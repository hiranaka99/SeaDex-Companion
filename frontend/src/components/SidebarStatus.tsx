import { Status } from '../types'
import { buttonBase, cx } from '../styles'
import { displayDateTime } from '../datetime'
import { usenetPauseText } from '../utils'
import Icon from './Icons'

interface Props {
  status: Status
  scanCompleted: string | null
  scanCancelledDismissed: boolean
  collapsed: boolean
  onCancelScan: () => void
  onRetryScan: () => void
  onOpenConfig: () => void
  onDismissScan: () => void
  onExpand: () => void
}

/** Compact scan status + background Usenet matching for the sidebar. */
export default function SidebarStatus({ status, scanCompleted, scanCancelledDismissed, collapsed, onCancelScan, onRetryScan, onOpenConfig, onDismissScan, onExpand }: Props) {
  const scanVisible = status.running || Boolean(status.error) || (status.cancelled && !scanCancelledDismissed) || Boolean(scanCompleted) || status.webhook_scan.queued
  const usenet = status.usenet_prefetch
  const usenetVisible = Boolean(usenet?.running)
  if (!scanVisible && !usenetVisible) return null
  const progress = status.total ? Math.min(100, Math.round(status.progress / status.total * 100)) : 0
  const usenetProgress = usenet?.total ? Math.min(100, Math.round(usenet.checked / usenet.total * 100)) : 0
  const failed = (status.error || status.cancelled) && !status.running

  if (collapsed) {
    return (
      <div className="mb-3 flex animate-fade flex-col items-center gap-2.5" aria-label="Application operations">
        {scanVisible && (
          <button type="button" onClick={onExpand} title={status.running ? status.message || 'Scanning library…' : status.error ? 'Scan failed' : status.cancelled ? 'Scan cancelled' : 'Scan complete'} aria-label={status.running ? status.message || 'Scanning library…' : status.error ? 'Scan failed — expand sidebar for details' : status.cancelled ? 'Scan cancelled' : 'Scan complete'} className="relative grid size-11 cursor-pointer place-items-center rounded-xl bg-panel text-accent-bright transition-colors hover:bg-panel-raised">
            {status.running ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name={failed ? 'alert' : 'check'} size={18} className={failed ? 'text-bad' : 'text-good'}/>}
            {status.error && <span className="absolute right-1 top-1 size-2 rounded-full bg-bad"/>}
          </button>
        )}
        {usenetVisible && <span className="grid size-11 place-items-center rounded-xl bg-panel" title={`Matching Usenet sources · ${usenet!.checked}/${usenet!.total}`} aria-label={`Matching Usenet sources · ${usenet!.checked} of ${usenet!.total} releases`}><span className="size-4 animate-spin rounded-full border-2 border-sky/30 border-t-sky"/></span>}
      </div>
    )
  }

  return (
    <div className="sidebar-status mb-4 animate-fade border-t border-line pb-4 pt-4" aria-label="Application operations">
      {scanVisible && (
        <div className="rounded-xl border border-line bg-panel/70 px-3 py-3" role={(status.error || status.cancelled) && !status.running ? 'alert' : 'status'}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
            <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', failed ? 'bg-bad/12 text-bad' : scanCompleted && !status.running ? 'bg-good/12 text-good' : 'bg-accent/12 text-accent-bright')}>
              {status.running ? <span className="size-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name={failed ? 'alert' : 'check'} size={15}/>}
            </span>
            <div className="min-w-0">
              <div className="text-[0.8125rem] font-extrabold leading-snug text-ink wrap-anywhere">{status.running ? status.message || 'Scanning library…' : status.webhook_scan.queued ? 'Scan queued' : status.cancelled ? 'Scan cancelled' : status.error ? 'Scan failed' : 'Scan complete'}</div>
              <div className="mt-0.5 whitespace-pre-wrap text-[0.6875rem] leading-snug text-muted wrap-anywhere">{status.running ? (status.total ? `${status.progress}/${status.total} titles · ${progress}%` : 'Preparing scan…') : status.webhook_scan.queued ? `Starts after new ${status.webhook_scan.sources.join(' + ')} entries settle` : status.cancelled ? 'Previous complete results were preserved' : status.error ? 'Review the error details or check your integrations.' : `Completed ${displayDateTime(scanCompleted)}`}</div>
            </div>
            {!status.running && !status.webhook_scan.queued && (status.cancelled || scanCompleted) && <button type="button" className="touch-target -mr-1 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel-raised hover:text-ink" onClick={onDismissScan} aria-label={status.cancelled ? 'Dismiss scan cancellation' : 'Dismiss scan completion'}><Icon name="close" size={14}/></button>}
          </div>
          {status.running && <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-panel-raised"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(progress, status.total ? 2 : 0)}%` }}/></div>}
          {status.running && <button type="button" className={cx(buttonBase, 'mt-2.5 w-full justify-center border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onCancelScan}>Cancel scan</button>}
          {!status.running && status.error && (
            <>
              <div className="mt-2.5 flex flex-col gap-1.5">
                <button type="button" className={cx(buttonBase, 'w-full justify-center border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onRetryScan}><Icon name="refresh" size={14}/>Retry scan</button>
                <button type="button" className={cx(buttonBase, 'w-full justify-center border-line bg-panel-raised text-ink hover:text-ink')} onClick={onOpenConfig}><Icon name="settings" size={14}/>Configuration</button>
              </div>
              <details className="mt-2 text-xs"><summary className="touch-target w-fit cursor-pointer rounded-md py-0.5 font-semibold text-ink">Error details</summary><div className="operation-diagnostics app-scrollbar mt-1 overflow-y-auto whitespace-pre-wrap text-[0.6875rem] text-muted wrap-anywhere" tabIndex={0} role="region" aria-label="Scan error details">{status.error}</div></details>
            </>
          )}
          {!status.running && Object.keys(status.source_errors).length > 0 && <button type="button" className={cx(buttonBase, 'mt-2.5 w-full justify-center border-warn/35 bg-warn/10 text-warn')} onClick={onOpenConfig}>Integration warning</button>}
        </div>
      )}
      {usenetVisible && (
        <div className="mt-3 px-1" role="status">
          <div className="flex items-center gap-2">
            <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-sky/30 border-t-sky" aria-hidden="true"/>
            <span className="min-w-0 flex-1 text-xs font-semibold text-muted">Matching Usenet sources</span>
            <span className="shrink-0 text-[0.6875rem] font-bold tabular-nums text-muted-dim">{usenet!.checked}/{usenet!.total}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-raised"><div className="h-full rounded-full bg-sky transition-[width] duration-500" style={{ width: `${Math.max(usenetProgress, 2)}%` }}/></div>
          <div className="mt-1 text-[0.6875rem] text-muted-dim">{usenetPauseText(usenet!.paused) ?? `Checking ${usenet!.total} releases against the Usenet indexers.`}</div>
        </div>
      )}
    </div>
  )
}
