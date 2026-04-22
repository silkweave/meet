import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const EventSubscriptionDelete = createAction({
  name: 'eventSubscriptionDelete',
  description: 'Delete a Google Workspace Events subscription.',
  args: ['name'],
  input: z.object({
    userId: z.string().optional().default('default'),
    name: z.string().describe('Subscription resource name `subscriptions/{id}`'),
    allowMissing: z.boolean().optional().default(true)
  }),
  run: async ({ userId, name, allowMissing }) => {
    const client = new MeetClient(userId)
    const resourceName = name.startsWith('subscriptions/') ? name : `subscriptions/${name}`
    return client.withAuth(async (auth) => {
      const { data } = await google.workspaceevents({ version: 'v1', auth }).subscriptions.delete({ name: resourceName, allowMissing })
      return data
    })
  }
})
