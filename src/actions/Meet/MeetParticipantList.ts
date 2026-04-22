import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetParticipantList = createAction({
  name: 'meetParticipantList',
  description: 'List participants of a Google Meet conference.',
  args: ['conferenceRecordId'],
  input: z.object({
    userId: z.string().optional().default('default'),
    conferenceRecordId: z.string(),
    pageSize: z.number().int().min(1).max(250).optional().default(100),
    pageToken: z.string().optional()
  }),
  run: async ({ userId, conferenceRecordId, pageSize, pageToken }) => {
    const client = new MeetClient(userId)
    const parent = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return client.withAuth(async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.participants.list({ parent, pageSize, pageToken })
      return { participants: data.participants ?? [], nextPageToken: data.nextPageToken ?? undefined, totalSize: data.totalSize ?? undefined }
    })
  }
})
