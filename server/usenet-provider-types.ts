// The two steps every Usenet indexer request goes through, a Newznab search and an NZB read, with the
// failure vocabulary they share, and the contract types of the hash indexers. Both steps answer with what
// they read or a `NewznabFailure`, so each client keeps only how it builds its request URLs, reads its items
// and turns a failure into its own error. Nothing here logs or returns credentials.

import { isRecord } from '../shared/guards.js'
import type { UsenetFailureCode, UsenetProvider } from '../shared/usenet-contracts.js'
import { detectXmlError, findNewznabError, listOf, parseNewznabXml, validateNzbBytes } from './newznab-xml.js'
import {
  LOOKUP_MAX_BYTES,
  LOOKUP_TIMEOUT_MS,
  ResponseTooLargeError,
  decodeText,
  httpStatusFailure,
  originRequest,
  readResponseCapped,
  readStreamCapped,
  safeText,
  statusFailure,
  statusFailureCode,
  transportFailure,
} from './indexer-http.js'
import type { TransportWords } from './indexer-http.js'

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

/** A failed hash-indexer lookup, its text made safe. */
export function failedLookup(code: UsenetFailureCode, message: string, retryAfter?: number): ProviderLookup {
  return { kind: 'failed', code, message: safeText(message), ...(retryAfter ? { retry_after_ms: retryAfter } : {}) }
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
  /** The bounds of a hash-indexer lookup unless given; a search through Prowlarr names its own. */
  timeoutMs?: number
  maxBytes?: number
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
  const failed = (failure: NewznabFailure): NewznabSearch => ({ kind: 'failed', failure })
  let response: Response
  try {
    response = await originRequest(
      {
        baseUrl: request.baseUrl,
        path: request.path,
        accept: 'application/rss+xml, application/xml',
        headers: request.headers,
        timeoutMs: request.timeoutMs ?? LOOKUP_TIMEOUT_MS,
        signal: request.signal,
      },
      fetchImpl,
    )
  } catch (error) {
    return failed(searchTransportFailure(error, request))
  }
  const refused = refusingStatus(response, request)
  if (refused) {
    await response.body?.cancel().catch(() => undefined)
    return failed(refused)
  }
  let body: string
  try {
    body = decodeText(await readResponseCapped(response, request.maxBytes ?? LOOKUP_MAX_BYTES))
  } catch (error) {
    return failed(searchTransportFailure(error, request))
  }
  let document: unknown
  try {
    document = parseNewznabXml(body)
  } catch {
    document = undefined
  }
  const reported = findNewznabError(document)
  if (reported) return failed(newznabErrorFailure(reported.code, request))
  if (!response.ok) {
    // What is left is a server failure or a status that is no answer.
    const answerer = request.viaProwlarr ? 'Prowlarr' : request.indexer
    const detail = `${answerer} returned HTTP ${response.status} for the search of ${request.indexer}`
    return failed({ ...statusFailure(response, detail), scope: 'indexer' })
  }
  const items = feedItems(document)
  if (!items)
    return failed({
      code: 'invalid_response',
      message: request.viaProwlarr
        ? `Prowlarr did not answer the search of ${request.indexer} with Newznab RSS. Check the Prowlarr URL.`
        : `${request.indexer} did not answer the search with Newznab RSS`,
      scope: 'indexer',
    })
  return { kind: 'items', items }
}

/** A search that never got a usable answer. Only an unusable configured address is Prowlarr's own fault. */
function searchTransportFailure(error: unknown, request: NewznabSearchRequest): NewznabFailure {
  const { indexer } = request
  const failure = transportFailure(
    error,
    {
      tooLarge: `The answer to the search of ${indexer} exceeded the byte limit`,
      timedOut: `The search of ${indexer} timed out`,
      cancelled: `The search of ${indexer} was cancelled`,
      unreachable: request.viaProwlarr
        ? `Could not reach Prowlarr for the search of ${indexer}`
        : `Could not reach ${indexer} for the search`,
    },
    request.signal,
  )
  return { ...failure, scope: failure.code === 'invalid_config' && request.viaProwlarr ? 'prowlarr' : 'indexer' }
}

/**
 * A status that answers the search by itself, before any body is read: a refused key, a rate limit, or an
 * indexer turned off in Prowlarr.
 */
function refusingStatus(response: Response, source: NewznabSource): NewznabFailure | null {
  if (response.ok) return null
  if (response.status === 410 && source.viaProwlarr)
    return { code: 'invalid_config', message: `${source.indexer} is turned off in Prowlarr`, scope: 'indexer' }
  const code = statusFailureCode(response.status)
  if (code !== 'unauthorized' && code !== 'rate_limited') return null
  if (!source.viaProwlarr) return { ...httpStatusFailure(response, source.indexer)!, scope: 'indexer' }
  const failure = statusFailure(response, `Prowlarr returned HTTP ${response.status}`, {
    unauthorized: `Prowlarr returned HTTP ${response.status}. Check the Prowlarr API key.`,
    // Prowlarr answers 429 itself, without asking the indexer, while the indexer is at the query limit set
    // in Prowlarr or disabled after failures. `Retry-After` says when it will ask again.
    rate_limited: `Prowlarr is not searching ${source.indexer} for now: it is at its query limit or disabled after failures`,
  })
  // A refused key is Prowlarr's own; a limit is the indexer's.
  return { ...failure, scope: code === 'unauthorized' ? 'prowlarr' : 'indexer' }
}

/** Newznab's "download limit reached", next to the request limit, code 500. */
const NEWZNAB_DOWNLOAD_LIMIT = 501

/**
 * A Newznab error code of the named indexer as a failure of that indexer. Only the code is read: the
 * description can echo the request address, key included.
 */
function newznabErrorFailure(code: number, source: NewznabSource): NewznabFailure {
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

/**
 * A Newznab error document sent in place of a file, an NZB or a .torrent, as a failure of `source`. Null for
 * anything else. Only the code is read.
 */
export function errorDocumentFailure(bytes: Uint8Array, source: NewznabSource): NewznabFailure | null {
  const reported = detectXmlError(bytes)
  return reported ? newznabErrorFailure(reported.code, source) : null
}

/** What reading an NZB response gave: the validated, decompressed NZB, or why it is not one. */
export type NzbRead = { kind: 'nzb'; bytes: Uint8Array } | { kind: 'failed'; failure: NewznabFailure }

/**
 * The one step every NZB fetch goes through, for the hash indexers and Prowlarr grabs alike: the body is
 * read under the byte cap, a file-compressed NZB is inflated once, a Newznab error document is read by its
 * code and what is left must be a valid NZB. Every failure is the indexer's. A transport failure while
 * reading is thrown, for the caller to classify the way its other transport failures are.
 */
export async function readNzb(response: Response, source: NewznabSource): Promise<NzbRead> {
  const failed = (message: string): NzbRead => ({
    kind: 'failed',
    failure: { code: 'invalid_response', message: safeText(message), scope: 'indexer' },
  })
  const tooLarge = () => failed(`${source.indexer} sent an NZB over the size limit`)
  const invalid = (detail: string) => failed(`${source.indexer} did not send a valid NZB: ${detail}`)
  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, NZB_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return tooLarge()
    throw error
  }
  try {
    bytes = await gunzipOnce(bytes, NZB_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return tooLarge()
    return invalid('compressed NZB response could not be decompressed')
  }
  // Checked once decompressed, so a compressed error document is recognised too.
  const reported = errorDocumentFailure(bytes, source)
  if (reported) return { kind: 'failed', failure: reported }
  try {
    validateNzbBytes(bytes)
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'NZB response was not valid')
  }
  return { kind: 'nzb', bytes }
}

/** How a hash indexer's NZB fetch that never got an answer is described. */
const NZB_FETCH: TransportWords = {
  timedOut: 'NZB fetch timed out',
  cancelled: 'NZB fetch cancelled',
  unreachable: 'provider NZB fetch failed',
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
    response = await originRequest(
      {
        baseUrl: settings.baseUrl,
        path,
        accept: 'application/octet-stream',
        timeoutMs: NZB_TIMEOUT_MS,
        signal: settings.signal,
      },
      fetchImpl,
    )
  } catch (error) {
    throw new Error(transportFailure(error, NZB_FETCH, settings.signal).message)
  }
  const status = httpStatusFailure(response, provider)
  if (status) throw new Error(status.message)
  let read: NzbRead
  try {
    read = await readNzb(response, { indexer: provider })
  } catch (error) {
    throw new Error(transportFailure(error, NZB_FETCH, settings.signal).message)
  }
  if (read.kind === 'failed') throw new Error(read.failure.message)
  return read.bytes
}
