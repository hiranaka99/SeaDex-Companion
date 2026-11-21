import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { ResultItem, ScanHistoryChange, ScanHistoryEntry } from '../types'
import Icon from './Icons'
import { buttonBase, control, cx } from '../styles'
import { displayDateTime } from '../datetime'
import { historyDetails, historyStatus, historyStatusLabel as statusLabel } from '../history'
import ReleaseChangeLine from './ReleaseChangeLine'

const changeLabel: Record<string, string> = { upgrade: 'Now upgradable', resolved: 'Resolved', new: 'New title', removed: 'Removed', changed: 'Updated' }
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
    const byLibrary = new Map<string, ResultItem>()
    for (const result of results) {
      const identity = JSON.stringify([result.arr, result.title, String(result.season)])
      if (result.library_key) byLibrary.set(JSON.stringify([result.library_key, result.season]), result)
      if (!byKey.has(result.key)) byKey.set(result.key, result)
      if (!byTitle.has(identity)) byTitle.set(identity, result)
    }
    return { byKey, byTitle, byLibrary }
  }, [results])
  const currentResult = (change: ScanHistoryChange) => resultIndex.byKey.get(change.key) || (change.library_key ? resultIndex.byLibrary.get(JSON.stringify([change.library_key, change.season])) : undefined) || resultIndex.byTitle.get(JSON.stringify([change.arr, change.title, String(change.season)]))

  return <section>
    <header className="app-page-header mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Scan history</h1><p className="mt-2 mb-0 text-sm text-muted">See what changed and open a title to review its current releases.</p></div>
      <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16}/>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>
    <div className="mb-4 flex flex-wrap gap-3"><label className="relative min-w-0 basis-48 flex-1"><span className="sr-only">Search history by title</span><input className={cx(control, 'w-full')} type="search" placeholder="Search titles in history" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="Change type" className={cx(control, 'max-w-full')} value={changeType} onChange={event => setChangeType(event.target.value)}><option value="">All changes</option>{Object.entries(changeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {error && <div className="mb-4 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert">{error}</div>}
    {!loading && !error && !filtered.length && <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">{scans.length ? 'No changes match these filters.' : 'Complete a scan to create the first history entry.'}</div>}
    <div className="space-y-4">{filtered.map(scan => <article key={scan.id} className="overflow-hidden rounded-2xl border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <Icon name={scan.outcome && scan.outcome !== 'success' ? 'alert' : 'clock'} className="text-accent-bright"/>
        <div className="min-w-0 flex-1"><h2 className="m-0 text-sm font-extrabold">{displayDateTime(scan.run_at)}</h2><p className="mt-1 mb-0 text-xs text-muted">{scan.id === scans[0]?.id ? 'Latest scan · ' : ''}{scan.changes.length} recorded changes · {scan.trigger === 'scheduled' ? 'Scheduled' : scan.trigger && scan.trigger !== 'manual' ? scan.trigger + ' webhook' : 'Manual'}{scan.duration_seconds !== undefined ? ' · ' + scan.duration_seconds.toFixed(1) + 's' : ''}{scan.outcome && scan.outcome !== 'success' ? ' · ' + scan.outcome : ''}</p>{scan.error && <p className="mt-1 text-xs text-bad">{scan.error}</p>}{Object.entries(scan.source_errors || {}).map(([source, message]) => <p key={source} className="mt-1 text-xs text-warn">{source}: {message}</p>)}</div>
        <div className="flex flex-wrap gap-1.5">{Object.entries(scan.counts || {}).filter(([, count]) => count > 0).map(([status, count]) => <span key={status} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">{count} {statusLabel[status] || status}</span>)}</div>
      </header>
      {scan.outcome === 'failed' || scan.outcome === 'cancelled' ? null : <div>{!scan.changes.length ? <p className="m-0 px-5 py-3 text-sm text-muted">No changes from the previous scan.</p> : <ul className="m-0 grid list-none p-0 lg:grid-cols-2">{scan.changes.map((change, index) => {
        const result = currentResult(change)
        const status = historyStatus(change)
        return <li key={change.key + ':' + index} className="min-w-0 border-t border-line px-3.5 py-2 first:border-t-0 lg:even:border-l lg:[&:nth-child(2)]:border-t-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button type="button" className="touch-target min-w-0 cursor-pointer text-left text-sm font-bold text-accent-bright wrap-anywhere hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline" disabled={!result} title={result ? 'Open ' + change.title + ' in the library' : change.title + ' is no longer in the current library'} onClick={() => result && onOpenResult(result.key)}>{change.title}</button>
            {change.season ? <span className="text-xs font-bold text-muted" title={`Season ${change.season}`}><span aria-hidden="true">S{String(change.season).padStart(2, '0')}</span><span className="sr-only">Season {change.season}</span></span> : <span className="text-xs font-bold text-muted">Movie</span>}
            {change.arr && <span className="text-xs text-muted">{change.arr}</span>}
            {status && <span className={cx('ml-auto text-xs', change.to === 'best' && change.from !== change.to ? 'text-good' : 'text-muted')}>{status}</span>}
          </div>
          <ul className="mt-0.5 mb-0 list-none space-y-0.5 p-0">
            {historyDetails(change).map((detail, detailIndex) => <li key={detailIndex}><ReleaseChangeLine detail={detail} /></li>)}
          </ul>
        </li>
      })}</ul>}</div>}
    </article>)}</div>
  </section>
}
