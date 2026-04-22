import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const GoogleGetUser = createAction({
  name: 'googleGetUser',
  description: 'Return identity of the currently authenticated Google user (email, name, picture).',
  input: z.object({
    userId: z.string().optional().default('default')
  }),
  run: async ({ userId }) => {
    const client = new MeetClient(userId)
    return client.withAuth(async (auth) => {
      const { data } = await google.oauth2({ version: 'v2', auth }).userinfo.get()
      return { id: data.id, email: data.email, name: data.name, picture: data.picture }
    })
  }
})
