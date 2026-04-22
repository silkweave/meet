import { createAction } from '@silkweave/core'
import z from 'zod'
import { MeetClient } from '../../classes/MeetClient.js'

export const GoogleAuthorize = createAction({
  name: 'googleAuthorize',
  description: 'Generate Google OAuth authorization URL. Stores app credentials for the given userId; open the returned URL, grant consent, then pass the `code` query parameter from the redirect into `googleGetToken`.',
  input: z.object({
    clientId: z.string().optional().describe('Google OAuth 2.0 client ID. Omit to reuse the credentials previously stored for this userId.'),
    clientSecret: z.string().optional().describe('Google OAuth 2.0 client secret. Omit to reuse previously stored credentials.'),
    redirectUri: z.string().optional().default('http://localhost:3000/callback').describe('Authorized redirect URI configured in GCP'),
    userId: z.string().optional().default('default').describe('Local identifier for this token registry entry')
  }),
  run: async (params) => {
    const client = new MeetClient(params.userId)
    const clientId = params.clientId ?? client.clientId
    const clientSecret = params.clientSecret ?? client.clientSecret
    if (!clientId) { throw new Error('Client ID is required') }
    if (!clientSecret) { throw new Error('Client Secret is required') }
    client.setAppCredentials(clientId, clientSecret, params.redirectUri)
    return { authorizeUrl: client.getAuthorizeUrl(params.userId) }
  }
})
