import { downloadJobs } from './download-jobs.js'
import { applyConfigUpdate, integrationConfig } from './config.js'
import { invalidateQbSnapshots } from './qbittorrent.js'
import { migrateConfig } from './config.js'
import { SECURITY_HEADERS, sendJson, readJson } from './http-response.js'
import { handleDownloadRequest } from './download-routes.js'
export { parseReleaseIndex } from './download-routes.js'
import { resetWebhookScanState, queueWebhookScan, webhookScanState, startScheduler, refreshAutocheckSchedule } from './scheduler.js'
export * from './scheduler.js'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'



import { createAuthArtworkCache } from './auth-artwork.js'
import { searchAniListTitles } from './anilist.js'
import { loadConfig, publicConfig, saveConfig, SECRET_CONFIG_KEYS } from './config.js'
import { ownedTorrentsSnapshot } from './download-store.js'
import { resultsForRequest } from './downloads.js'
import { loadScanHistory } from './history.js'
import { log, readLogTail } from './logging.js'
import { DATA_DIR, STATIC_DIR } from './paths.js'
import { testIntegration } from './qbittorrent.js'
import { clearScannedData, loadLastResults, scannedDataInfo } from './results.js'
import { runScan } from './scan.js'
import { autocheckState, cancelScan, getState, resultsRevision, setState } from './scan-state.js'
import { checkForUpdates } from './updates.js'
import { applyUserRulesToResults, exclusionRuleKey, loadUserRules, saveUserRules } from './user-rules.js'
import { AuthError, authState, expiredSessionCookie, isAuthenticated, login, logout, sessionCookie, setupAccount, updateAccount, verifyLoginCredentials } from './auth.js'
import type { Config, JsonObject } from './types.js'

function clientAddress(request: IncomingMessage): string { return request.socket.remoteAddress || 'unknown' }

const authArtwork = createAuthArtworkCache(resolve(DATA_DIR, 'auth-artwork.json'))

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

function serveStatic(pathname: string, response: ServerResponse, head = false): boolean {
  const relativeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(STATIC_DIR)
  const target = resolve(root, normalize(relativeFile))
  const containedPath = relative(root, target)
  if (containedPath.startsWith('..') || isAbsolute(containedPath)) return false
  if (!existsSync(target) || !statSync(target).isFile()) return false
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream' }
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

async function authenticateWebhook(request: IncomingMessage): Promise<void> {
  const authorization = String(request.headers.authorization || '')
  if (!authorization.startsWith('Basic ')) throw new AuthError(401, 'SeaDex login credentials required')
  let decoded = ''
  try { decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8') } catch { throw new AuthError(401, 'SeaDex login credentials required') }
  const separator = decoded.indexOf(':')
  if (separator < 0) throw new AuthError(401, 'SeaDex login credentials required')
  await verifyLoginCredentials(request, decoded.slice(0, separator), decoded.slice(separator + 1))
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || 'GET'
  const url = new URL(request.url || '/', 'http://localhost')
  const path = url.pathname

  if ((method === 'GET' || method === 'HEAD') && path === '/healthz') {
    if (method === 'HEAD') {
      response.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    return sendJson(response, 200, { status: 'ok' })
  }

  const webhookMatch = path.match(/^\/api\/webhooks\/(sonarr|radarr)$/)
  if (method === 'POST' && webhookMatch) {
    const source = webhookMatch[1] as 'sonarr' | 'radarr'
    await authenticateWebhook(request)
    const data = await readJson(request)
    const queued = queueWebhookScan(source, data.eventType, source === 'sonarr' ? data.series?.id : data.movie?.id)
    if (!queued.accepted) { response.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }); response.end(); return }
    return sendJson(response, 202, { accepted: true, action: 'scan_queued', due_at: queued.dueAt }, { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && path === '/api/auth/status') {
    return sendJson(response, 200, authState(request), { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && path === '/api/auth/artwork') {
    return sendJson(response, 200, { covers: await authArtwork.get() })
  }

  if (method === 'POST' && path === '/api/auth/setup') {
    const data = await readJson(request)
    const result = await setupAccount(request, data.username, data.password)
    log('INFO', `Administrator account created: ${result.username} (client: ${clientAddress(request)})`)
    return sendJson(response, 201, { setup_required: false, authenticated: true, username: result.username }, {
      'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, result.token),
    })
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const data = await readJson(request)
    const result = await login(request, data.username, data.password)
    log('INFO', `Login successful: ${result.username} (client: ${clientAddress(request)})`)
    return sendJson(response, 200, { setup_required: false, authenticated: true, username: result.username }, {
      'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, result.token),
    })
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const username = authState(request).username
    logout(request)
    log('INFO', `Logout${username ? `: ${username}` : ''} (client: ${clientAddress(request)})`)
    return sendJson(response, 200, { ok: true }, {
      'Cache-Control': 'no-store', 'Set-Cookie': expiredSessionCookie(request),
    })
  }

  if (path.startsWith('/api/') && !isAuthenticated(request)) {
    return sendJson(response, 401, { error: 'Authentication required' }, { 'Cache-Control': 'no-store' })
  }

  if (method === 'POST' && path === '/api/auth/account') {
    const data = await readJson(request)
    const result = await updateAccount(request, data.current_password, data.username, data.new_password)
    log('INFO', `Administrator account updated: ${result.username}; all other sessions revoked (client: ${clientAddress(request)})`)
    return sendJson(response, 200, { setup_required: false, authenticated: true, username: result.username }, {
      'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(request, result.token),
    })
  }

  if (method === 'GET' && path === '/api/config') return sendJson(response, 200, publicConfig(loadConfig()))

  if (method === 'GET' && path === '/api/history') return sendJson(response, 200, { scans: loadScanHistory() })

  if (method === 'GET' && path === '/api/anilist/search') {
    const query = String(url.searchParams.get('q') || '').trim()
    if (query.length < 2) return sendJson(response, 400, { error: 'Enter at least two characters' })
    return sendJson(response, 200, { results: await searchAniListTitles(query) })
  }

  if (method === 'POST' && path === '/api/mapping-overrides') {
    if (getState().running) return sendJson(response, 409, { error: 'Wait for the current scan to finish before changing a match' })
    const data = await readJson(request)
    if (getState().running) return sendJson(response, 409, { error: 'Wait for the current scan to finish before changing a match' })
    const libraryKey = String(data.library_key || '').trim()
    if (!libraryKey || !resultsForRequest().some((result) => result.library_key === libraryKey)) return sendJson(response, 404, { error: 'Library title not found — run a scan first' })
    const rules = loadUserRules()
    if (data.anilist_id == null) delete rules.mappings[libraryKey]
    else {
      const anilistId = Number(data.anilist_id)
      if (!Number.isInteger(anilistId) || anilistId <= 0) return sendJson(response, 400, { error: 'A valid AniList ID is required' })
      rules.mappings[libraryKey] = anilistId
    }
    saveUserRules(rules)
    log('INFO', `${data.anilist_id == null ? 'Removed manual AniList match' : `Set manual AniList match to ${rules.mappings[libraryKey]}`} for ${libraryKey}`)
    return sendJson(response, 200, { ok: true, anilist_id: rules.mappings[libraryKey] || null })
  }

  if (method === 'POST' && path === '/api/exclusions') {
    const data = await readJson(request)
    const libraryKey = String(data.library_key || '').trim()
    const season = Number(data.season || 0)
    const part = String(data.part || '').trim()
    if (!libraryKey || !Number.isInteger(season) || season < 0 || !resultsForRequest().some((result) => result.library_key === libraryKey && Number(result.season || 0) === season)) {
      return sendJson(response, 404, { error: 'Season not found — run a scan first' })
    }
    const rules = loadUserRules(); const exclusions = new Set(rules.exclusions)
    const key = exclusionRuleKey(libraryKey, season, part)
    if (data.excluded) exclusions.add(key); else exclusions.delete(key)
    rules.exclusions = [...exclusions]; saveUserRules(rules)
    log('INFO', `${data.excluded ? 'Ignored' : 'Restored'} ${libraryKey} season ${season || 'Movie'}${part ? ` ${part}` : ''} for bulk downloads and notifications`)
    return sendJson(response, 200, { ok: true, excluded: Boolean(data.excluded) })
  }

  if (method === 'GET' && path === '/api/scanned-data') return sendJson(response, 200, { ok: true, ...scannedDataInfo() })

  if (method === 'DELETE' && path === '/api/scanned-data') {
    if (getState().running) return sendJson(response, 409, { ok: false, error: 'Wait for the current scan to finish before clearing scanned data' })
    const cleared = clearScannedData()
    log('INFO', `Scanned data cleared (saved results: ${cleared.results}; AniList cache entries: ${cleared.cacheEntries})`)
    return sendJson(response, 200, { ok: true, cleared })
  }

  if (method === 'POST' && path === '/api/config') {
    const data = await readJson(request)
    let config: Config
    try { config = applyConfigUpdate(loadConfig(), data) }
    catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
    const clearedSecrets = new Set<string>(Array.isArray(data.clear_secrets) ? data.clear_secrets.filter((key: unknown): key is string => typeof key === 'string' && SECRET_CONFIG_KEYS.some(secret => secret === key)) : [])
    saveConfig(config)
    invalidateQbSnapshots()
    refreshAutocheckSchedule(config)
    const updatedSecrets = SECRET_CONFIG_KEYS.filter((key) => key in data && Boolean(String(data[key] || '').trim()))
    const integrationState = [
      `Sonarr=${config.sonarr_url && config.sonarr_key ? 'configured' : 'incomplete'}`,
      `Radarr=${config.radarr_url && config.radarr_key ? 'configured' : 'incomplete'}`,
      `qBittorrent=${config.qbittorrent_url && config.qbittorrent_user && config.qbittorrent_pass ? 'configured' : 'incomplete'}`,
      `Discord=${config.webhook ? 'configured' : 'incomplete'}`,
    ].join(', ')
    const secretChanges = [...updatedSecrets.map((key) => `${key} updated`), ...[...clearedSecrets].map((key) => `${key} cleared`)]
    log('INFO', `Configuration saved (${integrationState}; auto-check: ${config.scan_schedule.enabled ? config.scan_schedule.mode : 'disabled'}; notifications: ${config.notify_enabled ? 'enabled' : 'disabled'}; hidden titles: ${config.hidden.length}${secretChanges.length ? `; credentials: ${secretChanges.join(', ')}` : ''})`)
    return sendJson(response, 200, publicConfig(config))
  }

  if (method === 'POST' && path === '/api/config/test') {
    const data = await readJson(request)
    const service = String(data.service || '').toLowerCase()
    const submitted = data.config && typeof data.config === 'object' ? data.config as JsonObject : {}
    let config: Config
    try { config = integrationConfig(loadConfig(), service, submitted) }
    catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
    const started = Date.now()
    log('INFO', `Integration test started: ${service}`)
    try {
      const message = await testIntegration(config, service)
      log('INFO', `Integration test passed: ${service} in ${((Date.now() - started) / 1000).toFixed(1)}s (${message})`)
      return sendJson(response, 200, { ok: true, message })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Integration test failed: ${service} after ${((Date.now() - started) / 1000).toFixed(1)}s (${message})`)
      return sendJson(response, 502, { ok: false, error: message })
    }
  }

  if (method === 'GET' && path === '/api/status') {
    const state = getState()
    return sendJson(response, 200, {
      running: state.running, progress: state.progress, total: state.total, message: state.message,
      error: state.error, cancelled: state.cancelled, trigger: state.trigger, source_errors: state.source_errors,
      last_run: state.last_run || (!state.running ? loadLastResults()?.last_run ?? null : null), next_check: autocheckState.next,
      results_revision: resultsRevision(),
      webhook_scan: { queued: webhookScanState.dueAt !== null, due_at: webhookScanState.dueAt, sources: [...webhookScanState.sources] },
    })
  }

  if (method === 'GET' && path === '/api/update-check') {
    return sendJson(response, 200, await checkForUpdates(), { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && path === '/api/results') {
    const state = getState()
    const payload = state.running || state.results.length ? { results: state.results, last_run: state.last_run } : (loadLastResults() || { results: [], last_run: null })
    return sendJson(response, 200, { ...payload, results: applyUserRulesToResults(payload.results || []) })
  }

  if (method === 'GET' && path === '/api/logs') {
    const requested = Number.parseInt(url.searchParams.get('lines') || '500', 10)
    const count = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 500, 2000))
    const lines = readLogTail().slice(-count)
    return sendJson(response, 200, { lines, total: lines.length })
  }

  if (method === 'POST' && path === '/api/scan/cancel') {
    if (!cancelScan()) return sendJson(response, 409, { ok: false, error: 'No scan is running' })
    return sendJson(response, 202, { ok: true })
  }

  if (method === 'POST' && path === '/api/scan') {
    if (getState().running) {
      log('WARNING', 'Manual scan request ignored: a scan is already running')
      return sendJson(response, 409, { ok: false, error: 'Scan already running' })
    }
    let config: Config
    try { config = loadConfig() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Manual scan could not start: ${message}`)
      return sendJson(response, 500, { ok: false, error: message })
    }
    resetWebhookScanState(); autocheckState.pending = false
    setState({ running: true })
    void runScan(config, {}, 'manual')
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
    const result = resultsForRequest().find((item) => String(item.group_id ?? item.anilist_id ?? item.title) === key)
    log('INFO', `${data.hidden ? 'Hidden' : 'Restored'} library title: ${result?.title || key} (key: ${key}; hidden total: ${config.hidden.length})`)
    return sendJson(response, 200, { ok: true, hidden: config.hidden })
  }

  if (path.startsWith('/api/download')) return handleDownloadRequest(request, response, url)

  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && serveStatic(path, response, method === 'HEAD')) return
  sendJson(response, 404, { error: 'Not found' })
}

export function makeServer() {
  migrateConfig()
  downloadJobs.restore()
  return createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      const requestMethod = request.method || 'GET'
      const requestPath = new URL(request.url || '/', 'http://localhost').pathname
      if (error instanceof AuthError) {
        log('WARNING', `Request rejected: ${requestMethod} ${requestPath} → HTTP ${error.status} (client: ${clientAddress(request)}; ${message})`)
        if (!response.headersSent) sendJson(response, error.status, { error: message }, { 'Cache-Control': 'no-store' }); else response.end()
        return
      }
      log('ERROR', `Request failed: ${requestMethod} ${requestPath} (client: ${clientAddress(request)}; ${message})`)
      if (!response.headersSent) sendJson(response, 400, { error: message }); else response.end()
    })
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number.parseInt(process.env.PORT || '8080', 10)
  const scheduler = startScheduler()
  const server = makeServer()
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', `${signal} received; shutting down`)
    clearInterval(scheduler)
    const deadline = setTimeout(() => {
      log('ERROR', 'Graceful shutdown timed out')
      process.exit(1)
    }, 10_000)
    deadline.unref()
    server.close((error) => {
      clearTimeout(deadline)
      if (error) log('ERROR', `Shutdown failed: ${error.message}`)
      else log('INFO', 'Server stopped')
      process.exit(error ? 1 : 0)
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  server.listen(port, '0.0.0.0', () => {
    log('INFO', `Server listening on 0.0.0.0:${port} (Node ${process.version}; data: ${DATA_DIR}; static: ${STATIC_DIR})`)
    try {
      const config = loadConfig()
      const savedResults = loadLastResults()?.results?.length || 0
      const hiddenCount = Array.isArray(config.hidden) ? config.hidden.length : 0
      log('INFO', `Runtime state restored (saved results: ${savedResults}; tracked torrents: ${ownedTorrentsSnapshot().length}; hidden titles: ${hiddenCount}; auto-check: ${config.scan_schedule.enabled ? config.scan_schedule.mode : 'disabled'})`)
    } catch (error) {
      log('ERROR', `Runtime configuration could not be restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
