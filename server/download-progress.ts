import type { Config, JsonObject, ResultItem } from './types.js'
import type { AllDownloadProgress, CancelableDownload, CancelableDownloads, DownloadCapabilities, DownloadCancelResult, DownloadPhase, DownloadProgress } from '../shared/download-contracts.js'
import { downloadRecords, downloadRows, findDownloadRecord, markDownloadRemoved, setDownloadNative, setDownloadPhase, type OwnedDownloadRecord } from './download-store.js'
import { sabDeleteHistoryJob, sabDeleteQueueJob, sabFindJobsByName, sabHistoryJobs, sabPauseJob, sabQueueJobs, sabResumeJob, sabSubmissionName, type SabHistoryJob, type SabQueueJob } from './sabnzbd.js'
import { qbControlTorrents, qbGetTorrents } from './qbittorrent.js'
import { qbEndpointId, sabEndpoint } from './client-identity.js'
import { resultsForRequest } from './downloads.js'
import { errorMessage, log } from './logging.js'

const QUEUED_STATES: Record<string, true> = { queuedDL: true, queuedUP: true, metaDL: true }
const DOWNLOADING_STATES: Record<string, true> = { downloading: true, stalledDL: true, allocating: true, forcedDL: true }
const PAUSED_DOWNLOAD_STATES: Record<string, true> = { pausedDL: true, stoppedDL: true }
const VERIFYING_STATES: Record<string, true> = { checkingDL: true, checkingUP: true, checking: true }
const ERROR_STATES: Record<string, true> = { error: true, missingFiles: true }

function qbCapabilities(state: string, progress: number): DownloadCapabilities {
  const paused = Object.hasOwn(PAUSED_DOWNLOAD_STATES, state)
  const complete = progress >= 1
  return {
    pause: !paused && !complete && (Object.hasOwn(DOWNLOADING_STATES, state) || state === 'queuedDL' || state === 'metaDL'),
    resume: paused,
    remove: true,
    remove_files: true,
  }
}

export function qbPhase(state: string, progress: number): DownloadPhase {
  if (Object.hasOwn(ERROR_STATES, state)) return 'error'
  if (Object.hasOwn(PAUSED_DOWNLOAD_STATES, state)) return 'paused'
  if (Object.hasOwn(VERIFYING_STATES, state)) return 'verifying'
  if (progress >= 1) return state === 'uploading' || state === 'stalledUP' ? 'seeding' : 'complete'
  if (Object.hasOwn(QUEUED_STATES, state)) return 'queued'
  return 'downloading'
}

export function queuePhase(status: string): DownloadPhase {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'paused') return 'paused'
  if (normalized === 'downloading' || normalized === 'fetching') return 'downloading'
  if (normalized === 'queued' || normalized === 'propagating') return 'queued'
  return 'downloading'
}

export function historyPhase(status: string): DownloadPhase {
  const normalized = status.trim().toLowerCase()
  switch (normalized) {
    case 'quickcheck': case 'verifying': return 'verifying'
    case 'repairing': return 'repairing'
    case 'extracting': return 'unpacking'
    case 'completed': return 'complete'
    case 'failed': return 'error'
    default: return 'post_processing'
  }
}

interface ProgressContext {
  results: ResultItem[]
}

function associationTitles(context: ProgressContext, recordId: string): string[] {
  const titles = new Map<string, string>()
  for (const row of downloadRows(recordId)) {
    const result = context.results.find(item => item.key === row.key)
    if (!result) continue
    const season = result.season ? ` S${String(result.season).padStart(2, '0')}` : ''
    titles.set(`${result.key}\0${row.release}`, `${String(result.title || result.key)}${season}`)
  }
  return [...titles.values()]
}

function baseProgress(record: OwnedDownloadRecord): DownloadProgress {
  return {
    record_id: record.id, protocol: record.protocol, client: record.client,
    source_hash: record.source_hash, native_id: record.native_id,
    phase: record.last_phase || 'unavailable', state: '', category: record.category, labels: record.labels,
    title: record.card?.title || record.labels[0] || record.source_hash,
    season: record.card?.season ?? null, part: record.card?.part || '',
    release_group: record.card?.release_group || '', tracker: record.card?.tracker || '',
    size: record.card?.size || 0,
    associations: downloadRows(record.id),
    ...(record.scope ? { scope: [...record.scope] } : {}),
    progress: 0, downloaded: 0, total_size: 0, speed: 0,
    capabilities: { pause: false, resume: false, remove: false, remove_files: false },
    updated_at: record.updated_at,
  }
}

/**
 * Record-keyed live state for every app-owned acquisition. Reads each configured
 * client once per call; endpoint-mismatched records are reported unbound and are
 * never controlled, and failed reads preserve the persisted last-known phase.
 */
export async function collectDownloadProgress(config: Config): Promise<AllDownloadProgress> {
  return (await readDownloadProgress(config, downloadRecords())).progress
}

/** Unconfirmed submissions can only be removed from tracking; the client itself is never touched. */
const UNCONFIRMED_CAPABILITIES: DownloadCapabilities = { pause: false, resume: false, remove: true, remove_files: false }
const UNCONFIRMED_RETRY_MS = 60_000
const unconfirmedAttempts = new Map<string, number>()

/**
 * Adopts unconfirmed Usenet submissions that SABnzbd did accept: exactly one queue or
 * history job with the submitted name and category, not already owned by another record.
 * Anything less certain stays unconfirmed for the user to resolve.
 */
async function adoptUnconfirmedUsenet(config: Config, records: OwnedDownloadRecord[]): Promise<boolean> {
  const { apiUrl, endpointId } = sabEndpoint(config)
  if (!apiUrl || !config.sabnzbd_key) return false
  const now = Date.now()
  const pending = records.filter(record => record.protocol === 'usenet' && record.state === 'acceptance_unknown' && !record.native_id
    && record.endpoint === endpointId && now - (unconfirmedAttempts.get(record.id) || 0) >= UNCONFIRMED_RETRY_MS)
  if (!pending.length) return false
  const owned = new Set(downloadRecords().filter(record => record.protocol === 'usenet' && record.native_id).map(record => record.native_id))
  let adopted = false
  for (const record of pending) {
    unconfirmedAttempts.set(record.id, now)
    try {
      const jobs = (await sabFindJobsByName({ apiUrl, apiKey: config.sabnzbd_key }, sabSubmissionName(record.nzb_name, record.source_hash), globalThis.fetch))
        .filter(job => !owned.has(job.nzo_id) && job.category.trim().toLowerCase() === record.category.trim().toLowerCase())
      if (jobs.length !== 1) continue
      setDownloadNative(record.id, [jobs[0].nzo_id])
      owned.add(jobs[0].nzo_id)
      unconfirmedAttempts.delete(record.id)
      adopted = true
      log('INFO', `Confirmed earlier SABnzbd submission ${jobs[0].nzo_id} for ${record.source_hash.slice(0, 12)}`)
    } catch (error) {
      log('WARNING', `Could not look up an unconfirmed SABnzbd submission: ${errorMessage(error)}`)
    }
  }
  return adopted
}

async function readDownloadProgress(config: Config, records: OwnedDownloadRecord[]): Promise<{ progress: AllDownloadProgress; sabQueueIds: Set<string> }> {
  if (await adoptUnconfirmedUsenet(config, records)) records = records.map(record => findDownloadRecord(record.id) || record)
  const downloads: Record<string, DownloadProgress> = {}
  const unavailable_clients: AllDownloadProgress['unavailable_clients'] = []
  const currentQb = qbEndpointId(config)
  const { apiUrl, endpointId: currentSab } = sabEndpoint(config)

  const qbRecords = records.filter(record => record.protocol === 'torrent')
  const qbBound = qbRecords.filter(record => record.endpoint && record.endpoint === currentQb)
  const qbUnbound = qbRecords.filter(record => !record.endpoint || record.endpoint !== currentQb)
  const torrentsByHash = new Map<string, JsonObject>()
  let qbReadComplete = true
  if (qbBound.length) {
    try {
      const torrents = await qbGetTorrents(config, qbBound.map(record => record.native_id || record.source_hash), true)
      for (const torrent of torrents) torrentsByHash.set(String(torrent.hash || '').toLowerCase(), torrent)
    } catch (error) {
      qbReadComplete = false
      unavailable_clients.push('qbittorrent')
      log('WARNING', `qBittorrent progress read failed: ${errorMessage(error)}`)
    }
  }
  for (const record of qbUnbound) {
    const view = baseProgress(record)
    view.phase = 'unavailable'
    view.state = 'unbound'
    view.error = 'Saved from a different qBittorrent URL; controls are disabled until it is restored.'
    downloads[record.id] = view
  }
  for (let record of qbBound) {
    // A torrent's identity is its hash, so an unconfirmed submission that qBittorrent holds is confirmed.
    if (record.state === 'acceptance_unknown' && torrentsByHash.has(record.source_hash)) record = setDownloadNative(record.id, [record.source_hash]) || record
    const view = baseProgress(record)
    if (record.state === 'acceptance_unknown') {
      view.phase = 'acceptance_unknown'
      view.error = 'Submission status unknown. Check qBittorrent before retrying.'
      view.capabilities = { ...UNCONFIRMED_CAPABILITIES }
      downloads[record.id] = view
      continue
    }
    const torrent = torrentsByHash.get(record.native_id)
    if (!torrent) {
      view.phase = qbReadComplete ? 'missing' : (record.last_phase || 'unavailable')
      if (!qbReadComplete) view.error = 'qBittorrent could not be reached; showing the last known state.'
      else view.error = 'This torrent is no longer in qBittorrent.'
      if (qbReadComplete) view.capabilities.remove = true
      downloads[record.id] = view
      continue
    }
    const state = String(torrent.state || 'unknown')
    const progress = Number(torrent.progress || 0)
    const size = Number(torrent.size || torrent.total_size || 0)
    view.phase = qbPhase(state, progress)
    view.state = state
    view.progress = Math.floor(progress * 10_000) / 10_000
    view.downloaded = Math.trunc(size * progress)
    view.total_size = size
    view.speed = Number(torrent.dlspeed || 0)
    if (size && !view.size) view.size = size
    view.capabilities = qbCapabilities(state, progress)
    downloads[record.id] = view
    setDownloadPhase(record.id, view.phase)
  }

  const sabRecords = records.filter(record => record.protocol === 'usenet')
  const sabBound = sabRecords.filter(record => record.endpoint && record.endpoint === currentSab && record.native_id)
  const sabUnbound = sabRecords.filter(record => !sabBound.includes(record))
  const queueById = new Map<string, SabQueueJob>()
  const historyById = new Map<string, SabHistoryJob>()
  let sabReadComplete = true
  if (sabBound.length && apiUrl && config.sabnzbd_key) {
    try {
      const settings = { apiUrl, apiKey: config.sabnzbd_key }
      const [queue, history] = await Promise.all([
        sabQueueJobs(settings, sabBound.map(record => record.native_id), globalThis.fetch),
        sabHistoryJobs(settings, sabBound.map(record => record.native_id), globalThis.fetch),
      ])
      for (const job of queue.jobs) queueById.set(job.nzo_id, job)
      for (const job of history.jobs) historyById.set(job.nzo_id, job)
      sabReadComplete = queue.read_complete && history.read_complete
      if (!sabReadComplete) unavailable_clients.push('sabnzbd')
    } catch (error) {
      sabReadComplete = false
      unavailable_clients.push('sabnzbd')
      log('WARNING', `SABnzbd progress read failed: ${errorMessage(error)}`)
    }
  } else if (sabBound.length) {
    sabReadComplete = false
    unavailable_clients.push('sabnzbd')
  }
  for (const record of sabUnbound) {
    const view = baseProgress(record)
    if (record.state === 'acceptance_unknown' && !record.native_id) {
      view.phase = 'acceptance_unknown'
      view.error = 'Submission status unknown. Check SABnzbd before retrying.'
      view.capabilities = { ...UNCONFIRMED_CAPABILITIES }
    } else {
      view.phase = 'unavailable'
      view.state = 'unbound'
      view.error = 'Saved from a different SABnzbd URL; controls are disabled until it is restored.'
    }
    downloads[record.id] = view
  }
  for (const record of sabBound) {
    const view = baseProgress(record)
    if (record.state === 'acceptance_unknown') {
      view.phase = 'acceptance_unknown'
      view.error = 'Submission status unknown. Check SABnzbd before retrying.'
      view.capabilities = { ...UNCONFIRMED_CAPABILITIES }
      downloads[record.id] = view
      continue
    }
    const queueJob = queueById.get(record.native_id)
    const historyJob = historyById.get(record.native_id)
    const job = queueJob || historyJob
    if (!job) {
      view.phase = sabReadComplete ? 'missing' : (record.last_phase || 'unavailable')
      view.error = sabReadComplete ? 'This job is no longer in SABnzbd.' : 'SABnzbd could not be reached; showing the last known state.'
      if (sabReadComplete) view.capabilities.remove = true
      downloads[record.id] = view
      continue
    }
    if (queueJob) {
      view.phase = queuePhase(queueJob.status)
      view.state = queueJob.status
      view.total_size = queueJob.total_bytes
      view.downloaded = queueJob.downloaded_bytes
      view.progress = queueJob.total_bytes > 0 ? Math.floor((queueJob.downloaded_bytes / queueJob.total_bytes) * 10_000) / 10_000 : Math.floor(queueJob.percentage * 100) / 10_000
      view.speed = queueJob.speed_bytes_per_sec
      if (queueJob.name && !view.title.startsWith('usenet:')) view.title = queueJob.name
      view.capabilities = { pause: view.phase !== 'paused', resume: view.phase === 'paused', remove: true, remove_files: true }
    } else if (historyJob) {
      view.phase = historyPhase(historyJob.status)
      view.state = historyJob.status
      view.total_size = historyJob.total_bytes
      view.downloaded = historyJob.downloaded_bytes
      view.progress = historyJob.total_bytes > 0 ? Math.floor((historyJob.downloaded_bytes / historyJob.total_bytes) * 10_000) / 10_000 : 1
      if (historyJob.name && !view.title.startsWith('usenet:')) view.title = historyJob.name
      if (view.phase === 'error' && historyJob.fail_message) view.error = historyJob.fail_message
      view.capabilities = { pause: false, resume: false, remove: !historyJob.loaded, remove_files: !historyJob.loaded && view.phase === 'error' }
    }
    if (view.total_size && !view.size) view.size = view.total_size
    downloads[record.id] = view
    setDownloadPhase(record.id, view.phase)
  }

  return { progress: { ok: true, downloads, ...(unavailable_clients.length ? { unavailable_clients } : {}) }, sabQueueIds: new Set(queueById.keys()) }
}

const CANCELABLE_PHASES: Partial<Record<DownloadPhase, true>> = {
  queued: true, downloading: true, paused: true, verifying: true, repairing: true,
  unpacking: true, post_processing: true, error: true, missing: true,
}

export async function listCancelable(config: Config): Promise<CancelableDownloads> {
  const progress = await collectDownloadProgress(config)
  const context: ProgressContext = { results: resultsForRequest() }
  const items: CancelableDownload[] = []
  for (const view of Object.values(progress.downloads)) {
    if (!CANCELABLE_PHASES[view.phase] || !view.capabilities.remove) continue
    const associations = associationTitles(context, view.record_id)
    items.push({
      record_id: view.record_id, protocol: view.protocol, client: view.client, native_id: view.native_id,
      phase: view.phase, title: view.title, season: view.season, part: view.part,
      release_group: view.release_group, category: view.category,
      associations: associations.length ? associations : view.labels,
      size: view.size, capabilities: view.capabilities,
    })
  }
  items.sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) || (left.season || 0) - (right.season || 0) || left.part.localeCompare(right.part))
  return { ok: true, items }
}

/**
 * Removes app-owned acquisitions only. Records bound to a different client endpoint
 * are refused; completed downloads are left for the per-item control surface.
 */
export async function cancelRecords(config: Config, recordIds: unknown, removeFiles: boolean): Promise<DownloadCancelResult> {
  const wanted = recordIds === undefined ? null : Array.isArray(recordIds) ? recordIds.map(String) : null
  if (recordIds !== undefined && !Array.isArray(recordIds)) throw new Error('record_ids must be an array')
  const { progress, sabQueueIds } = await readDownloadProgress(config, downloadRecords())
  const removed: DownloadCancelResult['removed'] = []
  const failures: DownloadCancelResult['failures'] = []
  const { endpointId: currentSab } = sabEndpoint(config)
  for (const view of Object.values(progress.downloads)) {
    if (wanted && !wanted.includes(view.record_id)) continue
    if (view.state === 'unbound') { failures.push({ record_id: view.record_id, client: view.client, label: view.title, error: 'This download belongs to a different client URL.' }); continue }
    if (!CANCELABLE_PHASES[view.phase]) { if (wanted?.includes(view.record_id)) failures.push({ record_id: view.record_id, client: view.client, label: view.title, error: view.error || 'This download already finished.' }); continue }
    const record = findDownloadRecord(view.record_id)
    if (!record) continue
    try {
      await removeRecord(config, record, view, sabQueueIds.has(record.native_id), removeFiles)
      removed.push({ record_id: record.id, client: record.client })
    } catch (error) {
      failures.push({ record_id: record.id, client: record.client, label: view.title, error: errorMessage(error) })
    }
  }
  log('INFO', `Cancelled ${removed.length} app-owned download(s)${removeFiles ? ' with files' : ' keeping files'}${failures.length ? `; ${failures.length} failed` : ''} (endpoint ${currentSab || 'no-sab'})`)
  return { ok: failures.length === 0, removed, failures }
}

async function removeRecord(config: Config, record: OwnedDownloadRecord, view: DownloadProgress, inSabQueue: boolean, deleteFiles: boolean): Promise<void> {
  if (record.state === 'acceptance_unknown') throw new OwnershipError('Submission status is unknown; check the download client before removing this record.')
  if (!view.capabilities.remove) throw new OwnershipError(view.error || 'This download cannot be removed in its current state.')
  // Only a fresh complete read can expose ledger-only removal. Files stay untouched.
  if (view.phase !== 'missing') {
    const removeFiles = deleteFiles && view.capabilities.remove_files
    if (record.protocol === 'torrent') await qbControlTorrents(config, [record.native_id], 'remove', removeFiles)
    else {
      const { apiUrl } = sabEndpoint(config)
      if (!apiUrl || !config.sabnzbd_key) throw new OwnershipError('SABnzbd is not configured.')
      const settings = { apiUrl, apiKey: config.sabnzbd_key }
      if (inSabQueue) await sabDeleteQueueJob(settings, record.native_id, removeFiles, globalThis.fetch)
      else await sabDeleteHistoryJob(settings, record.native_id, removeFiles, globalThis.fetch)
    }
  }
  markDownloadRemoved(record.id)
}

/** Single-record controls use the saved ownership and a fresh client read. */
export async function controlRecord(config: Config, recordId: string, action: string, deleteFiles: boolean): Promise<{ ok: true }> {
  const record = findDownloadRecord(recordId)
  if (!record || record.removed_at) throw new OwnershipError('Download record not found.')
  if (action !== 'pause' && action !== 'resume' && action !== 'remove') throw new OwnershipError('Unknown download action')
  // An unconfirmed submission is only forgotten; the client is never touched, so nothing it holds is lost.
  if (record.state === 'acceptance_unknown' && action === 'remove') {
    markDownloadRemoved(record.id)
    unconfirmedAttempts.delete(record.id)
    log('INFO', `Stopped tracking unconfirmed ${record.client} submission for ${record.source_hash.slice(0, 12)}; the client was not changed`)
    return { ok: true }
  }
  const endpoint = record.protocol === 'torrent' ? qbEndpointId(config) : sabEndpoint(config).endpointId
  if (!record.endpoint || record.endpoint !== endpoint) throw new OwnershipError('This download was added through a different client URL; controls are disabled.')
  if (record.state === 'acceptance_unknown') throw new OwnershipError('Submission status is unknown; check the download client before controlling this record.')
  const { progress, sabQueueIds } = await readDownloadProgress(config, [record])
  const view = progress.downloads[record.id]
  if (action === 'remove') await removeRecord(config, record, view, sabQueueIds.has(record.native_id), deleteFiles)
  else if (record.protocol === 'torrent') {
    if (!view.state) throw new OwnershipError(view.error || 'This torrent is no longer in qBittorrent.')
    await qbControlTorrents(config, [record.native_id], action)
  } else {
    if (!sabQueueIds.has(record.native_id)) throw new OwnershipError(view.error || 'This job is not in the SABnzbd queue anymore.')
    const { apiUrl } = sabEndpoint(config)
    const settings = { apiUrl, apiKey: config.sabnzbd_key }
    if (action === 'pause') await sabPauseJob(settings, record.native_id, globalThis.fetch)
    else await sabResumeJob(settings, record.native_id, globalThis.fetch)
  }
  return { ok: true }
}

export class OwnershipError extends Error {}
