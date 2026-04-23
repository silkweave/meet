import { createAction } from '@silkweave/core'
import z from 'zod'
import { embedText, isEmbeddingEnabled } from '../../lib/embeddings.js'
import { transcriptDb } from '../../lib/transcriptDb.js'

export const TranscriptSearch = createAction({
  name: 'transcriptSearch',
  description: 'Search previously-persisted Meet transcripts (not live from Google). Combines full-text over subject/description/transcript body with optional vector/hybrid search when OpenAI embeddings are configured. Results are scoped to transcripts already ingested by the watcher or backfill.',
  input: z.object({
    query: z.string().optional().describe('Free-text search query. Omit to list without keyword filter (still honours the other filters).'),
    mode: z.enum(['fulltext', 'vector', 'hybrid']).optional().default('fulltext').describe('Search mode. `vector` and `hybrid` require OPENAI_API_KEY (or openai config in ~/.silkweave-meet/config.json).'),
    organizerEmail: z.string().optional().describe('Only match transcripts whose organiser is this user.'),
    attendee: z.string().optional().describe('Only match transcripts that include this attendee email.'),
    startTimeFrom: z.string().optional().describe('RFC3339 lower bound on the conference start time.'),
    startTimeTo: z.string().optional().describe('RFC3339 upper bound on the conference start time.'),
    similarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity for vector/hybrid mode (default 0.8).'),
    limit: z.number().int().min(1).max(100).optional().default(20),
    offset: z.number().int().min(0).optional().default(0)
  }),
  run: async ({ query, mode, organizerEmail, attendee, startTimeFrom, startTimeTo, similarity, limit, offset }) => {
    let queryEmbedding: number[] | undefined
    if ((mode === 'vector' || mode === 'hybrid') && query) {
      if (!isEmbeddingEnabled()) {
        throw new Error('Vector/hybrid search requires OPENAI_API_KEY (or `openai.apiKey` in ~/.silkweave-meet/config.json).')
      }
      queryEmbedding = await embedText(query)
      if (!queryEmbedding) { throw new Error('Failed to compute query embedding.') }
    }

    const { total, results } = await transcriptDb.search({
      query,
      mode,
      queryEmbedding,
      similarity,
      organizerEmail,
      attendee,
      startTimeFrom: startTimeFrom ? Date.parse(startTimeFrom) : undefined,
      startTimeTo: startTimeTo ? Date.parse(startTimeTo) : undefined,
      limit,
      offset
    })

    return { total, count: results.length, mode, results }
  }
})
