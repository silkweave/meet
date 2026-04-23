import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { count, create, getByID, remove, search, update, upsert, type AnyOrama, type SearchParams, type TypedDocument } from '@orama/orama'
import { persistToFile, restoreFromFile } from '@orama/plugin-data-persistence/server'
import { MeetClient } from '../classes/MeetClient.js'

export const EMBEDDING_DIM = 1536

const SCHEMA = {
  id: 'string',
  transcriptName: 'string',
  conferenceRecordName: 'string',
  organizerEmail: 'string',
  subject: 'string',
  description: 'string',
  attendees: 'string[]',
  meetingCode: 'string',
  calendarEventId: 'string',
  spaceId: 'string',
  startTime: 'number',
  endTime: 'number',
  startTimeIso: 'string',
  endTimeIso: 'string',
  filePath: 'string',
  entryCount: 'number',
  text: 'string',
  embedding: `vector[${EMBEDDING_DIM}]`,
  hasEmbedding: 'boolean',
  createdAt: 'number'
} as const

export interface TranscriptRecord {
  id: string
  transcriptName: string
  conferenceRecordName: string
  organizerEmail: string
  subject: string
  description: string
  attendees: string[]
  meetingCode: string
  calendarEventId: string
  spaceId: string
  startTime: number
  endTime: number
  startTimeIso: string
  endTimeIso: string
  filePath: string
  entryCount: number
  text: string
  embedding: number[]
  hasEmbedding: boolean
  createdAt: number
}

export type TranscriptRecordPublic = Omit<TranscriptRecord, 'embedding' | 'text'>

type DocType = TypedDocument<AnyOrama>

export interface TranscriptListOptions {
  organizerEmail?: string
  startTimeFrom?: number
  startTimeTo?: number
  attendee?: string
  limit?: number
  offset?: number
}

export interface TranscriptSearchOptions extends TranscriptListOptions {
  query?: string
  mode?: 'fulltext' | 'vector' | 'hybrid'
  queryEmbedding?: number[]
  similarity?: number
}

export interface TranscriptHit {
  record: TranscriptRecordPublic
  score: number
  snippet?: string
}

class TranscriptDbImpl {
  private db?: AnyOrama
  private loaded = false
  private loadInFlight?: Promise<void>

  async init(): Promise<void> {
    if (this.loaded) { return }
    if (this.loadInFlight) { return this.loadInFlight }
    this.loadInFlight = this.loadFromDisk()
    try { await this.loadInFlight } finally { this.loadInFlight = undefined }
  }

  private async loadFromDisk(): Promise<void> {
    const path = MeetClient.transcriptDbPath
    MeetClient.ensureConfigDir()
    if (existsSync(path)) {
      try {
        this.db = await restoreFromFile('binary', path)
        this.loaded = true
        return
      } catch (err) {
        process.stderr.write(`[silkweave-meet] transcriptDb restore failed (${(err as Error).message}); starting fresh\n`)
      }
    }
    this.db = create({ schema: SCHEMA })
    this.loaded = true
    await this.save()
  }

  private getDb(): AnyOrama {
    if (!this.db) { throw new Error('transcriptDb not initialised — call init() first') }
    return this.db
  }

  async save(): Promise<void> {
    const path = MeetClient.transcriptDbPath
    const dir = dirname(path)
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }) }
    await persistToFile(this.getDb(), 'binary', path)
  }

  async has(id: string): Promise<boolean> {
    await this.init()
    const doc = getByID(this.getDb(), id)
    return doc !== undefined && doc !== null
  }

  async get(id: string): Promise<TranscriptRecord | undefined> {
    await this.init()
    const doc = getByID(this.getDb(), id)
    return doc ? (doc as unknown as TranscriptRecord) : undefined
  }

  async upsert(record: TranscriptRecord, opts: { skipSave?: boolean } = {}): Promise<void> {
    await this.init()
    await upsert(this.getDb(), record as unknown as DocType)
    if (!opts.skipSave) { await this.save() }
  }

  async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const existing = await this.get(id)
    if (!existing) { return }
    await this.upsert({ ...existing, embedding, hasEmbedding: true })
  }

  async listForReembed(onlyMissing: boolean): Promise<Array<{ id: string; text: string; hasEmbedding: boolean }>> {
    await this.init()
    const params: Record<string, unknown> = { limit: 10000 }
    if (onlyMissing) { params.where = { hasEmbedding: false } }
    const results = await search(this.getDb(), params as SearchParams<AnyOrama>)
    return results.hits.map((h) => {
      const doc = h.document as unknown as TranscriptRecord
      return { id: doc.id, text: doc.text, hasEmbedding: doc.hasEmbedding }
    })
  }

  async updateEmbeddings(pairs: Array<{ id: string; embedding: number[] }>): Promise<number> {
    await this.init()
    let updated = 0
    for (const pair of pairs) {
      const existing = await this.get(pair.id)
      if (!existing) { continue }
      const next: TranscriptRecord = { ...existing, embedding: pair.embedding, hasEmbedding: true }
      await update(this.getDb(), pair.id, next as unknown as DocType)
      updated += 1
    }
    if (updated > 0) { await this.save() }
    return updated
  }

  async remove(id: string): Promise<boolean> {
    await this.init()
    const ok = await remove(this.getDb(), id)
    if (ok) { await this.save() }
    return ok
  }

  async list(opts: TranscriptListOptions = {}): Promise<{ total: number; results: TranscriptHit[] }> {
    return this.search(opts)
  }

  async search(opts: TranscriptSearchOptions = {}): Promise<{ total: number; results: TranscriptHit[] }> {
    await this.init()
    const where = buildWhere(opts)
    const limit = opts.limit ?? 20
    const offset = opts.offset ?? 0

    const params: Record<string, unknown> = { limit, offset }
    if (Object.keys(where).length > 0) { params.where = where }

    const mode = opts.mode ?? (opts.query ? 'fulltext' : 'fulltext')

    if (mode === 'vector' && opts.queryEmbedding) {
      params.mode = 'vector'
      params.vector = { value: opts.queryEmbedding, property: 'embedding' }
      if (opts.similarity !== undefined) { params.similarity = opts.similarity }
    } else if (mode === 'hybrid' && opts.queryEmbedding && opts.query) {
      params.mode = 'hybrid'
      params.term = opts.query
      params.vector = { value: opts.queryEmbedding, property: 'embedding' }
      if (opts.similarity !== undefined) { params.similarity = opts.similarity }
    } else if (opts.query) {
      params.term = opts.query
      params.properties = ['subject', 'description', 'text']
      params.boost = { subject: 3, description: 2, text: 1 }
      params.sortBy = { property: 'startTime', order: 'DESC' }
    } else {
      params.sortBy = { property: 'startTime', order: 'DESC' }
    }

    const results = await search(this.getDb(), params as SearchParams<AnyOrama>)
    const hits: TranscriptHit[] = results.hits.map((h) => {
      const doc = h.document as unknown as TranscriptRecord
      const { embedding: _embedding, text, ...rest } = doc
      return {
        record: rest,
        score: h.score,
        snippet: opts.query ? makeSnippet(text, opts.query) : undefined
      }
    })
    return { total: results.count, results: hits }
  }

  async count(): Promise<number> {
    await this.init()
    return count(this.getDb())
  }
}

function buildWhere(opts: TranscriptListOptions): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  if (opts.organizerEmail) { where.organizerEmail = opts.organizerEmail }
  if (opts.attendee) { where.attendees = opts.attendee }
  if (opts.startTimeFrom !== undefined || opts.startTimeTo !== undefined) {
    const range: Record<string, number> = {}
    if (opts.startTimeFrom !== undefined) { range.gte = opts.startTimeFrom }
    if (opts.startTimeTo !== undefined) { range.lte = opts.startTimeTo }
    where.startTime = range
  }
  return where
}

function makeSnippet(text: string, query: string, radius = 120): string | undefined {
  if (!text || !query) { return undefined }
  const needle = query.toLowerCase()
  const hay = text.toLowerCase()
  const idx = hay.indexOf(needle)
  if (idx < 0) { return text.slice(0, radius * 2) }
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + needle.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

export const transcriptDb = new TranscriptDbImpl()
