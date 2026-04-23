import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { google, meet_v2 } from 'googleapis'
import { JWT } from 'google-auth-library'
import { stringify as yamlStringify } from 'yaml'
import { MeetClient } from '../classes/MeetClient.js'
import { embedText, isEmbeddingEnabled, zeroEmbedding } from './embeddings.js'
import { enrichFromCalendar, type CalendarEnrichment } from './transcriptEnrich.js'
import { Participant, renderTranscriptMarkdown } from './transcripts.js'
import { transcriptDb, type TranscriptRecord } from './transcriptDb.js'

export interface IngestResult {
  status: 'saved' | 'skipped' | 'failed'
  transcriptName: string
  transcriptId: string
  userEmail: string
  filePath?: string
  reason?: string
  error?: string
  record?: Omit<TranscriptRecord, 'embedding' | 'text'>
}

export interface IngestOptions {
  transcriptDir?: string
  generateEmbedding?: boolean
}

export interface PreparedTranscript {
  record: TranscriptRecord
  filePath: string
}

const TRANSCRIPT_NAME_RE = /^(conferenceRecords\/[^/]+)\/transcripts\/([^/]+)$/

export function parseTranscriptName(transcriptName: string): { conferenceRecordName: string; transcriptId: string } | undefined {
  const match = transcriptName.match(TRANSCRIPT_NAME_RE)
  if (!match) { return undefined }
  return { conferenceRecordName: match[1], transcriptId: match[2] }
}

export async function prepareTranscriptRecord(params: {
  userEmail: string
  transcriptName: string
  options?: IngestOptions
}): Promise<PreparedTranscript> {
  const { userEmail, transcriptName } = params
  const options = params.options ?? {}
  const parsed = parseTranscriptName(transcriptName)
  if (!parsed) { throw new Error(`Unrecognised transcript resource name: ${transcriptName}`) }
  const { conferenceRecordName, transcriptId } = parsed

  return MeetClient.withAuth(userEmail, async (auth) => {
    const fetched = await fetchTranscriptBundle(auth, conferenceRecordName, transcriptName)

    let calendar: CalendarEnrichment | undefined
    if (fetched.meetingCode) {
      try {
        calendar = await enrichFromCalendar({
          auth,
          meetingCode: fetched.meetingCode,
          conferenceStart: fetched.conference.startTime,
          conferenceEnd: fetched.conference.endTime
        })
      } catch (err) {
        process.stderr.write(`[silkweave-meet] calendar enrichment failed for ${fetched.meetingCode}: ${(err as Error).message}\n`)
      }
    }

    const organizerEmail = calendar?.organizerEmail || userEmail
    const transcriptDir = options.transcriptDir ?? MeetClient.getTranscriptDir()
    const userDir = join(transcriptDir, sanitizeEmailForPath(organizerEmail))
    if (!existsSync(userDir)) { mkdirSync(userDir, { recursive: true }) }

    const markdown = renderTranscriptMarkdown(fetched.entries, fetched.participants)
    const startTimeStr = fetched.transcript.startTime ?? fetched.conference.startTime ?? new Date().toISOString()
    const endTimeStr = fetched.transcript.endTime ?? fetched.conference.endTime ?? startTimeStr
    const date = startTimeStr.slice(0, 10)
    const slug = sanitizeForFilename(fetched.meetingCode ?? conferenceRecordName.replace('conferenceRecords/', ''))
    const filePath = join(userDir, `${date}_${slug}_${sanitizeForFilename(transcriptId)}.md`)

    const subject = calendar?.subject ?? ''
    const description = calendar?.description ?? ''
    const attendees = calendar?.attendees ?? []

    writeFileSync(filePath, renderTranscriptFile({
      subject,
      description,
      organizerEmail,
      attendees,
      meetingCode: fetched.meetingCode,
      conferenceRecordName,
      transcriptName,
      transcriptId,
      calendarEventId: calendar?.calendarEventId,
      spaceId: fetched.spaceId,
      startTime: startTimeStr,
      endTime: endTimeStr,
      entryCount: fetched.entries.length,
      markdown
    }), 'utf-8')

    const fullText = [subject, description, markdown].filter(Boolean).join('\n\n')

    let embedding = zeroEmbedding()
    let hasEmbedding = false
    const wantEmbedding = options.generateEmbedding !== false && isEmbeddingEnabled()
    if (wantEmbedding) {
      try {
        const vec = await embedText(fullText)
        if (vec && vec.length > 0) {
          embedding = vec
          hasEmbedding = true
        }
      } catch (err) {
        process.stderr.write(`[silkweave-meet] embedding failed for transcript ${transcriptId}: ${(err as Error).message}\n`)
      }
    }

    const record: TranscriptRecord = {
      id: transcriptId,
      transcriptName,
      conferenceRecordName,
      organizerEmail,
      subject,
      description,
      attendees,
      meetingCode: fetched.meetingCode ?? '',
      calendarEventId: calendar?.calendarEventId ?? '',
      spaceId: fetched.spaceId ?? '',
      startTime: Date.parse(startTimeStr) || Date.now(),
      endTime: Date.parse(endTimeStr) || Date.now(),
      startTimeIso: startTimeStr,
      endTimeIso: endTimeStr,
      filePath,
      entryCount: fetched.entries.length,
      text: fullText,
      embedding,
      hasEmbedding,
      createdAt: Date.now()
    }
    return { record, filePath }
  })
}

export async function ingestTranscript(params: {
  userEmail: string
  transcriptName: string
  options?: IngestOptions
}): Promise<IngestResult> {
  const { userEmail, transcriptName } = params
  const result: IngestResult = { status: 'failed', transcriptName, transcriptId: '', userEmail }
  const parsed = parseTranscriptName(transcriptName)
  if (!parsed) {
    result.error = `Unrecognised transcript resource name: ${transcriptName}`
    return result
  }
  result.transcriptId = parsed.transcriptId

  if (await transcriptDb.has(parsed.transcriptId)) {
    result.status = 'skipped'
    result.reason = 'already in database'
    return result
  }

  try {
    const prepared = await prepareTranscriptRecord(params)
    await transcriptDb.upsert(prepared.record)
    const { embedding: _e, text: _t, ...pub } = prepared.record
    result.status = 'saved'
    result.filePath = prepared.filePath
    result.record = pub
    return result
  } catch (err) {
    result.error = (err as Error).message
    return result
  }
}

interface FetchedBundle {
  entries: meet_v2.Schema$TranscriptEntry[]
  participants: Record<string, Participant>
  transcript: meet_v2.Schema$Transcript
  conference: meet_v2.Schema$ConferenceRecord
  meetingCode?: string
  spaceId?: string
}

async function fetchTranscriptBundle(auth: JWT, conferenceRecordName: string, transcriptName: string): Promise<FetchedBundle> {
  const meet = google.meet({ version: 'v2', auth })

  const entries: meet_v2.Schema$TranscriptEntry[] = []
  let entryPageToken: string | undefined
  do {
    const { data } = await meet.conferenceRecords.transcripts.entries.list({ parent: transcriptName, pageSize: 500, pageToken: entryPageToken })
    if (data.transcriptEntries) { entries.push(...data.transcriptEntries) }
    entryPageToken = data.nextPageToken ?? undefined
  } while (entryPageToken)

  const participants: Record<string, Participant> = {}
  let participantPageToken: string | undefined
  do {
    const { data } = await meet.conferenceRecords.participants.list({ parent: conferenceRecordName, pageSize: 100, pageToken: participantPageToken })
    for (const p of data.participants ?? []) {
      if (p.name) { participants[p.name] = p }
    }
    participantPageToken = data.nextPageToken ?? undefined
  } while (participantPageToken)

  const [transcript, conference] = await Promise.all([
    meet.conferenceRecords.transcripts.get({ name: transcriptName }).then((r) => r.data),
    meet.conferenceRecords.get({ name: conferenceRecordName }).then((r) => r.data)
  ])

  let meetingCode: string | undefined
  let spaceId: string | undefined
  if (conference.space) {
    try {
      const { data } = await meet.spaces.get({ name: conference.space })
      meetingCode = data.meetingCode ?? undefined
      spaceId = data.name?.replace('spaces/', '') ?? conference.space.replace('spaces/', '')
    } catch { /* space lookup may fail if no longer accessible */ }
  }

  return { entries, participants, transcript, conference, meetingCode, spaceId }
}

export function sanitizeEmailForPath(email: string): string {
  return email.replace(/[^a-zA-Z0-9._@-]/g, '-') || 'unknown'
}

export function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'unknown'
}

function renderTranscriptFile(params: {
  subject: string
  description: string
  organizerEmail: string
  attendees: string[]
  meetingCode?: string
  conferenceRecordName: string
  transcriptName: string
  transcriptId: string
  calendarEventId?: string
  spaceId?: string
  startTime: string
  endTime: string
  entryCount: number
  markdown: string
}): string {
  const frontmatter: Record<string, unknown> = {
    title: params.subject || 'Untitled meeting',
    date: params.startTime,
    end: params.endTime,
    organizer: params.organizerEmail,
    attendees: params.attendees,
    meet_code: params.meetingCode ?? '',
    space_id: params.spaceId ?? '',
    conference_record: params.conferenceRecordName,
    transcript: params.transcriptName,
    transcript_id: params.transcriptId,
    calendar_event_id: params.calendarEventId ?? '',
    entry_count: params.entryCount
  }
  const fm = yamlStringify(frontmatter, { defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0 }).trimEnd()
  const parts = [`---\n${fm}\n---`, '']
  if (params.subject) { parts.push(`# ${params.subject}`, '') }
  if (params.description) { parts.push('## Description', '', params.description, '') }
  parts.push('## Transcript', '', params.markdown)
  return `${parts.join('\n')}\n`
}
