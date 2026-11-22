// AmeNZB (Newznab) client: hash search, authenticated capability-free probe and
// NZB retrieval through `t=get`. The API key is only ever sent to the configured
// base URL and never appears in a message.

import type { UsenetProvider } from '../shared/usenet-contracts.js'
import {
  AMENZB_ENTRY_PATTERN, HASH_PATTERN, LOOKUP_MAX_BYTES, LOOKUP_TIMEOUT_MS, NZB_TIMEOUT_MS,
  ProviderProtocolError, ResponseTooLargeError, classifyFailure, classifyNewznabError, decodeText, detectXmlError,
  failedFrom, failedLookup, findNewznabError, httpStatusFailure, isRecord, listOf, parseProviderXml, providerRequest,
  readNzbBody, readResponseCapped, safeByteSize, safeText, text, validateNzbBytes,
} from './usenet-provider-types.js'
import type { ProviderLookup, ProviderSettings, UsenetMatch } from './usenet-provider-types.js'

const PROVIDER: UsenetProvider = 'amenzb'
/** Cannot exist, so it validates the key/IP without depending on catalogue contents. */
const PROBE_HASH = '0'.repeat(40)

interface AmeNZBItem {
  entry_id: string
  source_hash?: string
  title?: string
  nzb_name?: string
  total_bytes?: number
}

function newznabAttributes(item: Record<string, unknown>): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const raw of listOf(item['newznab:attr'])) {
    if (!isRecord(raw)) continue
    const name = text(raw['@_name'])?.toLowerCase()
    const value = text(raw['@_value'])
    if (name && value !== undefined && !attributes.has(name)) attributes.set(name, value)
  }
  return attributes
}

/** Element body, also when attributes pushed the value under `#text`. */
function elementText(value: unknown): string | undefined {
  return isRecord(value) ? text(value['#text']) : text(value)
}

/**
 * Entry id carried by a getnzb URL. The `.nzb` segment is preferred because the
 * documented URL shape appends the API key as the final path segment.
 */
function urlEntryId(url: string | undefined): string | undefined {
  if (!url) return undefined
  let segments: string[]
  try { segments = new URL(url).pathname.split('/').filter(Boolean) }
  catch { return undefined }
  const withExtension = [...segments].reverse().find(segment => /\.nzb$/i.test(segment))
  const candidate = withExtension ?? segments[segments.length - 1]
  return candidate?.replace(/\.nzb$/i, '')
}

function parseItem(value: unknown): AmeNZBItem | undefined {
  if (!isRecord(value)) return undefined
  const attributes = newznabAttributes(value)
  const enclosure = isRecord(value.enclosure) ? value.enclosure : undefined
  const entryId = attributes.get('guid') ?? urlEntryId(elementText(value.link)) ?? urlEntryId(text(enclosure?.url))
  if (!entryId || !AMENZB_ENTRY_PATTERN.test(entryId)) return undefined
  const title = elementText(value.title)
  return {
    entry_id: entryId,
    source_hash: (attributes.get('info_hash') ?? attributes.get('infohash'))?.toLowerCase(),
    title,
    nzb_name: title ? `${title}.nzb` : undefined,
    total_bytes: safeByteSize(attributes.get('size')) ?? safeByteSize(enclosure?.['@_length']),
  }
}

function searchItems(document: unknown): unknown[] | undefined {
  if (!isRecord(document) || !isRecord(document.rss) || !isRecord(document.rss.channel)) return undefined
  return listOf(document.rss.channel.item)
}

/**
 * Run one hash search and classify everything the provider can answer with,
 * including `<error>` documents that arrive with HTTP 200.
 */
async function search(settings: ProviderSettings, requested: string, fetchImpl: typeof fetch): Promise<ProviderLookup> {
  if (!settings.apiKey) return failedLookup('invalid_config', 'AmeNZB API key is not configured')
  const path = `/api?t=search&apikey=${encodeURIComponent(settings.apiKey)}&info_hash=${requested}`

  let response: Response
  try { response = await providerRequest(settings, path, 'application/xml', LOOKUP_TIMEOUT_MS, fetchImpl) }
  catch (error) { return failedFrom(error, settings, 'lookup') }

  const status = httpStatusFailure(response, 'AmeNZB')
  if (status) return failedLookup(status.code, status.message, status.retryAfterMs)

  let document: unknown
  try { document = parseProviderXml(decodeText(await readResponseCapped(response, LOOKUP_MAX_BYTES))) }
  catch (error) {
    if (error instanceof ResponseTooLargeError) return failedLookup('invalid_response', safeText(error.message))
    if (error instanceof ProviderProtocolError) return failedLookup('invalid_response', safeText(error.message))
    return failedFrom(error, settings, 'lookup')
  }

  // An error document is never an empty result set.
  const reported = findNewznabError(document)
  if (reported) {
    const failure = classifyNewznabError(reported.code)
    return failedLookup(failure.code, failure.message)
  }

  const rawItems = searchItems(document)
  if (!rawItems) return failedLookup('invalid_response', 'AmeNZB search response was not Newznab RSS')
  if (rawItems.length === 0) return { kind: 'no_match' }

  const items: AmeNZBItem[] = []
  for (const raw of rawItems) {
    const item = parseItem(raw)
    if (!item) return failedLookup('invalid_response', 'AmeNZB returned an unusable search entry')
    items.push(item)
  }

  const hashed = items.filter(item => item.source_hash !== undefined)
  const matching = hashed.filter(item => item.source_hash === requested)
  if (items.length > 1) {
    // Only a unique hash agreement resolves multiple entries; never guess by title.
    if (matching.length === 1) return { kind: 'match', match: toMatch(matching[0], requested) }
    if (hashed.length === 1) return failedLookup('invalid_response', 'AmeNZB source hash did not match the requested hash')
    return failedLookup('invalid_response', 'ambiguous provider response')
  }

  const single = items[0]
  if (single.source_hash !== undefined && single.source_hash !== requested) {
    return failedLookup('invalid_response', 'AmeNZB source hash did not match the requested hash')
  }
  return { kind: 'match', match: toMatch(single, requested) }
}

function toMatch(item: AmeNZBItem, requested: string): UsenetMatch {
  return {
    provider: PROVIDER,
    entry_id: item.entry_id,
    source_hash: requested,
    title: item.title,
    nzb_name: item.nzb_name,
    total_bytes: item.total_bytes,
    // Hash search does not carry a per-file manifest.
    files_complete: false,
  }
}

/** Look up one source hash; hash agreement is required whenever the indexer supplies one. */
export async function lookupAmeNZB(settings: ProviderSettings, hash: string, fetchImpl: typeof fetch): Promise<ProviderLookup> {
  const requested = hash.toLowerCase()
  if (!HASH_PATTERN.test(requested)) return failedLookup('invalid_response', 'source hash was not a normalized SHA-1 digest')
  return await search(settings, requested, fetchImpl)
}

/**
 * Authenticated read-only search. Capabilities cannot validate a key/IP binding,
 * so this probes the hash endpoint instead and succeeds on any valid RSS answer.
 */
export async function testAmeNZB(settings: ProviderSettings, fetchImpl: typeof fetch): Promise<void> {
  const result = await search(settings, PROBE_HASH, fetchImpl)
  if (result.kind === 'failed') throw new Error(result.message)
}

/** Fetch and validate `t=get` for a matched entry from the configured origin. */
export async function fetchAmeNZBNzb(settings: ProviderSettings, match: UsenetMatch, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (!settings.apiKey) throw new Error('AmeNZB API key is not configured')
  if (!AMENZB_ENTRY_PATTERN.test(match.entry_id)) throw new Error('AmeNZB NZB reference was not usable')
  const path = `/api?t=get&apikey=${encodeURIComponent(settings.apiKey)}&id=${encodeURIComponent(match.entry_id)}`

  let response: Response
  try { response = await providerRequest(settings, path, 'application/octet-stream', NZB_TIMEOUT_MS, fetchImpl) }
  catch (error) { throw new Error(classifyFailure(error, settings, 'NZB fetch').message) }

  const status = httpStatusFailure(response, 'AmeNZB')
  if (status) throw new Error(status.message)

  const bytes = await readNzbBody(settings, response)
  // Indexers answer `t=get` failures with a Newznab error document, not a status code.
  const reported = detectXmlError(bytes)
  if (reported) throw new Error(classifyNewznabError(reported.code).message)
  validateNzbBytes(bytes)
  return bytes
}
