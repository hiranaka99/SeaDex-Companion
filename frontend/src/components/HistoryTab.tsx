import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { ResultItem, ScanHistoryChange, ScanHistoryEntry } from '../types'
import Icon from './Icons'
import { buttonBase, control, cx } from '../styles'
import { displayDateTime } from '../datetime'
import { changeTypeLabel, groupChanges, historyDetails, historyStatus, historyStatusLabel as statusLabel, matchesHistoryQuery, pluralize, scanTimes, summarizeChanges, type HistoryRow } from '../history'
import ReleaseChangeLine from './ReleaseChangeLine'

interface Props { active: boolean; results: ResultItem[]; onOpenResult: (key: string) => void }
type ScanView = 'all' | 'changes' | 'attention'

const SCAN_PAGE = 10
const ROW_PAGE = 40
const summaryTone: Record<string, string> = { regression: 'text-bad', upgrade: 'text-warn', resolved: 'text-good', changed: 'text-ink', new: 'text-sky', removed: 'text-muted' }
const outcomeLabel: Record<string, string> = { failed: 'Failed', partial: 'Partial', cancelled: 'Cancelled' }
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const needsAttention =(scan: ScanHistoryEntry) => Boolean(scan.error) || (scan.outcome !== undefined && scan.outcome !== 'success') || Object.keys(scan.source_errors || {}).length > 0
const triggerLabel = (scan: ScanHistoryEntry) => scan.trigger === 'scheduled' ? 'Scheduled' : scan.trigger === 'import' ? 'Import check' : scan.trigger && scan.trigger !== 'manual' ? scan.trigger.replace(/^./, letter => letter.toUpperCase()) + ' webhook' : 'Manual'

interface ScanEntry { scan: ScanHistoryEntry; changes: ScanHistoryChange[] }
type CurrentResult = (change: ScanHistoryChange) => ResultItem | undefined

function SeasonTag({ change }: { change: ScanHistoryChange }) {
  return change.season
    ? <span title={`Season ${change.season}`}><span aria-hidden="true">S{String(change.season).padStart(2, '0')}</span><span className="sr-only">Season {change.season}</span></span>
    : <span>Movie</span>
}

function ChangeRow({ change, result, onOpenResult }: { change: ScanHistoryChange; result: ResultItem | undefined; onOpenResult: (key: string) => void }) {
  const status = historyStatus(change)
  const moved = change.from !== change.to
  const gained = moved && change.to === 'best'
  return <li className="flex min-w-0 flex-col gap-x-5 gap-y-1 border-t border-line px-4 py-3 first:border-t-0 lg:grid lg:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)_minmax(8rem,auto)]">
    <div className="min-w-0 order-1 lg:col-start-1 lg:row-start-1">
      {result
        ? <button type="button" className="touch-target min-w-0 cursor-pointer text-left text-sm font-semibold text-accent-bright wrap-anywhere hover:underline" title={'Open ' + change.title + ' in the library'} onClick={() => onOpenResult(result.key)}>{change.title}</button>
        : <span className="block min-w-0 py-0.5 text-sm font-semibold text-ink wrap-anywhere">{change.title}</span>}
      <p className="m-0 flex flex-wrap gap-x-1.5 text-[13px] text-muted">
        <SeasonTag change={change} />{change.arr && <><span aria-hidden="true">·</span><span>{change.arr}</span></>}
        {!result && change.type !== 'removed' && <><span aria-hidden="true">·</span><span>No longer in the library</span></>}
      </p>
    </div>
    {status && <p className={cx('order-2 m-0 text-[13px] lg:order-none lg:col-start-3 lg:row-start-1 lg:text-right', gained ? 'font-bold text-good' : moved ? 'font-bold text-ink' : 'text-muted')}>{status}</p>}
    <ul className="order-3 m-0 min-w-0 list-none space-y-1 p-0 lg:order-none lg:col-start-2 lg:row-start-1">
      {historyDetails(change).map((detail, index) => <li key={index}><ReleaseChangeLine detail={detail} /></li>)}
    </ul>
  </li>
}

function ChangeGroupRow({ row, currentResult, onOpenResult }: { row: Extract<HistoryRow, { kind: 'group' }>; currentResult: CurrentResult; onOpenResult: (key: string) => void }) {
  return <li className="border-t border-line px-4 first:border-t-0">
    <details className="group">
      <summary className="touch-target flex w-fit cursor-pointer list-none items-center gap-1.5 py-2 text-[13px] hover:underline [&::-webkit-details-marker]:hidden">
        <Icon name="chevron-right" size={14} className="shrink-0 text-muted group-open:rotate-90" />
        <strong className="font-bold text-ink">{pluralize(row.changes.length, 'title')} {row.type === 'new' ? 'added to' : 'removed from'} your library</strong>
      </summary>
      <ul className="m-0 mb-3 grid list-none gap-x-5 gap-y-1 p-0 pl-5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        {row.changes.map((change, index) => {
          const result = row.type === 'new' ? currentResult(change) : undefined
          return <li key={change.key + ':' + index} className="min-w-0 wrap-anywhere">
            {result
              ? <button type="button" className="cursor-pointer text-left font-semibold text-accent-bright hover:underline" title={'Open ' + change.title + ' in the library'} onClick={() => onOpenResult(result.key)}>{change.title}</button>
              : <span className="text-ink">{change.title}</span>}
            {' '}<span className="text-muted"><SeasonTag change={change} /></span>
          </li>
        })}
      </ul>
    </details>
  </li>
}

interface CardProps {
  entry: ScanEntry; latest: boolean; open: boolean; limit: number; narrowed: boolean
  onToggle: () => void; onMore: () => void; currentResult: CurrentResult; onOpenResult: (key: string) => void
}

function ScanCard({ entry, latest, open, limit, narrowed, onToggle, onMore, currentResult, onOpenResult }: CardProps) {
  const { scan, changes } = entry
  const times = scanTimes(scan.run_at)
  const outcome = scan.outcome && scan.outcome !== 'success' ? scan.outcome : null
  const interrupted = outcome === 'failed' || outcome === 'cancelled'
  const expandable = !interrupted && changes.length > 0
  const tone = outcome === 'failed' ? 'text-bad' : outcome === 'partial' ? 'text-warn' : outcome === 'cancelled' ? 'text-muted' : 'text-accent-bright'
  const summary = summarizeChanges(scan.changes)
  const duration = scan.duration_seconds !== undefined && scan.duration_seconds >= 0.1 ? scan.duration_seconds.toFixed(1) + 's' : null
  const meta = [times.age, triggerLabel(scan), duration].filter(Boolean).join(' · ')
  const rows = useMemo(() => open && expandable ? groupChanges(changes) : [], [open, expandable, changes])
  const content = <>
    <Icon name={outcome === 'failed' || outcome === 'partial' ? 'alert' : outcome === 'cancelled' ? 'ban' : 'clock'} className={cx('mt-0.5 shrink-0', tone)} />
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <time className="text-sm font-extrabold" title={displayDateTime(scan.run_at)} dateTime={scan.run_at.replace(' ', 'T')}>{times.time}</time>
        {latest && <span className="text-xs font-bold text-accent-bright">Latest scan</span>}
        {outcome && <span className={cx('text-xs font-bold', tone)}>{outcomeLabel[outcome]}</span>}
      </span>
      <span className="mt-0.5 block text-[13px] text-muted">{meta}</span>
      {summary.length > 0
        ? <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px]">{summary.map(item => <span key={item.type}><strong className={cx('font-extrabold', summaryTone[item.type])}>{item.count.toLocaleString()}</strong> <span className="text-muted">{item.label}</span></span>)}</span>
        : !interrupted && <span className="mt-1.5 block text-[13px] text-muted">No changes from the previous scan.</span>}
    </span>
    {expandable && <Icon name="chevron-down" size={18} className={cx('mt-0.5 shrink-0 text-muted transition-transform duration-150', open && 'rotate-180')} />}
  </>
  const frame = 'flex w-full items-start gap-3 px-4 py-3.5 text-left'
  return <article className="overflow-hidden rounded-2xl border border-line bg-panel">
    <header>
      <h3 className="m-0">
        {expandable
          ? <button type="button" aria-expanded={open} className={cx(frame, 'cursor-pointer hover:bg-panel-raised')} onClick={onToggle}>{content}</button>
          : <span className={cx(frame, 'cursor-default')}>{content}</span>}
      </h3>
    </header>
    {(scan.error || Object.keys(scan.source_errors || {}).length > 0) && <div className="space-y-1 px-4 pb-3.5 pl-12">
      {scan.error && <p className={cx('m-0 text-[13px]', outcome === 'cancelled' ? 'text-muted' : 'text-bad')}>{scan.error}</p>}
      {Object.entries(scan.source_errors || {}).map(([source, message]) => <p key={source} className="m-0 text-[13px] text-warn">{source}: {message}</p>)}
    </div>}
    {open && expandable && <div className="border-t border-line">
      {narrowed && <p className="m-0 border-b border-line px-4 py-2 text-xs text-muted">Showing {changes.length.toLocaleString()} of {scan.changes.length.toLocaleString()} changes that match your filters.</p>}
      <ul className="m-0 list-none p-0">
        {rows.slice(0, limit).map((row, index) => row.kind === 'group'
          ? <ChangeGroupRow key={'group:' + row.type} row={row} currentResult={currentResult} onOpenResult={onOpenResult} />
          : <ChangeRow key={row.change.key + ':' + index} change={row.change} result={currentResult(row.change)} onOpenResult={onOpenResult} />)}
      </ul>
      {rows.length > limit && <div className="border-t border-line px-4 py-2">
        <button type="button" className="touch-target cursor-pointer text-[13px] font-bold text-accent-bright hover:underline" onClick={onMore}>Show {Math.min(ROW_PAGE, rows.length - limit)} more of {(rows.length - limit).toLocaleString()} remaining</button>
      </div>}
    </div>}
  </article>
}

export default function HistoryTab({ active, results, onOpenResult }: Props) {
  const [scans, setScans] = useState<ScanHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [changeType, setChangeType] = useState('')
  const [arr, setArr] = useState('')
  const [scanView, setScanView] = useState<ScanView>('all')
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({})
  const [scanLimit, setScanLimit] = useState(SCAN_PAGE)
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try { const response = await api.getScanHistory(); if (current === request.current) { setScans(response.scans || []); setError('') } }
    catch (caught) { if (current === request.current) setError(caught instanceof Error ? caught.message : 'Could not load scan history') }
    finally { if (current === request.current) setLoading(false) }
  }, [])
  useEffect(() => { if (active) void load(); return () => { request.current += 1 } }, [active, load])
  useEffect(() => setScanLimit(SCAN_PAGE), [query, changeType, arr, scanView])

  const changeFilterActive = Boolean(query.trim() || changeType || arr)
  const filterActive = changeFilterActive || scanView !== 'all'
  const apps = useMemo(() => [...new Set(scans.flatMap(scan => scan.changes.map(change => change.arr)).filter(Boolean))].sort(), [scans])
  const filtered = useMemo<ScanEntry[]>(() => scans.flatMap(scan => {
    const changes = changeFilterActive ? scan.changes.filter(change => matchesHistoryQuery(change, query) && (!changeType || change.type === changeType) && (!arr || change.arr === arr)) : scan.changes
    if (changeFilterActive && !changes.length) return []
    if (scanView === 'changes' && !scan.changes.length) return []
    if (scanView === 'attention' && !needsAttention(scan)) return []
    return [{ scan, changes }]
  }), [scans, query, changeType, arr, scanView, changeFilterActive])
  const visible = filtered.slice(0, scanLimit)
  const days = useMemo(() => {
    const groups: Array<{ key: string; label: string; entries: ScanEntry[] }> = []
    for (const entry of visible) {
      const day = scanTimes(entry.scan.run_at)
      const group = groups[groups.length - 1]
      if (group && group.key === day.dayKey) group.entries.push(entry)
      else groups.push({ key: day.dayKey, label: day.dayLabel, entries: [entry] })
    }
    return groups
  }, [visible])
  const totals = useMemo(() => {
    const last = scans.find(scan => scan.outcome !== 'failed' && scan.outcome !== 'cancelled' && Object.values(scan.counts || {}).some(count => count > 0))
    return last ? Object.entries(last.counts).filter(([, count]) => count > 0).map(([status, count]) => `${count.toLocaleString()} ${lowerFirst(statusLabel[status] || status)}`) : []
  }, [scans])
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
  const currentResult: CurrentResult = change => resultIndex.byKey.get(change.key) || (change.library_key ? resultIndex.byLibrary.get(JSON.stringify([change.library_key, change.season])) : undefined) || resultIndex.byTitle.get(JSON.stringify([change.arr, change.title, String(change.season)]))
  const resetFilters = () => { setQuery(''); setChangeType(''); setArr(''); setScanView('all') }
  const latestId = scans[0]?.id
  const defaultOpenId = scans.find(scan => scan.changes.length > 0 && scan.outcome !== 'failed' && scan.outcome !== 'cancelled')?.id
  const isOpen = (id: string) => opened[id] ?? (changeFilterActive || id === defaultOpenId)

  return <section>
    <header className="app-page-header mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Scan history</h1>
        <p className="mt-2 mb-0 text-sm text-muted">See what changed and open a title to review its current releases.</p>
        {totals.length > 0 && <p className="mt-1 mb-0 text-[13px] text-muted">As of the last scan: {totals.join(' · ')}</p>}
      </div>
      <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16}/>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <label className="relative min-w-0 basis-48 flex-1"><span className="sr-only">Search history by title or season</span><input className={cx(control, 'w-full')} type="search" placeholder="Search titles or season (S02)" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <select aria-label="Change type" className={cx(control, 'max-w-full')} value={changeType} onChange={event => setChangeType(event.target.value)}><option value="">All changes</option>{Object.entries(changeTypeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {apps.length > 1 && <select aria-label="Library app" className={cx(control, 'max-w-full')} value={arr} onChange={event => setArr(event.target.value)}><option value="">All apps</option>{apps.map(app => <option key={app} value={app}>{app}</option>)}</select>}
      <select aria-label="Scans shown" className={cx(control, 'max-w-full')} value={scanView} onChange={event => setScanView(event.target.value as ScanView)}><option value="all">All scans</option><option value="changes">Scans with changes</option><option value="attention">Failed or incomplete</option></select>
      {filterActive && <button type="button" className="touch-target cursor-pointer rounded-control px-2 text-sm font-semibold text-accent-bright hover:underline" onClick={resetFilters}>Reset filters</button>}
    </div>
    {error && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><span>{error}</span><button type="button" className="touch-target cursor-pointer font-bold underline" onClick={() => void load()} disabled={loading}>Try again</button></div>}
    {loading && !scans.length && !error && <div role="status" aria-label="Loading scan history" className="space-y-3">{[0, 1, 2].map(index => <div key={index} className="skeleton h-[78px] rounded-2xl border border-line" />)}</div>}
    {!loading && !error && !filtered.length && <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">{scans.length
      ? <>No scans match these filters. <button type="button" className="touch-target cursor-pointer font-bold text-accent-bright hover:underline" onClick={resetFilters}>Reset filters</button></>
      : 'Complete a scan to create the first history entry.'}</div>}
    <div className="space-y-6">{days.map(day => <section key={day.key} aria-label={day.label}>
      <h2 className="mt-0 mb-2 px-1 text-[13px] font-bold text-muted">{day.label}</h2>
      <div className="space-y-3">{day.entries.map(entry => <ScanCard
        key={entry.scan.id} entry={entry} latest={entry.scan.id === latestId} narrowed={changeFilterActive}
        open={isOpen(entry.scan.id)} limit={rowLimits[entry.scan.id] ?? ROW_PAGE}
        onToggle={() => setOpened(current => ({ ...current, [entry.scan.id]: !isOpen(entry.scan.id) }))}
        onMore={() => setRowLimits(current => ({ ...current, [entry.scan.id]: (current[entry.scan.id] ?? ROW_PAGE) + ROW_PAGE }))}
        currentResult={currentResult} onOpenResult={onOpenResult} />)}</div>
    </section>)}</div>
    {filtered.length > visible.length && <div className="mt-5 flex justify-center"><button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => setScanLimit(limit => limit + SCAN_PAGE)}>Show {Math.min(SCAN_PAGE, filtered.length - visible.length)} older scans · {(filtered.length - visible.length).toLocaleString()} remaining</button></div>}
  </section>
}
