import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionList = createAction({
  name: 'eventSubscriptionList',
  description: 'List Google Workspace Events subscriptions. The filter must include at least one `event_types:` clause.',
  input: z.object({
    userId: z.string().optional().default('default'),
    filter: z.string().optional().default('event_types:"google.workspace.meet.transcript.v2.fileGenerated"').describe('Filter query; must include event_types:'),
    pageSize: z.number().int().min(1).max(100).optional().default(50),
    pageToken: z.string().optional()
  }),
  run: async ({ userId, filter, pageSize, pageToken }) => {
    const client = new MeetClient(userId)
    return client.withAuth(async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.list({ filter, pageSize, pageToken })
      return { subscriptions: data.subscriptions ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
