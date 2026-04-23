import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionCreateForUser = createAction({
  name: 'eventSubscriptionCreateForUser',
  description: 'Create a Google Workspace Events subscription for the impersonated user, receiving transcript file-generated events for meetings they own or attend. Google requires the subscription to be authorized by the subscribed user; with DWD the service account acts on that user\'s behalf. Prerequisite: grant Pub/Sub Publisher to `meet-api-event-push@system.gserviceaccount.com` on the topic.',
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD. The subscription is created for this user.'),
    pubsubTopic: z.string().describe('Destination topic, e.g. `projects/{project}/topics/{topic}`'),
    eventTypes: z.array(z.string()).optional().default(['google.workspace.meet.transcript.v2.fileGenerated']),
    ttl: z.string().optional().describe('Duration string like `86400s`. Defaults to maximum allowed.')
  }),
  run: async ({ userEmail, pubsubTopic, eventTypes, ttl }) => {
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data: userinfo } = await google.oauth2({ version: 'v2', auth }).userinfo.get()
      const googleUserId = userinfo.id
      if (!googleUserId) { throw new Error('userinfo returned no id') }
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.create({
        requestBody: {
          targetResource: `//cloudidentity.googleapis.com/users/${googleUserId}`,
          eventTypes,
          notificationEndpoint: { pubsubTopic },
          ttl
        }
      })
      return data
    })
  }
})
