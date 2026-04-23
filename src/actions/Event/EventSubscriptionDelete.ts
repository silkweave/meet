import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionDelete = createAction({
  name: 'eventSubscriptionDelete',
  description: 'Delete a Google Workspace Events subscription. Impersonates `userEmail` (must be the subscription owner) via DWD.',
  args: ['name'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email (subscription owner) to impersonate via DWD'),
    name: z.string().describe('Subscription resource name `subscriptions/{id}`'),
    allowMissing: z.boolean().optional().default(true)
  }),
  run: async ({ userEmail, name, allowMissing }) => {
    const resourceName = name.startsWith('subscriptions/') ? name : `subscriptions/${name}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.delete({ name: resourceName, allowMissing })
      return data
    })
  }
})
