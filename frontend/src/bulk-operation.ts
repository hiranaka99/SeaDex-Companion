import { watchDownloadJob } from './bulk-job-store.js'
import type { DownloadCancelResult, DownloadJobStatus } from './api.js'

/** The bulk download or cancellation the operation banner shows. */
export interface BulkOperationState {
  action: 'start' | 'cancel'
  phase: 'running' | 'success' | 'warning' | 'error'
  settled: number
  total: number
  added: number
  failed: number
  message: string
  failures?: { label: string; error: string }[]
  jobId?: string
}

export interface BulkOperationSnapshot {
  operation: BulkOperationState | null
  /** The batch started in this session, whose review can be reopened. */
  reviewAvailable: boolean
  /** Counter the library watches to reopen the review of the current batch. */
  reviewRequest: number
}

const DISMISSED_JOB_KEY = 'seadex-dismissed-download-job'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * How far a download job got: its units that reached an outcome (sent, already queued, or failed) out of all
 * its units. The banner and the review show the same count.
 */
export function jobProgress(job: DownloadJobStatus): { settled: number; total: number } {
  const settled = job.added.length + job.existing.length + job.failures.length
  return { settled, total: settled + job.pending.length }
}

/** The banner for a download job; the same whether the job is followed live or restored after a reload. */
export function jobOperation(job: DownloadJobStatus): BulkOperationState {
  const { settled, total } = jobProgress(job)
  const parts = [`${job.added.length} sent`]
  if (job.existing.length) parts.push(`${job.existing.length} already queued`)
  if (job.pending.length) parts.push(`${job.pending.length} pending`)
  if (job.failures.length) parts.push(`${job.failures.length} failed`)
  return {
    action: 'start',
    phase: job.finished ? (job.failures.length ? 'warning' : 'success') : 'running',
    settled,
    total,
    added: job.added.length,
    failed: job.failures.length,
    failures: job.failures.map(({ label, error }) => ({ label, error })),
    jobId: job.id ?? undefined,
    message: parts.join(' · '),
  }
}

let snapshot: BulkOperationSnapshot = { operation: null, reviewAvailable: false, reviewRequest: 0 }
const listeners = new Set<() => void>()
let stopWatching: (() => void) | undefined
/** Kept in memory as well, so a dismissal holds for the session when storage is unavailable. */
let dismissedJob: string | null = null

function update(changes: Partial<BulkOperationSnapshot>): void {
  snapshot = { ...snapshot, ...changes }
  for (const listener of [...listeners]) listener()
}

function isDismissed(id: string): boolean {
  if (id === dismissedJob) return true
  try {
    return localStorage.getItem(DISMISSED_JOB_KEY) === id
  } catch {
    return false
  }
}

function observe(job: DownloadJobStatus): void {
  if (!job.id || isDismissed(job.id)) return
  update({ operation: jobOperation(job) })
}

/** Observes the latest download job while anything listens, so reloads and live batches share one projection. */
export function subscribeBulkOperation(listener: () => void): () => void {
  listeners.add(listener)
  stopWatching ??= watchDownloadJob(observe)
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    stopWatching?.()
    stopWatching = undefined
  }
}

export const getBulkOperation = (): BulkOperationSnapshot => snapshot

/** A bulk download was confirmed; its job reports progress through the shared observer once accepted. */
export function bulkDownloadStarting(): void {
  update({
    operation: {
      action: 'start',
      phase: 'running',
      settled: 0,
      total: 0,
      added: 0,
      failed: 0,
      message: 'Starting downloads…',
    },
    reviewAvailable: true,
  })
}

export function bulkCancelStarting(total: number): void {
  update({
    operation: {
      action: 'cancel',
      phase: 'running',
      settled: 0,
      total,
      added: 0,
      failed: 0,
      message: 'Removing selected incomplete downloads…',
    },
    reviewAvailable: false,
  })
}

export function bulkCancelFinished(result: DownloadCancelResult, total: number, deleteFiles: boolean): void {
  const removed = result.removed.length
  const failed = result.failures.length
  update({
    operation: {
      action: 'cancel',
      phase: failed ? 'warning' : 'success',
      settled: removed + failed,
      total,
      added: 0,
      failed,
      failures: result.failures.map(({ label, error }) => ({ label, error })),
      message: removed
        ? `Removed ${plural(removed, 'download')}; ${deleteFiles ? 'files deleted' : 'files preserved'}`
        : 'No downloads were found',
    },
  })
}

/** The request behind a bulk download or cancellation failed before any outcome was known. */
export function bulkOperationFailed(action: BulkOperationState['action'], total: number, message: string): void {
  update({
    operation: { action, phase: 'error', settled: 0, total, added: 0, failed: total, message },
    reviewAvailable: action === 'start',
  })
}

/** A dismissed job stays dismissed across reloads; newer jobs still appear. */
export function dismissBulkOperation(): void {
  const id = snapshot.operation?.jobId
  if (id) {
    dismissedJob = id
    try {
      localStorage.setItem(DISMISSED_JOB_KEY, id)
    } catch {
      /* storage unavailable; dismissal still holds for this session */
    }
  }
  update({ operation: null })
}

export function requestBulkReview(): void {
  update({ reviewRequest: snapshot.reviewRequest + 1 })
}

export function resetBulkReview(): void {
  update({ reviewAvailable: false })
}
