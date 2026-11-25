import { api } from './http.js'
import { log } from './logging.js'
import { errorMessage } from '../shared/errors.js'
import { arrApiBase } from './library.js'
import { configuredArrInstances, parseLibraryKey, type ArrInstance } from './arr-instances.js'
import {
  downloadRecords,
  updateDownloadImport,
  type LibraryTarget,
  type OwnedDownloadRecord,
} from './download-store.js'
import { releaseOwned } from '../shared/download-plan.js'
import type { Config, JsonObject, ResultItem } from './types.js'

/** Time Sonarr or Radarr gets to notice a finished download before its absence from the queue means anything. */
const GRACE_MS = 2 * 60_000
/** Without a queue entry or a library change after this long, the download is reported as not imported. */
const GIVE_UP_MS = 20 * 60_000
/** A requested library rescan gets this long to finish before its outcome is relied on. */
const RESCAN_SETTLE_MS = 3 * 60_000
/** The queue of Sonarr or Radarr is watched this long after a download finishes. */
const QUEUE_WINDOW_MS = 24 * 60 * 60_000
/** Later scans can still confirm an import this long after a download finished. */
const RECHECK_WINDOW_MS = 14 * 24 * 60 * 60_000
/** A download that never finishes is not polled forever. */
const WAITING_WINDOW_MS = 30 * 24 * 60 * 60_000
/** Sonarr and Radarr show passing warnings while they unpack and copy; only a lasting one is worth a notification. */
const BLOCKED_NOTIFY_MS = 5 * 60_000
const QUEUE_RETRY_MS = 5 * 60_000
const FOLLOW_SLACK_MS = 10 * 60_000

const elapsed = (now: number, since: string | undefined) => {
  const at = Date.parse(since || '')
  return Number.isFinite(at) ? now - at : Infinity
}
const groupKey = (group: string) => group.trim().toLowerCase()

/** Whether the library now holds the release a download was sent for; null when the season is not in the results. */
function targetOwned(results: ResultItem[], target: LibraryTarget): boolean | null {
  const result = results.find(
    item => item.library_key === target.key && Number(item.season || 0) === Number(target.season || 0),
  )
  if (!result) return null
  // A group can list several releases for one part; holding any of them is an import of the group's files.
  const releases = result.releases.filter(
    candidate => (candidate.part || '') === target.part && groupKey(candidate.releaseGroup) === groupKey(target.group),
  )
  if (releases.length) return releases.some(release => releaseOwned(result, release))
  // The recommendation changed since the download was sent; the files themselves still tell.
  const groups =
    (target.part && result.precise_part_ownership ? result.owned_by_part?.[target.part] : result.have) || []
  return groups.some(group => groupKey(group) === groupKey(target.group))
}

/**
 * Called with every new set of scan results. A finished download counts as imported once the
 * library holds its release for every season it was sent for. This is the only way an import is
 * confirmed: the queue of Sonarr or Radarr can explain a delay, but only the files prove the outcome.
 */
export function settleImports(results: ResultItem[], now = Date.now()): number {
  let settled = 0
  for (const record of downloadRecords()) {
    const tracking = record.import
    if (!tracking || !record.library?.length || tracking.state === 'waiting' || tracking.state === 'imported') continue
    if (elapsed(now, tracking.completed_at || tracking.since) > RECHECK_WINDOW_MS) continue
    const known = record.library
      .map(target => targetOwned(results, target))
      .filter((owned): owned is boolean => owned !== null)
    if (!known.length || !known.every(Boolean)) continue
    updateDownloadImport(record.id, { state: 'imported', message: undefined })
    settled += 1
    log(
      'INFO',
      `Import confirmed for ${record.card?.title || record.labels[0] || record.source_hash.slice(0, 12)}${record.card?.release_group ? ` [${record.card.release_group}]` : ''}`,
    )
  }
  return settled
}

export interface ArrQueueItem {
  downloadId: string
  state: string
  status: string
  messages: string[]
}

/** The download queue of one Sonarr or Radarr instance, including downloads it could not match to a title. */
export async function readArrQueue(instance: ArrInstance): Promise<ArrQueueItem[]> {
  const base = await arrApiBase(instance)
  const unknown = instance.kind === 'sonarr' ? 'includeUnknownSeriesItems' : 'includeUnknownMovieItems'
  const data = (await api(
    `${base}/queue?page=1&pageSize=1000&${unknown}=true`,
    instance.key,
    {},
    instance.kind === 'sonarr',
  )) as JsonObject
  const records: JsonObject[] = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : []
  return records.map(record => {
    const messages = [
      ...(Array.isArray(record.statusMessages)
        ? record.statusMessages.flatMap((entry: JsonObject) => (Array.isArray(entry?.messages) ? entry.messages : []))
        : []),
      record.errorMessage,
    ]
      .filter((message): message is string => typeof message === 'string' && Boolean(message.trim()))
      .map(message => message.trim())
    return {
      downloadId: String(record.downloadId || ''),
      state: String(record.trackedDownloadState || ''),
      status: String(record.trackedDownloadStatus || ''),
      messages: [...new Set(messages)],
    }
  })
}

/** The reason a queued download is not being imported, in the app's own words; null while it is still on its way. */
export function queueProblem(item: ArrQueueItem, appName: string): string | null {
  const state = item.state.toLowerCase()
  const stuck =
    state === 'importblocked' ||
    state === 'failedpending' ||
    state === 'failed' ||
    state === 'ignored' ||
    (state === 'importpending' && item.status.toLowerCase() !== 'ok' && item.messages.length > 0)
  if (!stuck) return null
  const detail = item.messages.slice(0, 3).join(' ').slice(0, 400)
  return detail || `${appName} reports a problem importing this download.`
}

export interface ImportProblem {
  title: string
  season: number | null
  releaseGroup: string
  app: string
  state: 'blocked' | 'not_imported'
  message: string
}

export interface FollowDependencies {
  /** Reads the download clients, which records the moment a download finishes. */
  readProgress: (config: Config) => Promise<unknown>
  readQueue: (instance: ArrInstance) => Promise<ArrQueueItem[]>
  /** Asks for a rescan of one library title so its new files are seen. */
  requestScan: (instance: ArrInstance, itemId: number) => void
  notify: (config: Config, problem: ImportProblem) => Promise<boolean>
  scanRunning: () => boolean
  now?: () => number
}

const queueRetryAt = new Map<string, number>()
export function resetImportFollowRuntime(): void {
  queueRetryAt.clear()
}

function instanceOfRecord(instances: ArrInstance[], record: OwnedDownloadRecord): ArrInstance | undefined {
  const target = parseLibraryKey(record.library?.[0]?.key || '')
  return target ? instances.find(instance => instance.id === target.instanceId) : undefined
}

/** Whether any download still needs the periodic check. */
export function importsToFollow(now = Date.now()): boolean {
  return downloadRecords().some(record => {
    const tracking = record.import
    if (!tracking || record.state !== 'accepted') return false
    if (tracking.state === 'waiting') return elapsed(now, record.added_at) < WAITING_WINDOW_MS
    // The slack lets an overdue wait be closed and a fresh problem be reported once.
    if (tracking.state === 'pending' || tracking.state === 'blocked')
      return elapsed(now, tracking.completed_at || tracking.since) < QUEUE_WINDOW_MS + FOLLOW_SLACK_MS
    return tracking.state === 'not_imported' && !tracking.notified && elapsed(now, tracking.since) < FOLLOW_SLACK_MS
  })
}

/**
 * One periodic check. It never changes anything in Sonarr, Radarr, or a download client:
 * it reads their state, asks for a library rescan when a finished download has left the queue,
 * and records why an import is stuck.
 */
export async function followImports(config: Config, dependencies: FollowDependencies): Promise<void> {
  const now = (dependencies.now || Date.now)()
  if (!importsToFollow(now)) return
  try {
    await dependencies.readProgress(config)
  } catch (error) {
    log('WARNING', `Import follow-up could not read the download clients: ${errorMessage(error)}`)
  }

  const instances = configuredArrInstances(config)
  const open = downloadRecords().filter(
    record =>
      record.import &&
      record.library?.length &&
      (record.import.state === 'pending' || record.import.state === 'blocked'),
  )
  const byInstance = new Map<ArrInstance, OwnedDownloadRecord[]>()
  for (const record of open) {
    const instance = instanceOfRecord(instances, record)
    if (instance) byInstance.set(instance, [...(byInstance.get(instance) || []), record])
  }
  for (const [instance, records] of byInstance) {
    const overdue = records.filter(
      record => elapsed(now, record.import!.completed_at || record.import!.since) >= QUEUE_WINDOW_MS,
    )
    for (const record of overdue)
      if (record.import!.state === 'pending') {
        updateDownloadImport(record.id, {
          state: 'not_imported',
          message: `${instance.name} did not import this download within a day.`,
        })
      }
    const watched = records.filter(record => !overdue.includes(record))
    if (!watched.length || (queueRetryAt.get(instance.id) || 0) > now) continue
    let queue: ArrQueueItem[]
    try {
      queue = await dependencies.readQueue(instance)
      queueRetryAt.delete(instance.id)
    } catch (error) {
      queueRetryAt.set(instance.id, now + QUEUE_RETRY_MS)
      log('WARNING', `Import follow-up could not read the ${instance.name} queue: ${errorMessage(error)}`)
      continue
    }
    for (const record of watched) {
      const tracking = record.import!
      const item = record.native_id
        ? queue.find(entry => entry.downloadId.toLowerCase() === record.native_id.toLowerCase())
        : undefined
      if (item) {
        const problem = queueProblem(item, instance.name)
        if (problem && (tracking.state !== 'blocked' || tracking.message !== problem)) {
          updateDownloadImport(record.id, {
            state: 'blocked',
            message: problem,
            rescans: undefined,
            rescan_at: undefined,
          })
          if (tracking.state !== 'blocked')
            log(
              'WARNING',
              `${instance.name} is not importing ${record.card?.title || record.source_hash.slice(0, 12)}: ${problem}`,
            )
        } else if (!problem && tracking.state === 'blocked') {
          updateDownloadImport(record.id, { state: 'pending', message: undefined })
        }
        continue
      }
      const age = elapsed(now, tracking.completed_at || tracking.since)
      if (age < GRACE_MS) continue
      const rescan = (count: number) => {
        for (const itemId of new Set(
          record
            .library!.map(target => parseLibraryKey(target.key)?.itemId)
            .filter((id): id is number => id !== undefined),
        ))
          dependencies.requestScan(instance, itemId)
        updateDownloadImport(record.id, { rescans: count, rescan_at: new Date(now).toISOString() })
      }
      // The download left the queue: either it was imported or the app gave up on it. The library tells which.
      if (!tracking.rescans) rescan(1)
      else if (age > GIVE_UP_MS && tracking.rescans < 2) rescan(2)
      else if (age > GIVE_UP_MS && elapsed(now, tracking.rescan_at) > RESCAN_SETTLE_MS && !dependencies.scanRunning()) {
        const message = `${instance.name} is not handling this download and the library files did not change. Check that ${instance.name} watches the "${record.category}" category and can reach the download folder.`
        updateDownloadImport(record.id, { state: 'not_imported', message })
        log(
          'WARNING',
          `Download finished but was not imported: ${record.card?.title || record.source_hash.slice(0, 12)} (${instance.name})`,
        )
      }
    }
  }

  if (!config.notify_enabled || !config.notify_import_problems || !config.webhook) return
  for (const record of downloadRecords()) {
    const tracking = record.import
    if (!tracking || tracking.notified || (tracking.state !== 'blocked' && tracking.state !== 'not_imported')) continue
    if (elapsed(now, tracking.since) >= QUEUE_WINDOW_MS) continue
    if (tracking.state === 'blocked' && elapsed(now, tracking.since) < BLOCKED_NOTIFY_MS) continue
    const instance = instanceOfRecord(instances, record)
    const sent = await dependencies.notify(config, {
      title: record.card?.title || record.labels[0] || record.source_hash,
      season: record.card?.season ?? null,
      releaseGroup: record.card?.release_group || '',
      app: instance?.name || 'Sonarr or Radarr',
      state: tracking.state,
      message: tracking.message || '',
    })
    if (sent) updateDownloadImport(record.id, { notified: true })
  }
}
