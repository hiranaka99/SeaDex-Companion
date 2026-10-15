import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { CONFIG_FILE, ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { log } from './logging.js'
import { api } from './http.js'
import type { Config, JsonObject, PublicConfig } from './types.js'

export const DEFAULT_CONFIG: Config = {
  sonarr_url: '',
  sonarr_key: '',
  radarr_url: '',
  radarr_key: '',
  sonarr_category: 'sonarr-anime',
  radarr_category: 'radarr-anime',
  qbittorrent_url: '',
  qbittorrent_user: '',
  qbittorrent_pass: '',
  webhook: '',
  notify_enabled: true,
  scan_schedule: {
    enabled: true,
    mode: 'interval',
    interval_minutes: 1440,
    times: ['03:00'],
    weekdays: [0],
    timezone: 'UTC',
    missed_run: 'run_once',
  },
  hidden: [],
}

export const SECRET_CONFIG_KEYS = ['sonarr_key', 'radarr_key', 'qbittorrent_pass', 'webhook'] as const
export type SecretConfigKey = typeof SECRET_CONFIG_KEYS[number]

export function arrBaseUrl(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/api\/v\d+$/i, '').replace(/\/+$/, '')
}

export function arrApiUrl(value: unknown): string {
  const base = arrBaseUrl(value)
  return base ? `${base}/api/v3` : ''
}

export async function sonarrApiUrl(value: unknown, key: string): Promise<string> {
  const base = arrBaseUrl(value)
  const info = await api(`${base}/api`, key, {}, true)
  if (info.current !== 'v3' && info.current !== 'v5') throw new Error(`Unsupported Sonarr API version: ${String(info.current)}`)
  return `${base}/api/${info.current}`
}

interface EncryptedSecretsPayload {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

const SECRETS_AAD = Buffer.from('seadex-companion:secrets:v1', 'utf8')

function loadSecretKey(createIfMissing = false): Buffer {
  if (!existsSync(SECRETS_KEY_FILE)) {
    if (!createIfMissing) {
      throw new Error(`Encryption key file not found: ${SECRETS_KEY_FILE}. Restore the key used to encrypt the existing credentials.`)
    }
    mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true })
    try {
      writeFileSync(SECRETS_KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 })
      log('INFO', `Generated credential encryption key: ${SECRETS_KEY_FILE}`)
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  const raw = readFileSync(SECRETS_KEY_FILE)
  const text = raw.toString('utf8').trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64')
    if (decoded.length === 32) return decoded
  }
  if (raw.length === 32) return raw
  throw new Error(`Invalid encryption key in ${SECRETS_KEY_FILE}: expected 32 raw bytes, 64 hex characters, or base64 for 32 bytes`)
}

export function encryptSecretValues(secrets: Partial<Record<SecretConfigKey, string>>, key: Buffer): EncryptedSecretsPayload {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte encryption key')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(SECRETS_AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSecretValues(payload: EncryptedSecretsPayload, key: Buffer): Partial<Record<SecretConfigKey, string>> {
  if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('Unsupported encrypted secrets format')
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte encryption key')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
    decipher.setAAD(SECRETS_AAD)
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(plaintext) as JsonObject
    const secrets: Partial<Record<SecretConfigKey, string>> = {}
    for (const keyName of SECRET_CONFIG_KEYS) if (typeof parsed[keyName] === 'string') secrets[keyName] = parsed[keyName]
    return secrets
  } catch {
    throw new Error('Could not decrypt secrets: the key is incorrect or the encrypted file is damaged')
  }
}

function loadEncryptedSecrets(): Partial<Record<SecretConfigKey, string>> {
  if (!existsSync(ENCRYPTED_SECRETS_FILE)) return {}
  const payload = readJson<EncryptedSecretsPayload | null>(ENCRYPTED_SECRETS_FILE, null)
  if (!payload) throw new Error(`Could not read encrypted secrets file: ${ENCRYPTED_SECRETS_FILE}`)
  return decryptSecretValues(payload, loadSecretKey())
}

export function normalizeScanSchedule(value: unknown, legacyMinutes?: number): Config['scan_schedule'] {
  const source = value && typeof value === 'object' ? value as JsonObject : {}
  const mode = source.mode === 'daily' || source.mode === 'weekly' ? source.mode : 'interval'
  const requestedEnabled = source.enabled === undefined ? (legacyMinutes === undefined ? DEFAULT_CONFIG.scan_schedule.enabled : Number(legacyMinutes) > 0) : source.enabled === true
  const rawInterval = Number(source.interval_minutes ?? legacyMinutes ?? 1440)
  const intervalMinutes = !requestedEnabled && rawInterval === 0 ? DEFAULT_CONFIG.scan_schedule.interval_minutes : rawInterval
  if (requestedEnabled && mode === 'interval' && (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 525_600)) throw new Error('scan_schedule.interval_minutes must be between 5 and 525600')
  const rawTimes = Array.isArray(source.times) ? source.times : ['03:00']
  const times = rawTimes.filter((time): time is string => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)).sort()
  if (requestedEnabled && mode !== 'interval' && times.length !== rawTimes.length) throw new Error('scan_schedule.times must contain valid HH:MM times')
  if (requestedEnabled && mode !== 'interval' && new Set(times).size !== times.length) throw new Error('scan_schedule.times must not contain duplicates')
  const rawWeekdays = Array.isArray(source.weekdays) ? source.weekdays : [0]
  const weekdays = rawWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort()
  if (requestedEnabled && mode === 'weekly' && (weekdays.length !== rawWeekdays.length || new Set(weekdays).size !== weekdays.length)) throw new Error('scan_schedule.weekdays must contain unique days from 0 to 6')
  const timezone = typeof source.timezone === 'string' && source.timezone ? source.timezone : 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { if (requestedEnabled && mode !== 'interval') throw new Error('scan_schedule.timezone must be a valid IANA timezone') }
  if (requestedEnabled && mode !== 'interval' && !times.length) throw new Error('scan_schedule.times must contain at least one HH:MM time')
  if (requestedEnabled && mode === 'weekly' && !weekdays.length) throw new Error('scan_schedule.weekdays must contain at least one day')
  return {
    enabled: requestedEnabled,
    mode, interval_minutes: intervalMinutes, times, weekdays, timezone,
    missed_run: source.missed_run === 'skip' ? 'skip' : 'run_once',
  }
}

export function loadConfig(): Config {
  const raw = readJson<unknown>(CONFIG_FILE, {}, 'Could not read config')
  const stored: Partial<Config> & { autocheck_minutes?: number; scan_webhook_secret?: string; webhook_debounce_seconds?: number; _secrets?: EncryptedSecretsPayload | null } = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const encryptedSecrets = '_secrets' in stored ? (stored._secrets ? decryptSecretValues(stored._secrets, loadSecretKey()) : {}) : loadEncryptedSecrets()
  const plaintextSecrets: Partial<Record<SecretConfigKey, string>> = {}
  for (const key of SECRET_CONFIG_KEYS) {
    if (typeof stored[key] === 'string' && stored[key]) plaintextSecrets[key] = stored[key]
  }
  const legacyMinutes = Number(stored.autocheck_minutes)
  const scanSchedule = normalizeScanSchedule(stored.scan_schedule, legacyMinutes)
  const config = { ...applyConfigUpdate({ ...DEFAULT_CONFIG, scan_schedule: scanSchedule }, stored), ...encryptedSecrets, ...plaintextSecrets }
  config.sonarr_url = arrBaseUrl(config.sonarr_url)
  config.radarr_url = arrBaseUrl(config.radarr_url)
  config.hidden = Array.isArray(config.hidden) ? config.hidden.filter((key): key is string => typeof key === 'string' && Boolean(key)) : []
  return config
}

export function publicConfig(config: Config): PublicConfig {
  return { ...config, sonarr_key: '', radarr_key: '', qbittorrent_pass: '', webhook: '',
    sonarr_key_configured: Boolean(config.sonarr_key), radarr_key_configured: Boolean(config.radarr_key),
    qbittorrent_pass_configured: Boolean(config.qbittorrent_pass), webhook_configured: Boolean(config.webhook),
  }
}

export function saveConfig(config: Config): void {
  const stored: JsonObject = { ...config }
  const secrets: Partial<Record<SecretConfigKey, string>> = {}
  for (const key of SECRET_CONFIG_KEYS) {
    if (config[key]) secrets[key] = config[key]
    delete stored[key]
  }
  // Credentials and public settings share one atomic commit. Encryption is retained.
  const previous = readJson<JsonObject | null>(CONFIG_FILE, null)
  const mayCreateKey = !existsSync(ENCRYPTED_SECRETS_FILE) && !previous?._secrets
  stored._secrets = Object.keys(secrets).length ? encryptSecretValues(secrets, loadSecretKey(mayCreateKey)) : null
  writeJsonAtomic(CONFIG_FILE, stored, true, 0o600)
}

/** Startup migration only; ordinary configuration reads never write. */
export function migrateConfig(): void {
  if (!existsSync(CONFIG_FILE)) return
  const stored = readJson<JsonObject | null>(CONFIG_FILE, null)
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && !('_secrets' in stored)) {
    saveConfig(loadConfig())
    log('INFO', 'Migrated configuration to an atomic encrypted snapshot')
  }
}

export function downloadCategory(config: Config, source: string): string {
  return (source === 'Sonarr' ? config.sonarr_category : source === 'Radarr' ? config.radarr_category : '').trim()
}

/** The same explicit patch rules serve both saving and connection previews. */
export function applyConfigUpdate(config: Config, input: unknown): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object')
  const data = input as Record<string, unknown>
  const next = { ...config }
  const cleared = new Set(Array.isArray(data.clear_secrets) ? data.clear_secrets : [])
  for (const key of SECRET_CONFIG_KEYS) {
    if (cleared.has(key)) next[key] = ''
    else if (key in data) {
      const raw = data[key] == null ? '' : String(data[key])
      const value = key === 'qbittorrent_pass' ? raw : raw.trim()
      if (value) next[key] = value
    }
  }
  for (const key of ['sonarr_url', 'radarr_url', 'sonarr_category', 'radarr_category', 'qbittorrent_url', 'qbittorrent_user'] as const) {
    if (key in data) next[key] = key === 'sonarr_url' || key === 'radarr_url' ? arrBaseUrl(data[key]) : String(data[key] ?? '').trim()
  }
  if ('notify_enabled' in data) {
    if (typeof data.notify_enabled !== 'boolean') throw new Error('notify_enabled must be a boolean')
    next.notify_enabled = data.notify_enabled
  }
  if ('hidden' in data) next.hidden = Array.isArray(data.hidden) ? data.hidden.filter((key): key is string => typeof key === 'string' && Boolean(key)) : []
  if ('scan_schedule' in data) next.scan_schedule = normalizeScanSchedule(data.scan_schedule)
  return next
}

export function integrationConfig(config: Config, service: string, input: unknown): Config {
  const fields: Record<string, readonly string[]> = {
    sonarr: ['sonarr_url', 'sonarr_key'], radarr: ['radarr_url', 'radarr_key'],
    qbittorrent: ['qbittorrent_url', 'qbittorrent_user', 'qbittorrent_pass'], discord: ['webhook'],
  }
  const allowed = fields[service]
  if (!allowed) throw new Error('Unknown integration')
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  return applyConfigUpdate(config, {
    ...Object.fromEntries(allowed.filter(key => key in data).map(key => [key, data[key]])),
    clear_secrets: Array.isArray(data.clear_secrets) ? data.clear_secrets.filter(key => typeof key === 'string' && allowed.includes(key)) : [],
  })
}
