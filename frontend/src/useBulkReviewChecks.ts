import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { DownloadJobStatus, DownloadPreflight, SelectionInput, UsenetAvailabilityResult } from './api'
import { observeUsenetAvailability, type AvailabilitySnapshot } from './usenet-observation'
import {
  checksInProgress,
  EMPTY_LEDGER,
  EMPTY_PLAN,
  openChecks,
  planVerification,
  recordVerification,
  type VerifyLedger,
  type VerifyPlan,
} from './usenet-review'

const PREFLIGHT_DEBOUNCE_MS = 300
const NO_ROWS: Record<string, UsenetAvailabilityResult> = {}

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
  /** The checks this review asked the server for, kept until the review closes. */
  const [ledger, setLedger] = useState<VerifyLedger>(EMPTY_LEDGER)
  const ledgerRef = useRef(ledger)
  const writeLedger = (next: VerifyLedger) => {
    ledgerRef.current = next
    setLedger(next)
  }
  /** Rows to verify or cancel that the server has not received yet; the next observation carries them. */
  const unsent = useRef<VerifyPlan>(EMPTY_PLAN)
  const [sends, setSends] = useState(0)

  useEffect(() => {
    if (!open) {
      forced.current = false
      return
    }
    if (!enabled || !selections.length || paused) return
    const controller = new AbortController()
    const refresh = forced.current
    forced.current = false
    const work = unsent.current
    const without = (rows: VerifyPlan['verify'], sent: VerifyPlan['verify']) => rows.filter(row => !sent.includes(row))
    void observeUsenetAvailability(selections, {
      refresh,
      verify: work.verify,
      cancelVerify: work.cancel,
      signal: controller.signal,
      initial: latest.current,
      onRequested: sent => {
        unsent.current = {
          verify: without(unsent.current.verify, sent.verify),
          cancel: without(unsent.current.cancel, sent.cancel),
        }
        writeLedger(recordVerification(ledgerRef.current, sent))
      },
      onSnapshot: snapshot => {
        if (!controller.signal.aborted && latestSignature.current === signature) setObserved({ ...snapshot, signature })
      },
    }).then(() => {
      if (controller.signal.aborted) return
      // A request that failed is not repeated on its own: its rows count as asked for until the review is refreshed.
      const lost = work.verify.filter(row => unsent.current.verify.includes(row))
      if (!lost.length) return
      unsent.current = { verify: without(unsent.current.verify, lost), cancel: unsent.current.cancel }
      writeLedger(recordVerification(ledgerRef.current, { verify: lost }))
    })
    return () => controller.abort()
  }, [open, signature, enabled, retry, paused, sends])

  // Closing the review stops the checks nobody waits for any more.
  useEffect(() => {
    if (!open) return
    return () => {
      api.cancelUsenetChecks(openChecks(ledgerRef.current, latest.current?.rows ?? NO_ROWS, unsent.current))
      unsent.current = EMPTY_PLAN
      writeLedger(EMPTY_LEDGER)
    }
  }, [open])

  const checking =
    enabled &&
    selections.length > 0 &&
    (!availability || availability.loading || Object.values(availability.rows).some(row => row.refreshing))

  return {
    availability,
    checking,
    ledger,
    /** Starts a new observation whose first request names these rows in `verify` and `cancel_verify`. */
    send: (plan: VerifyPlan) => {
      unsent.current = plan
      setSends(current => current + 1)
    },
    /** The next observation bypasses cached provider answers, and rows may be verified once more. */
    forceRefresh: () => {
      forced.current = true
      unsent.current = EMPTY_PLAN
      writeLedger(EMPTY_LEDGER)
    },
  }
}

/**
 * Has the server search and check the rows chosen for Usenet that have no proven copy yet: one NZB per
 * source, once per review. A row that is no longer chosen for Usenet has its queued check cancelled.
 */
export function useReviewChecks(
  observation: Pick<ReturnType<typeof useReviewAvailability>, 'availability' | 'ledger' | 'send'>,
  /** The rows chosen for Usenet right now. */
  wanted: SelectionInput[],
  active: boolean,
) {
  const { availability, ledger, send } = observation
  const rows = availability?.rows ?? NO_ROWS
  const plan = useMemo(
    () => (active ? planVerification(ledger, wanted, rows) : EMPTY_PLAN),
    [active, ledger, wanted, rows],
  )
  const planKey = plan.verify.length || plan.cancel.length ? JSON.stringify(plan) : ''
  useEffect(() => {
    if (planKey) send(plan)
  }, [planKey])

  return {
    /** Rows whose check is about to be requested or still runs. The review waits for them. */
    checks: active ? checksInProgress(ledger, wanted, rows, plan).length : 0,
    /** This review asked for at least one check, so what the indexers still allow is worth showing. */
    asked: Object.keys(ledger.requested).length > 0,
    usage: availability?.usage,
  }
}

/**
 * The server's review of the current selection, re-run shortly after the selection settles.
 * Acknowledgements belong to one review, so a new review starts with them cleared.
 */
export function usePreflight(
  selections: SelectionInput[],
  options: {
    open: boolean
    busy: boolean
    job: DownloadJobStatus | null
    revision: number
    retry: number
    /** Usenet checks of selected rows still run; the review reads their stored results, so it waits for them. */
    hold?: boolean
  },
) {
  const { open, busy, job, revision, retry, hold = false } = options
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
    if (hold) return () => controller.abort()
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
  }, [open, signature, retry, busy, job, hold])

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
