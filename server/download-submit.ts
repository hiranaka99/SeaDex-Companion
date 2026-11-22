import type { Config, Release, ResultItem } from './types.js'
import type { BulkSubmissionResult, DownloadJob, DownloadReceipt, DownloadSelectionRef, DownloadUnitEntry, DownloadUnitFailure } from '../shared/download-contracts.js'
import { currentGeneration } from './config-generation.js'
import type { StoredPlan } from './download-plans.js'
import { buildDownloadPlan, type SubmissionUnit } from './download-preflight.js'
import { downloadJobs, jobResult } from './download-jobs.js'
import { addDownloadRecord, markDownloadRemoved, setDownloadNative } from './download-store.js'
import { qbAddTorrent, QbittorrentAmbiguousError } from './qbittorrent.js'
import { sabAddNzb, SabnzbdAmbiguousError } from './sabnzbd.js'
import { qbEndpointId, sabEndpoint } from './client-identity.js'
import { fetchUsenetNzb } from './usenet.js'
import { errorMessage, log } from './logging.js'

/** A plan failed acceptance validation; the status is the HTTP status the route should report. */
export class PlanRejected extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const rowId = (selection: DownloadSelectionRef) => `${selection.key}\u0000${selection.release}`

// One submission chain: a second confirmation of the same plan can never race a
// first one into a duplicate NZB or torrent, whatever the client-side debounce says.
let acceptanceChain: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = acceptanceChain.then(task, task)
  acceptanceChain = run.then(() => undefined, () => undefined)
  return run
}

export interface AcknowledgeFlags { whole_source?: boolean; disk_space?: boolean }

function cardFor(selections: DownloadSelectionRef[], resultsById: Map<string, ResultItem>) {
  const first = selections[0]
  const result = first ? resultsById.get(first.key) : undefined
  const release: Release | undefined = result?.releases?.[first?.release ?? -1]
  if (!result || !release) return undefined
  return { title: result.title || result.key, season: result.season ?? null, part: release.part || '', release_group: release.releaseGroup, tracker: release.tracker, size: release.size ?? 0 }
}

/**
 * Accepts an expiring review plan: re-runs the full preflight against live state,
 * re-validates generation and acknowledgements, then submits each surviving unit with
 * an intent record written before any client mutation. Blocked review rows become
 * per-row failures; the rest still submit.
 */
export async function acceptDownloadPlan(
  config: Config,
  plan: StoredPlan,
  acknowledge: AcknowledgeFlags | undefined,
  results: ResultItem[],
): Promise<{ job: DownloadJob; completion: Promise<BulkSubmissionResult> }> {
  if (plan.config_generation !== currentGeneration()) {
    throw new PlanRejected(409, 'Settings changed after this review. Re-run the review before submitting.')
  }

  const built = await buildDownloadPlan(config, plan.selections, { results })
  if ('error' in built) throw new PlanRejected(built.error[0], built.error[1])
  const { review, units } = built
  if (plan.config_generation !== currentGeneration()) {
    throw new PlanRejected(409, 'Settings changed during acceptance. Re-run the review before submitting.')
  }
  if (review.requires_whole_ack && !acknowledge?.whole_source) {
    throw new PlanRejected(409, 'This batch sends whole Usenet sources including files you did not select. Re-open the review and confirm again.')
  }
  if (review.requires_space_ack && !acknowledge?.disk_space) {
    throw new PlanRejected(409, 'This batch needs disk space that could not be confirmed. Re-open the review and confirm again.')
  }

  const blockedByKey = new Map(review.blocked.map(blocked => [rowId(blocked), blocked]))
  const isBlocked = (selection: DownloadSelectionRef) => blockedByKey.has(rowId(selection))

  // Every requested row remains a job target, including rows blocked by the live review.
  const targets = plan.selections
  const allowedUnitSelections = (selections: DownloadSelectionRef[]) => selections.filter(selection =>
    !isBlocked(selection) && targets.some(target => target.key === selection.key && target.release === selection.release))

  const failures: DownloadUnitFailure[] = review.blocked.flatMap(blocked => {
    const pinned = plan.selections.find(selection => selection.key === blocked.key && selection.release === blocked.release)
    if (!pinned) return []
    return [{ protocol: pinned.protocol, label: `${blocked.key}#${blocked.release}`, code: blocked.code, error: blocked.reason, selections: [{ key: blocked.key, release: blocked.release }] }]
  })

  const existing: DownloadUnitEntry[] = review.units
    .filter(unit => unit.status === 'existing')
    .map(unit => ({ unit_id: unit.unit_id, protocol: unit.protocol, source_hash: unit.source_hash, label: unit.labels[0] || unit.source_hash, selections: allowedUnitSelections(unit.selections), record_id: unit.existing_record_id, native_id: unit.existing_native_id }))
    .filter(entry => entry.selections.length)

  const newUnits = units
    .filter(unit => unit.status === 'new')
    .map(unit => ({ ...unit, selections: allowedUnitSelections(unit.selections) }))
    .filter(unit => unit.selections.length)

  const resultsById = new Map(results.map(result => [result.key, result]))
  const job = downloadJobs.begin(
    targets.map(selection => ({ key: selection.key, release: selection.release, identity: selection.identity, protocol: selection.protocol })),
    newUnits.map(unit => ({ unit_id: unit.unit_id, protocol: unit.protocol, source_hash: unit.source_hash, label: unit.labels.join(' / ') || unit.source_hash, selections: unit.selections })),
    { existing, failures },
  )

  const completion = serialized(async () => {
    try {
      for (const unit of newUnits) await submitUnit(config, job.id, unit, resultsById)
      return jobResult(downloadJobs.finish(job.id))
    } catch (error) {
      try {
        downloadJobs.finish(job.id, `Submission stopped: ${errorMessage(error)}`)
      } catch (storageError) {
        throw new AggregateError([error, storageError], `Submission stopped and the job could not be finalized: ${errorMessage(error)}; ${errorMessage(storageError)}`)
      }
      throw error
    }
  })
  return { job, completion }
}

async function submitUnit(config: Config, jobId: string, unit: SubmissionUnit, resultsById: Map<string, ResultItem>) {
  const label = unit.labels.join(' / ') || unit.source_hash
  const card = cardFor(unit.selections, resultsById)
  if (unit.protocol === 'torrent') {
    const record = addDownloadRecord({
      protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), native_id: unit.source_hash,
      state: 'acceptance_unknown', source_hash: unit.source_hash, category: unit.category, card, labels: unit.labels, rows: unit.selections,
      scope: unit.requestedPaths.length ? unit.requestedPaths : undefined,
    })
    let accepted = false
    let removed = false
    let ownershipWriteError: unknown
    try {
      await qbAddTorrent(config, `magnet:?xt=urn:btih:${unit.source_hash}`, unit.category, unit.requestedPaths, undefined, {
        record: () => {
          accepted = true
          try { setDownloadNative(record.id, [unit.source_hash]) }
          catch (error) { ownershipWriteError = error; throw error }
        },
        forget: () => { markDownloadRemoved(record.id); removed = true },
      })
      try { downloadJobs.added(jobId, unit.unit_id, { record_id: record.id, native_id: unit.source_hash }) }
      catch (error) { ownershipWriteError = error; throw error }
    } catch (error) {
      const ambiguous = error instanceof QbittorrentAmbiguousError
      if (!accepted && !removed && !ambiguous) markDownloadRemoved(record.id)
      downloadJobs.failure(jobId, {
        unit_id: unit.unit_id, protocol: 'torrent', record_id: record.id, source_hash: unit.source_hash, label,
        code: ambiguous ? 'acceptance_unknown' : ownershipWriteError ? 'storage' : 'client',
        error: ambiguous ? `Submission status unknown. Check qBittorrent before retrying. ${errorMessage(error)}` : errorMessage(error), selections: unit.selections,
      })
      if (ownershipWriteError) throw ownershipWriteError
    }
    return
  }

  const { apiUrl, endpointId } = sabEndpoint(config)
  const record = addDownloadRecord({
    protocol: 'usenet', client: 'sabnzbd', endpoint: endpointId, native_id: '',
    state: 'acceptance_unknown', source_hash: unit.source_hash, category: unit.category,
    provider: unit.provider, entry_id: unit.entryId, nzb_name: unit.nzb_name, card, labels: unit.labels, rows: unit.selections,
  })
  let accepted = false
  try {
    if (!apiUrl || !config.sabnzbd_key) throw new Error('SABnzbd is no longer configured.')
    if (!unit.provider || !unit.entryId) throw new Error('The Usenet source reference is no longer available. Re-run the review.')
    const nzb = await fetchUsenetNzb(config, unit.provider, unit.entryId, unit.source_hash)
    const nzoIds = await sabAddNzb({ apiUrl, apiKey: config.sabnzbd_key }, nzb, unit.nzb_name || `${unit.source_hash.slice(0, 12)}.nzb`, unit.category, globalThis.fetch)
    accepted = true
    setDownloadNative(record.id, nzoIds)
    downloadJobs.added(jobId, unit.unit_id, { record_id: record.id, native_id: nzoIds[0] })
  } catch (error) {
    if (error instanceof SabnzbdAmbiguousError) {
      // The job may well be in SABnzbd. Keep the record, never auto-retry the add.
      log('WARNING', `SABnzbd submission status unknown for ${unit.source_hash.slice(0, 12)}; record kept for manual reconciliation`)
      downloadJobs.failure(jobId, { unit_id: unit.unit_id, protocol: 'usenet', record_id: record.id, source_hash: unit.source_hash, label, code: 'acceptance_unknown', error: 'Submission status unknown. Check SABnzbd before retrying.', selections: unit.selections })
      return
    }
    if (!accepted) markDownloadRemoved(record.id)
    downloadJobs.failure(jobId, { unit_id: unit.unit_id, protocol: 'usenet', record_id: record.id, source_hash: unit.source_hash, label, code: accepted ? 'storage' : 'client', error: errorMessage(error), selections: unit.selections })
    if (accepted) throw error
  }
}

/** Builds a single-release receipt from every required source in its job. */
export function receiptFromJob(job: DownloadJob): DownloadReceipt | { error: string } {
  const failures: DownloadUnitFailure[] = [...job.failures, ...job.pending.map(unit => ({ ...unit, code: 'acceptance_unknown', error: 'The submission did not settle; check the download client before retrying.' }))]
  const entry = job.added[0] || job.existing[0] || failures[0]
  if (!entry) return { error: 'The submission did not settle; check the download client before retrying.' }
  const protocol = entry.protocol
  const successful = job.added.length + job.existing.length
  return {
    ok: job.finished && failures.length === 0, record_id: entry.record_id || '', native_id: 'native_id' in entry ? entry.native_id || '' : '',
    protocol, client: protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd', source_hash: entry.source_hash || '', category: '',
    ...(failures.some(failure => failure.code === 'acceptance_unknown') ? { acceptance_unknown: true } : {}),
    ...(failures.length ? {
      failures,
      error: `${successful ? `${successful} source(s) ready, but ` : ''}${failures.length} source(s) failed: ${failures.map(failure => `${failure.label}: ${failure.error}`).join('; ')}`,
    } : {}),
  }
}
