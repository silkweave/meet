import { createAction } from '@silkweave/core'
import { existsSync } from 'fs'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

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

export interface UserSubscription {
  name: string
  state?: string
  pubsubTopic?: string
  eventTypes?: string[]
  expireTime?: string
  matchesTopic?: boolean
}

export interface UserStatus {
  userEmail: string
  impersonationOk: boolean
  impersonationError?: string
  googleUserId?: string
  subscriptions: UserSubscription[]
  hasSubscriptionOnTopic?: boolean
}

export const SetupStatus = createAction({
  name: 'setupStatus',
  description: 'Report the multi-user setup state: for every user in the config, confirm DWD impersonation works and list their Meet Workspace Events subscriptions. If `pubsubTopic` is provided, flag which users are subscribed to it.',
  input: z.object({
    pubsubTopic: z.string().optional().describe('Optional Pub/Sub topic `projects/{project}/topics/{topic}` to check subscription coverage against')
  }),
  run: async ({ pubsubTopic }) => {
    const keyPresent = existsSync(MeetClient.keyPath)
    const users = MeetClient.listUsers()
    const results: UserStatus[] = []
    for (const userEmail of users) {
      const status: UserStatus = { userEmail, impersonationOk: false, subscriptions: [] }
      try {
        await MeetClient.withAuth(userEmail, async (auth) => {
          const { data: userinfo } = await google.oauth2({ version: 'v2', auth }).userinfo.get()
          status.googleUserId = userinfo.id ?? undefined
          status.impersonationOk = true
          const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.list({ filter: LIST_FILTER, pageSize: 100 })
          status.subscriptions = (data.subscriptions ?? []).map((s) => ({
            name: s.name ?? '',
            state: s.state ?? undefined,
            pubsubTopic: s.notificationEndpoint?.pubsubTopic ?? undefined,
            eventTypes: s.eventTypes ?? undefined,
            expireTime: s.expireTime ?? undefined,
            matchesTopic: pubsubTopic ? topicShortName(s.notificationEndpoint?.pubsubTopic) === topicShortName(pubsubTopic) : undefined
          }))
          if (pubsubTopic) {
            status.hasSubscriptionOnTopic = status.subscriptions.some((s) => s.matchesTopic)
          }
        })
      } catch (err) {
        status.impersonationError = (err as Error).message
      }
      results.push(status)
    }
    return {
      serviceAccountKey: MeetClient.keyPath,
      serviceAccountKeyPresent: keyPresent,
      configPath: MeetClient.configPath,
      pubsubTopic,
      userCount: results.length,
      impersonatedCount: results.filter((u) => u.impersonationOk).length,
      subscribedCount: pubsubTopic ? results.filter((u) => u.hasSubscriptionOnTopic).length : undefined,
      users: results
    }
  }
})
