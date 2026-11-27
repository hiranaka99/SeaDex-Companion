// The two steps every Usenet indexer request goes through, a Newznab search and an NZB read, with the
// failure vocabulary they share, and the contract types of the hash indexers. Each client keeps only how it
// builds its request URLs and reads its items. Nothing here logs or returns credentials.

import { isRecord } from '../shared/guards.js'
import type { UsenetFailureCode, UsenetProvider } from '../shared/usenet-contracts.js'
import { detectXmlError, findNewznabError, listOf, parseProviderXml, validateNzbBytes } from './newznab-xml.js'
import {
  ProviderConfigError,
  ResponseTooLargeError,
  classifyFailure,
  decodeText,
  httpStatusFailure,
  providerEndpoint,
  providerRequest,
  readResponseCapped,
  readStreamCapped,
  retryAfterMs,
  safeText,
} from './provider-http.js'

const NZB_TIMEOUT_MS = 30_000
export const NZB_MAX_BYTES = 16 * 1024 * 1024

export interface UsenetSourceFile {
  name: string
  size: number
}

export interface UsenetMatch {
  provider: UsenetProvider
  entry_id: string
  /** lower-case 40-hex; validated against the requested hash when the provider returns one */
  source_hash: string
  title?: string
  /** preferred SABnzbd job display name */
  nzb_name?: string
  /** provider-reported whole-source payload bytes */
  total_bytes?: number
  /** Provider-reported total source file count, including undisclosed files. */
  file_count?: number
  /** present only when files_complete */
  files?: UsenetSourceFile[]
  /** provider supplied the full source manifest */
  files_complete: boolean
}

export type ProviderLookup =
  | { kind: 'match'; match: UsenetMatch }
  | { kind: 'processing'; provider: UsenetProvider; entry_id: string; source_hash: string; title?: string }
  | { kind: 'deleted'; provider: UsenetProvider; entry_id: string }
  | { kind: 'no_match' }
  /** message: safe bounded text, never HTML/provider markup and never a credential */
  | { kind: 'failed'; code: UsenetFailureCode; message: string; retry_after_ms?: number }

export interface ProviderSettings {
  /** No trailing slash; credential-bearing requests never leave this origin. */
  baseUrl: string
  apiKey?: string
  signal?: AbortSignal
}

/**
 * Transparently inflate a file-compressed NZB exactly once. `fetch` has already
 * applied Content-Encoding, so gzip magic in the body means the file itself is
 * compressed; decompressing again would corrupt it.
 */
async function gunzipOnce(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  // The DOM lib types the gzip sink as BufferSource rather than Uint8Array.
  const gzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  return await readStreamCapped(source.pipeThrough(gzip), maxBytes)
}

/** Who answers a Newznab request, for the failure messages and their scope. */
export interface NewznabSource {
  /** The indexer's name in a message: safe and short. */
  indexer: string
  /** The indexer is asked through Prowlarr's Newznab endpoint, so Prowlarr answers for it first. */
  viaProwlarr?: boolean
}

/**
 * Who a failure is attributed to. `indexer`: one indexer refused, is limited or could not answer, so only
 * that indexer is affected. `prowlarr`: Prowlarr itself did, so nothing can be asked through it.
 */
export type NewznabFailureScope = 'indexer' | 'prowlarr'

/** A failed Newznab request: a typed code, safe text that never quotes the indexer, and who is at fault. */
export interface NewznabFailure {
  code: UsenetFailureCode
  message: string
  retryAfterMs?: number
  scope: NewznabFailureScope
}

/** One Newznab search: where it goes and how much it may cost. The client builds the path and query. */
export interface NewznabSearchRequest extends NewznabSource {
  /** The configured origin. The path is appended to it and can never leave it. */
  baseUrl: string
  /** Path and query under the base URL. */
  path: string
  /** Extra request headers, such as Prowlarr's key. */
  headers?: Record<string, string>
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
}

/** What a search gave: the `<item>` elements of the feed, for the client to read, or why there are none. */
export type NewznabSearch = { kind: 'items'; items: unknown[] } | { kind: 'failed'; failure: NewznabFailure }

/** `<item>` elements of a Newznab answer. Undefined when the document is not Newznab RSS. */
function feedItems(document: unknown): unknown[] | undefined {
  if (!isRecord(document) || !isRecord(document.rss) || !('channel' in document.rss)) return undefined
  const channel = document.rss.channel
  // A channel without children parses to an empty string: the indexer answered and has nothing.
  if (channel === '') return []
  return isRecord(channel) ? listOf(channel.item) : undefined
}

/**
 * The one step every Newznab search goes through, for AmeNZB and Prowlarr's indexers alike: one GET on the
 * configured origin with no redirect, its status, a capped read, the XML, an error document, which is never
 * an empty answer whatever status it arrives with, and the feed items.
 */
export async function searchNewznab(
  request: NewznabSearchRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<NewznabSearch> {
  const signals: AbortSignal[] = [AbortSignal.timeout(request.timeoutMs)]
  if (request.signal) signals.push(request.signal)
  let response: Response
  try {
    response = await fetchImpl(providerEndpoint(request.baseUrl, request.path), {
      method: 'GET',
      headers: { accept: 'application/rss+xml, application/xml', ...request.headers },
      signal: AbortSignal.any(signals),
      redirect: 'error',
    })
  } catch (error) {
    return { kind: 'failed', failure: searchTransportFailure(error, request) }
  }
  const refused = refusingStatus(response, request)
  if (refused) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'failed', failure: refused }
  }
  let body: string
  try {
    body = decodeText(await readResponseCapped(response, request.maxBytes))
  } catch (error) {
    return { kind: 'failed', failure: searchTransportFailure(error, request) }
  }
  let document: unknown
  try {
    document = parseProviderXml(body)
  } catch {
    document = undefined
  }
  const reported = findNewznabError(document)
  if (reported) return { kind: 'failed', failure: newznabErrorFailure(reported.code, request) }
  if (!response.ok) {
    const answerer = request.viaProwlarr ? 'Prowlarr' : request.indexer
    const detail = `${answerer} returned HTTP ${response.status} for the search of ${request.indexer}`
    const retryAfter = retryAfterMs(response)
    if (response.status >= 500)
      return {
        kind: 'failed',
        failure: {
          code: 'server',
          message: detail,
          ...(retryAfter ? { retryAfterMs: retryAfter } : {}),
          scope: 'indexer',
        },
      }
    return { kind: 'failed', failure: { code: 'invalid_response', message: detail, scope: 'indexer' } }
  }
  const items = feedItems(document)
  if (!items)
    return {
      kind: 'failed',
      failure: {
        code: 'invalid_response',
        message: request.viaProwlarr
          ? `Prowlarr did not answer the search of ${request.indexer} with Newznab RSS. Check the Prowlarr URL.`
          : `${request.indexer} did not answer the search with Newznab RSS`,
        scope: 'indexer',
      },
    }
  return { kind: 'items', items }
}

/** A search that never got a usable answer. Only an unusable configured address is Prowlarr's own fault. */
function searchTransportFailure(error: unknown, request: NewznabSearchRequest): NewznabFailure {
  const { indexer } = request
  const failure = (code: UsenetFailureCode, message: string): NewznabFailure => ({ code, message, scope: 'indexer' })
  if (error instanceof ProviderConfigError)
    return {
      code: 'invalid_config',
      message: safeText(error.message),
      scope: request.viaProwlarr ? 'prowlarr' : 'indexer',
    }
  if (error instanceof ResponseTooLargeError)
    return failure('invalid_response', `The answer to the search of ${indexer} exceeded the byte limit`)
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError') return failure('timeout', `The search of ${indexer} timed out`)
  if (name === 'AbortError' || request.signal?.aborted)
    return failure('network', `The search of ${indexer} was cancelled`)
  return failure(
    'network',
    request.viaProwlarr
      ? `Could not reach Prowlarr for the search of ${indexer}`
      : `Could not reach ${indexer} for the search`,
  )
}

/** A status that answers the search by itself, before any body is read. */
function refusingStatus(response: Response, source: NewznabSource): NewznabFailure | null {
  const retryAfter = retryAfterMs(response)
  if (response.status === 401 || response.status === 403)
    return source.viaProwlarr
      ? {
          code: 'unauthorized',
          message: `Prowlarr returned HTTP ${response.status}. Check the Prowlarr API key.`,
          scope: 'prowlarr',
        }
      : {
          code: 'unauthorized',
          message: `${source.indexer} returned HTTP ${response.status} — check the API key and pinned API IP`,
          scope: 'indexer',
        }
  if (response.status === 410 && source.viaProwlarr)
    return { code: 'invalid_config', message: `${source.indexer} is turned off in Prowlarr`, scope: 'indexer' }
  if (response.status === 429)
    return {
      code: 'rate_limited',
      // Prowlarr answers 429 itself, without asking the indexer, while the indexer is at the query limit set
      // in Prowlarr or disabled after failures. `Retry-After` says when it will ask again.
      message: source.viaProwlarr
        ? `Prowlarr is not searching ${source.indexer} for now: it is at its query limit or disabled after failures`
        : `${source.indexer} rate limited the request`,
      ...(retryAfter ? { retryAfterMs: retryAfter } : {}),
      scope: 'indexer',
    }
  return null
}

/** Newznab's "download limit reached", next to the request limit, code 500. */
const NEWZNAB_DOWNLOAD_LIMIT = 501

/**
 * A Newznab error code of the named indexer as a failure of that indexer. Only the code is read: the
 * description can echo the request address, key included.
 */
export function newznabErrorFailure(code: number, source: NewznabSource): NewznabFailure {
  const failure = (failed: UsenetFailureCode, message: string): NewznabFailure => ({
    code: failed,
    message,
    scope: 'indexer',
  })
  const { indexer } = source
  switch (code) {
    case 100:
      // Through Prowlarr it is the indexer's own key, kept in Prowlarr.
      return source.viaProwlarr
        ? failure('unauthorized', `${indexer} refused its API key (code 100). Check the indexer in Prowlarr.`)
        : failure('unauthorized', 'Invalid API key or IP mismatch — check the key and pinned API IP')
    case 500:
      return failure(
        'rate_limited',
        `${indexer} API limit reached (code 500) — retry later or check the account allowance`,
      )
    case NEWZNAB_DOWNLOAD_LIMIT:
      return failure('rate_limited', `${indexer} reported that its download limit is reached (code ${code})`)
    case 200:
    case 201:
    case 202:
      return failure('invalid_response', `${indexer} rejected the request parameters (code ${code})`)
    case 300:
      return failure('server', `${indexer} refused the resource (code 300)`)
    default:
      return failure('server', `${indexer} reported an error (code ${code})`)
  }
}

/** What reading an NZB response gave: the validated, decompressed NZB, or why it is not one. */
export type NzbRead =
  | { kind: 'nzb'; bytes: Uint8Array }
  /** The body crossed `NZB_MAX_BYTES`, as sent or once decompressed. */
  | { kind: 'too_large' }
  /** The indexer answered with a Newznab error document instead of the file, whatever its status. */
  | { kind: 'error_document'; code: number }
  /** Not an NZB: undecompressable, malformed, or the wrong document. `message` is safe text. */
  | { kind: 'invalid'; message: string }

/**
 * The one step every NZB fetch goes through, for the hash indexers and Prowlarr grabs alike: the body is
 * read under the byte cap, a file-compressed NZB is inflated once, a Newznab error document is recognised
 * and what is left must be a valid NZB. A transport failure while reading is thrown, for the caller to
 * classify the way its other transport failures are.
 */
export async function readNzb(response: Response): Promise<NzbRead> {
  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, NZB_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return { kind: 'too_large' }
    throw error
  }
  try {
    bytes = await gunzipOnce(bytes, NZB_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return { kind: 'too_large' }
    return { kind: 'invalid', message: 'compressed NZB response could not be decompressed' }
  }
  // Checked once decompressed, so a compressed error document is recognised too.
  const reported = detectXmlError(bytes)
  if (reported) return { kind: 'error_document', code: reported.code }
  try {
    validateNzbBytes(bytes)
  } catch (error) {
    return { kind: 'invalid', message: safeText(error instanceof Error ? error.message : 'NZB response was not valid') }
  }
  return { kind: 'nzb', bytes }
}

/**
 * Fetch an NZB from a hash indexer's configured origin and return it validated. Every failure is thrown as
 * an `Error` whose message is safe text; an error document is classified without its description.
 */
export async function fetchProviderNzb(
  settings: ProviderSettings,
  path: string,
  provider: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await providerRequest(settings, path, 'application/octet-stream', NZB_TIMEOUT_MS, fetchImpl)
  } catch (error) {
    throw new Error(classifyFailure(error, settings, 'NZB fetch').message)
  }
  const status = httpStatusFailure(response, provider)
  if (status) throw new Error(status.message)
  let read: NzbRead
  try {
    read = await readNzb(response)
  } catch (error) {
    throw new Error(classifyFailure(error, settings, 'NZB fetch').message)
  }
  switch (read.kind) {
    case 'nzb':
      return read.bytes
    case 'too_large':
      throw new Error(new ResponseTooLargeError().message)
    case 'error_document':
      throw new Error(newznabErrorFailure(read.code, { indexer: provider }).message)
    case 'invalid':
      throw new Error(read.message)
  }
}
