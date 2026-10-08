import { existsSync } from 'fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { MeetClient } from '../classes/MeetClient.js'

export const EMBEDDING_DIM = 1536

const SCHEMA_VERSION = '1'
const DEFAULT_SIMILARITY = 0.8

// `pk` is an explicit INTEGER PRIMARY KEY so the external-content FTS rowids stay stable across VACUUM
// (implicit rowids of a table without one may be renumbered).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS transcripts (
  pk INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  transcript_name TEXT NOT NULL,
  conference_record_name TEXT NOT NULL,
  organizer_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]',
  meeting_code TEXT NOT NULL DEFAULT '',
  calendar_event_id TEXT NOT NULL DEFAULT '',
  space_id TEXT NOT NULL DEFAULT '',
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  start_time_iso TEXT NOT NULL,
  end_time_iso TEXT NOT NULL,
  file_path TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_start ON transcripts(start_time DESC);
CREATE INDEX IF NOT EXISTS transcripts_organizer ON transcripts(organizer_email);

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  subject, description, text,
  content='transcripts', content_rowid='pk', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS transcripts_fts_ai AFTER INSERT ON transcripts BEGIN
  INSERT INTO transcripts_fts(rowid, subject, description, text) VALUES (new.pk, new.subject, new.description, new.text);
END;
CREATE TRIGGER IF NOT EXISTS transcripts_fts_ad AFTER DELETE ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, subject, description, text) VALUES ('delete', old.pk, old.subject, old.description, old.text);
END;
CREATE TRIGGER IF NOT EXISTS transcripts_fts_au AFTER UPDATE OF subject, description, text ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, subject, description, text) VALUES ('delete', old.pk, old.subject, old.description, old.text);
  INSERT INTO transcripts_fts(rowid, subject, description, text) VALUES (new.pk, new.subject, new.description, new.text);
END;
`

const PUBLIC_COLUMNS = `t.id, t.transcript_name, t.conference_record_name, t.organizer_email, t.subject, t.description,
  t.attendees, t.meeting_code, t.calendar_event_id, t.space_id, t.start_time, t.end_time, t.start_time_iso,
  t.end_time_iso, t.file_path, t.entry_count, t.created_at, (t.embedding IS NOT NULL) AS has_embedding`

const INSERT_COLUMNS = `(id, transcript_name, conference_record_name, organizer_email, subject, description, attendees,
  meeting_code, calendar_event_id, space_id, start_time, end_time, start_time_iso, end_time_iso, file_path, entry_count,
  text, embedding, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_IGNORE_SQL = `INSERT OR IGNORE INTO transcripts ${INSERT_COLUMNS}`

const UPSERT_SQL = `
INSERT INTO transcripts ${INSERT_COLUMNS}
ON CONFLICT(id) DO UPDATE SET
  transcript_name = excluded.transcript_name,
  conference_record_name = excluded.conference_record_name,
  organizer_email = excluded.organizer_email,
  subject = excluded.subject,
  description = excluded.description,
  attendees = excluded.attendees,
  meeting_code = excluded.meeting_code,
  calendar_event_id = excluded.calendar_event_id,
  space_id = excluded.space_id,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  start_time_iso = excluded.start_time_iso,
  end_time_iso = excluded.end_time_iso,
  file_path = excluded.file_path,
  entry_count = excluded.entry_count,
  text = excluded.text,
  embedding = excluded.embedding,
  created_at = excluded.created_at
`

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

type Row = Record<string, unknown>

interface Filter {
  sql: string
  params: SQLInputValue[]
}

class TranscriptDbImpl {
  private db?: DatabaseSync
  private initInFlight?: Promise<void>

  async init(): Promise<void> {
    if (this.db) { return }
    if (this.initInFlight) { return this.initInFlight }
    this.initInFlight = this.open()
    try { await this.initInFlight } finally { this.initInFlight = undefined }
  }

  private async open(): Promise<void> {
    MeetClient.ensureConfigDir()
    const db = new DatabaseSync(MeetClient.transcriptDbPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec(SCHEMA_SQL)
      // Check first so a normal boot never takes the write lock (another process may be migrating).
      if (!db.prepare('SELECT 1 FROM meta WHERE key = \'schema_version\'').get()) {
        db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (\'schema_version\', ?)').run(SCHEMA_VERSION)
      }
      await migrateFromOrama(db)
    } catch (err) {
      db.close()
      throw err
    }
    this.db = db
  }

  private async conn(): Promise<DatabaseSync> {
    await this.init()
    return this.db!
  }

  /** No-op: every write is committed immediately. Kept for API compatibility. */
  async save(): Promise<void> {}

  async has(id: string): Promise<boolean> {
    const db = await this.conn()
    return db.prepare('SELECT 1 FROM transcripts WHERE id = ?').get(id) !== undefined
  }

  async get(id: string): Promise<TranscriptRecord | undefined> {
    const db = await this.conn()
    const row = db.prepare(`SELECT ${PUBLIC_COLUMNS}, t.text, t.embedding FROM transcripts t WHERE t.id = ?`).get(id)
    return row ? rowToRecord(row) : undefined
  }

  /** `opts.skipSave` is accepted for API compatibility and ignored. */
  async upsert(record: TranscriptRecord, _opts: { skipSave?: boolean } = {}): Promise<void> {
    const db = await this.conn()
    db.prepare(UPSERT_SQL).run(...recordParams(record))
  }

  /** Upserts many records in one write transaction. */
  async upsertMany(records: TranscriptRecord[]): Promise<void> {
    if (records.length === 0) { return }
    const db = await this.conn()
    const stmt = db.prepare(UPSERT_SQL)
    transaction(db, () => {
      for (const record of records) { stmt.run(...recordParams(record)) }
    })
  }

  async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.updateEmbeddings([{ id, embedding }])
  }

  async updateEmbeddings(pairs: Array<{ id: string; embedding: number[] }>): Promise<number> {
    if (pairs.length === 0) { return 0 }
    const db = await this.conn()
    const stmt = db.prepare('UPDATE transcripts SET embedding = ? WHERE id = ?')
    let updated = 0
    transaction(db, () => {
      for (const pair of pairs) {
        updated += Number(stmt.run(encodeEmbedding(pair.embedding, true), pair.id).changes)
      }
    })
    return updated
  }

  async listForReembed(onlyMissing: boolean): Promise<Array<{ id: string; text: string; hasEmbedding: boolean }>> {
    const db = await this.conn()
    const where = onlyMissing ? 'WHERE embedding IS NULL' : ''
    const rows = db.prepare(`SELECT id, text, (embedding IS NOT NULL) AS has_embedding FROM transcripts ${where} ORDER BY start_time DESC`).all()
    return rows.map((r) => ({ id: String(r.id), text: String(r.text), hasEmbedding: Boolean(r.has_embedding) }))
  }

  async all(): Promise<TranscriptRecord[]> {
    const db = await this.conn()
    return db.prepare(`SELECT ${PUBLIC_COLUMNS}, t.text, t.embedding FROM transcripts t ORDER BY t.start_time DESC`).all().map(rowToRecord)
  }

  /** Records without a Calendar match, newest first. */
  async listUnmatched(): Promise<TranscriptRecord[]> {
    const db = await this.conn()
    return db.prepare(`SELECT ${PUBLIC_COLUMNS}, t.text, t.embedding FROM transcripts t WHERE t.calendar_event_id = '' ORDER BY t.start_time DESC`).all().map(rowToRecord)
  }

  async remove(id: string): Promise<boolean> {
    const db = await this.conn()
    return Number(db.prepare('DELETE FROM transcripts WHERE id = ?').run(id).changes) > 0
  }

  async count(): Promise<number> {
    const db = await this.conn()
    return Number(db.prepare('SELECT count(*) AS n FROM transcripts').get()!.n)
  }

  async list(opts: TranscriptListOptions = {}): Promise<{ total: number; results: TranscriptHit[] }> {
    return this.search(opts)
  }

  async search(opts: TranscriptSearchOptions = {}): Promise<{ total: number; results: TranscriptHit[] }> {
    const db = await this.conn()
    const limit = opts.limit ?? 20
    const offset = opts.offset ?? 0
    const filter = buildFilter(opts)
    const match = opts.query ? buildMatch(opts.query) : undefined
    const mode = opts.mode ?? 'fulltext'

    if (mode === 'vector' && opts.queryEmbedding) {
      return this.vectorSearch(db, filter, opts.queryEmbedding, opts, limit, offset)
    }
    if (mode === 'hybrid' && opts.queryEmbedding && match) {
      return this.hybridSearch(db, filter, match, opts.queryEmbedding, opts, limit, offset)
    }
    if (match) {
      return this.fulltextSearch(db, filter, match, opts, limit, offset)
    }

    const total = Number(db.prepare(`SELECT count(*) AS n FROM transcripts t ${whereClause(filter)}`).get(...filter.params)!.n)
    const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM transcripts t ${whereClause(filter)} ORDER BY t.start_time DESC LIMIT ? OFFSET ?`)
      .all(...filter.params, limit, offset)
    return { total, results: rows.map((r) => ({ record: rowToPublic(r), score: 0, snippet: undefined })) }
  }

  private fulltextSearch(db: DatabaseSync, filter: Filter, match: string, opts: TranscriptSearchOptions, limit: number, offset: number) {
    const where = whereClause(filter, ['transcripts_fts MATCH ?'])
    const from = 'FROM transcripts_fts JOIN transcripts t ON t.pk = transcripts_fts.rowid'
    const params = [match, ...filter.params]
    const total = Number(db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(...params)!.n)
    // Ordered by start time (newest first), as before; score is the BM25 relevance.
    const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS}, t.text, -bm25(transcripts_fts, 3.0, 2.0, 1.0) AS score ${from} ${where}
      ORDER BY t.start_time DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
    return {
      total,
      results: rows.map((r) => ({ record: rowToPublic(r), score: Number(r.score), snippet: makeSnippet(String(r.text), opts.query!) }))
    }
  }

  private vectorSearch(db: DatabaseSync, filter: Filter, queryEmbedding: number[], opts: TranscriptSearchOptions, limit: number, offset: number) {
    const threshold = opts.similarity ?? DEFAULT_SIMILARITY
    const scored = this.vectorScores(db, filter, queryEmbedding)
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
    return this.materialise(db, scored, opts, limit, offset)
  }

  private hybridSearch(db: DatabaseSync, filter: Filter, match: string, queryEmbedding: number[], opts: TranscriptSearchOptions, limit: number, offset: number) {
    const threshold = opts.similarity ?? DEFAULT_SIMILARITY
    const textRows = db.prepare(`SELECT t.id, -bm25(transcripts_fts, 3.0, 2.0, 1.0) AS score
      FROM transcripts_fts JOIN transcripts t ON t.pk = transcripts_fts.rowid ${whereClause(filter, ['transcripts_fts MATCH ?'])}`)
      .all(match, ...filter.params)
    const maxText = textRows.reduce((m, r) => Math.max(m, Number(r.score)), 0)
    const textScores = new Map(textRows.map((r) => [String(r.id), maxText > 0 ? Number(r.score) / maxText : 0]))
    const vectorScores = new Map(this.vectorScores(db, filter, queryEmbedding).map((s) => [s.id, s.score]))

    const ids = new Set(textScores.keys())
    for (const [id, score] of vectorScores) { if (score >= threshold) { ids.add(id) } }
    const scored = [...ids]
      .map((id) => ({ id, score: 0.5 * (textScores.get(id) ?? 0) + 0.5 * Math.max(0, vectorScores.get(id) ?? 0) }))
      .sort((a, b) => b.score - a.score)
    return this.materialise(db, scored, opts, limit, offset)
  }

  private vectorScores(db: DatabaseSync, filter: Filter, queryEmbedding: number[]): Array<{ id: string; score: number }> {
    const query = Float32Array.from(queryEmbedding)
    const queryNorm = norm(query)
    if (queryNorm === 0) { return [] }
    const rows = db.prepare(`SELECT t.id, t.embedding FROM transcripts t ${whereClause(filter, ['t.embedding IS NOT NULL'])}`).all(...filter.params)
    return rows.map((r) => ({ id: String(r.id), score: cosine(query, queryNorm, decodeEmbedding(r.embedding as Uint8Array)) }))
  }

  /** Paginates a scored id list and fetches the page's records in score order. */
  private materialise(db: DatabaseSync, scored: Array<{ id: string; score: number }>, opts: TranscriptSearchOptions, limit: number, offset: number) {
    const page = scored.slice(offset, offset + limit)
    if (page.length === 0) { return { total: scored.length, results: [] } }
    const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS}, t.text FROM transcripts t WHERE t.id IN (${page.map(() => '?').join(', ')})`)
      .all(...page.map((p) => p.id))
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    const results: TranscriptHit[] = []
    for (const p of page) {
      const r = byId.get(p.id)
      if (!r) { continue }
      results.push({ record: rowToPublic(r), score: p.score, snippet: opts.query ? makeSnippet(String(r.text), opts.query) : undefined })
    }
    return { total: scored.length, results }
  }
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function recordParams(r: TranscriptRecord): SQLInputValue[] {
  return [
    r.id, r.transcriptName, r.conferenceRecordName, r.organizerEmail, r.subject ?? '', r.description ?? '',
    JSON.stringify(r.attendees ?? []), r.meetingCode ?? '', r.calendarEventId ?? '', r.spaceId ?? '',
    r.startTime, r.endTime, r.startTimeIso, r.endTimeIso, r.filePath, r.entryCount, r.text ?? '',
    encodeEmbedding(r.embedding, r.hasEmbedding), r.createdAt
  ]
}

/** Float32 bytes, or NULL when there is no (non-zero) embedding. */
function encodeEmbedding(embedding: number[] | undefined, hasEmbedding: boolean): Uint8Array | null {
  if (!hasEmbedding || !embedding?.length || embedding.every((v) => v === 0)) { return null }
  const vec = Float32Array.from(embedding)
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

function decodeEmbedding(blob: Uint8Array): Float32Array {
  // Copy so the Float32Array view is 4-byte aligned regardless of the source buffer offset.
  return new Float32Array(blob.slice().buffer)
}

function norm(v: Float32Array): number {
  let sum = 0
  for (const x of v) { sum += x * x }
  return Math.sqrt(sum)
}

function cosine(query: Float32Array, queryNorm: number, vec: Float32Array): number {
  if (vec.length !== query.length) { return 0 }
  let dot = 0
  let vecSum = 0
  for (let i = 0; i < vec.length; i++) {
    dot += query[i] * vec[i]
    vecSum += vec[i] * vec[i]
  }
  return vecSum === 0 ? 0 : dot / (queryNorm * Math.sqrt(vecSum))
}

function rowToPublic(r: Row): TranscriptRecordPublic {
  return {
    id: String(r.id),
    transcriptName: String(r.transcript_name),
    conferenceRecordName: String(r.conference_record_name),
    organizerEmail: String(r.organizer_email),
    subject: String(r.subject),
    description: String(r.description),
    attendees: parseAttendees(r.attendees),
    meetingCode: String(r.meeting_code),
    calendarEventId: String(r.calendar_event_id),
    spaceId: String(r.space_id),
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    startTimeIso: String(r.start_time_iso),
    endTimeIso: String(r.end_time_iso),
    filePath: String(r.file_path),
    entryCount: Number(r.entry_count),
    hasEmbedding: Boolean(r.has_embedding),
    createdAt: Number(r.created_at)
  }
}

function rowToRecord(r: Row): TranscriptRecord {
  const blob = r.embedding as Uint8Array | null
  return {
    ...rowToPublic(r),
    text: String(r.text),
    embedding: blob ? Array.from(decodeEmbedding(blob)) : new Array(EMBEDDING_DIM).fill(0)
  }
}

function parseAttendees(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function buildFilter(opts: TranscriptListOptions): Filter {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  if (opts.organizerEmail) {
    clauses.push('t.organizer_email = ?')
    params.push(opts.organizerEmail)
  }
  if (opts.attendee) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(t.attendees) WHERE value = ?)')
    params.push(opts.attendee)
  }
  if (opts.startTimeFrom !== undefined) {
    clauses.push('t.start_time >= ?')
    params.push(opts.startTimeFrom)
  }
  if (opts.startTimeTo !== undefined) {
    clauses.push('t.start_time <= ?')
    params.push(opts.startTimeTo)
  }
  return { sql: clauses.join(' AND '), params }
}

/** WHERE clause; `leading` clauses come first so their params must precede the filter params. */
function whereClause(filter: Filter, leading: string[] = []): string {
  const clauses = [...leading, ...(filter.sql ? [filter.sql] : [])]
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

/**
 * FTS5 MATCH expression from free user input: every whitespace-separated token becomes a quoted
 * prefix term (`"tok"*`), AND-ed together, so user input can never produce an FTS syntax error.
 * Returns undefined when the query has no tokens.
 */
function buildMatch(query: string): string | undefined {
  const tokens = query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t))
  if (tokens.length === 0) { return undefined }
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ')
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

interface OramaDoc {
  id?: string
  transcriptName?: string
  conferenceRecordName?: string
  organizerEmail?: string
  subject?: string
  description?: string
  attendees?: string[]
  meetingCode?: string
  calendarEventId?: string
  spaceId?: string
  startTime?: number
  endTime?: number
  startTimeIso?: string
  endTimeIso?: string
  filePath?: string
  entryCount?: number
  text?: string
  createdAt?: number
}

/**
 * One-time import of the legacy Orama archive (`transcripts.msp`). Runs inside BEGIN IMMEDIATE so
 * two processes booting at once cannot both migrate. Embeddings are not carried over (Orama does
 * not return stored vectors); `transcript-reembed` restores them. The `.msp` file is left in place.
 */
async function migrateFromOrama(db: DatabaseSync): Promise<void> {
  const isDone = () => db.prepare('SELECT value FROM meta WHERE key = \'migrated_from_orama\'').get() !== undefined
  if (isDone()) { return }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (isDone()) {
      db.exec('COMMIT')
      return
    }
    const legacyPath = MeetClient.legacyTranscriptDbPath
    let marker = 'none'
    if (existsSync(legacyPath)) {
      const { search } = await import('@orama/orama')
      const { restoreFromFile } = await import('@orama/plugin-data-persistence/server')
      const orama = await restoreFromFile('binary', legacyPath)
      const { hits } = await search(orama, { limit: 100000 })
      const stmt = db.prepare(INSERT_IGNORE_SQL)
      let migrated = 0
      for (const hit of hits) {
        const d = hit.document as OramaDoc
        if (!d.id) { continue }
        const startTime = d.startTime ?? 0
        const endTime = d.endTime ?? startTime
        const record: TranscriptRecord = {
          id: d.id,
          transcriptName: d.transcriptName ?? '',
          conferenceRecordName: d.conferenceRecordName ?? '',
          organizerEmail: d.organizerEmail ?? '',
          subject: d.subject ?? '',
          description: d.description ?? '',
          attendees: d.attendees ?? [],
          meetingCode: d.meetingCode ?? '',
          calendarEventId: d.calendarEventId ?? '',
          spaceId: d.spaceId ?? '',
          startTime,
          endTime,
          startTimeIso: d.startTimeIso ?? new Date(startTime).toISOString(),
          endTimeIso: d.endTimeIso ?? new Date(endTime).toISOString(),
          filePath: d.filePath ?? '',
          entryCount: d.entryCount ?? 0,
          text: d.text ?? '',
          embedding: [],
          hasEmbedding: false,
          createdAt: d.createdAt ?? Date.now()
        }
        migrated += Number(stmt.run(...recordParams(record)).changes)
      }
      marker = new Date().toISOString()
      process.stderr.write(`[silkweave-meet] migrated ${migrated} transcripts from transcripts.msp; run transcript-reembed to restore embeddings\n`)
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (\'migrated_from_orama\', ?)').run(marker)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    // Leave the marker unset so the next start retries; the SQLite archive stays usable meanwhile.
    process.stderr.write(`[silkweave-meet] migration from transcripts.msp failed (${(err as Error).message}); will retry on next start\n`)
  }
}

export const transcriptDb = new TranscriptDbImpl()
