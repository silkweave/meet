import { createAction } from '@silkweave/core'
import { google, meet_v2 } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { Participant, renderTranscriptMarkdown } from '../../lib/transcripts.js'

export const MeetTranscriptGet = createAction({
  name: 'meetTranscriptGet',
  description: 'Retrieve a full Google Meet transcript (all entries aggregated) rendered as Markdown or JSON. Defaults to the first transcript of the conference if no transcriptId is given. Impersonates `userEmail` via DWD.',
  args: ['conferenceRecordId'],
  input: z.object({
    userEmail: z.string().describe('Workspace user email to impersonate via DWD'),
    conferenceRecordId: z.string(),
    transcriptId: z.string().optional().describe('Bare transcript ID or full `conferenceRecords/{c}/transcripts/{t}` name. Defaults to the first available.'),
    format: z.enum(['markdown', 'json']).optional().default('markdown')
  }),
  run: async ({ userEmail, conferenceRecordId, transcriptId, format }) => {
    const parent = conferenceRecordId.startsWith('conferenceRecords/') ? conferenceRecordId : `conferenceRecords/${conferenceRecordId}`

    return MeetClient.withAuth(userEmail, async (auth) => {
      const meet = google.meet({ version: 'v2', auth })

      let transcriptName: string
      if (transcriptId) {
        transcriptName = transcriptId.includes('/transcripts/') ? transcriptId : `${parent}/transcripts/${transcriptId}`
      } else {
        const { data } = await meet.conferenceRecords.transcripts.list({ parent, pageSize: 10 })
        const first = data.transcripts?.[0]
        if (!first?.name) { throw new Error(`No transcripts found for ${parent}`) }
        transcriptName = first.name
      }

      const entries: meet_v2.Schema$TranscriptEntry[] = []
      let nextPageToken: string | undefined
      do {
        const { data } = await meet.conferenceRecords.transcripts.entries.list({ parent: transcriptName, pageSize: 500, pageToken: nextPageToken })
        if (data.transcriptEntries) { entries.push(...data.transcriptEntries) }
        nextPageToken = data.nextPageToken ?? undefined
      } while (nextPageToken)

      const participants: Record<string, Participant> = {}
      let participantPageToken: string | undefined
      do {
        const { data } = await meet.conferenceRecords.participants.list({ parent, pageSize: 100, pageToken: participantPageToken })
        for (const p of data.participants ?? []) {
          if (p.name) { participants[p.name] = p }
        }
        participantPageToken = data.nextPageToken ?? undefined
      } while (participantPageToken)

      if (format === 'json') {
        return { transcript: transcriptName, entries, participants }
      }
      const markdown = renderTranscriptMarkdown(entries, participants)
      return { transcript: transcriptName, markdown, entryCount: entries.length }
    })
  }
})
