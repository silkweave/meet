import { createAction } from '@silkweave/core'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'

export const TranscriptWatchStatus = createAction({
  name: 'transcriptWatchStatus',
  description: 'Return the current transcript watcher status: whether it is running, per-subscription counters, recent saved transcripts, and the persisted configuration.',
  input: z.object({
    userId: z.string().optional().default('default')
  }),
  run: async ({ userId }) => {
    const client = new MeetClient(userId)
    return {
      status: transcriptWatcher.getStatus(),
      persistedConfig: client.getWatcherConfig() ?? null
    }
  }
})
