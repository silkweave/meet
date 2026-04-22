import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetTranscriptList = createAction({
  name: 'meetTranscriptList',
  description: 'List transcripts for a Google Meet conference. Each transcript has a `state` indicating whether its file has been generated.',
  args: ['conferenceRecordId'],
  input: z.object({
    userId: z.string().optional().default('default'),
    conferenceRecordId: z.string(),
    pageSize: z.number().int().min(1).max(100).optional().default(10),
    pageToken: z.string().optional()
  }),
  run: async ({ userId, conferenceRecordId, pageSize, pageToken }) => {
    const client = new MeetClient(userId)
    const parent = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`
    return client.withAuth(async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.transcripts.list({ parent, pageSize, pageToken })
      return { transcripts: data.transcripts ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
