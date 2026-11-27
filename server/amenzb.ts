// AmeNZB (Newznab) client: hash search, authenticated capability-free probe and
// NZB retrieval through `t=get`. The API key is only ever sent to the configured
// base URL and never appears in a message.

import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'
import { elementText, newznabAttributes, safeByteSize, text } from './newznab-xml.js'
import { LOOKUP_MAX_BYTES, LOOKUP_TIMEOUT_MS, failedLookup } from './provider-http.js'
import { fetchProviderNzb, searchNewznab } from './usenet-provider-types.js'
import type { ProviderLookup, ProviderSettings, UsenetMatch } from './usenet-provider-types.js'

/** AmeNZB (Newznab) guid / t=get ids. */
export const AMENZB_ENTRY_PATTERN = /^[0-9A-Za-z_-]+$/

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

/**
 * Entry id carried by a getnzb URL. The `.nzb` segment is preferred because the
 * documented URL shape appends the API key as the final path segment.
 */
function urlEntryId(url: string | undefined): string | undefined {
  if (!url) return undefined
  let segments: string[]
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean)
  } catch {
    return undefined
  }
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

/**
 * Run one hash search through the shared Newznab search step, which classifies everything the indexer
 * can answer with, including `<error>` documents that arrive with HTTP 200.
 */
async function search(settings: ProviderSettings, requested: string, fetchImpl: typeof fetch): Promise<ProviderLookup> {
  if (!settings.apiKey) return failedLookup('invalid_config', 'AmeNZB API key is not configured')
  const answer = await searchNewznab(
    {
      indexer: 'AmeNZB',
      baseUrl: settings.baseUrl,
      path: `/api?t=search&apikey=${encodeURIComponent(settings.apiKey)}&info_hash=${requested}`,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      maxBytes: LOOKUP_MAX_BYTES,
      signal: settings.signal,
    },
    fetchImpl,
  )
  if (answer.kind === 'failed') {
    const { failure } = answer
    return failedLookup(failure.code, failure.message, failure.retryAfterMs)
  }
  const rawItems = answer.items
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
    if (hashed.length === 1)
      return failedLookup('invalid_response', 'AmeNZB source hash did not match the requested hash')
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
export async function lookupAmeNZB(
  settings: ProviderSettings,
  hash: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderLookup> {
  const requested = hash.toLowerCase()
  if (!INFO_HASH_PATTERN.test(requested))
    return failedLookup('invalid_response', 'source hash was not a normalized SHA-1 digest')
  return await search(settings, requested, fetchImpl)
}

/**
 * Authenticated read-only search. Capabilities cannot validate a key/IP binding,
 * so this probes the hash endpoint instead and succeeds on any valid RSS answer.
 */
export async function testAmeNZB(
  settings: ProviderSettings,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const result = await search(settings, PROBE_HASH, fetchImpl)
  if (result.kind === 'failed') throw new Error(result.message)
}

/** Fetch and validate `t=get` for a matched entry from the configured origin. */
export async function fetchAmeNZBNzb(
  settings: ProviderSettings,
  match: UsenetMatch,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Uint8Array> {
  if (!settings.apiKey) throw new Error('AmeNZB API key is not configured')
  if (!AMENZB_ENTRY_PATTERN.test(match.entry_id)) throw new Error('AmeNZB NZB reference was not usable')
  const path = `/api?t=get&apikey=${encodeURIComponent(settings.apiKey)}&id=${encodeURIComponent(match.entry_id)}`
  // Indexers answer `t=get` failures with a Newznab error document, not a status code; the shared step rejects it.
  return await fetchProviderNzb(settings, path, 'AmeNZB', fetchImpl)
}
