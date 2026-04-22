import { createAction } from '@silkweave/core'
import { homedir } from 'os'
import { join } from 'path'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'

export const TranscriptWatchStart = createAction({
  name: 'transcriptWatchStart',
  description: 'Start the background transcript watcher: pulls Workspace Events from one or more Pub/Sub subscriptions, saves each new transcript as a Markdown file, and optionally runs a shell command. Any config passed in is persisted so auto-start on next MCP boot picks it up.',
  input: z.object({
    userId: z.string().optional().default('default'),
    pubsubSubscriptions: z.array(z.string()).optional().describe('Pub/Sub subscription resource names like `projects/{p}/subscriptions/{s}` to pull from. If omitted, uses the persisted config.'),
    transcriptDir: z.string().optional().describe('Directory to write transcript markdown files into. Defaults to ~/.silkweave-meet/transcripts.'),
    onTranscriptCommand: z.string().optional().describe('Optional shell command run after each transcript is saved. Exposed env vars: $TRANSCRIPT_PATH, $TRANSCRIPT_RAW, $TRANSCRIPT_NAME, $CONFERENCE_RECORD, $MEET_CODE, $START_TIME, $END_TIME, $ENTRY_COUNT, $DATE.'),
    autoStart: z.boolean().optional().describe('Persist autoStart flag so the watcher launches automatically on MCP boot.')
  }),
  run: async ({ userId, pubsubSubscriptions, transcriptDir, onTranscriptCommand, autoStart }) => {
    const client = new MeetClient(userId)
    const existing = client.getWatcherConfig()
    const config = client.setWatcherConfig({
      pubsubSubscriptions: pubsubSubscriptions ?? existing?.pubsubSubscriptions ?? [],
      transcriptDir: transcriptDir ?? existing?.transcriptDir ?? join(homedir(), '.silkweave-meet', 'transcripts'),
      onTranscriptCommand: onTranscriptCommand ?? existing?.onTranscriptCommand,
      autoStart: autoStart ?? existing?.autoStart
    })

    if (transcriptWatcher.isRunning()) { transcriptWatcher.stop() }
    await transcriptWatcher.start(userId, config)
    return { started: true, config, status: transcriptWatcher.getStatus() }
  }
})
