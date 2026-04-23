import { google } from 'googleapis'
import { JWT } from 'google-auth-library'

export interface CalendarEnrichment {
  calendarEventId: string
  subject: string
  description: string
  attendees: string[]
  organizerEmail: string
  eventStart?: string
  eventEnd?: string
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function enrichFromCalendar(params: {
  auth: JWT
  meetingCode: string
  conferenceStart?: string | null
  conferenceEnd?: string | null
}): Promise<CalendarEnrichment | undefined> {
  const { auth, meetingCode, conferenceStart, conferenceEnd } = params
  if (!meetingCode) { return undefined }

  const anchor = conferenceStart ? Date.parse(conferenceStart) : Date.now()
  const anchorEnd = conferenceEnd ? Date.parse(conferenceEnd) : anchor
  const timeMin = new Date(anchor - ONE_DAY_MS).toISOString()
  const timeMax = new Date(anchorEnd + ONE_DAY_MS).toISOString()

  const calendar = google.calendar({ version: 'v3', auth })
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    maxResults: 50,
    orderBy: 'startTime'
  })

  const match = (data.items ?? []).find((e) => e.conferenceData?.conferenceId === meetingCode)
  if (!match) { return undefined }

  return {
    calendarEventId: match.id ?? '',
    subject: match.summary ?? '',
    description: stripHtml(match.description ?? ''),
    attendees: (match.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
    organizerEmail: match.organizer?.email ?? '',
    eventStart: match.start?.dateTime ?? match.start?.date ?? undefined,
    eventEnd: match.end?.dateTime ?? match.end?.date ?? undefined
  }
}

function stripHtml(input: string): string {
  if (!input) { return '' }
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
