import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import AnimeTab from './components/AnimeTab'
import ConfigTab from './components/ConfigTab'
import LogTab from './components/LogTab'
import AuthPage from './components/AuthPage'
import ConfirmDialog from './components/ConfirmDialog'
import OperationCenter, { BulkOperationState } from './components/OperationCenter'
import HistoryTab from './components/HistoryTab'
import DownloadsTab from './components/DownloadsTab'
import { useToast } from './components/Toast'
import { TabId, Status, ResultItem, Config, AuthState } from './types'
import * as api from './api'

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

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

function readTab(): TabId {
  const value = window.location.hash.slice(1)
  return ['anime', 'history', 'config', 'log', 'downloads'].includes(value) ? value as TabId : 'anime'
}

function AuthenticatedApp({ username, onLogout, onAccountUpdated }: AuthenticatedAppProps) {
  const [tab, setTab] = useState<TabId>(readTab)
  const configVisited = useRef(tab === 'config')
  const historyVisited = useRef(tab === 'history')
  if (tab === 'config') configVisited.current = true
  if (tab === 'history') historyVisited.current = true
  const [openResultKey, setOpenResultKey] = useState<string | null>(null)
  const changeTab = (next: TabId) => { if (next !== tab) window.location.hash = next; setTab(next) }
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
  const [scanCompleted, setScanCompleted] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [configFooterTarget, setConfigFooterTarget] = useState<HTMLDivElement | null>(null)
  const toast = useToast()

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

  const pollStatus = useCallback(async (generation: number): Promise<void> => {
    try {
      const st = await api.getStatus()
      if (!mounted.current || generation !== pollGeneration.current) return
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
      pollTimer.current = window.setTimeout(() => { void pollStatus(generation) }, st.running ? 1500 : 10_000)
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
    let active = true
    let timer = 0
    let observing = false
    const recoverBulk = async () => {
      try {
        const batch = await api.getBulkDownloadStatus()
        if (!active) return
        const settled = batch.added.length + batch.failures.length
        if (!batch.finished || observing) {
          observing = true
          setBulkOperation({ action: 'start', phase: batch.finished ? batch.failures.length ? 'warning' : 'success' : 'running', settled, total: settled + batch.pending.length, added: batch.added.length, failed: batch.failures.length, message: `${batch.added.length} added · ${batch.pending.length} pending · ${batch.failures.length} failed` })
          if (!batch.finished) timer = window.setTimeout(recoverBulk, 3000)
        }
      } catch { if (active) timer = window.setTimeout(recoverBulk, 3000) }
    }
    void recoverBulk()
    return () => { active = false; window.clearTimeout(timer) }
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

  const handleScan = async () => {
    try {
      setScanCompleted(null)
      const r = await api.startScan()
      if (!r.ok) throw new Error(r.error || 'Could not start scan')
      scanWasRunning.current = true
      setStatus({ ...INITIAL_STATUS, running: true, message: 'Starting scan…' })
      if (pollTimer.current) window.clearTimeout(pollTimer.current)
      pollTimer.current = null
      const generation = ++pollGeneration.current
      void pollStatus(generation)
    } catch (e: any) {
      toast.show('Could not start scan: ' + e.message, 'error')
    }
  }

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

  const sidebarWidth = collapsed ? 76 : 248

  return (
    <div
      className="grid h-dvh grid-cols-[var(--sidebar)_minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-300 ease-in-out max-[900px]:grid-cols-1"
      style={{ ['--sidebar' as string]: `${sidebarWidth}px` }}
    >
      <TopBar
        tab={tab}
        onTabChange={changeTab}
        username={username}
        onLogout={onLogout}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className={`app-scroll-pane app-scrollbar min-h-0 flex-1 overflow-y-auto px-8 max-[1200px]:px-6 max-[900px]:px-4 ${tab === 'config' ? 'pb-4' : 'pb-14 mobile-content-clearance'} ${tab === 'log' ? 'log-main-pane' : ''}`}>
        <div className={`app-content pt-7 ${tab === 'log' ? 'flex h-full min-h-0 flex-col' : ''}`}>
        <OperationCenter
          status={status}
          scanCompleted={scanCompleted}
          onCancelScan={() => void handleCancelScan()}
          bulk={bulkOperation}
          onRetryScan={() => void handleScan()}
          onOpenLibrary={() => changeTab('anime')}
          onOpenConfig={() => changeTab('config')}
          onDismissBulk={() => setBulkOperation(null)}
          onDismissScan={() => setScanCompleted(null)}
        />
        <div className="connection-status mb-4 flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted" role={statusError ? 'alert' : undefined}>
          {statusError ? <><span className="text-bad">Connection lost: {statusError}. Displayed data may be outdated.</span><button className="cursor-pointer font-bold text-accent-bright" onClick={() => { if (pollTimer.current) window.clearTimeout(pollTimer.current); void pollStatus(++pollGeneration.current) }}>Retry connection</button></> : lastStatusUpdate && <span>Updated {lastStatusUpdate.toLocaleTimeString()}</span>}
        </div>
        <div hidden={tab !== 'anime'}>
          <AnimeTab
            active={tab === 'anime'}
            openResultKey={openResultKey}
            onResultOpened={() => setOpenResultKey(null)}
            bulkOperationActive={bulkOperation?.phase === 'running'}
            results={results}
            config={config}
            status={status}
            lastRun={lastRun}
            onScan={handleScan}
            loading={resultsLoading}
            loadError={resultsError}
            onReloadResults={() => void loadResults()}
            onOpenConfig={() => changeTab('config')}
            onBulkOperationChange={setBulkOperation}
            operationsVisible={status.running || Boolean(status.error) || Boolean(scanCompleted) || Boolean(bulkOperation)}
            onResultsChanged={async () => { await loadResults() }}
          />
        </div>
        {historyVisited.current && <div hidden={tab !== 'history'}><HistoryTab active={tab === 'history'} results={results} onOpenResult={openHistoryResult} /></div>}
        {configVisited.current && <div hidden={tab !== 'config'}><ConfigTab active={tab === 'config'} footerTarget={configFooterTarget} loadError={configError} onRetry={() => void loadConfig()} config={config} status={status} username={username} onRunScan={handleScan} onAccountUpdated={onAccountUpdated} onSaved={saved => { api.invalidateDownloadProgress(); setConfig(saved) }} onScannedDataCleared={handleScannedDataCleared} /></div>}
        {tab === 'downloads' && <DownloadsTab />}
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
