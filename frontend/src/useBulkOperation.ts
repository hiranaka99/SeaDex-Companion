import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { BulkOperationState } from './components/OperationCenter'

const DISMISSED_JOB_KEY = 'seadex-dismissed-download-job'

function readDismissedJob(): string | null {
  try {
    return localStorage.getItem(DISMISSED_JOB_KEY)
  } catch {
    return null
  }
}

/** The bulk download or cancellation shown in the operation banner, restored from the server after a reload. */
export function useBulkOperation() {
  const [operation, setOperation] = useState<BulkOperationState | null>(null)
  const [reviewAvailable, setReviewAvailable] = useState(false)
  const [reviewRequest, setReviewRequest] = useState(0)
  const dismissedJob = useRef(readDismissedJob())

  useEffect(() => {
    return api.watchDownloadJob(job => {
      if (!job.id || job.id === dismissedJob.current) return
      const settled = job.added.length + job.existing.length + job.failures.length
      setOperation({
        action: 'start',
        phase: job.finished ? (job.failures.length ? 'warning' : 'success') : 'running',
        settled,
        total: settled + job.pending.length,
        added: job.added.length,
        failed: job.failures.length,
        failures: job.failures,
        jobId: job.id,
        message: `${job.added.length} sent${job.existing.length ? ` · ${job.existing.length} already queued` : ''} · ${job.pending.length} pending · ${job.failures.length} failed`,
      })
    })
  }, [])

  return {
    operation,
    running: operation?.phase === 'running',
    reviewAvailable,
    /** Counter the library watches to reopen the review of the current batch. */
    reviewRequest,
    report: (next: BulkOperationState) => {
      setOperation(next)
      setReviewAvailable(next.action === 'start')
    },
    /** A dismissed job stays dismissed across reloads; newer jobs still appear. */
    dismiss: () => {
      if (operation?.jobId) {
        dismissedJob.current = operation.jobId
        try {
          localStorage.setItem(DISMISSED_JOB_KEY, operation.jobId)
        } catch {
          /* storage unavailable; dismissal still holds for this session */
        }
      }
      setOperation(null)
    },
    requestReview: () => setReviewRequest(value => value + 1),
    resetReview: () => setReviewAvailable(false),
  }
}
