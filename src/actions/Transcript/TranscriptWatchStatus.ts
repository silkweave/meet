import { createAction } from '@silkweave/core'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'

export const TranscriptWatchStatus = createAction({
  name: 'transcriptWatchStatus',
  description: 'Return the current transcript watcher status: running state, per-subscription counters, recent saved transcripts, number of known subscription owners, and the persisted configuration.',
  input: z.object({}),
  run: async () => {
    return {
      status: transcriptWatcher.getStatus(),
      persistedConfig: MeetClient.getWatcherConfig() ?? null
    }
  }
})
