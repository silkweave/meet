# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build:** `pnpm build` (tsdown, outputs to `build/`)
- **Check (lint + typecheck):** `pnpm check`
- **Lint only:** `pnpm lint`
- **Typecheck only:** `pnpm typecheck`
- **Clean:** `pnpm clean`
- **Run MCP server (dev):** `pnpm tsx src/mcp.ts`
- **Run CLI (dev):** `pnpm tsx src/cli.ts` (or `pnpm cli <actionName>`)

## Architecture

`@silkweave/meet` is a Google Meet API client exposed as both an **MCP server** (`meet-mcp` / `src/mcp.ts`) and a **CLI** (`meet-cli` / `src/cli.ts`). Auth is **exclusively** a Workspace service account with domain-wide delegation: no OAuth, no token registry, no interactive flow. The package is built on [silkweave](https://www.npmjs.com/package/silkweave): every tool is a `createAction()` (zod schema + `run`).

The **MCP surface is deliberately narrow**:
- Live Google lookups: `meetTranscriptList`, `meetTranscriptGet`.
- Persisted archive (local Orama DB): `transcriptList`, `transcriptGet`, `transcriptSearch`, `transcriptBackfill`.
- Status: `mcpStatus`.

Everything that configures subscriptions, controls the background watcher, or manages multi-user setup is **CLI-only**. The CLI exposes the full action surface.

### Entry Points

- `src/index.ts` — library exports (`MeetClient`, scopes)
- `src/mcp.ts` — MCP server (stdio). Mounts the minimal `mcpActions` set from `src/actions/index.ts`. Auto-resumes the transcript watcher on boot when `watcher.autoStart` is set.
- `src/cli.ts` — CLI. Mounts the full `actions` set from `src/actions/index.ts` plus CLI-only helpers appended directly in `cli.ts` (currently `Setup/SetupStatus`, `Setup/SetupSubscribeAll` — they orchestrate the whole config rather than a single user).

### Core — `src/classes/MeetClient.ts`

All-static. No OAuth. On-disk artefacts in `~/.silkweave-meet/`:

- `service-account.json` — DWD-enabled service account key (exported as `MeetClient.keyPath` / `SERVICE_ACCOUNT_KEY_PATH`).
- `config.json` — `{ users: string[], cursors?: Record<email, rfc3339>, watcher?: WatcherConfig, openai?: OpenAIConfig }`.
- `transcripts.msp` — persisted Orama DB (binary). Managed by `src/lib/transcriptDb.ts`.
- `transcripts/<organizerEmail>/…` — default markdown archive (overridable via `watcher.transcriptDir`).

Interface:

- `MeetClient.withAuth(userEmail, fn)` — constructs a `JWT` with `keyFile`, `scopes`, and `subject: userEmail`, passes it to `fn`. Every Google API call goes through this. Fails fast if the key is missing or `userEmail` is empty.
- `listUsers() / addUsers(emails) / removeUser(email)` — manage `config.users`.
- `getEventCursor(email) / setEventCursor(email, cursor)` — per-user polling cursor.
- `getWatcherConfig() / setWatcherConfig(patch)` — shared watcher config.
- `getTranscriptDir()` — resolved transcript directory (watcher config or default).
- `getOpenAIConfig() / setOpenAIConfig(patch)` — optional OpenAI config for embeddings. `OPENAI_API_KEY` / `OPENAI_EMBEDDING_MODEL` env vars act as fallbacks.
- `transcriptDbPath` / `defaultTranscriptDir` / `configDir` — path accessors.

### Actions (`src/actions/`)

Every action is `createAction({ input: z.object(...), run: async ({ input }) => ... })`. Every user-scoped action takes a **required** `userEmail: z.string()` — no default, no fallback. Groups:

- `Calendar/` — upcoming meetings (`CalendarEventList`, `CalendarEventGet`).
- `Meet/` — past conferences, participants, recordings, transcripts, spaces. **Live API calls** — these hit Google, not the local archive.
- `Event/` — transcript notifications:
  - `EventPullTranscripts` — polling with cursor persisted in `config.cursors[email]`; idempotent. Does NOT write to the local archive — it's a stateless read. Use `transcriptBackfill` for persistence.
  - `EventSubscriptionCreate` / `EventSubscriptionCreateForUser` — Workspace Events subscriptions publishing to a Pub/Sub topic.
  - `EventSubscriptionList` / `EventSubscriptionDelete` — manage them.
- `Transcript/` — two distinct groups:
  - **Archive (MCP + CLI)**: `TranscriptList`, `TranscriptGet`, `TranscriptSearch` read from the local Orama DB. `TranscriptBackfill` ingests historical transcripts for every configured user (default: last 30 days).
  - **Watcher (CLI-only)**: `TranscriptWatchStart|Stop|Status` control the background Pub/Sub consumer.
- `Mcp/` — `McpStatus`: the single MCP-exposed health/status tool (also available in the CLI).
- `Setup/` — **CLI-only** helpers (`SetupStatus`, `SetupSubscribeAll`) that iterate every user in the config. Registered directly in `src/cli.ts`, not `src/actions/index.ts`, so they don't ship over MCP.

`src/actions/index.ts` exports two arrays: `actions` (the full set — used by the CLI) and `mcpActions` (the narrow MCP set: `McpStatus`, the live `MeetTranscript*`, and the archive `Transcript{Backfill,Get,List,Search}`). When adding a new action:

- If it belongs on MCP (read-only transcript access, archive search, backfill, or status), add it to both `actions` and `mcpActions`.
- If it is setup/configuration/management, add it to `actions` only so the CLI picks it up.
- If it is a one-off CLI orchestration (like the Setup helpers), skip the index entirely and append it directly in `src/cli.ts`.

### Transcript archive & ingest — `src/lib/transcriptDb.ts` + `transcriptIngest.ts` + `transcriptEnrich.ts`

- **`transcriptDb`** — singleton wrapper around an Orama DB persisted as `~/.silkweave-meet/transcripts.msp` (binary). Schema keeps `startTime`/`endTime` as epoch ms for range filters, plus subject/description/attendees/markdown text for full-text, and a `vector[1536]` embedding field for optional vector/hybrid search. Every mutation (`upsert`, `remove`, `updateEmbedding`) persists to disk — single-writer assumption (MCP server + CLI should not both mutate simultaneously).
- **`transcriptEnrich.enrichFromCalendar({ auth, meetingCode, conferenceStart, conferenceEnd })`** — deterministic Calendar match. Queries the user's primary calendar within ±1 day of the conference window and filters locally by `conferenceData.conferenceId === meetingCode`. No time-based guessing; no match = no enrichment (file is still saved, DB record is still inserted with empty subject/attendees).
- **`transcriptIngest.ingestTranscript({ userEmail, transcriptName, options })`** — the single code path used by both the watcher and `transcriptBackfill`. Dedupes via `transcriptDb.has(transcriptId)`, fetches entries + participants + conference + space, enriches via Calendar, writes the markdown file under `<transcriptDir>/<organizerEmail>/…`, computes an OpenAI embedding if configured (else inserts a zero vector with `hasEmbedding=false`), and upserts the record.

### Transcript Watcher — `src/lib/transcriptWatcher.ts`

Singleton long-running consumer. For each configured Pub/Sub subscription it opens a **StreamingPull** via `@google-cloud/pubsub` using the service-account key (required). On each message it reads `ce-source` to identify the originating Workspace Events subscription, looks up the owning user email in a `subscriptionId → email` cache (built at startup by impersonating each user in `config.users` and listing their subscriptions; rebuilt lazily on cache miss), then delegates to `ingestTranscript(...)` which impersonates that user via DWD for the fetch. In-memory `processed` Set deduplicates within a run; the shared DB dedupes across runs. Since subscriptions fire on the organizer, each meeting produces exactly one ingested record under the organizer's email.

### Scopes — `src/lib/scopes.ts`

The single DWD scope list applied by `MeetClient.withAuth`. Adding a new Google API surface that needs a new scope = add it here, and add the same scope under Domain-wide delegation in the Workspace Admin Console.

## Tooling

> Make sure to use the `roam` MCP server when exploring the codebase.

- One `roam` command replaces 5-10 grep/read cycles. Always try roam first.
- Use `roam search` instead of grep/glob for finding symbols - it understands
  definitions vs. usage and ranks by importance.
- `roam context` gives exact line ranges - more precise than reading whole files.
- After `git pull`, run `roam index` to keep the graph fresh.
- For disambiguation, use `file:symbol` syntax: `roam symbol myfile:MyClass`.

### Code Quality Metrics

**Do NOT use `roam health` as a quality metric** for this project. It penalizes
architectural patterns that are correct for a multi-package library toolkit
(adapter hubs → bottlenecks, disconnected packages → low connectivity,
public API exports → "dead" symbols).

Use these instead:
- `roam fitness` - metric thresholds + trend guards in `.roam/fitness.yaml` (CI-friendly, exit 1 on failure)
- `roam rules --ci` - custom architecture rules in `.roam/rules/` (layer violations, adapter isolation)
- `roam check-rules --profile minimal` - built-in structural rules with false-positive-prone checks excluded
- `roam complexity --threshold 15` - function-level cognitive complexity
- `roam vibe-check` - AI rot score (target: < 10)
- `roam ai-readiness` - agent-friendliness score
- `roam trends --save` - save a snapshot after each release for trend guards

### Roam in Sub-Agents

All `mcp__roam-code__*` tools are available inside sub-agents (both `general-purpose` and `Explore` types). When spawning a sub-agent for codebase exploration, include these instructions in the prompt:

> Use `mcp__roam-code__*` MCP tools for codebase exploration. Prefer roam over
> grep/glob/read - it understands symbols, call graphs, and architecture.
> Key tools: `roam_understand` (overview), `roam_context` (files for a symbol),
> `roam_search_symbol` (find by name), `roam_trace` (dependency paths),
> `roam_file_info` (file structure), `roam_impact` (blast radius).
> Use ToolSearch to find the full tool schemas before calling them.

## Code Style

- No semicolons
- Single quotes
- 2-space indent
- No trailing commas
- 1TBS brace style (single-line blocks allowed, e.g. `if (x) { return }`)
- Arrow parens always required
- `@typescript-eslint/no-explicit-any` is enforced (error)

## Testing via MCP

This project is configured as an MCP server in `.mcp.json` (`pnpm tsx src/mcp.ts`). Claude Code can call the MCP-exposed tools directly — `mcp__meet__mcpStatus`, `mcp__meet__meetTranscriptList`, `mcp__meet__meetTranscriptGet`, `mcp__meet__transcriptList`, `mcp__meet__transcriptGet`, `mcp__meet__transcriptSearch`, `mcp__meet__transcriptBackfill` — to verify changes. For everything else (subscriptions, watcher, setup), run the action via the CLI: `pnpm tsx src/cli.ts <actionName> …`.

**Restarting after code changes:** The MCP server runs as a child process of Claude Code. There is no longer an `mcpRestart` tool — ask the user to restart the MCP connection (or kill the process) so code changes are picked up.

**Caveat — new tools:** Claude Code caches the tool list at connection time, so *any* change to the MCP action set requires a full reconnect.

## Publishing

This is an unscoped public package (`@silkweave/meet`). Publish with:

```sh
pnpm publish --no-git-checks
```

## Wrapup Config

- check: `pnpm check`
- test: skip (no test suite)
- push: no (manual — confirm before pushing)
- version_bump: no (manual — confirm before bumping)
- publish: manual (`pnpm publish --no-git-checks` after version bump)
- docs: single CLAUDE.md + README.md
- frontend_smoke: n/a

## Wrap-Up Checklist

1. **Clean up** debug code, unused imports, stale comments in changed files.
2. **Validate** with `pnpm check`.
3. **Update README.md** when the public action surface or setup flow changes.
4. **Update CLAUDE.md** when architecture, commands, or conventions change.
5. **Commit** with a descriptive message (what + why).
6. **Release (manual):** bump `package.json` version, commit as `chore: bump version to X.Y.Z`, then `pnpm publish --no-git-checks`.
