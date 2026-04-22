import { createAction } from '@silkweave/core'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const GoogleGetToken = createAction({
  name: 'googleGetToken',
  description: 'Exchange an OAuth authorization code for access/refresh tokens and persist them for the given userId.',
  args: ['code'],
  input: z.object({
    userId: z.string().optional().default('default'),
    code: z.string().describe('The `code` query parameter returned to the redirect URI after the user grants consent')
  }),
  run: async ({ userId, code }) => {
    const client = new MeetClient(userId)
    return client.createAccessToken(code)
  }
})
