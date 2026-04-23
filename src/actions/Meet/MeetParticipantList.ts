import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetParticipantList = createAction({
  name: 'meetParticipantList',
  description: 'List participants of a Google Meet conference. Impersonates `userEmail` via DWD.',
  args: ['conferenceRecordId'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    conferenceRecordId: z.string(),
    pageSize: z.number().int().min(1).max(250).optional().default(100),
    pageToken: z.string().optional()
  }),
  run: async ({ userEmail, conferenceRecordId, pageSize, pageToken }) => {
    const parent = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.participants.list({ parent, pageSize, pageToken })
      return { participants: data.participants ?? [], nextPageToken: data.nextPageToken ?? undefined, totalSize: data.totalSize ?? undefined }
    })
  }
})
