import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { ResultItem, ScanHistoryChange, ScanHistoryEntry } from '../types'
import Icon from './Icons'
import { buttonBase, control, cx } from '../styles'

const changeTone: Record<string, string> = {
  upgrade: 'border-accent/35 bg-accent/8 text-ink', resolved: 'border-good/35 bg-good/8 text-ink',
  new: 'border-purple/35 bg-purple/8 text-ink', removed: 'border-line bg-canvas-soft text-muted', changed: 'border-warn/35 bg-warn/8 text-ink',
}
const changeLabel: Record<string, string> = { upgrade: 'Now upgradable', resolved: 'Resolved', new: 'New title', removed: 'Removed', changed: 'Changed' }
const statusLabel: Record<string, string> = { upgrade: 'Upgradable', best: 'Best quality', missing: 'Not on SeaDex', uncovered: 'No releases', partial: 'Partially on SeaDex' }
interface Props { active: boolean; results: ResultItem[]; onOpenResult: (key: string) => void }

export default function HistoryTab({ active, results, onOpenResult }: Props) {
  const [scans, setScans] = useState<ScanHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [changeType, setChangeType] = useState('')
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try { const response = await api.getScanHistory(); if (current === request.current) { setScans(response.scans || []); setError('') } }
    catch (caught) { if (current === request.current) setError(caught instanceof Error ? caught.message : 'Could not load scan history') }
    finally { if (current === request.current) setLoading(false) }
  }, [])
  useEffect(() => { if (active) void load(); return () => { request.current += 1 } }, [active, load])
  const filtered = useMemo(() => scans.map(scan => ({ ...scan, changes: scan.changes.filter(change =>
    change.title.toLowerCase().includes(query.trim().toLowerCase()) && (!changeType || change.type === changeType),
  ) })).filter(scan => (!query.trim() && !changeType) || scan.changes.length), [scans, query, changeType])
  const resultIndex = useMemo(() => {
    const byKey = new Map<string, ResultItem>()
    const byTitle = new Map<string, ResultItem>()
    for (const result of results) {
      const identity = JSON.stringify([result.arr, result.title, String(result.season)])
      if (!byKey.has(result.key)) byKey.set(result.key, result)
      if (!byTitle.has(identity)) byTitle.set(identity, result)
    }
    return { byKey, byTitle }
  }, [results])
  const currentResult = (change: ScanHistoryChange) => resultIndex.byKey.get(change.key) || resultIndex.byTitle.get(JSON.stringify([change.arr, change.title, String(change.season)]))

  return <section>
    <header className="app-page-header mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Scan history</h1><p className="mt-2 mb-0 text-sm text-muted">See what changed and open a title to review its current releases.</p></div>
      <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16}/>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>
    <div className="mb-4 flex flex-wrap gap-3"><label className="min-w-0 basis-48 flex-1"><span className="sr-only">Search history by title</span><input className={cx(control, 'w-full')} type="search" placeholder="Search titles in history" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="Change type" className={cx(control, 'max-w-full')} value={changeType} onChange={event => setChangeType(event.target.value)}><option value="">All changes</option>{Object.entries(changeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {error && <div className="mb-4 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert">{error}</div>}
    {!loading && !error && !filtered.length && <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">{scans.length ? 'No changes match these filters.' : 'Complete a scan to create the first history entry.'}</div>}
    <div className="space-y-4">{filtered.map(scan => <article key={scan.id} className="overflow-hidden rounded-2xl border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <Icon name={scan.outcome && scan.outcome !== 'success' ? 'alert' : 'clock'} className="text-accent-bright"/>
        <div className="min-w-0 flex-1"><h2 className="m-0 text-sm font-extrabold">{scan.run_at}</h2><p className="mt-1 mb-0 text-xs text-muted">{scan.id === scans[0]?.id ? 'Latest scan · ' : ''}{scan.changes.length} recorded changes · {scan.trigger === 'scheduled' ? 'Scheduled' : scan.trigger && scan.trigger !== 'manual' ? scan.trigger + ' webhook' : 'Manual'}{scan.duration_seconds !== undefined ? ' · ' + scan.duration_seconds.toFixed(1) + 's' : ''}{scan.outcome && scan.outcome !== 'success' ? ' · ' + scan.outcome : ''}</p>{scan.error && <p className="mt-1 text-xs text-bad">{scan.error}</p>}{Object.entries(scan.source_errors || {}).map(([source, message]) => <p key={source} className="mt-1 text-xs text-warn">{source}: {message}</p>)}</div>
        <div className="flex flex-wrap gap-1.5">{Object.entries(scan.counts || {}).filter(([, count]) => count > 0).map(([status, count]) => <span key={status} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">{count} {statusLabel[status] || status}</span>)}</div>
      </header>
      {scan.outcome === 'failed' || scan.outcome === 'cancelled' ? null : <div className="p-5">{!scan.changes.length ? <p className="m-0 text-sm text-muted">No changes from the previous scan.</p> : <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">{scan.changes.map((change, index) => {
        const result = currentResult(change)
        return <li key={change.key + ':' + index} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-canvas-soft px-3 py-2.5">
          <span className={cx('shrink-0 rounded-full border px-2 py-1 text-xs font-extrabold uppercase', changeTone[change.type])}>{changeLabel[change.type]}</span>
          <span className="min-w-0 flex-1 max-[600px]:basis-full"><button type="button" className="block w-full cursor-pointer text-left wrap-anywhere text-xs font-bold text-accent-bright hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline" disabled={!result} title={result ? 'Open ' + change.title + ' in the library' : change.title + ' is no longer in the current library'} onClick={() => result && onOpenResult(result.key)}>{change.title}</button><span className="mt-0.5 block text-xs text-muted">{change.season ? 'S' + String(change.season).padStart(2, '0') : 'Movie'}{change.from || change.to ? ' · ' + (statusLabel[change.from || ''] || change.from || '—') + ' → ' + (statusLabel[change.to || ''] || change.to || '—') : ''}{change.details?.length ? ' — ' + change.details.join(' · ') : ''}</span></span>
        </li>
      })}</ul>}</div>}
    </article>)}</div>
  </section>
}
