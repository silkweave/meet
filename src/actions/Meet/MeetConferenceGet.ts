import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetConferenceGet = createAction({
  name: 'meetConferenceGet',
  description: 'Fetch a single Google Meet conference record by ID or resource name (`conferenceRecords/{id}`).',
  args: ['conferenceRecordId'],
  input: z.object({
    userId: z.string().optional().default('default'),
    conferenceRecordId: z.string().describe('Either the bare conference record ID or the full `conferenceRecords/{id}` resource name')
  }),
  run: async ({ userId, conferenceRecordId }) => {
    const client = new MeetClient(userId)
    const name = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return client.withAuth(async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.get({ name })
      return data
    })
  }
})
