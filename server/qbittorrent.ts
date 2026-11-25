import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { normalizeTorrentPath } from '../shared/download-plan.js'
import { fetchWithTimeout, sleep } from './http.js'
import { errorMessage } from '../shared/errors.js'
import type { Config, JsonObject } from './types.js'

interface QbSession {
  cookie: string
}
interface QbConnection {
  session: Promise<QbSession> | null
  cache: { data: JsonObject[]; timestamp: number } | null
  pending: Promise<JsonObject[]> | null
  revision: number
  locks: Map<string, Promise<void>>
}
const connections = new Map<string, QbConnection>()
const endpointLocks = new Map<string, Map<string, Promise<void>>>()
const qbBaseUrl = (config: Config): string => String(config.qbittorrent_url || '').replace(/\/+$/, '')

function connectionFor(config: Config): QbConnection {
  const base = qbBaseUrl(config)
  const key = JSON.stringify([base, config.qbittorrent_user, config.qbittorrent_pass])
  let connection = connections.get(key)
  if (!connection) {
    const locks = endpointLocks.get(base) || new Map<string, Promise<void>>()
    endpointLocks.set(base, locks)
    connection = { session: null, cache: null, pending: null, revision: 0, locks }
    connections.set(key, connection)
  }
  return connection
}
function invalidateQbCache(config: Config): void {
  const connection = connectionFor(config)
  connection.cache = null
  connection.pending = null
  connection.revision += 1
}
const QB_METADATA_TIMEOUT_MS = 15_000

async function withTorrentLocks<T>(config: Config, hashes: string[], operation: () => Promise<T>): Promise<T> {
  const locks = connectionFor(config).locks
  const unlock: (() => void)[] = []
  try {
    for (const hash of [...new Set(hashes)].sort()) {
      const previous = locks.get(hash) || Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(done => {
        release = done
      })
      locks.set(hash, current)
      await previous
      unlock.push(() => {
        release()
        if (locks.get(hash) === current) locks.delete(hash)
      })
    }
    return await operation()
  } finally {
    for (const release of unlock.reverse()) release()
  }
}

function qbCookies(headers: Headers, previous = ''): string {
  const cookies = new Map<string, string>()
  // Read Set-Cookie individually; Expires attributes can contain commas.
  for (const value of [...previous.split(';'), ...headers.getSetCookie()]) {
    const pair = value.split(';', 1)[0].trim()
    const separator = pair.indexOf('=')
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function qbLogin(base: string, user: string, password: string): Promise<QbSession> {
  const response = await fetchWithTimeout(
    `${base}/api/v2/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user, password }),
    },
    30_000,
  )
  const text = await response.text()
  if (response.status === 204 || (response.status === 200 && text.trim() === 'Ok.')) {
    return { cookie: qbCookies(response.headers) }
  }
  throw new Error(`qBittorrent login failed (HTTP ${response.status})`)
}

export async function qbTestConnection(config: Config): Promise<void> {
  const base = qbBaseUrl(config)
  if (!base || !config.qbittorrent_user || !config.qbittorrent_pass)
    throw new Error('qBittorrent URL, username and password are required')
  await qbLogin(base, config.qbittorrent_user, config.qbittorrent_pass)
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = (error as { name?: string }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return /abort|timed out|timeout/i.test(error.message)
}

interface QbRequestOptions {
  timeoutMs?: number
  /** Called once the request is about to leave, so a later failure is known to be ambiguous. */
  onDispatch?: () => void
  /** A 403 means the session expired: sign in again and retry once. */
  retryExpiredSession?: boolean
}

async function qbRequest(
  config: Config,
  path: string,
  init: RequestInit = {},
  options: QbRequestOptions = {},
): Promise<Response> {
  const { timeoutMs = 30_000, onDispatch, retryExpiredSession = true } = options
  const base = qbBaseUrl(config)
  if (!base) throw new Error('qBittorrent is not configured (Config tab)')
  const connection = connectionFor(config)
  const login = () => {
    const pending = qbLogin(base, config.qbittorrent_user, config.qbittorrent_pass).catch(error => {
      if (connection.session === pending) connection.session = null
      throw error
    })
    return pending
  }
  connection.session ||= login()
  const sessionPromise = connection.session
  const session = await sessionPromise
  let cookie = session.cookie
  const headers = new Headers(init.headers)
  if (cookie) headers.set('Cookie', cookie)
  onDispatch?.()
  const response = await fetchWithTimeout(`${base}${path}`, { ...init, headers }, timeoutMs)
  // Authentication bypass can replace an expired session on a successful response.
  // A delayed response must not overwrite cookies adopted by a newer request.
  if (connection.session === sessionPromise && session.cookie === cookie) {
    cookie = session.cookie = qbCookies(response.headers, cookie)
  }
  if (response.status === 403 && retryExpiredSession) {
    await response.body?.cancel()
    if (connection.session === sessionPromise && session.cookie === cookie) connection.session = login()
    return qbRequest(config, path, init, { ...options, retryExpiredSession: false })
  }
  return response
}

function magnetInfoHash(magnet: string): string | null {
  const hash = magnet.match(/(?:[?&]xt=urn:btih:)([0-9a-f]{40})(?:&|$)/i)?.[1]
  return hash ? hash.toLowerCase() : null
}

const normalizedTorrentPath = (value: unknown) => normalizeTorrentPath(String(value || ''))

async function qbPostWithFallback(config: Config, paths: string[], body: URLSearchParams): Promise<void> {
  let lastError = ''
  for (const [index, path] of paths.entries()) {
    const response = await qbRequest(config, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await response.text()
    if (response.status === 200) return
    lastError = `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`
    if (index === paths.length - 1 || (response.status !== 404 && response.status !== 405)) break
  }
  throw new Error(`qBittorrent request failed (${lastError})`)
}

async function qbTorrentExists(config: Config, hash: string): Promise<boolean> {
  const response = await qbRequest(config, `/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`)
  const text = await response.text()
  if (response.status !== 200)
    throw new Error(`Could not check existing torrents (HTTP ${response.status}: ${text.slice(0, 120)})`)
  let torrents: JsonObject[]
  try {
    torrents = JSON.parse(text) as JsonObject[]
  } catch {
    throw new Error('qBittorrent returned an invalid existing-torrents response')
  }
  return torrents.some(torrent => String(torrent.hash || '').toLowerCase() === hash)
}

async function qbSelectTorrentFiles(
  config: Config,
  hash: string,
  selectedFiles: string[],
  timeoutMs = QB_METADATA_TIMEOUT_MS,
): Promise<void> {
  const stateBody = new URLSearchParams({ hashes: hash })
  // Magnet metadata is exchanged only while the torrent is running. Start it,
  // poll for the file list until the per-torrent metadata budget runs out,
  // then stop it before changing any priorities so the final download
  // contains only the requested cour.
  await qbPostWithFallback(config, ['/api/v2/torrents/start', '/api/v2/torrents/resume'], stateBody)
  let files: JsonObject[] | null = null
  const metadataDeadline = Date.now() + timeoutMs
  try {
    // The file list is polled with exponential backoff (100ms → 2s) instead of a
    // fixed 100ms so we stop hammering qBittorrent once the metadata clearly
    // needs more time to arrive, while staying responsive when it does.
    let pollDelay = 100
    while (Date.now() < metadataDeadline) {
      try {
        const response = await qbRequest(
          config,
          `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`,
          {},
          { timeoutMs: Math.max(1_000, Math.min(5_000, metadataDeadline - Date.now())) },
        )
        const text = await response.text()
        if (response.status === 200) {
          const parsed = JSON.parse(text) as JsonObject[]
          if (parsed.length) {
            files = parsed
            break
          }
        } else if (response.status !== 404 && response.status !== 409) {
          throw new Error(`Could not load torrent files (HTTP ${response.status}: ${text.slice(0, 120)})`)
        }
      } catch (error) {
        // A single request that blew its time slice is retried while budget
        // remains (the loop condition stops the polling); anything else is a
        // hard failure that aborts this torrent.
        if (!isTimeoutLikeError(error)) throw error
      }
      await sleep(pollDelay)
      pollDelay = Math.min(pollDelay * 2, 2000)
    }
  } catch (error) {
    try {
      await qbPostWithFallback(config, ['/api/v2/torrents/stop', '/api/v2/torrents/pause'], stateBody)
    } catch {
      /* preserve the metadata error */
    }
    throw error
  }
  if (!files)
    throw new Error(
      `Metadata fetching failed: qBittorrent did not load the torrent metadata within ${Math.ceil(timeoutMs / 1000)} seconds`,
    )
  await qbPostWithFallback(config, ['/api/v2/torrents/stop', '/api/v2/torrents/pause'], stateBody)

  const wanted = new Set(selectedFiles.map(normalizedTorrentPath).filter(Boolean))
  const indexedFiles = files.map((file, index) => ({ file, index }))
  let selected = indexedFiles.filter(({ file }) => wanted.has(normalizedTorrentPath(file.name)))
  if (!selected.length) {
    selected = indexedFiles.filter(({ file }) => {
      const path = normalizedTorrentPath(file.name)
      return [...wanted].some(wantedPath => path.endsWith(`/${wantedPath}`) || wantedPath.endsWith(`/${path}`))
    })
  }
  if (!selected.length) throw new Error('The selected cour files could not be matched in qBittorrent')

  const allIds = files.map((file, index) => String(file.index ?? index)).join('|')
  const selectedIds = selected.map(({ file, index }) => String(file.index ?? index)).join('|')
  await qbPostWithFallback(
    config,
    ['/api/v2/torrents/filePrio'],
    new URLSearchParams({ hash, id: allIds, priority: '0' }),
  )
  await qbPostWithFallback(
    config,
    ['/api/v2/torrents/filePrio'],
    new URLSearchParams({ hash, id: selectedIds, priority: '1' }),
  )
  await qbPostWithFallback(config, ['/api/v2/torrents/start', '/api/v2/torrents/resume'], stateBody)
}

export interface QbOwnershipHooks {
  record: (hash: string) => void
  forget: (hash: string) => void
}

export class QbittorrentAmbiguousError extends Error {}

export async function qbAddTorrent(
  config: Config,
  magnet: string,
  category?: string,
  selectedFiles: string[] = [],
  timeoutMs = QB_METADATA_TIMEOUT_MS,
  ownership?: QbOwnershipHooks,
): Promise<void> {
  return withTorrentLocks(config, [magnetInfoHash(magnet) || magnet], async () => {
    const hash = magnetInfoHash(magnet)
    if (selectedFiles.length && !hash) throw new Error('Cannot select torrent files without a v1 info hash')
    if (hash && (await qbTorrentExists(config, hash)))
      throw new Error('Torrent already exists in qBittorrent and was not marked as app-owned')
    const body = new URLSearchParams({ urls: magnet })
    if (category) body.set('category', category)
    if (selectedFiles.length) {
      body.set('paused', 'true')
      body.set('stopped', 'true')
    }
    let dispatched = false
    let response: Response
    try {
      response = await qbRequest(
        config,
        '/api/v2/torrents/add',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
        {
          onDispatch: () => {
            dispatched = true
          },
        },
      )
    } catch (error) {
      if (dispatched)
        throw new QbittorrentAmbiguousError(`qBittorrent submission status is unknown: ${errorMessage(error)}`)
      throw error
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (response.status === 200)
        throw new QbittorrentAmbiguousError(`qBittorrent submission response could not be read: ${errorMessage(error)}`)
      throw new Error(`qBittorrent rejected the torrent (HTTP ${response.status}: ${errorMessage(error)})`)
    }
    if (response.status === 200) {
      let accepted = text.trim() === 'Ok.'
      let rejected = text.trim() === 'Fails.'
      if (!accepted && !rejected) {
        try {
          const data = JSON.parse(text)
          accepted =
            Number(data?.success_count) > 0 ||
            (Array.isArray(data?.added_torrent_ids) && data.added_torrent_ids.length > 0)
          rejected =
            data?.success_count === 0 || (Array.isArray(data?.added_torrent_ids) && data.added_torrent_ids.length === 0)
        } catch {
          /* Unknown responses retain duplicate protection below. */
        }
      }
      if (!accepted && !rejected)
        throw new QbittorrentAmbiguousError('qBittorrent did not confirm whether it accepted the torrent')
      if (accepted) {
        try {
          if (hash) ownership?.record(hash)
          if (selectedFiles.length) await qbSelectTorrentFiles(config, hash!, selectedFiles, timeoutMs)
        } catch (error) {
          if (!hash) throw error
          try {
            await qbPostWithFallback(
              config,
              ['/api/v2/torrents/delete'],
              new URLSearchParams({ hashes: hash, deleteFiles: 'false' }),
            )
            if ((await qbGetTorrents(config, [hash], true)).length)
              throw new Error('qBittorrent did not confirm removal; the torrent is still present')
            ownership?.forget(hash)
          } catch (cleanupError) {
            throw new QbittorrentAmbiguousError(
              `${errorMessage(error)}; cleanup failed and the torrent may remain in qBittorrent: ${errorMessage(cleanupError)}`,
            )
          } finally {
            invalidateQbCache(config)
          }
          throw error
        }
        invalidateQbCache(config)
        return
      }
    }
    throw new Error(`qBittorrent rejected the torrent (HTTP ${response.status}: ${text.slice(0, 120)})`)
  })
}

/** Fresh reads of up to this many hashes ask qBittorrent for those torrents only; this keeps the URL short. */
const QB_HASH_FILTER_LIMIT = 100

async function qbTorrentList(config: Config, query = ''): Promise<JsonObject[]> {
  const response = await qbRequest(config, `/api/v2/torrents/info${query}`)
  const text = await response.text()
  if (response.status !== 200) throw new Error(`qBittorrent error (HTTP ${response.status}: ${text.slice(0, 120)})`)
  const parsed: unknown = JSON.parse(text)
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      torrent =>
        !torrent ||
        typeof torrent !== 'object' ||
        typeof torrent.hash !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(torrent.hash),
    )
  )
    throw new Error('qBittorrent returned an invalid torrent list')
  return parsed as JsonObject[]
}

/**
 * A fresh read of the named torrents. Progress polls track a few torrents, and a client seeding thousands would
 * otherwise send its whole list every few seconds, so small sets are filtered by qBittorrent itself.
 */
export async function qbReadTorrents(config: Config, hashes: string[]): Promise<JsonObject[]> {
  const wanted = new Set(hashes.map(hash => hash.toLowerCase()))
  if (wanted.size > QB_HASH_FILTER_LIMIT) return qbGetTorrents(config, hashes, true)
  if (!wanted.size) return []
  const torrents = await qbTorrentList(config, `?hashes=${[...wanted].map(encodeURIComponent).join('|')}`)
  return torrents.filter(torrent => wanted.has(String(torrent.hash || '').toLowerCase()))
}

export async function qbGetTorrents(config: Config, hashes?: string[], fresh = false): Promise<JsonObject[]> {
  if (fresh) invalidateQbCache(config)
  const connection = connectionFor(config)
  let torrents = connection.cache && Date.now() - connection.cache.timestamp < 2000 ? connection.cache.data : null
  if (!torrents) {
    if (!connection.pending) {
      const revision = connection.revision
      const pending = (async () => {
        const parsed = await qbTorrentList(config)
        if (revision === connection.revision) connection.cache = { data: parsed, timestamp: Date.now() }
        return parsed
      })().finally(() => {
        if (connection.pending === pending) connection.pending = null
      })
      connection.pending = pending
    }
    torrents = await connection.pending
  }
  if (!hashes) return torrents
  const wanted = new Set(hashes.map(hash => hash.toLowerCase()))
  return torrents.filter(torrent => wanted.has(String(torrent.hash || '').toLowerCase()))
}

export interface QbStorageLocation {
  category: string
  path: string | null
  free_bytes: number | null
  reason?: string
}

/** Read space on qBittorrent's host, never on the Companion container's filesystem. */
export async function qbGetDownloadStorage(config: Config, categories: string[]): Promise<QbStorageLocation[]> {
  if (!categories.length) return []
  const read = async (path: string): Promise<JsonObject> => {
    const response = await qbRequest(config, path, {}, { timeoutMs: 5_000 })
    if (!response.ok) throw new Error(`qBittorrent storage check returned HTTP ${response.status}`)
    return (await response.json()) as JsonObject
  }
  let preferences: JsonObject
  let categoryPaths: JsonObject = {}
  let defaultFree: number | null = null
  const bytes = (value: unknown): number | null => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }
  try {
    preferences = await read('/api/v2/app/preferences')
  } catch {
    return categories.map(category => ({
      category,
      path: null,
      free_bytes: null,
      reason: 'Could not read qBittorrent download paths.',
    }))
  }
  if (typeof preferences.auto_tmm_enabled !== 'boolean')
    return categories.map(category => ({
      category,
      path: null,
      free_bytes: null,
      reason: 'Could not determine qBittorrent save-path settings.',
    }))
  try {
    defaultFree = bytes((await read('/api/v2/sync/maindata?rid=0')).server_state?.free_space_on_disk)
  } catch {
    /* optional on older clients */
  }
  const usesCategoryPaths =
    preferences.auto_tmm_enabled === true || preferences.use_category_paths_in_manual_mode === true
  if (usesCategoryPaths && categories.some(Boolean)) {
    try {
      categoryPaths = await read('/api/v2/torrents/categories')
    } catch {
      return categories.map(category => ({
        category,
        path: null,
        free_bytes: null,
        reason: 'Could not read qBittorrent category paths.',
      }))
    }
  }
  const locations: QbStorageLocation[] = []
  for (const category of categories) {
    let savePath = String(preferences.save_path || '')
    if (usesCategoryPaths && category) {
      const settings = categoryPaths[category]
      // Subcategories and custom category download directories need settings
      // unavailable on some clients. Do not claim the default disk is theirs.
      if (!settings || settings.downloadPath?.enabled) {
        locations.push({
          category,
          path: null,
          free_bytes: null,
          reason: 'The category download path could not be determined.',
        })
        continue
      }
      const categoryPath = String(settings.savePath || '')
      if (categoryPath) {
        if (categoryPath.startsWith('/') || /^[a-z]:[\\/]/i.test(categoryPath) || categoryPath.startsWith('\\\\'))
          savePath = categoryPath
        else {
          locations.push({
            category,
            path: null,
            free_bytes: null,
            reason: 'Relative category paths cannot be checked reliably.',
          })
          continue
        }
      }
    }
    const paths = [savePath, ...(preferences.temp_path_enabled ? [String(preferences.temp_path || '')] : [])]
    for (const path of new Set(paths)) locations.push({ category, path: path || null, free_bytes: null })
  }
  const freeByPath = new Map<string, number | null>()
  let pathApiUnsupported = false
  for (const location of locations) {
    if (!location.path) {
      location.reason = 'qBittorrent did not report a download path.'
      continue
    }
    if (!freeByPath.has(location.path)) {
      let free: number | null = null
      if (!pathApiUnsupported) {
        try {
          const response = await qbRequest(
            config,
            `/api/v2/app/getFreeSpaceAtPath?path=${encodeURIComponent(location.path)}`,
            {},
            { timeoutMs: 5_000 },
          )
          if (response.status === 404 || response.status === 405) pathApiUnsupported = true
          if (response.ok) free = bytes(await response.text())
        } catch {
          /* continue with default-path fallback */
        }
      }
      if (free === null && location.path === String(preferences.save_path || '')) free = defaultFree
      freeByPath.set(location.path, free)
    }
    location.free_bytes = freeByPath.get(location.path)!
    if (location.free_bytes === null)
      location.reason = 'This qBittorrent client could not report free space for this path.'
  }
  return locations
}

export type QbTorrentAction = 'pause' | 'resume' | 'remove'

export async function qbControlTorrents(
  config: Config,
  hashes: string[],
  action: QbTorrentAction,
  deleteFiles = false,
): Promise<void> {
  const validHashes = [...new Set(hashes.map(hash => hash.toLowerCase()).filter(hash => INFO_HASH_PATTERN.test(hash)))]
  if (!validHashes.length) throw new Error('No valid torrent hashes provided')

  return withTorrentLocks(config, validHashes, async () => {
    const body = new URLSearchParams({ hashes: validHashes.join('|') })
    let paths: string[]
    if (action === 'pause') paths = ['/api/v2/torrents/stop', '/api/v2/torrents/pause']
    else if (action === 'resume') paths = ['/api/v2/torrents/start', '/api/v2/torrents/resume']
    else {
      paths = ['/api/v2/torrents/delete']
      body.set('deleteFiles', String(deleteFiles))
    }

    await qbPostWithFallback(config, paths, body)
    invalidateQbCache(config)
  })
}

export function resetQbRuntime(): void {
  connections.clear()
  endpointLocks.clear()
}

export function invalidateQbSnapshots(): void {
  for (const connection of connections.values()) {
    connection.cache = null
    connection.pending = null
    connection.revision += 1
  }
}
