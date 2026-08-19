import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG, LOG_FILE, STATIC_DIR, arrBaseUrl, autocheckState, getState, loadConfig, loadLastResults,
  log, normalizeQbStates, publicConfig, qbAddTorrent, qbGetTorrents, resultsForRequest, runScan,
  saveConfig, SECRET_CONFIG_KEYS, setState,
} from './app.js'
import {
  AuthError, authState, expiredSessionCookie, isAuthenticated, login, logout, sessionCookie,
  setupAccount,
} from './auth.js'
import type { Config, JsonObject } from './types.js'

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function findResult(key: string, releaseIndex: number): { result?: JsonObject; release?: JsonObject; error?: [number, string] } {
  const result = resultsForRequest().find((item) => item.key === key)
  if (!result) return { error: [404, 'Result not found — run a scan first'] }
  const releases = result.releases || []
  if (releaseIndex < 0 || releaseIndex >= releases.length) return { error: [404, 'Release not found'] }
  return { result, release: releases[releaseIndex] }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

function serveStatic(pathname: string, response: ServerResponse): boolean {
  const relativeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(STATIC_DIR)
  const target = resolve(root, normalize(relativeFile))
  const containedPath = relative(root, target)
  if (containedPath.startsWith('..') || isAbsolute(containedPath)) return false
  if (!existsSync(target) || !statSync(target).isFile()) return false
  response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream' })
  createReadStream(target).pipe(response)
  return true
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || 'GET'
  const url = new URL(request.url || '/', 'http://localhost')
  const path = url.pathname

  if (method === 'GET' && path === '/api/auth/status') {
    return sendJson(response, 200, authState(request), { 'Cache-Control': 'no-store' })
  }

  if (method === 'POST' && path === '/api/auth/setup') {
    const data = await readJson(request)
    const result = await setupAccount(data.username, data.password)
    log('INFO', `Administrator account created: ${result.username}`)
    return sendJson(response, 201, { setup_required: false, authenticated: true, username: result.username }, {
      'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, result.token),
    })
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const data = await readJson(request)
    const result = await login(request, data.username, data.password)
    log('INFO', `Login successful: ${result.username}`)
    return sendJson(response, 200, { setup_required: false, authenticated: true, username: result.username }, {
      'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, result.token),
    })
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    logout(request)
    return sendJson(response, 200, { ok: true }, {
      'Cache-Control': 'no-store', 'Set-Cookie': expiredSessionCookie(request),
    })
  }

  if (path.startsWith('/api/') && !isAuthenticated(request)) {
    return sendJson(response, 401, { error: 'Authentication required' }, { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && path === '/api/config') return sendJson(response, 200, publicConfig(loadConfig()))

  if (method === 'POST' && path === '/api/config') {
    const data = await readJson(request)
    const config = loadConfig()
    const clearedSecrets = new Set(
      Array.isArray(data.clear_secrets)
        ? data.clear_secrets.filter((key: unknown) => typeof key === 'string' && SECRET_CONFIG_KEYS.includes(key as any))
        : [],
    )
    for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG)) {
      if (SECRET_CONFIG_KEYS.includes(key as any)) {
        if (clearedSecrets.has(key)) config[key] = ''
        else if (key in data) {
          const replacement = data[key] == null ? '' : String(data[key]).trim()
          if (replacement) config[key] = replacement
        }
        continue
      }
      if (!(key in data)) continue
      const value = data[key]
      if (typeof defaultValue === 'boolean') config[key] = Boolean(value)
      else if (typeof defaultValue === 'number') {
        const parsed = Number.parseInt(String(value), 10)
        config[key] = Number.isFinite(parsed) ? Math.max(0, parsed) : defaultValue
      } else if (Array.isArray(defaultValue)) config[key] = Array.isArray(value) ? [...value] : []
      else if (key === 'sonarr_url' || key === 'radarr_url') config[key] = arrBaseUrl(value)
      else config[key] = value == null ? '' : String(value).trim()
    }
    saveConfig(config)
    log('INFO', `Config saved (autocheck=${config.autocheck_minutes}m, notify=${config.notify_enabled})`)
    return sendJson(response, 200, publicConfig(config))
  }

  if (method === 'GET' && path === '/api/status') {
    const state = getState()
    return sendJson(response, 200, {
      running: state.running, progress: state.progress, total: state.total, message: state.message,
      error: state.error, last_run: state.last_run, next_check: autocheckState.next,
    })
  }

  if (method === 'GET' && path === '/api/results') {
    const state = getState()
    return sendJson(response, 200, state.running || state.results.length ? { results: state.results, last_run: state.last_run } : (loadLastResults() || { results: [], last_run: null }))
  }

  if (method === 'GET' && path === '/api/logs') {
    const requested = Number.parseInt(url.searchParams.get('lines') || '500', 10)
    const count = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 500, 2000))
    let lines: string[] = []
    try { if (existsSync(LOG_FILE)) lines = readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1) } catch { /* empty log response */ }
    return sendJson(response, 200, { lines: lines.slice(-count), total: lines.length })
  }

  if (method === 'POST' && path === '/api/scan') {
    if (getState().running) return sendJson(response, 409, { ok: false, error: 'Scan already running' })
    setState({ running: true })
    void runScan(loadConfig())
    return sendJson(response, 200, { ok: true })
  }

  if (method === 'POST' && path === '/api/hidden') {
    const data = await readJson(request)
    const key = String(data.key || '').trim()
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    const config = loadConfig()
    const hidden = new Set(config.hidden || [])
    if (data.hidden) hidden.add(key); else hidden.delete(key)
    config.hidden = [...hidden].sort(); saveConfig(config)
    return sendJson(response, 200, { ok: true, hidden: config.hidden })
  }

  if (method === 'POST' && path === '/api/download') {
    const data = await readJson(request)
    const key = String(data.key || '').trim()
    const releaseIndex = Number.parseInt(String(data.release ?? 0), 10) || 0
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    const hashes = (found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash))
    if (!hashes.length) return sendJson(response, 400, { ok: false, error: 'No magnet available for this release (private tracker)' })
    const config = loadConfig()
    const category = String(config[`${String(found.result!.arr).toLowerCase()}_category`] || '').trim()
    try {
      for (const hash of hashes) await qbAddTorrent(config, `magnet:?xt=urn:btih:${hash}`, category)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Download failed for ${key} (release ${releaseIndex}): ${message}`)
      return sendJson(response, 502, { ok: false, error: message })
    }
    log('INFO', `Sent to qBittorrent: ${key} release ${releaseIndex}, ${hashes.length} torrent(s) (category: ${category || '-'})`)
    return sendJson(response, 200, { ok: true })
  }

  if (method === 'GET' && path === '/api/download_progress') {
    const key = String(url.searchParams.get('key') || '').trim()
    const releaseIndex = Number.parseInt(url.searchParams.get('release') || '0', 10) || 0
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    const hashes = (found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash))
    if (!hashes.length) return sendJson(response, 400, { ok: false, error: 'No magnet available for this release' })
    let torrents: JsonObject[]
    try { torrents = await qbGetTorrents(loadConfig(), hashes) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Download progress check failed for ${key} (release ${releaseIndex}): ${message}`)
      return sendJson(response, 502, { ok: false, error: message })
    }
    let totalSize = 0; let downloaded = 0; let speed = 0
    const states: string[] = []
    for (const torrent of torrents) {
      const size = torrent.size || torrent.total_size || 0; const progress = torrent.progress || 0
      totalSize += size; downloaded += Math.trunc(size * progress); speed += torrent.dlspeed || 0; states.push(torrent.state || 'unknown')
    }
    const foundAny = torrents.length > 0
    const progress = totalSize > 0 ? downloaded / totalSize : 0
    let state = normalizeQbStates(states); if (foundAny && totalSize > 0 && progress >= 0.999) state = 'complete'
    return sendJson(response, 200, { ok: true, found: foundAny, progress: Math.round(progress * 10_000) / 10_000, downloaded, total_size: totalSize, speed, state })
  }

  if (method === 'GET' && !path.startsWith('/api/') && serveStatic(path, response)) return
  sendJson(response, 404, { error: 'Not found' })
}

export function makeServer() {
  return createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AuthError) {
        if (!response.headersSent) sendJson(response, error.status, { error: message }, { 'Cache-Control': 'no-store' }); else response.end()
        return
      }
      log('ERROR', `Request failed: ${message}`)
      if (!response.headersSent) sendJson(response, 400, { error: message }); else response.end()
    })
  })
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const config = loadConfig(); const minutes = config.autocheck_minutes || 0
        if (minutes <= 0) { autocheckState.next = null; return }
        const now = Date.now() / 1000; const interval = minutes * 60
        if (now - autocheckState.last >= interval) {
          autocheckState.last = now; autocheckState.next = now + interval
          if (getState().running) { log('INFO', 'Auto-check due, but a scan is already running — skipping'); return }
          log('INFO', `Auto-check triggered (interval ${minutes} min)`); await runScan(config)
        }
      } catch (error) { log('ERROR', `Scheduler error: ${error instanceof Error ? error.message : String(error)}`) }
    })()
  }, 30_000)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number.parseInt(process.env.PORT || '8080', 10)
  startScheduler()
  makeServer().listen(port, '0.0.0.0', () => log('INFO', `Server starting on 0.0.0.0:${port} (data dir: ${process.env.DATA_DIR || process.cwd()})`))
}
