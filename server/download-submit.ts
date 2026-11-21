import type { Config, Release, ResultItem } from './types.js'
import type { BulkSubmissionResult, DownloadJob, DownloadReceipt, DownloadSelectionRef, DownloadUnitEntry, DownloadUnitFailure } from '../shared/download-contracts.js'
import { currentGeneration } from './config-generation.js'
import type { StoredPlan } from './download-plans.js'
import { buildDownloadPlan, type SubmissionUnit } from './download-preflight.js'
import { downloadJobs, jobResult } from './download-jobs.js'
import { addDownloadRecord, markDownloadRemoved, setDownloadNative } from './download-store.js'
import { qbAddTorrent } from './qbittorrent.js'
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
  if (plan.requires_whole_ack && !acknowledge?.whole_source) {
    throw new PlanRejected(409, 'This batch sends whole Usenet sources including files you did not select. Re-open the review and confirm again.')
  }
  if (plan.requires_space_ack && !acknowledge?.disk_space) {
    throw new PlanRejected(409, 'This batch needs disk space that could not be confirmed. Re-open the review and confirm again.')
  }

  const built = await buildDownloadPlan(config, plan.selections, { results })
  if ('error' in built) throw new PlanRejected(built.error[0], built.error[1])
  const { review, units } = built

  const blockedByKey = new Map(review.blocked.map(blocked => [rowId(blocked), blocked]))
  const isBlocked = (selection: DownloadSelectionRef) => blockedByKey.has(rowId(selection))

  // Selections the rebuilt review still allows: these become job targets.
  const targets = plan.selections.filter(selection => !blockedByKey.has(rowId(selection)))
  const allowedUnitSelections = (selections: DownloadSelectionRef[]) => selections.filter(selection =>
    !isBlocked(selection) && targets.some(target => target.key === selection.key && target.release === selection.release))

  const failures: DownloadUnitFailure[] = review.blocked.flatMap(blocked => {
    const pinned = plan.selections.find(selection => selection.key === blocked.key && selection.release === blocked.release)
    if (!pinned) return []
    return [{ protocol: pinned.protocol, label: `${blocked.key}#${blocked.release}`, code: blocked.code, error: blocked.reason, selections: [{ key: blocked.key, release: blocked.release }] }]
  })

  const existing: DownloadUnitEntry[] = review.units
    .filter(unit => unit.status === 'existing')
    .map(unit => ({ unit_id: unit.unit_id, protocol: unit.protocol, source_hash: unit.source_hash, label: unit.labels[0] || unit.source_hash, selections: allowedUnitSelections(unit.selections) }))
    .filter(entry => entry.selections.length)

  const newUnits = units
    .filter(unit => unit.status === 'new')
    .map(unit => ({ ...unit, selections: allowedUnitSelections(unit.selections) }))
    .filter(unit => unit.selections.length)

  const resultsById = new Map(results.map(result => [result.key, result]))
  const job = downloadJobs.begin(
    targets.map(selection => ({ key: selection.key, release: selection.release, identity: selection.identity })),
    newUnits.map(unit => ({ unit_id: unit.unit_id, protocol: unit.protocol, source_hash: unit.source_hash, label: unit.labels.join(' / ') || unit.source_hash })),
    { existing, failures },
  )

  const completion = serialized(async () => {
    for (const unit of newUnits) await submitUnit(config, job.id, unit, resultsById)
    const finalJob = downloadJobs.finish(job.id)
    return jobResult(finalJob || downloadJobs.get(job.id)!)
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
    })
    try {
      await qbAddTorrent(config, `magnet:?xt=urn:btih:${unit.source_hash}`, unit.category, unit.requestedPaths.length ? unit.requestedPaths : undefined, undefined,
        { record: () => undefined, forget: () => undefined })
      setDownloadNative(record.id, [unit.source_hash])
      downloadJobs.added(jobId, unit.unit_id, { record_id: record.id, native_id: unit.source_hash })
    } catch (error) {
      markDownloadRemoved(record.id)
      downloadJobs.failure(jobId, { unit_id: unit.unit_id, protocol: 'torrent', record_id: record.id, source_hash: unit.source_hash, label, code: 'client', error: errorMessage(error), selections: unit.selections })
    }
    return
  }

  const { apiUrl, endpointId } = sabEndpoint(config)
  const record = addDownloadRecord({
    protocol: 'usenet', client: 'sabnzbd', endpoint: endpointId, native_id: '',
    state: 'acceptance_unknown', source_hash: unit.source_hash, category: unit.category,
    provider: unit.provider, entry_id: unit.entryId, nzb_name: unit.nzb_name, card, labels: unit.labels, rows: unit.selections,
  })
  try {
    if (!apiUrl || !config.sabnzbd_key) throw new Error('SABnzbd is no longer configured.')
    if (!unit.provider || !unit.entryId) throw new Error('The Usenet source reference is no longer available. Re-run the review.')
    const nzb = await fetchUsenetNzb(config, unit.provider, unit.entryId, unit.source_hash)
    const nzoIds = await sabAddNzb({ apiUrl, apiKey: config.sabnzbd_key }, nzb, unit.nzb_name || `${unit.source_hash.slice(0, 12)}.nzb`, unit.category, globalThis.fetch)
    setDownloadNative(record.id, nzoIds)
    downloadJobs.added(jobId, unit.unit_id, { record_id: record.id, native_id: nzoIds[0] })
  } catch (error) {
    if (error instanceof SabnzbdAmbiguousError) {
      // The job may well be in SABnzbd. Keep the record, never auto-retry the add.
      log('WARNING', `SABnzbd submission status unknown for ${unit.source_hash.slice(0, 12)}; record kept for manual reconciliation`)
      downloadJobs.failure(jobId, { unit_id: unit.unit_id, protocol: 'usenet', record_id: record.id, source_hash: unit.source_hash, label, code: 'acceptance_unknown', error: 'Submission status unknown. Check SABnzbd before retrying.', selections: unit.selections })
      return
    }
    markDownloadRemoved(record.id)
    downloadJobs.failure(jobId, { unit_id: unit.unit_id, protocol: 'usenet', record_id: record.id, source_hash: unit.source_hash, label, code: 'client', error: errorMessage(error), selections: unit.selections })
  }
}

/** Builds the single-release receipt from a finished single-unit job. */
export function receiptFromJob(job: DownloadJob): DownloadReceipt | { error: string } {
  const added = job.added[0]
  const failed = job.failures[0]
  const entry = added || job.existing[0] || failed
  if (!entry) return { error: 'The submission did not settle; check the download client before retrying.' }
  const protocol = entry.protocol
  const client = protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd'
  if (failed && !added && !job.existing.length) {
    return {
      ok: false, record_id: failed.record_id || '', native_id: '', protocol, client,
      source_hash: failed.source_hash || '', category: '',
      ...(failed.code === 'acceptance_unknown' ? { acceptance_unknown: true } : {}),
      error: failed.error,
    }
  }
  return {
    ok: true, record_id: entry.record_id || '', native_id: entry.native_id || '', protocol, client,
    source_hash: entry.source_hash, category: '',
  }
}
