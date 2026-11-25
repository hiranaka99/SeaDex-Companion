import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonObject } from './types.js'
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

/** JSON responses are never cached unless a header says otherwise. */
export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(body)
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
