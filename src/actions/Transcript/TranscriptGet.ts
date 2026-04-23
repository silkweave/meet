import { readFileSync } from 'fs'
import { createAction } from '@silkweave/core'
import z from 'zod'
import { transcriptDb } from '../../lib/transcriptDb.js'

export const TranscriptGet = createAction({
  name: 'transcriptGet',
  description: 'Fetch a previously-persisted Meet transcript by its transcriptId (not live from Google). Returns the enriched metadata and the rendered markdown body read from disk.',
  args: ['transcriptId'],
  input: z.object({
    transcriptId: z.string().describe('Bare transcriptId. Accepts the full `conferenceRecords/{c}/transcripts/{t}` name; only the last segment is used.'),
    includeBody: z.boolean().optional().default(true).describe('Include the markdown body read from the persisted file.')
  }),
  run: async ({ transcriptId, includeBody }) => {
    const id = transcriptId.includes('/transcripts/') ? transcriptId.split('/transcripts/')[1] : transcriptId
    const record = await transcriptDb.get(id)
    if (!record) { throw new Error(`No persisted transcript found for id ${id}`) }

    const { embedding: _e, text: _t, ...pub } = record
    let markdown: string | undefined
    if (includeBody) {
      try { markdown = readFileSync(record.filePath, 'utf-8') } catch (err) {
        throw new Error(`Transcript file missing at ${record.filePath}: ${(err as Error).message}`)
      }
    }
    return { record: pub, markdown }
  }
})
