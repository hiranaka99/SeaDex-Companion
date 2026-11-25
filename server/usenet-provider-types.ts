// Shared plumbing for the Usenet provider clients: contract types, byte-bounded
// streaming reads, gzip-once NZB handling and NZB/Newznab XML validation.
// Protocol specifics stay in each provider module. Nothing here logs or returns
// credentials.

import { isRecord } from '../shared/guards.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { UsenetFailureCode, UsenetProvider } from '../shared/usenet-contracts.js'

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

export const LOOKUP_TIMEOUT_MS = 15_000
export const NZB_TIMEOUT_MS = 30_000
export const LOOKUP_MAX_BYTES = 512 * 1024
/**
 * AnimeTosho hash lookups carry per-file hashes and media info (observed up to
 * ~45 KB per file), so complete batches routinely exceed the generic cap.
 */
export const ANIMETOSHO_LOOKUP_MAX_BYTES = 16 * 1024 * 1024
export const NZB_MAX_BYTES = 16 * 1024 * 1024

/** AnimeTosho entry ids are numeric and never interpolated raw into a URL. */
export const ANIMETOSHO_ENTRY_PATTERN = /^[0-9]+$/
/** AmeNZB (Newznab) guid / t=get ids. */
export const AMENZB_ENTRY_PATTERN = /^[0-9A-Za-z_-]+$/

const SAFE_MESSAGE_LIMIT = 200
/** Provider XML rejects declarations; NZBs allow only the public standard DTD. */
const DECLARATION_PATTERN = /<!DOCTYPE|<!ENTITY/i
const STANDARD_NZB_DOCTYPE =
  /<!DOCTYPE\s+nzb\s+PUBLIC\s+(["'])-\/\/newzBin\/\/DTD NZB 1\.1\/\/EN\1\s+(["'])https?:\/\/www\.newzbin\.com\/DTD\/nzb\/nzb-1\.1\.dtd\2\s*>/
/** Newznab XML is only ever inspected through the parser, never with regexes. */
const XML_PARSER_OPTIONS = { ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }
const xmlParser = new XMLParser(XML_PARSER_OPTIONS)
const decoder = new TextDecoder('utf-8')

/** Base URL is unusable: report invalid_config rather than touching the network. */
export class ProviderConfigError extends Error {}
/** A response body crossed its byte cap while being read. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('provider response exceeded the byte limit')
  }
}
/** Body was not XML the provider could have meant (malformed, empty, DTD). */
export class ProviderProtocolError extends Error {}

export interface NewznabError {
  code: number
}
/** Classified transport/HTTP failure: typed code plus safe text, no lookup kind. */
export interface ProviderFailure {
  code: UsenetFailureCode
  message: string
  retryAfterMs?: number
}

/** Upper bound for a provider-requested pause; a hostile or broken header cannot park lookups for days. */
const RETRY_AFTER_LIMIT_MS = 60 * 60_000

/** `Retry-After` as delta-seconds or an HTTP date, bounded; undefined when absent or unusable. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  if (!Number.isFinite(delay) || delay <= 0) return undefined
  return Math.min(delay, RETRY_AFTER_LIMIT_MS)
}

export function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

/** Trimmed non-empty provider string, or undefined when the field is absent/blank. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Provider-reported byte count only when it is a safe non-negative integer. */
export function safeByteSize(value: unknown): number | undefined {
  const size = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

/** Collapse markup/control characters and bound the length of any failure text. */
export function safeText(value: string, limit = SAFE_MESSAGE_LIMIT): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1)}…`
}

export function failedLookup(code: UsenetFailureCode, message: string, retryAfter?: number): ProviderLookup {
  return { kind: 'failed', code, message: safeText(message), ...(retryAfter ? { retry_after_ms: retryAfter } : {}) }
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Build a request URL that is guaranteed to stay on the configured provider origin. */
export function providerEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  let base: URL
  try {
    base = new URL(`${trimmed}/`)
  } catch {
    throw new ProviderConfigError('provider base URL is not a valid URL')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:')
    throw new ProviderConfigError('provider base URL must use http or https')
  // Our own path segments are appended to the configured endpoint, so a base URL
  // served from a subdirectory still works and no segment can escape the origin.
  let url: URL
  try {
    url = new URL(`${trimmed}${path}`)
  } catch {
    throw new ProviderConfigError('provider request URL is not valid')
  }
  if (url.origin !== base.origin) throw new ProviderConfigError('provider request would leave the configured origin')
  return url.toString()
}

/**
 * Bounded GET against the configured provider origin. Redirects are refused so an
 * API key can never follow a cross-origin hop, and a caller-supplied signal is
 * combined with the read timeout.
 */
export async function providerRequest(
  settings: ProviderSettings,
  path: string,
  accept: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = providerEndpoint(settings.baseUrl, path)
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (settings.signal) signals.push(settings.signal)
  return await fetchImpl(url, {
    method: 'GET',
    headers: { accept },
    signal: AbortSignal.any(signals),
    redirect: 'error',
  })
}

/** Map a transport/limit failure onto a typed code plus safe text. */
export function classifyFailure(
  error: unknown,
  settings: ProviderSettings,
  operation: 'lookup' | 'NZB fetch',
): ProviderFailure {
  if (error instanceof ProviderConfigError) return { code: 'invalid_config', message: safeText(error.message) }
  if (error instanceof ResponseTooLargeError) return { code: 'invalid_response', message: safeText(error.message) }
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError') return { code: 'timeout', message: `${operation} timed out` }
  if (name === 'AbortError' || settings.signal?.aborted) {
    return { code: 'network', message: operation === 'lookup' ? 'lookup cancelled' : `${operation} cancelled` }
  }
  return { code: 'network', message: `provider ${operation} failed` }
}

export function failedFrom(
  error: unknown,
  settings: ProviderSettings,
  operation: 'lookup' | 'NZB fetch',
): ProviderLookup {
  const failure = classifyFailure(error, settings, operation)
  return failedLookup(failure.code, failure.message)
}

/** Classify an unsuccessful HTTP status. Never reports a transport failure as absence. */
export function httpStatusFailure(response: Response, provider: string): ProviderFailure | null {
  if (response.ok) return null
  const detail = `${provider} returned HTTP ${response.status}`
  if (response.status === 401 || response.status === 403)
    return { code: 'unauthorized', message: `${detail} — check the API key and pinned API IP` }
  const retryAfter = retryAfterMs(response)
  if (response.status === 429)
    return {
      code: 'rate_limited',
      message: `${provider} rate limited the request`,
      ...(retryAfter ? { retryAfterMs: retryAfter } : {}),
    }
  if (response.status >= 500)
    return { code: 'server', message: detail, ...(retryAfter ? { retryAfterMs: retryAfter } : {}) }
  return { code: 'invalid_response', message: detail }
}

async function readStreamCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      // Enforced while reading so a response without Content-Length cannot buffer first.
      if (total > maxBytes) throw new ResponseTooLargeError()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error instanceof Error ? error : undefined).catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* the cancel above already released it */
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readResponseCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(declared) && declared > maxBytes) throw new ResponseTooLargeError()
  if (!response.body) return new Uint8Array(0)
  return await readStreamCapped(response.body, maxBytes)
}

/**
 * Transparently inflate a file-compressed NZB exactly once. `fetch` has already
 * applied Content-Encoding, so gzip magic in the body means the file itself is
 * compressed; decompressing again would corrupt it.
 */
export async function gunzipOnce(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
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

/** Read an NZB body under the byte cap with one round of file-decompression. */
export async function readNzbBody(settings: ProviderSettings, response: Response): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await readResponseCapped(response, NZB_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new Error(error.message)
    throw new Error(classifyFailure(error, settings, 'NZB fetch').message)
  }
  try {
    return await gunzipOnce(bytes, NZB_MAX_BYTES)
  } catch {
    throw new Error('compressed NZB response could not be decompressed')
  }
}

/**
 * `XMLParser` repairs unclosed and mismatched elements, so malformed markup is
 * checked with the same dependency's validator before it is trusted.
 */
function assertWellFormedXml(value: string): void {
  if (XMLValidator.validate(value) !== true) throw new ProviderProtocolError('provider response was not valid XML')
}

export function parseProviderXml(text: string): unknown {
  if (!text.trim()) throw new ProviderProtocolError('provider response was empty')
  if (DECLARATION_PATTERN.test(text)) throw new ProviderProtocolError('provider response declared a DTD or entity')
  assertWellFormedXml(text)
  try {
    return xmlParser.parse(text)
  } catch {
    throw new ProviderProtocolError('provider response was not valid XML')
  }
}

function newznabErrorFrom(value: unknown): NewznabError | null {
  if (!isRecord(value)) return null
  const code = Number(value['@_code'])
  if (!Number.isSafeInteger(code) || code <= 0) return null
  return { code }
}

function scanForError(node: unknown, depth: number): NewznabError | null {
  if (depth > 8) return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = scanForError(entry, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isRecord(node)) return null
  const direct = newznabErrorFrom(node.error)
  if (direct) return direct
  for (const key of Object.keys(node)) {
    if (key === 'error') continue
    const found = scanForError(node[key], depth + 1)
    if (found) return found
  }
  return null
}

/** Newznab sends `<error code description="...">` with HTTP 200; it is never "no match". */
export function findNewznabError(document: unknown): NewznabError | null {
  return scanForError(document, 0)
}

/** Cheap guard for NZB bodies that are really a Newznab error document. */
export function detectXmlError(bytes: Uint8Array): NewznabError | null {
  if (bytes.length === 0 || bytes.length > LOOKUP_MAX_BYTES || bytes[0] !== 0x3c) return null
  let document: unknown
  try {
    document = parseProviderXml(decodeText(bytes))
  } catch {
    return null
  }
  return findNewznabError(document)
}

/**
 * Classify a Newznab error code. Provider-supplied descriptions are never copied
 * into the message: an indexer can echo the full request URL, key included.
 */
export function classifyNewznabError(code: number): ProviderFailure {
  switch (code) {
    case 100:
      return { code: 'unauthorized', message: 'Invalid API key or IP mismatch — check the key and pinned API IP' }
    case 500:
      return {
        code: 'rate_limited',
        message: 'AmeNZB API limit reached (code 500) — retry later or check the account allowance',
      }
    case 200:
    case 201:
    case 202:
      return { code: 'invalid_response', message: `AmeNZB rejected the request parameters (code ${code})` }
    case 300:
      return { code: 'server', message: 'AmeNZB refused the resource (code 300)' }
    default:
      return { code: 'server', message: `AmeNZB reported an error (code ${code})` }
  }
}

/** Accept the standard public DTD without passing it to the XML parser. */
export function validateNzbBytes(bytes: Uint8Array): void {
  const value = decodeText(bytes)
  if (!value.trim()) throw new Error('NZB response was empty')
  const declaration = value.match(STANDARD_NZB_DOCTYPE)
  if (declaration && !/^(?:\s|<\?xml\s[^?]*\?>|<!--[\s\S]*?-->)*$/.test(value.slice(0, declaration.index))) {
    throw new Error('NZB response was not valid XML')
  }
  const xml = value.replace(STANDARD_NZB_DOCTYPE, '')
  if (DECLARATION_PATTERN.test(xml)) throw new Error('NZB response declared an unsupported DTD or entity')
  assertWellFormedXml(xml)
  let document: unknown
  try {
    document = xmlParser.parse(xml)
  } catch {
    throw new Error('NZB response was not valid XML')
  }
  const roots = isRecord(document) ? Object.keys(document).filter(key => !key.startsWith('?')) : []
  const nzb = isRecord(document) ? document.nzb : undefined
  if (roots.length !== 1 || roots[0] !== 'nzb' || !isRecord(nzb))
    throw new Error('NZB response had the wrong root element')
  const files = listOf(nzb.file)
  if (!files.length) throw new Error('NZB response contained no segments')
  for (const file of files) {
    const container = isRecord(file) && isRecord(file.segments) ? file.segments : undefined
    const segments = listOf(container?.segment)
    if (!segments.length) throw new Error('NZB response contained no segments')
    for (const segment of segments) {
      if (
        !isRecord(segment) ||
        !text(segment['#text']) ||
        safeByteSize(segment['@_bytes']) === undefined ||
        !Number.isSafeInteger(Number(segment['@_number'])) ||
        Number(segment['@_number']) <= 0
      ) {
        throw new Error('NZB response contained an invalid segment')
      }
    }
  }
}
