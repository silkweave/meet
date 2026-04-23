import { JWT } from 'google-auth-library'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { scopes } from '../lib/scopes.js'

export interface WatcherConfig {
  pubsubSubscriptions: string[]
  transcriptDir: string
  onTranscriptCommand?: string
  autoStart?: boolean
}

export interface Config {
  users: string[]
  cursors?: Record<string, string>
  watcher?: WatcherConfig
}

const CONFIG_DIR = join(homedir(), '.silkweave-meet')
export const SERVICE_ACCOUNT_KEY_PATH = join(CONFIG_DIR, 'service-account.json')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) { return { users: [] } }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<Config>
  return { users: parsed.users ?? [], cursors: parsed.cursors, watcher: parsed.watcher }
}

function writeConfig(next: Config): void {
  if (!existsSync(CONFIG_DIR)) { mkdirSync(CONFIG_DIR, { recursive: true }) }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
}

export class MeetClient {
  public static get configPath(): string { return CONFIG_PATH }
  public static get keyPath(): string { return SERVICE_ACCOUNT_KEY_PATH }

  public static getConfig(): Config { return readConfig() }

  public static listUsers(): string[] { return readConfig().users }

  public static addUsers(emails: string[]): string[] {
    const config = readConfig()
    const set = new Set(config.users)
    for (const email of emails) { set.add(email) }
    const users = Array.from(set).sort()
    writeConfig({ ...config, users })
    return users
  }

  public static removeUser(email: string): string[] {
    const config = readConfig()
    const users = config.users.filter((u) => u !== email)
    const cursors = { ...(config.cursors ?? {}) }
    delete cursors[email]
    writeConfig({ ...config, users, cursors })
    return users
  }

  public static getEventCursor(email: string): string | undefined {
    return readConfig().cursors?.[email]
  }

  public static setEventCursor(email: string, cursor: string): void {
    const config = readConfig()
    writeConfig({ ...config, cursors: { ...(config.cursors ?? {}), [email]: cursor } })
  }

  public static getWatcherConfig(): WatcherConfig | undefined {
    return readConfig().watcher
  }

  public static setWatcherConfig(patch: Partial<WatcherConfig>): WatcherConfig {
    const config = readConfig()
    const current: WatcherConfig = config.watcher ?? {
      pubsubSubscriptions: [],
      transcriptDir: join(CONFIG_DIR, 'transcripts')
    }
    const watcher: WatcherConfig = { ...current, ...patch }
    writeConfig({ ...config, watcher })
    return watcher
  }

  public static async withAuth<T>(userEmail: string, fn: (auth: JWT) => Promise<T>): Promise<T> {
    if (!existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
      throw new Error(`Service account key not found at ${SERVICE_ACCOUNT_KEY_PATH}. Place your DWD-enabled service account JSON there (chmod 600).`)
    }
    if (!userEmail) { throw new Error('userEmail is required: DWD impersonates a specific Workspace user for every API call.') }
    const keyJson = JSON.parse(readFileSync(SERVICE_ACCOUNT_KEY_PATH, 'utf-8')) as { client_email?: string; private_key?: string }
    if (!keyJson.client_email || !keyJson.private_key) {
      throw new Error(`Service account key at ${SERVICE_ACCOUNT_KEY_PATH} is missing client_email or private_key.`)
    }
    const auth = new JWT({
      email: keyJson.client_email,
      key: keyJson.private_key,
      scopes,
      subject: userEmail
    })
    return fn(auth)
  }

  public static ensureConfigDir(): void {
    if (!existsSync(CONFIG_DIR)) { mkdirSync(CONFIG_DIR, { recursive: true }) }
  }
}
