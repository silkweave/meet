import { createAction } from '@silkweave/core'
import z from 'zod'
import { embedText, isEmbeddingEnabled } from '../../lib/embeddings.js'
import { transcriptDb } from '../../lib/transcriptDb.js'

const DEFAULT_CONCURRENCY = 4

export const TranscriptReembed = createAction({
  name: 'transcriptReembed',
  description: 'Compute or recompute OpenAI embeddings for persisted transcripts. By default operates on records that were ingested without an embedding (typical after adding the OpenAI key to an already-populated archive). Pass `force=true` to re-embed every record. Requires OPENAI_API_KEY (or openai.apiKey in ~/.silkweave-meet/config.json).',
  input: z.object({
    force: z.boolean().optional().default(false).describe('Re-embed every record, even those already carrying an embedding.'),
    concurrency: z.number().int().min(1).max(16).optional().default(DEFAULT_CONCURRENCY).describe('Parallel OpenAI embedding requests.'),
    limit: z.number().int().min(1).max(10000).optional().describe('Maximum records to (re-)embed this run. Omit to process everything eligible.')
  }),
  run: async ({ force, concurrency, limit }) => {
    if (!isEmbeddingEnabled()) {
      throw new Error('OpenAI is not configured. Set OPENAI_API_KEY or openai.apiKey in ~/.silkweave-meet/config.json.')
    }

    const candidates = await transcriptDb.listForReembed(!force)
    const targets = limit ? candidates.slice(0, limit) : candidates
    if (targets.length === 0) {
      return { force, processed: 0, updated: 0, failed: 0, skipped: 0, message: force ? 'no records in archive' : 'all records already have embeddings' }
    }

    const results: Array<{ id: string; embedding?: number[]; error?: string }> = []
    let cursor = 0
    async function worker() {
      while (cursor < targets.length) {
        const i = cursor++
        const row = targets[i]
        try {
          if (!row.text?.trim()) {
            results.push({ id: row.id, error: 'empty text' })
            continue
          }
          const vec = await embedText(row.text)
          if (!vec) {
            results.push({ id: row.id, error: 'embedText returned undefined' })
            continue
          }
          results.push({ id: row.id, embedding: vec })
        } catch (err) {
          results.push({ id: row.id, error: (err as Error).message })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()))

    const successful = results.filter((r) => r.embedding).map((r) => ({ id: r.id, embedding: r.embedding! }))
    const updated = await transcriptDb.updateEmbeddings(successful)
    const failures = results.filter((r) => r.error)

    return {
      force,
      processed: targets.length,
      updated,
      failed: failures.length,
      skipped: candidates.length - targets.length,
      failures: failures.map((f) => ({ id: f.id, error: f.error }))
    }
  }
})
