import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonObject } from './types.js'
import { acceptedEncoding, compress, COMPRESS_MIN_BYTES } from './compression.js'
import { HttpError } from './http-error.js'
import { errorMessage } from '../shared/errors.js'
import { isRecord } from '../shared/guards.js'

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

const MAX_BODY_BYTES = 1024 * 1024

export function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown'
}

/**
 * JSON responses are never cached unless a header says otherwise. Larger bodies are compressed for browsers
 * that accept it: scan results run to megabytes of repetitive text.
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const base = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  const encoding = body.length >= COMPRESS_MIN_BYTES ? acceptedEncoding(response.req?.headers['accept-encoding']) : null
  if (!encoding) {
    response.writeHead(status, { ...base, 'Content-Length': body.length, ...headers })
    response.end(body)
    return
  }
  // The headers go out now, so a later failure in the same request cannot start a second response.
  response.writeHead(status, { ...base, 'Content-Encoding': encoding, Vary: 'Accept-Encoding', ...headers })
  compress(body, encoding, 'fast').then(
    compressed => {
      if (!response.writableEnded) response.end(compressed)
    },
    () => response.destroy(),
  )
}

/** A bodiless success or redirect-free acknowledgement. */
export function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' })
  response.end()
}

/** The request body as a JSON object; an absent body reads as an empty object. */
export async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(400, 'Request body is too large')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new HttpError(400, errorMessage(error))
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'Request body must be a JSON object')
  return parsed
}
