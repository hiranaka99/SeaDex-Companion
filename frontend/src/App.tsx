import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import AnimeTab from './components/AnimeTab'
import ConfigTab from './components/ConfigTab'
import LogTab from './components/LogTab'
import AuthPage from './components/AuthPage'
import ConfirmDialog from './components/ConfirmDialog'
import OperationCenter, { BulkOperationState } from './components/OperationCenter'
import HistoryTab from './components/HistoryTab'
import { useToast } from './components/Toast'
import { TabId, Status, ResultItem, Config, AuthState } from './types'
import * as api from './api'
import { setDateTimeFormat } from './datetime'

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

interface AuthenticatedAppProps {
  username: string
  onLogout: () => void
  onAccountUpdated: (username: string) => void
}

const SIDEBAR_KEY = 'seadex-sidebar-collapsed'
const SIDEBAR_WIDTH_KEY = 'seadex-sidebar-width'
const DISMISSED_BULK_JOB_KEY = 'seadex-dismissed-download-job'

function readDismissedBulkJob(): string | null {
  try {
    return localStorage.getItem(DISMISSED_BULK_JOB_KEY)
  } catch {
    return null
  }
}

const SIDEBAR_MIN = 232
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 248

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

function readSidebarWidth(): number {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX) return value
  } catch {
    // ignore storage errors
  }
  return SIDEBAR_DEFAULT
}

function readTab(): TabId {
  const value = window.location.hash.slice(1)
  return ['anime', 'history', 'config', 'log'].includes(value) ? value as TabId : 'anime'
}

function AuthenticatedApp({ username, onLogout, onAccountUpdated }: AuthenticatedAppProps) {
  const [tab, setTab] = useState<TabId>(readTab)
  const configVisited = useRef(tab === 'config')
  const historyVisited = useRef(tab === 'history')
  if (tab === 'config') configVisited.current = true
  if (tab === 'history') historyVisited.current = true
  const [openResultKey, setOpenResultKey] = useState<string | null>(null)
  const changeTab = useCallback((next: TabId) => { if (next !== tab) window.location.hash = next; setTab(next) }, [tab])
  const [status, setStatus] = useState<Status>(INITIAL_STATUS)
  const [results, setResults] = useState<ResultItem[]>([])
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [resultsLoading, setResultsLoading] = useState(true)
  const [resultsError, setResultsError] = useState('')
  const [configError, setConfigError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [lastStatusUpdate, setLastStatusUpdate] = useState<Date | null>(null)
  const [bulkOperation, setBulkOperation] = useState<BulkOperationState | null>(null)
  const dismissedBulkJob = useRef<string | null>(readDismissedBulkJob())
  const [bulkReviewAvailable, setBulkReviewAvailable] = useState(false)
  const [bulkReviewRequest, setBulkReviewRequest] = useState(0)
  const [scanCompleted, setScanCompleted] = useState<string | null>(null)
  const [scanCancelledDismissed, setScanCancelledDismissed] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [sidebarPx, setSidebarPx] = useState<number>(readSidebarWidth)
  const sidebarDrag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [configFooterTarget, setConfigFooterTarget] = useState<HTMLDivElement | null>(null)
  const toast = useToast()

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
    } catch {
      // ignore storage errors
    }
  }, [])
  const nudgeSidebar = useCallback((delta: number) => {
    setSidebarPx((current) => {
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, current + delta))
      persistSidebarWidth(next)
      return next
    })
  }, [persistSidebarWidth])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const pollTimer = useRef<number | null>(null)
  const scanWasRunning = useRef(false)
  const statusInitialized = useRef(false)
  const lastSeenRun = useRef<string | null>(null)
  const pollGeneration = useRef(0)
  const mounted = useRef(true)
  const lastLoadedRevision = useRef<string | undefined>(undefined)
  const resultsRequest = useRef(0)

  const loadResults = useCallback(async (generation?: number) => {
    const request = ++resultsRequest.current
    try {
      const data = await api.getResults()
      if (!mounted.current || request !== resultsRequest.current || (generation !== undefined && generation !== pollGeneration.current)) return
      api.invalidateDownloadProgress()
      setResults(data.results || [])
      const hidden = data.hidden
      if (hidden) setConfig(current => current && JSON.stringify(current.hidden) !== JSON.stringify(hidden) ? { ...current, hidden } : current)
      setLastRun(data.last_run || null)
      setResultsError('')
      return true
    } catch (e: unknown) {
      if (!mounted.current || request !== resultsRequest.current || (generation !== undefined && generation !== pollGeneration.current)) return
      console.error('Failed to load results:', e)
      setResultsError(e instanceof Error ? e.message : 'Could not load scanned results')
      return false
    } finally {
      if (mounted.current && request === resultsRequest.current && (generation === undefined || generation === pollGeneration.current)) setResultsLoading(false)
    }
  }, [])

  const handleResultOpened = useCallback(() => setOpenResultKey(null), [])
  const handleResultsChanged = useCallback(async () => { await loadResults() }, [loadResults])

  const pollStatus = useCallback(async (generation: number): Promise<void> => {
    try {
      const st = await api.getStatus()
      if (!mounted.current || generation !== pollGeneration.current) return
      if (st.running || !st.cancelled) setScanCancelledDismissed(false)
      if (st.running || st.error || st.cancelled) setScanCompleted(null)
      const completedSinceLastPoll = statusInitialized.current && Boolean(st.last_run) && st.last_run !== lastSeenRun.current
      if ((scanWasRunning.current || completedSinceLastPoll) && !st.running && !st.error && !st.cancelled) setScanCompleted(st.last_run || 'just now')
      scanWasRunning.current = st.running
      lastSeenRun.current = st.last_run
      statusInitialized.current = true
      setStatus(st)
      setStatusError('')
      setLastStatusUpdate(new Date())
      if (!st.results_revision || st.results_revision !== lastLoadedRevision.current) {
        if (await loadResults(generation)) lastLoadedRevision.current = st.results_revision
      }
      if (!mounted.current || generation !== pollGeneration.current) return
      pollTimer.current = window.setTimeout(() => { void pollStatus(generation) }, st.running ? 1500 : st.usenet_prefetch?.running ? 4000 : 10_000)
    } catch (e) {
      console.error('Status poll failed:', e)
      if (!mounted.current || generation !== pollGeneration.current) return
      setStatusError(e instanceof Error ? e.message : 'Could not connect to the server')
      setResultsLoading(false)
      pollTimer.current = window.setTimeout(() => { void pollStatus(generation) }, 3000)
    }
  }, [loadResults])

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await api.getConfig()
      api.invalidateDownloadProgress()
      setDateTimeFormat(cfg.datetime_format)
      setConfig(cfg)
      setConfigError('')
    } catch (e) {
      console.error('Failed to load config:', e)
      setConfigError(e instanceof Error ? e.message : 'Could not load configuration')
    }
  }, [])

  useEffect(() => {
    const navigate = () => setTab(readTab())
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])

  const openHistoryResult = (key: string) => { setOpenResultKey(key); changeTab('anime') }

  useEffect(() => {
    return api.watchDownloadJob(job => {
      if (!job.id || job.id === dismissedBulkJob.current) return
      const settled = job.added.length + job.existing.length + job.failures.length
      setBulkOperation({ action: 'start', phase: job.finished ? job.failures.length ? 'warning' : 'success' : 'running', settled, total: settled + job.pending.length, added: job.added.length, failed: job.failures.length, failures: job.failures, jobId: job.id, message: `${job.added.length} sent${job.existing.length ? ` · ${job.existing.length} already queued` : ''} · ${job.pending.length} pending · ${job.failures.length} failed` })
    })
  }, [])

  useEffect(() => {
    mounted.current = true
    const generation = ++pollGeneration.current
    loadConfig()
    void pollStatus(generation)
    return () => {
      mounted.current = false
      pollGeneration.current += 1
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
    }
  }, [loadConfig, loadResults, pollStatus])

  const handleScan = useCallback(async () => {
    if (status.running || bulkOperation?.phase === 'running') return
    try {
      setScanCompleted(null)
      const r = await api.startScan()
      if (!r.ok) throw new Error(r.error || 'Could not start scan')
      setScanCancelledDismissed(false)
      scanWasRunning.current = true
      setStatus({ ...INITIAL_STATUS, running: true, message: 'Starting scan…' })
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
      pollTimer.current = null
      const generation = ++pollGeneration.current
      void pollStatus(generation)
    } catch (e: any) {
      toast.show('Could not start scan: ' + e.message, 'error')
    }
  }, [status.running, bulkOperation?.phase, pollStatus, toast])

  const handleCancelScan = async () => {
    try { await api.cancelScan(); toast.show('Cancelling scan…', 'info') }
    catch (error: unknown) { toast.show(`Could not cancel scan: ${error instanceof Error ? error.message : String(error)}`, 'error') }
  }

  const handleScannedDataCleared = () => {
    resultsRequest.current += 1
    lastLoadedRevision.current = undefined
    api.invalidateDownloadProgress()
    setResults([])
    setLastRun(null)
    setStatus((current) => ({ ...INITIAL_STATUS, next_check: current.next_check, webhook_scan: current.webhook_scan }))
    setResultsError('')
    setScanCompleted(null)
  }

  const sidebarWidth = collapsed ? 76 : sidebarPx

  return (
    <div
      className="app-shell relative grid h-dvh grid-cols-[var(--sidebar)_minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-1"
      style={{ ['--sidebar' as string]: `${sidebarWidth}px` }}
    >
      <TopBar
        tab={tab}
        onTabChange={changeTab}
        username={username}
        onLogout={onLogout}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        status={status}
        scanCompleted={scanCompleted}
        scanCancelledDismissed={scanCancelledDismissed}
        onCancelScan={() => void handleCancelScan()}
        onRetryScan={() => void handleScan()}
        onOpenConfig={() => changeTab('config')}
        onDismissScan={() => { setScanCompleted(null); setScanCancelledDismissed(status.cancelled) }}
      />
      {!collapsed && <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={sidebarPx}
        tabIndex={0}
        className="sidebar-resize absolute bottom-0 top-0 z-30 hidden w-1.5 cursor-col-resize touch-none min-[901px]:block"
        style={{ left: sidebarWidth - 3 }}
        onPointerDown={(event) => {
          sidebarDrag.current = { startX: event.clientX, startWidth: sidebarPx }
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic or already-released pointers */ }
          document.documentElement.classList.add('sidebar-resizing')
        }}
        onPointerMove={(event) => {
          if (!sidebarDrag.current) return
          setSidebarPx(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarDrag.current.startWidth + event.clientX - sidebarDrag.current.startX)))
        }}
        onPointerUp={(event) => {
          if (!sidebarDrag.current) return
          sidebarDrag.current = null
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* capture may already be gone */ }
          document.documentElement.classList.remove('sidebar-resizing')
          setSidebarPx((current) => { persistSidebarWidth(current); return current })
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeSidebar(-16) }
          else if (event.key === 'ArrowRight') { event.preventDefault(); nudgeSidebar(16) }
          else if (event.key === 'Home') { event.preventDefault(); nudgeSidebar(SIDEBAR_MIN - sidebarPx) }
          else if (event.key === 'End') { event.preventDefault(); nudgeSidebar(SIDEBAR_MAX - sidebarPx) }
        }}
      />}
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className={`app-scroll-pane app-scrollbar relative min-h-0 flex-1 overflow-y-auto px-8 max-[1200px]:px-6 max-[900px]:px-4 ${tab === 'config' ? 'pb-4' : 'pb-14 mobile-content-clearance'} ${tab === 'log' ? 'log-main-pane' : ''}`}>
        <div className={`app-content pt-7 ${tab === 'log' ? 'flex h-full min-h-0 flex-col' : ''}`}>
        <OperationCenter
          status={status}
          scanCompleted={scanCompleted}
          scanCancelledDismissed={scanCancelledDismissed}
          onCancelScan={() => void handleCancelScan()}
          bulk={bulkOperation}
          onRetryScan={() => void handleScan()}
          onOpenLibrary={() => changeTab('anime')}
          onOpenConfig={() => changeTab('config')}
          onDismissBulk={() => {
            if (bulkOperation?.jobId) {
              dismissedBulkJob.current = bulkOperation.jobId
              try { localStorage.setItem(DISMISSED_BULK_JOB_KEY, bulkOperation.jobId) } catch { /* storage unavailable; dismissal still holds for this session */ }
            }
            setBulkOperation(null)
          }}
          onReviewBulk={bulkReviewAvailable ? () => { changeTab('anime'); setBulkReviewRequest(value => value + 1) } : undefined}
          onDismissScan={() => { setScanCompleted(null); setScanCancelledDismissed(status.cancelled) }}
        />
        <div className="connection-status mb-4 hidden shrink-0 flex-wrap items-center gap-3 text-xs text-muted max-[900px]:flex" role={statusError ? 'alert' : undefined}>
          {statusError ? <><span className="text-bad">Connection lost: {statusError}. Displayed data may be outdated.</span><button className="cursor-pointer font-bold text-accent-bright" onClick={() => { if (pollTimer.current) window.clearTimeout(pollTimer.current); void pollStatus(++pollGeneration.current) }}>Retry connection</button></> : lastStatusUpdate && <span>Updated {lastStatusUpdate.toLocaleTimeString()}</span>}
        </div>
        <div hidden={tab !== 'anime'}>
          <AnimeTab
            active={tab === 'anime'}
            openResultKey={openResultKey}
            onResultOpened={handleResultOpened}
            bulkOperationActive={bulkOperation?.phase === 'running'}
            bulkReviewRequest={bulkReviewRequest}
            onBulkReviewReset={() => setBulkReviewAvailable(false)}
            results={results}
            config={config}
            status={status}
            lastRun={lastRun}
            onScan={handleScan}
            loading={resultsLoading}
            loadError={resultsError}
            onReloadResults={() => void loadResults()}
            onOpenConfig={() => changeTab('config')}
            onBulkOperationChange={operation => { setBulkOperation(operation); setBulkReviewAvailable(operation.action === 'start') }}
            operationsVisible={status.running || Boolean(status.error) || (status.cancelled && !scanCancelledDismissed) || status.webhook_scan.queued || Boolean(scanCompleted) || Boolean(bulkOperation)}
            onResultsChanged={handleResultsChanged}
          />
        </div>
        {historyVisited.current && <div hidden={tab !== 'history'}><HistoryTab active={tab === 'history'} results={results} onOpenResult={openHistoryResult} /></div>}
        {configVisited.current && <div hidden={tab !== 'config'}><ConfigTab active={tab === 'config'} scanDisabled={status.running || bulkOperation?.phase === 'running'} footerTarget={configFooterTarget} loadError={configError} onRetry={() => void loadConfig()} config={config} status={status} username={username} onRunScan={handleScan} onAccountUpdated={onAccountUpdated} onSaved={saved => { api.invalidateDownloadProgress(); setDateTimeFormat(saved.datetime_format); setConfig(saved) }} onScannedDataCleared={handleScannedDataCleared} /></div>}
        {tab === 'log' && <LogTab active={tab === 'log'} />}
        </div>
        </div>
        <div ref={setConfigFooterTarget} hidden={tab !== 'config' || !config} className="configuration-footer shrink-0 border-t border-line bg-canvas px-8 py-4 max-[1200px]:px-6 max-[900px]:px-4" />
      </main>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [logoutOpen, setLogoutOpen] = useState(false)
  const toast = useToast()
  const authRequest = useRef(0)

  const refreshAuth = useCallback(async () => {
    const request = ++authRequest.current
    try {
      const status = await api.getAuthStatus()
      if (request !== authRequest.current) return
      setAuth(status)
      setLoadError('')
    } catch (caught: any) {
      if (request !== authRequest.current) return
      setLoadError(caught?.message || 'Could not load authentication status')
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
    const authenticationRequired = () => { void refreshAuth() }
    window.addEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired)
    return () => { authRequest.current += 1; window.removeEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired) }
  }, [refreshAuth])

  const handleLogout = async () => {
    try {
      await api.logout()
      authRequest.current += 1
      setAuth({ setup_required: false, authenticated: false, username: null })
    } catch (caught: any) {
      toast.show('Could not log out: ' + (caught?.message || 'Unknown error'), 'error')
      throw caught
    }
  }

  if (loadError && !auth) {
    return (
      <main className="grid min-h-screen place-items-center px-4 text-center">
        <div>
          <p className="text-bad">{loadError}</p>
          <button className="cursor-pointer text-accent-bright" onClick={() => void refreshAuth()}>Try again</button>
        </div>
      </main>
    )
  }
  if (!auth) return <main className="grid min-h-screen place-items-center text-sm text-muted">Loading…</main>
  if (!auth.authenticated) return <AuthPage setupRequired={auth.setup_required} onAuthenticated={status => { authRequest.current += 1; setLoadError(''); setAuth(status) }} />
  return <>
    <AuthenticatedApp username={auth.username || 'Administrator'} onLogout={() => setLogoutOpen(true)} onAccountUpdated={(username) => setAuth((current) => current ? { ...current, username } : current)} />
    <ConfirmDialog open={logoutOpen} title="Log out?" description="You will need your administrator password to return." confirmLabel="Log out" onConfirm={handleLogout} onClose={() => setLogoutOpen(false)} />
  </>
}
