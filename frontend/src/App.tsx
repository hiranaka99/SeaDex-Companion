import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import AnimeTab from './components/AnimeTab'
import ConfigTab from './components/ConfigTab'
import LogTab from './components/LogTab'
import AuthPage from './components/AuthPage'
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
}

function AuthenticatedApp({ username, onLogout }: AuthenticatedAppProps) {
  const [tab, setTab] = useState<TabId>('anime')
  const [status, setStatus] = useState<Status>(INITIAL_STATUS)
  const [results, setResults] = useState<ResultItem[]>([])
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [config, setConfig] = useState<Config | null>(null)

  const pollTimer = useRef<number | null>(null)

  const loadResults = useCallback(async () => {
    try {
      const data = await api.getResults()
      setResults(data.results || [])
      if (data.last_run) setLastRun(data.last_run)
    } catch (e) {
      console.error('Failed to load results:', e)
    }
  }, [])

  const pollStatus = useCallback(async () => {
    try {
      const st = await api.getStatus()
      setStatus(st)
      if (st.running) {
        await loadResults()
        pollTimer.current = window.setTimeout(pollStatus, 1500)
      } else {
        pollTimer.current = null
        loadResults()
      }
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
      const r = await api.startScan()
      if (!r.ok) throw new Error(r.error || 'Could not start scan')
      setStatus({ ...INITIAL_STATUS, running: true, message: 'Starting scan…' })
      if (!pollTimer.current) pollStatus()
    } catch (e: any) {
      alert('Could not start scan: ' + e.message)
    }
  }

  return (
    <div className="grid h-screen grid-rows-[auto_1fr] overflow-hidden max-[820px]:h-auto max-[820px]:min-h-screen">
      <TopBar tab={tab} onTabChange={setTab} status={status} username={username} onLogout={onLogout} />
      <main className="app-scrollbar overflow-y-auto px-[34px] pt-[26px] pb-[60px] max-[820px]:px-4 max-[820px]:pt-5 max-[820px]:pb-[50px]">
        {tab === 'anime' && (
          <AnimeTab
            results={results}
            config={config}
            status={status}
            lastRun={lastRun}
            onScan={handleScan}
          />
        )}
        {tab === 'config' && <ConfigTab config={config} onSaved={loadConfig} />}
        {tab === 'log' && <LogTab active={tab === 'log'} />}
      </main>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [loadError, setLoadError] = useState('')

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
      alert('Could not log out: ' + (caught?.message || 'Unknown error'))
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
  return <AuthenticatedApp username={auth.username || 'Administrator'} onLogout={() => void handleLogout()} />
}
