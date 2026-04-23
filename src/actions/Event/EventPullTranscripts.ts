import { createAction } from '@silkweave/core'
import { google, meet_v2 } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { Participant, renderTranscriptMarkdown } from '../../lib/transcripts.js'

export const EventPullTranscripts = createAction({
  name: 'eventPullTranscripts',
  description: 'MCP-native polling for new Google Meet transcripts. On each call, returns transcripts generated since the last call (cursor stored in config per userEmail), then advances the cursor. First-time callers can pass `since` to seed the cursor; otherwise the last 24h are used. Idempotent: calling twice in a row returns an empty batch the second time. Impersonates `userEmail` via DWD.',
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    since: z.string().optional().describe('Initial cursor (RFC3339) if no cursor has been stored yet. Defaults to now - 24h.'),
    includeMarkdown: z.boolean().optional().default(true).describe('Render each new transcript to markdown in the response.'),
    maxConferences: z.number().int().min(1).max(100).optional().default(25)
  }),
  run: async ({ userEmail, since, includeMarkdown, maxConferences }) => {
    const cursor = MeetClient.getEventCursor(userEmail) ?? since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    return MeetClient.withAuth(userEmail, async (auth) => {
      const meet = google.meet({ version: 'v2', auth })

      const { data: conferencesData } = await meet.conferenceRecords.list({
        filter: `start_time>="${cursor}"`,
        pageSize: maxConferences
      })
      const conferences = conferencesData.conferenceRecords ?? []

      const results: Array<{
        conferenceRecord: string
        transcript: string
        endTime?: string | null
        markdown?: string
        entryCount?: number
      }> = []
      let newestEnd = cursor

      for (const conf of conferences) {
        if (!conf.name) { continue }
        const { data: transcriptsData } = await meet.conferenceRecords.transcripts.list({ parent: conf.name, pageSize: 10 })
        for (const transcript of transcriptsData.transcripts ?? []) {
          if (transcript.state !== 'FILE_GENERATED' || !transcript.name) { continue }
          if (transcript.endTime && transcript.endTime <= cursor) { continue }

          const row: (typeof results)[number] = {
            conferenceRecord: conf.name,
            transcript: transcript.name,
            endTime: transcript.endTime
          }

          if (includeMarkdown) {
            const entries: meet_v2.Schema$TranscriptEntry[] = []
            let nextPageToken: string | undefined
            do {
              const { data } = await meet.conferenceRecords.transcripts.entries.list({ parent: transcript.name, pageSize: 500, pageToken: nextPageToken })
              if (data.transcriptEntries) { entries.push(...data.transcriptEntries) }
              nextPageToken = data.nextPageToken ?? undefined
            } while (nextPageToken)

            const participants: Record<string, Participant> = {}
            let participantPageToken: string | undefined
            do {
              const { data } = await meet.conferenceRecords.participants.list({ parent: conf.name, pageSize: 100, pageToken: participantPageToken })
              for (const p of data.participants ?? []) {
                if (p.name) { participants[p.name] = p }
              }
              participantPageToken = data.nextPageToken ?? undefined
            } while (participantPageToken)

            row.markdown = renderTranscriptMarkdown(entries, participants)
            row.entryCount = entries.length
          }

          results.push(row)
          if (transcript.endTime && transcript.endTime > newestEnd) { newestEnd = transcript.endTime }
        }
      }

      MeetClient.setEventCursor(userEmail, newestEnd)
      return { cursor: newestEnd, previousCursor: cursor, transcripts: results }
    })
  }
})
