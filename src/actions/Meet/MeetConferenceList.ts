import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const MeetConferenceList = createAction({
  name: 'meetConferenceList',
  description: 'List past Google Meet conference records the authenticated user participated in. Supports EBNF filters like `space.meeting_code="abc-mnop-xyz"` or `start_time>="2026-04-01T00:00:00Z"`.',
  input: z.object({
    userId: z.string().optional().default('default'),
    filter: z.string().optional().describe('EBNF filter (space.meeting_code, space.name, start_time, end_time). e.g. `end_time IS NULL` for ongoing.'),
    pageSize: z.number().int().min(1).max(100).optional().default(25),
    pageToken: z.string().optional()
  }),
  run: async ({ userId, filter, pageSize, pageToken }) => {
    const client = new MeetClient(userId)
    return client.withAuth(async (auth) => {
      const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.list({ filter, pageSize, pageToken })
      return { conferenceRecords: data.conferenceRecords ?? [], nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
