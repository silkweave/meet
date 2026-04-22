import { createAction } from '@silkweave/core'
import z from 'zod'

export const McpHealth = createAction({
  name: 'mcpHealth',
  description: 'Check MCP server health and uptime',
  input: z.object({}),
  run: async () => ({
    status: 'ok',
    uptime: process.uptime(),
    pid: process.pid
  })
})
