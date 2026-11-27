// AnimeTosho NEW (feed.animetosho.net) client: hash lookup, capabilities probe
// and NZB retrieval. The NZB URL is always derived from the entry id on the
// configured base URL, never taken from the provider response.

import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'
import { NewznabXmlError, parseNewznabXml, safeByteSize, text } from './newznab-xml.js'
import {
  LOOKUP_MAX_BYTES,
  LOOKUP_TIMEOUT_MS,
  decodeText,
  httpStatusFailure,
  originRequest,
  readResponseCapped,
  safeText,
  transportFailure,
} from './indexer-http.js'
import type { OriginRequest, RequestFailure } from './indexer-http.js'
import { failedLookup, fetchProviderNzb } from './usenet-provider-types.js'
import type { ProviderLookup, ProviderSettings, UsenetMatch, UsenetSourceFile } from './usenet-provider-types.js'

/**
 * AnimeTosho hash lookups carry per-file hashes and media info (observed up to
 * ~45 KB per file), so complete batches routinely exceed the generic cap.
 */
export const ANIMETOSHO_LOOKUP_MAX_BYTES = 16 * 1024 * 1024
/** AnimeTosho entry ids are numeric and never interpolated raw into a URL. */
export const ANIMETOSHO_ENTRY_PATTERN = /^[0-9]+$/

const PROVIDER: UsenetProvider = 'animetosho'
/** How long an entry without an NZB is still expected to gain one. */
export const ANIMETOSHO_PROCESSING_WINDOW_MS = 48 * 60 * 60_000

/**
 * An entry without an NZB is pending only while AnimeTosho says so or while it
 * is recent. An entry without a usable timestamp keeps the conservative
 * "processing" reading.
 */
function isStillProcessing(entry: Record<string, unknown>): boolean {
  if (entry.status === 'processing') return true
  const seconds = typeof entry.timestamp === 'number' ? entry.timestamp : Number.NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return true
  return Date.now() - seconds * 1000 < ANIMETOSHO_PROCESSING_WINDOW_MS
}

function entryId(entry: Record<string, unknown>): string {
  return entry.id === undefined || entry.id === null ? '' : String(entry.id)
}

function sourceFile(value: unknown): UsenetSourceFile {
  const file = isRecord(value) ? value : {}
  const name = text(file.name) ?? text(file.filename) ?? ''
  const size = safeByteSize(file.size)
  return { name, size: size ?? Number.NaN }
}

/** A lookup-bounded GET on AnimeTosho's configured origin. */
function lookupRequest(settings: ProviderSettings, path: string, accept: string): OriginRequest {
  return { baseUrl: settings.baseUrl, path, accept, timeoutMs: LOOKUP_TIMEOUT_MS, signal: settings.signal }
}

/** A lookup or probe that never got a usable answer. */
function lookupFailure(error: unknown, settings: ProviderSettings): RequestFailure {
  return transportFailure(
    error,
    { timedOut: 'lookup timed out', cancelled: 'lookup cancelled', unreachable: 'provider lookup failed' },
    settings.signal,
  )
}

const failedFrom = (failure: RequestFailure): ProviderLookup => failedLookup(failure.code, failure.message)

function usableFile(file: UsenetSourceFile): boolean {
  return file.name !== '' && Number.isSafeInteger(file.size) && file.size >= 0
}

/**
 * Look up one source hash. The requested hash is the authority: a returned
 * `info_hash` must agree with it, and a disagreement is never echoed back.
 */
export async function lookupAnimeTosho(
  settings: ProviderSettings,
  hash: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderLookup> {
  const requested = hash.toLowerCase()
  if (!INFO_HASH_PATTERN.test(requested))
    return failedLookup('invalid_response', 'source hash was not a normalized SHA-1 digest')

  let response: Response
  try {
    response = await originRequest(
      lookupRequest(settings, `/json?show=torrent&hash=${requested}`, 'application/json'),
      fetchImpl,
    )
  } catch (error) {
    return failedFrom(lookupFailure(error, settings))
  }

  if (response.status === 404) return { kind: 'no_match' }
  const status = httpStatusFailure(response, 'AnimeTosho')
  if (status) return failedLookup(status.code, status.message, status.retryAfterMs)

  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, ANIMETOSHO_LOOKUP_MAX_BYTES)
  } catch (error) {
    return failedFrom(lookupFailure(error, settings))
  }

  let entry: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(decodeText(bytes))
    if (!isRecord(parsed)) return failedLookup('invalid_response', 'AnimeTosho response was not a JSON object')
    entry = parsed
  } catch {
    return failedLookup('invalid_response', 'AnimeTosho response was not valid JSON')
  }

  const returned = text(entry.info_hash)?.toLowerCase()
  if (returned !== undefined && returned !== requested)
    return failedLookup('invalid_response', 'AnimeTosho reported a different source hash')

  if (entry.deleted === true) return { kind: 'deleted', provider: PROVIDER, entry_id: entryId(entry) }
  if (entry.status === 'skipped') return { kind: 'no_match' }

  const id = entryId(entry)
  const title = text(entry.title)
  // NZBs appear some hours after the entry itself, so a recent entry without one
  // is still processing. An older one was never mirrored (AnimeTosho reports
  // status "unknown" for those) and is absent rather than pending.
  if (!entry.nzb_url) {
    return isStillProcessing(entry)
      ? { kind: 'processing', provider: PROVIDER, entry_id: id, source_hash: requested, title }
      : { kind: 'no_match' }
  }
  if (!ANIMETOSHO_ENTRY_PATTERN.test(id)) return failedLookup('invalid_response', 'AnimeTosho entry id was not usable')

  const files = Array.isArray(entry.files) ? entry.files.map(sourceFile) : undefined
  const fileCount = safeByteSize(entry.num_files)
  const filesComplete = files !== undefined && fileCount === files.length && files.length > 0 && files.every(usableFile)
  // A usable NZB reference is what makes an entry downloadable; unrelated DDL
  // processing (`status`) is not required to be complete.
  const match: UsenetMatch = {
    provider: PROVIDER,
    entry_id: id,
    source_hash: requested,
    title,
    nzb_name: text(entry.torrent_name) ?? title,
    total_bytes: safeByteSize(entry.total_size),
    ...(fileCount !== undefined ? { file_count: fileCount } : {}),
    files: filesComplete ? files : undefined,
    files_complete: filesComplete,
  }
  return { kind: 'match', match }
}

/**
 * Fetch the validated NZB of a matched entry. The URL is derived from the
 * entry id on the configured origin, so a provider-supplied absolute URL is
 * structurally impossible to fetch.
 */
export async function fetchAnimeToshoNzb(
  settings: ProviderSettings,
  match: UsenetMatch,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Uint8Array> {
  if (!ANIMETOSHO_ENTRY_PATTERN.test(match.entry_id)) throw new Error('AnimeTosho NZB reference was not usable')
  return await fetchProviderNzb(settings, `/nzb/${encodeURIComponent(match.entry_id)}`, 'AnimeTosho', fetchImpl)
}

/** Unauthenticated capabilities probe: proves the endpoint answers with Newznab-style XML. */
export async function testAnimeTosho(
  settings: ProviderSettings,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  let response: Response
  try {
    response = await originRequest(lookupRequest(settings, '/api?t=caps', 'application/xml'), fetchImpl)
  } catch (error) {
    throw new Error(lookupFailure(error, settings).message)
  }
  const status = httpStatusFailure(response, 'AnimeTosho')
  if (status) throw new Error(status.message)

  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, LOOKUP_MAX_BYTES)
  } catch (error) {
    throw new Error(lookupFailure(error, settings).message)
  }
  let document: unknown
  try {
    document = parseNewznabXml(decodeText(bytes))
  } catch (error) {
    throw new Error(
      error instanceof NewznabXmlError ? safeText(error.message) : 'AnimeTosho capabilities response could not be read',
    )
  }
  if (!isRecord(document) || !isRecord(document.caps)) {
    throw new Error('AnimeTosho capabilities check returned an unexpected document root')
  }
}
