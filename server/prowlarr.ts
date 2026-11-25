// Prowlarr client: indexer list, search and downloads through Prowlarr's own proxy. Every request goes to
// the configured Prowlarr origin with the API key in a header; download links from search results are
// re-rooted on that origin and never passed to the browser.

import { createHash } from 'node:crypto'
import type { Config } from './types.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import type { ProwlarrCoverage } from '../shared/contracts.js'
import { isRecord } from '../shared/guards.js'
import {
  ProviderConfigError,
  ResponseTooLargeError,
  providerEndpoint,
  readResponseCapped,
  retryAfterMs,
  safeText,
} from './usenet-provider-types.js'

export interface ProwlarrSettings {
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}

export interface ProwlarrIndexer {
  id: number
  name: string
  protocol: 'torrent' | 'usenet'
  /** `public`, `private` or `semiPrivate`, as Prowlarr reports it. */
  privacy: string
  /** Lower-case alphanumeric names Prowlarr knows the indexer by, for matching SeaDex's tracker names. */
  aliases: string[]
}

export interface ProwlarrRelease {
  guid: string
  indexer_id: number
  indexer: string
  title: string
  size: number | null
  protocol: 'torrent' | 'usenet'
  /** Path and query of Prowlarr's download proxy on the configured origin. Carries the API key; server-only. */
  download_path: string
  /** Every link the result names, for recognizing a tracker's torrent ID. */
  links: string[]
  /** The result's page on its indexer, safe to show: never a download link and never one carrying a key. */
  info_url?: string
}

/** A Prowlarr call that failed, with a code the availability states understand. */
export class ProwlarrError extends Error {
  constructor(
    readonly code: UsenetFailureCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(safeText(message))
  }
}

const API_TIMEOUT_MS = 20_000
/** Prowlarr asks every selected indexer in turn before it answers a search. */
const SEARCH_TIMEOUT_MS = 90_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const API_MAX_BYTES = 8 * 1024 * 1024
const INDEXER_TTL_MS = 5 * 60_000

export function prowlarrSettings(config: Config): ProwlarrSettings | null {
  if (!config.prowlarr_enabled || !config.prowlarr_url || !config.prowlarr_key) return null
  return { baseUrl: config.prowlarr_url, apiKey: config.prowlarr_key }
}

/**
 * Prowlarr settings for finding private-tracker releases. Public-tracker mode never downloads them, so
 * Prowlarr is only used while Release preferences include private trackers.
 */
export function privateSearchSettings(config: Config): ProwlarrSettings | null {
  return config.tracker_mode === 'private' ? prowlarrSettings(config) : null
}

/** Credential-free identity of a Prowlarr connection, for cache keys. */
export function prowlarrFingerprint(settings: ProwlarrSettings): string {
  return createHash('sha256').update(`${settings.baseUrl}\u0000${settings.apiKey}`).digest('hex').slice(0, 24)
}

function failureFromStatus(response: Response): ProwlarrError {
  const detail = `Prowlarr returned HTTP ${response.status}`
  if (response.status === 401 || response.status === 403)
    return new ProwlarrError('unauthorized', `${detail}. Check the Prowlarr API key.`)
  if (response.status === 429)
    return new ProwlarrError('rate_limited', 'Prowlarr rate limited the request', retryAfterMs(response))
  if (response.status >= 500) return new ProwlarrError('server', detail, retryAfterMs(response))
  return new ProwlarrError('invalid_response', detail)
}

function transportFailure(error: unknown, operation: string): ProwlarrError {
  if (error instanceof ProwlarrError) return error
  if (error instanceof ProviderConfigError) return new ProwlarrError('invalid_config', error.message)
  if (error instanceof ResponseTooLargeError)
    return new ProwlarrError('invalid_response', `Prowlarr ${operation} was too large`)
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError') return new ProwlarrError('timeout', `Prowlarr ${operation} timed out`)
  if (name === 'AbortError') return new ProwlarrError('network', `Prowlarr ${operation} was cancelled`)
  return new ProwlarrError('network', `Could not reach Prowlarr for the ${operation}`)
}

async function request(
  settings: ProwlarrSettings,
  path: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  redirect: RequestRedirect = 'error',
): Promise<Response> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(settings.signal ? [settings.signal] : [])]
  return await fetchImpl(providerEndpoint(settings.baseUrl, path), {
    method: 'GET',
    headers: { accept: 'application/json', 'X-Api-Key': settings.apiKey },
    signal: AbortSignal.any(signals),
    redirect,
  })
}

async function getJson(
  settings: ProwlarrSettings,
  path: string,
  timeoutMs: number,
  operation: string,
  fetchImpl: typeof fetch,
) {
  try {
    const response = await request(settings, path, timeoutMs, fetchImpl)
    if (!response.ok) {
      await response.body?.cancel()
      throw failureFromStatus(response)
    }
    const text = new TextDecoder('utf-8').decode(await readResponseCapped(response, API_MAX_BYTES))
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ProwlarrError('invalid_response', `Prowlarr ${operation} was not JSON. Check the Prowlarr URL.`)
    }
  } catch (error) {
    throw transportFailure(error, operation)
  }
}

const alias = (value: unknown): string =>
  typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''

function parseIndexer(value: unknown): ProwlarrIndexer | null {
  if (!isRecord(value) || value.enable === false) return null
  const id = Number(value.id)
  const protocol = value.protocol
  if (!Number.isSafeInteger(id) || id <= 0 || (protocol !== 'torrent' && protocol !== 'usenet')) return null
  const name = typeof value.name === 'string' ? value.name : `Indexer ${id}`
  return {
    id,
    name,
    protocol,
    privacy: typeof value.privacy === 'string' ? value.privacy : 'public',
    aliases: [
      ...new Set(
        [value.name, value.definitionName, value.implementationName, value.implementation].map(alias).filter(Boolean),
      ),
    ],
  }
}

const indexerCache = new Map<string, { at: number; indexers: ProwlarrIndexer[] }>()

/** Enabled indexers, cached briefly so one review does not list them once per release. */
export async function prowlarrIndexers(
  settings: ProwlarrSettings,
  fetchImpl: typeof fetch = globalThis.fetch,
  fresh = false,
): Promise<ProwlarrIndexer[]> {
  const key = prowlarrFingerprint(settings)
  const cached = indexerCache.get(key)
  if (!fresh && cached && Date.now() - cached.at < INDEXER_TTL_MS) return cached.indexers
  const body = await getJson(settings, '/api/v1/indexer', API_TIMEOUT_MS, 'indexer list', fetchImpl)
  if (!Array.isArray(body)) throw new ProwlarrError('invalid_response', 'Prowlarr indexer list was not a list')
  const indexers = body.map(parseIndexer).filter((indexer): indexer is ProwlarrIndexer => indexer !== null)
  indexerCache.set(key, { at: Date.now(), indexers })
  return indexers
}

/**
 * The indexer list if it was read recently, without waiting: a stale or missing list is refreshed in the
 * background and `undefined` is returned until it arrives.
 */
export function knownProwlarrIndexers(settings: ProwlarrSettings): ProwlarrIndexer[] | undefined {
  const cached = indexerCache.get(prowlarrFingerprint(settings))
  if (!cached || Date.now() - cached.at >= INDEXER_TTL_MS)
    void prowlarrIndexers(settings, globalThis.fetch, true).catch(() => undefined)
  return cached?.indexers
}

export function resetProwlarrRuntime(): void {
  indexerCache.clear()
}

/** SeaDex's tracker names and the names Prowlarr gives the same trackers. */
const TRACKER_ALIASES: Record<string, string[]> = {
  ab: ['animebytes'],
  animebytes: ['animebytes'],
  beyondhd: ['beyondhd', 'bhd'],
  bhd: ['beyondhd', 'bhd'],
  passthepopcorn: ['passthepopcorn', 'ptp'],
  broadcastthenet: ['broadcastthenet', 'btn'],
  hdbits: ['hdbits'],
  blutopia: ['blutopia'],
  aither: ['aither'],
}

/** Private torrent indexers in Prowlarr that are the tracker SeaDex names. */
export function trackerIndexers(indexers: ProwlarrIndexer[], tracker: string): ProwlarrIndexer[] {
  const wanted = TRACKER_ALIASES[alias(tracker)] ?? [alias(tracker)]
  if (!wanted[0]) return []
  return indexers.filter(
    indexer =>
      indexer.protocol === 'torrent' &&
      indexer.privacy !== 'public' &&
      indexer.aliases.some(name => wanted.some(target => name === target || name.startsWith(target))),
  )
}

/** Which of the given trackers Prowlarr has a private torrent indexer for, and whether it has Usenet indexers. */
export async function prowlarrCoverage(
  settings: ProwlarrSettings,
  trackers: string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProwlarrCoverage> {
  const indexers = await prowlarrIndexers(settings, fetchImpl)
  return {
    trackers: [...new Set(trackers)].filter(tracker => trackerIndexers(indexers, tracker).length > 0),
    usenet: indexers.some(indexer => indexer.protocol === 'usenet'),
  }
}

/** The download proxy path of a result, re-rooted on the configured origin. Null when it points elsewhere. */
function downloadPath(settings: ProwlarrSettings, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  let link: URL
  let base: URL
  try {
    base = new URL(`${settings.baseUrl.replace(/\/+$/, '')}/`)
    link = new URL(value, base)
  } catch {
    return null
  }
  // Prowlarr names its own host as it was reached; only the path under the configured base is kept.
  const prefix = base.pathname.replace(/\/+$/, '')
  if (prefix && !link.pathname.startsWith(`${prefix}/`)) return null
  return `${link.pathname.slice(prefix.length)}${link.search}`
}

const CREDENTIAL_PARAMS = /^(?:api_?key|apikey|key|passkey|token|auth|r|i)$/i

/**
 * A result's indexer page for the browser. Download proxies on Prowlarr, download links and any address
 * with a credential-like parameter or the Prowlarr key are left out.
 */
function infoUrl(settings: ProwlarrSettings, ...candidates: unknown[]): string | undefined {
  let prowlarr = ''
  try {
    prowlarr = new URL(settings.baseUrl).origin
  } catch {
    /* an invalid base URL never produces results */
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (url.origin === prowlarr || /\/(?:download|getnzb|api)/i.test(url.pathname)) continue
    if (url.username || url.password || candidate.includes(settings.apiKey)) continue
    if ([...url.searchParams.keys()].some(name => CREDENTIAL_PARAMS.test(name))) continue
    return url.href
  }
  return undefined
}

function parseRelease(settings: ProwlarrSettings, value: unknown): ProwlarrRelease | null {
  if (!isRecord(value)) return null
  const protocol = value.protocol
  const indexerId = Number(value.indexerId)
  const path = downloadPath(settings, value.downloadUrl)
  if ((protocol !== 'torrent' && protocol !== 'usenet') || !Number.isSafeInteger(indexerId) || !path) return null
  const size = Number(value.size)
  return {
    guid: typeof value.guid === 'string' ? value.guid : path,
    indexer_id: indexerId,
    indexer: typeof value.indexer === 'string' ? value.indexer : '',
    title: typeof value.title === 'string' ? value.title : '',
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
    protocol,
    download_path: path,
    links: [value.guid, value.infoUrl, value.commentUrl, value.downloadUrl].filter(
      (link): link is string => typeof link === 'string' && Boolean(link),
    ),
    ...(infoUrl(settings, value.infoUrl, value.commentUrl, value.guid)
      ? { info_url: infoUrl(settings, value.infoUrl, value.commentUrl, value.guid) }
      : {}),
  }
}

/** One free-text search across the given indexers. */
export async function searchProwlarr(
  settings: ProwlarrSettings,
  query: string,
  indexerIds: number[],
  fetchImpl: typeof fetch = globalThis.fetch,
  categories: number[] = [],
): Promise<ProwlarrRelease[]> {
  if (!indexerIds.length) return []
  const params = new URLSearchParams({ query, type: 'search', limit: '100', offset: '0' })
  for (const id of indexerIds) params.append('indexerIds', String(id))
  for (const category of categories) params.append('categories', String(category))
  const body = await getJson(settings, `/api/v1/search?${params}`, SEARCH_TIMEOUT_MS, 'search', fetchImpl)
  if (!Array.isArray(body)) throw new ProwlarrError('invalid_response', 'Prowlarr search did not return a list')
  return body.map(item => parseRelease(settings, item)).filter((item): item is ProwlarrRelease => item !== null)
}

/** Prowlarr's per-indexer "Redirect" option answers a download with the indexer's own link instead of the file. */
const DOWNLOAD_REDIRECT_LIMIT = 3

/**
 * Downloads a result's file through Prowlarr. Prowlarr counts this as a grab on the indexer, so callers
 * fetch only the few candidates they will check. When Prowlarr redirects to the indexer, the redirect is
 * followed to http(s) addresses only, and the Prowlarr API key is never sent beyond Prowlarr itself.
 */
export async function prowlarrDownload(
  settings: ProwlarrSettings,
  release: Pick<ProwlarrRelease, 'download_path'>,
  maxBytes: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Uint8Array> {
  try {
    let response = await request(settings, release.download_path, DOWNLOAD_TIMEOUT_MS, fetchImpl, 'manual')
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      let next: URL | null = null
      try {
        next = location ? new URL(location, response.url || settings.baseUrl) : null
      } catch {
        next = null
      }
      if (!next || (next.protocol !== 'https:' && next.protocol !== 'http:'))
        throw new ProwlarrError('invalid_response', 'Prowlarr redirected the download to something other than a file')
      if (hop >= DOWNLOAD_REDIRECT_LIMIT)
        throw new ProwlarrError('invalid_response', 'The download redirected too many times')
      response = await fetchImpl(next.href, {
        method: 'GET',
        signal: AbortSignal.any([
          AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          ...(settings.signal ? [settings.signal] : []),
        ]),
        redirect: 'manual',
      })
      if (!response.ok && (response.status < 300 || response.status >= 400)) {
        await response.body?.cancel()
        throw new ProwlarrError('invalid_response', `The indexer refused the download (HTTP ${response.status})`)
      }
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw failureFromStatus(response)
    }
    return await readResponseCapped(response, maxBytes)
  } catch (error) {
    throw transportFailure(error, 'download')
  }
}

/** Read-only connection test: the version and what the configured indexers can search. */
export async function testProwlarr(
  settings: ProwlarrSettings,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const status = await getJson(settings, '/api/v1/system/status', API_TIMEOUT_MS, 'status check', fetchImpl)
  if (!isRecord(status) || typeof status.version !== 'string')
    throw new ProwlarrError('invalid_response', 'The URL did not answer like Prowlarr. Check the URL and URL base.')
  const indexers = await prowlarrIndexers(settings, fetchImpl, true)
  const usenet = indexers.filter(indexer => indexer.protocol === 'usenet').length
  const privateTorrent = indexers.filter(
    indexer => indexer.protocol === 'torrent' && indexer.privacy !== 'public',
  ).length
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
  return `Connected to Prowlarr ${status.version} · ${plural(usenet, 'Usenet indexer')}, ${plural(privateTorrent, 'private torrent indexer')}`
}
