import { spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { google, meet_v2 } from 'googleapis'
import { MeetClient, WatcherConfig } from '../classes/MeetClient.js'
import { Participant, renderTranscriptMarkdown } from './transcripts.js'

interface SubscriptionStatus {
  messagesReceived: number
  messagesAcked: number
  errors: number
  lastPulledAt?: string
  lastError?: string
  lastErrorAt?: string
}

export interface WatcherStatus {
  running: boolean
  startedAt?: string
  userId?: string
  config?: WatcherConfig
  transcriptsSaved: number
  subscriptions: Record<string, SubscriptionStatus>
  recent: Array<{ transcriptName: string; file: string; savedAt: string }>
}

const IDLE_BACKOFF_MS = 2_000
const ERROR_BACKOFF_MS = 10_000
const MAX_RECENT = 20

class TranscriptWatcher {
  private stopped = true
  private userId?: string
  private config?: WatcherConfig
  private status: WatcherStatus = { running: false, transcriptsSaved: 0, subscriptions: {}, recent: [] }
  private processed = new Set<string>()

  isRunning(): boolean { return !this.stopped }

  getStatus(): WatcherStatus {
    return { ...this.status, running: !this.stopped }
  }

  async start(userId: string, config: WatcherConfig): Promise<void> {
    if (!this.stopped) { throw new Error('Transcript watcher is already running') }
    if (!config.pubsubSubscriptions?.length) {
      throw new Error('At least one Pub/Sub subscription is required (pubsubSubscriptions)')
    }
    if (!existsSync(config.transcriptDir)) { mkdirSync(config.transcriptDir, { recursive: true }) }

    this.userId = userId
    this.config = config
    this.stopped = false
    this.status = {
      running: true,
      startedAt: new Date().toISOString(),
      userId,
      config,
      transcriptsSaved: 0,
      subscriptions: Object.fromEntries(
        config.pubsubSubscriptions.map((s) => [s, { messagesReceived: 0, messagesAcked: 0, errors: 0 }])
      ),
      recent: []
    }

    for (const subscription of config.pubsubSubscriptions) {
      this.pullLoop(subscription).catch((err) => {
        this.recordSubscriptionError(subscription, err)
      })
    }
  }

  stop(): void {
    this.stopped = true
    this.status.running = false
  }

  private async pullLoop(subscription: string): Promise<void> {
    while (!this.stopped) {
      try {
        const client = new MeetClient(this.userId)
        const result = await client.withAuth(async (auth) => {
          const pubsub = google.pubsub({ version: 'v1', auth })
          const { data } = await pubsub.projects.subscriptions.pull({
            subscription,
            requestBody: { maxMessages: 10, returnImmediately: false }
          })
          const messages = data.receivedMessages ?? []
          if (messages.length === 0) { return { processed: 0 } }

          const ackIds: string[] = []
          for (const received of messages) {
            this.status.subscriptions[subscription].messagesReceived += 1
            try {
              await this.handleMessage(received, client)
              if (received.ackId) { ackIds.push(received.ackId) }
            } catch (err) {
              this.recordSubscriptionError(subscription, err)
            }
          }

          if (ackIds.length > 0) {
            await pubsub.projects.subscriptions.acknowledge({ subscription, requestBody: { ackIds } })
            this.status.subscriptions[subscription].messagesAcked += ackIds.length
          }
          this.status.subscriptions[subscription].lastPulledAt = new Date().toISOString()
          return { processed: messages.length }
        })

        if (result.processed === 0) { await sleep(IDLE_BACKOFF_MS) }
      } catch (err) {
        this.recordSubscriptionError(subscription, err)
        await sleep(ERROR_BACKOFF_MS)
      }
    }
  }

  private async handleMessage(received: { message?: { data?: string | null; attributes?: Record<string, string> | null } | null }, client: MeetClient): Promise<void> {
    const message = received.message
    if (!message) { return }

    const attrs = message.attributes ?? {}
    const ceType = attrs['ce-type']
    if (ceType && !ceType.startsWith('google.workspace.meet.transcript')) { return }

    const transcriptName = extractTranscriptName(message)
    if (!transcriptName) { return }

    if (this.processed.has(transcriptName)) { return }

    const match = transcriptName.match(/^(conferenceRecords\/[^/]+)\/transcripts\/([^/]+)$/)
    if (!match) { throw new Error(`Unrecognised transcript resource name: ${transcriptName}`) }
    const [, conferenceRecordName, transcriptId] = match

    const fetched = await client.withAuth(async (auth) => {
      const meet = google.meet({ version: 'v2', auth })

      const entries: meet_v2.Schema$TranscriptEntry[] = []
      let entryPageToken: string | undefined
      do {
        const { data } = await meet.conferenceRecords.transcripts.entries.list({ parent: transcriptName, pageSize: 500, pageToken: entryPageToken })
        if (data.transcriptEntries) { entries.push(...data.transcriptEntries) }
        entryPageToken = data.nextPageToken ?? undefined
      } while (entryPageToken)

      const participants: Record<string, Participant> = {}
      let participantPageToken: string | undefined
      do {
        const { data } = await meet.conferenceRecords.participants.list({ parent: conferenceRecordName, pageSize: 100, pageToken: participantPageToken })
        for (const p of data.participants ?? []) {
          if (p.name) { participants[p.name] = p }
        }
        participantPageToken = data.nextPageToken ?? undefined
      } while (participantPageToken)

      const [transcript, conference] = await Promise.all([
        meet.conferenceRecords.transcripts.get({ name: transcriptName }).then((r) => r.data),
        meet.conferenceRecords.get({ name: conferenceRecordName }).then((r) => r.data)
      ])

      let meetingCode: string | undefined
      if (conference.space) {
        try {
          const { data } = await meet.spaces.get({ name: conference.space })
          meetingCode = data.meetingCode ?? undefined
        } catch { /* space lookup may fail if no longer accessible; fall through */ }
      }

      return { entries, participants, transcript, conference, meetingCode }
    })

    const markdown = renderTranscriptMarkdown(fetched.entries, fetched.participants)
    const startTime = fetched.transcript.startTime ?? fetched.conference.startTime ?? new Date().toISOString()
    const date = startTime.slice(0, 10)
    const slug = sanitizeForFilename(fetched.meetingCode ?? conferenceRecordName.replace('conferenceRecords/', ''))
    const file = join(this.config!.transcriptDir, `${date}_${slug}_${sanitizeForFilename(transcriptId)}.md`)
    const body = buildMarkdownDocument({
      conferenceRecordName,
      transcriptName,
      meetingCode: fetched.meetingCode,
      startTime: fetched.transcript.startTime ?? null,
      endTime: fetched.transcript.endTime ?? null,
      markdown
    })
    writeFileSync(file, body, 'utf-8')

    this.processed.add(transcriptName)
    this.status.transcriptsSaved += 1
    this.status.recent.unshift({ transcriptName, file, savedAt: new Date().toISOString() })
    if (this.status.recent.length > MAX_RECENT) { this.status.recent.length = MAX_RECENT }

    if (this.config?.onTranscriptCommand) {
      const env = {
        ...process.env,
        TRANSCRIPT_PATH: file,
        TRANSCRIPT_RAW: markdown,
        TRANSCRIPT_NAME: transcriptName,
        CONFERENCE_RECORD: conferenceRecordName,
        MEET_CODE: fetched.meetingCode ?? '',
        START_TIME: fetched.transcript.startTime ?? '',
        END_TIME: fetched.transcript.endTime ?? '',
        ENTRY_COUNT: String(fetched.entries.length),
        DATE: date
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
      const decoded = Buffer.from(message.data, 'base64').toString('utf-8')
      const payload = JSON.parse(decoded) as { transcript?: { name?: string }; name?: string }
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

function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'unknown'
}

function buildMarkdownDocument(params: {
  conferenceRecordName: string
  transcriptName: string
  meetingCode?: string
  startTime: string | null
  endTime: string | null
  markdown: string
}): string {
  const header = [
    '# Meeting transcript',
    '',
    `- **Conference:** \`${params.conferenceRecordName}\``,
    `- **Transcript:** \`${params.transcriptName}\``,
    params.meetingCode ? `- **Meet code:** \`${params.meetingCode}\`` : null,
    params.startTime ? `- **Start:** ${params.startTime}` : null,
    params.endTime ? `- **End:** ${params.endTime}` : null,
    '',
    '---',
    ''
  ].filter((line) => line !== null).join('\n')
  return `${header}${params.markdown}\n`
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) { return err.message }
  return String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
