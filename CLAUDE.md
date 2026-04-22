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

`@silkweave/meet` is a Google Meet API client exposed as both an **MCP server** (`meet-mcp` / `src/mcp.ts`) and a **CLI** (`meet-cli` / `src/cli.ts`). Both entry points share the same action set and a single token store. The package is built on [silkweave](https://www.npmjs.com/package/silkweave): every tool is a `createAction()` (zod schema + `run`) registered via `src/actions/index.ts`, then mounted onto either the stdio MCP adapter or the CLI adapter.

### Entry Points

- `src/index.ts` — library exports (`MeetClient`, scopes)
- `src/mcp.ts` — MCP server (stdio). Auto-resumes the transcript watcher on boot when `watcher.autoStart` is set.
- `src/cli.ts` — CLI, same action set

### Core Classes — `src/classes/MeetClient.ts`

`MeetClient` is the only stateful class. It owns the token registry persisted to `~/.silkweave-meet.json`:

```ts
{ clientId, clientSecret, redirectUri,
  entries: { [userId]: TokenEntry },   // per-user OAuth tokens + eventCursor
  watcher?: WatcherConfig }            // single shared watcher config
```

- `withAuth(fn)` — refreshes the access token if near expiry, then calls `fn(OAuth2Client)`. All Google API calls go through this. Actions that need auth always read `userId` from input (default `'default'`) and construct a fresh `MeetClient(userId)`.
- `setEventCursor` / `eventCursor` — per-user cursor for `eventPullTranscripts` (polling).
- `setWatcherConfig` / `getWatcherConfig` — shared watcher config (pub/sub subs, transcript dir, post-save shell command, `autoStart`).
- `REFRESH_TOKEN_TTL_MS` is tracked manually because Google doesn't return a refresh-token expiry; if a new refresh token is issued during refresh, the TTL is reset.

### Actions (`src/actions/`)

Every action is `createAction({ input: z.object(...), run: async ({ input }) => ... })`. Groups:

- `Google/` — OAuth bootstrap (`GoogleAuthorize`, `GoogleGetToken`, `GoogleGetUser`).
- `Calendar/` — upcoming meetings (`CalendarEventList`, `CalendarEventGet`).
- `Meet/` — past conferences, participants, recordings, transcripts, spaces.
- `Event/` — **transcript notifications**:
  - `EventPullTranscripts` — MCP-native polling with a persisted cursor; idempotent.
  - `EventSubscriptionCreate` / `EventSubscriptionCreateForUser` — Workspace Events subscriptions (space-level or user-level) publishing to a user-owned Pub/Sub topic.
  - `EventSubscriptionList` / `EventSubscriptionDelete` — manage them.
- `Transcript/` — `TranscriptWatchStart|Stop|Status`: control the background Pub/Sub watcher.
- `Mcp/` — `McpHealth`, `McpRestart`.

Register every new action in `src/actions/index.ts` (imports alphabetical, `actions` array alphabetical).

### Transcript Watcher — `src/lib/transcriptWatcher.ts`

Singleton long-running consumer. Per configured Pub/Sub subscription, it pulls, decodes Workspace Events payloads, fetches the transcript via the Meet API, renders Markdown via `src/lib/transcripts.ts`, writes `YYYY-MM-DD_{meetCodeOrConferenceId}_{transcriptId}.md` to `transcriptDir`, and optionally runs `onTranscriptCommand` with `$TRANSCRIPT_PATH`, `$TRANSCRIPT_RAW`, `$MEET_CODE`, etc. in env. In-memory `processed` Set deduplicates within a run; across restarts, the cursor+ack machinery keeps things safe.

### Scopes — `src/lib/scopes.ts`

Single source of truth for the scope list requested by `GoogleAuthorize`. Adding a new Google API surface that needs a new scope = add it here and re-authorize.

## Code Style

- No semicolons
- Single quotes
- 2-space indent
- No trailing commas
- 1TBS brace style (single-line blocks allowed, e.g. `if (x) { return }`)
- Arrow parens always required
- `@typescript-eslint/no-explicit-any` is enforced (error)

## Testing via MCP

This project is configured as an MCP server in `.mcp.json` (`pnpm tsx src/mcp.ts`). Claude Code can call the Meet MCP tools directly to test changes — use the `mcp__meet__*` tools to verify actions work correctly after editing.

**Restarting after code changes:** The MCP server runs as a child process of Claude Code. After making code changes, call the `mcp__meet__McpRestart` tool. This exits the process cleanly; Claude Code auto-restarts it on the next tool call, picking up changes to existing actions.

**Caveat — new tools:** Claude Code caches the tool list at connection time. Changes to existing actions are picked up after restart, but *newly added* actions won't appear until the MCP connection is fully re-established (ask the user to reconnect).

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
