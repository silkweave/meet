import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const CalendarEventGet = createAction({
  name: 'calendarEventGet',
  description: 'Fetch a single Google Calendar event by ID. Includes Meet join info when present. Impersonates `userEmail` via DWD.',
  args: ['eventId'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    eventId: z.string(),
    calendarId: z.string().optional().default('primary')
  }),
  run: async ({ userEmail, eventId, calendarId }) => {
    return MeetClient.withAuth(userEmail, async (auth) => {
      const { data } = await google.calendar({ version: 'v3', auth }).events.get({ calendarId, eventId })
      const entryPoint = data.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
      return {
        ...data,
        meetUri: entryPoint?.uri,
        meetCode: data.conferenceData?.conferenceId
      }
    })
  }
})
