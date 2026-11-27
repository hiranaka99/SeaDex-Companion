// AnimeTosho NEW (feed.animetosho.net) client: hash lookup, capabilities probe
// and NZB retrieval. The NZB URL is always derived from the entry id on the
// configured base URL, never taken from the provider response.

import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'
import {
  ANIMETOSHO_ENTRY_PATTERN,
  ANIMETOSHO_LOOKUP_MAX_BYTES,
  LOOKUP_MAX_BYTES,
  LOOKUP_TIMEOUT_MS,
  ProviderProtocolError,
  ResponseTooLargeError,
  classifyFailure,
  decodeText,
  failedFrom,
  failedLookup,
  fetchProviderNzb,
  httpStatusFailure,
  parseProviderXml,
  providerRequest,
  readResponseCapped,
  safeByteSize,
  safeText,
  text,
} from './usenet-provider-types.js'
import type { ProviderLookup, ProviderSettings, UsenetMatch, UsenetSourceFile } from './usenet-provider-types.js'

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
    response = await providerRequest(
      settings,
      `/json?show=torrent&hash=${requested}`,
      'application/json',
      LOOKUP_TIMEOUT_MS,
      fetchImpl,
    )
  } catch (error) {
    return failedFrom(error, settings, 'lookup')
  }

  if (response.status === 404) return { kind: 'no_match' }
  const status = httpStatusFailure(response, 'AnimeTosho')
  if (status) return failedLookup(status.code, status.message, status.retryAfterMs)

  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, ANIMETOSHO_LOOKUP_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return failedLookup('invalid_response', safeText(error.message))
    return failedFrom(error, settings, 'lookup')
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
    response = await providerRequest(settings, '/api?t=caps', 'application/xml', LOOKUP_TIMEOUT_MS, fetchImpl)
  } catch (error) {
    throw new Error(classifyFailure(error, settings, 'lookup').message)
  }
  const status = httpStatusFailure(response, 'AnimeTosho')
  if (status) throw new Error(status.message)

  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, LOOKUP_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new Error(safeText(error.message))
    throw new Error(classifyFailure(error, settings, 'lookup').message)
  }
  let document: unknown
  try {
    document = parseProviderXml(decodeText(bytes))
  } catch (error) {
    throw new Error(
      error instanceof ProviderProtocolError
        ? safeText(error.message)
        : 'AnimeTosho capabilities response could not be read',
    )
  }
  if (!isRecord(document) || !isRecord(document.caps)) {
    throw new Error('AnimeTosho capabilities check returned an unexpected document root')
  }
}
