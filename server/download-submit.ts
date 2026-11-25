import type { Config, ResultItem } from './types.js'
import type {
  BulkSubmissionResult,
  DownloadJob,
  DownloadReceipt,
  DownloadSelectionRef,
  DownloadUnitEntry,
  DownloadUnitFailure,
} from '../shared/download-contracts.js'
import { jobResult } from '../shared/download-contracts.js'
import { currentGeneration } from './config-generation.js'
import type { StoredPlan } from './download-plans.js'
import { planDownloads } from './download-preflight.js'
import { downloadJobs } from './download-jobs.js'
import { addDownloadRecord, markDownloadRemoved, setDownloadNative, type LibraryTarget } from './download-store.js'
import { CLIENT_FOR_PROTOCOL, downloadClients } from './download-clients.js'
import type { DownloadClientAdapter, SubmissionUnit } from './download-client-types.js'
import { HttpError } from './http-error.js'
import { errorMessage } from '../shared/errors.js'
import { rowKey } from '../shared/ids.js'

/** A plan failed acceptance validation; the status is the HTTP status the route reports. */
export class PlanRejected extends HttpError {
  constructor(status: number, message: string) {
    super(status, message, { ok: false })
  }
}

const UNSETTLED = 'The submission did not settle; check the download client before retrying.'

// One submission chain: a second confirmation of the same plan can never race a
// first one into a duplicate NZB or torrent, whatever the client-side debounce says.
let acceptanceChain: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = acceptanceChain.then(task, task)
  acceptanceChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export interface AcknowledgeFlags {
  whole_source?: boolean
  disk_space?: boolean
}

const unitLabel = (unit: { labels: string[]; source_hash: string }): string =>
  unit.labels.join(' / ') || unit.source_hash

/** The library card a unit belongs to, saved with its record so progress stays readable after rescans. */
function cardFor(selections: DownloadSelectionRef[], resultsByKey: Map<string, ResultItem>) {
  const first = selections[0]
  const result = first && resultsByKey.get(first.key)
  const release = result?.releases[first.release]
  if (!result || !release) return undefined
  return {
    title: result.title || result.key,
    season: result.season ?? null,
    part: release.part || '',
    release_group: release.releaseGroup,
    tracker: release.tracker,
    size: release.size ?? 0,
  }
}

/** The library seasons a source is downloaded for, so its import can be confirmed against later scans. */
function libraryTargets(selections: DownloadSelectionRef[], resultsById: Map<string, ResultItem>): LibraryTarget[] {
  const targets = new Map<string, LibraryTarget>()
  for (const selection of selections) {
    const result = resultsById.get(selection.key)
    const release = result?.releases?.[selection.release]
    if (!result?.library_key || !release) continue
    const target = {
      key: result.library_key,
      season: result.season ?? null,
      part: release.part || '',
      group: release.releaseGroup,
    }
    targets.set(JSON.stringify(target), target)
  }
  return [...targets.values()]
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
  // Plans pin only the selections the review could resolve; a fully blocked review has nothing to send.
  if (!plan.selections.length)
    throw new PlanRejected(
      409,
      'Nothing in this review can be sent. Re-run the review after resolving the blocked releases.',
    )

  // A plan the live state no longer supports is rejected the same way as any other stale review.
  const { review, units } = await planDownloads(config, plan.selections, { results }).catch(error => {
    throw error instanceof HttpError ? new PlanRejected(error.status, error.message) : error
  })
  if (plan.config_generation !== currentGeneration()) {
    throw new PlanRejected(409, 'Settings changed during acceptance. Re-run the review before submitting.')
  }
  if (review.requires_whole_ack && !acknowledge?.whole_source) {
    throw new PlanRejected(
      409,
      'This batch sends whole Usenet sources including files you did not select. Re-open the review and confirm again.',
    )
  }
  if (review.requires_space_ack && !acknowledge?.disk_space) {
    throw new PlanRejected(
      409,
      'This batch needs disk space that could not be confirmed. Re-open the review and confirm again.',
    )
  }

  // Every requested row remains a job target, including rows blocked by the live review.
  const targets = plan.selections
  const targetByRow = new Map(targets.map(target => [rowKey(target), target]))
  const blockedRows = new Set(review.blocked.map(rowKey))
  const sendable = (selections: DownloadSelectionRef[]) =>
    selections.filter(selection => !blockedRows.has(rowKey(selection)) && targetByRow.has(rowKey(selection)))

  const failures: DownloadUnitFailure[] = review.blocked.flatMap(blocked => {
    const pinned = targetByRow.get(rowKey(blocked))
    return pinned
      ? [
          {
            protocol: pinned.protocol,
            label: `${blocked.key}#${blocked.release}`,
            code: blocked.code,
            error: blocked.reason,
            selections: [{ key: blocked.key, release: blocked.release }],
          },
        ]
      : []
  })
  const existing: DownloadUnitEntry[] = units
    .filter(unit => unit.status === 'existing')
    .map(unit => ({
      unit_id: unit.unit_id,
      protocol: unit.protocol,
      source_hash: unit.source_hash,
      label: unit.labels[0] || unit.source_hash,
      selections: sendable(unit.selections),
      record_id: unit.existing_record_id,
      native_id: unit.existing_native_id,
    }))
    .filter(entry => entry.selections.length)
  const newUnits = units
    .filter(unit => unit.status === 'new')
    .map(unit => ({ ...unit, selections: sendable(unit.selections) }))
    .filter(unit => unit.selections.length)

  const job = downloadJobs.begin(
    targets.map(({ key, release, identity, protocol }) => ({ key, release, identity, protocol })),
    newUnits.map(unit => ({
      unit_id: unit.unit_id,
      protocol: unit.protocol,
      source_hash: unit.source_hash,
      label: unitLabel(unit),
      selections: unit.selections,
    })),
    { existing, failures },
  )

  const clients = downloadClients(config)
  const resultsByKey = new Map(results.map(result => [result.key, result]))
  const completion = serialized(async () => {
    try {
      for (const unit of newUnits)
        await submitUnit(
          clients[unit.protocol],
          job.id,
          unit,
          cardFor(unit.selections, resultsByKey),
          libraryTargets(unit.selections, resultsByKey),
        )
      return jobResult(downloadJobs.finish(job.id))
    } catch (error) {
      try {
        downloadJobs.finish(job.id, `Submission stopped: ${errorMessage(error)}`)
      } catch (storageError) {
        throw new AggregateError(
          [error, storageError],
          `Submission stopped and the job could not be finalized: ${errorMessage(error)}; ${errorMessage(storageError)}`,
        )
      }
      throw error
    }
  })
  return { job, completion }
}

/**
 * Sends one unit. The intent record is durable before the client is asked, so a crash or an
 * unanswered request leaves an unconfirmed record rather than an untracked download. A failed
 * ledger or job write after acceptance stops the whole job: nothing further may be sent blind.
 */
async function submitUnit(
  client: DownloadClientAdapter,
  jobId: string,
  unit: SubmissionUnit,
  card: ReturnType<typeof cardFor>,
  library: LibraryTarget[],
): Promise<void> {
  const record = addDownloadRecord({
    protocol: client.protocol,
    client: client.client,
    endpoint: client.endpointId,
    state: 'acceptance_unknown',
    source_hash: unit.source_hash,
    category: unit.category,
    scope: unit.whole_source ? undefined : unit.requestedPaths,
    provider: unit.provider,
    entry_id: unit.entryId,
    nzb_name: unit.nzb_name,
    card,
    labels: unit.labels,
    rows: unit.selections,
    library,
  })
  let accepted = false
  let forgotten = false
  let storageError: unknown
  const durably = <Result>(write: () => Result): Result => {
    try {
      return write()
    } catch (error) {
      storageError = error
      throw error
    }
  }
  try {
    const nativeId = await client.submit(unit, {
      accepted: nativeIds => {
        accepted = true
        durably(() => setDownloadNative(record.id, nativeIds))
      },
      forgotten: () => {
        markDownloadRemoved(record.id)
        forgotten = true
      },
    })
    durably(() => downloadJobs.added(jobId, unit.unit_id, { record_id: record.id, native_id: nativeId }))
  } catch (error) {
    const ambiguity = client.ambiguity(error)
    // A submission the client certainly never took leaves no record; an uncertain one keeps it for reconciliation.
    if (!accepted && !forgotten && ambiguity === null) markDownloadRemoved(record.id)
    downloadJobs.failure(jobId, {
      unit_id: unit.unit_id,
      protocol: client.protocol,
      record_id: record.id,
      source_hash: unit.source_hash,
      label: unitLabel(unit),
      code: ambiguity !== null ? 'acceptance_unknown' : storageError ? 'storage' : 'client',
      error: ambiguity ?? errorMessage(error),
      selections: unit.selections,
    })
    if (storageError) throw storageError
  }
}

/** Builds a single-release receipt from every required source in its job. */
export function receiptFromJob(job: DownloadJob): DownloadReceipt | { error: string } {
  const failures: DownloadUnitFailure[] = [
    ...job.failures,
    ...job.pending.map(unit => ({ ...unit, code: 'acceptance_unknown', error: UNSETTLED })),
  ]
  const entry = job.added[0] || job.existing[0] || failures[0]
  if (!entry) return { error: UNSETTLED }
  const successful = job.added.length + job.existing.length
  return {
    ok: job.finished && failures.length === 0,
    record_id: entry.record_id || '',
    native_id: 'native_id' in entry ? entry.native_id || '' : '',
    protocol: entry.protocol,
    client: CLIENT_FOR_PROTOCOL[entry.protocol],
    source_hash: entry.source_hash || '',
    category: '',
    ...(failures.some(failure => failure.code === 'acceptance_unknown') ? { acceptance_unknown: true } : {}),
    ...(failures.length
      ? {
          failures,
          error: `${successful ? `${successful} source(s) ready, but ` : ''}${failures.length} source(s) failed: ${failures.map(failure => `${failure.label}: ${failure.error}`).join('; ')}`,
        }
      : {}),
  }
}
