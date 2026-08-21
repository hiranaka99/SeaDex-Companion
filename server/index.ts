import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR, DEFAULT_CONFIG, STATIC_DIR, applyUserRulesToResults, arrBaseUrl, autocheckState, bulkDownloadBatchStatus, bulkDownloadTargets, clearScannedData, exclusionRuleKey, forgetOwnedTorrents,
  finishBulkDownloadBatch, getState, indexResultReleases, loadConfig, loadLastResults, loadScanHistory, loadUserRules, log, normalizeQbStates, ownedTorrentsSnapshot,
  publicConfig, qbAddTorrent, qbBulkAddTorrents, qbControlTorrents, qbGetTorrents, readLogTail, recordOwnedTorrents, resetBulkDownloadBatch,
  resultsForRequest, runScan, saveConfig, saveUserRules, scannedDataInfo, searchAniListTitles, SECRET_CONFIG_KEYS, settleBulkDownloadBatch, setState, testIntegration,
} from './app.js'
import {
  AuthError, authState, expiredSessionCookie, isAuthenticated, login, logout, sessionCookie,
  setupAccount, updateAccount,
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

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown'
}

function resultLabel(result: JsonObject): string {
  const season = result.season ? ` S${String(result.season).padStart(2, '0')}` : ' (Movie)'
  return `${String(result.title || result.key || 'Unknown title')}${season}`
}

function releaseDetails(result: JsonObject, release: JsonObject, releaseIndex: number): string {
  return `${resultLabel(result)} [key: ${result.key}; release: ${releaseIndex}; group: ${release.releaseGroup || '-'}; tracker: ${release.tracker || '-'}]`
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / (1024 ** unit)
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

const downloadProgressStates = new Map<string, string>()
const downloadProgressFailures = new Map<string, { message: string; lastLogged: number; suppressed: number }>()
let bulkOperationActive = false

function summarizeTorrentProgress(torrents: JsonObject[]): JsonObject {
  let totalSize = 0; let downloaded = 0; let speed = 0
  const states: string[] = []
  for (const torrent of torrents) {
    const size = Number(torrent.size || torrent.total_size || 0); const progress = Number(torrent.progress || 0)
    totalSize += size; downloaded += Math.trunc(size * progress); speed += Number(torrent.dlspeed || 0); states.push(String(torrent.state || 'unknown'))
  }
  const found = torrents.length > 0
  const progress = totalSize > 0 ? downloaded / totalSize : 0
  let state = normalizeQbStates(states)
  if (found && totalSize > 0 && progress >= 0.999) state = 'complete'
  return { ok: true, found, progress: Math.round(progress * 10_000) / 10_000, downloaded, total_size: totalSize, speed, state }
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
  const headers: Record<string, string> = { 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream' }
  // Vite emits content-hashed files under /assets/ — they never change once built,
  // so let the browser cache them indefinitely. index.html (and any non-hashed file)
  // must stay uncached so new deploys are picked up on reload.
  if (relativeFile.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  response.writeHead(200, headers)
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
    refreshAutocheckSchedule(config)
    const updatedSecrets = SECRET_CONFIG_KEYS.filter((key) => key in data && Boolean(String(data[key] || '').trim()))
    const integrationState = [
      `Sonarr=${config.sonarr_url && config.sonarr_key ? 'configured' : 'incomplete'}`,
      `Radarr=${config.radarr_url && config.radarr_key ? 'configured' : 'incomplete'}`,
      `qBittorrent=${config.qbittorrent_url && config.qbittorrent_user && config.qbittorrent_pass ? 'configured' : 'incomplete'}`,
      `Discord=${config.webhook ? 'configured' : 'incomplete'}`,
    ].join(', ')
    const secretChanges = [...updatedSecrets.map((key) => `${key} updated`), ...[...clearedSecrets].map((key) => `${key} cleared`)]
    log('INFO', `Configuration saved (${integrationState}; auto-check: ${config.autocheck_minutes}m; notifications: ${config.notify_enabled ? 'enabled' : 'disabled'}; hidden titles: ${config.hidden.length}${secretChanges.length ? `; credentials: ${secretChanges.join(', ')}` : ''})`)
    return sendJson(response, 200, publicConfig(config))
  }

  if (method === 'POST' && path === '/api/config/test') {
    const data = await readJson(request)
    const service = String(data.service || '').toLowerCase()
    const submitted = data.config && typeof data.config === 'object' ? data.config as JsonObject : {}
    const config = loadConfig()
    const serviceFields: Record<string, string[]> = {
      sonarr: ['sonarr_url', 'sonarr_key'],
      radarr: ['radarr_url', 'radarr_key'],
      qbittorrent: ['qbittorrent_url', 'qbittorrent_user', 'qbittorrent_pass'],
      discord: ['webhook'],
    }
    const fields = serviceFields[service]
    if (!fields) return sendJson(response, 400, { error: 'Unknown integration' })
    for (const key of fields) {
      if (!(key in submitted)) continue
      const value = submitted[key] == null ? '' : String(submitted[key]).trim()
      if (SECRET_CONFIG_KEYS.includes(key as any) && !value) continue
      config[key] = key === 'sonarr_url' || key === 'radarr_url' ? arrBaseUrl(value) : value
    }
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
      error: state.error, last_run: state.last_run, next_check: autocheckState.next,
    })
  }

  if (method === 'GET' && path === '/api/results') {
    const state = getState()
    const payload = state.running || state.results.length ? { results: state.results, last_run: state.last_run } : (loadLastResults() || { results: [], last_run: null })
    return sendJson(response, 200, { ...payload, results: applyUserRulesToResults(payload.results || []) })
  }

  if (method === 'GET' && path === '/api/logs') {
    const requested = Number.parseInt(url.searchParams.get('lines') || '500', 10)
    const count = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 500, 2000))
    // Only a bounded tail of the log file is read (see readLogTail), so polling
    // this endpoint stays cheap as the log grows and survives log rotation.
    const lines = readLogTail().slice(-count)
    return sendJson(response, 200, { lines, total: lines.length })
  }

  if (method === 'POST' && path === '/api/scan') {
    if (getState().running) {
      log('WARNING', 'Manual scan request ignored: a scan is already running')
      return sendJson(response, 409, { ok: false, error: 'Scan already running' })
    }
    log('INFO', 'Manual scan requested')
    let config: Config
    try { config = loadConfig() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Manual scan could not start: ${message}`)
      return sendJson(response, 500, { ok: false, error: message })
    }
    setState({ running: true })
    void runScan(config)
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
    const selectedFiles = Array.isArray(found.release!.selected_files) ? found.release!.selected_files.map(String) : []
    const started = Date.now()
    const details = releaseDetails(found.result!, found.release!, releaseIndex)
    log('INFO', `Download requested: ${details} (torrents: ${hashes.length}; category: ${category || '-'}; files: ${selectedFiles.length ? `${selectedFiles.length} selected` : 'all'})`)
    try {
      for (const hash of hashes) await qbAddTorrent(config, `magnet:?xt=urn:btih:${hash}`, category, selectedFiles, undefined, {
        record: (ownedHash) => recordOwnedTorrents([ownedHash]),
        forget: (ownedHash) => forgetOwnedTorrents([ownedHash]),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Download failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${details} (${message})`)
      return sendJson(response, 502, { ok: false, error: message })
    }
    log('INFO', `Download added in ${((Date.now() - started) / 1000).toFixed(1)}s: ${details} (torrents: ${hashes.length}; tracked torrents: ${ownedTorrentsSnapshot().length})`)
    return sendJson(response, 200, { ok: true })
  }

  if (method === 'GET' && path === '/api/download_bulk/status') {
    return sendJson(response, 200, { ok: true, ...bulkDownloadBatchStatus() })
  }

  if (method === 'POST' && path === '/api/download_bulk') {
    const data = await readJson(request)
    const action = String(data.action || '')
    if (action !== 'start' && action !== 'cancel') {
      return sendJson(response, 400, { ok: false, error: 'Unknown bulk download action' })
    }
    if (bulkOperationActive) return sendJson(response, 409, { ok: false, error: 'Another bulk operation is already running' })
    const availableTargets = bulkDownloadTargets()
    const config = loadConfig()
    bulkOperationActive = true
    try {
      if (action === 'start') {
        if (!Array.isArray(data.selections)) return sendJson(response, 400, { ok: false, error: 'No bulk release selections provided' })
        const byRelease = new Map(availableTargets.map((target) => [`${target.key}\0${target.release}`, target]))
        const selectedParts = new Set<string>()
        const targets = []
        for (const selection of data.selections) {
          const key = String(selection?.key || '')
          const release = Number.parseInt(String(selection?.release ?? -1), 10)
          const target = byRelease.get(`${key}\0${release}`)
          if (!target) return sendJson(response, 400, { ok: false, error: 'A selected bulk release is unavailable' })
          const partKey = `${target.key}\0${target.part}`
          if (selectedParts.has(partKey)) return sendJson(response, 400, { ok: false, error: 'Choose only one best release per season or cour' })
          selectedParts.add(partKey)
          targets.push(target)
        }
        const pending = new Map<string, { category: string; selectedFiles: Set<string>; unrestricted: boolean }>()
        const labelsByHash = new Map<string, string[]>()
        for (const target of targets) {
          const category = String(config[`${target.arr.toLowerCase()}_category`] || '').trim()
          const item = resultsForRequest().find((entry) => entry.key === target.key)
          const label = `${item?.title || target.key}${target.part ? ` · ${target.part}` : ''}`
          for (const hash of target.hashes) {
            const current = pending.get(hash) || { category, selectedFiles: new Set<string>(), unrestricted: false }
            if (target.selectedFiles?.length) for (const file of target.selectedFiles) current.selectedFiles.add(file)
            else current.unrestricted = true
            pending.set(hash, current)
            const labels = labelsByHash.get(hash) || []
            if (!labels.includes(label)) labels.push(label)
            labelsByHash.set(hash, labels)
          }
        }
        const bulkStarted = Date.now()
        const categories = [...new Set([...pending.values()].map((target) => target.category || '-'))]
        const scopedTorrents = [...pending.values()].filter((target) => !target.unrestricted).length
        log('INFO', `Bulk download requested: ${targets.length} release selection${targets.length === 1 ? '' : 's'}, ${pending.size} unique torrent${pending.size === 1 ? '' : 's'} (categories: ${categories.join(', ') || '-'}; file-scoped torrents: ${scopedTorrents})`)
        // Each torrent is added independently: a single failure (for example a
        // magnet metadata timeout) must never prevent the remaining torrents
        // from being queued. Arm the live batch status first so the UI can poll
        // per-torrent progress (green/red) while the adds are still in flight.
        resetBulkDownloadBatch([...pending.keys()])
        try {
          const outcome = await qbBulkAddTorrents(config, [...pending.entries()].map(([hash, target]) => ({
            hash,
            label: (labelsByHash.get(hash) || [hash]).join(' / '),
            category: target.category,
            selectedFiles: target.unrestricted ? [] : [...target.selectedFiles],
          })), {
            onSettle: (hash, error) => settleBulkDownloadBatch(hash, (labelsByHash.get(hash) || [hash]).join(' / '), error),
            ownership: {
              record: (hash) => recordOwnedTorrents([hash]),
              forget: (hash) => forgetOwnedTorrents([hash]),
            },
          })
          if (outcome.failures.length) {
            log('WARNING', `Bulk download finished in ${((Date.now() - bulkStarted) / 1000).toFixed(1)}s: added ${outcome.added.length}/${pending.size} torrent(s); ${outcome.failures.length} failed: ${outcome.failures.map((failure) => `${failure.label} (${failure.error})`).join('; ')}`)
          } else {
            log('INFO', `Bulk download finished in ${((Date.now() - bulkStarted) / 1000).toFixed(1)}s: added ${outcome.added.length}/${pending.size} torrent(s) (tracked torrents: ${ownedTorrentsSnapshot().length})`)
          }
          return sendJson(response, 200, {
            ok: outcome.added.length > 0,
            count: outcome.added.length,
            targets: targets.map(({ key, release }) => ({ key, release })),
            failures: outcome.failures,
          })
        } finally {
          finishBulkDownloadBatch()
        }
      }

      // Only ever cancel/remove torrents this app added itself (tracked in the
      // ownership ledger), never torrents the user added manually.
      const cancelStarted = Date.now()
      const index = indexResultReleases()
      const ownedSet = new Set(ownedTorrentsSnapshot())
      const requestedSelections = Array.isArray(data.selections) ? data.selections.length : null
      log('INFO', `Bulk cancel requested: ${requestedSelections === null ? 'all incomplete app-added downloads' : `${requestedSelections} selected release${requestedSelections === 1 ? '' : 's'}`} (tracked torrents: ${ownedSet.size}; delete files: ${data.delete_files === true ? 'yes' : 'no'})`)
      const torrents = ownedSet.size ? await qbGetTorrents(config, [...ownedSet]) : []
      const presentHashes = new Set(
        torrents.map((torrent) => String(torrent.hash || '').toLowerCase()).filter((hash) => /^[0-9a-f]{40}$/.test(hash)),
      )
      const incompleteOwned = torrents
        .filter((torrent) => {
          const hash = String(torrent.hash || '').toLowerCase()
          return /^[0-9a-f]{40}$/.test(hash) && ownedSet.has(hash) && Number(torrent.progress || 0) < 0.999
        })
        .map((torrent) => String(torrent.hash || '').toLowerCase())
      // With explicit selections only the checked releases are cancelled;
      // without selections the legacy "cancel everything" behavior is kept.
      const wanted = Array.isArray(data.selections)
        ? new Set<string>(
            (data.selections as Array<{ key?: unknown; release?: unknown }>).flatMap((selection) => {
              const targetKey = `${String(selection?.key || '')}\0${Number.parseInt(String(selection?.release ?? -1), 10)}`
              return [...(index.byTarget.get(targetKey) || [])]
            }),
          )
        : null
      const incompleteHashes = incompleteOwned.filter((hash) => !wanted || wanted.has(hash))
      const deleteFiles = data.delete_files === true
      if (incompleteHashes.length) await qbControlTorrents(config, incompleteHashes, 'remove', deleteFiles)
      const cancelled = new Set(incompleteHashes)
      const affectedTargetKeys = new Set<string>()
      for (const hash of cancelled) {
        const info = index.byHash.get(hash)
        if (info) affectedTargetKeys.add(`${info.key}\0${info.release}`)
      }
      const affectedTargets = [...affectedTargetKeys].map((targetKey) => {
        const [key, release] = targetKey.split('\0')
        return { key, release: Number(release) }
      })
      // Keep the ledger in sync: forget the removed torrents, plus any app-added
      // torrent the user deleted manually from qBittorrent in the meantime.
      const staleHashes = [...ownedSet].filter((hash) => !presentHashes.has(hash) && !cancelled.has(hash))
      forgetOwnedTorrents([...incompleteHashes, ...staleHashes])
      log('INFO', `Bulk cancel finished in ${((Date.now() - cancelStarted) / 1000).toFixed(1)}s: removed ${incompleteHashes.length} incomplete torrent(s) across ${affectedTargets.length} release(s), ${deleteFiles ? 'deleted downloaded files' : 'preserved downloaded files'}; pruned ${staleHashes.length} stale ledger entr${staleHashes.length === 1 ? 'y' : 'ies'}`)
      return sendJson(response, 200, { ok: true, count: incompleteHashes.length, targets: affectedTargets })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Bulk ${action === 'start' ? 'download' : 'cancel'} failed: ${message}`)
      return sendJson(response, 502, { ok: false, error: message })
    } finally {
      bulkOperationActive = false
    }
  }

  if (method === 'GET' && path === '/api/download_bulk/cancelable') {
    const index = indexResultReleases()
    const ownedSet = new Set(ownedTorrentsSnapshot())
    let torrents: JsonObject[] = []
    if (ownedSet.size) {
      try {
        torrents = await qbGetTorrents(loadConfig(), [...ownedSet])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log('ERROR', `Cancelable bulk downloads check failed: ${message}`)
        return sendJson(response, 502, { ok: false, error: message })
      }
    }
    // One row per (result, release): every still-incomplete torrent the app
    // added for that release, so bulk cancel can offer torrent selection just
    // like the bulk download dialog offers release selection.
    const byTarget = new Map<string, JsonObject>()
    for (const torrent of torrents) {
      const hash = String(torrent.hash || '').toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(hash) || !ownedSet.has(hash)) continue
      if (Number(torrent.progress || 0) >= 0.999) continue
      const info = index.byHash.get(hash)
      if (!info) continue
      const targetKey = `${info.key}\0${info.release}`
      const entry = byTarget.get(targetKey) || {
        key: info.key,
        release: info.release,
        title: info.title,
        season: info.season,
        part: info.part,
        release_group: info.releaseGroup,
        tracker: info.tracker,
        size: info.size,
        hashes: [],
      }
      entry.hashes.push(hash)
      byTarget.set(targetKey, entry)
    }
    const downloads = [...byTarget.values()].sort((left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) ||
      (left.season || 0) - (right.season || 0) ||
      left.part.localeCompare(right.part),
    )
    return sendJson(response, 200, { ok: true, downloads })
  }

  if (method === 'GET' && path === '/api/download_progress/all') {
    try {
      const torrents = await qbGetTorrents(loadConfig())
      const byHash = new Map(torrents.map((torrent) => [String(torrent.hash || '').toLowerCase(), torrent]))
      const downloads: Record<string, JsonObject> = {}
      for (const result of resultsForRequest()) {
        if (!result.key) continue
        for (const [releaseIndex, release] of (result.releases || []).entries()) {
          const hashes = (release.info_hashes || []).map((hash: unknown) => String(hash).toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash))
          const matches = hashes.map((hash: string) => byHash.get(hash)).filter(Boolean) as JsonObject[]
          if (matches.length) downloads[`${result.key}\0${releaseIndex}`] = summarizeTorrentProgress(matches)
        }
      }
      return sendJson(response, 200, { ok: true, downloads })
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'GET' && path === '/api/download_progress') {
    const key = String(url.searchParams.get('key') || '').trim()
    const releaseIndex = Number.parseInt(url.searchParams.get('release') || '0', 10) || 0
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    const progressKey = `${key}\0${releaseIndex}`
    const details = releaseDetails(found.result!, found.release!, releaseIndex)
    const hashes = (found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash))
    if (!hashes.length) return sendJson(response, 400, { ok: false, error: 'No magnet available for this release' })
    let torrents: JsonObject[]
    try { torrents = await qbGetTorrents(loadConfig(), hashes) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      const previous = downloadProgressFailures.get(progressKey)
      if (!previous || previous.message !== message || now - previous.lastLogged >= 30_000) {
        const suppressed = previous?.suppressed ? `; ${previous.suppressed} repeated error${previous.suppressed === 1 ? '' : 's'} suppressed` : ''
        log('ERROR', `Download status check failed: ${details} (${message}${suppressed})`)
        downloadProgressFailures.set(progressKey, { message, lastLogged: now, suppressed: 0 })
      } else {
        previous.suppressed += 1
      }
      return sendJson(response, 502, { ok: false, error: message })
    }
    const previousFailure = downloadProgressFailures.get(progressKey)
    if (previousFailure) {
      log('INFO', `Download status checks recovered: ${details}${previousFailure.suppressed ? ` (${previousFailure.suppressed} repeated error${previousFailure.suppressed === 1 ? '' : 's'} were suppressed)` : ''}`)
      downloadProgressFailures.delete(progressKey)
    }
    const summary = summarizeTorrentProgress(torrents)
    const foundAny = Boolean(summary.found)
    const progress = Number(summary.progress)
    const state = String(summary.state)
    const previousState = downloadProgressStates.get(progressKey)
    if (foundAny && previousState !== state) {
      log('INFO', `Download state ${previousState ? `${previousState} → ` : ''}${state}: ${details} (${(progress * 100).toFixed(1)}%; ${formatBytes(Number(summary.downloaded))}/${formatBytes(Number(summary.total_size))}; ${formatBytes(Number(summary.speed))}/s)`)
      downloadProgressStates.set(progressKey, state)
    } else if (!foundAny && previousState) {
      log('INFO', `Download no longer present in qBittorrent: ${details} (previous state: ${previousState})`)
      downloadProgressStates.delete(progressKey)
    }
    return sendJson(response, 200, summary)
  }

  if (method === 'POST' && path === '/api/download_control') {
    const data = await readJson(request)
    const key = String(data.key || '').trim()
    const releaseIndex = Number.parseInt(String(data.release ?? 0), 10) || 0
    const action = String(data.action || '')
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    if (action !== 'pause' && action !== 'resume' && action !== 'remove') {
      return sendJson(response, 400, { ok: false, error: 'Unknown torrent action' })
    }
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    const hashes = (found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash))
    if (!hashes.length) return sendJson(response, 400, { ok: false, error: 'No torrent hashes available for this release' })
    const deleteFiles = action === 'remove' && data.delete_files === true
    const started = Date.now()
    const details = releaseDetails(found.result!, found.release!, releaseIndex)
    log('INFO', `Torrent ${action} requested: ${details} (torrents: ${hashes.length}${action === 'remove' ? `; delete files: ${deleteFiles ? 'yes' : 'no'}` : ''})`)
    try {
      await qbControlTorrents(loadConfig(), hashes, action, deleteFiles)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Torrent ${action} failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${details} (${message})`)
      return sendJson(response, 502, { ok: false, error: message })
    }
    if (action === 'remove') {
      forgetOwnedTorrents(hashes)
      downloadProgressStates.delete(`${key}\0${releaseIndex}`)
      downloadProgressFailures.delete(`${key}\0${releaseIndex}`)
    }
    const detail = action === 'remove' ? (deleteFiles ? ' and deleted its files' : ' and preserved its files') : ''
    log('INFO', `Torrent ${action} finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${details}${detail}`)
    return sendJson(response, 200, { ok: true })
  }

  if (method === 'GET' && !path.startsWith('/api/') && serveStatic(path, response)) return
  sendJson(response, 404, { error: 'Not found' })
}

export function makeServer() {
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

export function refreshAutocheckSchedule(config: Config, now = Date.now() / 1000): void {
  const minutes = Number(config.autocheck_minutes || 0)
  if (minutes <= 0) {
    autocheckState.minutes = 0
    autocheckState.next = null
    return
  }
  if (autocheckState.minutes !== minutes || autocheckState.next === null) {
    autocheckState.minutes = minutes
    autocheckState.last = now
    autocheckState.next = now + minutes * 60
  }
}

export function startScheduler(): NodeJS.Timeout {
  try { refreshAutocheckSchedule(loadConfig()) } catch (error) { log('ERROR', `Scheduler initialization failed: ${error instanceof Error ? error.message : String(error)}`) }
  return setInterval(() => {
    void (async () => {
      try {
        const config = loadConfig(); const minutes = config.autocheck_minutes || 0
        const now = Date.now() / 1000
        refreshAutocheckSchedule(config, now)
        if (minutes <= 0) return
        const interval = minutes * 60
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
  makeServer().listen(port, '0.0.0.0', () => {
    log('INFO', `Server listening on 0.0.0.0:${port} (Node ${process.version}; data: ${DATA_DIR}; static: ${STATIC_DIR})`)
    try {
      const config = loadConfig()
      const savedResults = loadLastResults()?.results?.length || 0
      const hiddenCount = Array.isArray(config.hidden) ? config.hidden.length : 0
      log('INFO', `Runtime state restored (saved results: ${savedResults}; tracked torrents: ${ownedTorrentsSnapshot().length}; hidden titles: ${hiddenCount}; auto-check: ${config.autocheck_minutes > 0 ? `${config.autocheck_minutes}m` : 'disabled'})`)
    } catch (error) {
      log('ERROR', `Runtime configuration could not be restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
