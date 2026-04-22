import { silkweave } from '@silkweave/core'
import { stdio } from '@silkweave/mcp'
import { actions } from './actions/index.js'
import { MeetClient } from './classes/MeetClient.js'
import { VERSION } from './lib/version.js'
import { transcriptWatcher } from './lib/transcriptWatcher.js'

async function main() {
  await silkweave({ name: 'silkweave-meet', description: 'Meet MCP', version: VERSION })
    .adapter(stdio())
    .actions(actions)
    .start()

  await maybeAutoStartWatcher()
}

async function maybeAutoStartWatcher() {
  const userId = process.env.SILKWEAVE_MEET_USER_ID ?? 'default'
  try {
    const client = new MeetClient(userId)
    const config = client.getWatcherConfig()
    if (!config?.autoStart) { return }
    if (!config.pubsubSubscriptions?.length) { return }
    await transcriptWatcher.start(userId, config)
  } catch (err) {
    process.stderr.write(`[silkweave-meet] transcript watcher auto-start failed: ${(err as Error).message}\n`)
  }
}

main()
