# Plan: replace the Orama archive with SQLite

Status: approved, not started. Work on a branch (`feat/sqlite-store`), release as **2.2.0**.

## Why

The archive (`~/.silkweave-meet/transcripts.msp`, Orama, ~27 MB on the mini, ~330 records) is
loaded into memory once per process and **rewritten whole on every mutation**
(`transcriptDb.save()` → `persistToFile`). Consequences seen in production on 8 Oct 2026:

- **Lost writes across processes.** Every Claude session with the meet MCP auto-starts the watcher
  (`watcher.autoStart: true`); two sessions plus the nightly backfill each hold a stale in-memory
  copy and overwrite each other's inserts. We had to manually stop sessions before running
  `transcript-backfill` / `transcript-enrich`.
- Full 27 MB rewrite per single-record upsert; each MCP process holds its own in-memory copy.
- Stored vectors are not readable back (`getByID` / search hits return `embedding: null`), which is
  why `TranscriptEnrich` has to re-embed instead of carrying vectors over.

## Decision

- **`node:sqlite`** (`DatabaseSync`, built into Node ≥ 22.13; mini runs 24.16, dev 24.15). No native
  dependency, no `allowBuilds` entry. Verified: bundled SQLite 3.51.3 has FTS5.
- **WAL mode** + `busy_timeout` → many readers + serialized writers across processes; per-row upserts.
- **FTS5** for keyword search; **embeddings as Float32 BLOBs** with cosine similarity in JS
  (brute force is milliseconds at this scale; `sqlite-vec` only if we pass ~50k rows).
- Markdown files under `transcriptDir` stay unchanged.
- Add `"engines": { "node": ">=22.13" }` to `package.json`.

## Scope: `src/lib/transcriptDb.ts` only (keep the public interface)

Consumers (must keep working unchanged, except the backfill tweak below):
`src/mcp.ts` (`init`), `TranscriptList` (`list`), `TranscriptGet` (`get`), `TranscriptSearch`
(`search`), `TranscriptReembed` (`listForReembed`, `updateEmbeddings`), `TranscriptEnrich` (`get`,
`all`, `upsert`), `TranscriptBackfill` (`has`, `upsert({ skipSave })`, `save`), `transcriptIngest`
(`has`, `upsert`), `embeddings.ts` (`EMBEDDING_DIM`). `count()` currently has no callers.

Keep exports: `EMBEDDING_DIM`, `TranscriptRecord`, `TranscriptRecordPublic`, `TranscriptListOptions`,
`TranscriptSearchOptions`, `TranscriptHit`, `transcriptDb`.

### Paths (`src/classes/MeetClient.ts`)

- New `transcripts.db` (+ `-wal`/`-shm`) in `~/.silkweave-meet/`. `transcriptDbPath` → the `.db` file.
- Add `legacyTranscriptDbPath` → `transcripts.msp` (migration source only).

### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- meta: schema_version = 1, migrated_from_orama = <iso time> | 'none'

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,                 -- transcriptId
  transcript_name TEXT NOT NULL,
  conference_record_name TEXT NOT NULL,
  organizer_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]', -- JSON array of emails
  meeting_code TEXT NOT NULL DEFAULT '',
  calendar_event_id TEXT NOT NULL DEFAULT '',
  space_id TEXT NOT NULL DEFAULT '',
  start_time INTEGER NOT NULL,          -- epoch ms
  end_time INTEGER NOT NULL,
  start_time_iso TEXT NOT NULL,
  end_time_iso TEXT NOT NULL,
  file_path TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,                       -- Float32Array bytes; NULL = no embedding
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_start ON transcripts(start_time DESC);
CREATE INDEX IF NOT EXISTS transcripts_organizer ON transcripts(organizer_email);

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  subject, description, text,
  content='transcripts', content_rowid='rowid', tokenize='porter unicode61'
);
-- + AFTER INSERT / AFTER DELETE / AFTER UPDATE triggers keeping transcripts_fts in sync
--   (standard external-content pattern: delete old row via 'delete' command, insert new).
```

`hasEmbedding` is derived: `embedding IS NOT NULL`. On write, a record with `hasEmbedding: false`
(or an all-zero vector) stores `NULL`.

### Method mapping

| Method | SQLite behaviour |
| --- | --- |
| `init()` | Open DB once per process (lazy, idempotent), set pragmas, create schema, run Orama migration if needed. |
| `has(id)` / `get(id)` | `SELECT … WHERE id = ?`; `get` decodes `embedding` BLOB → `number[]` (vectors are now readable). |
| `upsert(record, opts?)` | `INSERT … ON CONFLICT(id) DO UPDATE`. `opts.skipSave` accepted and ignored (keep the signature). |
| `save()` | No-op (kept for compatibility); remove its call in `TranscriptBackfill` and the `skipSave` arg. Wrap backfill's inserts in one transaction (`BEGIN IMMEDIATE … COMMIT`). |
| `remove(id)` | `DELETE`. |
| `all()` | All rows (decoded), for `TranscriptEnrich`. Consider a lighter `listUnmatched()` (`WHERE calendar_event_id = ''`) and switch `TranscriptEnrich` to it. |
| `listForReembed(onlyMissing)` | `SELECT id, text, embedding IS NOT NULL … [WHERE embedding IS NULL]`. |
| `updateEmbedding(s)` | `UPDATE transcripts SET embedding = ? WHERE id = ?` in one transaction. |
| `count()` | `SELECT count(*)`. |
| `list(opts)` / `search(opts)` | See below. |

### Filters (shared by list/search)

`organizerEmail` → `organizer_email = ?`; `attendee` →
`EXISTS (SELECT 1 FROM json_each(attendees) WHERE value = ?)`; `startTimeFrom/To` → `start_time >= / <= ?`.

### Search semantics (match current behaviour where it is visible)

- **No query:** filtered rows, `ORDER BY start_time DESC`, `LIMIT/OFFSET`, `total` = filtered `count(*)`, `score` 0.
- **fulltext:** `transcripts_fts MATCH ?` joined to `transcripts`. Build the MATCH expression by
  tokenising the user query on whitespace and quoting each token (`"tok"`, double any `"`) so user
  input can never produce an FTS syntax error; tokens are AND-ed. Rank with
  `bm25(transcripts_fts, 3.0, 2.0, 1.0)` (subject/description/text boosts, same as Orama's 3/2/1).
  **Today's results are ordered by `startTime DESC`, not relevance**; keep that ordering for
  `fulltext` (and report `score = -bm25`) to avoid a behaviour change. Snippet: keep `makeSnippet`.
- **vector:** load `id, embedding` for filtered rows with an embedding, cosine vs `queryEmbedding`,
  keep `>= similarity` (default **0.8**, as today), sort by score desc, paginate; then fetch the page's
  records.
- **hybrid:** text score = bm25 normalised to 0..1 over the matched set; vector score = cosine;
  `score = 0.5 * text + 0.5 * vector` over the union of FTS matches and vector hits above
  `similarity`; sort desc; paginate.
- Return shape unchanged: `{ total, results: TranscriptHit[] }` with `record` excluding `embedding`/`text`.

### Migration from Orama (one-time, automatic)

In `init()`, inside `BEGIN IMMEDIATE` (so two processes booting at once can't both migrate):
if `meta.migrated_from_orama` is unset and `transcripts.msp` exists → dynamically `import()`
`@orama/orama` + `@orama/plugin-data-persistence/server`, `restoreFromFile('binary', …)`,
`search(db, { limit: 100000 })`, `INSERT OR IGNORE` every document with `embedding = NULL`
(Orama does not give vectors back), set `meta.migrated_from_orama`. Leave `transcripts.msp` in place
(rollback path). Log to stderr: `migrated N transcripts from transcripts.msp; run transcript-reembed
to restore embeddings`. If no `.msp` exists, set `migrated_from_orama = 'none'`.

Keep `@orama/*` as dependencies for this release (migration only); drop them in a later major.

## Docs

- `CLAUDE.md`: replace the "Transcript archive" Orama description (file name, single-writer
  assumption → WAL multi-process, vectors readable, FTS5), the `transcripts.msp` artefact line, and
  note the auto-migration.
- `README.md`: archive section (storage file, search modes unchanged), upgrade note
  ("2.2.0 migrates the archive to SQLite on first start; run `meet-cli transcript-reembed` once").

## Verification

1. `pnpm check`.
2. Local: copy the mini's `~/.silkweave-meet` into a sandbox `HOME` (set `watcher.autoStart: false`
   and point `transcriptDir` at a temp dir), run the packed build (`pnpm pack`, `npx -p <tgz>`):
   - `mcp-status`, `transcript-list --limit 5`, `transcript-get <id>` (Vinish
     `4e70ca93-5acf-4fcb-84da-8e052f6c67a0` must keep its enriched subject), `transcript-search
     --query vinish`, then `transcript-reembed` and `transcript-search --mode vector|hybrid`.
   - Record count after migration == Orama count (329 on 8 Oct + any new ones).
3. Concurrency: two processes upserting different records at once (e.g. `transcript-backfill` while
   an MCP server is running), then verify both rows exist. This is the bug being fixed.
4. Edge: FTS query with quotes/parentheses/`-`/`*` must not throw.

## Rollout (mini)

Release 2.2.0 → on the mini: stop meet-using Claude sessions, back up `~/.silkweave-meet`, run
`meet-cli mcp-status` once (triggers migration), `meet-cli transcript-reembed`, spot-check search,
then allow sessions again. After this, sessions no longer need to be stopped for backfill/enrich.

## Out of scope / follow-ups

- `config.json` writes (cursors, watcher config) are also read-modify-write across processes;
  low frequency, leave for now.
- Several sessions each running a watcher on the same Pub/Sub subscription is now *safe* (idempotent
  upserts) but wasteful; consider a single dedicated watcher (Box automation) with
  `autoStart: false` for interactive sessions.
- Nightly backfill on the mini (`~/toby/campaigns/scripts/run_meet_backfill.sh`, launchd
  `bi.atomic.meet.backfill`) still uses `claude -p`; move to a Box automation calling
  `meet-cli transcript-backfill` and posting to chat.
