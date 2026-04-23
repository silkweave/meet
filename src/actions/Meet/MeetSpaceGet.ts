import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetSpaceGet = createAction({
  name: 'meetSpaceGet',
  description: 'Look up a Google Meet space by resource name (`spaces/{id}`) or meeting code (e.g. `abc-mnop-xyz`). Impersonates `userEmail` via DWD.',
  args: ['space'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    space: z.string().describe('Space resource name `spaces/{id}` or meeting code `abc-mnop-xyz`')
  }),
  run: async ({ userEmail, space }) => {
    const name = space.startsWith('spaces/') ? space : `spaces/${space}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).spaces.get({ name })
      return data
    })
  }
})
