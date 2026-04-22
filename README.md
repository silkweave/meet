# @silkweave/meet

Google Meet API client exposed as both an **MCP server** and a **CLI**. Built with [silkweave](https://www.npmjs.com/package/silkweave).

## Features

- List upcoming meetings from Google Calendar and past Google Meet conference records
- Retrieve conference details, participants, recordings, and transcripts
- Render transcripts as clean Markdown (consecutive utterances per speaker merged)
- Three ways to consume new-transcript notifications:
  - `eventPullTranscripts` — MCP-native polling with a persisted cursor (idempotent)
  - Workspace Events subscriptions (`eventSubscription*`) — space-level or user-level → your Pub/Sub topic
  - Built-in background watcher (`transcriptWatch*`) — consumes Pub/Sub, writes Markdown files, runs a per-save shell command

## Quick Start

### 1. Add the MCP Server

No installation required -- `npx` downloads and runs the package automatically.

**Claude Code** -- add to `.mcp.json` in your project root:

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

**Other MCP clients** -- use the command `npx -y -p @silkweave/meet meet-mcp` with stdio transport.

The package ships two bins: `meet-mcp` (stdio MCP server) and `meet-cli` (same action set as direct commands).

### 2. Create Google OAuth2 Credentials

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create or pick a project.
2. Enable these APIs:
   - **Google Calendar API**
   - **Google Meet API**
   - **Google Workspace Events API** (only required if you plan to use `eventSubscription*`)
3. OAuth consent screen → add your email as a test user (while the app is in testing).
4. Credentials → *Create Credentials* → *OAuth client ID* → **Web application**.
5. Add `http://localhost:3000/callback` (or whatever `redirectUri` you'll pass) as an authorized redirect URI.
6. Download the Client ID and Client Secret.

### 3. Authenticate

Run the CLI (or call the MCP tool `googleAuthorize`):

```bash
npx -p @silkweave/meet meet-cli googleAuthorize --clientId=<id> --clientSecret=<secret>
```

Open the returned `authorizeUrl`, grant consent, and copy the `code` query parameter from the redirect. Then:

```bash
npx -p @silkweave/meet meet-cli googleGetToken <code>
npx -p @silkweave/meet meet-cli googleGetUser
```

Tokens are persisted to `~/.silkweave-meet.json`. Refresh is automatic; re-authenticate only if the refresh token is revoked.

## Required Scopes

Listed in `src/lib/scopes.ts`:

| Scope | Purpose |
| --- | --- |
| `openid` | Identity primitives |
| `userinfo.email`, `userinfo.profile` | `googleGetUser` identity |
| `calendar.events.readonly` | List upcoming meetings (`calendarEvent*`) |
| `meetings.space.readonly` | Read conference records, participants, transcripts; also authorises Meet subscriptions via Workspace Events API |
| `meetings.space.created` | Read transcripts/recordings for private spaces the user created; also required for space-level Workspace Events subscriptions |
| `pubsub` | Pull events from Pub/Sub for the background transcript watcher (`transcriptWatch*`) |

## Usage

### As a Library

```bash
pnpm add @silkweave/meet
```

```typescript
import { MeetClient } from '@silkweave/meet'
import { google } from 'googleapis'

const client = new MeetClient('default')
const conferences = await client.withAuth(async (auth) => {
  const { data } = await google.meet({ version: 'v2', auth }).conferenceRecords.list()
  return data.conferenceRecords ?? []
})
```

### As a CLI

```bash
npx -p @silkweave/meet meet-cli <actionName> [flags]
```

## Tools Reference

### Auth — `Google*`

| Tool | Purpose |
| --- | --- |
| `googleAuthorize` | Persist app credentials; return the consent URL for a given `userId`. |
| `googleGetToken` | Exchange an authorization `code` for access/refresh tokens and persist them. |
| `googleGetUser` | Return the authenticated user's identity (email, name, picture). |

### Upcoming meetings — `Calendar*`

| Tool | Purpose |
| --- | --- |
| `calendarEventList` | List Calendar events (optionally filtered to Meet-enabled ones). |
| `calendarEventGet` | Get one event with Meet join info. |

### Past meetings & transcripts — `Meet*`

| Tool | Purpose |
| --- | --- |
| `meetConferenceList` | List past `conferenceRecords` with optional EBNF filter. |
| `meetConferenceGet` | Fetch a single conference record. |
| `meetParticipantList` | List participants of a conference. |
| `meetRecordingList` | List recording artifacts (Drive links). |
| `meetTranscriptList` | List transcripts for a conference. |
| `meetTranscriptGet` | Fetch a full transcript; returns Markdown by default, `format=json` for raw entries. |
| `meetSpaceGet` | Resolve a space by `spaces/{id}` or meeting code. |

### Notifications — `Event*`

| Tool | Purpose |
| --- | --- |
| `eventPullTranscripts` | **Polling, MCP-native.** Returns transcripts generated since the stored cursor, then advances the cursor. Call on a schedule (e.g. Claude Code `/loop`). No Pub/Sub needed. |
| `eventSubscriptionCreate` | Create a Workspace Events subscription for a specific Meet space, publishing events to a user-owned Pub/Sub topic. Requires `meet-api-event-push@system.gserviceaccount.com` to have Pub/Sub Publisher on the topic. |
| `eventSubscriptionCreateForUser` | Create a Workspace Events subscription for all Meet events from a user (organizer or attendee), publishing to a Pub/Sub topic. Covers all meetings, not just a specific space. |
| `eventSubscriptionList` | List existing subscriptions. |
| `eventSubscriptionDelete` | Delete a subscription. |

### Background watcher — `TranscriptWatch*`

Long-running consumer that pulls events from one or more Pub/Sub subscriptions, saves each transcript as a Markdown file under a configurable directory, and optionally runs a shell command after each save.

| Tool | Purpose |
| --- | --- |
| `transcriptWatchStart` | Start the watcher (and persist config). Pass `pubsubSubscriptions`, `transcriptDir`, `onTranscriptCommand`, `autoStart`. |
| `transcriptWatchStop` | Stop the watcher. Pass `disableAutoStart=true` to also disable boot-time auto-start. |
| `transcriptWatchStatus` | Current status: running flag, per-subscription counters, last error, recent saved files. |

When `autoStart: true` is persisted, the MCP server resumes the watcher on every boot.

Each saved file is named `YYYY-MM-DD_{meetCodeOrConferenceId}_{transcriptId}.md` so files sort chronologically in the directory.

### Operational — `Mcp*`

| Tool | Purpose |
| --- | --- |
| `mcpHealth` | Report uptime/pid. |
| `mcpRestart` | Exit the process so the host auto-restarts it and picks up code changes. |

## Notifications for new transcripts

Three complementary paths:

1. **`eventPullTranscripts`** — on-demand polling. The MCP stdio process cannot receive HTTP webhooks, so polling-with-a-cursor is the right primitive for ad-hoc queries. Idempotent: repeat calls return no duplicates.
2. **`transcriptWatch*` (built-in watcher)** — recommended for always-on setups. Create a Workspace Events subscription that publishes to a Pub/Sub topic (see below), create a Pub/Sub subscription on that topic, then call `transcriptWatchStart` with the subscription name. The watcher pulls messages continuously while the MCP server is running, saves Markdown to your configured directory, and can trigger a shell command per save.
3. **`eventSubscriptionCreate` / `eventSubscriptionCreateForUser` → your own consumer** — when you want events consumed by an external system instead of the MCP watcher, create the Workspace Events subscription and consume from Pub/Sub yourself.

### End-to-end setup for the built-in watcher

```sh
# 1. Authorise (make sure pubsub scope is granted by re-running if upgrading).
npx -p @silkweave/meet meet-cli googleAuthorize --clientId=... --clientSecret=...
npx -p @silkweave/meet meet-cli googleGetToken <code>

# 2. Create a Pub/Sub topic in your GCP project and grant Meet permission to publish.
gcloud pubsub topics create meet-transcripts
gcloud pubsub topics add-iam-policy-binding meet-transcripts \
  --member=serviceAccount:meet-api-event-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher

# 3. Create a Workspace Events subscription -- user-level captures all meetings.
npx -p @silkweave/meet meet-cli eventSubscriptionCreateForUser \
  --userEmail=you@example.com \
  --pubsubTopic=projects/<project>/topics/meet-transcripts

# 4. Create a Pub/Sub subscription to consume from (pull).
gcloud pubsub subscriptions create meet-transcripts-sub \
  --topic=meet-transcripts

# 5. Start the watcher.
npx -p @silkweave/meet meet-cli transcriptWatchStart \
  --pubsubSubscriptions=projects/<project>/subscriptions/meet-transcripts-sub \
  --transcriptDir=~/meet-transcripts \
  --onTranscriptCommand='osascript -e "display notification \"$MEET_CODE\" with title \"New transcript\""' \
  --autoStart=true
```

### Shell command env vars

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

For very long transcripts, prefer reading from `$TRANSCRIPT_PATH` -- environment size is bounded (~256KB on macOS).

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

When iterating through the MCP in Claude Code, call `mcp__meet__mcpRestart` after code changes to reload. Newly added tools require a full MCP reconnect (Claude Code caches the tool list at connection time).

## License

MIT
