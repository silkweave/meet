import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionCreateForUser = createAction({
  name: 'eventSubscriptionCreateForUser',
  description: 'Create a Google Workspace Events subscription for all Meet transcript events from a user (organizer or attendee). Prerequisite: grant Pub/Sub Publisher to `meet-api-event-push@system.gserviceaccount.com` on the topic.',
  input: z.object({
    userId: z.string().optional().default('default').describe('Local identifier for the token registry entry'),
    userEmail: z.string().describe('Email or unique ID of the user whose meetings to monitor (e.g. user@example.com)'),
    pubsubTopic: z.string().describe('Destination topic, e.g. `projects/{project}/topics/{topic}`'),
    eventTypes: z.array(z.string()).optional().default(['google.workspace.meet.transcript.v2.fileGenerated']),
    ttl: z.string().optional().describe('Duration string like `86400s`. Defaults to maximum allowed.')
  }),
  run: async ({ userId, userEmail, pubsubTopic, eventTypes, ttl }) => {
    const client = new MeetClient(userId)
    return client.withAuth(async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.create({
        requestBody: {
          targetResource: `//cloudidentity.googleapis.com/users/${userEmail}`,
          eventTypes,
          notificationEndpoint: { pubsubTopic },
          ttl
        }
      })
      return data
    })
  }
})
