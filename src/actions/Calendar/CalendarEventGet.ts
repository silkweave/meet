import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const CalendarEventGet = createAction({
  name: 'calendarEventGet',
  description: 'Fetch a single Google Calendar event by ID. Includes Meet join info when present.',
  args: ['eventId'],
  input: z.object({
    userId: z.string().optional().default('default'),
    eventId: z.string(),
    calendarId: z.string().optional().default('primary')
  }),
  run: async ({ userId, eventId, calendarId }) => {
    const client = new MeetClient(userId)
    return client.withAuth(async (auth) => {
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
