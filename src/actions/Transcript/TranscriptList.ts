import { createAction } from '@silkweave/core'
import z from 'zod'
import { transcriptDb } from '../../lib/transcriptDb.js'

export const TranscriptList = createAction({
  name: 'transcriptList',
  description: 'List previously-persisted Meet transcripts (not live from Google), ordered by most recent first. Optional filters for organizer, attendee, and date range.',
  input: z.object({
    organizerEmail: z.string().optional(),
    attendee: z.string().optional().describe('Email that must appear in the attendee list.'),
    startTimeFrom: z.string().optional().describe('RFC3339 lower bound on conference start time.'),
    startTimeTo: z.string().optional().describe('RFC3339 upper bound on conference start time.'),
    limit: z.number().int().min(1).max(100).optional().default(20),
    offset: z.number().int().min(0).optional().default(0)
  }),
  run: async ({ organizerEmail, attendee, startTimeFrom, startTimeTo, limit, offset }) => {
    const { total, results } = await transcriptDb.list({
      organizerEmail,
      attendee,
      startTimeFrom: startTimeFrom ? Date.parse(startTimeFrom) : undefined,
      startTimeTo: startTimeTo ? Date.parse(startTimeTo) : undefined,
      limit,
      offset
    })
    return { total, count: results.length, results: results.map((r) => r.record) }
  }
})
