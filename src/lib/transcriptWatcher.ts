import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { Message, PubSub, Subscription } from '@google-cloud/pubsub'
import { google } from 'googleapis'
import { MeetClient, SERVICE_ACCOUNT_KEY_PATH, WatcherConfig } from '../classes/MeetClient.js'
import { ingestTranscript } from './transcriptIngest.js'

interface SubscriptionStatus {
  messagesReceived: number
  messagesAcked: number
  errors: number
  lastMessageAt?: string
  lastError?: string
  lastErrorAt?: string
}

export interface WatcherStatus {
  running: boolean
  startedAt?: string
  config?: WatcherConfig
  pubsubKeyFile?: string
  transcriptsSaved: number
  knownSubscriptionOwners: number
  subscriptionOwners: Record<string, string>
  subscriptions: Record<string, SubscriptionStatus>
  recent: Array<{ transcriptName: string; file: string; savedAt: string; userEmail: string }>
  notRunningReason?: string
}

const MEET_EVENT_FILTER = [
  'google.workspace.meet.conference.v2.started',
  'google.workspace.meet.conference.v2.ended',
  'google.workspace.meet.participant.v2.joined',
  'google.workspace.meet.participant.v2.left',
  'google.workspace.meet.recording.v2.fileGenerated',
  'google.workspace.meet.transcript.v2.fileGenerated'
].map((t) => `event_types:"${t}"`).join(' OR ')

const MAX_RECENT = 20

class TranscriptWatcher {
  private stopped = true
  private config?: WatcherConfig
  private status: WatcherStatus = { running: false, transcriptsSaved: 0, knownSubscriptionOwners: 0, subscriptionOwners: {}, subscriptions: {}, recent: [] }
  private processed = new Set<string>()
  private subscriptionToEmail = new Map<string, string>()
  private pubsub?: PubSub
  private subscriptions: Subscription[] = []
  private rebuildInFlight?: Promise<void>
  private notRunningReason?: string

  isRunning(): boolean { return !this.stopped }

  setNotRunningReason(reason: string | undefined): void { this.notRunningReason = reason }

  getStatus(): WatcherStatus {
    return {
      ...this.status,
      running: !this.stopped,
      knownSubscriptionOwners: this.subscriptionToEmail.size,
      subscriptionOwners: Object.fromEntries(this.subscriptionToEmail),
      notRunningReason: this.stopped ? this.notRunningReason : undefined
    }
  }

  async start(config: WatcherConfig): Promise<void> {
    if (!this.stopped) { throw new Error('Transcript watcher is already running') }
    if (!config.pubsubSubscriptions?.length) {
      throw new Error('At least one Pub/Sub subscription is required (pubsubSubscriptions)')
    }
    if (!existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
      throw new Error(`Service account key not found at ${SERVICE_ACCOUNT_KEY_PATH}.`)
    }
    if (!existsSync(config.transcriptDir)) { mkdirSync(config.transcriptDir, { recursive: true }) }

    this.config = config
    this.stopped = false
    this.notRunningReason = undefined
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      config,
      pubsubKeyFile: SERVICE_ACCOUNT_KEY_PATH,
      transcriptsSaved: 0,
      knownSubscriptionOwners: 0,
      subscriptionOwners: {},
      subscriptions: Object.fromEntries(
        config.pubsubSubscriptions.map((s) => [s, { messagesReceived: 0, messagesAcked: 0, errors: 0 }])
      ),
      recent: []
    }

    await this.rebuildUserMap()

    this.pubsub = new PubSub({ keyFilename: SERVICE_ACCOUNT_KEY_PATH })
    for (const subscriptionName of config.pubsubSubscriptions) {
      const sub = this.pubsub.subscription(subscriptionName, { flowControl: { maxMessages: 10 } })
      sub.on('message', (msg: Message) => {
        this.handleMessage(msg, subscriptionName).catch((err) => {
          this.recordSubscriptionError(subscriptionName, err)
          try { msg.nack() } catch { /* already settled */ }
        })
      })
      sub.on('error', (err: Error) => this.recordSubscriptionError(subscriptionName, err))
      this.subscriptions.push(sub)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.status.running = false
    this.notRunningReason = 'stopped manually'
    const subs = this.subscriptions
    this.subscriptions = []
    await Promise.all(subs.map((s) => s.close().catch(() => { /* ignore */ })))
    if (this.pubsub) {
      await this.pubsub.close().catch(() => { /* ignore */ })
      this.pubsub = undefined
    }
  }

  private async handleMessage(msg: Message, pullSubscription: string): Promise<void> {
    const s = this.status.subscriptions[pullSubscription]
    s.messagesReceived += 1
    s.lastMessageAt = new Date().toISOString()

    const attrs = msg.attributes ?? {}
    const ceType = attrs['ce-type']
    if (ceType && !ceType.startsWith('google.workspace.meet.transcript')) {
      msg.ack()
      s.messagesAcked += 1
      return
    }

    const ceSource = attrs['ce-source'] ?? ''
    const userEmail = await this.resolveUserEmail(ceSource)
    if (!userEmail) {
      this.recordSubscriptionError(pullSubscription, new Error(`Unknown subscription owner for ce-source=${ceSource}`))
      msg.nack()
      return
    }

    const transcriptName = extractTranscriptName({ data: msg.data?.toString('utf-8'), attributes: attrs })
    if (!transcriptName) {
      msg.ack()
      s.messagesAcked += 1
      return
    }

    if (this.processed.has(transcriptName)) {
      msg.ack()
      s.messagesAcked += 1
      return
    }

    try {
      await this.processTranscript(userEmail, transcriptName)
      msg.ack()
      s.messagesAcked += 1
    } catch (err) {
      this.recordSubscriptionError(pullSubscription, err)
      msg.nack()
    }
  }

  private async resolveUserEmail(ceSource: string): Promise<string | undefined> {
    if (!ceSource) { return undefined }
    const match = ceSource.match(/subscriptions\/[^/]+$/)
    if (!match) { return undefined }
    const subId = match[0]
    if (this.subscriptionToEmail.has(subId)) { return this.subscriptionToEmail.get(subId) }
    await this.rebuildUserMap()
    return this.subscriptionToEmail.get(subId)
  }

  private async rebuildUserMap(): Promise<void> {
    if (this.rebuildInFlight) { return this.rebuildInFlight }
    this.rebuildInFlight = (async () => {
      const next = new Map<string, string>()
      for (const email of MeetClient.listUsers()) {
        try {
          await MeetClient.withAuth(email, async (auth) => {
            const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.list({ filter: MEET_EVENT_FILTER, pageSize: 100 })
            for (const sub of data.subscriptions ?? []) {
              if (sub.name) { next.set(sub.name, email) }
            }
          })
        } catch { /* impersonation may fail for any user; skip */ }
      }
      this.subscriptionToEmail = next
      this.status.knownSubscriptionOwners = next.size
    })()
    try { await this.rebuildInFlight } finally { this.rebuildInFlight = undefined }
  }

  private async processTranscript(userEmail: string, transcriptName: string): Promise<void> {
    const result = await ingestTranscript({
      userEmail,
      transcriptName,
      options: { transcriptDir: this.config?.transcriptDir }
    })

    if (result.status === 'failed') {
      throw new Error(result.error ?? 'transcript ingest failed')
    }

    this.processed.add(transcriptName)

    if (result.status !== 'saved' || !result.record || !result.filePath) { return }

    this.status.transcriptsSaved += 1
    this.status.recent.unshift({ transcriptName, file: result.filePath, savedAt: new Date().toISOString(), userEmail })
    if (this.status.recent.length > MAX_RECENT) { this.status.recent.length = MAX_RECENT }

    if (this.config?.onTranscriptCommand) {
      const record = result.record
      let markdown = ''
      try { markdown = readFileSync(result.filePath, 'utf-8') } catch { /* best effort */ }
      const env = {
        ...process.env,
        TRANSCRIPT_PATH: result.filePath,
        TRANSCRIPT_RAW: markdown,
        TRANSCRIPT_NAME: transcriptName,
        CONFERENCE_RECORD: record.conferenceRecordName,
        MEET_CODE: record.meetingCode,
        START_TIME: record.startTimeIso,
        END_TIME: record.endTimeIso,
        ENTRY_COUNT: String(record.entryCount),
        DATE: record.startTimeIso.slice(0, 10),
        SUBJECT: record.subject,
        CALENDAR_EVENT_ID: record.calendarEventId
      }
      const child = spawn(this.config.onTranscriptCommand, {
        shell: true,
        env,
        stdio: 'ignore',
        detached: true
      })
      child.unref()
      child.on('error', (err) => {
        this.recordGeneralError(`command spawn failed: ${err.message}`)
      })
    }
  }

  private recordSubscriptionError(subscription: string, err: unknown): void {
    const s = this.status.subscriptions[subscription]
    if (!s) { return }
    s.errors += 1
    s.lastError = errorMessage(err)
    s.lastErrorAt = new Date().toISOString()
  }

  private recordGeneralError(message: string): void {
    for (const sub of Object.keys(this.status.subscriptions)) {
      this.status.subscriptions[sub].lastError = message
      this.status.subscriptions[sub].lastErrorAt = new Date().toISOString()
    }
  }
}

export const transcriptWatcher = new TranscriptWatcher()

function extractTranscriptName(message: { data?: string | null; attributes?: Record<string, string> | null }): string | undefined {
  if (message.data) {
    try {
      const payload = JSON.parse(message.data) as { transcript?: { name?: string }; name?: string }
      if (payload.transcript?.name) { return payload.transcript.name }
      if (payload.name?.includes('/transcripts/')) { return payload.name }
    } catch { /* fall through */ }
  }
  const subject = message.attributes?.['ce-subject']
  if (subject) {
    const idx = subject.indexOf('conferenceRecords/')
    if (idx >= 0) { return subject.slice(idx) }
  }
  return undefined
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) { return err.message }
  return String(err)
}
