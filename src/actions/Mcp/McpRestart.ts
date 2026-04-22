import { createAction } from '@silkweave/core'
import z from 'zod'

export const McpRestart = createAction({
  name: 'mcpRestart',
  description: 'Restart the MCP server to pick up code changes',
  input: z.object({}),
  run: async () => {
    setTimeout(() => process.exit(0), 100)
    return { status: 'restarting' }
  }
})
