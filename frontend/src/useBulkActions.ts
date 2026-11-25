import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { DownloadAcknowledge, DownloadJobStatus, DownloadUnitFailure } from './api'
import type { BulkOperationState } from './components/OperationCenter'
import type { BulkScope } from './components/BulkScopeSelector'
import { useToast } from './components/Toast'
import type { ResultItem } from './types'
import { groupResults } from './utils'
import { errorMessage } from '../../shared/errors.js'

type BulkAction = 'start' | 'cancel'

/** The results a review covers, captured when it opens so later scans do not shift it. */
export interface BulkReviewSnapshot {
  filtered: ResultItem[]
  all: ResultItem[]
  description: string
}

interface Options {
  /** The library page is showing; reviews close when it is left. */
  active: boolean
  /** Another bulk operation is already running somewhere in the app. */
  operationActive: boolean
  /** Counter that reopens the download review when it changes. */
  reviewRequest: number
  onReviewReset: () => void
  onOperationChange: (operation: BulkOperationState) => void
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function describeFailures(failures: DownloadUnitFailure[]): string {
  const shown = failures.slice(0, 3).map(failure => `${failure.label} — ${failure.error}`)
  return shown.join('; ') + (failures.length > 3 ? `; and ${failures.length - 3} more` : '')
}

const settledCount = (job: DownloadJobStatus) => job.added.length + job.existing.length + job.failures.length

/** The bulk download and bulk cancel reviews: what they cover, and running the confirmed batch. */
export function useBulkActions({ active, operationActive, reviewRequest, onReviewReset, onOperationChange }: Options) {
  const [confirm, setConfirm] = useState<BulkAction | null>(null)
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const inFlight = useRef(false)
  const [job, setJob] = useState<DownloadJobStatus | null>(null)
  const [scope, setScope] = useState<BulkScope>('filtered')
  const [review, setReview] = useState<BulkReviewSnapshot | null>(null)
  const toast = useToast()

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
  useEffect(() => {
    if (reviewRequest) setConfirm('start')
  }, [reviewRequest])

  const open = (action: BulkAction, snapshot: BulkReviewSnapshot) => {
    onReviewReset()
    setScope('filtered')
    setReview(snapshot)
    setJob(null)
    setConfirm(action)
  }

  /** Runs one confirmed batch at a time, reporting it to the operation banner from start to finish. */
  const run = async (action: BulkAction, total: number, work: () => Promise<void>) => {
    if (inFlight.current || operationActive) return
    inFlight.current = true
    setBusy(action)
    try {
      await work()
    } catch (error) {
      toast.show(`Bulk ${action === 'start' ? 'download' : 'cancel'} failed: ${errorMessage(error)}`, 'error')
      onOperationChange({
        action,
        phase: 'error',
        settled: 0,
        total,
        added: 0,
        failed: total,
        message: errorMessage(error),
      })
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const start = (planId: string, acknowledge: DownloadAcknowledge) =>
    run('start', 0, async () => {
      const running = { action: 'start', phase: 'running' } as const
      onOperationChange({ ...running, settled: 0, total: 0, added: 0, failed: 0, message: 'Starting downloads…' })
      const { job_id } = await api.startDownloadJob(planId, acknowledge)
      const finished = await api.followJob(job_id, current => {
        setJob(current)
        onOperationChange({
          ...running,
          settled: settledCount(current),
          total: settledCount(current) + current.pending.length,
          added: current.added.length,
          failed: current.failures.length,
          jobId: job_id,
          message: `${current.added.length} sent · ${current.existing.length} already queued · ${current.pending.length} pending`,
        })
      })
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
      const settled = finished.added.length + finished.existing.length + failures.length
      onOperationChange({
        action: 'start',
        phase: failures.length ? 'warning' : 'success',
        settled,
        total: settled,
        added: finished.added.length,
        failed: failures.length,
        failures,
        jobId: finished.id || job_id,
        message: `${finished.added.length} sent · ${finished.existing.length} already queued${failures.length ? ` · ${failures.length} failed` : ''}`,
      })
      api.invalidateDownloadProgress()
    })

  const cancel = (recordIds: string[], deleteFiles: boolean) =>
    run('cancel', recordIds.length, async () => {
      const total = recordIds.length
      onOperationChange({
        action: 'cancel',
        phase: 'running',
        settled: 0,
        total,
        added: 0,
        failed: 0,
        message: 'Removing selected incomplete downloads…',
      })
      const result = await api.cancelDownloads(recordIds, deleteFiles)
      const removed = result.removed.length
      const failed = result.failures.length
      toast.show(
        removed
          ? `Cancelled ${plural(removed, 'download')}; ${deleteFiles ? 'downloaded files were deleted' : 'files were kept'}${failed ? `; ${failed} could not be removed` : ''}`
          : 'No downloads were removed',
        failed ? 'info' : 'success',
      )
      onOperationChange({
        action: 'cancel',
        phase: failed ? 'warning' : 'success',
        settled: removed + failed,
        total,
        added: 0,
        failed,
        failures: result.failures.map(failure => ({ label: failure.label, error: failure.error })),
        message: removed
          ? `Removed ${plural(removed, 'download')}; ${deleteFiles ? 'files deleted' : 'files preserved'}`
          : 'No downloads were found',
      })
      api.invalidateDownloadProgress()
      if (!failed) setConfirm(null)
    })

  return {
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
