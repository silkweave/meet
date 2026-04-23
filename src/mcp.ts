import { silkweave } from '@silkweave/core'
import { stdio } from '@silkweave/mcp'
import { mcpActions } from './actions/index.js'
import { MeetClient } from './classes/MeetClient.js'
import { transcriptDb } from './lib/transcriptDb.js'
import { VERSION } from './lib/version.js'
import { transcriptWatcher } from './lib/transcriptWatcher.js'

async function main() {
  await silkweave({ name: 'silkweave-meet', description: 'Meet MCP', version: VERSION })
    .adapter(stdio())
    .actions(mcpActions)
    .start()

  try { await transcriptDb.init() } catch (err) {
    process.stderr.write(`[silkweave-meet] transcriptDb init failed: ${(err as Error).message}\n`)
  }

  await maybeAutoStartWatcher()
}

async function maybeAutoStartWatcher() {
  try {
    const config = MeetClient.getWatcherConfig()
    if (!config) {
      transcriptWatcher.setNotRunningReason('no watcher config; run setupSubscribeAll or transcriptWatchStart')
      return
    }
    if (!config.autoStart) {
      transcriptWatcher.setNotRunningReason('autoStart disabled in watcher config')
      return
    }
    if (!config.pubsubSubscriptions?.length) {
      transcriptWatcher.setNotRunningReason('no pubsubSubscriptions configured in watcher config; run setupSubscribeAll to create a Pub/Sub pull subscription and wire it in')
      return
    }
    await transcriptWatcher.start(config)
  } catch (err) {
    const msg = (err as Error).message
    transcriptWatcher.setNotRunningReason(`auto-start failed: ${msg}`)
    process.stderr.write(`[silkweave-meet] transcript watcher auto-start failed: ${msg}\n`)
  }
}

main()
