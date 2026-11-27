import type { Config } from './types.js'
import type { DiskSpaceCheck, DownloadPhase } from '../shared/download-contracts.js'
import {
  sabAddNzb,
  sabDeleteHistoryJob,
  sabDeleteQueueJob,
  sabDiskSpace,
  sabFindJobsByName,
  sabHistoryJobs,
  sabMissingCategories,
  sabPauseJob,
  sabQueueJobs,
  sabResumeJob,
  sabSubmissionName,
  SabnzbdAmbiguousError,
  type SabHistoryJob,
  type SabQueueJob,
} from './sabnzbd.js'
import { sabEndpoint, sabSettings } from './client-identity.js'
import { downloadRecords, setDownloadNative, type OwnedDownloadRecord } from './download-store.js'
import { fetchUsenetNzb } from './usenet.js'
import { log } from './logging.js'
import { errorMessage } from '../shared/errors.js'
import {
  OwnershipError,
  spaceVerdict,
  unitSizing,
  type DownloadClientAdapter,
  type DownloadSpaceLocation,
  type LiveJob,
  type SubmissionUnit,
} from './download-client-types.js'

export function queuePhase(status: string): DownloadPhase {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'paused') return 'paused'
  if (normalized === 'queued' || normalized === 'propagating') return 'queued'
  return 'downloading'
}

export function historyPhase(status: string): DownloadPhase {
  switch (status.trim().toLowerCase()) {
    case 'quickcheck':
    case 'verifying':
      return 'verifying'
    case 'repairing':
      return 'repairing'
    case 'extracting':
      return 'unpacking'
    case 'completed':
      return 'complete'
    case 'failed':
      return 'error'
    default:
      return 'post_processing'
  }
}

const ratio = (done: number, total: number): number => Math.floor((done / total) * 10_000) / 10_000

function liveQueueJob(job: SabQueueJob): LiveJob {
  const phase = queuePhase(job.status)
  return {
    phase,
    state: job.status,
    total_size: job.total_bytes,
    downloaded: job.downloaded_bytes,
    progress:
      job.total_bytes > 0 ? ratio(job.downloaded_bytes, job.total_bytes) : Math.floor(job.percentage * 100) / 10_000,
    speed: job.speed_bytes_per_sec,
    active: true,
    capabilities: { pause: phase !== 'paused', resume: phase === 'paused', remove: true, remove_files: true },
    ...(job.name ? { name: job.name } : {}),
  }
}

function liveHistoryJob(job: SabHistoryJob): LiveJob {
  const phase = historyPhase(job.status)
  return {
    phase,
    state: job.status,
    total_size: job.total_bytes,
    downloaded: job.downloaded_bytes,
    progress: job.total_bytes > 0 ? ratio(job.downloaded_bytes, job.total_bytes) : 1,
    speed: 0,
    active: false,
    // SABnzbd refuses to delete a history entry it is still post-processing.
    capabilities: { pause: false, resume: false, remove: !job.loaded, remove_files: !job.loaded && phase === 'error' },
    ...(job.name ? { name: job.name } : {}),
    ...(phase === 'error' && job.fail_message ? { error: job.fail_message } : {}),
  }
}

const UNCONFIRMED_RETRY_MS = 60_000
/** When each unconfirmed submission was last looked up by name, so progress polls do not repeat the search. */
const unconfirmedAttempts = new Map<string, number>()

export function sabnzbdAdapter(config: Config): DownloadClientAdapter {
  const { endpointId } = sabEndpoint(config)
  const settings = sabSettings(config)

  /** SABnzbd reports one figure per folder, not per category, so every category shares both checks. */
  async function diskChecks(units: SubmissionUnit[]): Promise<DiskSpaceCheck[]> {
    const categories = [...new Set(units.map(unit => unit.category))]
    const { required, uncertain, unsized } = unitSizing(units)
    let free: { incomplete_free_bytes: number | null; complete_free_bytes: number | null } = {
      incomplete_free_bytes: null,
      complete_free_bytes: null,
    }
    let reason: string | undefined
    try {
      if (!settings) throw new Error('SABnzbd is not configured')
      free = await sabDiskSpace(settings)
      if (free.incomplete_free_bytes === null && free.complete_free_bytes === null)
        reason = 'SABnzbd did not report free space for its folders.'
    } catch (error) {
      reason = `Could not read SABnzbd storage information: ${errorMessage(error).slice(0, 120)}`
    }
    const folders: [string, number | null][] = [
      ['SABnzbd incomplete folder', free.incomplete_free_bytes],
      ['SABnzbd completed folder', free.complete_free_bytes],
    ]
    return folders.map(([label, bytes]) => ({
      client: 'sabnzbd',
      path: null,
      label,
      categories,
      required_bytes: required,
      unknown_units: uncertain,
      free_bytes: bytes,
      sufficient: spaceVerdict(bytes, required, uncertain - unsized, unsized),
      reason: reason || 'Category folders on other disks are not checked.',
    }))
  }

  async function freeSpace(): Promise<DownloadSpaceLocation[]> {
    if (!settings) return []
    try {
      const space = await sabDiskSpace(settings)
      return [{ client: 'sabnzbd', label: 'SABnzbd completed folder', free_bytes: space.complete_free_bytes }]
    } catch (error) {
      return [
        {
          client: 'sabnzbd',
          label: 'SABnzbd completed folder',
          free_bytes: null,
          reason: `Could not read SABnzbd storage: ${errorMessage(error).slice(0, 120)}`,
        },
      ]
    }
  }

  /**
   * Adopts unconfirmed submissions that SABnzbd did accept: exactly one queue or history job
   * with the submitted name and category, not already owned by another record. Anything less
   * certain stays unconfirmed for the user to resolve.
   */
  async function adoptUnconfirmed(records: OwnedDownloadRecord[]): Promise<boolean> {
    if (!settings) return false
    const now = Date.now()
    const pending = records.filter(
      record =>
        record.state === 'acceptance_unknown' &&
        !record.native_id &&
        record.endpoint === endpointId &&
        now - (unconfirmedAttempts.get(record.id) || 0) >= UNCONFIRMED_RETRY_MS,
    )
    if (!pending.length) return false
    const owned = new Set(
      downloadRecords()
        .filter(record => record.protocol === 'usenet' && record.native_id)
        .map(record => record.native_id),
    )
    let adopted = false
    for (const record of pending) {
      unconfirmedAttempts.set(record.id, now)
      try {
        const jobs = (await sabFindJobsByName(settings, sabSubmissionName(record.nzb_name, record.source_hash))).filter(
          job => !owned.has(job.nzo_id) && job.category.trim().toLowerCase() === record.category.trim().toLowerCase(),
        )
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

  return {
    protocol: 'usenet',
    client: 'sabnzbd',
    label: 'SABnzbd',
    jobNoun: 'job',
    endpointId,
    nativeIdIsSourceHash: false,
    notControllable: 'This job is not in the SABnzbd queue anymore.',
    async read(records) {
      if (!settings) return { jobs: new Map(), complete: false }
      const ids = records.map(record => record.native_id)
      const [queue, history] = await Promise.all([sabQueueJobs(settings, ids), sabHistoryJobs(settings, ids)])
      // A job listed in both is still being worked on, so its queue entry wins.
      const jobs = new Map<string, LiveJob>(history.jobs.map(job => [job.nzo_id, liveHistoryJob(job)]))
      for (const job of queue.jobs) jobs.set(job.nzo_id, liveQueueJob(job))
      return { jobs, complete: queue.read_complete && history.read_complete }
    },
    async presence(records) {
      const ids = records
        .filter(
          record =>
            record.protocol === 'usenet' &&
            record.state === 'accepted' &&
            record.endpoint === endpointId &&
            record.native_id,
        )
        .map(record => record.native_id)
      if (!ids.length) return { ids: new Set(), complete: true }
      if (!settings) return { ids: new Set(), complete: false }
      const [queue, history] = await Promise.all([sabQueueJobs(settings, ids), sabHistoryJobs(settings, ids)])
      return {
        ids: new Set([...queue.jobs, ...history.jobs].map(job => job.nzo_id)),
        complete: queue.read_complete && history.read_complete,
      }
    },
    async submit(unit, ownership) {
      try {
        if (!settings) throw new Error('SABnzbd is no longer configured.')
        if (!unit.provider || !unit.entryId)
          throw new Error('The Usenet source reference is no longer available. Re-run the review.')
        const nzb = await fetchUsenetNzb(config, unit.provider, unit.entryId, unit.source_hash, unit.sourceFiles)
        const nzoIds = await sabAddNzb(settings, nzb, sabSubmissionName(unit.nzb_name, unit.source_hash), unit.category)
        ownership.accepted(nzoIds)
        return nzoIds[0]
      } catch (error) {
        // The job may well be in SABnzbd. The record is kept and the add is never retried automatically.
        if (error instanceof SabnzbdAmbiguousError)
          log(
            'WARNING',
            `SABnzbd submission status unknown for ${unit.source_hash.slice(0, 12)}; record kept for manual reconciliation`,
          )
        throw error
      }
    },
    ambiguity: error =>
      error instanceof SabnzbdAmbiguousError ? 'Submission status unknown. Check SABnzbd before retrying.' : null,
    async control(nativeId, action) {
      if (!settings) throw new OwnershipError('SABnzbd is not configured.')
      if (action === 'pause') await sabPauseJob(settings, nativeId)
      else await sabResumeJob(settings, nativeId)
    },
    async remove(nativeId, removeFiles, job) {
      if (!settings) throw new OwnershipError('SABnzbd is not configured.')
      if (job?.active) await sabDeleteQueueJob(settings, nativeId, removeFiles)
      else await sabDeleteHistoryJob(settings, nativeId, removeFiles)
    },
    diskChecks,
    freeSpace,
    unknownCategories: async categories => (settings ? sabMissingCategories(settings, categories) : null),
    adoptUnconfirmed,
    forgotten: recordId => {
      unconfirmedAttempts.delete(recordId)
    },
  }
}
