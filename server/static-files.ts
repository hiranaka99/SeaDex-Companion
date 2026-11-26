import { createReadStream, readdirSync, statSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { acceptedEncoding, compress, COMPRESS_MIN_BYTES, type ContentEncoding } from './compression.js'
import { SECURITY_HEADERS } from './http-response.js'
import { STATIC_DIR } from './paths.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Text formats and uncompressed fonts shrink well; images and WOFF fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.txt', '.svg', '.ttf'])
/** A larger file is not worth holding compressed in memory; none of the built frontend comes close. */
const COMPRESS_MAX_BYTES = 8 * 1024 * 1024

/** Compressed copies of the built frontend, made once per file version and encoding. */
const compressed = new Map<string, { version: string; body: Promise<Buffer> }>()

function compressedFile(file: string, stat: Stats, encoding: ContentEncoding): Promise<Buffer> {
  const key = `${encoding}\0${file}`
  const version = `${stat.size}:${stat.mtimeMs}`
  const cached = compressed.get(key)
  if (cached?.version === version) return cached.body
  const body = readFile(file).then(content => compress(content, encoding, 'small'))
  compressed.set(key, { version, body })
  // A failed read is not remembered, so the next request tries again.
  body.catch(() => {
    if (compressed.get(key)?.body === body) compressed.delete(key)
  })
  return body
}

/** Changes whenever the file does, so a browser can ask whether its copy is still current. */
const entityTag = (stat: Stats) => `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`

function tagMatches(header: string | undefined, tag: string): boolean {
  if (!header) return false
  const bare = (value: string) => value.trim().replace(/^W\//, '')
  return header.split(',').some(candidate => candidate.trim() === '*' || bare(candidate) === bare(tag))
}

/** The file's size and modification time; undefined for anything that is not a readable file. */
function fileStat(file: string): Stats | undefined {
  try {
    const stat = statSync(file, { throwIfNoEntry: false })
    return stat?.isFile() ? stat : undefined
  } catch {
    return undefined
  }
}

/** Serves one built frontend file; false when the path is not a file inside the static directory. */
export function serveStatic(pathname: string, response: ServerResponse, head = false): boolean {
  const relativeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(STATIC_DIR)
  const target = resolve(root, normalize(relativeFile))
  const containedPath = relative(root, target)
  if (containedPath.startsWith('..') || isAbsolute(containedPath)) return false
  const stat = fileStat(target)
  if (!stat) return false
  const extension = extname(target).toLowerCase()
  const compressible = COMPRESSIBLE.has(extension) && stat.size >= COMPRESS_MIN_BYTES && stat.size <= COMPRESS_MAX_BYTES
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    // Vite emits content-hashed files under /assets/ — they never change once built,
    // so let the browser cache them indefinitely. index.html and every other file keeps
    // its name across versions: the browser keeps a copy but asks whether it is still
    // current, so a new deploy is picked up on reload without downloading unchanged files again.
    'Cache-Control': relativeFile.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: entityTag(stat),
    ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
  }
  const request = response.req
  if (tagMatches(request?.headers['if-none-match'], headers.ETag)) {
    response.writeHead(304, headers)
    response.end()
    return true
  }
  const encoding = compressible ? acceptedEncoding(request?.headers['accept-encoding']) : null
  if (encoding) {
    compressedFile(target, stat, encoding).then(
      body => {
        response.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': String(body.length) })
        response.end(head ? undefined : body)
      },
      () => response.destroy(),
    )
    return true
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(stat.size) })
  if (head) response.end()
  else {
    const stream = createReadStream(target)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
  return true
}

/**
 * Compresses the application's script and stylesheet ahead of the first visit, off the main thread.
 * Compressing them as small as possible takes a moment that no page load should wait for.
 */
export function warmStaticCompression(): void {
  const assets = join(resolve(STATIC_DIR), 'assets')
  let names: string[]
  try {
    names = readdirSync(assets)
  } catch {
    return
  }
  for (const name of names) {
    const file = join(assets, name)
    const stat = fileStat(file)
    if (!stat || !COMPRESSIBLE.has(extname(file).toLowerCase())) continue
    if (stat.size < COMPRESS_MIN_BYTES || stat.size > COMPRESS_MAX_BYTES) continue
    for (const encoding of ['br', 'gzip'] as const) void compressedFile(file, stat, encoding).catch(() => {})
  }
}
