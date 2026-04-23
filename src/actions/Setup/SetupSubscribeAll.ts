import { createAction } from '@silkweave/core'
import { PubSub } from '@google-cloud/pubsub'
import { google } from 'googleapis'
import { homedir } from 'os'
import { join } from 'path'
import z from 'zod'
import { MeetClient, SERVICE_ACCOUNT_KEY_PATH, WatcherConfig } from '../../classes/MeetClient.js'

const MEET_EVENT_TYPES = [
  'google.workspace.meet.conference.v2.started',
  'google.workspace.meet.conference.v2.ended',
  'google.workspace.meet.participant.v2.joined',
  'google.workspace.meet.participant.v2.left',
  'google.workspace.meet.recording.v2.fileGenerated',
  'google.workspace.meet.transcript.v2.fileGenerated'
]

const LIST_FILTER = MEET_EVENT_TYPES.map((t) => `event_types:"${t}"`).join(' OR ')

function topicShortName(topic: string | null | undefined): string {
  if (!topic) { return '' }
  const match = topic.match(/\/topics\/([^/]+)$/)
  return match ? match[1] : topic
}

type Result =
  | { userEmail: string; googleUserId: string; action: 'created'; subscriptionName: string }
  | { userEmail: string; googleUserId: string; action: 'skipped'; reason: string; subscriptionName?: string }
  | { userEmail: string; googleUserId?: string; action: 'failed'; error: string }

export const SetupSubscribeAll = createAction({
  name: 'setupSubscribeAll',
  description: 'End-to-end setup: for every user in the config (or the `--users` list, which is also appended to config) create a user-level Workspace Events subscription publishing to the given Pub/Sub topic, then create a Pub/Sub pull subscription on that topic and wire it into the transcript watcher config (idempotent). Prerequisite: `meet-api-event-push@system.gserviceaccount.com` has Pub/Sub Publisher on the topic and the service account has Pub/Sub Editor on the project.',
  input: z.object({
    pubsubTopic: z.string().describe('Destination topic, e.g. `projects/{project}/topics/{topic}`'),
    users: z.array(z.string()).optional().describe('User emails to add to the config before subscribing. If omitted, the existing config.users list is used as-is.'),
    eventTypes: z.array(z.string()).optional().default(['google.workspace.meet.transcript.v2.fileGenerated']),
    ttl: z.string().optional().describe('Duration string like `86400s`. Defaults to maximum allowed.'),
    pullSubscription: z.string().optional().describe('Pub/Sub pull subscription resource name `projects/{project}/subscriptions/{sub}` for the watcher to stream from. If omitted, `{topicName}-silkweave-watcher` in the topic\'s project is used.'),
    transcriptDir: z.string().optional().describe('Directory the watcher writes markdown transcripts into. Defaults to ~/.silkweave-meet/transcripts.'),
    autoStart: z.boolean().optional().describe('Persist watcher autoStart flag. If omitted, preserves existing value (defaulting to true on first setup).'),
    dryRun: z.boolean().optional().default(false).describe('Report what would be created without calling any API')
  }),
  run: async ({ pubsubTopic, users, eventTypes, ttl, pullSubscription, transcriptDir, autoStart, dryRun }) => {
    const topicMatch = pubsubTopic.match(/^projects\/([^/]+)\/topics\/([^/]+)$/)
    if (!topicMatch) { throw new Error(`pubsubTopic must be \`projects/{project}/topics/{topic}\`, got: ${pubsubTopic}`) }
    const [, topicProject, topicShort] = topicMatch

    let pullSubFull: string
    let pullSubShort: string
    let pullSubProject: string
    if (pullSubscription) {
      const subMatch = pullSubscription.match(/^projects\/([^/]+)\/subscriptions\/([^/]+)$/)
      if (!subMatch) { throw new Error(`pullSubscription must be \`projects/{project}/subscriptions/{sub}\`, got: ${pullSubscription}`) }
      pullSubProject = subMatch[1]
      pullSubShort = subMatch[2]
      pullSubFull = pullSubscription
    } else {
      pullSubProject = topicProject
      pullSubShort = `${topicShort}-silkweave-watcher`
      pullSubFull = `projects/${pullSubProject}/subscriptions/${pullSubShort}`
    }

    if (users?.length) { MeetClient.addUsers(users) }
    const emails = MeetClient.listUsers()
    const results: Result[] = []
    for (const userEmail of emails) {
      try {
        await MeetClient.withAuth(userEmail, async (auth) => {
          const { data: userinfo } = await google.oauth2({ version: 'v2', auth }).userinfo.get()
          const googleUserId = userinfo.id ?? ''
          if (!googleUserId) { throw new Error('userinfo returned no id') }
          const targetResource = `//cloudidentity.googleapis.com/users/${googleUserId}`
          const filter = `(${LIST_FILTER}) AND target_resource="${targetResource}"`
          const { data: list } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.list({ filter, pageSize: 100 })
          const existing = (list.subscriptions ?? []).find((s) => s.targetResource === targetResource)
          if (existing) {
            const sameTopic = topicShortName(existing.notificationEndpoint?.pubsubTopic) === topicShortName(pubsubTopic)
            results.push({ userEmail, googleUserId, action: 'skipped', reason: sameTopic ? 'subscription already exists' : `subscription exists on a different topic (${existing.notificationEndpoint?.pubsubTopic ?? 'unknown'})`, subscriptionName: existing.name ?? undefined })
            return
          }
          if (dryRun) {
            results.push({ userEmail, googleUserId, action: 'skipped', reason: 'dry run' })
            return
          }
          try {
            const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.create({
              requestBody: {
                targetResource,
                eventTypes,
                notificationEndpoint: { pubsubTopic },
                ttl
              }
            })
            results.push({ userEmail, googleUserId, action: 'created', subscriptionName: data.name ?? '' })
          } catch (err) {
            const msg = (err as Error).message
            if (/already exists/i.test(msg)) {
              results.push({ userEmail, googleUserId, action: 'skipped', reason: 'subscription already exists (returned by create)' })
              return
            }
            throw err
          }
        })
      } catch (err) {
        results.push({ userEmail, action: 'failed', error: (err as Error).message })
      }
    }

    let pullSubAction: 'created' | 'exists' | 'dry-run' | 'failed'
    let pullSubError: string | undefined
    if (dryRun) {
      pullSubAction = 'dry-run'
    } else {
      try {
        const pubsubClient = new PubSub({ keyFilename: SERVICE_ACCOUNT_KEY_PATH, projectId: pullSubProject })
        const [exists] = await pubsubClient.subscription(pullSubShort).exists()
        if (exists) {
          pullSubAction = 'exists'
        } else {
          await pubsubClient.topic(pubsubTopic).createSubscription(pullSubShort)
          pullSubAction = 'created'
        }
        await pubsubClient.close()
      } catch (err) {
        pullSubAction = 'failed'
        pullSubError = (err as Error).message
      }
    }

    let watcher: WatcherConfig | undefined
    if (!dryRun && pullSubAction !== 'failed') {
      const existing = MeetClient.getWatcherConfig()
      const existingSubs = existing?.pubsubSubscriptions ?? []
      const nextSubs = existingSubs.includes(pullSubFull) ? existingSubs : [...existingSubs, pullSubFull]
      watcher = MeetClient.setWatcherConfig({
        pubsubSubscriptions: nextSubs,
        transcriptDir: transcriptDir ?? existing?.transcriptDir ?? join(homedir(), '.silkweave-meet', 'transcripts'),
        autoStart: autoStart ?? existing?.autoStart ?? true
      })
    }

    return {
      pubsubTopic,
      pullSubscription: pullSubFull,
      pullSubscriptionAction: pullSubAction,
      pullSubscriptionError: pullSubError,
      watcher,
      configuredUsers: emails,
      total: results.length,
      created: results.filter((r) => r.action === 'created').length,
      skipped: results.filter((r) => r.action === 'skipped').length,
      failed: results.filter((r) => r.action === 'failed').length,
      results
    }
  }
})
