import { createAction } from '@silkweave/core'
import { homedir } from 'os'
import { join } from 'path'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'

export const TranscriptWatchStart = createAction({
  name: 'transcriptWatchStart',
  description: 'Start the background transcript watcher: streams Workspace Events from one or more Pub/Sub subscriptions (Pub/Sub auth via the service-account key at ~/.silkweave-meet/service-account.json), saves each new transcript as a Markdown file, and optionally runs a shell command. Meet API reads for each transcript are done by impersonating (via DWD) the user whose subscription produced the event, identified from the message\'s ce-source attribute.',
  input: z.object({
    pubsubSubscriptions: z.array(z.string()).optional().describe('Pub/Sub subscription resource names like `projects/{p}/subscriptions/{s}` to stream from. If omitted, uses the persisted config.'),
    transcriptDir: z.string().optional().describe('Directory to write transcript markdown files into. Defaults to ~/.silkweave-meet/transcripts.'),
    onTranscriptCommand: z.string().optional().describe('Optional shell command run after each transcript is saved. Exposed env vars: $TRANSCRIPT_PATH, $TRANSCRIPT_RAW, $TRANSCRIPT_NAME, $CONFERENCE_RECORD, $MEET_CODE, $START_TIME, $END_TIME, $ENTRY_COUNT, $DATE.'),
    autoStart: z.boolean().optional().describe('Persist autoStart flag so the watcher launches automatically on MCP boot.')
  }),
  run: async ({ pubsubSubscriptions, transcriptDir, onTranscriptCommand, autoStart }) => {
    const existing = MeetClient.getWatcherConfig()
    const config = MeetClient.setWatcherConfig({
      pubsubSubscriptions: pubsubSubscriptions ?? existing?.pubsubSubscriptions ?? [],
      transcriptDir: transcriptDir ?? existing?.transcriptDir ?? join(homedir(), '.silkweave-meet', 'transcripts'),
      onTranscriptCommand: onTranscriptCommand ?? existing?.onTranscriptCommand,
      autoStart: autoStart ?? existing?.autoStart
    })

    if (transcriptWatcher.isRunning()) { await transcriptWatcher.stop() }
    await transcriptWatcher.start(config)
    return { started: true, config, status: transcriptWatcher.getStatus() }
  }
})
