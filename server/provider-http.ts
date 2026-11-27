// Bounded HTTP to a configured provider origin, shared by the Usenet clients: the request, its status, a
// capped read, `Retry-After` and safe failure text. Credential-bearing requests never leave the configured
// origin, and nothing here logs or returns credentials.

import { isRecord } from '../shared/guards.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import type { ProviderLookup, ProviderSettings } from './usenet-provider-types.js'

export const LOOKUP_TIMEOUT_MS = 15_000
export const LOOKUP_MAX_BYTES = 512 * 1024

const SAFE_MESSAGE_LIMIT = 200
const decoder = new TextDecoder('utf-8')

/** Base URL is unusable: report invalid_config rather than touching the network. */
export class ProviderConfigError extends Error {}
/** A response body crossed its byte cap while being read. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('provider response exceeded the byte limit')
  }
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
