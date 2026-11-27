// Bounded HTTP to a configured origin, a Usenet indexer's or Prowlarr's: the request, what a failed request
// and an unsuccessful status mean, a capped read, `Retry-After` and safe failure text. Credential-bearing
// requests never leave the configured origin, and nothing here logs or returns credentials.

import { isRecord } from '../shared/guards.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'

export const LOOKUP_TIMEOUT_MS = 15_000
export const LOOKUP_MAX_BYTES = 512 * 1024

const SAFE_MESSAGE_LIMIT = 200
const decoder = new TextDecoder('utf-8')

/** Base URL is unusable: report invalid_config rather than touching the network. */
export class OriginConfigError extends Error {}
/** A response body crossed its byte cap while being read. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('provider response exceeded the byte limit')
  }
}

/** A failed request or an unsuccessful status: typed code plus safe text. */
export interface RequestFailure {
  code: UsenetFailureCode
  message: string
  retryAfterMs?: number
}

/** Upper bound for a requested pause; a hostile or broken header cannot park lookups for days. */
const RETRY_AFTER_LIMIT_MS = 60 * 60_000

/** `Retry-After` as delta-seconds or an HTTP date, bounded; undefined when absent or unusable. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  if (!Number.isFinite(delay) || delay <= 0) return undefined
  return Math.min(delay, RETRY_AFTER_LIMIT_MS)
}

/** Collapse markup/control characters and bound the length of any failure text. */
export function safeText(value: string, limit = SAFE_MESSAGE_LIMIT): string {
  const collapsed = value
    // oxlint-disable-next-line no-control-regex -- control characters are what this strips
    .replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1)}…`
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Build a request URL that is guaranteed to stay on the configured origin. */
export function originEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  let base: URL
  try {
    base = new URL(`${trimmed}/`)
  } catch {
    throw new OriginConfigError('provider base URL is not a valid URL')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:')
    throw new OriginConfigError('provider base URL must use http or https')
  // Our own path segments are appended to the configured endpoint, so a base URL
  // served from a subdirectory still works and no segment can escape the origin.
  let url: URL
  try {
    url = new URL(`${trimmed}${path}`)
  } catch {
    throw new OriginConfigError('provider request URL is not valid')
  }
  if (url.origin !== base.origin) throw new OriginConfigError('provider request would leave the configured origin')
  return url.toString()
}

/** One GET on a configured origin. */
export interface OriginRequest {
  /** The configured origin. The path is appended to it and can never leave it. */
  baseUrl: string
  /** Path and query under the base URL. */
  path: string
  accept: string
  /** Extra request headers, such as Prowlarr's key. */
  headers?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** `error` unless the caller follows redirects itself. */
  redirect?: 'error' | 'manual'
}

/**
 * Bounded GET against the configured origin. Redirects are refused unless the caller follows them itself, so
 * an API key can never follow a cross-origin hop, and a caller-supplied signal is combined with the timeout.
 */
export async function originRequest(request: OriginRequest, fetchImpl: typeof fetch): Promise<Response> {
  const url = originEndpoint(request.baseUrl, request.path)
  const signals: AbortSignal[] = [AbortSignal.timeout(request.timeoutMs)]
  if (request.signal) signals.push(request.signal)
  return await fetchImpl(url, {
    method: 'GET',
    headers: { accept: request.accept, ...request.headers },
    signal: AbortSignal.any(signals),
    redirect: request.redirect ?? 'error',
  })
}

/** How a request that never got a usable answer is described; the configuration error says its own words. */
export interface TransportWords {
  /** The body crossed its cap. Without it, the cap's own message. */
  tooLarge?: string
  timedOut: string
  cancelled: string
  unreachable: string
}

/**
 * What a request that never got a usable answer means: an unusable configured address, a body over its cap, a
 * timeout, a cancellation (also any failure once `signal` aborted) or an unreachable origin.
 */
export function transportFailure(error: unknown, words: TransportWords, signal?: AbortSignal): RequestFailure {
  if (error instanceof OriginConfigError) return { code: 'invalid_config', message: safeText(error.message) }
  if (error instanceof ResponseTooLargeError)
    return { code: 'invalid_response', message: safeText(words.tooLarge ?? error.message) }
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError') return { code: 'timeout', message: words.timedOut }
  if (name === 'AbortError' || signal?.aborted) return { code: 'network', message: words.cancelled }
  return { code: 'network', message: words.unreachable }
}

/** The failure codes an unsuccessful HTTP status maps to. */
export type StatusFailureCode = 'unauthorized' | 'rate_limited' | 'server' | 'invalid_response'

/** What an unsuccessful HTTP status means, for every indexer and Prowlarr alike. */
export function statusFailureCode(status: number): StatusFailureCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'invalid_response'
}

/**
 * An unsuccessful status as a failure: its code, the caller's message for that code or `detail`, and
 * `Retry-After` when a rate limit or a server failure names one.
 */
export function statusFailure(
  response: Response,
  detail: string,
  messages: Partial<Record<StatusFailureCode, string>> = {},
): RequestFailure {
  const code = statusFailureCode(response.status)
  const retryAfter = code === 'rate_limited' || code === 'server' ? retryAfterMs(response) : undefined
  return { code, message: messages[code] ?? detail, ...(retryAfter ? { retryAfterMs: retryAfter } : {}) }
}

/** An unsuccessful status of an indexer asked directly. Never reports a transport failure as absence. */
export function httpStatusFailure(response: Response, indexer: string): RequestFailure | null {
  if (response.ok) return null
  const detail = `${indexer} returned HTTP ${response.status}`
  return statusFailure(response, detail, {
    unauthorized: `${detail} — check the API key and pinned API IP`,
    rate_limited: `${indexer} rate limited the request`,
  })
}

export async function readStreamCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
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
