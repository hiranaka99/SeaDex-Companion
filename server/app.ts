import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChainEntry, ChainPart, Config, JsonObject, ReleaseCandidate, ScanState } from './types.js'

export const SEADEX = 'https://releases.moe/api'
export const ANILIST = 'https://graphql.anilist.co'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const BASE_DIR = MODULE_DIR.endsWith(join('dist', 'server')) ? resolve(MODULE_DIR, '../..') : resolve(MODULE_DIR, '..')
export const DATA_DIR = process.env.DATA_DIR || BASE_DIR
export const STATIC_DIR = process.env.STATIC_DIR || join(BASE_DIR, 'static')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const ENCRYPTED_SECRETS_FILE = join(DATA_DIR, 'secrets.enc.json')
export const SECRETS_KEY_FILE = process.env.SECRETS_KEY_FILE || join(DATA_DIR, '.seadex-key')
export const CACHE_FILE = join(DATA_DIR, 'anilist_cache.json')
export const RESULTS_FILE = join(DATA_DIR, 'last_results.json')
export const NOTIFIED_FILE = join(DATA_DIR, 'notified.json')
export const OWNED_TORRENTS_FILE = join(DATA_DIR, 'owned_torrents.json')
export const LOG_DIR = join(DATA_DIR, 'logs')
export const LOG_FILE = join(LOG_DIR, 'app.log')

mkdirSync(LOG_DIR, { recursive: true })

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
  autocheck_minutes: 1440,
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

interface EncryptedSecretsPayload {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

const SECRETS_AAD = Buffer.from('seadex-companion:secrets:v1', 'utf8')

export const scanState: ScanState = {
  running: false,
  progress: 0,
  total: 0,
  message: 'Idle',
  results: [],
  error: null,
  last_run: null,
}

export const autocheckState: { last: number; next: number | null } = {
  last: Date.now() / 1000,
  next: null,
}

export function setState(values: Partial<ScanState>): void {
  Object.assign(scanState, values)
}

export function getState(): ScanState {
  return { ...scanState, results: scanState.results }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function rotateLog(): void {
  try {
    if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size < 5 * 1024 * 1024) return
    for (let index = 3; index >= 1; index -= 1) {
      const source = index === 1 ? LOG_FILE : `${LOG_FILE}.${index - 1}`
      const target = `${LOG_FILE}.${index}`
      if (existsSync(source)) renameSync(source, target)
    }
  } catch {
    // Logging must never stop the application.
  }
}

export function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string): void {
  const line = `${timestamp()} [${level}] ${message}`
  rotateLog()
  try { appendFileSync(LOG_FILE, `${line}\n`, 'utf8') } catch { /* stdout is still available */ }
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARNING') console.warn(line)
  else console.log(line)
}

function readJson<T>(file: string, fallback: T, warning?: string): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    if (warning) log('WARNING', `${warning} (${errorMessage(error)}), using defaults`)
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown, pretty = false, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, pretty ? 2 : undefined), { encoding: 'utf8', mode })
  if (mode !== undefined) chmodSync(temporary, mode)
  renameSync(temporary, file)
  if (mode !== undefined) chmodSync(file, mode)
}

function loadSecretKey(createIfMissing = false): Buffer {
  if (!existsSync(SECRETS_KEY_FILE)) {
    if (!createIfMissing) {
      throw new Error(`Encryption key file not found: ${SECRETS_KEY_FILE}. Restore the key used to encrypt the existing credentials.`)
    }
    mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true })
    try {
      writeFileSync(SECRETS_KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 })
      log('INFO', `Generated credential encryption key: ${SECRETS_KEY_FILE}`)
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
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

export function loadConfig(): Config {
  const stored = readJson<Partial<Config>>(CONFIG_FILE, {}, 'Could not read config')
  const encryptedSecrets = loadEncryptedSecrets()
  const plaintextSecrets: Partial<Record<SecretConfigKey, string>> = {}
  let containsPlaintextSecretFields = false
  for (const key of SECRET_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) containsPlaintextSecretFields = true
    if (typeof stored[key] === 'string' && stored[key]) plaintextSecrets[key] = stored[key]
  }
  const config = { ...DEFAULT_CONFIG, ...stored, ...encryptedSecrets, ...plaintextSecrets }
  config.sonarr_url = arrBaseUrl(config.sonarr_url)
  config.radarr_url = arrBaseUrl(config.radarr_url)
  if (containsPlaintextSecretFields) {
    saveConfig(config)
    log('INFO', 'Migrated plaintext configuration secrets to encrypted storage')
  }
  return config
}

export function publicConfig(config: Config): JsonObject {
  const result: JsonObject = { ...config }
  for (const key of SECRET_CONFIG_KEYS) {
    result[key] = ''
    result[`${key}_configured`] = Boolean(config[key])
  }
  return result
}

export function saveConfig(config: Config): void {
  const stored: JsonObject = { ...config }
  const secrets: Partial<Record<SecretConfigKey, string>> = {}
  for (const key of SECRET_CONFIG_KEYS) {
    if (config[key]) secrets[key] = config[key]
    delete stored[key]
  }
  if (Object.keys(secrets).length || existsSync(ENCRYPTED_SECRETS_FILE)) {
    const mayCreateKey = !existsSync(ENCRYPTED_SECRETS_FILE)
    writeJsonAtomic(ENCRYPTED_SECRETS_FILE, encryptSecretValues(secrets, loadSecretKey(mayCreateKey)), true, 0o600)
  }
  writeJsonAtomic(CONFIG_FILE, stored, true, 0o600)
}
export function loadCache(): JsonObject { return readJson<JsonObject>(CACHE_FILE, {}) }
export function saveCache(cache: JsonObject): void { writeJsonAtomic(CACHE_FILE, cache, true) }
export function saveLastResults(results: JsonObject[], lastRun: string): void {
  writeJsonAtomic(RESULTS_FILE, { results, last_run: lastRun })
}
export function loadLastResults(): JsonObject | null { return readJson<JsonObject | null>(RESULTS_FILE, null) }
export function loadNotified(): Set<string> { return new Set(readJson<string[]>(NOTIFIED_FILE, [])) }
export function saveNotified(keys: Set<string>): void { writeJsonAtomic(NOTIFIED_FILE, [...keys].sort()) }

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 60_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
}

export async function api(url: string, key?: string, init: RequestInit = {}): Promise<any> {
  try {
    const headers = new Headers(init.headers)
    if (key) headers.set('X-Api-Key', key)
    const response = await fetchWithTimeout(url, { ...init, headers })
    if (!response.ok) {
      log('ERROR', `API ${url} → HTTP ${response.status}`)
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    log('ERROR', `API request to ${url} failed: ${errorMessage(error)}`)
    throw error
  }
}

export function guessQuality(filename: string): string {
  const resolution = filename.match(/(2160p|1080p|720p)/i)?.[1] || '?'
  const source = filename.match(/(Blu-ray|Web-DL|WebRip|BD-Remux)/i)?.[1] || ''
  return `${resolution} ${source}`.trim()
}

export function seasonsFromFiles(files: JsonObject[] = []): Set<number> {
  const seasons = new Set<number>()
  for (const file of files) {
    for (const match of String(file.name || '').matchAll(/S(\d{1,3})E(\d{1,3})/gi)) seasons.add(Number(match[1]))
  }
  return seasons
}

export async function seadexBest(): Promise<Map<number, JsonObject>> {
  const best = new Map<number, JsonObject>()
  let page = 1
  while (true) {
    const data = await api(`${SEADEX}/collections/entries/records?page=${page}&perPage=500&expand=trs`)
    for (const item of data.items as JsonObject[]) {
      const alid = Number(item.alID)
      const torrents = item.expand?.trs || []
      if (!best.has(alid)) best.set(alid, { url: `https://releases.moe/${alid}/`, notes: item.notes || '-', seasons: {} })
      const entry = best.get(alid)!
      // Keep filler/placeholder pages even when SeaDex has no torrents. The
      // scanner can then mark the mapped season as uncovered (with its page
      // link) instead of incorrectly claiming that it is not listed at all.
      if (!torrents.length) continue
      const torrentInfos: Array<[JsonObject, JsonObject[], Set<number>]> = []
      const entrySeasons = new Set<number>()
      for (const torrent of torrents) {
        const files = torrent.files || []
        const seasons = seasonsFromFiles(files)
        for (const season of seasons) entrySeasons.add(season)
        torrentInfos.push([torrent, files, seasons])
      }
      for (const [torrent, files, detectedSeasons] of torrentInfos) {
        const seasons = detectedSeasons.size ? detectedSeasons : (entrySeasons.size ? entrySeasons : new Set([0]))
        const quality = guessQuality(files.map((file) => file.name || '').join(' '))
        const sizes = new Map<number, number>()
        const counts = new Map<number, number>()
        for (const file of files) {
          const season = Number(String(file.name || '').match(/S(\d{1,3})E/i)?.[1] || 0)
          sizes.set(season, (sizes.get(season) || 0) + (file.length || 0))
          counts.set(season, (counts.get(season) || 0) + 1)
        }
        for (const season of seasons) {
          entry.seasons[season] ||= { candidates: [] }
          const candidates = entry.seasons[season].candidates as ReleaseCandidate[]
          let size = sizes.get(season) || 0
          let count = counts.get(season) || 0
          if (!size && season !== 0) size = sizes.get(0) || 0
          if (!count && season !== 0) count = counts.get(0) || 0
          const groupKey = `${String(torrent.releaseGroup).toLowerCase()}\0${String(torrent.tracker || '').toLowerCase()}`
          let release = candidates.find((candidate) => `${candidate.releaseGroup.toLowerCase()}\0${String(candidate.tracker || '').toLowerCase()}` === groupKey)
          if (!release) {
            release = {
              releaseGroup: torrent.releaseGroup,
              tracker: torrent.tracker,
              quality,
              tags: torrent.tags || [],
              dual_audio: Boolean(torrent.dualAudio),
              size: 0,
              file_count: 0,
              info_hashes: [],
              is_best: false,
              source_files: [],
            }
            candidates.push(release)
          }
          release.size += size
          release.file_count += count
          release.is_best ||= Boolean(torrent.isBest)
          release.dual_audio ||= Boolean(torrent.dualAudio)
          release.source_files!.push(...files.map((file) => ({ name: String(file.name || ''), length: Number(file.length || 0) })))
          const hash = torrent.infoHash || ''
          if (hash && !release.info_hashes.includes(hash)) release.info_hashes.push(hash)
        }
      }
    }
    if (page >= data.totalPages) break
    page += 1
  }
  return best
}

export async function localItems(config: Config): Promise<JsonObject[]> {
  const items: JsonObject[] = []
  if (config.sonarr_url && config.sonarr_key) {
    let series: JsonObject[] = []
    try { series = await api(`${arrApiUrl(config.sonarr_url)}/series`, config.sonarr_key) } catch { /* preserve partial scans */ }
    for (const show of series) {
      let episodes: JsonObject[] = []
      let episodeFiles: JsonObject[] = []
      try {
        [episodes, episodeFiles] = await Promise.all([
          api(`${arrApiUrl(config.sonarr_url)}/episode?seriesId=${show.id}`, config.sonarr_key),
          api(`${arrApiUrl(config.sonarr_url)}/episodefile?seriesId=${show.id}`, config.sonarr_key),
        ])
      } catch { /* fall back to season-wide release groups */ }
      const fileGroups = new Map<number, string>()
      const fileSizes = new Map<number, number>()
      for (const file of episodeFiles) {
        const group = String(file.releaseGroup || '').trim()
        if (file.id && group) fileGroups.set(Number(file.id), group)
        if (file.id) fileSizes.set(Number(file.id), Number(file.size || 0))
      }
      const groupsBySeasonEpisode = new Map<number, Map<string, Set<number>>>()
      const episodeNumbersBySeason = new Map<number, Set<number>>()
      const fileEpisodes = new Map<number, { season: number; episode: number }[]>()
      for (const episode of episodes) {
        const season = Number(episode.seasonNumber || 0)
        const number = Number(episode.episodeNumber || 0)
        if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(number) || number <= 0) continue
        const seasonNumbers = episodeNumbersBySeason.get(season) || new Set<number>()
        seasonNumbers.add(number); episodeNumbersBySeason.set(season, seasonNumbers)
        const fileId = Number(episode.episodeFileId || episode.episodeFile?.id || 0)
        const group = String(episode.episodeFile?.releaseGroup || fileGroups.get(fileId) || '').trim()
        if (fileId && !fileSizes.has(fileId) && episode.episodeFile?.size) fileSizes.set(fileId, Number(episode.episodeFile.size))
        if (fileId) fileEpisodes.set(fileId, [...(fileEpisodes.get(fileId) || []), { season, episode: number }])
        if (!group) continue
        const groups = groupsBySeasonEpisode.get(season) || new Map<string, Set<number>>()
        const numbers = groups.get(group) || new Set<number>()
        numbers.add(number); groups.set(group, numbers); groupsBySeasonEpisode.set(season, groups)
      }
      const sizesBySeasonEpisode = new Map<number, Map<number, number>>()
      for (const [fileId, linkedEpisodes] of fileEpisodes) {
        const size = fileSizes.get(fileId) || 0
        if (!size || !linkedEpisodes.length) continue
        const share = size / linkedEpisodes.length
        for (const linked of linkedEpisodes) {
          const sizes = sizesBySeasonEpisode.get(linked.season) || new Map<number, number>()
          sizes.set(linked.episode, (sizes.get(linked.episode) || 0) + share)
          sizesBySeasonEpisode.set(linked.season, sizes)
        }
      }
      const seasons: JsonObject = {}
      for (const season of show.seasons || []) {
        const number = season.seasonNumber || 0
        if (number === 0) continue
        const stats = season.statistics || {}
        const groups = stats.releaseGroups || []
        if (groups.length) {
          const episodeGroups = groupsBySeasonEpisode.get(Number(number))
          const episodeSizes = sizesBySeasonEpisode.get(Number(number))
          const episodeNumbers = [...(episodeNumbersBySeason.get(Number(number)) || [])].sort((left, right) => left - right)
          seasons[number] = {
            groups,
            size: stats.sizeOnDisk || 0,
            episode_numbers: episodeNumbers,
            episode_count: episodeNumbers.length || null,
            groups_by_episode: episodeGroups
              ? Object.fromEntries([...episodeGroups].map(([group, numbers]) => [group, [...numbers].sort((left, right) => left - right)]))
              : {},
            sizes_by_episode: episodeSizes ? Object.fromEntries(episodeSizes) : {},
          }
        }
      }
      if (Object.keys(seasons).length) items.push({ arr: 'Sonarr', id: show.id, title: show.title, slug: show.titleSlug, seasons })
    }
  }
  if (config.radarr_url && config.radarr_key) {
    let movies: JsonObject[] = []
    try { movies = await api(`${arrApiUrl(config.radarr_url)}/movie`, config.radarr_key) } catch { /* preserve partial scans */ }
    for (const movie of movies) {
      const stats = movie.statistics || {}
      const groups = stats.releaseGroups || []
      if (groups.length) items.push({
        arr: 'Radarr', id: movie.id, title: movie.title, slug: movie.titleSlug,
        seasons: { 0: { groups, size: stats.sizeOnDisk || 0 } },
      })
    }
  }
  return items
}

export function arrItemUrl(config: Config | JsonObject, item: JsonObject): string | null {
  const base = arrBaseUrl(config[`${String(item.arr).toLowerCase()}_url`])
  if (!base) return null
  const path = item.arr === 'Sonarr' ? 'series' : 'movie'
  return `${base}/${path}/${item.slug || item.id}`
}

let lastAnilist = 0
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))

async function pacedAniList(payload: JsonObject, search: boolean): Promise<any> {
  let result: any = search ? [] : {}
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = 2050 - (Date.now() - lastAnilist)
    if (wait > 0) await sleep(wait)
    lastAnilist = Date.now()
    let response: Response
    try {
      response = await fetchWithTimeout(ANILIST, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, 30_000)
    } catch (error) {
      log('WARNING', `AniList ${search ? 'search ' : ''}network error, retrying: ${errorMessage(error)}`)
      await sleep(3000)
      continue
    }
    if (response.status === 429) {
      log('WARNING', `AniList ${search ? 'search ' : ''}rate limit (HTTP 429), backing off`)
      await sleep((Number(response.headers.get('Retry-After') || 60) + 1) * 1000)
      continue
    }
    let body: any = null
    try { body = await response.json() } catch { /* transient non-JSON response */ }
    result = search ? (body?.data?.Page?.media || []) : (body?.data?.Media || {})
    break
  }
  return result
}

export async function alMedia(query: string, variables: JsonObject): Promise<JsonObject> {
  return pacedAniList({ query, variables }, false)
}
export async function alSearch(query: string, variables: JsonObject): Promise<JsonObject[]> {
  return pacedAniList({ query, variables }, true)
}

export function normalizeTitle(title: string): string {
  if (!title) return ''
  return title.replace(/×/g, 'x').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[«»]/g, '').replace(/\s*[:-]\s*(The\s+Movie|Movie|Theatrical)\b.*$/i, '')
    .replace(/\s+/g, ' ').trim()
}

export function searchCandidates(title: string): string[] {
  const normalized = normalizeTitle(title)
  const spaced = normalized.replace(/([a-z])\s*([Xx])\s*([A-Z])/g, '$1 $2 $3')
  const seen = new Set<string>()
  return [title, normalized, spaced].filter((candidate) => {
    const key = candidate?.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function titleKey(title?: string | null): string {
  return (title || '').toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9]+/g, '')
}

export function pickAniListSearchResult(candidates: JsonObject[], title: string): JsonObject | null {
  const wanted = titleKey(title)
  const score = (media: JsonObject): number[] => {
    const titles = media.title || {}
    const exact = Boolean(wanted && ['english', 'romaji', 'native'].some((key) => titleKey(titles[key]) === wanted))
    const seasonFormat = ['TV', 'TV_SHORT', 'ONA'].includes(media.format)
    return [exact ? 3 : 0, seasonFormat ? 1 : 0, -(media.seasonYear || 9999), -(media.id || 0)]
  }
  const compare = (left: number[], right: number[]) => {
    for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i]
    return 0
  }
  return candidates.reduce<JsonObject | null>((best, candidate) => !best || compare(score(candidate), score(best)) > 0 ? candidate : best, null)
}

export async function anilistLookup(title: string, cache: JsonObject, search = alSearch, persist = saveCache): Promise<JsonObject | null> {
  const cacheKey = `lookup:v2:${title}`
  if (cache[cacheKey]) return cache[cacheKey]
  const query = 'query($t:String){Page(perPage:10){media(search:$t,type:ANIME,sort:SEARCH_MATCH){id format season seasonYear episodes title{romaji english native} coverImage{large extraLarge} bannerImage}}}'
  for (const candidate of searchCandidates(title)) {
    const data = pickAniListSearchResult(await search(query, { t: candidate }), candidate)
    if (data) {
      const cover = data.coverImage || {}
      const entry = { id: data.id, cover: cover.extraLarge || cover.large, banner: data.bannerImage }
      cache[cacheKey] = entry
      persist(cache)
      return entry
    }
  }
  return null
}

const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA'])
const SEASON_ORDER: JsonObject = { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 }
const COUR_PART_RE = /\b(?:part|cour)\s*(?:[-:]\s*)?(\d+|first|second|third|fourth|1st|2nd|3rd|4th)\b/i
const COUR_ORDINALS: JsonObject = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 }

export function courPartNumber(media: JsonObject): number | null {
  const titles = media.title || {}
  for (const title of [titles.english, titles.romaji, titles.native]) {
    const value = String(title || '').match(COUR_PART_RE)?.[1]?.toLowerCase()
    if (value) return /^\d+$/.test(value) ? Number(value) : COUR_ORDINALS[value]
  }
  return null
}

function mediaPart(id: number, data: JsonObject, fallback: JsonObject = {}): ChainPart & JsonObject {
  const cover = data.coverImage || {}
  const titles = data.title || {}
  return {
    id, cover: cover.extraLarge || cover.large || fallback.cover,
    banner: data.bannerImage || fallback.banner,
    episodeCount: data.episodes ?? null,
    title: titles.english || titles.romaji,
  }
}

export interface AniListDependencies {
  lookup?: typeof anilistLookup
  media?: typeof alMedia
  persist?: typeof saveCache
}

export async function anilistChain(title: string, cache: JsonObject, dependencies: AniListDependencies = {}): Promise<ChainEntry[]> {
  const lookup = dependencies.lookup || anilistLookup
  const media = dependencies.media || alMedia
  const persist = dependencies.persist || saveCache
  const base = await lookup(title, cache)
  if (!base) return []
  const chainKey = `chain:v8:${base.id}`
  if (cache[chainKey]) return cache[chainKey].chain || []
  const query = 'query($id:Int){Media(id:$id,type:ANIME){id format season seasonYear episodes title{romaji english native} coverImage{large extraLarge} bannerImage relations{edges{relationType node{id}}}}}'
  const nodes = new Map<number, JsonObject>()
  const seen = new Set<number>([base.id])
  const queue = [base.id as number]
  while (queue.length && nodes.size < 50) {
    const id = queue.shift()!
    const data = await media(query, { id })
    if (!Object.keys(data).length) continue
    nodes.set(id, data)
    for (const edge of data.relations?.edges || []) {
      const nextId = edge.node?.id
      if (edge.relationType === 'SEQUEL' && nextId && !seen.has(nextId)) {
        seen.add(nextId)
        queue.push(nextId)
      }
    }
  }
  const discovery = new Map([...nodes.keys()].map((id, index) => [id, index]))
  const seasonIds = [...nodes.keys()].filter((id) => id !== base.id && SEASON_FORMATS.has(nodes.get(id)?.format))
  seasonIds.sort((left, right) => {
    const a = nodes.get(left) || {}; const b = nodes.get(right) || {}
    const aa = [discovery.get(left) || 0, a.seasonYear || 0, SEASON_ORDER[a.season] ?? 4, left]
    const bb = [discovery.get(right) || 0, b.seasonYear || 0, SEASON_ORDER[b.season] ?? 4, right]
    for (let index = 0; index < aa.length; index += 1) if (aa[index] !== bb[index]) return aa[index] - bb[index]
    return 0
  })
  const groups: number[][] = [[base.id]]
  const groupById = new Map<number, number[]>([[base.id, groups[0]]])
  for (const id of seasonIds) {
    const data = nodes.get(id)!
    let group: number[] | undefined
    if ((courPartNumber(data) || 0) >= 2) {
      const prequels = (data.relations?.edges || []).filter((edge: JsonObject) => edge.relationType === 'PREQUEL').map((edge: JsonObject) => edge.node?.id)
      group = prequels.map((prequel: number) => groupById.get(prequel)).find(Boolean) || groups.at(-1)
    }
    if (!group) { group = []; groups.push(group) }
    group.push(id); groupById.set(id, group)
  }
  const chain = groups.map((ids, index) => {
    const parts = ids.map((id) => mediaPart(id, nodes.get(id) || {}, id === base.id ? base : {}))
    const first = parts[0]
    const counts = parts.map((part) => part.episodeCount)
    return {
      season: index + 1, id: first.id, ids: parts.map((part) => part.id), parts,
      cover: first.cover, banner: first.banner,
      episodeCount: counts.every((count) => count !== null) ? counts.reduce((sum, count) => sum + count, 0) : null,
    } as unknown as ChainEntry
  })
  cache[chainKey] = { chain }
  persist(cache)
  return chain
}

export function isDownloadable(release: JsonObject): boolean {
  return (release.info_hashes || []).some((hash: string) => /^[0-9a-f]{40}$/i.test(hash))
}

export function pickBest(candidates: ReleaseCandidate[], episodeCount?: number | null): [ReleaseCandidate | null, ReleaseCandidate[]] {
  if (!candidates.length) return [null, []]
  const flagged = candidates.filter((candidate) => candidate.is_best)
  let pool = flagged.length ? flagged : [...candidates]
  if (episodeCount && episodeCount > 0) {
    const matching = pool.filter((candidate) => candidate.file_count === episodeCount)
    if (matching.length) pool = matching
  }
  const downloadable = pool.filter(isDownloadable)
  const selectedPool = downloadable.length ? downloadable : pool
  const chosen = selectedPool.reduce((best, candidate) => (candidate.size || 0) > (best.size || 0) ? candidate : best)
  return [chosen, candidates.filter((candidate) => candidate !== chosen)]
}

interface ParsedEpisode {
  episode: number
  season: number | null
}

function episodeFromFilename(name: string): ParsedEpisode | null {
  // Opening/ending theme clips are extras, never episodes. Keeping them unparsed
  // lets scopeReleaseToPart treat them as cour extras instead of mis-reading the
  // "NCOP 01" / "NCED1" counters as absolute episode numbers.
  if (/NCOP|NCED/i.test(name)) return null
  const standard = name.match(/S(\d{1,3})E(\d{1,3}(?:\.\d+)?)/i)
  if (standard) return { season: Number(standard[1]), episode: Number(standard[2]) }
  const named = name.match(/(?:\bSeason\b|\bEpisode\b|\bEp\.?)[ ._-]*(\d{1,3}(?:\.\d+)?)(?=[ ._[\]()-]|$)/i)
  if (named) return { season: null, episode: Number(named[1]) }
  // Absolute episode numbering with no season/episode keyword, e.g.
  // "[Thighs] Mushoku Tensei - 05 (BD 1080p ...).mkv". This is a common whole-season
  // encode layout: the first standalone 1-3 digit value (optional half-episode) after
  // the title is the absolute episode number. The trailing boundary keeps resolution
  // tags such as "1080p" (a 4-digit run) from being mistaken for an episode.
  const absolute = name.match(/(?:^|[\s_-])(\d{1,3}(?:\.\d+)?)(?=[\s(.\]]|$)/)
  return absolute ? { season: null, episode: Number(absolute[1]) } : null
}

function extraBelongsToPart(name: string, partNumber: number): boolean {
  const padded = String(partNumber).padStart(2, '0')
  return new RegExp(`(?:P(?:art)?[ ._-]*0?${partNumber}\\b.*(?:NCOP|NCED)|(?:NCOP|NCED)[ ._-]*${padded}\\b)`, 'i').test(name)
}

/**
 * Restrict downloads to regular episodes. For split cours this also scopes a
 * whole-season torrent to the current cour; for normal seasons it removes
 * specials, extras, and other files when the full episode set is identifiable.
 */
export function scopeReleaseToPart(
  release: ReleaseCandidate,
  episodeCount: number | null | undefined,
  partIndex: number,
  partCount: number,
  episodeOffset?: number,
): ReleaseCandidate {
  const files = release.source_files || []
  if (!episodeCount || episodeCount <= 0 || !files.length) return release

  const parsed = files.map((file) => ({ file, parsed: episodeFromFilename(file.name) }))
  const seasonFrequency = new Map<number, number>()
  for (const item of parsed) {
    const season = item.parsed?.season
    if (season && season > 0 && Number.isInteger(item.parsed?.episode)) seasonFrequency.set(season, (seasonFrequency.get(season) || 0) + 1)
  }
  // A positive SxxE season wins when present; otherwise the torrent uses absolute
  // numbering (season null) and we scope on those files, ignoring S00 specials.
  const primarySeason = [...seasonFrequency].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  const inScope = (season: number | null): boolean => primarySeason !== null ? season === primarySeason : season === null
  const episodeNumbers = [...new Set(
    parsed
      .filter((item) => item.parsed && Number.isInteger(item.parsed.episode) && inScope(item.parsed.season))
      .map((item) => item.parsed!.episode),
  )].sort((left, right) => left - right)
  const splitSeason = partCount > 1
  if (splitSeason ? episodeNumbers.length <= episodeCount : episodeNumbers.length < episodeCount) return release

  const start = splitSeason ? (episodeOffset ?? partIndex * episodeCount) : 0
  const selectedNumbers = episodeNumbers.slice(start, start + episodeCount)
  if (!selectedNumbers.length) return release
  const selected = new Set(selectedNumbers)
  const partNumber = partIndex + 1
  const selectedEpisodeFiles = parsed.filter(({ parsed: episode }) =>
    episode && selected.has(episode.episode) && inScope(episode.season),
  )
  const selectedEpisodeFileSet = new Set(selectedEpisodeFiles.map(({ file }) => file))
  if (!splitSeason) {
    if (selectedEpisodeFiles.length === files.length) return release
    return {
      ...release,
      size: selectedEpisodeFiles.reduce((total, { file }) => total + file.length, 0),
      file_count: selectedNumbers.length,
      selected_files: selectedEpisodeFiles.map(({ file }) => file.name),
    }
  }
  const scopedFiles = parsed.filter(({ file, parsed: episode }) =>
    selectedEpisodeFileSet.has(file) ||
    (!episode && extraBelongsToPart(file.name, partNumber)),
  )
  if (!scopedFiles.length) return release

  return {
    ...release,
    size: scopedFiles.reduce((total, { file }) => total + file.length, 0),
    file_count: selectedNumbers.length,
    selected_files: selectedEpisodeFiles.map(({ file }) => file.name),
  }
}

export function releaseDict(kind: string, release: JsonObject, part?: string | null, url?: string): JsonObject {
  const result: JsonObject = {
    kind, releaseGroup: release.releaseGroup, tracker: release.tracker, quality: release.quality,
    tags: release.tags || [], dual_audio: Boolean(release.dual_audio), size: release.size || 0,
    info_hashes: [...(release.info_hashes || [])], downloadable: isDownloadable(release),
  }
  if (part) result.part = part
  if (url) result.url = url
  if (release.selected_files?.length) result.selected_files = [...release.selected_files]
  return result
}

export function seadexSlot(entry: JsonObject, season: number): JsonObject | null {
  const direct = entry.seasons?.[season]
  if (direct?.candidates?.length) return direct
  const buckets = Object.entries(entry.seasons || {}).filter(([, value]: [string, any]) => value.candidates?.length)
  if (!buckets.length) return null
  buckets.sort(([left], [right]) => Math.abs(Number(left) - season) - Math.abs(Number(right) - season) || Number(left) - Number(right))
  return buckets[0][1] as JsonObject
}

export function entryParts(entry: JsonObject): JsonObject[] {
  return entry.parts || [{ id: entry.id, episodeCount: entry.episodeCount, title: null }]
}

/**
 * AniList tells us which entries form a split season, while Sonarr's episode
 * list is sourced from TVDB and is authoritative for the episodes in it.
 */
export function effectiveSeasonParts(local: JsonObject, parts: JsonObject[]): JsonObject[] {
  const episodeNumbers = [...new Set<number>(
    (local.episode_numbers || [])
      .map(Number)
      .filter((episode: number) => Number.isInteger(episode) && episode > 0),
  )].sort((left, right) => left - right)
  if (!episodeNumbers.length || !parts.length) return parts

  if (parts.length === 1) {
    return [{ ...parts[0], episodeCount: episodeNumbers.length, episodeNumbers }]
  }

  // Earlier AniList counts define the cour boundaries. The final cour gets
  // every TVDB episode that remains, correcting stale AniList season totals.
  let offset = 0
  return parts.map((part, index) => {
    const isLast = index === parts.length - 1
    const boundaryCount = Math.max(0, Number(part.episodeCount || 0))
    const partEpisodes = isLast
      ? episodeNumbers.slice(offset)
      : episodeNumbers.slice(offset, offset + boundaryCount)
    offset += partEpisodes.length
    return { ...part, episodeCount: partEpisodes.length, episodeNumbers: partEpisodes }
  })
}

export function orderedPartReleases(best: ReleaseCandidate, alternatives: ReleaseCandidate[]): Array<['best' | 'alt', ReleaseCandidate]> {
  const byGroup = new Map<string, ReleaseCandidate>()
  for (const release of [best, ...alternatives]) {
    const key = release.releaseGroup.trim().toLowerCase()
    const current = byGroup.get(key)
    if (!current || (isDownloadable(release) && !isDownloadable(current))) byGroup.set(key, release)
  }
  const bestKey = best.releaseGroup.trim().toLowerCase()
  const ordered = [bestKey, ...[...byGroup.keys()].filter((key) => key !== bestKey)]
  return ordered.map((key) => [key === bestKey || byGroup.get(key)!.is_best ? 'best' : 'alt', byGroup.get(key)!])
}

export function commonBestRelease(resolved: JsonObject[], localGroups: Set<string>): ReleaseCandidate | null {
  if (resolved.length < 2) return null
  let common: Set<string> | null = null
  const releases = new Map<string, ReleaseCandidate>()
  for (const part of resolved) {
    const keys = new Set<string>()
    for (const release of [part.best, ...part.alts] as ReleaseCandidate[]) {
      if (!release.is_best || !isDownloadable(release) || !localGroups.has(release.releaseGroup.trim().toLowerCase())) continue
      const hashes = release.info_hashes.filter((hash) => /^[0-9a-f]{40}$/i.test(hash)).map((hash) => hash.toLowerCase()).sort()
      if (!hashes.length) continue
      const key = `${release.releaseGroup.trim().toLowerCase()}\0${hashes.join('\0')}`
      keys.add(key); if (!releases.has(key)) releases.set(key, release)
    }
    if (common === null) common = keys
    else {
      const intersection = new Set<string>()
      for (const key of common as Set<string>) if (keys.has(key)) intersection.add(key)
      common = intersection
    }
    if (!common.size) return null
  }
  const commonKeys = common as Set<string>
  return [...commonKeys].map((key) => releases.get(key)!).reduce<ReleaseCandidate | null>((best, release) => !best || release.size > best.size ? release : best, null)
}

export function partBestGroups(part: JsonObject): Set<string> {
  return new Set(orderedPartReleases(part.best, part.alts).filter(([kind]) => kind === 'best').map(([, release]) => release.releaseGroup.trim().toLowerCase()))
}

export interface PartOwnership {
  have: Record<string, string[]>
  owned: Record<string, string[]>
  sizes: Record<string, number>
  precise: boolean
}

export function localPartOwnership(local: JsonObject, parts: JsonObject[]): PartOwnership {
  const groups: string[] = [...(local.groups || [])]
  const episodeEntries = Object.entries(local.groups_by_episode || {})
    .map(([group, episodes]) => [group, new Set((episodes as unknown[]).map(Number).filter((episode) => episode > 0))] as const)
    .filter(([, episodes]) => episodes.size > 0)
  const precise = episodeEntries.length > 0
  const have: Record<string, string[]> = {}
  const owned: Record<string, string[]> = {}
  const sizes: Record<string, number> = {}
  const episodeSizes = new Map(
    Object.entries(local.sizes_by_episode || {}).map(([episode, size]) => [Number(episode), Number(size || 0)]),
  )
  const hasEpisodeSizes = episodeSizes.size > 0
  let offset = 0

  for (const [index, part] of parts.entries()) {
    const label = parts.length > 1 ? `Cour ${index + 1}` : ''
    const count = Number(part.episodeCount || 0)
    const explicitEpisodes = Array.isArray(part.episodeNumbers)
      ? part.episodeNumbers.map(Number).filter((episode: number) => Number.isInteger(episode) && episode > 0)
      : null
    const expected = explicitEpisodes || Array.from({ length: count }, (_, episodeIndex) => offset + episodeIndex + 1)
    if (!precise) {
      have[label] = [...groups].sort()
      owned[label] = [...groups].sort()
      sizes[label] = parts.length > 1 ? 0 : Number(local.size || 0)
      offset += count
      continue
    }
    have[label] = episodeEntries
      .filter(([, episodes]) => expected.some((episode) => episodes.has(episode)))
      .map(([group]) => group)
      .sort()
    owned[label] = episodeEntries
      .filter(([, episodes]) => expected.length > 0 && expected.every((episode) => episodes.has(episode)))
      .map(([group]) => group)
      .sort()
    sizes[label] = expected.reduce((total, episode) => total + (episodeSizes.get(episode) || 0), 0)
    offset += count
  }
  const totalExpectedEpisodes = parts.reduce((total, part) => total + Number(part.episodeCount || 0), 0)
  const localSize = Number(local.size || 0)
  // The proportional estimate is only a stand-in for when per-episode file
  // sizes are unavailable. When episode sizes exist, a part summing to zero
  // means it is genuinely unowned, so leave it at zero.
  if (parts.length > 1 && localSize > 0 && totalExpectedEpisodes > 0 && !hasEpisodeSizes) {
    for (const [index, part] of parts.entries()) {
      const label = `Cour ${index + 1}`
      if (!sizes[label]) sizes[label] = localSize * Number(part.episodeCount || 0) / totalExpectedEpisodes
    }
  }
  return { have, owned, sizes, precise }
}

export interface ScanDependencies {
  seadexBest?: typeof seadexBest
  localItems?: typeof localItems
  anilistChain?: typeof anilistChain
  loadCache?: typeof loadCache
  saveLastResults?: typeof saveLastResults
  autoNotifyNew?: typeof autoNotifyNew
}

export async function runScan(config: Config | JsonObject, dependencies: ScanDependencies = {}): Promise<void> {
  const started = Date.now()
  try {
    log('INFO', 'Scan started')
    setState({ running: true, error: null, progress: 0, total: 0, message: 'Loading SeaDex best releases…', results: [], last_run: null })
    const best = await (dependencies.seadexBest || seadexBest)()
    log('INFO', `releases.moe: ${best.size} best-release entries loaded`)
    setState({ message: 'Loading local library…' })
    const items = await (dependencies.localItems || localItems)(config as Config)
    log('INFO', `Local library: ${items.length} item(s) from Sonarr/Radarr`)
    setState({ total: items.length })
    const cache = (dependencies.loadCache || loadCache)()
    const results: JsonObject[] = []
    for (const [itemIndex, item] of items.entries()) {
      setState({ progress: itemIndex, message: `Resolving: ${item.title}` })
      const arrUrl = arrItemUrl(config, item)
      const chain = await (dependencies.anilistChain || anilistChain)(item.title, cache)
      const seasonEntries = Object.entries(item.seasons).map(([season, local]) => [Number(season), local as JsonObject] as const).sort(([a], [b]) => a - b)
      if (!chain.length) {
        log('WARNING', `No AniList match for: ${item.title}`)
        for (const [season, local] of seasonEntries) results.push({
          key: `${item.arr}:item${item.id}:${season}:missing`, group_id: null, arr: item.arr, title: item.title,
          season, status: 'missing', have: [...local.groups].sort(), local_size: local.size || 0,
          best_group: null, best_size: 0, releases: [], url: null, notes: null, image: null,
          banner: null, anilist_id: null, arr_url: arrUrl,
        })
        setState({ progress: itemIndex + 1, results: [...results] })
        continue
      }
      for (const [season, local] of seasonEntries) {
        const localGroups: string[] = local.groups
        setState({ message: `Resolving: ${item.title} (${season ? `S${String(season).padStart(2, '0')}` : 'Movie'})` })
        const entry = season >= 1 && season <= chain.length ? chain[season - 1] : chain[0]
        const alid = entry.id
        const parts = effectiveSeasonParts(local, entryParts(entry))
        const partOwnership = localPartOwnership(local, parts)
        const common: JsonObject = {
          group_id: chain[0].id, arr: item.arr, title: item.title, season, have: [...localGroups].sort(),
          have_by_part: partOwnership.have, owned_by_part: partOwnership.owned, precise_part_ownership: partOwnership.precise,
          local_size_by_part: partOwnership.sizes,
          local_size: local.size || 0, url: null, notes: null, image: entry.cover || null,
          banner: entry.banner || null, anilist_id: alid, arr_url: arrUrl,
        }
        const resolved: JsonObject[] = []
        const sources: JsonObject[] = []
        let missingPart = false; let uncoveredPart = false
        let episodeOffset = 0
        for (const [partIndex, part] of parts.entries()) {
          const currentEpisodeOffset = episodeOffset
          episodeOffset += Number(part.episodeCount || 0)
          const source = best.get(part.id)
          if (!source) { missingPart = true; continue }
          const label = parts.length > 1 ? `Cour ${partIndex + 1}` : null
          sources.push({ label: label || 'releases.moe', url: source.url })
          const slot = seadexSlot(source, season)
          if (!slot) { uncoveredPart = true; continue }
          const [selected, alternatives] = pickBest(slot.candidates, part.episodeCount)
          if (!selected) { uncoveredPart = true; continue }
          resolved.push({
            label,
            source,
            best: scopeReleaseToPart(selected, part.episodeCount, partIndex, parts.length, currentEpisodeOffset),
            alts: alternatives.map((release) => scopeReleaseToPart(release, part.episodeCount, partIndex, parts.length, currentEpisodeOffset)),
          })
        }
        common.urls = sources
        common.anilist_ids = parts.map((part) => part.id)
        common.notes_by_part = Object.fromEntries(resolved.map((part) => [part.label || '', part.source.notes || '-']))
        if (sources.length) {
          common.url = sources[0].url
          const notes = [...new Set(resolved.map((part) => part.source.notes || '-').filter((note) => note !== '-'))]
          common.notes = notes.length ? notes.join('\n') : '-'
        }
        if (missingPart) {
          results.push({ ...common, key: `${item.arr}:${alid}:${season}:missing`, status: 'missing', best_group: null, best_size: 0, releases: [] })
          continue
        }
        if (uncoveredPart || resolved.length !== parts.length) {
          results.push({ ...common, key: `${item.arr}:${alid}:${season}:uncovered`, status: 'uncovered', best_group: null, best_size: 0, releases: [] })
          continue
        }
        const bestGroups = [...new Set(resolved.map((part) => part.best.releaseGroup))]
        let bestGroup = bestGroups.join(' + ')
        let bestSize = resolved.reduce((sum, part) => sum + (part.best.size || 0), 0)
        const localGroupKeys = new Set(localGroups.map((group) => group.toLowerCase()))
        const fullyOwnedByPart = resolved.map((part) => new Set<string>((partOwnership.owned[part.label || ''] || []).map((group) => group.toLowerCase())))
        let ownsAllBest = resolved.every((part, index) => [...partBestGroups(part)].some((group) => fullyOwnedByPart[index].has(group)))
        const commonOwnedGroups = fullyOwnedByPart.length
          ? [...fullyOwnedByPart.slice(1).reduce((commonGroups, groups) => new Set([...commonGroups].filter((group) => groups.has(group))), fullyOwnedByPart[0])]
          : [...localGroupKeys]
        const commonBest = commonBestRelease(resolved, new Set(commonOwnedGroups))
        if (commonBest) { bestGroup = commonBest.releaseGroup; bestSize = commonBest.size || 0; ownsAllBest = true }
        const releases: JsonObject[] = []
        if (ownsAllBest) {
          for (const part of resolved) {
            for (const [kind, release] of orderedPartReleases(commonBest || part.best, part.alts)) {
              if (kind === 'best') releases.push(releaseDict(kind, release, part.label, part.source.url))
            }
          }
          results.push({ ...common, key: `${item.arr}:${alid}:${season}:${bestGroup}`, status: 'best', best_group: bestGroup, best_size: bestSize, releases })
        } else {
          for (const part of resolved) for (const [kind, release] of orderedPartReleases(part.best, part.alts)) releases.push(releaseDict(kind, release, part.label, part.source.url))
          results.push({ ...common, key: `${item.arr}:${alid}:${season}:${bestGroup}`, status: 'upgrade', best_group: bestGroup, best_size: bestSize, releases })
        }
      }
      setState({ progress: itemIndex + 1, results: [...results] })
    }
    const lastRun = timestamp()
    setState({ progress: items.length, message: 'Done', results, last_run: lastRun })
    ;(dependencies.saveLastResults || saveLastResults)(results, lastRun)
    await (dependencies.autoNotifyNew || autoNotifyNew)(config as Config)
    log('INFO', `Scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ${results.length} upgrade(s) found`)
  } catch (error) {
    log('ERROR', `Scan failed: ${errorMessage(error)}`)
    setState({ error: errorMessage(error) })
  } finally {
    setState({ running: false })
  }
}

export async function sendToDiscord(webhook: string, results: JsonObject[]): Promise<number> {
  let sent = 0
  for (const result of results) {
    const title = result.title + (result.season ? `  (S${String(result.season).padStart(2, '0')})` : '')
    const release = result.releases?.[0] || {}
    const message = `${result.arr} · ${title}\n  have : ${(result.have || []).join(', ')}\n  best : ${result.best_group}  (${release.quality || ''}, ${release.tracker || ''})\n  notes: ${result.notes}\n  tags : ${(release.tags || []).join(', ') || '-'}\n  ${result.url}`
    try {
      await fetchWithTimeout(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message.slice(0, 1900) }) }, 30_000)
      sent += 1; await sleep(500)
    } catch (error) { log('ERROR', `Discord webhook failed for ${title}: ${errorMessage(error)}`) }
  }
  if (sent) log('INFO', `Discord: sent ${sent}/${results.length} notification(s)`)
  return sent
}

export async function autoNotifyNew(config: Config): Promise<number> {
  if (!config.notify_enabled || !config.webhook) return 0
  const notified = loadNotified()
  const fresh = scanState.results.filter((result) => result.status === 'upgrade' && result.key && !notified.has(result.key))
  if (!fresh.length) return 0
  const sent = await sendToDiscord(config.webhook, fresh)
  for (const result of fresh) notified.add(result.key)
  saveNotified(notified)
  return sent
}

interface QbSession { cookie: string }
let qbSession: QbSession | null = null
let qbCache: { data: JsonObject[] | null; timestamp: number } = { data: null, timestamp: 0 }
let qbQueue: Promise<void> = Promise.resolve()

/** Per-torrent budget for qBittorrent to fetch magnet metadata. */
export const QB_METADATA_TIMEOUT_MS = 15_000

async function withQbLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = qbQueue
  let release!: () => void
  qbQueue = new Promise<void>((done) => { release = done })
  await previous
  try { return await operation() } finally { release() }
}

async function qbLogin(base: string, user: string, password: string): Promise<QbSession> {
  const response = await fetchWithTimeout(`${base}/api/v2/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password }),
  }, 30_000)
  const text = await response.text()
  if (response.status === 204 || (response.status === 200 && text.includes('Ok'))) {
    return { cookie: (response.headers.get('set-cookie') || '').split(';', 1)[0] }
  }
  throw new Error(`qBittorrent login failed (HTTP ${response.status})`)
}

export async function testIntegration(config: Config, service: string): Promise<string> {
  if (service === 'sonarr' || service === 'radarr') {
    const base = arrApiUrl(config[`${service}_url`])
    const key = String(config[`${service}_key`] || '')
    if (!base || !key) throw new Error(`${service === 'sonarr' ? 'Sonarr' : 'Radarr'} URL and API key are required`)
    const status = await api(`${base}/system/status`, key)
    const name = String(status.appName || status.instanceName || (service === 'sonarr' ? 'Sonarr' : 'Radarr'))
    const version = status.version ? ` ${status.version}` : ''
    return `Connected to ${name}${version}`
  }
  if (service === 'qbittorrent') {
    const base = String(config.qbittorrent_url || '').replace(/\/+$/, '')
    if (!base || !config.qbittorrent_user || !config.qbittorrent_pass) throw new Error('qBittorrent URL, username and password are required')
    await qbLogin(base, config.qbittorrent_user, config.qbittorrent_pass)
    return 'Connected to qBittorrent'
  }
  if (service === 'discord') {
    if (!config.webhook) throw new Error('Discord webhook URL is required')
    const response = await fetchWithTimeout(config.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '✅ SeaDex Companion connection test successful.' }),
    }, 30_000)
    if (!response.ok) throw new Error(`Discord rejected the test message (HTTP ${response.status})`)
    return 'Test message sent to Discord'
  }
  throw new Error('Unknown integration')
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = (error as { name?: string }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return /abort|timed out|timeout/i.test(error.message)
}

async function qbRequest(config: Config, path: string, init: RequestInit = {}, retry = true, timeout = 30_000): Promise<Response> {
  const base = config.qbittorrent_url.replace(/\/$/, '')
  if (!base) throw new Error('qBittorrent is not configured (Config tab)')
  qbSession ||= await qbLogin(base, config.qbittorrent_user, config.qbittorrent_pass)
  const headers = new Headers(init.headers); if (qbSession.cookie) headers.set('Cookie', qbSession.cookie)
  const response = await fetchWithTimeout(`${base}${path}`, { ...init, headers }, timeout)
  if (response.status === 403 && retry) { qbSession = await qbLogin(base, config.qbittorrent_user, config.qbittorrent_pass); return qbRequest(config, path, init, false, timeout) }
  return response
}

function magnetInfoHash(magnet: string): string | null {
  const hash = magnet.match(/(?:[?&]xt=urn:btih:)([0-9a-f]{40})(?:&|$)/i)?.[1]
  return hash ? hash.toLowerCase() : null
}

function normalizedTorrentPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').toLowerCase()
}

async function qbPostWithFallback(config: Config, paths: string[], body: URLSearchParams): Promise<void> {
  let lastError = ''
  for (const [index, path] of paths.entries()) {
    const response = await qbRequest(config, path, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    })
    const text = await response.text()
    if (response.status === 200) return
    lastError = `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`
    if (index === paths.length - 1 || (response.status !== 404 && response.status !== 405)) break
  }
  throw new Error(`qBittorrent request failed (${lastError})`)
}

async function qbSelectTorrentFiles(config: Config, hash: string, selectedFiles: string[], timeoutMs = QB_METADATA_TIMEOUT_MS): Promise<void> {
  const stateBody = new URLSearchParams({ hashes: hash })
  // Magnet metadata is exchanged only while the torrent is running. Start it,
  // poll for the file list until the per-torrent metadata budget runs out,
  // then stop it before changing any priorities so the final download
  // contains only the requested cour.
  await qbPostWithFallback(config, ['/api/v2/torrents/start', '/api/v2/torrents/resume'], stateBody)
  let files: JsonObject[] | null = null
  const metadataDeadline = Date.now() + timeoutMs
  try {
    while (Date.now() < metadataDeadline) {
      try {
        const response = await qbRequest(config, `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`, {}, true, Math.max(1_000, Math.min(5_000, metadataDeadline - Date.now())))
        const text = await response.text()
        if (response.status === 200) {
          const parsed = JSON.parse(text) as JsonObject[]
          if (parsed.length) { files = parsed; break }
        } else if (response.status !== 404 && response.status !== 409) {
          throw new Error(`Could not load torrent files (HTTP ${response.status}: ${text.slice(0, 120)})`)
        }
      } catch (error) {
        // A single request that blew its time slice is retried while budget
        // remains (the loop condition stops the polling); anything else is a
        // hard failure that aborts this torrent.
        if (!isTimeoutLikeError(error)) throw error
      }
      await sleep(100)
    }
  } catch (error) {
    try { await qbPostWithFallback(config, ['/api/v2/torrents/stop', '/api/v2/torrents/pause'], stateBody) } catch { /* preserve the metadata error */ }
    throw error
  }
  if (!files) {
    // The metadata never arrived within the budget. Remove the torrent from
    // qBittorrent (preserving files, though normally none exist yet) and
    // report that metadata fetching failed.
    try {
      await qbPostWithFallback(config, ['/api/v2/torrents/delete'], new URLSearchParams({ hashes: hash, deleteFiles: 'false' }))
    } catch (removeError) {
      log('WARNING', `Could not remove torrent ${hash} from qBittorrent after the metadata timeout: ${errorMessage(removeError)}`)
    }
    qbCache = { data: null, timestamp: 0 }
    throw new Error(`Metadata fetching failed: qBittorrent did not load the torrent metadata within ${Math.ceil(timeoutMs / 1000)} seconds`)
  }
  await qbPostWithFallback(config, ['/api/v2/torrents/stop', '/api/v2/torrents/pause'], stateBody)

  const wanted = new Set(selectedFiles.map(normalizedTorrentPath).filter(Boolean))
  const indexedFiles = files.map((file, index) => ({ file, index }))
  let selected = indexedFiles.filter(({ file }) => wanted.has(normalizedTorrentPath(file.name)))
  if (!selected.length) {
    selected = indexedFiles.filter(({ file }) => {
      const path = normalizedTorrentPath(file.name)
      return [...wanted].some((wantedPath) => path.endsWith(`/${wantedPath}`) || wantedPath.endsWith(`/${path}`))
    })
  }
  if (!selected.length) throw new Error('The selected cour files could not be matched in qBittorrent; the torrent was left stopped')

  const allIds = files.map((file, index) => String(file.index ?? index)).join('|')
  const selectedIds = selected.map(({ file, index }) => String(file.index ?? index)).join('|')
  await qbPostWithFallback(config, ['/api/v2/torrents/filePrio'], new URLSearchParams({ hash, id: allIds, priority: '0' }))
  await qbPostWithFallback(config, ['/api/v2/torrents/filePrio'], new URLSearchParams({ hash, id: selectedIds, priority: '1' }))
  await qbPostWithFallback(config, ['/api/v2/torrents/start', '/api/v2/torrents/resume'], stateBody)
}

export async function qbAddTorrent(config: Config, magnet: string, category?: string, selectedFiles: string[] = [], timeoutMs = QB_METADATA_TIMEOUT_MS): Promise<void> {
  return withQbLock(async () => {
    const body = new URLSearchParams({ urls: magnet }); if (category) body.set('category', category)
    if (selectedFiles.length) { body.set('paused', 'true'); body.set('stopped', 'true') }
    const response = await qbRequest(config, '/api/v2/torrents/add', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    const text = await response.text()
    if (response.status === 200) {
      let accepted = text.includes('Ok')
      if (!accepted) {
        try { const data = JSON.parse(text); accepted = data.success_count > 0 || Boolean(data.added_torrent_ids?.length) } catch { /* handled below */ }
      }
      if (accepted) {
        const hash = magnetInfoHash(magnet)
        if (selectedFiles.length && !hash) throw new Error('Cannot select torrent files without a v1 info hash')
        if (selectedFiles.length) await qbSelectTorrentFiles(config, hash!, selectedFiles, timeoutMs)
        qbCache = { data: null, timestamp: 0 }
        return
      }
    }
    throw new Error(`qBittorrent rejected the torrent (HTTP ${response.status}: ${text.slice(0, 120)})`)
  })
}

export interface QbBulkAddEntry {
  hash: string
  label: string
  category?: string
  selectedFiles?: string[]
  timeoutMs?: number
}

export interface QbBulkAddFailure {
  hash: string
  label: string
  error: string
}

export interface QbBulkAddOutcome {
  added: string[]
  failures: QbBulkAddFailure[]
}

export interface QbBulkAddOptions {
  /**
   * Invoked once per torrent as soon as it settles (added or failed), so the
   * caller can surface per-torrent progress (green/red rows) in real time
   * instead of waiting for the whole batch to finish. `error` is null when the
   * torrent was added successfully.
   */
  onSettle?: (hash: string, error: string | null) => void
}

/**
 * Adds every torrent individually and swallows per-torrent errors so a single
 * failure (for example a metadata timeout) never prevents the remaining
 * torrents from being added. Failures are returned so the caller can report
 * them to the user.
 */
export async function qbBulkAddTorrents(config: Config, entries: QbBulkAddEntry[], options: QbBulkAddOptions = {}): Promise<QbBulkAddOutcome> {
  const { onSettle } = options
  const added: string[] = []
  const failures: QbBulkAddFailure[] = []
  for (const entry of entries) {
    let error: string | null = null
    try {
      await qbAddTorrent(config, `magnet:?xt=urn:btih:${entry.hash}`, entry.category, entry.selectedFiles || [], entry.timeoutMs)
      added.push(entry.hash)
    } catch (caught) {
      error = errorMessage(caught)
      failures.push({ hash: entry.hash, label: entry.label, error })
      log('ERROR', `Bulk download failed for ${entry.label} (${entry.hash}): ${error}`)
    }
    onSettle?.(entry.hash, error)
  }
  return { added, failures }
}

// ---------------------------------------------------------------------------
// Bulk download batch status
//
// Live per-torrent state of the in-flight bulk download batch, so the UI can
// poll it and color each title as soon as its own torrent settles instead of
// only once every torrent in the batch has been processed.
// ---------------------------------------------------------------------------
export interface BulkBatchFailure {
  hash: string
  label: string
  error: string
}

export interface BulkDownloadBatchStatus {
  finished: boolean
  pending: string[]
  added: string[]
  failures: BulkBatchFailure[]
}

const bulkBatch: BulkDownloadBatchStatus = { finished: true, pending: [], added: [], failures: [] }

export function resetBulkDownloadBatch(hashes: string[]): BulkDownloadBatchStatus {
  const normalized = new Set(hashes.map((hash) => hash.toLowerCase()).filter((hash) => /^[0-9a-f]{40}$/.test(hash)))
  bulkBatch.finished = false
  bulkBatch.pending = [...normalized]
  bulkBatch.added = []
  bulkBatch.failures = []
  return bulkDownloadBatchStatus()
}

export function settleBulkDownloadBatch(hash: string, label: string, error: string | null): void {
  const normalized = hash.toLowerCase()
  const pendingIndex = bulkBatch.pending.indexOf(normalized)
  if (pendingIndex !== -1) bulkBatch.pending.splice(pendingIndex, 1)
  if (error) {
    if (!bulkBatch.failures.some((failure) => failure.hash === normalized)) bulkBatch.failures.push({ hash: normalized, label, error })
  } else if (!bulkBatch.added.includes(normalized)) {
    bulkBatch.added.push(normalized)
  }
}

export function finishBulkDownloadBatch(): BulkDownloadBatchStatus {
  bulkBatch.finished = true
  bulkBatch.pending = []
  return bulkDownloadBatchStatus()
}

export function bulkDownloadBatchStatus(): BulkDownloadBatchStatus {
  return { finished: bulkBatch.finished, pending: [...bulkBatch.pending], added: [...bulkBatch.added], failures: [...bulkBatch.failures] }
}

export async function qbGetTorrents(config: Config, hashes?: string[]): Promise<JsonObject[]> {
  return withQbLock(async () => {
    let torrents = qbCache.data
    if (!torrents || Date.now() - qbCache.timestamp >= 2000) {
      const response = await qbRequest(config, '/api/v2/torrents/info')
      const text = await response.text()
      if (response.status !== 200) throw new Error(`qBittorrent error (HTTP ${response.status}: ${text.slice(0, 120)})`)
      const parsed = JSON.parse(text) as JsonObject[]
      torrents = parsed; qbCache = { data: parsed, timestamp: Date.now() }
    }
    const available = torrents || []
    if (!hashes) return available
    const wanted = new Set(hashes.map((hash) => hash.toLowerCase()))
    return available.filter((torrent) => wanted.has(String(torrent.hash || '').toLowerCase()))
  })
}

export type QbTorrentAction = 'pause' | 'resume' | 'remove'

export async function qbControlTorrents(
  config: Config,
  hashes: string[],
  action: QbTorrentAction,
  deleteFiles = false,
): Promise<void> {
  const validHashes = [...new Set(hashes.map((hash) => hash.toLowerCase()).filter((hash) => /^[0-9a-f]{40}$/.test(hash)))]
  if (!validHashes.length) throw new Error('No valid torrent hashes provided')

  return withQbLock(async () => {
    const body = new URLSearchParams({ hashes: validHashes.join('|') })
    let paths: string[]
    if (action === 'pause') paths = ['/api/v2/torrents/stop', '/api/v2/torrents/pause']
    else if (action === 'resume') paths = ['/api/v2/torrents/start', '/api/v2/torrents/resume']
    else {
      paths = ['/api/v2/torrents/delete']
      body.set('deleteFiles', String(deleteFiles))
    }

    let lastError = ''
    for (let index = 0; index < paths.length; index++) {
      const response = await qbRequest(config, paths[index], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const text = await response.text()
      if (response.status === 200) {
        qbCache = { data: null, timestamp: 0 }
        return
      }
      lastError = `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`
      if (index === paths.length - 1 || (response.status !== 404 && response.status !== 405)) break
    }
    throw new Error(`qBittorrent rejected the ${action} request (${lastError})`)
  })
}

// ---------------------------------------------------------------------------
// Ownership ledger
//
// Tracks the info hashes of torrents that SeaDex Companion itself added to
// qBittorrent, so bulk cancellation can only ever cancel/remove torrents the
// app created — never torrents the user added manually.
// ---------------------------------------------------------------------------
function normalizeInfoHash(value: unknown): string | null {
  const hash = String(value || '').toLowerCase()
  return /^[0-9a-f]{40}$/.test(hash) ? hash : null
}

const ownedTorrents = new Set<string>(readJson<string[]>(OWNED_TORRENTS_FILE, []))

export function saveOwnedTorrents(): void {
  writeJsonAtomic(OWNED_TORRENTS_FILE, [...ownedTorrents].sort())
}

export function recordOwnedTorrents(hashes: string[]): void {
  let changed = false
  for (const hash of hashes) {
    const normalized = normalizeInfoHash(hash)
    if (normalized && !ownedTorrents.has(normalized)) {
      ownedTorrents.add(normalized)
      changed = true
    }
  }
  if (changed) saveOwnedTorrents()
}

export function forgetOwnedTorrents(hashes: string[]): void {
  let changed = false
  for (const hash of hashes) {
    const normalized = normalizeInfoHash(hash)
    if (normalized && ownedTorrents.delete(normalized)) changed = true
  }
  if (changed) saveOwnedTorrents()
}

export function ownedTorrentsSnapshot(): string[] {
  return [...ownedTorrents].sort()
}

export function normalizeQbStates(states: string[]): string {
  if (!states.length) return 'unknown'
  if (states.some((state) => ['error', 'unknown'].includes(state))) return 'error'
  const downloading = new Set(['downloading', 'forcedDL', 'metaDL', 'queuedDL', 'stalledDL', 'checkingDL', 'allocating', 'checkingResumeData'])
  const uploading = new Set(['uploading', 'forcedUP', 'queuedUP', 'stalledUP'])
  const paused = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'])
  if (states.every((state) => uploading.has(state))) return 'complete'
  if (states.some((state) => downloading.has(state))) return 'downloading'
  if (states.every((state) => paused.has(state))) return 'paused'
  return 'unknown'
}

export interface BulkDownloadTarget {
  key: string
  release: number
  arr: string
  part: string
  hashes: string[]
  selectedFiles?: string[]
}

export function bulkDownloadTargets(results: JsonObject[] = resultsForRequest()): BulkDownloadTarget[] {
  const targets: BulkDownloadTarget[] = []
  for (const result of results) {
    if (result.status !== 'upgrade' || !result.key) continue
    for (const [releaseIndex, release] of (result.releases || []).entries()) {
      if (release.kind !== 'best' || !release.downloadable) continue
      const hashes = [...new Set<string>(
        (release.info_hashes || [])
          .map((hash: unknown) => String(hash).toLowerCase())
          .filter((hash: string) => /^[0-9a-f]{40}$/.test(hash)),
      )]
    if (hashes.length) targets.push({
      key: String(result.key), release: releaseIndex, arr: String(result.arr || ''), part: String(release.part || ''), hashes,
      ...(release.selected_files?.length ? { selectedFiles: [...release.selected_files] } : {}),
    })
    }
  }
  return targets
}

export interface BulkCancelInfo {
  key: string
  release: number
  title: string
  season: number | null
  part: string
  releaseGroup: string
  tracker: string
  size: number
}

export interface ResultReleaseIndex {
  byHash: Map<string, BulkCancelInfo>
  byTarget: Map<string, Set<string>>
}

/**
 * Indexes every valid info hash in the current scan results so a qBittorrent
 * torrent can be mapped back to the release that created it. `byTarget` also
 * lets bulk cancellation resolve a (key, release) selection to its hashes.
 */
export function indexResultReleases(results: JsonObject[] = resultsForRequest()): ResultReleaseIndex {
  const byHash = new Map<string, BulkCancelInfo>()
  const byTarget = new Map<string, Set<string>>()
  for (const result of results) {
    if (!result.key) continue
    const key = String(result.key)
    const season = result.season == null ? null : Number(result.season)
    for (const [releaseIndex, release] of (result.releases || []).entries()) {
      const targetKey = `${key}\0${releaseIndex}`
      const info: BulkCancelInfo = {
        key,
        release: releaseIndex,
        title: String(result.title || ''),
        season,
        part: String(release.part || ''),
        releaseGroup: String(release.releaseGroup || ''),
        tracker: String(release.tracker || ''),
        size: Number(release.size || 0),
      }
      for (const raw of (release.info_hashes || [])) {
        const hash = String(raw).toLowerCase()
        if (!/^[0-9a-f]{40}$/.test(hash)) continue
        byHash.set(hash, info)
        if (!byTarget.has(targetKey)) byTarget.set(targetKey, new Set())
        byTarget.get(targetKey)!.add(hash)
      }
    }
  }
  return { byHash, byTarget }
}

export function resultsForRequest(): JsonObject[] {
  return scanState.results.length ? scanState.results : (loadLastResults()?.results || [])
}

export function resetRuntimeForTests(): void {
  Object.assign(scanState, { running: false, progress: 0, total: 0, message: 'Idle', results: [], error: null, last_run: null })
  qbSession = null; qbCache = { data: null, timestamp: 0 }; qbQueue = Promise.resolve(); ownedTorrents.clear()
  bulkBatch.finished = true; bulkBatch.pending = []; bulkBatch.added = []; bulkBatch.failures = []
}
