import { createReadStream, existsSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { SECURITY_HEADERS } from './http-response.js'
import { STATIC_DIR } from './paths.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Serves one built frontend file; false when the path is not a file inside the static directory. */
export function serveStatic(pathname: string, response: ServerResponse, head = false): boolean {
  const relativeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(STATIC_DIR)
  const target = resolve(root, normalize(relativeFile))
  const containedPath = relative(root, target)
  if (containedPath.startsWith('..') || isAbsolute(containedPath)) return false
  if (!existsSync(target) || !statSync(target).isFile()) return false
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream',
  }
  // Vite emits content-hashed files under /assets/ — they never change once built,
  // so let the browser cache them indefinitely. index.html (and any non-hashed file)
  // must stay uncached so new deploys are picked up on reload.
  if (relativeFile.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  response.writeHead(200, headers)
  if (head) response.end()
  else {
    const stream = createReadStream(target)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
  return true
}
