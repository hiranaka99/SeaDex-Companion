import { useEffect, useState } from 'react'
import * as api from '../api'
import { ScanHistoryEntry } from '../types'
import Icon from './Icons'
import { buttonBase, cx } from '../styles'

const changeTone: Record<string, string> = {
  upgrade: 'border-accent/35 bg-accent/8 text-accent-bright',
  resolved: 'border-good/35 bg-good/8 text-good',
  new: 'border-purple/35 bg-purple/8 text-purple',
  removed: 'border-line bg-canvas-soft text-muted',
  changed: 'border-warn/35 bg-warn/8 text-warn',
}

const changeLabel: Record<string, string> = {
  upgrade: 'Now upgradable', resolved: 'Resolved', new: 'New title', removed: 'Removed', changed: 'Changed',
}

export default function HistoryTab() {
  const [scans, setScans] = useState<ScanHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try { const result = await api.getScanHistory(); setScans(result.scans || []); setError('') }
    catch (caught: any) { setError(caught?.message || 'Could not load scan history') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  return <section>
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Activity</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Scan history</h1><p className="mt-2 mb-0 text-sm text-muted">See what changed between completed library scans.</p></div>
      <button type="button" className={cx(buttonBase, 'border-line bg-panel text-muted hover:text-ink')} onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16}/>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>
    {error && <div className="mb-4 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert">{error}</div>}
    {!loading && !error && scans.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center"><Icon name="clock" size={30} className="mx-auto mb-3 text-muted-dim"/><h2 className="mb-2 text-lg font-bold">No scan history yet</h2><p className="m-0 text-sm text-muted">Complete a scan to create the first history entry.</p></div>}
    <div className="space-y-4">{scans.map((scan, scanIndex) => {
      const countSummary = Object.entries(scan.counts || {}).filter(([, count]) => count > 0)
      return <article key={scan.id} className="overflow-hidden rounded-2xl border border-line bg-panel">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4"><span className={cx('grid size-10 place-items-center rounded-xl', scan.outcome === 'failed' || scan.outcome === 'cancelled' ? 'bg-bad/10 text-bad' : scan.outcome === 'partial' ? 'bg-warn/10 text-warn' : 'bg-accent/10 text-accent-bright')}><Icon name={scan.outcome && scan.outcome !== 'success' ? 'alert' : 'clock'} size={18}/></span><div className="min-w-0 flex-1"><h2 className="m-0 text-sm font-extrabold">{scan.run_at}</h2><p className="mt-1 mb-0 text-xs text-muted">{scanIndex === 0 ? 'Latest scan' : `${scan.changes.length} recorded change${scan.changes.length === 1 ? '' : 's'}`} · {scan.trigger === 'scheduled' ? 'Scheduled' : scan.trigger === 'sonarr' ? 'Sonarr webhook' : scan.trigger === 'radarr' ? 'Radarr webhook' : scan.trigger === 'sonarr+radarr' ? 'Sonarr + Radarr webhooks' : 'Manual'}{scan.scanned_titles !== undefined ? ` · ${scan.scanned_titles} titles` : ''}{scan.duration_seconds !== undefined ? ` · ${scan.duration_seconds.toFixed(1)}s` : ''}{scan.outcome && scan.outcome !== 'success' ? ` · ${scan.outcome[0].toUpperCase()}${scan.outcome.slice(1)}` : ''}</p>{scan.error && <p className="mt-1 mb-0 text-[10px] text-bad">{scan.error}</p>}{Object.entries(scan.source_errors || {}).map(([source, message]) => <p key={source} className="mt-1 mb-0 text-[10px] text-warn">{source}: {message}</p>)}</div><div className="flex flex-wrap gap-1.5">{countSummary.map(([status, count]) => <span key={status} className="rounded-full border border-line bg-canvas-soft px-2.5 py-1 text-[10px] font-bold text-muted">{count} {status}</span>)}</div></header>
        {scan.outcome === 'failed' || scan.outcome === 'cancelled' ? null : <div className="p-5">{scan.changes.length === 0 ? <p className="m-0 text-sm text-muted">No changes from the previous scan.</p> : <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">{scan.changes.map((change, index) => <li key={`${change.key}:${index}`} className="flex items-center gap-3 rounded-xl border border-line bg-canvas-soft px-3 py-2.5"><span className={cx('shrink-0 rounded-full border px-2 py-1 text-[9px] font-extrabold uppercase', changeTone[change.type])}>{changeLabel[change.type]}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-ink" title={change.title}>{change.title}</span><span className="mt-0.5 block text-[10px] text-muted">{change.season ? `S${String(change.season).padStart(2, '0')}` : 'Movie'}{change.from || change.to ? ` · ${change.from || '—'} → ${change.to || '—'}` : ''}{(change.details || []).length ? ` — ${(change.details || []).join(' · ')}` : ''}</span></span></li>)}</ul>}</div>}
      </article>
    })}</div>
  </section>
}
