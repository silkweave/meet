import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const CalendarEventList = createAction({
  name: 'calendarEventList',
  description: 'List Google Calendar events (upcoming or past) on the primary calendar, optionally filtered to those with a Google Meet link. Use this to find meeting IDs before fetching conference records. Impersonates `userEmail` via DWD.',
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    timeMin: z.string().optional().describe('RFC3339 lower bound on event start (defaults to now)'),
    timeMax: z.string().optional().describe('RFC3339 upper bound on event start'),
    q: z.string().optional().describe('Free-text search across event summary/description/attendees'),
    maxResults: z.number().int().min(1).max(2500).optional().default(50),
    pageToken: z.string().optional(),
    onlyWithMeet: z.boolean().optional().default(true).describe('Only return events that have a Google Meet conference attached')
  }),
  run: async ({ userEmail, timeMin, timeMax, q, maxResults, pageToken, onlyWithMeet }) => {
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.calendar({ version: 'v3', auth }).events.list({
        calendarId: 'primary',
        timeMin: timeMin ?? new Date().toISOString(),
        timeMax,
        q,
        maxResults,
        pageToken,
        singleEvents: true,
        orderBy: 'startTime'
      })
      const events = (data.items ?? []).map((e) => {
        const entryPoint = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
        return {
          id: e.id,
          summary: e.summary,
          description: e.description,
          start: e.start,
          end: e.end,
          organizer: e.organizer,
          attendees: e.attendees,
          htmlLink: e.htmlLink,
          meetUri: entryPoint?.uri,
          meetCode: e.conferenceData?.conferenceId,
          hangoutLink: e.hangoutLink
        }
      })
      const filtered = onlyWithMeet ? events.filter((e) => e.meetUri || e.meetCode) : events
      return { events: filtered, nextPageToken: data.nextPageToken ?? undefined }
    })
  }
})
