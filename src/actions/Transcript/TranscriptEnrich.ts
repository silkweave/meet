import { createAction } from '@silkweave/core'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { embedText, isEmbeddingEnabled, zeroEmbedding } from '../../lib/embeddings.js'
import { transcriptDb, type TranscriptRecord } from '../../lib/transcriptDb.js'
import { enrichFromCalendar } from '../../lib/transcriptEnrich.js'
import { renderTranscriptFile, transcriptFilePath } from '../../lib/transcriptIngest.js'

export interface EnrichResult {
  id: string
  status: 'enriched' | 'unmatched' | 'failed'
  subject?: string
  organizerEmail?: string
  filePath?: string
  error?: string
}

export const TranscriptEnrich = createAction({
  name: 'transcriptEnrich',
  description: 'Re-run Calendar enrichment (subject, description, attendees, organizer) for transcripts already in the local archive, then rewrite the archive record and its Markdown file. Without `transcriptId` it processes every archived transcript that has no Calendar match yet (e.g. ingested before a matching fix). Uses only the stored meet code and times plus a Calendar lookup (impersonating the record\'s organizer, or `userEmail`, via DWD), so it also works for meetings older than Meet\'s retention window. Transcripts that get enriched are re-embedded when OpenAI is configured.',
  input: z.object({
    transcriptId: z.string().optional().describe('Enrich only this archived transcript (re-runs even if it already has a Calendar match). Omit to process every transcript without a Calendar match.'),
    userEmail: z.string().optional().describe('Workspace user whose calendar to search. Defaults to the record\'s organizer email, which is the ingesting user when no Calendar match was found.'),
    limit: z.number().int().min(1).max(10000).optional().describe('Maximum transcripts to process this run (batch mode only), newest first.')
  }),
  run: async ({ transcriptId, userEmail, limit }) => {
    let targets: TranscriptRecord[]
    if (transcriptId) {
      const record = await transcriptDb.get(transcriptId)
      if (!record) { throw new Error(`Transcript ${transcriptId} is not in the local archive`) }
      targets = [record]
    } else {
      const unmatched = await transcriptDb.listUnmatched()
      targets = limit ? unmatched.slice(0, limit) : unmatched
    }

    const results: EnrichResult[] = []
    for (const existing of targets) {
      results.push(await enrichRecord(existing, userEmail))
    }

    return {
      processed: results.length,
      enriched: results.filter((r) => r.status === 'enriched').length,
      unmatched: results.filter((r) => r.status === 'unmatched').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results
    }
  }
})

async function enrichRecord(existing: TranscriptRecord, userEmail: string | undefined): Promise<EnrichResult> {
  const id = existing.id
  try {
    if (!existing.meetingCode) { return { id, status: 'unmatched', error: 'record has no meet code' } }
    const calendar = await MeetClient.withAuth(userEmail || existing.organizerEmail, (auth) => enrichFromCalendar({
      auth,
      meetingCode: existing.meetingCode,
      conferenceStart: existing.startTimeIso,
      conferenceEnd: existing.endTimeIso
    }))
    if (!calendar) { return { id, status: 'unmatched' } }

    const markdown = transcriptMarkdown(existing)
    const organizerEmail = calendar.organizerEmail || existing.organizerEmail
    const filePath = transcriptFilePath({
      transcriptDir: MeetClient.getTranscriptDir(),
      organizerEmail,
      startTime: existing.startTimeIso,
      meetingCode: existing.meetingCode,
      conferenceRecordName: existing.conferenceRecordName,
      transcriptId: id
    })
    writeFileSync(filePath, renderTranscriptFile({
      subject: calendar.subject,
      description: calendar.description,
      organizerEmail,
      attendees: calendar.attendees,
      meetingCode: existing.meetingCode,
      conferenceRecordName: existing.conferenceRecordName,
      transcriptName: existing.transcriptName,
      transcriptId: id,
      calendarEventId: calendar.calendarEventId,
      spaceId: existing.spaceId,
      startTime: existing.startTimeIso,
      endTime: existing.endTimeIso,
      entryCount: existing.entryCount,
      markdown
    }), 'utf-8')

    const text = [calendar.subject, calendar.description, markdown].filter(Boolean).join('\n\n')
    // Enrichment changes the indexed text, so the stored vector is stale and is recomputed.
    let embedding = zeroEmbedding()
    let hasEmbedding = false
    if (isEmbeddingEnabled() && text.trim()) {
      try {
        const vec = await embedText(text)
        if (vec && vec.length > 0) {
          embedding = vec
          hasEmbedding = true
        }
      } catch (err) {
        process.stderr.write(`[silkweave-meet] embedding failed for transcript ${id}: ${(err as Error).message}\n`)
      }
    }

    await transcriptDb.upsert({
      ...existing,
      organizerEmail,
      subject: calendar.subject,
      description: calendar.description,
      attendees: calendar.attendees,
      calendarEventId: calendar.calendarEventId ?? '',
      filePath,
      text,
      embedding,
      hasEmbedding
    })

    // A new organizer moves the file to another folder; drop the stale copy, but only inside the
    // configured transcript dir so a changed `transcriptDir` never deletes files elsewhere.
    if (existing.filePath && existing.filePath !== filePath && isInside(MeetClient.getTranscriptDir(), existing.filePath) && existsSync(existing.filePath)) {
      unlinkSync(existing.filePath)
    }
    return { id, status: 'enriched', subject: calendar.subject || undefined, organizerEmail, filePath }
  } catch (err) {
    return { id, status: 'failed', error: (err as Error).message }
  }
}

const TRANSCRIPT_HEADING = '\n## Transcript\n\n'

/** The rendered transcript body: from the archived file when present, else from the indexed text. */
function transcriptMarkdown(record: TranscriptRecord): string {
  if (record.filePath && existsSync(record.filePath)) {
    const file = readFileSync(record.filePath, 'utf-8')
    const at = file.indexOf(TRANSCRIPT_HEADING)
    if (at >= 0) { return file.slice(at + TRANSCRIPT_HEADING.length).replace(/\n$/, '') }
  }
  const prefix = [record.subject, record.description].filter(Boolean).join('\n\n')
  return prefix && record.text.startsWith(`${prefix}\n\n`) ? record.text.slice(prefix.length + 2) : record.text
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}
