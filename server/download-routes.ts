import type { DownloadProgress, CancelableDownload } from '../shared/download-contracts.js'
import { applyUserRulesToResults } from './user-rules.js'
import { downloadJobs, submitDownloadJob, DownloadJobConflict } from './download-jobs.js'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { releaseIdentity } from '../shared/releases.js'
import { downloadPreflight } from './download-preflight.js'
import { readJson, sendJson } from './http-response.js'
import { log } from './logging.js'
import { loadConfig, downloadCategory } from './config.js'
import { resultsForRequest, bulkDownloadTargets, indexResultReleases, normalizeQbStates } from './downloads.js'
import { qbAddTorrent, qbControlTorrents, qbGetTorrents } from './qbittorrent.js'
import { forgetOwnedTorrents, ownedTorrentsSnapshot, loadDownloadRecords, recordOwnedDownload, trackedDownloadInfo } from './download-store.js'
import type { JsonObject } from './types.js'

export function parseReleaseIndex(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function selectedBulkTargets(selections: unknown, results = applyUserRulesToResults(resultsForRequest())): { targets: ReturnType<typeof bulkDownloadTargets>; results: JsonObject[]; error?: [number, string] } {
  const targets: ReturnType<typeof bulkDownloadTargets> = []
  if (!Array.isArray(selections)) return { targets, results, error: [400, 'No bulk release selections provided'] }
  const available = new Map(bulkDownloadTargets(results).map(target => [`${target.key}\0${target.release}`, target]))
  const parts = new Set<string>()
  for (const selection of selections) {
    const key = String(selection?.key || '')
    const release = parseReleaseIndex(selection?.release)
    if (release === null) return { targets, results, error: [400, 'Release must be a non-negative integer'] }
    const target = available.get(`${key}\0${release}`)
    if (!target) return { targets, results, error: [400, 'A selected bulk release is unavailable'] }
    const selectedRelease = results.find(item => item.key === key)?.releases?.[release]
    if (selection.identity && selection.identity !== releaseIdentity(selectedRelease || {})) return { targets, results, error: [409, 'A selected release changed. Reopen the review to see the latest recommendations.'] }
    const part = `${key}\0${target.part}`
    if (parts.has(part)) return { targets, results, error: [400, 'Choose only one best release per season or cour'] }
    parts.add(part)
    targets.push(target)
  }
  return { targets, results }
}

function findResult(key: string, releaseIndex: number): { result?: JsonObject; release?: JsonObject; error?: [number, string] } {
  const result = resultsForRequest().find((item) => item.key === key)
  if (!result) return { error: [404, 'Result not found — run a scan first'] }
  const releases = result.releases || []
  if (releaseIndex < 0 || releaseIndex >= releases.length) return { error: [404, 'Release not found'] }
  return { result, release: releases[releaseIndex] }
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

function summarizeTorrentProgress(torrents: JsonObject[], expectedCount = torrents.length): DownloadProgress {
  let totalSize = 0; let downloaded = 0; let speed = 0
  const states: string[] = []
  for (const torrent of torrents) {
    const size = Number(torrent.size || torrent.total_size || 0); const progress = Number(torrent.progress || 0)
    totalSize += size; downloaded += Math.trunc(size * progress); speed += Number(torrent.dlspeed || 0); states.push(String(torrent.state || 'unknown'))
  }
  const found = torrents.length > 0
  const progress = totalSize > 0 ? downloaded / totalSize : 0
  let state = normalizeQbStates(states)
  const missing = Math.max(0, expectedCount - torrents.length)
  if (missing && state === 'complete') state = 'waiting'
  if (!missing && state !== 'error' && found && totalSize > 0 && progress >= 1) state = 'complete'
  return { ok: true, found, progress: Math.floor(progress * 10_000) / 10_000, downloaded, total_size: totalSize, speed, state, missing_torrents: missing }
}


export async function handleDownloadRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method || 'GET'
  const path = url.pathname
  if (method === 'POST' && path === '/api/download') {
    const data = await readJson(request)
    const key = String(data.key || '').trim()
    const releaseIndex = parseReleaseIndex(data.release ?? 0)
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    if (releaseIndex === null) return sendJson(response, 400, { ok: false, error: 'Release must be a non-negative integer' })
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    if (data.identity && data.identity !== releaseIdentity(found.release!)) return sendJson(response, 409, { error: 'This release changed. Review the updated recommendation before downloading.' })
    const hashes = [...new Set<string>((found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash)))]
    if (!hashes.length) return sendJson(response, 400, { ok: false, error: 'No magnet available for this release (private tracker)' })
    const config = loadConfig()
    const category = downloadCategory(config, String(found.result!.arr))
    const selectedFiles = Array.isArray(found.release!.selected_files) ? found.release!.selected_files.map(String) : []
    const started = Date.now()
    const details = releaseDetails(found.result!, found.release!, releaseIndex)
    const downloadInfo = indexResultReleases([found.result!], [{ key, release: releaseIndex }]).byHash.get(hashes[0])!
    log('INFO', `Download requested: ${details} (torrents: ${hashes.length}; category: ${category || '-'}; files: ${selectedFiles.length ? `${selectedFiles.length} selected` : 'all'})`)
    try {
      for (const hash of hashes) await qbAddTorrent(config, `magnet:?xt=urn:btih:${hash}`, category, selectedFiles, undefined, {
        record: (ownedHash) => { recordOwnedDownload(ownedHash, downloadInfo) },
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

  if (method === 'POST' && path === '/api/download_bulk/preflight') {
    const selection = selectedBulkTargets((await readJson(request)).selections)
    if (selection.error) return sendJson(response, selection.error[0], { error: selection.error[1] })
    const config = loadConfig()
    const results = selection.results
    const estimate = await downloadPreflight(config, selection.targets.map(target => ({
      release: results.find(result => result.key === target.key)!.releases[target.release],
      category: downloadCategory(config, target.arr),
    })))
    return sendJson(response, 200, estimate, { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && (path === '/api/download_bulk/status' || path === '/api/download-jobs/latest' || /^\/api\/download-jobs\/[^/]+$/.test(path))) {
    const id = path.startsWith('/api/download-jobs/') && !path.endsWith('/latest') ? path.slice('/api/download-jobs/'.length) : undefined
    const job = downloadJobs.get(id)
    if (id && !job) return sendJson(response, 404, { error: 'Download job not found' })
    return sendJson(response, 200, { ok: true, ...(job || { id: null, finished: true, pending: [], added: [], failures: [], existing: [], targets: [] }) })
  }

  if (method === 'POST' && path === '/api/download-jobs') {
    if (bulkOperationActive || downloadJobs.active()) return sendJson(response, 409, { error: 'Another bulk operation is already running' })
    const selection = selectedBulkTargets((await readJson(request)).selections)
    if (selection.error) return sendJson(response, selection.error[0], { error: selection.error[1] })
    try {
      const { job } = submitDownloadJob(loadConfig(), selection.targets, selection.results)
      return sendJson(response, 202, { ok: true, ...job })
    } catch (error) {
      if (error instanceof DownloadJobConflict) return sendJson(response, 409, { error: error.message })
      throw error
    }
  }

  if (method === 'POST' && path === '/api/download_bulk') {
    const data = await readJson(request)
    const action = String(data.action || '')
    if (action !== 'start' && action !== 'cancel') {
      return sendJson(response, 400, { ok: false, error: 'Unknown bulk download action' })
    }
    if (bulkOperationActive || downloadJobs.active()) return sendJson(response, 409, { ok: false, error: 'Another bulk operation is already running' })
    const config = loadConfig()
    bulkOperationActive = true
    try {
      if (action === 'start') {
        const selection = selectedBulkTargets(data.selections)
        if (selection.error) return sendJson(response, selection.error[0], { error: selection.error[1] })
        const { completion } = submitDownloadJob(config, selection.targets, selection.results)
        return sendJson(response, 200, await completion)
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
          return /^[0-9a-f]{40}$/.test(hash) && ownedSet.has(hash) && Number(torrent.progress || 0) < 1
        })
        .map((torrent) => String(torrent.hash || '').toLowerCase())
      // With explicit selections only the checked releases are cancelled;
      // without selections the legacy "cancel everything" behavior is kept.
      const wanted = Array.isArray(data.selections)
        ? new Set<string>(
            (data.selections as Array<{ key?: unknown; release?: unknown }>).flatMap((selection) => {
              const key = String(selection?.key || '')
              if (key.startsWith('torrent:')) return ownedSet.has(key.slice(8)) && parseReleaseIndex(selection.release) === 0 ? [key.slice(8)] : []
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
    const records = loadDownloadRecords()
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
    const byTarget = new Map<string, CancelableDownload>()
    for (const torrent of torrents) {
      const hash = String(torrent.hash || '').toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(hash) || !ownedSet.has(hash)) continue
      if (Number(torrent.progress || 0) >= 1) continue
      const info = trackedDownloadInfo(torrent, records, index)
      const targetKey = `torrent:${hash}\0${0}`
      const entry: CancelableDownload = byTarget.get(targetKey) || {
        key: `torrent:${hash}`,
        result_keys: [...new Set([
          info.key,
          ...(index.byHash.get(hash)?.associations || []).map(association => association.key),
          ...resultsForRequest().filter(result => (info.associations || [info]).some(association => association.library_key && result.library_key === association.library_key && result.season === association.season)).map(result => String(result.key)),
        ])],
        release: 0,
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
          const hashes = [...new Set<string>((release.info_hashes || []).map((hash: unknown) => String(hash).toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash)))]
          const matches = hashes.map((hash: string) => byHash.get(hash)).filter(Boolean) as JsonObject[]
          if (matches.length) downloads[`${result.key}\0${releaseIndex}`] = { ...summarizeTorrentProgress(matches, hashes.length), identity: releaseIdentity(release) }
        }
      }
      return sendJson(response, 200, { ok: true, downloads })
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'GET' && path === '/api/download_progress') {
    const key = String(url.searchParams.get('key') || '').trim()
    const releaseIndex = parseReleaseIndex(url.searchParams.get('release') || '0')
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    if (releaseIndex === null) return sendJson(response, 400, { ok: false, error: 'Release must be a non-negative integer' })
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    const progressKey = `${key}\0${releaseIndex}`
    const details = releaseDetails(found.result!, found.release!, releaseIndex)
    const hashes = [...new Set<string>((found.release!.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter((hash: string) => /^[0-9a-f]{40}$/.test(hash)))]
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
    const summary: JsonObject = { ...summarizeTorrentProgress(torrents, hashes.length), identity: releaseIdentity(found.release!) }
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
    const releaseIndex = parseReleaseIndex(data.release ?? 0)
    const action = String(data.action || '')
    if (!key) return sendJson(response, 400, { ok: false, error: 'No key provided' })
    if (releaseIndex === null) return sendJson(response, 400, { ok: false, error: 'Release must be a non-negative integer' })
    if (action !== 'pause' && action !== 'resume' && action !== 'remove') {
      return sendJson(response, 400, { ok: false, error: 'Unknown torrent action' })
    }
    const found = findResult(key, releaseIndex)
    if (found.error) return sendJson(response, found.error[0], { ok: false, error: found.error[1] })
    if (data.identity && data.identity !== releaseIdentity(found.release!)) return sendJson(response, 409, { error: 'This release changed. Open Downloads to control the original torrent.' })
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

  sendJson(response, 404, { error: 'Not found' })
}
