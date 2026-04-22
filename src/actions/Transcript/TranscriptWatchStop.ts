import { createAction } from '@silkweave/core'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'

export const TranscriptWatchStop = createAction({
  name: 'transcriptWatchStop',
  description: 'Stop the background transcript watcher. Does not clear persisted config. Pass disableAutoStart=true to also prevent it from restarting on next MCP boot.',
  input: z.object({
    userId: z.string().optional().default('default'),
    disableAutoStart: z.boolean().optional().default(false)
  }),
  run: async ({ userId, disableAutoStart }) => {
    transcriptWatcher.stop()
    if (disableAutoStart) {
      const client = new MeetClient(userId)
      const existing = client.getWatcherConfig()
      if (existing) { client.setWatcherConfig({ autoStart: false }) }
    }
    return { stopped: true }
  }
})
