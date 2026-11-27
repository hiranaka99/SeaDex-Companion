import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { DownloadAcknowledge, DownloadJobStatus, DownloadUnitFailure } from './api'
import { bulkCancelFinished, bulkCancelStarting, bulkDownloadStarting, bulkOperationFailed } from './bulk-operation'
import type { BulkScope } from './components/BulkScopeSelector'
import { useToast } from './components/Toast'
import type { ResultItem } from './types'
import { groupResults } from './utils'
import { useBulkOperation, useBulkReviewRequest } from './useBulkOperation'
import { errorMessage } from '../../shared/errors.js'

type BulkAction = 'start' | 'cancel'

/** The results a review covers, captured when it opens so later scans do not shift it. */
export interface BulkReviewSnapshot {
  filtered: ResultItem[]
  all: ResultItem[]
  description: string
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function describeFailures(failures: DownloadUnitFailure[]): string {
  const shown = failures.slice(0, 3).map(failure => `${failure.label} — ${failure.error}`)
  return shown.join('; ') + (failures.length > 3 ? `; and ${failures.length - 3} more` : '')
}

/**
 * The bulk download and bulk cancel reviews: what they cover, and running the confirmed batch. `active` is
 * whether the library page is showing; reviews close when it is left.
 */
export function useBulkActions(active: boolean) {
  const [confirm, setConfirm] = useState<BulkAction | null>(null)
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const inFlight = useRef(false)
  const [job, setJob] = useState<DownloadJobStatus | null>(null)
  const [scope, setScope] = useState<BulkScope>('filtered')
  const [review, setReview] = useState<BulkReviewSnapshot | null>(null)
  const toast = useToast()
  const operation = useBulkOperation()

  const reviewResults = useMemo(
    () => (review ? (scope === 'filtered' ? review.filtered : review.all) : []),
    [review, scope],
  )
  const reviewCounts = useMemo(
    () => ({
      filtered: review ? groupResults(review.filtered).length : 0,
      all: review ? groupResults(review.all).length : 0,
    }),
    [review],
  )

  useEffect(() => {
    if (!active) setConfirm(null)
  }, [active])
  useBulkReviewRequest(() => setConfirm('start'))

  const open = (action: BulkAction, snapshot: BulkReviewSnapshot) => {
    operation.resetReview()
    setScope('filtered')
    setReview(snapshot)
    setJob(null)
    setConfirm(action)
  }

  /** Runs one confirmed batch at a time, reporting it to the operation banner from start to finish. */
  const run = async (action: BulkAction, total: number, work: () => Promise<void>) => {
    if (inFlight.current || operation.running) return
    inFlight.current = true
    setBusy(action)
    try {
      await work()
    } catch (error) {
      toast.show(`Bulk ${action === 'start' ? 'download' : 'cancel'} failed: ${errorMessage(error)}`, 'error')
      bulkOperationFailed(action, total, errorMessage(error))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const start = (planId: string, acknowledge: DownloadAcknowledge) =>
    run('start', 0, async () => {
      bulkDownloadStarting()
      const { job_id } = await api.startDownloadJob(planId, acknowledge)
      // The banner follows the job through the shared observer; the review shows the same job's rows.
      const finished = await api.followJob(job_id, setJob)
      const { count, failures } = api.jobResult(finished)
      if (count > 0 && !failures.length) toast.show(`Sent ${plural(count, 'download')}`, 'success')
      else if (count > 0)
        toast.show(
          `Sent ${plural(count, 'download')}; ${failures.length} failed: ${describeFailures(failures)}`,
          'info',
        )
      else if (!failures.length) toast.show('Selected releases are already queued or no longer upgradable', 'info')
      else
        toast.show(`${plural(failures.length, 'download')} could not be added: ${describeFailures(failures)}`, 'error')
      api.invalidateDownloadProgress()
    })

  const cancel = (recordIds: string[], deleteFiles: boolean) =>
    run('cancel', recordIds.length, async () => {
      const total = recordIds.length
      bulkCancelStarting(total)
      const result = await api.cancelDownloads(recordIds, deleteFiles)
      const removed = result.removed.length
      const failed = result.failures.length
      toast.show(
        removed
          ? `Cancelled ${plural(removed, 'download')}; ${deleteFiles ? 'downloaded files were deleted' : 'files were kept'}${failed ? `; ${failed} could not be removed` : ''}`
          : 'No downloads were removed',
        failed ? 'info' : 'success',
      )
      bulkCancelFinished(result, total, deleteFiles)
      api.invalidateDownloadProgress()
      if (!failed) setConfirm(null)
    })

  return {
    /** Another bulk operation is already running somewhere in the app. */
    operationActive: operation.running,
    /** The operation banner shows a bulk operation. */
    operationShown: Boolean(operation.operation),
    confirm,
    busy,
    job,
    scope,
    setScope,
    review,
    reviewResults,
    reviewCounts,
    open,
    close: () => setConfirm(null),
    start,
    cancel,
  }
}
