import { Status } from '../types'
import { buttonBase, cx } from '../styles'
import Icon from './Icons'

export interface BulkOperationState {
  action: 'start' | 'cancel'
  phase: 'running' | 'success' | 'warning' | 'error'
  settled: number
  total: number
  added: number
  failed: number
  message: string
}

interface Props {
  status: Status
  scanCompleted: string | null
  bulk: BulkOperationState | null
  onRetryScan: () => void
  onCancelScan: () => void
  onOpenLibrary: () => void
  onOpenConfig: () => void
  onDismissBulk: () => void
  onDismissScan: () => void
}

export default function OperationCenter({ status, scanCompleted, bulk, onRetryScan, onCancelScan, onOpenLibrary, onOpenConfig, onDismissBulk, onDismissScan }: Props) {
  const scanVisible = status.running || Boolean(status.error) || status.cancelled || Boolean(scanCompleted) || status.webhook_scan.queued
  if (!scanVisible && !bulk) return null
  const progress = status.total ? Math.min(100, Math.round(status.progress / status.total * 100)) : 0
  const bulkProgress = bulk?.total ? Math.min(100, Math.round(bulk.settled / bulk.total * 100)) : 0

  return (
    <section className="operation-center sticky top-0 z-40 mb-5 space-y-2 rounded-2xl border border-line-strong bg-panel-raised/95 p-3 shadow-card backdrop-blur-xl" aria-label="Application operations">
      {scanVisible && (
        <div className={cx('rounded-xl border px-3.5 py-3', (status.error || status.cancelled) && !status.running ? 'border-bad/35 bg-bad/8' : scanCompleted && !status.running ? 'border-good/35 bg-good/8' : 'border-accent/30 bg-accent/7')}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5">
            <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg', (status.error || status.cancelled) && !status.running ? 'bg-bad/12 text-bad' : scanCompleted && !status.running ? 'bg-good/12 text-good' : 'bg-accent/12 text-accent-bright')}>
              {status.running ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name={status.error || status.cancelled ? 'alert' : 'check'} size={17}/>}
            </span>
            <div className="min-w-0" role={(status.error || status.cancelled) && !status.running ? 'alert' : 'status'}>
              <div className="text-sm font-extrabold text-ink wrap-anywhere">{status.running ? status.message || 'Scanning library…' : status.webhook_scan.queued ? 'Scan queued' : status.cancelled ? 'Scan cancelled' : status.error ? 'Scan failed' : 'Scan complete'}</div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-muted wrap-anywhere">{status.running ? (status.total ? `${status.progress}/${status.total} titles · ${progress}%` : 'Preparing scan…') : status.webhook_scan.queued ? `Starts after new ${status.webhook_scan.sources.join(' + ')} entries settle` : status.cancelled ? 'Previous complete results were preserved' : status.error ? 'Review the error details or check your integrations.' : `Completed ${scanCompleted}`}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {status.running && <button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onCancelScan}>Cancel scan</button>}
            {!status.running && status.error && <button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onRetryScan}><Icon name="refresh" size={15}/>Retry scan</button>}
            {!status.running && status.error && <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onOpenConfig}><Icon name="settings" size={15}/>Configuration</button>}
            {!status.running && Object.keys(status.source_errors).length > 0 && <button type="button" className={cx(buttonBase, 'border-warn/35 bg-warn/10 text-warn')} onClick={onOpenConfig}>Integration warning</button>}
            <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onOpenLibrary}>Open library</button>
            {!status.running && scanCompleted && <button type="button" className="touch-target grid size-8 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onDismissScan} aria-label="Dismiss scan completion"><Icon name="close" size={16}/></button>}
          </div>
          {!status.running && status.error && <details className="mt-3 border-t border-bad/25 pt-2 text-xs"><summary className="touch-target w-fit cursor-pointer rounded-md py-1 font-semibold text-ink">Error details</summary><div className="operation-diagnostics app-scrollbar mt-2 overflow-y-auto whitespace-pre-wrap text-muted wrap-anywhere" tabIndex={0} role="region" aria-label="Scan error details">{status.error}</div></details>}
          {status.running && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(progress, status.total ? 2 : 0)}%` }}/></div>}
        </div>
      )}

      {bulk && (
        <div className={cx('rounded-xl border px-3.5 py-3', bulk.phase === 'error' ? 'border-bad/35 bg-bad/8' : bulk.phase === 'warning' ? 'border-warn/35 bg-warn/8' : bulk.phase === 'success' ? 'border-good/35 bg-good/8' : 'border-accent/30 bg-accent/7')} role={bulk.phase === 'error' ? 'alert' : 'status'} aria-live="polite">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg', bulk.phase === 'error' ? 'bg-bad/12 text-bad' : bulk.phase === 'warning' ? 'bg-warn/12 text-warn' : bulk.phase === 'success' ? 'bg-good/12 text-good' : 'bg-accent/12 text-accent-bright')}>
              {bulk.phase === 'running' ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name={bulk.phase === 'success' ? 'check' : 'alert'} size={17}/>} 
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-extrabold wrap-anywhere">{bulk.action === 'start' ? 'Bulk downloads' : 'Bulk cancellation'} · {bulk.phase === 'running' ? 'In progress' : bulk.phase === 'success' ? 'Complete' : bulk.phase === 'warning' ? 'Completed with issues' : 'Failed'}</div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-muted wrap-anywhere">{bulk.phase === 'error' ? 'Review the error details before retrying.' : bulk.message}</div>
            </div>
            {bulk.total > 0 && <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-bold tabular-nums text-muted">{bulk.settled}/{bulk.total}</span>}
            <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onOpenLibrary}>Open library</button>
            {bulk.phase !== 'running' && <button type="button" className="touch-target grid size-8 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onDismissBulk} aria-label="Dismiss bulk operation"><Icon name="close" size={16}/></button>}
          </div>
          {bulk.phase === 'error' && <details className="mt-3 border-t border-bad/25 pt-2 text-xs"><summary className="touch-target w-fit cursor-pointer rounded-md py-1 font-semibold text-ink">Error details</summary><div className="operation-diagnostics app-scrollbar mt-2 overflow-y-auto whitespace-pre-wrap text-muted wrap-anywhere" tabIndex={0} role="region" aria-label="Bulk operation error details">{bulk.message}</div></details>}
          {bulk.phase === 'running' && bulk.total > 0 && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-linear-to-r from-accent to-good transition-[width] duration-500" style={{ width: `${Math.max(bulkProgress, 2)}%` }}/></div>}
        </div>
      )}
    </section>
  )
}
