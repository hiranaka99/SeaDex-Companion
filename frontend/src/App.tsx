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

const INITIAL_STATUS: Status = {
  running: false,
  progress: 0,
  total: 0,
  message: 'Idle',
  error: null,
  last_run: null,
  next_check: null,
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

function AuthenticatedApp({ username, onLogout, onAccountUpdated }: AuthenticatedAppProps) {
  const [tab, setTab] = useState<TabId>('anime')
  const [status, setStatus] = useState<Status>(INITIAL_STATUS)
  const [results, setResults] = useState<ResultItem[]>([])
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [resultsLoading, setResultsLoading] = useState(true)
  const [resultsError, setResultsError] = useState('')
  const [bulkOperation, setBulkOperation] = useState<BulkOperationState | null>(null)
  const [scanCompleted, setScanCompleted] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
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

  const loadResults = useCallback(async () => {
    try {
      const data = await api.getResults()
      setResults(data.results || [])
      setLastRun(data.last_run || null)
      setResultsError('')
    } catch (e: any) {
      console.error('Failed to load results:', e)
      setResultsError(e?.message || 'Could not load scanned results')
    } finally {
      setResultsLoading(false)
    }
  }, [])

  const pollStatus = useCallback(async () => {
    try {
      const st = await api.getStatus()
      if (st.running || st.error) setScanCompleted(null)
      const completedSinceLastPoll = statusInitialized.current && Boolean(st.last_run) && st.last_run !== lastSeenRun.current
      if ((scanWasRunning.current || completedSinceLastPoll) && !st.running && !st.error) setScanCompleted(st.last_run || 'just now')
      scanWasRunning.current = st.running
      lastSeenRun.current = st.last_run
      statusInitialized.current = true
      setStatus(st)
      await loadResults()
      pollTimer.current = window.setTimeout(pollStatus, st.running ? 1500 : 10_000)
    } catch (e) {
      console.error('Status poll failed:', e)
      pollTimer.current = window.setTimeout(pollStatus, 3000)
    }
  }, [loadResults])

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await api.getConfig()
      setConfig(cfg)
    } catch (e) {
      console.error('Failed to load config:', e)
    }
  }, [])

  useEffect(() => {
    loadConfig()
    loadResults()
    pollStatus()
    return () => {
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
      void pollStatus()
    } catch (e: any) {
      toast.show('Could not start scan: ' + e.message, 'error')
    }
  }

  const handleScannedDataCleared = () => {
    setResults([])
    setLastRun(null)
    setStatus((current) => ({ ...INITIAL_STATUS, next_check: current.next_check }))
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
        onTabChange={setTab}
        username={username}
        onLogout={onLogout}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
      <main className="app-scrollbar overflow-y-auto px-8 pt-7 pb-14 max-[1200px]:px-6 max-[900px]:px-4 max-[900px]:pt-20 max-[900px]:pb-24">
        <OperationCenter
          status={status}
          scanCompleted={scanCompleted}
          bulk={bulkOperation}
          onRetryScan={() => void handleScan()}
          onOpenLibrary={() => setTab('anime')}
          onOpenConfig={() => setTab('config')}
          onDismissBulk={() => setBulkOperation(null)}
          onDismissScan={() => setScanCompleted(null)}
        />
        {tab === 'anime' && (
          <AnimeTab
            results={results}
            config={config}
            status={status}
            lastRun={lastRun}
            onScan={handleScan}
            loading={resultsLoading}
            loadError={resultsError}
            onReloadResults={() => void loadResults()}
            onOpenConfig={() => setTab('config')}
            onBulkOperationChange={setBulkOperation}
            operationsVisible={status.running || Boolean(status.error) || Boolean(scanCompleted) || Boolean(bulkOperation)}
            onResultsChanged={loadResults}
          />
        )}
        {tab === 'history' && <HistoryTab />}
        {tab === 'config' && <ConfigTab config={config} username={username} onAccountUpdated={onAccountUpdated} onSaved={loadConfig} onScannedDataCleared={handleScannedDataCleared} />}
        {tab === 'log' && <LogTab active={tab === 'log'} />}
      </main>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [logoutOpen, setLogoutOpen] = useState(false)
  const toast = useToast()

  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await api.getAuthStatus())
      setLoadError('')
    } catch (caught: any) {
      setLoadError(caught?.message || 'Could not load authentication status')
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
    const authenticationRequired = () => { void refreshAuth() }
    window.addEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired)
    return () => window.removeEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired)
  }, [refreshAuth])

  const handleLogout = async () => {
    try {
      await api.logout()
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
  if (!auth.authenticated) return <AuthPage setupRequired={auth.setup_required} onAuthenticated={setAuth} />
  return <>
    <AuthenticatedApp username={auth.username || 'Administrator'} onLogout={() => setLogoutOpen(true)} onAccountUpdated={(username) => setAuth((current) => current ? { ...current, username } : current)} />
    <ConfirmDialog open={logoutOpen} title="Log out?" description="You will need your administrator password to return." confirmLabel="Log out" onConfirm={handleLogout} onClose={() => setLogoutOpen(false)} />
  </>
}
