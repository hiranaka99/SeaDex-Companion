import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { DownloadJobStatus, DownloadPreflight, SelectionInput } from './api'
import { observeUsenetAvailability, type AvailabilitySnapshot } from './usenet-observation'

const PREFLIGHT_DEBOUNCE_MS = 300

/**
 * Usenet availability of the rows a review can offer. A snapshot belongs to the selection it was
 * requested for: once the selection or the provider configuration changes it is no longer shown.
 */
export function useReviewAvailability(
  selections: SelectionInput[],
  options: { open: boolean; enabled: boolean; paused: boolean; revision: number; retry: number },
) {
  const { open, enabled, paused, revision, retry } = options
  const signature = JSON.stringify([revision, selections])
  const [observed, setObserved] = useState<(AvailabilitySnapshot & { signature: string }) | null>(null)
  const availability = observed?.signature === signature ? observed : null
  const latest = useRef(availability)
  latest.current = availability
  const latestSignature = useRef(signature)
  latestSignature.current = signature
  const forced = useRef(false)

  useEffect(() => {
    if (!open) {
      forced.current = false
      return
    }
    if (!enabled || !selections.length || paused) return
    const controller = new AbortController()
    const refresh = forced.current
    forced.current = false
    void observeUsenetAvailability(selections, {
      refresh,
      signal: controller.signal,
      initial: latest.current,
      onSnapshot: snapshot => {
        if (!controller.signal.aborted && latestSignature.current === signature) setObserved({ ...snapshot, signature })
      },
    })
    return () => controller.abort()
  }, [open, signature, enabled, retry, paused])

  const checking =
    enabled &&
    selections.length > 0 &&
    (!availability || availability.loading || Object.values(availability.rows).some(row => row.refreshing))

  return {
    availability,
    checking,
    /** The next observation bypasses cached provider answers. */
    forceRefresh: () => {
      forced.current = true
    },
  }
}

/**
 * The server's review of the current selection, re-run shortly after the selection settles.
 * Acknowledgements belong to one review, so a new review starts with them cleared.
 */
export function usePreflight(
  selections: SelectionInput[],
  options: { open: boolean; busy: boolean; job: DownloadJobStatus | null; revision: number; retry: number },
) {
  const { open, busy, job, revision, retry } = options
  const signature = JSON.stringify([revision, selections])
  const [result, setResult] = useState<{ signature: string; preflight: DownloadPreflight } | null>(null)
  const [failure, setFailure] = useState<{ signature: string; message: string } | null>(null)
  const [wholeSource, setWholeSource] = useState(false)
  const [diskSpace, setDiskSpace] = useState(false)
  const latestSelections = useRef(selections)
  latestSelections.current = selections
  const forced = useRef(false)

  useEffect(() => {
    if (!open) {
      forced.current = false
      return
    }
    if (busy || (job?.id && job.finished)) return
    const controller = new AbortController()
    setResult(null)
    setFailure(null)
    setWholeSource(false)
    setDiskSpace(false)
    const timer = window.setTimeout(() => {
      const refresh = forced.current
      forced.current = false
      void api
        .preflightDownload(latestSelections.current, refresh, controller.signal)
        .then(preflight => {
          if (!controller.signal.aborted) setResult({ signature, preflight })
        })
        .catch(error => {
          if (!controller.signal.aborted)
            setFailure({ signature, message: error instanceof Error ? error.message : 'Could not check downloads' })
        })
    }, PREFLIGHT_DEBOUNCE_MS)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, signature, retry, busy, job])

  return {
    preflight: result?.signature === signature ? result.preflight : null,
    error: failure?.signature === signature ? failure.message : null,
    wholeSource,
    diskSpace,
    setWholeSource,
    setDiskSpace,
    /** Discards the shown review at once; the next one bypasses cached provider answers. */
    forceRefresh: () => {
      forced.current = true
      setResult(null)
      setFailure(null)
      setWholeSource(false)
      setDiskSpace(false)
    },
  }
}
