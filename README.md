# @silkweave/meet

Google Meet API client exposed as both an **MCP server** and a **CLI**. Built with [silkweave](https://www.npmjs.com/package/silkweave).

Authentication is **exclusively** through a Google Workspace service account with domain-wide delegation (DWD). There is no OAuth flow, no per-user token registry, no interactive login. One service-account JSON on disk and a list of Workspace user emails in a config file is the entire setup.

## Features

- List upcoming meetings from Google Calendar and past Google Meet conference records
- Retrieve conference details, participants, recordings, and transcripts (impersonating any Workspace user via DWD)
- Render transcripts as clean Markdown (consecutive utterances per speaker merged)
- Two ways to consume new-transcript notifications:
  - `eventPullTranscripts` — on-demand polling with a persisted cursor (idempotent)
  - Built-in background watcher (`transcriptWatch*`) — streams from Pub/Sub and writes Markdown files, with optional per-save shell command

## Quick Start

### 1. Provision a service account with DWD

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create or pick a project.
2. Enable the **Google Calendar API**, **Google Meet API**, **Google Workspace Events API**, and **Cloud Pub/Sub API**.
3. Create a service account; download its JSON key.

In your [Google Workspace Admin Console](https://admin.google.com/):

4. *Security → Access and data control → API controls → Domain-wide delegation → Add new*.
5. Paste the service account's **Client ID** (the numeric one in the JSON key, field `client_id`).
6. Grant these OAuth scopes:
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/meetings.space.readonly`
   - `https://www.googleapis.com/auth/meetings.space.created`

### 2. Install the key locally

```sh
mkdir -p ~/.silkweave-meet
cp /path/to/sa-key.json ~/.silkweave-meet/service-account.json
chmod 600 ~/.silkweave-meet/service-account.json
```

That's all the auth configuration. No env vars, no OAuth flow.

### 3. Register the MCP server (optional, for Claude Code)

```json
{
  "mcpServers": {
    "meet": {
      "command": "npx",
      "args": ["-y", "-p", "@silkweave/meet", "meet-mcp"]
    }
  }
}
```

The package ships two bins: `meet-mcp` (stdio MCP server) and `meet-cli` (same action set as direct commands).

### 4. Try a call

```sh
npx -p @silkweave/meet meet-cli calendar-event-list --user-email=you@your-workspace.com
```

## Configuration file

Everything non-secret lives in `~/.silkweave-meet/config.json`:

```json
{
  "users": ["alice@company.com", "bob@company.com"],
  "watcher": {
    "pubsubSubscriptions": ["projects/my-project/subscriptions/meet-transcripts-sub"],
    "transcriptDir": "/Users/alice/meet-transcripts",
    "onTranscriptCommand": "osascript -e 'display notification ...'",
    "autoStart": true
  },
  "cursors": {
    "alice@company.com": "2026-04-22T14:30:00Z"
  }
}
```

- `users` — Workspace user emails the tool is allowed to impersonate. Populated by `setupSubscribeAll --users=a,b,c` or edited manually.
- `watcher` — persisted watcher config, written by `transcriptWatchStart`.
- `cursors` — per-user polling cursors for `eventPullTranscripts`.

## Tools Reference

Every action that reads Google data takes a required `userEmail` — the Workspace user the service account impersonates for that call. Permissions match exactly what that user can see.

The **MCP surface is intentionally small**: only `meetTranscriptList`, `meetTranscriptGet`, and `mcpStatus` are exposed over MCP. All other tools listed below are **CLI-only** (via `meet-cli`). This keeps MCP focused on consuming already-existing transcripts; subscription management, the background watcher, and multi-user setup all live in the CLI.

### Upcoming meetings — `Calendar*` (CLI-only)

| Tool | Purpose |
| --- | --- |
| `calendarEventList` | List Calendar events on the user's primary calendar (optionally filtered to Meet-enabled ones). |
| `calendarEventGet` | Get one event with Meet join info. |

### Past meetings & transcripts — `Meet*`

`meetTranscriptList` and `meetTranscriptGet` are available on **both MCP and CLI**. The rest are CLI-only.

| Tool | Surface | Purpose |
| --- | --- | --- |
| `meetTranscriptList` | MCP + CLI | List transcripts for a conference. |
| `meetTranscriptGet` | MCP + CLI | Fetch a full transcript; returns Markdown by default, `format=json` for raw entries. |
| `meetConferenceList` | CLI | List past `conferenceRecords` the user participated in (optional EBNF filter). |
| `meetConferenceGet` | CLI | Fetch a single conference record. |
| `meetParticipantList` | CLI | List participants of a conference. |
| `meetRecordingList` | CLI | List recording artifacts (Drive links). |
| `meetSpaceGet` | CLI | Resolve a space by `spaces/{id}` or meeting code. |

### Notifications — `Event*` (CLI-only)

| Tool | Purpose |
| --- | --- |
| `eventPullTranscripts` | Polling. Returns transcripts generated since the user's stored cursor, advances it. No Pub/Sub needed. |
| `eventSubscriptionCreate` | Create a Workspace Events subscription for a specific Meet space (requires `meet-api-event-push@system.gserviceaccount.com` to have Pub/Sub Publisher on the topic). |
| `eventSubscriptionCreateForUser` | Create a user-level Workspace Events subscription for the impersonated user. Covers meetings they own *or* attend. |
| `eventSubscriptionList` | List existing subscriptions owned by the impersonated user. |
| `eventSubscriptionDelete` | Delete a subscription. |

### Background watcher — `TranscriptWatch*` (CLI-only)

Singleton consumer that streams events from a Pub/Sub subscription (Pub/Sub auth from the same service-account key), and for each message impersonates (via DWD) the user whose Workspace Events subscription produced it — identified by the message's `ce-source` attribute — to fetch the transcript via the Meet API. One watcher covers every user listed in the config.

| Tool | Purpose |
| --- | --- |
| `transcriptWatchStart` | Start the watcher (and persist config). Pass `pubsubSubscriptions`, `transcriptDir`, `onTranscriptCommand`, `autoStart`. |
| `transcriptWatchStop` | Stop the watcher. Pass `disableAutoStart=true` to also disable boot-time auto-start. |
| `transcriptWatchStatus` | Current status: running flag, per-subscription counters, known subscription owners, recent saved files. |

When `autoStart: true` is persisted, the MCP server resumes the watcher on every boot. Each saved file is named `YYYY-MM-DD_{meetCodeOrConferenceId}_{transcriptId}.md` so files sort chronologically.

### Multi-user setup — `Setup*` (CLI-only)

| Tool | Purpose |
| --- | --- |
| `setupStatus` | Report, for each user in the config, whether DWD impersonation succeeds and which Workspace Events subscriptions they own. With `--pubsub-topic`, flag which users are subscribed to it. |
| `setupSubscribeAll` | Create a user-level subscription for every user in the config. Optional `--users=a,b,c` also appends those emails to the config. Idempotent — re-running skips users already subscribed. |

These are registered only in `src/cli.ts` (not the MCP action list), because they orchestrate the whole config rather than a single user.

### Operational — `Mcp*`

| Tool | Surface | Purpose |
| --- | --- | --- |
| `mcpStatus` | MCP + CLI | Lightweight status: version/uptime/pid, service-account key presence, watcher running state, configured users with per-user subscription coverage, and the 10 most recent saved transcripts. |

## Multi-user setup walkthrough

```sh
# 1. Create the shared Pub/Sub topic and let Meet publish to it.
gcloud pubsub topics create meet-transcripts
gcloud pubsub topics add-iam-policy-binding meet-transcripts \
  --member=serviceAccount:meet-api-event-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher

# 2. Register the users and create one user-level subscription per person
#    (idempotent). The --users flag appends to ~/.silkweave-meet/config.json.
npx -p @silkweave/meet meet-cli setup-subscribe-all \
  --pubsub-topic=projects/<project>/topics/meet-transcripts \
  --users=alice@company.com,bob@company.com,carol@company.com,dave@company.com

# 3. Confirm every user is subscribed.
npx -p @silkweave/meet meet-cli setup-status \
  --pubsub-topic=projects/<project>/topics/meet-transcripts

# 4. Create the pull subscription the watcher will stream from, and grant the
#    service account Subscriber on it.
gcloud pubsub subscriptions create meet-transcripts-sub --topic=meet-transcripts
SA_EMAIL=$(jq -r .client_email ~/.silkweave-meet/service-account.json)
gcloud pubsub subscriptions add-iam-policy-binding meet-transcripts-sub \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/pubsub.subscriber

# 5. Start the watcher. Routes each incoming event to the right user's
#    impersonation context based on the message's ce-source.
npx -p @silkweave/meet meet-cli transcript-watch-start \
  --pubsub-subscriptions=projects/<project>/subscriptions/meet-transcripts-sub \
  --transcript-dir=~/meet-transcripts \
  --auto-start=true
```

User-level subscriptions expire (Google's max TTL applies). Re-run `setup-subscribe-all` on a schedule (cron / launchd) to refresh any that have expired; existing valid ones are skipped.

User-level subscriptions capture `transcript.v2.fileGenerated` events for meetings the user **owns *or* is merely invited to** — that is the only non-owner event the Workspace Events API delivers, and it's exactly the one we want. Expect duplicates when multiple team members are in the same meeting; the watcher dedupes by `transcriptId` in memory per run.

## Shell command env vars

The `onTranscriptCommand` runs via `spawn(..., { shell: true })` with these environment variables exposed:

| Var | Meaning |
| --- | --- |
| `$TRANSCRIPT_PATH` | Absolute path to the saved Markdown file |
| `$TRANSCRIPT_RAW` | Full rendered Markdown as a string (subject to shell env size limits) |
| `$TRANSCRIPT_NAME` | `conferenceRecords/{c}/transcripts/{t}` resource name |
| `$CONFERENCE_RECORD` | `conferenceRecords/{c}` resource name |
| `$MEET_CODE` | Meeting code (e.g. `abc-mnop-xyz`), if resolvable |
| `$START_TIME` / `$END_TIME` | Transcript start/end (RFC3339) |
| `$ENTRY_COUNT` | Number of transcript entries |
| `$DATE` | `YYYY-MM-DD` prefix used in the filename |

For very long transcripts, prefer reading from `$TRANSCRIPT_PATH` — environment size is bounded (~256KB on macOS).

## Library usage

```bash
pnpm add @silkweave/meet
```

```ts
import { MeetClient } from '@silkweave/meet'
import { google } from 'googleapis'

const conferences = await MeetClient.withAuth('alice@company.com', async (auth) => {
  const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.list()
  return data.conferenceRecords ?? []
})
```

`MeetClient.withAuth` creates a DWD-impersonating JWT for that user using the key at `~/.silkweave-meet/service-account.json`.

## Development

```bash
pnpm install
pnpm tsx src/mcp.ts     # MCP server in dev
pnpm tsx src/cli.ts     # CLI in dev
pnpm build              # build to build/
pnpm lint               # eslint
pnpm typecheck          # tsc --noEmit
pnpm clean              # rm -rf build/
```

When iterating through the MCP in Claude Code, the server is a child process — after code changes, restart the MCP connection (or kill the process) so changes are picked up. Claude Code caches the tool list at connection time, so any change to the MCP action set also requires a full reconnect.

## License

MIT
