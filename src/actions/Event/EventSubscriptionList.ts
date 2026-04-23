import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionList = createAction({
  name: 'eventSubscriptionList',
  description: 'List Google Workspace Events subscriptions owned by the impersonated user. The filter must include at least one `event_types:` clause. Impersonates `userEmail` via DWD.',
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    filter: z.string().optional().default('event_types:"google.workspace.meet.transcript.v2.fileGenerated"').describe('Filter query; must include event_types:'),
    pageSize: z.number().int().min(1).max(100).optional().default(50),
    pageToken: z.string().optional()
  }),
  run: async ({ userEmail, filter, pageSize, pageToken }) => {
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.list({ filter, pageSize, pageToken })
      return { subscriptions: data.subscriptions ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
