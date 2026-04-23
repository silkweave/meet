import { createAction } from '@silkweave/core'
import { existsSync } from 'fs'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'
import { transcriptWatcher } from '../../lib/transcriptWatcher.js'
import { VERSION } from '../../lib/version.js'

export const McpStatus = createAction({
  name: 'mcpStatus',
  description: 'Lightweight MCP server status: health, the configured Workspace users (flagged with whether the transcript watcher has mapped a subscription to them), and the 10 most recent saved transcripts.',
  input: z.object({}),
  run: async () => {
    const watcher = transcriptWatcher.getStatus()
    const configuredUsers = MeetClient.listUsers()
    const owners = watcher.subscriptionOwners
    const perUser = configuredUsers.map((email) => {
      const subscriptions = Object.entries(owners).filter(([, e]) => e === email).map(([name]) => name)
      return { email, subscribed: subscriptions.length > 0, subscriptions }
    })
    return {
      health: {
        status: 'ok',
        version: VERSION,
        uptime: process.uptime(),
        pid: process.pid,
        serviceAccountKeyPresent: existsSync(MeetClient.keyPath),
        serviceAccountKeyPath: MeetClient.keyPath,
        configPath: MeetClient.configPath
      },
      watcher: {
        running: watcher.running,
        startedAt: watcher.startedAt,
        transcriptsSaved: watcher.transcriptsSaved,
        pubsubSubscriptions: watcher.config?.pubsubSubscriptions ?? [],
        transcriptDir: watcher.config?.transcriptDir,
        reason: watcher.notRunningReason
      },
      users: {
        total: configuredUsers.length,
        subscribed: perUser.filter((u) => u.subscribed).length,
        entries: perUser
      },
      recent: watcher.recent.slice(0, 10)
    }
  }
})
