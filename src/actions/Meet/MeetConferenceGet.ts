import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetConferenceGet = createAction({
  name: 'meetConferenceGet',
  description: 'Fetch a single Google Meet conference record by ID or resource name (`conferenceRecords/{id}`). Impersonates `userEmail` via DWD.',
  args: ['conferenceRecordId'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    conferenceRecordId: z.string().describe('Either the bare conference record ID or the full `conferenceRecords/{id}` resource name')
  }),
  run: async ({ userEmail, conferenceRecordId }) => {
    const name = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.get({ name })
      return data
    })
  }
})
