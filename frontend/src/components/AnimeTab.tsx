import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ResultItem, Config, Status, GroupedCard } from '../types'
import { groupResults, formatBytes, seasonLabel } from '../utils'
import Card from './Card'
import BulkDownloadDialog, { BulkOutcome } from './BulkDownloadDialog'
import BulkCancelDialog from './BulkCancelDialog'
import Icon, { IconName } from './Icons'
import { useToast } from './Toast'
import * as api from '../api'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import { BulkOperationState } from './OperationCenter'

interface Props {
  active: boolean
  openResultKey: string | null
  onResultOpened: () => void
  bulkOperationActive?: boolean
  results: ResultItem[]
  config: Config | null
  status: Status
  lastRun: string | null
  onScan: () => void
  loading: boolean
  loadError: string
  onReloadResults: () => void
  onOpenConfig: () => void
  onBulkOperationChange: (operation: BulkOperationState) => void
  operationsVisible: boolean
  onResultsChanged: () => Promise<void>
}

const PAGE_SIZE = 60

function cardKey(group: GroupedCard): string {
  return group.anilist_id !== null ? String(group.anilist_id) : `${group.arr}:${group.title}`
}

function cardDelta(group: GroupedCard): number {
  return group.seasons.reduce((total, season) => total + (season.status === 'upgrade' || (season.status === 'partial' && season.upgrade_available) ? (season.best_size || 0) - (season.local_size || 0) : 0), 0)
}

function SkeletonCards() {
  return <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]" aria-label="Loading library">
    {Array.from({ length: 6 }, (_, index) => <div key={index} className="overflow-hidden rounded-card border border-line bg-panel"><div className="skeleton h-40"/><div className="space-y-3 p-4"><div className="skeleton h-5 w-3/4 rounded-md"/><div className="flex gap-2"><div className="skeleton h-7 w-20 rounded-full"/><div className="skeleton h-7 w-24 rounded-full"/></div><div className="skeleton h-10 rounded-lg"/></div></div>)}
  </div>
}

export default function AnimeTab({ active, openResultKey, onResultOpened, bulkOperationActive = false, results, config, status, lastRun, onScan, loading, loadError, onReloadResults, onOpenConfig, onBulkOperationChange, operationsVisible, onResultsChanged }: Props) {
  const [search, setSearch] = useState('')
  const [arr, setArr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState('recommended')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [page, setPage] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm] = useState<'start' | 'cancel' | null>(null)
  const [bulkBusy, setBulkBusy] = useState<'start' | 'cancel' | null>(null)
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null)
  const toast = useToast()

  useEffect(() => { if (!openResultKey) setPage(0) }, [search, arr, statusFilter, sort, showHidden])

  useEffect(() => { if (!active && !bulkBusy) setBulkConfirm(null) }, [active, bulkBusy])
  useEffect(() => {
    if (!openResultKey) return
    const group = groupResults(results).find(group => group.seasons.some(season => season.key === openResultKey))
    if (group) { setSearch(''); setArr(''); setStatusFilter(''); setShowHidden(hiddenKeys.has(cardKey(group))) }
    else { toast.show('This title is no longer in the current library', 'info'); onResultOpened() }
  }, [openResultKey])

  useEffect(() => {
    if (config?.hidden) setHiddenKeys(new Set(config.hidden))
  }, [config?.hidden])

  const allGroups = useMemo(() => groupResults(results), [results])
  const scopeGroups = useMemo(() => allGroups.filter(group => {
    if (hiddenKeys.has(cardKey(group)) !== showHidden || (arr && group.arr !== arr)) return false
    const haystack = `${group.title} ${group.seasons.map(season => `${season.title} ${season.best_group || ''} ${season.have.join(' ')} ${seasonLabel(season)}`).join(' ')}`
    return haystack.toLowerCase().includes(search.trim().toLowerCase())
  }), [allGroups, hiddenKeys, showHidden, arr, search])
  const counts = useMemo(() => Object.fromEntries(['upgrade', 'partial', 'missing', 'best', 'review'].map(status => [status, scopeGroups.filter(group => group.status === status).length])), [scopeGroups])

  const toggleHidden = async (key: string) => {
    const wasHidden = hiddenKeys.has(key)
    const next = new Set(hiddenKeys)
    if (wasHidden) next.delete(key); else next.add(key)
    setHiddenKeys(next)
    try {
      await api.setHidden(key, !wasHidden)
      toast.show(wasHidden ? 'Card restored to the library' : 'Card hidden from the library', 'success')
    } catch (error: any) {
      setHiddenKeys(hiddenKeys)
      toast.show('Could not update hidden cards: ' + error.message, 'error')
    }
  }

  const groups = useMemo(() => {
    const filtered = scopeGroups.filter(group => statusFilter === 'episodes'
      ? group.seasons.some(season => (season.missing_episode_count || 0) > 0)
      : !statusFilter || group.status === statusFilter)
    const rank: Record<string, number> = { review: 0, upgrade: 1, partial: 2, missing: 3, best: 4 }
    filtered.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      if (sort === 'size') return Math.abs(cardDelta(b)) - Math.abs(cardDelta(a)) || a.title.localeCompare(b.title)
      return rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    })
    return filtered
  }, [scopeGroups, statusFilter, sort])

  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  const requestedIndex = openResultKey ? groups.findIndex(group => group.seasons.some(season => season.key === openResultKey)) : -1
  const currentPage = requestedIndex >= 0 ? Math.floor(requestedIndex / PAGE_SIZE) : Math.min(page, pageCount - 1)
  const visibleGroups = groups.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  // Persist a history destination's page before Card clears the open request.
  useLayoutEffect(() => { if (requestedIndex >= 0) setPage(Math.floor(requestedIndex / PAGE_SIZE)) }, [requestedIndex])
  useEffect(() => { setPage(value => Math.min(value, pageCount - 1)) }, [pageCount])
  const changePage = (next: number) => {
    setPage(Math.max(0, Math.min(next, pageCount - 1)))
    window.requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ block: 'start' })
      resultsRef.current?.focus({ preventScroll: true })
    })
  }


  const totalDelta = groups.reduce((sum, group) => sum + cardDelta(group), 0)
  const upgradeSeasonCount = useMemo(() => new Set(
    results
      .filter((result) => {
        if (result.excluded || (result.status !== 'upgrade' && !(result.status === 'partial' && result.upgrade_available))) return false
        const excludedParts = new Set(result.excluded_parts || [])
        return result.releases.some((release) => release.kind === 'best' && !excludedParts.has(release.part || ''))
      })
      .map((result) => result.key),
  ).size, [results])
  const libraryConfigured = Boolean(
    (config?.sonarr_url && config.sonarr_key_configured) ||
    (config?.radarr_url && config.radarr_key_configured),
  )
  const autoCheckMinutes = status.next_check ? Math.max(0, Math.round((status.next_check - Date.now() / 1000) / 60)) : null
  const autoCheckLabel = autoCheckMinutes == null ? null : (() => { const hours = Math.floor(autoCheckMinutes / 60); const minutes = autoCheckMinutes % 60; return hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) : `${minutes} min` })()
  const scheduleDescription = config?.scan_schedule?.enabled
    ? config.scan_schedule.mode === 'interval'
      ? `Every ${config.scan_schedule.interval_minutes >= 60 ? `${Math.floor(config.scan_schedule.interval_minutes / 60)}h ${config.scan_schedule.interval_minutes % 60 ? `${config.scan_schedule.interval_minutes % 60}m` : ''}`.trim() : `${config.scan_schedule.interval_minutes}m`}`
      : `${config.scan_schedule.mode === 'daily' ? 'Daily' : config.scan_schedule.weekdays.map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')} at ${config.scan_schedule.times.join(', ')} ${config.scan_schedule.timezone}`
    : null
  const clearFilters = () => { setSearch(''); setArr(''); setStatusFilter(''); setSort('recommended'); setShowHidden(false) }
  const statusFilters: { value: string; label: string; count: number; tone: string; icon: IconName }[] = [
    { value: '', label: 'All', count: scopeGroups.length, tone: 'text-ink', icon: 'library' },
    { value: 'review', label: 'Match needs review', count: counts.review, tone: 'text-warn', icon: 'search' },
    { value: 'episodes', label: 'Episodes missing', count: scopeGroups.filter(group => group.seasons.some(season => (season.missing_episode_count || 0) > 0)).length, tone: 'text-warn', icon: 'alert' },
    { value: 'upgrade', label: 'Upgradable', count: counts.upgrade, tone: 'text-accent-bright', icon: 'sparkles' },
    { value: 'partial', label: 'Partially on SeaDex', count: counts.partial, tone: 'text-warn', icon: 'alert' },
    { value: 'missing', label: 'Not on SeaDex', count: counts.missing, tone: 'text-muted', icon: 'alert' },
    { value: 'best', label: 'Best quality', count: counts.best, tone: 'text-good', icon: 'check' },
  ]
  const activeOptions = [arr, showHidden ? 'Hidden only' : '', sort === 'title' ? 'Title A–Z' : sort === 'size' ? 'Largest size change' : ''].filter(Boolean)
  const activeFilters = [search.trim() ? `Search: ${search.trim()}` : '', ...activeOptions, statusFilter ? statusFilters.find(filter => filter.value === statusFilter)?.label : ''].filter(Boolean)

  const describeBulkFailures = (failures: api.BulkDownloadFailure[]): string => {
    const shown = failures.slice(0, 3).map((failure) => {
      const suffix = /metadata fetching failed/i.test(failure.error)
        ? ' — metadata fetching failed, torrent removed from qBittorrent'
        : ` — ${failure.error}`
      return `${failure.label}${suffix}`
    })
    return shown.join('; ') + (failures.length > 3 ? `; and ${failures.length - 3} more` : '')
  }

  const hashesForSelection = (selection: api.BulkDownloadTarget): string[] => {
    const item = results.find((entry) => entry.key === selection.key)
    return (item?.releases?.[selection.release]?.info_hashes || []).map((hash: string) => String(hash).toLowerCase())
  }

  const handleBulkDownloads = async (action: 'start' | 'cancel', selections: api.BulkDownloadTarget[] = [], deleteFiles = false) => {
    setBulkBusy(action)
    let pollId: number | null = null
    let polling = true
    try {
      if (action === 'start') {
        const allHashes = new Set<string>()
        for (const selection of selections) for (const hash of hashesForSelection(selection)) allHashes.add(hash)
        onBulkOperationChange({ action, phase: 'running', settled: 0, total: allHashes.size, added: 0, failed: 0, message: `Preparing ${allHashes.size} torrent${allHashes.size === 1 ? '' : 's'}…` })
        // The request settles each torrent one at a time (metadata is fetched
        // with a 15 second budget per torrent), so poll the live batch status
        // while it is in flight and color each title as soon as its own
        // torrent settles instead of only after the whole batch finished.
        setBulkOutcome({ requested: new Set(), failed: new Set(), pending: new Set(allHashes), inflight: true })
        const request = api.bulkDownloads('start', selections)
        pollId = window.setInterval(() => {
          void api.getBulkDownloadStatus().then((status) => {
            if (!polling) return
            const settled = status.added.length + status.failures.length
            onBulkOperationChange({ action, phase: 'running', settled, total: settled + status.pending.length, added: status.added.length, failed: status.failures.length, message: `${status.added.length} added · ${status.pending.length} pending${status.failures.length ? ` · ${status.failures.length} failed` : ''}` })
            setBulkOutcome((current) => current ? {
              requested: new Set(status.added.map((hash) => hash.toLowerCase())),
              failed: new Set(status.failures.map((failure) => failure.hash.toLowerCase())),
              pending: new Set(status.pending.map((hash) => hash.toLowerCase())),
              inflight: true,
            } : current)
          }).catch(() => { /* transient poll failure — keep polling */ })
        }, 700)
        const result = await request
        polling = false
        let status: api.BulkDownloadStatus | null = null
        try { status = await api.getBulkDownloadStatus() } catch { /* fall back to the request result */ }
        const failures = status && status.failures.length ? status.failures : (result.failures || [])
        if (result.count > 0) {
          toast.show(`Sent ${result.count} torrent${result.count === 1 ? '' : 's'} to qBittorrent`, 'success')
        } else if (!failures.length) {
          toast.show(result.existing?.length ? 'Selected torrents are already in qBittorrent' : 'No downloadable upgrades found', 'info')
        }
        if (failures.length) {
          toast.show(`${failures.length} torrent${failures.length === 1 ? '' : 's'} could not be added: ${describeBulkFailures(failures)}`, 'error')
        }
        const failed = new Set(failures.map((failure) => failure.hash.toLowerCase()))
        const pending = status ? new Set(status.pending.map((hash) => hash.toLowerCase())) : new Set<string>()
        const requested = new Set<string>()
        if (status) for (const hash of status.added) requested.add(hash.toLowerCase())
        for (const hash of allHashes) if (!failed.has(hash) && !pending.has(hash) && !requested.has(hash)) requested.add(hash)
        setBulkOutcome({ requested, failed, pending, inflight: false })
        onBulkOperationChange({
          action,
          phase: failures.length ? 'warning' : 'success',
          settled: requested.size + failures.length,
          total: allHashes.size,
          added: result.count,
          failed: failures.length,
          message: `${result.count} added${result.existing?.length ? ` · ${result.existing.length} already in qBittorrent` : ''}${failures.length ? ` · ${failures.length} failed` : ''}`,
        })
      } else {
        onBulkOperationChange({ action, phase: 'running', settled: 0, total: selections.length, added: 0, failed: 0, message: `Removing selected incomplete downloads…` })
        const result = await api.bulkDownloads(action, selections, deleteFiles)
        toast.show(result.count
          ? `Cancelled ${result.count} download${result.count === 1 ? '' : 's'}; ${deleteFiles ? 'downloaded files were deleted' : 'files were kept'}`
          : 'No active bulk downloads found', result.count ? 'success' : 'info')
        onBulkOperationChange({ action, phase: 'success', settled: selections.length, total: selections.length, added: 0, failed: 0, message: result.count ? `Removed ${result.count} torrent${result.count === 1 ? '' : 's'}; ${deleteFiles ? 'files deleted' : 'files preserved'}` : 'No active bulk downloads were found' })
        setBulkConfirm(null)
      }
    } catch (error: any) {
      toast.show(`Bulk ${action === 'start' ? 'download' : 'cancel'} failed: ${error.message}`, 'error')
      onBulkOperationChange({ action, phase: 'error', settled: 0, total: selections.length, added: 0, failed: selections.length, message: error.message })
      if (action === 'start') {
        // The request itself failed (for example qBittorrent is unreachable):
        // show every selected title in red so the user sees what was affected.
        const failed = new Set<string>()
        for (const selection of selections) for (const hash of hashesForSelection(selection)) failed.add(hash)
        setBulkOutcome({ requested: new Set(), failed, pending: new Set(), inflight: false })
      } else {
        setBulkConfirm(null)
      }
    } finally {
      polling = false
      if (pollId !== null) window.clearInterval(pollId)
      setBulkBusy(null)
    }
  }

  return (
    <section>
      <header className="app-page-header mb-6 flex flex-wrap items-start justify-between gap-5">
        <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Anime library</h1><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="clock" size={15}/>{lastRun ? `Last scan ${lastRun}` : 'No completed scan'}</span>{autoCheckLabel !== null && <span title={scheduleDescription || undefined}>{scheduleDescription} · next in ~{autoCheckLabel}</span>}{status.webhook_scan.queued && <span className="text-accent-bright">Webhook scan queued</span>}</div></div>
        <div className="library-actions flex flex-wrap items-center gap-2.5 max-[600px]:grid max-[600px]:w-full max-[600px]:grid-cols-2">
          <button className={cx(buttonPrimary, 'justify-center max-[600px]:col-span-2')} onClick={onScan} disabled={status.running || bulkBusy !== null || bulkOperationActive}>{status.running ? <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/> : <Icon name="play" size={17}/>}<span>{status.running ? 'Scanning library…' : 'Scan library'}</span></button>
          <button type="button" className={cx(buttonBase, 'justify-center border-good/35 bg-good/10 text-good hover:bg-good/18 max-[600px]:px-3 max-[600px]:text-xs')} onClick={() => { setBulkOutcome(null); setBulkConfirm('start') }} disabled={status.running || bulkBusy !== null || upgradeSeasonCount === 0}>{bulkBusy === 'start' ? <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good"/> : <Icon name="download" size={17}/>}<span>Bulk download</span></button>
          <button type="button" className={cx(buttonBase, 'justify-center border-bad/35 bg-bad/10 text-bad hover:bg-bad/18 max-[600px]:px-3 max-[600px]:text-xs')} onClick={() => setBulkConfirm('cancel')} disabled={status.running || bulkBusy !== null || bulkOperationActive}>{bulkBusy === 'cancel' ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={17}/>}<span>Bulk cancel</span></button>
        </div>
      </header>

      {loadError && <div className="mb-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="shrink-0"/><span className="min-w-0 flex-1">Could not load scanned results: {loadError}</span><button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onReloadResults}><Icon name="refresh" size={15}/>Retry</button><button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onOpenConfig}>Open Config</button></div>}

      <div className={cx('library-toolbar z-20 mb-5 rounded-2xl border border-line bg-canvas/92 p-3 shadow-[0_12px_28px_rgba(0,0,0,.22)] backdrop-blur-xl', operationsVisible ? 'relative' : 'sticky top-0')}>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-0 flex-1 max-[600px]:basis-full"><span className="sr-only">Search anime</span><Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-dim"/><input type="search" className={cx(control, 'w-full pl-10')} placeholder="Search titles and release groups" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
          <select aria-label="Filter by status" className={cx(control, 'hidden min-w-0 flex-1 max-[600px]:block')} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>{statusFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label} ({filter.count})</option>)}</select>
          <button type="button" className={cx(buttonBase, 'justify-center border-line bg-panel px-3 text-xs text-ink min-[601px]:hidden')} aria-expanded={optionsOpen} aria-controls="library-options" onClick={() => setOptionsOpen(value => !value)}><Icon name="filter" size={16}/><span>Filters & sort{activeOptions.length > 0 && ` (${activeOptions.length})`}</span></button>
          <div id="library-options" className={cx('w-full min-w-0 flex-wrap items-center gap-2.5 [&>select]:min-w-0 [&>select]:max-w-full min-[601px]:contents', optionsOpen ? 'flex' : 'hidden')}>
          <select aria-label="Source" className={cx(control, 'cursor-pointer')} value={arr} onChange={(event) => setArr(event.target.value)}><option value="">All sources</option><option value="Sonarr">Sonarr</option><option value="Radarr">Radarr</option></select>
          <select aria-label="Sort library" className={cx(control, 'cursor-pointer')} value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">Recommended order</option><option value="title">Title A–Z</option><option value="size">Largest size change</option></select>
          <button type="button" className={cx('inline-flex cursor-pointer items-center gap-2 rounded-control border px-3.5 py-2.5 text-sm font-semibold transition-colors', showHidden ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line bg-panel text-ink hover:text-ink')} aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}><Icon name={showHidden ? 'eye-off' : 'eye'} size={17}/>{showHidden ? 'Hidden only' : 'Show hidden only'}</button>
          </div>
        </div>
        <div className="mt-3 hidden flex-wrap min-[601px]:flex items-center gap-1" aria-label="Filter by status">
          {statusFilters.map((filter) => <button key={filter.value} type="button" className={cx('touch-target inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors', statusFilter === filter.value ? 'bg-accent/14 text-ink' : 'text-muted hover:bg-panel hover:text-ink')} aria-pressed={statusFilter === filter.value} onClick={() => setStatusFilter(filter.value)}><Icon name={filter.icon} size={15} className={cx('shrink-0', filter.tone)}/><span>{filter.label}</span><span className="text-xs tabular-nums text-muted">{filter.count}</span></button>)}
          <span className="ml-auto shrink-0 px-2 text-xs text-muted-dim">{groups.length} shown{totalDelta !== 0 && ` · ${(totalDelta > 0 ? '+' : '') + formatBytes(totalDelta)}`}</span>
        </div>
        <p className="mt-2 mb-0 hidden text-xs text-muted max-[600px]:block">{groups.length} shown{totalDelta !== 0 && ` · ${(totalDelta > 0 ? '+' : '') + formatBytes(totalDelta)}`}</p>
        {activeFilters.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs text-muted" aria-label="Active library filters"><span className="min-w-0 flex-1 wrap-anywhere">{activeFilters.join(' · ')}</span><button type="button" className="touch-target cursor-pointer rounded-md px-2 py-1 font-semibold text-accent-bright hover:underline" onClick={clearFilters}>Clear filters</button></div>}
      </div>

      {(loading || (status.running && results.length === 0)) && <SkeletonCards/>}
      {!loading && results.length > 0 && groups.length > 0 && <div ref={resultsRef} className="library-results" tabIndex={-1} role="region" aria-label="Library results">
        {pageCount > 1 && <nav className="mb-4 flex flex-wrap items-center justify-between gap-3" aria-label="Library pages"><span className="text-xs text-muted" role="status">{(currentPage * PAGE_SIZE + 1).toLocaleString()}–{Math.min((currentPage + 1) * PAGE_SIZE, groups.length).toLocaleString()} of {groups.length.toLocaleString()} titles</span><div className="flex flex-wrap items-center gap-2"><button type="button" className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><Icon name="chevron-left" size={15}/>Previous</button><select className={cx(control, 'text-xs')} aria-label="Library page" value={currentPage} onChange={event => changePage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Page {index + 1} of {pageCount}</option>)}</select><button type="button" className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')} disabled={currentPage >= pageCount - 1} onClick={() => changePage(currentPage + 1)}>Next<Icon name="chevron-right" size={15}/></button></div></nav>}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]">{visibleGroups.map((group, index) => <Card key={cardKey(group)} active={active} openRequested={group.seasons.some(season => season.key === openResultKey)} onOpened={onResultOpened} group={group} index={index} config={config} hidden={hiddenKeys.has(cardKey(group))} onToggle={() => void toggleHidden(cardKey(group))} onRulesChanged={onResultsChanged} onRescan={onScan}/>)}</div>
      </div>}
      {!loading && !loadError && results.length === 0 && !status.running && <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center"><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent-bright"><Icon name="library" size={26}/></span><h2 className="mb-2 text-lg font-bold">{libraryConfigured ? 'Your library is ready to be scanned' : 'Connect your library first'}</h2><p className="mx-auto mb-5 max-w-md text-sm text-muted">{libraryConfigured ? 'Compare your Sonarr and Radarr collection with the best releases available on SeaDex.' : 'Configure Sonarr or Radarr before running your first scan.'}</p><div className="flex flex-wrap justify-center gap-2"><button type="button" className={libraryConfigured ? buttonPrimary : cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onScan} disabled={!libraryConfigured}><Icon name="play" size={17}/>Scan library</button><button type="button" className={libraryConfigured ? cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink') : buttonPrimary} onClick={onOpenConfig}><Icon name="settings" size={17}/>Open Config</button></div></div>}
      {!loading && results.length > 0 && groups.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong py-14 text-center"><Icon name="filter" size={26} className="mx-auto mb-3 text-muted-dim"/><h2 className="mb-1 text-lg font-bold">No matching titles</h2><p className="mb-4 text-sm text-muted">Try changing or clearing the active filters.</p><button type="button" className="cursor-pointer text-sm font-bold text-accent-bright" onClick={clearFilters}>Clear filters</button></div>}
      <BulkDownloadDialog
        open={active && bulkConfirm === 'start'}
        results={results}
        hiddenKeys={hiddenKeys}
        busy={bulkBusy === 'start'}
        outcome={bulkConfirm === 'start' ? bulkOutcome : null}
        onConfirm={(selections) => void handleBulkDownloads('start', selections)}
        onClose={() => { if (!bulkBusy) { setBulkConfirm(null); setBulkOutcome(null) } }}
      />
      <BulkCancelDialog
        open={active && bulkConfirm === 'cancel'}
        busy={bulkBusy === 'cancel'}
        onConfirm={(selections, deleteFiles) => void handleBulkDownloads('cancel', selections, deleteFiles)}
        onClose={() => { if (!bulkBusy) setBulkConfirm(null) }}
      />
    </section>
  )
}
