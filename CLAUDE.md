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

The **MCP surface is deliberately narrow** — only tools for reading already-existing transcripts (`meetTranscriptList`, `meetTranscriptGet`) plus the lightweight `mcpStatus` tool. Everything that configures, manages, or writes state (Calendar browsing, conference/participant/recording/space lookups, Event subscription management, transcript watcher controls, Setup helpers) is **CLI-only**. The CLI exposes the full action surface.

### Entry Points

- `src/index.ts` — library exports (`MeetClient`, scopes)
- `src/mcp.ts` — MCP server (stdio). Mounts the minimal `mcpActions` set from `src/actions/index.ts`. Auto-resumes the transcript watcher on boot when `watcher.autoStart` is set.
- `src/cli.ts` — CLI. Mounts the full `actions` set from `src/actions/index.ts` plus CLI-only helpers appended directly in `cli.ts` (currently `Setup/SetupStatus`, `Setup/SetupSubscribeAll` — they orchestrate the whole config rather than a single user).

### Core — `src/classes/MeetClient.ts`

All-static. No OAuth. Two on-disk artefacts:

- `~/.silkweave-meet/service-account.json` — DWD-enabled service account key (exported as `MeetClient.keyPath` / `SERVICE_ACCOUNT_KEY_PATH`).
- `~/.silkweave-meet/config.json` — `{ users: string[], cursors?: Record<email, rfc3339>, watcher?: WatcherConfig }`.

Interface:

- `MeetClient.withAuth(userEmail, fn)` — constructs a `JWT` with `keyFile`, `scopes`, and `subject: userEmail`, passes it to `fn`. Every Google API call goes through this. Fails fast if the key is missing or `userEmail` is empty.
- `listUsers() / addUsers(emails) / removeUser(email)` — manage `config.users`.
- `getEventCursor(email) / setEventCursor(email, cursor)` — per-user polling cursor.
- `getWatcherConfig() / setWatcherConfig(patch)` — shared watcher config.

### Actions (`src/actions/`)

Every action is `createAction({ input: z.object(...), run: async ({ input }) => ... })`. Every user-scoped action takes a **required** `userEmail: z.string()` — no default, no fallback. Groups:

- `Calendar/` — upcoming meetings (`CalendarEventList`, `CalendarEventGet`).
- `Meet/` — past conferences, participants, recordings, transcripts, spaces.
- `Event/` — transcript notifications:
  - `EventPullTranscripts` — polling with cursor persisted in `config.cursors[email]`; idempotent.
  - `EventSubscriptionCreate` / `EventSubscriptionCreateForUser` — Workspace Events subscriptions publishing to a Pub/Sub topic.
  - `EventSubscriptionList` / `EventSubscriptionDelete` — manage them.
- `Transcript/` — `TranscriptWatchStart|Stop|Status`: control the background Pub/Sub watcher (no `userEmail` — the watcher is a singleton routing per-event). CLI-only.
- `Mcp/` — `McpStatus`: the single MCP-exposed health/status tool (also available in the CLI).
- `Setup/` — **CLI-only** helpers (`SetupStatus`, `SetupSubscribeAll`) that iterate every user in the config. Registered directly in `src/cli.ts`, not `src/actions/index.ts`, so they don't ship over MCP.

`src/actions/index.ts` exports two arrays: `actions` (the full set — imports and array alphabetical — used by the CLI) and `mcpActions` (the minimal MCP set: `McpStatus`, `MeetTranscriptGet`, `MeetTranscriptList`). When adding a new action:

- If it belongs on MCP (read-only, transcript-facing, or status), add it to both `actions` and `mcpActions`.
- If it is setup/configuration/management, add it to `actions` only so the CLI picks it up.
- If it is a one-off CLI orchestration (like the Setup helpers), skip the index entirely and append it directly in `src/cli.ts`.

### Transcript Watcher — `src/lib/transcriptWatcher.ts`

Singleton long-running consumer. For each configured Pub/Sub subscription it opens a **StreamingPull** via `@google-cloud/pubsub` using the service-account key (required). On each message it reads `ce-source` to identify the originating Workspace Events subscription, looks up the owning user email in a `subscriptionId → email` cache (built at startup by impersonating each user in `config.users` and listing their subscriptions; rebuilt lazily on cache miss), then fetches the transcript by impersonating **that** user via DWD. Renders Markdown via `src/lib/transcripts.ts`, writes `YYYY-MM-DD_{meetCodeOrConferenceId}_{transcriptId}.md` to `transcriptDir`, and optionally runs `onTranscriptCommand` with `$TRANSCRIPT_PATH`, `$TRANSCRIPT_RAW`, `$MEET_CODE`, etc. in env. In-memory `processed` Set deduplicates within a run (important because N users in the same meeting produce N messages on the shared topic).

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

This project is configured as an MCP server in `.mcp.json` (`pnpm tsx src/mcp.ts`). Claude Code can call the three Meet MCP tools (`mcp__meet__mcpStatus`, `mcp__meet__meetTranscriptList`, `mcp__meet__meetTranscriptGet`) directly to verify changes. For everything else (subscriptions, watcher, setup), run the action via the CLI: `pnpm tsx src/cli.ts <actionName> …`.

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
