import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { setDateTimeFormat } from './datetime'
import type { Config, ResultItem, Status } from './types'

const INITIAL_STATUS: Status = {
  running: false,
  progress: 0,
  total: 0,
  message: 'Idle',
  error: null,
  cancelled: false,
  trigger: null,
  source_errors: {},
  last_run: null,
  next_check: null,
  webhook_scan: { queued: false, due_at: null, sources: [] },
}

const POLL_SCANNING_MS = 1500
const POLL_PREFETCHING_MS = 4000
const POLL_IDLE_MS = 10_000
const POLL_RETRY_MS = 3000

/**
 * Server state the whole app reads: scan status (polled), scan results (reloaded when their
 * revision changes) and configuration. Every response is checked against the request that is
 * current when it arrives, so a slow answer never overwrites a newer one.
 */
export function useLibraryData() {
  const [status, setStatus] = useState<Status>(INITIAL_STATUS)
  const [statusError, setStatusError] = useState('')
  const [lastStatusUpdate, setLastStatusUpdate] = useState<Date | null>(null)
  const [results, setResults] = useState<ResultItem[]>([])
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [resultsLoading, setResultsLoading] = useState(true)
  const [resultsError, setResultsError] = useState('')
  const [config, setConfig] = useState<Config | null>(null)
  const [configError, setConfigError] = useState('')
  /** Finish time of a scan that completed while the app was open, until its banner is dismissed. */
  const [scanCompleted, setScanCompleted] = useState<string | null>(null)
  const [scanCancelledDismissed, setScanCancelledDismissed] = useState(false)

  const mounted = useRef(true)
  const pollTimer = useRef<number | null>(null)
  const pollGeneration = useRef(0)
  const resultsRequest = useRef(0)
  const lastLoadedRevision = useRef<string | undefined>(undefined)
  const scanWasRunning = useRef(false)
  const statusInitialized = useRef(false)
  const lastSeenRun = useRef<string | null>(null)

  const loadResults = useCallback(async (generation?: number) => {
    const request = ++resultsRequest.current
    const current = () =>
      mounted.current &&
      request === resultsRequest.current &&
      (generation === undefined || generation === pollGeneration.current)
    try {
      const data = await api.getResults()
      if (!current()) return
      api.invalidateDownloadProgress()
      setResults(data.results || [])
      const hidden = data.hidden
      if (hidden)
        setConfig(saved =>
          saved && JSON.stringify(saved.hidden) !== JSON.stringify(hidden) ? { ...saved, hidden } : saved,
        )
      setLastRun(data.last_run || null)
      setResultsError('')
      return true
    } catch (error) {
      if (!current()) return
      console.error('Failed to load results:', error)
      setResultsError(error instanceof Error ? error.message : 'Could not load scanned results')
      return false
    } finally {
      if (current()) setResultsLoading(false)
    }
  }, [])

  const pollStatus = useCallback(
    async (generation: number): Promise<void> => {
      const current = () => mounted.current && generation === pollGeneration.current
      const pollAgainIn = (delay: number) => {
        pollTimer.current = window.setTimeout(() => void pollStatus(generation), delay)
      }
      try {
        const next = await api.getStatus()
        if (!current()) return
        if (next.running || !next.cancelled) setScanCancelledDismissed(false)
        if (next.running || next.error || next.cancelled) setScanCompleted(null)
        const completedSinceLastPoll =
          statusInitialized.current && Boolean(next.last_run) && next.last_run !== lastSeenRun.current
        if ((scanWasRunning.current || completedSinceLastPoll) && !next.running && !next.error && !next.cancelled)
          setScanCompleted(next.last_run || 'just now')
        scanWasRunning.current = next.running
        lastSeenRun.current = next.last_run
        statusInitialized.current = true
        setStatus(next)
        setStatusError('')
        setLastStatusUpdate(new Date())
        if (!next.results_revision || next.results_revision !== lastLoadedRevision.current) {
          if (await loadResults(generation)) lastLoadedRevision.current = next.results_revision
        }
        if (!current()) return
        pollAgainIn(
          next.running ? POLL_SCANNING_MS : next.usenet_prefetch?.running ? POLL_PREFETCHING_MS : POLL_IDLE_MS,
        )
      } catch (error) {
        console.error('Status poll failed:', error)
        if (!current()) return
        setStatusError(error instanceof Error ? error.message : 'Could not connect to the server')
        setResultsLoading(false)
        pollAgainIn(POLL_RETRY_MS)
      }
    },
    [loadResults],
  )

  /** Drops the pending poll and starts a fresh polling chain right away. */
  const restartPolling = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current)
    pollTimer.current = null
    void pollStatus(++pollGeneration.current)
  }, [pollStatus])

  const loadConfig = useCallback(async () => {
    try {
      const loaded = await api.getConfig()
      api.invalidateDownloadProgress()
      setDateTimeFormat(loaded.datetime_format)
      setConfig(loaded)
      setConfigError('')
    } catch (error) {
      console.error('Failed to load config:', error)
      setConfigError(error instanceof Error ? error.message : 'Could not load configuration')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const generation = ++pollGeneration.current
    void loadConfig()
    void pollStatus(generation)
    return () => {
      mounted.current = false
      pollGeneration.current += 1
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
    }
  }, [loadConfig, pollStatus])

  /** Asks the server for a scan and shows it as running at once. Rejects when the server refuses. */
  const startScan = useCallback(async () => {
    setScanCompleted(null)
    const started = await api.startScan()
    if (!started.ok) throw new Error(started.error || 'Could not start scan')
    setScanCancelledDismissed(false)
    scanWasRunning.current = true
    setStatus({ ...INITIAL_STATUS, running: true, message: 'Starting scan…' })
    restartPolling()
  }, [restartPolling])

  const reloadResults = useCallback(async () => {
    await loadResults()
  }, [loadResults])

  return {
    status,
    statusError,
    lastStatusUpdate,
    results,
    lastRun,
    resultsLoading,
    resultsError,
    config,
    configError,
    scanCompleted,
    scanCancelledDismissed,
    loadConfig,
    reloadResults,
    restartPolling,
    startScan,
    dismissScan: () => {
      setScanCompleted(null)
      setScanCancelledDismissed(status.cancelled)
    },
    applySavedConfig: (saved: Config) => {
      api.invalidateDownloadProgress()
      setDateTimeFormat(saved.datetime_format)
      setConfig(saved)
    },
    /** Empties the shown results after the server cleared its scanned data. */
    clearResults: () => {
      resultsRequest.current += 1
      lastLoadedRevision.current = undefined
      api.invalidateDownloadProgress()
      setResults([])
      setLastRun(null)
      setStatus(previous => ({
        ...INITIAL_STATUS,
        next_check: previous.next_check,
        webhook_scan: previous.webhook_scan,
      }))
      setResultsError('')
      setScanCompleted(null)
    },
  }
}
