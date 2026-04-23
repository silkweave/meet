import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionCreate = createAction({
  name: 'eventSubscriptionCreate',
  description: 'Create a Google Workspace Events subscription that publishes Meet events (default: transcript file generated) to a Pub/Sub topic. Prerequisite: grant Pub/Sub Publisher to `meet-api-event-push@system.gserviceaccount.com` on the topic. Impersonates `userEmail` via DWD.',
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    targetResource: z.string().describe('Full Meet resource name, e.g. `//meet.googleapis.com/spaces/{space}`'),
    pubsubTopic: z.string().describe('Destination topic, e.g. `projects/{project}/topics/{topic}`'),
    eventTypes: z.array(z.string()).optional().default(['google.workspace.meet.transcript.v2.fileGenerated']),
    ttl: z.string().optional().describe('Duration string like `86400s`. Defaults to maximum allowed.')
  }),
  run: async ({ userEmail, targetResource, pubsubTopic, eventTypes, ttl }) => {
    const normalized = targetResource.startsWith('//') ? targetResource : `//meet.googleapis.com/${targetResource.replace(/^\/+/, '')}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.create({
        requestBody: {
          targetResource: normalized,
          eventTypes,
          notificationEndpoint: { pubsubTopic },
          ttl
        }
      })
      return data
    })
  }
})
