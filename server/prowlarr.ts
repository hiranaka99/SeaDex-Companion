// Prowlarr client: indexer list, search and downloads through Prowlarr's own proxy. Every request goes to
// the configured Prowlarr origin with the API key in a header; download links from search results are
// re-rooted on that origin and never passed to the browser.

import { createHash } from 'node:crypto'
import type { Config } from './types.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import type { ProwlarrCoverage } from '../shared/contracts.js'
import { isRecord } from '../shared/guards.js'
import { detectXmlError, elementText, listOf, newznabAttributeValues, safeByteSize, text } from './newznab-xml.js'
import {
  ProviderConfigError,
  ResponseTooLargeError,
  decodeText,
  providerEndpoint,
  readResponseCapped,
  retryAfterMs,
  safeText,
} from './provider-http.js'
import { newznabErrorFailure, readNzb, searchNewznab } from './usenet-provider-types.js'
import type { NewznabFailureScope } from './usenet-provider-types.js'

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
  /** Lower-case parameters the indexer accepts in a `t=tvsearch` request, such as `tvdbid`. */
  tvSearchParams: string[]
  /** Lower-case parameters the indexer accepts in a `t=movie` request, such as `tmdbid`. */
  movieSearchParams: string[]
  /** Epoch ms until which Prowlarr leaves the indexer alone after repeated failures. May lie in the past. */
  disabledTill?: number
  /** The query limit set on the indexer in Prowlarr, per 24 hours. Absent when Prowlarr sets none. */
  queryLimitPerDay?: number
  /** The grab limit set on the indexer in Prowlarr, per 24 hours. Absent when Prowlarr sets none. */
  grabLimitPerDay?: number
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

/** One result of a search of a single Usenet indexer. Server-only, like the release it extends. */
export interface ProwlarrSearchResult extends ProwlarrRelease {
  /** File count the indexer reports. */
  files?: number
  /** How often the indexer says the result was grabbed. */
  grabs?: number
  /** Epoch ms of the post. Prowlarr writes the time of the search when the indexer names no date. */
  posted_at?: number
  /** Newznab category IDs of the result; empty when the indexer names none. */
  categories: number[]
}

/** One free-text search of one indexer. Sizes are in bytes and bound the size the indexer reports. */
export interface IndexerSearchParams {
  q: string
  minSize?: number
  maxSize?: number
}

/**
 * What Prowlarr needs to download a result, without the API key: the `link` and `file` parameters of its
 * download link. `link` is Prowlarr's encrypted form of the indexer's own address, so it stays server-side.
 */
export interface ProwlarrDownloadRef {
  indexer_id: number
  link: string
  file: string
}

/** Who a Prowlarr failure is attributed to, in the vocabulary of the Newznab search step. */
export type ProwlarrFailureScope = NewznabFailureScope

/** A Prowlarr call that failed, with a code the availability states understand. */
export class ProwlarrError extends Error {
  constructor(
    readonly code: UsenetFailureCode,
    message: string,
    readonly retryAfterMs?: number,
    readonly scope: ProwlarrFailureScope = 'prowlarr',
  ) {
    super(safeText(message))
  }
}

const API_TIMEOUT_MS = 20_000
/** Prowlarr asks every selected indexer in turn before it answers a search. */
const SEARCH_TIMEOUT_MS = 90_000
/** A search of one indexer through its Newznab endpoint. */
const INDEXER_SEARCH_TIMEOUT_MS = 45_000
const INDEXER_SEARCH_LIMIT = 100
const DOWNLOAD_TIMEOUT_MS = 60_000
const API_MAX_BYTES = 8 * 1024 * 1024
const INDEXER_TTL_MS = 5 * 60_000
/** Indexer names come from Prowlarr's settings; a message keeps them short. */
const INDEXER_NAME_LIMIT = 60

export function prowlarrSettings(config: Config): ProwlarrSettings | null {
  if (!config.prowlarr_enabled || !config.prowlarr_url || !config.prowlarr_key) return null
  return { baseUrl: config.prowlarr_url, apiKey: config.prowlarr_key }
}

/**
 * Prowlarr settings for finding private-tracker releases. Public-tracker mode never downloads them, so
 * Prowlarr is only used while Release preferences include private trackers. Every other tracker mode
 * includes them.
 */
export function privateSearchSettings(config: Config): ProwlarrSettings | null {
  return config.tracker_mode === 'public' ? null : prowlarrSettings(config)
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

/**
 * A request that never got a usable answer. `peer` is who was being talked to: Prowlarr, or the indexer
 * once a download was redirected to it.
 */
function transportFailure(
  error: unknown,
  operation: string,
  scope: ProwlarrFailureScope = 'prowlarr',
  peer: 'Prowlarr' | 'Indexer' = 'Prowlarr',
): ProwlarrError {
  if (error instanceof ProwlarrError) return error
  if (error instanceof ProviderConfigError) return new ProwlarrError('invalid_config', error.message)
  if (error instanceof ResponseTooLargeError)
    return new ProwlarrError('invalid_response', `${peer} ${operation} was too large`, undefined, scope)
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError') return new ProwlarrError('timeout', `${peer} ${operation} timed out`, undefined, scope)
  if (name === 'AbortError') return new ProwlarrError('network', `${peer} ${operation} was cancelled`, undefined, scope)
  const target = peer === 'Prowlarr' ? 'Prowlarr' : 'the indexer'
  return new ProwlarrError('network', `Could not reach ${target} for the ${operation}`, undefined, scope)
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
    const body = decodeText(await readResponseCapped(response, API_MAX_BYTES))
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new ProwlarrError('invalid_response', `Prowlarr ${operation} was not JSON. Check the Prowlarr URL.`)
    }
  } catch (error) {
    throw transportFailure(error, operation)
  }
}

const alias = (value: unknown): string =>
  typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''

/** Search parameter names of a capability list, lower-cased as a Newznab request spells them. */
function capabilityParams(value: unknown): string[] {
  const names = listOf(value)
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim().toLowerCase())
  return [...new Set(names.filter(Boolean))]
}

/**
 * A query or grab limit as a figure per 24 hours. `unit` is Prowlarr's `IndexerLimitsUnit`, Day = 0 and
 * Hour = 1; those values were read from Prowlarr's source and not confirmed against a running instance.
 * Any other unit counts as per day. Prowlarr sets no limit when the figure is missing, zero or negative.
 */
function limitPerDay(limit: unknown, unit: unknown): number | undefined {
  const count = Math.floor(
    typeof limit === 'number' ? limit : typeof limit === 'string' && limit.trim() ? Number(limit) : Number.NaN,
  )
  if (!Number.isSafeInteger(count) || count <= 0) return undefined
  const hourly = unit === 1 || (typeof unit === 'string' && /^(?:1|hour)$/i.test(unit.trim()))
  return hourly ? count * 24 : count
}

function parseIndexer(value: unknown): ProwlarrIndexer | null {
  if (!isRecord(value) || value.enable === false) return null
  const id = Number(value.id)
  const protocol = value.protocol
  if (!Number.isSafeInteger(id) || id <= 0 || (protocol !== 'torrent' && protocol !== 'usenet')) return null
  const name = typeof value.name === 'string' ? value.name : `Indexer ${id}`
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {}
  const status = isRecord(value.status) ? value.status : {}
  const disabledTill = typeof status.disabledTill === 'string' ? Date.parse(status.disabledTill) : Number.NaN
  // An indexer's settings arrive as a list of named fields.
  const fields = new Map<string, unknown>()
  for (const field of listOf(value.fields))
    if (isRecord(field) && typeof field.name === 'string') fields.set(field.name, field.value)
  const unit = fields.get('baseSettings.limitsUnit')
  const queryLimit = limitPerDay(fields.get('baseSettings.queryLimit'), unit)
  const grabLimit = limitPerDay(fields.get('baseSettings.grabLimit'), unit)
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
    tvSearchParams: capabilityParams(capabilities.tvSearchParams),
    movieSearchParams: capabilityParams(capabilities.movieSearchParams),
    ...(Number.isFinite(disabledTill) ? { disabledTill } : {}),
    ...(queryLimit ? { queryLimitPerDay: queryLimit } : {}),
    ...(grabLimit ? { grabLimitPerDay: grabLimit } : {}),
  }
}

const indexerCache = new Map<string, { at: number; indexers: ProwlarrIndexer[] }>()
/** Connections whose indexer list is being read in the background for `knownProwlarrIndexers`. */
const indexerRefreshes = new Set<string>()

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
  const key = prowlarrFingerprint(settings)
  const cached = indexerCache.get(key)
  // One refresh at a time: a status read or a sweep asks once per release.
  if ((!cached || Date.now() - cached.at >= INDEXER_TTL_MS) && !indexerRefreshes.has(key)) {
    indexerRefreshes.add(key)
    void prowlarrIndexers(settings, globalThis.fetch, true)
      .catch(() => undefined)
      .finally(() => indexerRefreshes.delete(key))
  }
  return cached?.indexers
}

export function resetProwlarrRuntime(): void {
  indexerCache.clear()
  indexerRefreshes.clear()
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
    if (url.origin === prowlarr || /\/(?:download|getnzb|api)\b/i.test(url.pathname)) continue
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

/**
 * An indexer's Newznab error document, sent instead of a downloaded file, as a failure of that indexer.
 * Prowlarr may have passed it on or the indexer sent it after a redirect, so its name is not known here.
 */
function downloadErrorDocument(code: number): ProwlarrError {
  const failure = newznabErrorFailure(code, { indexer: 'The indexer', viaProwlarr: true })
  return new ProwlarrError(failure.code, failure.message, failure.retryAfterMs, failure.scope)
}

/** The indexer's name for a message: cleaned, short and never empty. */
function indexerLabel(indexer: { id: number; name: string }): string {
  return safeText(indexer.name, INDEXER_NAME_LIMIT) || `Indexer ${indexer.id}`
}

/** A size bound in whole bytes. Undefined when missing or not positive, which Prowlarr reads as no bound. */
function byteBound(value: number | undefined, round: (value: number) => number): number | undefined {
  const bytes = value === undefined ? Number.NaN : round(value)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
}

/** A reported size in bytes. Undefined when the indexer gave none or zero, which is not a size. */
function knownSize(value: unknown): number | undefined {
  return safeByteSize(value) || undefined
}

/** An identity for a result that names no GUID: a digest of its download link without the API key. */
function linkDigest(path: string): string {
  const at = path.indexOf('?')
  const query = new URLSearchParams(at < 0 ? '' : path.slice(at + 1))
  query.delete('apikey')
  return createHash('sha1')
    .update(`${at < 0 ? path : path.slice(0, at)}?${query}`)
    .digest('hex')
}

function parseSearchItem(
  settings: ProwlarrSettings,
  indexer: { id: number; name: string },
  value: unknown,
): ProwlarrSearchResult | null {
  if (!isRecord(value)) return null
  const enclosure = isRecord(value.enclosure) ? value.enclosure : {}
  const enclosureUrl = text(enclosure['@_url'])
  const link = elementText(value.link)
  const path = downloadPath(settings, enclosureUrl) ?? downloadPath(settings, link)
  if (!path?.startsWith('/')) return null
  const attributes = newznabAttributeValues(value)
  const attribute = (name: string) => attributes.get(name)?.[0]
  const guid = elementText(value.guid)
  const comments = elementText(value.comments)
  const info = infoUrl(settings, comments, guid)
  const files = safeByteSize(attribute('files'))
  const grabs = safeByteSize(attribute('grabs'))
  const posted = Date.parse(elementText(value.pubDate) ?? '')
  // Prowlarr names each category twice, as an attribute and as a plain element.
  const categories = [...(attributes.get('category') ?? []), ...listOf(value.category).map(elementText)]
    .map(Number)
    .filter(category => Number.isSafeInteger(category) && category > 0)
  return {
    guid: guid ?? linkDigest(path),
    indexer_id: indexer.id,
    indexer: indexer.name,
    title: elementText(value.title) ?? '',
    size:
      knownSize(attribute('size')) ?? knownSize(elementText(value.size)) ?? knownSize(enclosure['@_length']) ?? null,
    protocol: 'usenet',
    download_path: path,
    links: [...new Set([guid, comments, link, enclosureUrl].filter((entry): entry is string => Boolean(entry)))],
    ...(info ? { info_url: info } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(grabs !== undefined ? { grabs } : {}),
    ...(Number.isFinite(posted) ? { posted_at: posted } : {}),
    categories: [...new Set(categories)],
  }
}

/**
 * One free-text search of one Usenet indexer, through its Newznab endpoint in Prowlarr. `/api/v1/search`
 * answers with an empty list when an indexer fails or is at its limit; this endpoint says so, and an empty
 * list here means the indexer answered and has nothing. No category is ever sent, because Prowlarr drops
 * every result outside the requested categories.
 */
export async function searchIndexer(
  settings: ProwlarrSettings,
  indexer: { id: number; name: string },
  params: IndexerSearchParams,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProwlarrSearchResult[]> {
  const name = indexerLabel(indexer)
  // The ID becomes a path segment, so it is never anything but a number.
  if (!Number.isSafeInteger(indexer.id) || indexer.id <= 0)
    throw new ProwlarrError('invalid_config', 'The Prowlarr indexer has no usable ID', undefined, 'indexer')
  const query = new URLSearchParams({ t: 'search', q: params.q, limit: String(INDEXER_SEARCH_LIMIT), extended: '1' })
  const minSize = byteBound(params.minSize, Math.floor)
  const maxSize = byteBound(params.maxSize, Math.ceil)
  if (minSize) query.set('minsize', String(minSize))
  if (maxSize) query.set('maxsize', String(maxSize))
  const answer = await searchNewznab(
    {
      indexer: name,
      viaProwlarr: true,
      baseUrl: settings.baseUrl,
      path: `/${indexer.id}/api?${query}`,
      headers: { 'X-Api-Key': settings.apiKey },
      timeoutMs: INDEXER_SEARCH_TIMEOUT_MS,
      maxBytes: API_MAX_BYTES,
      signal: settings.signal,
    },
    fetchImpl,
  )
  if (answer.kind === 'failed') {
    const { failure } = answer
    throw new ProwlarrError(failure.code, failure.message, failure.retryAfterMs, failure.scope)
  }
  return answer.items
    .map(item => parseSearchItem(settings, indexer, item))
    .filter((item): item is ProwlarrSearchResult => item !== null)
}

/** Prowlarr's download link for a result: `/{indexer id}/download?apikey=…&link=…&file=…`. */
const DOWNLOAD_LINK = /^\/(\d+)\/download\?(.*)$/s

/**
 * The storable reference of a result's download link, without the API key. Null when the link has another
 * form, names another indexer than the result, or carries no `link`.
 */
export function downloadRef(
  release: Pick<ProwlarrRelease, 'download_path' | 'indexer_id'>,
): ProwlarrDownloadRef | null {
  const match = DOWNLOAD_LINK.exec(release.download_path)
  if (!match || Number(match[1]) !== release.indexer_id) return null
  const query = new URLSearchParams(match[2])
  const link = query.get('link')
  if (!link) return null
  return { indexer_id: release.indexer_id, link, file: query.get('file') ?? '' }
}

/** The download link of a stored reference, rebuilt with the configured key. Server-only, like every such link. */
export function downloadPathFromRef(settings: ProwlarrSettings, ref: ProwlarrDownloadRef): string {
  // A reference is read back from disk, and its ID becomes a path segment.
  if (!Number.isSafeInteger(ref.indexer_id) || ref.indexer_id <= 0)
    throw new ProwlarrError('invalid_response', 'The stored download reference is not usable', undefined, 'indexer')
  const query = new URLSearchParams({ apikey: settings.apiKey, link: ref.link, file: ref.file })
  return `/${ref.indexer_id}/download?${query}`
}

/** Prowlarr's per-indexer "Redirect" option answers a download with the indexer's own link instead of the file. */
const DOWNLOAD_REDIRECT_LIMIT = 3

/** What an unsuccessful download answer means. Prowlarr answers first; after a redirect the indexer does. */
function downloadStatusFailure(response: Response, fromIndexer: boolean): ProwlarrError {
  const retryAfter = retryAfterMs(response)
  if (!fromIndexer) {
    // Prowlarr refuses a download itself while the indexer is at the grab limit set in Prowlarr or
    // disabled after failures, so its 429 is about that indexer and not about Prowlarr.
    if (response.status === 429)
      return new ProwlarrError(
        'rate_limited',
        'Prowlarr is not downloading from this indexer for now: it is at its grab limit or disabled after failures',
        retryAfter,
        'indexer',
      )
    return failureFromStatus(response)
  }
  const detail = `The indexer refused the download (HTTP ${response.status})`
  if (response.status === 429)
    return new ProwlarrError('rate_limited', 'The indexer rate limited the download', retryAfter, 'indexer')
  if (response.status === 401 || response.status === 403)
    return new ProwlarrError('unauthorized', `${detail}. Check the indexer in Prowlarr.`, undefined, 'indexer')
  if (response.status >= 500)
    return new ProwlarrError(
      'server',
      `The indexer could not send the download (HTTP ${response.status})`,
      retryAfter,
      'indexer',
    )
  return new ProwlarrError('invalid_response', detail, undefined, 'indexer')
}

/**
 * Downloads a result's file through Prowlarr and reads it with `read`. Prowlarr counts this as a grab on the
 * indexer, so callers fetch only the few candidates they will check. When Prowlarr redirects to the indexer,
 * the redirect is followed to http(s) addresses only, and the Prowlarr API key is never sent beyond Prowlarr
 * itself.
 *
 * A failure says who caused it. An indexer that is rate limited, failing or refusing its key by its HTTP
 * status fails with indexer scope; what the body says is `read`'s to judge.
 */
async function download<T>(
  settings: ProwlarrSettings,
  release: Pick<ProwlarrRelease, 'download_path'>,
  fetchImpl: typeof fetch,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  // Once Prowlarr has redirected, every answer and every failure is the indexer's.
  let redirected = false
  try {
    let response = await request(settings, release.download_path, DOWNLOAD_TIMEOUT_MS, fetchImpl, 'manual')
    for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
      await response.body?.cancel()
      const scope: ProwlarrFailureScope = redirected ? 'indexer' : 'prowlarr'
      const location = response.headers.get('location')
      let next: URL | null = null
      try {
        next = location ? new URL(location, response.url || settings.baseUrl) : null
      } catch {
        next = null
      }
      if (!next || (next.protocol !== 'https:' && next.protocol !== 'http:'))
        throw new ProwlarrError(
          'invalid_response',
          `${redirected ? 'The indexer' : 'Prowlarr'} redirected the download to something other than a file`,
          undefined,
          scope,
        )
      if (hop >= DOWNLOAD_REDIRECT_LIMIT)
        throw new ProwlarrError('invalid_response', 'The download redirected too many times', undefined, scope)
      redirected = true
      response = await fetchImpl(next.href, {
        method: 'GET',
        signal: AbortSignal.any([
          AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          ...(settings.signal ? [settings.signal] : []),
        ]),
        redirect: 'manual',
      })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw downloadStatusFailure(response, redirected)
    }
    return await read(response)
  } catch (error) {
    throw redirected ? transportFailure(error, 'download', 'indexer', 'Indexer') : transportFailure(error, 'download')
  }
}

/**
 * Downloads a result's file, such as a private tracker's .torrent, and returns it as it was sent. A Newznab
 * error document sent instead of the file fails with indexer scope, also with HTTP 200.
 */
export async function prowlarrDownload(
  settings: ProwlarrSettings,
  release: Pick<ProwlarrRelease, 'download_path'>,
  maxBytes: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Uint8Array> {
  return await download(settings, release, fetchImpl, async response => {
    const bytes = await readResponseCapped(response, maxBytes)
    // An indexer at its limit answers with HTTP 200 and a Newznab error document instead of the file,
    // whether Prowlarr fetched the body itself or redirected to the indexer.
    const reported = detectXmlError(bytes)
    if (reported) throw downloadErrorDocument(reported.code)
    return bytes
  })
}

/**
 * Grabs a Usenet result's NZB and returns it decompressed and validated, through the same NZB step as the
 * hash indexers. A body that is not a usable NZB fails with indexer scope, whether Prowlarr passed it on or
 * the indexer sent it after a redirect: an error document as its code says, anything else, too large
 * included, as `invalid_response`.
 */
export async function prowlarrGrabNzb(
  settings: ProwlarrSettings,
  release: Pick<ProwlarrRelease, 'download_path'>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Uint8Array> {
  return await download(settings, release, fetchImpl, async response => {
    const nzb = await readNzb(response)
    switch (nzb.kind) {
      case 'nzb':
        return nzb.bytes
      case 'too_large':
        // As sent or only once decompressed, the file is the indexer's, also when Prowlarr passed it on.
        throw new ProwlarrError('invalid_response', 'The indexer sent an NZB over the size limit', undefined, 'indexer')
      case 'error_document':
        throw downloadErrorDocument(nzb.code)
      case 'invalid':
        throw new ProwlarrError('invalid_response', 'The indexer did not send a valid NZB', undefined, 'indexer')
    }
  })
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
