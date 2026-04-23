import { createAction } from '@silkweave/core'
import { google } from 'googleapis'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptDb } from '../../lib/transcriptDb.js'
import { prepareTranscriptRecord } from '../../lib/transcriptIngest.js'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

interface Pair {
  userEmail: string
  transcriptName: string
  transcriptId: string
  conferenceName: string
}

export const TranscriptBackfill = createAction({
  name: 'transcriptBackfill',
  description: 'Backfill persisted Meet transcripts for every configured user (or the subset in `userEmails`). Lists past conferences since `startTime` (default: 30 days ago), fetches each transcript in parallel, enriches with Calendar, writes a YAML-frontmatter Markdown file to `<transcriptDir>/<organizerEmail>/`, and indexes into the local search database. Dedupes by transcriptId — already-ingested transcripts are skipped.',
  input: z.object({
    startTime: z.string().optional().describe('RFC3339 lower bound on conference start time. Defaults to now - 30 days.'),
    userEmails: z.array(z.string()).optional().describe('Restrict backfill to this subset of configured users. Defaults to all config.users.'),
    maxConferencesPerUser: z.number().int().min(1).max(500).optional().default(200),
    concurrency: z.number().int().min(1).max(32).optional().default(8).describe('Parallel transcript fetches (Meet + Calendar + OpenAI).'),
    generateEmbedding: z.boolean().optional().default(true).describe('If OpenAI is configured, compute and store embeddings for newly-ingested transcripts.')
  }),
  run: async ({ startTime, userEmails, maxConferencesPerUser, concurrency, generateEmbedding }) => {
    const cursor = startTime ?? new Date(Date.now() - THIRTY_DAYS_MS).toISOString()
    const emails = userEmails?.length ? userEmails : MeetClient.listUsers()
    if (!emails.length) { throw new Error('No users configured. Add users with `setupSubscribeAll --users` or MeetClient.addUsers.') }

    const transcriptDir = MeetClient.getTranscriptDir()
    const startedAt = Date.now()

    const allPairs: Pair[] = []
    const listErrors: Array<{ userEmail: string; error: string }> = []
    const perUserDiscovered: Record<string, { conferences: number; transcriptsSeen: number; error?: string }> = {}
    for (const userEmail of emails) {
      const bucket = { conferences: 0, transcriptsSeen: 0 } as { conferences: number; transcriptsSeen: number; error?: string }
      perUserDiscovered[userEmail] = bucket
      try {
        await MeetClient.withAuth(userEmail, async (auth) => {
          const meet = google.meet({ version: 'v2', auth })
          let pageToken: string | undefined
          let scanned = 0
          do {
            const { data } = await meet.conferenceRecords.list({
              filter: `start_time>="${cursor}"`,
              pageSize: Math.min(100, maxConferencesPerUser - scanned),
              pageToken
            })
            const confs = data.conferenceRecords ?? []
            bucket.conferences += confs.length
            scanned += confs.length
            for (const conf of confs) {
              if (!conf.name) { continue }
              const { data: tx } = await meet.conferenceRecords.transcripts.list({ parent: conf.name, pageSize: 20 })
              for (const t of tx.transcripts ?? []) {
                if (t.state !== 'FILE_GENERATED' || !t.name) { continue }
                bucket.transcriptsSeen += 1
                const tid = t.name.split('/transcripts/')[1]
                if (!tid) { continue }
                allPairs.push({ userEmail, transcriptName: t.name, transcriptId: tid, conferenceName: conf.name })
              }
            }
            pageToken = data.nextPageToken ?? undefined
            if (scanned >= maxConferencesPerUser) { break }
          } while (pageToken)
        })
      } catch (err) {
        bucket.error = (err as Error).message
        listErrors.push({ userEmail, error: bucket.error })
      }
    }

    const seen = new Set<string>()
    const uniquePairs: Pair[] = []
    for (const p of allPairs) {
      if (seen.has(p.transcriptId)) { continue }
      seen.add(p.transcriptId)
      uniquePairs.push(p)
    }

    const toFetch: Pair[] = []
    let alreadyInDb = 0
    for (const p of uniquePairs) {
      if (await transcriptDb.has(p.transcriptId)) { alreadyInDb += 1 } else { toFetch.push(p) }
    }

    const prepared: Array<{ pair: Pair; record: Awaited<ReturnType<typeof prepareTranscriptRecord>>['record']; filePath: string }> = []
    const failures: Array<{ userEmail: string; transcriptName: string; error: string }> = []
    let cursorIdx = 0
    async function worker() {
      while (cursorIdx < toFetch.length) {
        const i = cursorIdx++
        const pair = toFetch[i]
        try {
          const result = await prepareTranscriptRecord({
            userEmail: pair.userEmail,
            transcriptName: pair.transcriptName,
            options: { transcriptDir, generateEmbedding }
          })
          prepared.push({ pair, record: result.record, filePath: result.filePath })
        } catch (err) {
          failures.push({ userEmail: pair.userEmail, transcriptName: pair.transcriptName, error: (err as Error).message })
        }
      }
    }
    const pool = Math.min(concurrency, Math.max(1, toFetch.length))
    await Promise.all(Array.from({ length: pool }, () => worker()))

    for (const p of prepared) {
      await transcriptDb.upsert(p.record, { skipSave: true })
    }
    if (prepared.length > 0) { await transcriptDb.save() }

    const perUser = emails.map((userEmail) => {
      const d = perUserDiscovered[userEmail] ?? { conferences: 0, transcriptsSeen: 0 }
      const savedForUser = prepared.filter((p) => p.pair.userEmail === userEmail).length
      const failedForUser = failures.filter((f) => f.userEmail === userEmail).length
      return {
        userEmail,
        conferences: d.conferences,
        transcriptsSeen: d.transcriptsSeen,
        saved: savedForUser,
        failed: failedForUser,
        error: d.error
      }
    })

    return {
      startTime: cursor,
      users: emails,
      transcriptDir,
      concurrency: pool,
      elapsedMs: Date.now() - startedAt,
      totals: {
        conferences: perUser.reduce((a, b) => a + b.conferences, 0),
        transcriptsSeen: uniquePairs.length,
        duplicatePairsAcrossUsers: allPairs.length - uniquePairs.length,
        alreadyInDb,
        saved: prepared.length,
        failed: failures.length
      },
      perUser,
      listErrors,
      failures
    }
  }
})
