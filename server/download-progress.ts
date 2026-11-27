import type { Config, ResultItem } from './types.js'
import type {
  AllDownloadProgress,
  CancelableDownload,
  CancelableDownloads,
  DownloadCancelResult,
  DownloadCapabilities,
  DownloadClient,
  DownloadImport,
  DownloadProgress,
} from '../shared/download-contracts.js'
import { cancelablePhase, isCancelable } from '../shared/download-contracts.js'
import { arrInstances, parseLibraryKey } from './arr-instances.js'
import {
  downloadRecords,
  downloadRows,
  findDownloadRecord,
  markDownloadRemoved,
  setDownloadNative,
  setDownloadPhase,
  type OwnedDownloadRecord,
} from './download-store.js'
import {
  OwnershipError,
  type ClientSnapshot,
  type DownloadClientAdapter,
  type DownloadClients,
  type LiveJob,
} from './download-client-types.js'
import { resultsForRequest } from './downloads.js'
import { log } from './logging.js'
import { errorMessage } from '../shared/errors.js'
import { rowKey, seasonTag } from '../shared/ids.js'

export { OwnershipError }

function associationTitles(results: ResultItem[], recordId: string): string[] {
  const titles = new Map<string, string>()
  for (const row of downloadRows(recordId)) {
    const result = results.find(item => item.key === row.key)
    if (result)
      titles.set(rowKey(row), `${result.title || result.key}${result.season ? ` ${seasonTag(result.season)}` : ''}`)
  }
  return [...titles.values()]
}

/** The saved facts about a record, before anything a client says about it. */
function baseProgress(record: OwnedDownloadRecord): DownloadProgress {
  return {
    record_id: record.id,
    protocol: record.protocol,
    client: record.client,
    source_hash: record.source_hash,
    ...(record.source_alias ? { source_alias: record.source_alias } : {}),
    native_id: record.native_id,
    phase: record.last_phase || 'unavailable',
    state: '',
    category: record.category,
    labels: record.labels,
    title: record.card?.title || record.labels[0] || record.source_hash,
    season: record.card?.season ?? null,
    part: record.card?.part || '',
    release_group: record.card?.release_group || '',
    tracker: record.card?.tracker || '',
    size: record.card?.size || 0,
    associations: downloadRows(record.id),
    ...(record.scope ? { scope: [...record.scope] } : {}),
    progress: 0,
    downloaded: 0,
    total_size: 0,
    speed: 0,
    capabilities: { pause: false, resume: false, remove: false, remove_files: false },
    updated_at: record.updated_at,
  }
}

const IMPORT_ATTENTION_MS = 14 * 24 * 60 * 60_000

/** Import follow-through of a record, naming the Sonarr or Radarr instance that should import it. */
function importView(config: Config, record: OwnedDownloadRecord): DownloadImport | undefined {
  if (!record.import) return undefined
  // An import nobody resolved for two weeks is no longer checked by scans, so it stops asking for attention.
  const since = Date.parse(record.import.completed_at || record.import.since)
  if (
    record.import.state !== 'waiting' &&
    record.import.state !== 'imported' &&
    Number.isFinite(since) &&
    Date.now() - since > IMPORT_ATTENTION_MS
  )
    return undefined
  const target = parseLibraryKey(record.library?.[0]?.key || '')
  const app = target
    ? arrInstances(config).find(instance => instance.id === target.instanceId)?.name || target.arr
    : 'Sonarr or Radarr'
  return {
    state: record.import.state,
    app,
    ...(record.import.message ? { message: record.import.message } : {}),
    ...(record.import.completed_at ? { completed_at: record.import.completed_at } : {}),
  }
}

/** Unconfirmed submissions can only be removed from tracking; the client itself is never touched. */
const UNCONFIRMED_CAPABILITIES: DownloadCapabilities = {
  pause: false,
  resume: false,
  remove: true,
  remove_files: false,
}

function unconfirmedView(record: OwnedDownloadRecord, client: DownloadClientAdapter): DownloadProgress {
  return {
    ...baseProgress(record),
    phase: 'acceptance_unknown',
    error: `Submission status unknown. Check ${client.label} before retrying.`,
    capabilities: { ...UNCONFIRMED_CAPABILITIES },
  }
}

function unboundView(record: OwnedDownloadRecord, client: DownloadClientAdapter): DownloadProgress {
  return {
    ...baseProgress(record),
    phase: 'unavailable',
    state: 'unbound',
    error: `Saved from a different ${client.label} URL; controls are disabled until it is restored.`,
  }
}

function absentView(
  record: OwnedDownloadRecord,
  client: DownloadClientAdapter,
  readComplete: boolean,
): DownloadProgress {
  const view = baseProgress(record)
  // Only a fresh complete read can establish absence and expose ledger-only removal.
  if (!readComplete)
    return {
      ...view,
      phase: record.last_phase || 'unavailable',
      error: `${client.label} could not be reached; showing the last known state.`,
    }
  return {
    ...view,
    phase: 'missing',
    error: `This ${client.jobNoun} is no longer in ${client.label}.`,
    capabilities: { ...view.capabilities, remove: true },
  }
}

/**
 * A finished download the client no longer holds. Sonarr and Radarr remove what they imported, and people
 * clear torrents after a manual import, so this is the normal end of a download rather than a problem.
 * Only the tracking entry can be cleared; whether the files reached the library is told by the import state.
 */
function handedOffView(record: OwnedDownloadRecord): DownloadProgress {
  const view = baseProgress(record)
  return {
    ...view,
    phase: 'complete',
    state: 'removed',
    progress: 1,
    downloaded: view.size,
    total_size: view.size,
    capabilities: { ...view.capabilities, remove: true },
  }
}

/** True once a client read saw the download finish, or its import follow-through started. */
function hasFinished(record: OwnedDownloadRecord): boolean {
  return (
    record.last_phase === 'complete' ||
    record.last_phase === 'seeding' ||
    Boolean(record.import && record.import.state !== 'waiting')
  )
}

/** A finished download that left the client needs no more tracking once its import is settled or never followed. */
function nothingLeftToFollow(config: Config, record: OwnedDownloadRecord): boolean {
  return !record.import || record.import.state === 'imported' || !importView(config, record)
}

function liveView(record: OwnedDownloadRecord, job: LiveJob): DownloadProgress {
  const view: DownloadProgress = {
    ...baseProgress(record),
    phase: job.phase,
    state: job.state,
    progress: job.progress,
    downloaded: job.downloaded,
    total_size: job.total_size,
    speed: job.speed,
    capabilities: job.capabilities,
  }
  if (job.name && !view.title.startsWith('usenet:')) view.title = job.name
  if (job.error) view.error = job.error
  if (view.total_size && !view.size) view.size = view.total_size
  return view
}

/** An accepted download is given time to appear in the client before an absence is treated as meaningful. */
const UNOBSERVED_GRACE_MS = 10 * 60_000

/** True for an accepted record that no client read has ever confirmed and that is past the grace period. */
function isStaleUnobserved(record: OwnedDownloadRecord): boolean {
  if (record.last_phase || record.state !== 'accepted') return false
  const added = Date.parse(record.added_at)
  return Number.isFinite(added) && Date.now() - added > UNOBSERVED_GRACE_MS
}

interface ProgressRead {
  progress: AllDownloadProgress
  /** Live client jobs by record ID, for the controls that follow a read. */
  live: Map<string, LiveJob>
}

/** Reads one client once and projects each of its records onto the shared progress view. */
async function readClient(
  config: Config,
  client: DownloadClientAdapter,
  records: OwnedDownloadRecord[],
  downloads: Record<string, DownloadProgress>,
  live: Map<string, LiveJob>,
): Promise<boolean> {
  if (await client.adoptUnconfirmed?.(records)) records = records.map(record => findDownloadRecord(record.id) || record)
  const isBound = (record: OwnedDownloadRecord) =>
    Boolean(record.endpoint && record.endpoint === client.endpointId && record.native_id)
  const bound = records.filter(isBound)
  let snapshot: ClientSnapshot = { jobs: new Map(), complete: true }
  if (bound.length) {
    try {
      snapshot = await client.read(bound)
    } catch (error) {
      snapshot = { jobs: new Map(), complete: false }
      log('WARNING', `${client.label} progress read failed: ${errorMessage(error)}`)
    }
  }
  // Records bound to another endpoint are reported and never controlled.
  for (const record of records) {
    if (!isBound(record))
      downloads[record.id] =
        record.state === 'acceptance_unknown' && !record.native_id
          ? unconfirmedView(record, client)
          : unboundView(record, client)
  }
  let retired = 0
  let handedOff = 0
  for (let record of bound) {
    const unconfirmed = record.state === 'acceptance_unknown'
    if (unconfirmed && client.nativeIdIsSourceHash && snapshot.jobs.has(record.source_hash))
      record = setDownloadNative(record.id, [record.source_hash]) || record
    if (record.state === 'acceptance_unknown') {
      downloads[record.id] = unconfirmedView(record, client)
      continue
    }
    const job = snapshot.jobs.get(record.native_id)
    if (job) {
      downloads[record.id] = liveView(record, job)
      live.set(record.id, job)
      setDownloadPhase(record.id, job.phase)
    } else if (snapshot.complete && hasFinished(record)) {
      // Removed after finishing, usually by Sonarr or Radarr once imported. The client and the files are untouched.
      if (nothingLeftToFollow(config, record)) {
        markDownloadRemoved(record.id)
        handedOff++
      } else downloads[record.id] = handedOffView(record)
    } else if (snapshot.complete && client.nativeIdIsSourceHash && isStaleUnobserved(record)) {
      // Carried over from the pre-ledger torrent list, or sent long ago: the client never held it while we watched,
      // so there is nothing to warn about. Only our tracking entry is dropped; the client and its files are untouched.
      markDownloadRemoved(record.id)
      retired++
    } else downloads[record.id] = absentView(record, client, snapshot.complete)
  }
  if (handedOff)
    log(
      'INFO',
      `Stopped tracking ${handedOff} finished ${client.jobNoun}(s) that left ${client.label}; the client was not changed`,
    )
  if (retired)
    log(
      'INFO',
      `Stopped tracking ${retired} ${client.jobNoun}(s) that were never seen in ${client.label}; the client was not changed`,
    )
  return snapshot.complete
}

/**
 * Record-keyed live state for every app-owned acquisition. Reads each configured
 * client once per call; endpoint-mismatched records are reported unbound and are
 * never controlled, and failed reads preserve the persisted last-known phase.
 */
async function readDownloadProgress(
  config: Config,
  records: OwnedDownloadRecord[],
  clients: DownloadClients,
): Promise<ProgressRead> {
  const downloads: Record<string, DownloadProgress> = {}
  const live = new Map<string, LiveJob>()
  const unavailable: DownloadClient[] = []
  for (const client of Object.values(clients)) {
    const complete = await readClient(
      config,
      client,
      records.filter(record => record.protocol === client.protocol),
      downloads,
      live,
    )
    if (!complete) unavailable.push(client.client)
  }
  // Read last, so a download seen finishing in this pass already reports that it awaits import.
  for (const view of Object.values(downloads)) {
    const tracked = findDownloadRecord(view.record_id)
    const state = tracked && importView(config, tracked)
    if (state) view.import = state
  }
  return {
    progress: { ok: true, downloads, ...(unavailable.length ? { unavailable_clients: unavailable } : {}) },
    live,
  }
}

export async function collectDownloadProgress(config: Config, clients: DownloadClients): Promise<AllDownloadProgress> {
  return (await readDownloadProgress(config, downloadRecords(), clients)).progress
}

export async function listCancelable(config: Config, clients: DownloadClients): Promise<CancelableDownloads> {
  const progress = await collectDownloadProgress(config, clients)
  const results = resultsForRequest()
  const items: CancelableDownload[] = []
  for (const view of Object.values(progress.downloads)) {
    if (!isCancelable(view)) continue
    const associations = associationTitles(results, view.record_id)
    items.push({
      record_id: view.record_id,
      protocol: view.protocol,
      client: view.client,
      native_id: view.native_id,
      phase: view.phase,
      title: view.title,
      season: view.season,
      part: view.part,
      release_group: view.release_group,
      category: view.category,
      associations: associations.length ? associations : view.labels,
      size: view.size,
      capabilities: view.capabilities,
    })
  }
  items.sort(
    (left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) ||
      (left.season || 0) - (right.season || 0) ||
      left.part.localeCompare(right.part),
  )
  return { ok: true, items }
}

async function removeRecord(
  client: DownloadClientAdapter,
  record: OwnedDownloadRecord,
  view: DownloadProgress,
  job: LiveJob | undefined,
  deleteFiles: boolean,
): Promise<void> {
  if (record.state === 'acceptance_unknown')
    throw new OwnershipError('Submission status is unknown; check the download client before removing this record.')
  if (!view.capabilities.remove)
    throw new OwnershipError(view.error || 'This download cannot be removed in its current state.')
  // A download the client no longer holds only leaves the ledger. Files stay untouched.
  if (job) await client.remove(record.native_id, deleteFiles && view.capabilities.remove_files, job)
  markDownloadRemoved(record.id)
}

/**
 * Removes app-owned acquisitions only. Records bound to a different client endpoint
 * are refused; completed downloads are left for the per-item control surface.
 */
export async function cancelRecords(
  config: Config,
  recordIds: unknown,
  removeFiles: boolean,
  clients: DownloadClients,
): Promise<DownloadCancelResult> {
  if (recordIds !== undefined && !Array.isArray(recordIds)) throw new Error('record_ids must be an array')
  const wanted = recordIds?.map(String)
  const { progress, live } = await readDownloadProgress(config, downloadRecords(), clients)
  const removed: DownloadCancelResult['removed'] = []
  const failures: DownloadCancelResult['failures'] = []
  for (const view of Object.values(progress.downloads)) {
    if (wanted && !wanted.includes(view.record_id)) continue
    const refuse = (error: string) =>
      failures.push({ record_id: view.record_id, client: view.client, label: view.title, error })
    if (view.state === 'unbound') {
      refuse('This download belongs to a different client URL.')
      continue
    }
    if (!cancelablePhase(view.phase)) {
      if (wanted) refuse(view.error || 'This download already finished.')
      continue
    }
    const record = findDownloadRecord(view.record_id)
    if (!record) continue
    try {
      await removeRecord(clients[record.protocol], record, view, live.get(record.id), removeFiles)
      removed.push({ record_id: record.id, client: record.client })
    } catch (error) {
      refuse(errorMessage(error))
    }
  }
  log(
    'INFO',
    `Cancelled ${removed.length} app-owned download(s)${removeFiles ? ' with files' : ' keeping files'}${failures.length ? `; ${failures.length} failed` : ''} (endpoint ${clients.usenet.endpointId || 'no-sab'})`,
  )
  return { ok: failures.length === 0, removed, failures }
}

/** Single-record controls use the saved ownership and a fresh client read. */
export async function controlRecord(
  config: Config,
  recordId: string,
  action: string,
  deleteFiles: boolean,
  clients: DownloadClients,
): Promise<{ ok: true }> {
  const record = findDownloadRecord(recordId)
  if (!record || record.removed_at) throw new OwnershipError('Download record not found.', 404)
  if (action !== 'pause' && action !== 'resume' && action !== 'remove')
    throw new OwnershipError('Unknown download action', 400)
  const client = clients[record.protocol]
  // An unconfirmed submission is only forgotten; the client is never touched, so nothing it holds is lost.
  if (record.state === 'acceptance_unknown' && action === 'remove') {
    markDownloadRemoved(record.id)
    client.forgotten?.(record.id)
    log(
      'INFO',
      `Stopped tracking unconfirmed ${record.client} submission for ${record.source_hash.slice(0, 12)}; the client was not changed`,
    )
    return { ok: true }
  }
  if (!record.endpoint || record.endpoint !== client.endpointId)
    throw new OwnershipError('This download was added through a different client URL; controls are disabled.')
  if (record.state === 'acceptance_unknown')
    throw new OwnershipError('Submission status is unknown; check the download client before controlling this record.')
  const { progress, live } = await readDownloadProgress(config, [record], clients)
  const view = progress.downloads[record.id]
  if (!view) throw new OwnershipError('Download record not found.', 404)
  const job = live.get(record.id)
  if (action === 'remove') await removeRecord(client, record, view, job, deleteFiles)
  else {
    if (!job?.active) throw new OwnershipError(view.error || client.notControllable)
    await client.control(record.native_id, action)
  }
  return { ok: true }
}
