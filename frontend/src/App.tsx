import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import AnimeTab from './components/AnimeTab'
import ConfigTab from './components/ConfigTab'
import LogTab from './components/LogTab'
import { TabId, Status, ResultItem, Config } from './types'
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

export default function App() {
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
    <div className="app">
      <TopBar tab={tab} onTabChange={setTab} status={status} />
      <main className="main">
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
