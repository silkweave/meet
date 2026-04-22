import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { scopes } from '../lib/scopes.js'

export interface TokenEntry {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
  eventCursor?: string
}

export interface WatcherConfig {
  pubsubSubscriptions: string[]
  transcriptDir: string
  onTranscriptCommand?: string
  autoStart?: boolean
}

export interface TokenRegistry {
  clientId: string
  clientSecret: string
  redirectUri: string
  entries: Record<string, TokenEntry>
  watcher?: WatcherConfig
}

const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000

export class MeetClient {
  private key: string
  private storePath: string
  private registry: TokenRegistry

  constructor(key = 'default', storePath = join(homedir(), '.silkweave-meet.json')) {
    this.key = key
    this.storePath = storePath
    this.registry = existsSync(this.storePath)
      ? JSON.parse(readFileSync(this.storePath, 'utf-8'))
      : { clientId: '', clientSecret: '', redirectUri: '', entries: {} }
  }

  public setAppCredentials(clientId: string, clientSecret: string, redirectUri: string) {
    this.registry.clientId = clientId
    this.registry.clientSecret = clientSecret
    this.registry.redirectUri = redirectUri
    this.flush()
  }

  public getAuthorizeUrl(state: string) {
    return this.createOAuth2Client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: scopes,
      state
    })
  }

  public async createAccessToken(code: string): Promise<TokenEntry> {
    const { tokens } = await this.createOAuth2Client().getToken(code)
    const now = Date.now()
    const entry: TokenEntry = {
      accessToken: tokens.access_token ?? '',
      accessTokenExpiresAt: tokens.expiry_date ?? (now + 3600 * 1000),
      refreshToken: tokens.refresh_token ?? '',
      refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_MS
    }
    if (!entry.accessToken) { throw new Error('Google did not return an access token') }
    if (!entry.refreshToken) { throw new Error('Google did not return a refresh token -- ensure prompt=consent and access_type=offline') }
    this.setEntry(entry)
    return entry
  }

  public async withAuth<T>(fn: (auth: OAuth2Client) => Promise<T>): Promise<T> {
    if (!this.clientId) { throw new Error('Client ID is required, please re-authenticate') }
    if (!this.clientSecret) { throw new Error('Client Secret is required, please re-authenticate') }
    await this.assertValidAccessToken()
    const auth = this.createOAuth2Client()
    auth.setCredentials({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expiry_date: this.accessTokenExpiresAt
    })
    auth.on('tokens', (tokens) => {
      const entry = this.getEntry()
      const next: TokenEntry = {
        ...entry,
        accessToken: tokens.access_token ?? entry.accessToken,
        accessTokenExpiresAt: tokens.expiry_date ?? entry.accessTokenExpiresAt,
        refreshToken: tokens.refresh_token ?? entry.refreshToken,
        refreshTokenExpiresAt: tokens.refresh_token ? Date.now() + REFRESH_TOKEN_TTL_MS : entry.refreshTokenExpiresAt
      }
      this.setEntry(next)
    })
    return fn(auth)
  }

  public get clientId() { return this.registry.clientId }
  public get clientSecret() { return this.registry.clientSecret }
  public get redirectUri() { return this.registry.redirectUri }
  public get accessToken() { return this.getEntry().accessToken }
  public get accessTokenExpiresAt() { return this.getEntry().accessTokenExpiresAt }
  public get refreshToken() { return this.getEntry().refreshToken }
  public get refreshTokenExpiresAt() { return this.getEntry().refreshTokenExpiresAt }
  public get eventCursor() { return this.registry.entries[this.key]?.eventCursor }

  public setEventCursor(cursor: string) {
    const entry = this.getEntry()
    this.setEntry({ ...entry, eventCursor: cursor })
  }

  public getWatcherConfig(): WatcherConfig | undefined {
    return this.registry.watcher
  }

  public setWatcherConfig(config: Partial<WatcherConfig>): WatcherConfig {
    const current: WatcherConfig = this.registry.watcher ?? {
      pubsubSubscriptions: [],
      transcriptDir: join(homedir(), '.silkweave-meet', 'transcripts')
    }
    const next: WatcherConfig = { ...current, ...config }
    this.registry.watcher = next
    this.flush()
    return next
  }

  public setEntry(token: TokenEntry): void {
    this.registry.entries[this.key] = token
    this.flush()
  }

  public getEntry(): TokenEntry {
    const entry = this.registry.entries[this.key]
    if (!entry) { throw new Error(`No tokens stored for ${this.key}`) }
    return entry
  }

  private createOAuth2Client() {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri)
  }

  private async assertValidAccessToken() {
    const now = Date.now()
    const entry = this.getEntry()
    if (now >= entry.refreshTokenExpiresAt) {
      throw new Error('Refresh Token expired, please re-authenticate')
    }
    if (now < entry.accessTokenExpiresAt - 60_000) { return }
    const auth = this.createOAuth2Client()
    auth.setCredentials({ refresh_token: entry.refreshToken })
    const { credentials } = await auth.refreshAccessToken()
    const next: TokenEntry = {
      ...entry,
      accessToken: credentials.access_token ?? entry.accessToken,
      accessTokenExpiresAt: credentials.expiry_date ?? (now + 3600 * 1000),
      refreshToken: credentials.refresh_token ?? entry.refreshToken,
      refreshTokenExpiresAt: credentials.refresh_token ? now + REFRESH_TOKEN_TTL_MS : entry.refreshTokenExpiresAt
    }
    this.setEntry(next)
  }

  private flush() {
    const dirName = dirname(this.storePath)
    if (!existsSync(dirName)) { mkdirSync(dirName, { recursive: true }) }
    writeFileSync(this.storePath, JSON.stringify(this.registry, null, 2))
  }
}
