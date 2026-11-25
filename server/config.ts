import { isRecord } from '../shared/guards.js'
import { existsSync } from 'node:fs'
import { arrBaseUrl } from './arr-urls.js'
import { DEFAULT_SCAN_SCHEDULE, normalizeScanSchedule } from './config-schedule.js'
import {
  decryptSecretValues,
  encryptSecretValues,
  loadEncryptedSecrets,
  loadSecretKey,
  type EncryptedSecretsPayload,
  type SecretValues,
} from './config-secrets.js'
import { CONFIG_FILE, ENCRYPTED_SECRETS_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { log } from './logging.js'
import { DEFAULT_DATETIME_FORMAT, isValidDateTimeFormat } from '../shared/datetime-format.js'
import { SECRET_CONFIG_KEYS, type SecretConfigKey } from '../shared/contracts.js'
import {
  ARR_TAG_KEYS,
  ARR_TAG_PATTERN,
  DEFAULT_ARR_TAGS,
  DEFAULT_RELEASE_PREFERENCES,
  EMPTY_LIBRARY_SCOPE,
  normalizeLibraryScope,
  normalizeReleasePreferences,
} from '../shared/settings.js'
import { configuredArrInstances, instanceOf, PRIMARY_INSTANCE_IDS } from './arr-instances.js'
import type { ArrInstanceConfig, Config, JsonObject, PublicConfig } from './types.js'
import type { DownloadProtocol } from '../shared/download-contracts.js'

export const DEFAULT_CONFIG: Config = {
  sonarr_url: '',
  sonarr_key: '',
  radarr_url: '',
  radarr_key: '',
  sonarr_category: 'sonarr-anime',
  radarr_category: 'radarr-anime',
  sonarr_scope: EMPTY_LIBRARY_SCOPE,
  radarr_scope: EMPTY_LIBRARY_SCOPE,
  arr_instances: [],
  release_preferences: DEFAULT_RELEASE_PREFERENCES,
  verify_release_files: true,
  arr_tags_enabled: false,
  ...DEFAULT_ARR_TAGS,
  qbittorrent_url: '',
  qbittorrent_user: '',
  qbittorrent_pass: '',
  download_mode: 'torrent_only',
  sabnzbd_url: '',
  sabnzbd_key: '',
  sabnzbd_sonarr_category: 'sonarr-anime',
  sabnzbd_radarr_category: 'radarr-anime',
  animetosho_enabled: true,
  animetosho_url: 'https://feed.animetosho.net',
  amenzb_enabled: false,
  amenzb_url: 'https://amenzb.moe',
  amenzb_key: '',
  webhook: '',
  notify_enabled: true,
  notify_import_problems: true,
  unhide_on_new_best: false,
  datetime_format: DEFAULT_DATETIME_FORMAT,
  scan_schedule: DEFAULT_SCAN_SCHEDULE,
  hidden: [],
}

export const MAX_ARR_INSTANCES = 10
const INSTANCE_ID_PATTERN = /^[a-z0-9]{4,20}$/

export const DOWNLOAD_MODES = ['torrent_only', 'usenet_only', 'choose'] as const

/** Validate a user-configured client/provider base URL. Preserves reverse-proxy path prefixes, never double-appends. */
export function serviceBaseUrl(value: unknown, label: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} must use HTTP or HTTPS`)
  return raw.replace(/\/+$/, '')
}

/** SABnzbd control base: configured URL plus a single /api segment, reverse-proxy safe. */
export function sabnzbdApiUrl(config: Config): string {
  const base = serviceBaseUrl(config.sabnzbd_url, 'sabnzbd_url')
  return base ? `${base.replace(/\/api$/i, '')}/api` : ''
}

export function loadConfig(): Config {
  const raw = readJson<unknown>(CONFIG_FILE, {}, 'Could not read config')
  const stored: Partial<Config> & {
    autocheck_minutes?: number
    scan_webhook_secret?: string
    webhook_debounce_seconds?: number
    _secrets?: EncryptedSecretsPayload | null
  } = isRecord(raw) ? raw : {}
  const encryptedSecrets =
    '_secrets' in stored
      ? stored._secrets
        ? decryptSecretValues(stored._secrets, loadSecretKey())
        : {}
      : loadEncryptedSecrets()
  const plaintextSecrets: Partial<Record<SecretConfigKey, string>> = {}
  for (const key of SECRET_CONFIG_KEYS) {
    if (typeof stored[key] === 'string' && stored[key]) plaintextSecrets[key] = stored[key]
  }
  const legacyMinutes = Number(stored.autocheck_minutes)
  const scanSchedule = normalizeScanSchedule(stored.scan_schedule, legacyMinutes)
  const { arr_instance_keys: instanceKeys = {}, ...namedSecrets } = encryptedSecrets
  const config = {
    ...applyConfigUpdate({ ...DEFAULT_CONFIG, scan_schedule: scanSchedule }, stored),
    ...namedSecrets,
    ...plaintextSecrets,
  }
  config.arr_instances = config.arr_instances.map(instance => ({
    ...instance,
    key: instanceKeys[instance.id] || instance.key || '',
  }))
  config.sonarr_url = arrBaseUrl(config.sonarr_url)
  config.radarr_url = arrBaseUrl(config.radarr_url)
  config.hidden = Array.isArray(config.hidden)
    ? config.hidden.filter((key): key is string => typeof key === 'string' && Boolean(key))
    : []
  return config
}

export function publicConfig(config: Config): PublicConfig {
  const redacted = Object.fromEntries(
    SECRET_CONFIG_KEYS.flatMap(key => [
      [key, ''],
      [`${key}_configured`, Boolean(config[key])],
    ]),
  )
  // The mapped key names are not expressible through Object.fromEntries.
  return {
    ...config,
    ...redacted,
    arr_instances: config.arr_instances.map(instance => ({
      ...instance,
      key: '',
      key_configured: Boolean(instance.key),
    })),
  } as PublicConfig
}

export function saveConfig(config: Config): void {
  const stored: JsonObject = { ...config }
  const secrets: SecretValues = {}
  for (const key of SECRET_CONFIG_KEYS) {
    if (config[key]) secrets[key] = config[key]
    delete stored[key]
  }
  const instanceKeys = Object.fromEntries(
    config.arr_instances.filter(instance => instance.key).map(instance => [instance.id, instance.key]),
  )
  if (Object.keys(instanceKeys).length) secrets.arr_instance_keys = instanceKeys
  stored.arr_instances = config.arr_instances.map(({ key: _key, ...instance }) => instance)
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
  if (isRecord(stored) && !('_secrets' in stored)) {
    saveConfig(loadConfig())
    log('INFO', 'Migrated configuration to an atomic encrypted snapshot')
  }
}

/** Download-client category of the instance a result belongs to, so the right Sonarr or Radarr imports it. */
export function downloadCategory(
  config: Config,
  source: string | { arr: string; instance?: string },
  protocol: DownloadProtocol,
): string {
  const instance = instanceOf(config, typeof source === 'string' ? { arr: source } : source)
  if (!instance) return ''
  return (protocol === 'usenet' ? instance.sabnzbd_category : instance.category).trim()
}

/** SABnzbd categories every configured instance imports from. */
export function sabnzbdCategories(config: Config): string[] {
  const configured = configuredArrInstances(config).map(instance => instance.sabnzbd_category)
  return [
    ...new Set(
      [config.sabnzbd_sonarr_category, config.sabnzbd_radarr_category, ...configured]
        .map(category => category.trim())
        .filter(Boolean),
    ),
  ]
}

function normalizeArrInstances(raw: unknown, previous: ArrInstanceConfig[]): ArrInstanceConfig[] {
  if (!Array.isArray(raw)) throw new Error('arr_instances must be a list')
  if (raw.length > MAX_ARR_INSTANCES) throw new Error(`At most ${MAX_ARR_INSTANCES} additional instances are supported`)
  const ids = new Set<string>()
  const names = new Set<string>(['sonarr', 'radarr'])
  return raw.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Each additional instance must be an object')
    const source = entry as Record<string, unknown>
    const id = String(source.id ?? '').trim()
    if (!INSTANCE_ID_PATTERN.test(id) || PRIMARY_INSTANCE_IDS.includes(id))
      throw new Error('Each additional instance needs an identifier of 4 to 20 lowercase letters or digits')
    if (ids.has(id)) throw new Error('Additional instance identifiers must be unique')
    ids.add(id)
    if (source.kind !== 'sonarr' && source.kind !== 'radarr')
      throw new Error('An additional instance must be either Sonarr or Radarr')
    const existing = previous.find(instance => instance.id === id)
    if (existing && existing.kind !== source.kind)
      throw new Error('An additional instance cannot change between Sonarr and Radarr')
    const name = String(source.name ?? '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!name || name.length > 40) throw new Error('Each additional instance needs a name of 1 to 40 characters')
    if (names.has(name.toLowerCase())) throw new Error(`Instance names must be unique: "${name}" is already used`)
    names.add(name.toLowerCase())
    const key = String(source.key ?? '').trim()
    return {
      id,
      kind: source.kind,
      name,
      url: arrBaseUrl(source.url),
      key: key || existing?.key || '',
      category: String(source.category ?? existing?.category ?? `${source.kind}-anime`).trim(),
      sabnzbd_category: String(source.sabnzbd_category ?? existing?.sabnzbd_category ?? `${source.kind}-anime`).trim(),
      scope: normalizeLibraryScope(source.scope, `Scope of ${name}`),
    }
  })
}

/** The same explicit patch rules serve both saving and connection previews. */
export function applyConfigUpdate(config: Config, input: unknown): Config {
  if (!isRecord(input)) throw new Error('Configuration must be an object')
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
  for (const key of [
    'sonarr_url',
    'radarr_url',
    'sonarr_category',
    'radarr_category',
    'qbittorrent_url',
    'qbittorrent_user',
    'sabnzbd_sonarr_category',
    'sabnzbd_radarr_category',
  ] as const) {
    if (key in data)
      next[key] = key === 'sonarr_url' || key === 'radarr_url' ? arrBaseUrl(data[key]) : String(data[key] ?? '').trim()
  }
  if ('download_mode' in data) {
    if (
      typeof data.download_mode !== 'string' ||
      !DOWNLOAD_MODES.includes(data.download_mode as (typeof DOWNLOAD_MODES)[number])
    )
      throw new Error('download_mode must be torrent_only, usenet_only, or choose')
    next.download_mode = data.download_mode as Config['download_mode']
  }
  if ('sabnzbd_url' in data) next.sabnzbd_url = serviceBaseUrl(data.sabnzbd_url, 'sabnzbd_url')
  if ('animetosho_url' in data) next.animetosho_url = serviceBaseUrl(data.animetosho_url, 'animetosho_url')
  if ('amenzb_url' in data) next.amenzb_url = serviceBaseUrl(data.amenzb_url, 'amenzb_url')
  for (const key of [
    'notify_enabled',
    'notify_import_problems',
    'unhide_on_new_best',
    'animetosho_enabled',
    'amenzb_enabled',
    'verify_release_files',
    'arr_tags_enabled',
  ] as const) {
    if (key in data) {
      if (typeof data[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
      next[key] = data[key]
    }
  }
  if ('datetime_format' in data) {
    const raw = String(data.datetime_format ?? '').trim()
    if (!raw) next.datetime_format = DEFAULT_DATETIME_FORMAT
    else if (isValidDateTimeFormat(raw)) next.datetime_format = raw
    else
      throw new Error(
        'datetime_format must contain date/time tokens (YYYY MM DD HH mm ss) with only punctuation around them',
      )
  }
  if ('hidden' in data)
    next.hidden = Array.isArray(data.hidden)
      ? data.hidden.filter((key): key is string => typeof key === 'string' && Boolean(key))
      : []
  if ('scan_schedule' in data) next.scan_schedule = normalizeScanSchedule(data.scan_schedule)
  if ('sonarr_scope' in data) next.sonarr_scope = normalizeLibraryScope(data.sonarr_scope, 'sonarr_scope')
  if ('radarr_scope' in data) next.radarr_scope = normalizeLibraryScope(data.radarr_scope, 'radarr_scope')
  if ('arr_instances' in data)
    next.arr_instances = normalizeArrInstances(data.arr_instances, config.arr_instances || [])
  if ('release_preferences' in data) next.release_preferences = normalizeReleasePreferences(data.release_preferences)
  for (const key of ARR_TAG_KEYS) {
    if (!(key in data)) continue
    const label = String(data[key] ?? '')
      .trim()
      .toLowerCase()
    if (label && !ARR_TAG_PATTERN.test(label))
      throw new Error(`${key} may contain only lowercase letters, digits, and hyphens`)
    next[key] = label
  }
  const labels = ARR_TAG_KEYS.map(key => next[key]).filter(Boolean)
  if (new Set(labels).size !== labels.length) throw new Error('Each status tag needs a different name')
  if (next.arr_tags_enabled && !labels.length) throw new Error('Enter at least one tag name to write status tags')
  return next
}

export function integrationConfig(config: Config, service: string, input: unknown): Config {
  const fields: Record<string, readonly string[]> = {
    sonarr: ['sonarr_url', 'sonarr_key', 'sonarr_scope'],
    radarr: ['radarr_url', 'radarr_key', 'radarr_scope'],
    qbittorrent: ['qbittorrent_url', 'qbittorrent_user', 'qbittorrent_pass'],
    discord: ['webhook'],
    sabnzbd: ['sabnzbd_url', 'sabnzbd_key', 'sabnzbd_sonarr_category', 'sabnzbd_radarr_category'],
    animetosho: ['animetosho_enabled', 'animetosho_url'],
    amenzb: ['amenzb_enabled', 'amenzb_url', 'amenzb_key'],
  }
  const data = isRecord(input) ? (input as Record<string, unknown>) : {}
  // An additional instance is tested from the submitted draft list; nothing else in the draft applies.
  if (service.startsWith('arr:'))
    return applyConfigUpdate(config, 'arr_instances' in data ? { arr_instances: data.arr_instances } : {})
  const allowed = fields[service]
  if (!allowed) throw new Error('Unknown integration')
  return applyConfigUpdate(config, {
    ...Object.fromEntries(allowed.filter(key => key in data).map(key => [key, data[key]])),
    clear_secrets: Array.isArray(data.clear_secrets)
      ? data.clear_secrets.filter(key => typeof key === 'string' && allowed.includes(key))
      : [],
  })
}
