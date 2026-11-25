import { errorMessage } from '../../shared/errors.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar'
import AnimeTab from './components/AnimeTab'
import ConfigTab from './components/ConfigTab'
import LogTab from './components/LogTab'
import AuthPage from './components/AuthPage'
import ConfirmDialog from './components/ConfirmDialog'
import OperationCenter from './components/OperationCenter'
import HistoryTab from './components/HistoryTab'
import SidebarResizer from './components/SidebarResizer'
import { useToast } from './components/Toast'
import type { AuthState } from './types'
import * as api from './api'
import { useBulkOperation } from './useBulkOperation'
import { useHashTab } from './useHashTab'
import { useLibraryData } from './useLibraryData'
import { useSidebar } from './useSidebar'

interface AuthenticatedAppProps {
  username: string
  onLogout: () => void
  onAccountUpdated: (username: string) => void
}

/** The signed-in shell: sidebar, operation banners and the four pages over one shared copy of the server state. */
function AuthenticatedApp({ username, onLogout, onAccountUpdated }: AuthenticatedAppProps) {
  const { tab, changeTab, visited } = useHashTab()
  const sidebar = useSidebar()
  const library = useLibraryData()
  const bulk = useBulkOperation()
  const toast = useToast()
  const [openResultKey, setOpenResultKey] = useState<string | null>(null)
  const [configFooterTarget, setConfigFooterTarget] = useState<HTMLDivElement | null>(null)
  const { status, config, scanCompleted, scanCancelledDismissed } = library
  const busy = status.running || bulk.running

  const handleResultOpened = useCallback(() => setOpenResultKey(null), [])
  const openConfig = () => changeTab('config')

  const { startScan } = library
  const handleScan = useCallback(async () => {
    if (busy) return
    try {
      await startScan()
    } catch (error) {
      toast.show('Could not start scan: ' + errorMessage(error), 'error')
    }
  }, [busy, startScan, toast])

  const handleCancelScan = async () => {
    try {
      await api.cancelScan()
      toast.show('Cancelling scan…', 'info')
    } catch (error) {
      toast.show(`Could not cancel scan: ${errorMessage(error)}`, 'error')
    }
  }

  const scanBanner = {
    status,
    scanCompleted,
    scanCancelledDismissed,
    onCancelScan: () => void handleCancelScan(),
    onRetryScan: () => void handleScan(),
    onOpenConfig: openConfig,
    onDismissScan: library.dismissScan,
  }

  return (
    <div
      className="app-shell relative grid h-dvh grid-cols-[var(--sidebar)_minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-1"
      style={{ ['--sidebar' as string]: `${sidebar.width}px` }}
    >
      <TopBar
        tab={tab}
        onTabChange={changeTab}
        username={username}
        onLogout={onLogout}
        collapsed={sidebar.collapsed}
        onToggleCollapsed={sidebar.toggleCollapsed}
        {...scanBanner}
      />
      <SidebarResizer sidebar={sidebar} />
      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          className={`app-scroll-pane app-scrollbar relative min-h-0 flex-1 overflow-y-auto px-8 max-[1200px]:px-6 max-[900px]:px-4 ${tab === 'config' ? 'pb-4' : 'pb-14 mobile-content-clearance'} ${tab === 'log' ? 'log-main-pane' : ''}`}
        >
          <div className={`app-content pt-7 ${tab === 'log' ? 'flex h-full min-h-0 flex-col' : ''}`}>
            <OperationCenter
              {...scanBanner}
              bulk={bulk.operation}
              onOpenLibrary={() => changeTab('anime')}
              onDismissBulk={bulk.dismiss}
              onReviewBulk={
                bulk.reviewAvailable
                  ? () => {
                      changeTab('anime')
                      bulk.requestReview()
                    }
                  : undefined
              }
            />
            <div
              className="connection-status mb-4 hidden shrink-0 flex-wrap items-center gap-3 text-xs text-muted max-[900px]:flex"
              role={library.statusError ? 'alert' : undefined}
            >
              {library.statusError ? (
                <>
                  <span className="text-bad">
                    Connection lost: {library.statusError}. Displayed data may be outdated.
                  </span>
                  <button className="cursor-pointer font-bold text-accent-bright" onClick={library.restartPolling}>
                    Retry connection
                  </button>
                </>
              ) : (
                library.lastStatusUpdate && <span>Updated {library.lastStatusUpdate.toLocaleTimeString()}</span>
              )}
            </div>
            <div hidden={tab !== 'anime'}>
              <AnimeTab
                active={tab === 'anime'}
                openResultKey={openResultKey}
                onResultOpened={handleResultOpened}
                bulkOperationActive={bulk.running}
                bulkReviewRequest={bulk.reviewRequest}
                onBulkReviewReset={bulk.resetReview}
                results={library.results}
                config={config}
                status={status}
                lastRun={library.lastRun}
                onScan={handleScan}
                loading={library.resultsLoading}
                loadError={library.resultsError}
                onReloadResults={() => void library.reloadResults()}
                onOpenConfig={openConfig}
                onBulkOperationChange={bulk.report}
                operationsVisible={
                  status.running ||
                  Boolean(status.error) ||
                  (status.cancelled && !scanCancelledDismissed) ||
                  status.webhook_scan.queued ||
                  Boolean(scanCompleted) ||
                  Boolean(bulk.operation)
                }
                onResultsChanged={library.reloadResults}
              />
            </div>
            {visited.has('history') && (
              <div hidden={tab !== 'history'}>
                <HistoryTab
                  active={tab === 'history'}
                  results={library.results}
                  onOpenResult={key => {
                    setOpenResultKey(key)
                    changeTab('anime')
                  }}
                />
              </div>
            )}
            {visited.has('config') && (
              <div hidden={tab !== 'config'}>
                <ConfigTab
                  active={tab === 'config'}
                  scanDisabled={busy}
                  footerTarget={configFooterTarget}
                  loadError={library.configError}
                  onRetry={() => void library.loadConfig()}
                  config={config}
                  status={status}
                  username={username}
                  onRunScan={handleScan}
                  onAccountUpdated={onAccountUpdated}
                  onSaved={library.applySavedConfig}
                  onScannedDataCleared={library.clearResults}
                />
              </div>
            )}
            {tab === 'log' && <LogTab active={tab === 'log'} />}
          </div>
        </div>
        <div
          ref={setConfigFooterTarget}
          hidden={tab !== 'config' || !config}
          className="configuration-footer shrink-0 border-t border-line bg-canvas px-8 py-4 max-[1200px]:px-6 max-[900px]:px-4"
        />
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
    } catch (caught) {
      if (request !== authRequest.current) return
      setLoadError((caught instanceof Error && caught.message) || 'Could not load authentication status')
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
    const authenticationRequired = () => {
      void refreshAuth()
    }
    window.addEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired)
    return () => {
      authRequest.current += 1
      window.removeEventListener(api.AUTH_REQUIRED_EVENT, authenticationRequired)
    }
  }, [refreshAuth])

  const handleLogout = async () => {
    try {
      await api.logout()
      authRequest.current += 1
      setAuth({ setup_required: false, authenticated: false, username: null })
    } catch (caught) {
      toast.show('Could not log out: ' + ((caught instanceof Error && caught.message) || 'Unknown error'), 'error')
      throw caught
    }
  }

  if (loadError && !auth) {
    return (
      <main className="grid min-h-screen place-items-center px-4 text-center">
        <div>
          <p className="text-bad">{loadError}</p>
          <button className="cursor-pointer text-accent-bright" onClick={() => void refreshAuth()}>
            Try again
          </button>
        </div>
      </main>
    )
  }
  if (!auth) return <main className="grid min-h-screen place-items-center text-sm text-muted">Loading…</main>
  if (!auth.authenticated)
    return (
      <AuthPage
        setupRequired={auth.setup_required}
        onAuthenticated={status => {
          authRequest.current += 1
          setLoadError('')
          setAuth(status)
        }}
      />
    )
  return (
    <>
      <AuthenticatedApp
        username={auth.username || 'Administrator'}
        onLogout={() => setLogoutOpen(true)}
        onAccountUpdated={username => setAuth(current => (current ? { ...current, username } : current))}
      />
      <ConfirmDialog
        open={logoutOpen}
        title="Log out?"
        description="You will need your administrator password to return."
        confirmLabel="Log out"
        onConfirm={handleLogout}
        onClose={() => setLogoutOpen(false)}
      />
    </>
  )
}
