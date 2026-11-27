import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  dismissBulkOperation,
  getBulkOperation,
  requestBulkReview,
  resetBulkReview,
  subscribeBulkOperation,
} from './bulk-operation'

/** The bulk download or cancellation shown in the operation banner, shared by every view that shows or starts one. */
export function useBulkOperation() {
  const { operation, reviewAvailable } = useSyncExternalStore(subscribeBulkOperation, getBulkOperation)
  return {
    operation,
    running: operation?.phase === 'running',
    reviewAvailable,
    dismiss: dismissBulkOperation,
    requestReview: requestBulkReview,
    resetReview: resetBulkReview,
  }
}

/**
 * Runs `onRequest` each time a banner asks to review the current batch. The request counter outlives the
 * views, so only requests made after this view mounted count.
 */
export function useBulkReviewRequest(onRequest: () => void) {
  const { reviewRequest } = useSyncExternalStore(subscribeBulkOperation, getBulkOperation)
  const seen = useRef(reviewRequest)
  const handler = useRef(onRequest)
  handler.current = onRequest
  useEffect(() => {
    if (reviewRequest === seen.current) return
    seen.current = reviewRequest
    handler.current()
  }, [reviewRequest])
}
