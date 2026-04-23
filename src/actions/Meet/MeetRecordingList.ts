import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetRecordingList = createAction({
  name: 'meetRecordingList',
  description: 'List recordings (Drive destinations) of a Google Meet conference. Impersonates `userEmail` via DWD.',
  args: ['conferenceRecordId'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    conferenceRecordId: z.string(),
    pageSize: z.number().int().min(1).max(100).optional().default(10),
    pageToken: z.string().optional()
  }),
  run: async ({ userEmail, conferenceRecordId, pageSize, pageToken }) => {
    const parent = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.recordings.list({ parent, pageSize, pageToken })
      return { recordings: data.recordings ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
