import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetRecordingList = createAction({
  name: 'meetRecordingList',
  description: 'List recordings (Drive destinations) of a Google Meet conference.',
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
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.recordings.list({ parent, pageSize, pageToken })
      return { recordings: data.recordings ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
