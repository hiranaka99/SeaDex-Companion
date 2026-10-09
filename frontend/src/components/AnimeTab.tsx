import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ResultItem, Config, Status, GroupedCard } from '../types'
import { groupResults, seasonLabel, cardSizeDelta, hasCardUpgrade } from '../utils'
import Card from './Card'
import BulkDownloadDialog, { BulkOutcome } from './BulkDownloadDialog'
import BulkCancelDialog from './BulkCancelDialog'
import Icon, { IconName } from './Icons'
import { useToast } from './Toast'
import * as api from '../api'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import { BulkOperationState } from './OperationCenter'
import LibrarySizeChange from './LibrarySizeChange'
import BulkScopeSelector, { BulkScope } from './BulkScopeSelector'

interface Props {
  active: boolean
  openResultKey: string | null
  onResultOpened: () => void
  bulkOperationActive?: boolean
  bulkReviewRequest: number
  onBulkReviewReset: () => void
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

function SkeletonCards() {
  return <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]" aria-label="Loading library">
    {Array.from({ length: 6 }, (_, index) => <div key={index} className="overflow-hidden rounded-card border border-line bg-panel"><div className="library-card-body"><div className="library-card-poster skeleton"/><div className="library-card-info"><div className="flex flex-col gap-3 p-3"><div className="skeleton h-5 w-full rounded-md"/><div className="skeleton h-5 w-2/3 rounded-md"/><div className="skeleton h-4 w-24 rounded-md"/></div></div></div><div className="flex gap-1.5 px-3.5 pb-3.5"><div className="skeleton h-8 w-11 rounded-md"/><div className="skeleton h-8 w-11 rounded-md"/></div><div className="border-t border-line p-3"><div className="skeleton h-9 rounded-lg"/></div></div>)}
  </div>
}

export default function AnimeTab({ active, openResultKey, onResultOpened, bulkOperationActive = false, bulkReviewRequest, onBulkReviewReset, results, config, status, lastRun, onScan, loading, loadError, onReloadResults, onOpenConfig, onBulkOperationChange, operationsVisible, onResultsChanged }: Props) {
  const [search, setSearch] = useState('')
  const [arr, setArr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [coverageFilter, setCoverageFilter] = useState('')
  const [sort, setSort] = useState('recommended')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [page, setPage] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const moreActionsRef = useRef<HTMLDetailsElement>(null)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const hiddenKeysRef = useRef(hiddenKeys)
  const hiddenRequests = useRef(new Map<string, Promise<unknown>>())
  const [bulkConfirm, setBulkConfirm] = useState<'start' | 'cancel' | null>(null)
  const [bulkBusy, setBulkBusy] = useState<'start' | 'cancel' | null>(null)
  const bulkInFlight = useRef(false)
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null)
  const [bulkScope, setBulkScope] = useState<BulkScope>('filtered')
  const [bulkReview, setBulkReview] = useState<{ filtered: ResultItem[]; all: ResultItem[]; description: string } | null>(null)
  const reviewResults = useMemo(() => bulkReview ? bulkScope === 'filtered' ? bulkReview.filtered : bulkReview.all : [], [bulkReview, bulkScope])
  const reviewKeys = useMemo(() => new Set(reviewResults.map(result => result.key)), [reviewResults])
  const toast = useToast()

  useEffect(() => { if (!openResultKey) setPage(0) }, [search, arr, statusFilter, coverageFilter, sort, showHidden])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const menu = moreActionsRef.current
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  useEffect(() => { if (!active) setBulkConfirm(null) }, [active])
  useEffect(() => { if (bulkReviewRequest) setBulkConfirm('start') }, [bulkReviewRequest])
  useEffect(() => {
    if (!openResultKey) return
    const group = groupResults(results).find(group => group.seasons.some(season => season.key === openResultKey))
    if (group) { setSearch(''); setArr(''); setStatusFilter(''); setCoverageFilter(''); setShowHidden(hiddenKeys.has(cardKey(group))) }
    else { toast.show('This title is no longer in the current library', 'info'); onResultOpened() }
  }, [openResultKey])

  useEffect(() => {
    if (config?.hidden) { hiddenKeysRef.current = new Set(config.hidden); setHiddenKeys(hiddenKeysRef.current) }
  }, [config?.hidden])

  const allGroups = useMemo(() => groupResults(results), [results])
  const scopeGroups = useMemo(() => allGroups.filter(group => {
    if (hiddenKeys.has(cardKey(group)) !== showHidden || (arr && group.arr !== arr)) return false
    const haystack = `${group.title} ${group.seasons.map(season => `${season.title} ${season.best_group || ''} ${season.have.join(' ')} ${seasonLabel(season)}`).join(' ')}`
    return haystack.toLowerCase().includes(search.trim().toLowerCase())
  }), [allGroups, hiddenKeys, showHidden, arr, search])
  const coverageGroups = useMemo(() => scopeGroups.filter(group => !coverageFilter || group.status === coverageFilter), [scopeGroups, coverageFilter])
  const counts = useMemo(() => ({
    upgrade: coverageGroups.filter(hasCardUpgrade).length,
    review: coverageGroups.filter(group => group.status === 'review').length,
    episodes: coverageGroups.filter(group => group.seasons.some(season => (season.missing_episode_count || 0) > 0)).length,
  }), [coverageGroups])

  const setCardHidden = async (key: string, hidden: boolean, offerUndo = false): Promise<boolean> => {
    const wasHidden = hiddenKeysRef.current.has(key)
    const update = (value: boolean) => {
      const next = new Set(hiddenKeysRef.current)
      if (value) next.add(key); else next.delete(key)
      hiddenKeysRef.current = next
      setHiddenKeys(next)
    }
    update(hidden)
    // Serialize writes for each card so a quick Undo cannot finish out of order.
    const request = (hiddenRequests.current.get(key) || Promise.resolve()).catch(() => {}).then(() => api.setHidden(key, hidden))
    hiddenRequests.current.set(key, request)
    try {
      await request
      if (hiddenRequests.current.get(key) !== request) return false
      const title = allGroups.find(group => cardKey(group) === key)?.title || 'Title'
      toast.show(hidden ? `${title} hidden from the library` : `${title} restored to the library`, 'success', offerUndo ? 12000 : undefined, offerUndo ? {
        label: 'Undo',
        onClick: () => { void setCardHidden(key, wasHidden).then(restored => { if (restored) window.requestAnimationFrame(() => {
          const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(button => button.getAttribute('aria-label') === `Details for ${title}`)
          button?.scrollIntoView({ block: 'nearest' }); button?.focus({ preventScroll: true })
        }) }) },
      } : undefined)
      return true
    } catch (error: any) {
      if (hiddenRequests.current.get(key) === request) update(wasHidden)
      toast.show('Could not update hidden cards: ' + error.message, 'error')
      return false
    } finally {
      if (hiddenRequests.current.get(key) === request) hiddenRequests.current.delete(key)
    }
  }
  const toggleHidden = (key: string) => setCardHidden(key, !hiddenKeysRef.current.has(key), true)

  const groups = useMemo(() => {
    const filtered = coverageGroups.filter(group => statusFilter === 'episodes'
      ? group.seasons.some(season => (season.missing_episode_count || 0) > 0)
      : statusFilter === 'upgrade' ? hasCardUpgrade(group) : !statusFilter || group.status === statusFilter)
    const rank: Record<string, number> = { review: 0, upgrade: 1, partial: 2, missing: 3, best: 4 }
    filtered.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      if (sort === 'size') return Math.abs(cardSizeDelta(b)) - Math.abs(cardSizeDelta(a)) || a.title.localeCompare(b.title)
      return rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    })
    return filtered
  }, [coverageGroups, statusFilter, sort])

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


  const totalDelta = groups.reduce((sum, group) => sum + cardSizeDelta(group), 0)
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
  const clearFilters = () => { setSearch(''); setArr(''); setStatusFilter(''); setCoverageFilter(''); setSort('recommended'); setShowHidden(false) }
  const coverageFilters = [
    { value: '', label: 'All coverage states' },
    { value: 'partial', label: 'Partially on SeaDex' },
    { value: 'missing', label: 'Not on SeaDex' },
    { value: 'best', label: 'Best quality' },
  ]
  const statusFilters: { value: string; label: string; count: number; tone: string; icon: IconName }[] = [
    { value: '', label: 'All', count: coverageGroups.length, tone: 'text-ink', icon: 'library' },
    { value: 'upgrade', label: 'Upgradable', count: counts.upgrade, tone: 'text-accent-bright', icon: 'arrow-up' },
    { value: 'review', label: 'Match needs review', count: counts.review, tone: 'text-warn', icon: 'search' },
    { value: 'episodes', label: 'Episodes missing', count: counts.episodes, tone: 'text-warn', icon: 'alert' },
  ]
  const activeOptions = [arr, coverageFilter ? coverageFilters.find(filter => filter.value === coverageFilter)?.label : '', showHidden ? 'Hidden only' : '', sort === 'title' ? 'Title A–Z' : sort === 'size' ? 'Largest size change' : ''].filter(Boolean)
  const activeFilters = [search.trim() ? `Search: ${search.trim()}` : '', ...activeOptions, statusFilter ? statusFilters.find(filter => filter.value === statusFilter)?.label : ''].filter(Boolean)
  const openBulkReview = (action: 'start' | 'cancel') => {
    onBulkReviewReset()
    setBulkScope('filtered')
    setBulkReview({ filtered: groups.flatMap(group => group.seasons), all: [...results], description: activeFilters.join(' · ') || 'Current library results' })
    setBulkOutcome(null)
    setBulkConfirm(action)
  }
  const scopeControl = <BulkScopeSelector value={bulkScope} onChange={setBulkScope} filteredCount={bulkReview ? groupResults(bulkReview.filtered).length : 0} allCount={bulkReview ? groupResults(bulkReview.all).length : 0} description={bulkReview?.description || 'Current library results'} allLabel={bulkConfirm === 'cancel' ? 'All tracked downloads' : undefined} allDescription={bulkConfirm === 'cancel' ? 'All incomplete downloads tracked by SeaDex Companion, regardless of library filters.' : undefined} disabled={bulkBusy !== null || Boolean(bulkOutcome)}/>

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
    const item = (bulkReview?.all || results).find((entry) => entry.key === selection.key)
    return (item?.releases?.[selection.release]?.info_hashes || []).map((hash: string) => String(hash).toLowerCase())
  }

  const handleBulkDownloads = async (action: 'start' | 'cancel', selections: api.BulkDownloadTarget[] = [], deleteFiles = false) => {
    if (bulkInFlight.current || bulkOperationActive) return
    bulkInFlight.current = true
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
          failures,
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
      bulkInFlight.current = false
      polling = false
      if (pollId !== null) window.clearInterval(pollId)
      setBulkBusy(null)
    }
  }

  return (
    <section>
      <header className="app-page-header mb-5 flex flex-wrap items-start justify-between gap-4 max-[600px]:mb-4 max-[600px]:gap-3">
        <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Anime library</h1><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted max-[600px]:hidden"><span className="inline-flex items-center gap-1.5"><Icon name="clock" size={15}/>{lastRun ? `Last scan ${lastRun}` : 'No completed scan'}</span>{autoCheckLabel !== null && <span title={scheduleDescription || undefined}>{scheduleDescription} · next in ~{autoCheckLabel}</span>}{status.webhook_scan.queued && <span className="text-accent-bright">Webhook scan queued</span>}</div></div>
        <div className="library-actions flex flex-wrap items-center gap-2 max-[600px]:w-full">
          <button type="button" className={cx(buttonBase, 'library-scan-button justify-center wrap-anywhere max-[600px]:text-xs')} onClick={onScan} disabled={!libraryConfigured || status.running || bulkBusy !== null || bulkOperationActive}>{status.running ? <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/> : <Icon name="play" size={17}/>}<span>{status.running ? 'Scanning…' : 'Scan library'}</span></button>
          <button type="button" className={cx(buttonBase, 'library-bulk-button justify-center wrap-anywhere border-line bg-panel text-ink hover:bg-panel-raised max-[600px]:text-xs')} onClick={() => openBulkReview('start')} disabled={status.running || bulkBusy !== null || bulkOperationActive || upgradeSeasonCount === 0}><Icon name="download" size={17}/><span>Bulk download</span></button>
          <details ref={moreActionsRef} className="library-more-actions relative shrink-0" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); event.stopPropagation() } }}><summary className="touch-target grid size-11 cursor-pointer list-none place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink"><Icon name="more" size={18}/><span className="sr-only">More library actions</span></summary><div className="absolute top-full right-0 z-30 mt-2 min-w-44 rounded-control bg-panel-raised p-2 shadow-card"><button type="button" className="touch-target inline-flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-bad hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-50" onClick={event => { openBulkReview('cancel'); event.currentTarget.closest('details')?.removeAttribute('open') }} disabled={status.running || bulkBusy !== null || bulkOperationActive}><Icon name="trash" size={17}/>Bulk cancel</button></div></details>
        </div>
      </header>

      {loadError && <div className="mb-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="shrink-0"/><span className="min-w-0 flex-1">Could not load scanned results: {loadError}</span><button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={onReloadResults}><Icon name="refresh" size={15}/>Retry</button><button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onOpenConfig}>Open Config</button></div>}


      <div className={cx('library-toolbar library-toolbar-refined z-20 mb-5 max-[600px]:mb-3 rounded-2xl border border-line', operationsVisible ? 'relative' : 'sticky top-0')}>
        <div className="toolbar-controls flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-0 flex-1 max-[600px]:basis-full"><span className="sr-only">Search anime</span><Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-dim"/><input type="search" className={cx(control, 'w-full pl-10')} placeholder="Search titles and release groups" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
          <select aria-label="Filter by status" className={cx(control, 'hidden min-w-0 flex-1 max-[600px]:block')} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>{statusFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label} ({filter.count})</option>)}</select>
          <button type="button" className={cx(buttonBase, 'justify-center border-line bg-panel px-3 text-xs text-ink min-[601px]:hidden')} aria-expanded={optionsOpen} aria-controls="library-options" onClick={() => setOptionsOpen(value => !value)}><Icon name="filter" size={16}/><span>Filters & sort{activeOptions.length > 0 && ` (${activeOptions.length})`}</span></button>
          <div id="library-options" className={cx('w-full min-w-0 flex-wrap items-center gap-2.5 [&>select]:min-w-0 [&>select]:max-w-full min-[601px]:contents', optionsOpen ? 'flex' : 'hidden')}>
          {autoCheckLabel !== null && <p className="m-0 w-full text-xs text-muted min-[601px]:hidden">{scheduleDescription} · next in ~{autoCheckLabel}</p>}
          <select aria-label="Source" className={cx(control, 'cursor-pointer')} value={arr} onChange={(event) => setArr(event.target.value)}><option value="">All sources</option><option value="Sonarr">Sonarr</option><option value="Radarr">Radarr</option></select>
          <select aria-label="Coverage status" className={cx(control, 'cursor-pointer')} value={coverageFilter} onChange={event => setCoverageFilter(event.target.value)}>{coverageFilters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select>
          <select aria-label="Sort library" className={cx(control, 'cursor-pointer')} value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">Recommended order</option><option value="title">Title A–Z</option><option value="size">Largest size change</option></select>
          <button type="button" className={cx('touch-target inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors', showHidden ? 'bg-warn/10 text-warn' : 'text-muted hover:bg-panel hover:text-ink')} aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}><Icon name="eye-off" size={17}/>{showHidden ? 'Hidden only' : 'Show hidden only'}</button>
          </div>
        </div>
        <div className="mt-3 hidden flex-wrap min-[601px]:flex items-center gap-1" role="group" aria-label="Filter by status">
          {statusFilters.map((filter) => <button key={filter.value} type="button" className={cx('toolbar-status-filter touch-target inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors', statusFilter === filter.value ? 'bg-accent/14 text-ink' : 'text-muted hover:bg-panel hover:text-ink')} aria-pressed={statusFilter === filter.value} onClick={() => setStatusFilter(filter.value)}><Icon name={filter.icon} size={15} className={cx('shrink-0', filter.tone)}/><span>{filter.label}</span><span className="toolbar-status-count text-xs tabular-nums text-muted">{filter.count}</span></button>)}
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-dim"><span>{groups.length} shown</span>{totalDelta !== 0 && <LibrarySizeChange delta={totalDelta}/>}</div>
        </div>
        {statusFilter === 'upgrade' && <p className="mt-2 mb-0 text-xs text-muted">Includes partially covered titles with available upgrades.</p>}
        <div className="mt-2 hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted max-[600px]:flex"><span>{groups.length} shown</span><span className="library-scan-freshness">{lastRun ? `Last scan ${lastRun}` : 'No completed scan'}</span>{totalDelta !== 0 && <LibrarySizeChange delta={totalDelta}/>}</div>
        <p className="sr-only" role="status" aria-atomic="true">{groups.length} matching titles{activeFilters.length ? ` · ${activeFilters.join(' · ')}` : ''}</p>
        {activeFilters.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs text-muted" aria-label="Active library filters"><span className="min-w-0 flex-1 wrap-anywhere">{activeFilters.join(' · ')}</span><button type="button" className="touch-target cursor-pointer rounded-md px-2 py-1 font-semibold text-accent-bright hover:underline" onClick={clearFilters}>Clear filters</button></div>}
      </div>


      {(loading || (status.running && results.length === 0)) && <SkeletonCards/>}
      {!loading && results.length > 0 && groups.length > 0 && <div ref={resultsRef} className="library-results" tabIndex={-1} role="region" aria-label="Library results">
        {pageCount > 1 && <nav className="mb-4 flex flex-wrap items-center justify-between gap-2 max-[600px]:justify-end" aria-label="Library pages"><span className="text-xs text-muted max-[600px]:hidden" role="status">{(currentPage * PAGE_SIZE + 1).toLocaleString()}–{Math.min((currentPage + 1) * PAGE_SIZE, groups.length).toLocaleString()} of {groups.length.toLocaleString()} titles</span><div className="flex flex-wrap items-center gap-2"><button type="button" className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}><Icon name="chevron-left" size={15}/><span className="max-[600px]:sr-only">Previous</span></button><select className={cx(control, 'text-xs')} aria-label="Library page" value={currentPage} onChange={event => changePage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Page {index + 1} of {pageCount}</option>)}</select><button type="button" className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')} disabled={currentPage >= pageCount - 1} onClick={() => changePage(currentPage + 1)}><span className="max-[600px]:sr-only">Next</span><Icon name="chevron-right" size={15}/></button></div></nav>}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]">{visibleGroups.map((group, index) => <Card key={cardKey(group)} active={active} openRequested={group.seasons.some(season => season.key === openResultKey)} onOpened={onResultOpened} group={group} index={index} config={config} hidden={hiddenKeys.has(cardKey(group))} onToggle={() => void toggleHidden(cardKey(group))} onRulesChanged={onResultsChanged} onRescan={onScan}/>)}</div>
      </div>}
      {!loading && !loadError && results.length === 0 && !status.running && <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center"><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent-bright"><Icon name="library" size={26}/></span><h2 className="mb-2 text-lg font-bold">{libraryConfigured ? 'Your library is ready to be scanned' : 'Connect your library first'}</h2><p className="mx-auto mb-5 max-w-md text-sm text-muted">{libraryConfigured ? 'Compare your Sonarr and Radarr collection with the best releases available on SeaDex.' : 'Configure Sonarr or Radarr before running your first scan.'}</p><div className="flex flex-wrap justify-center gap-2"><button type="button" className={libraryConfigured ? buttonPrimary : cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onScan} disabled={!libraryConfigured}><Icon name="play" size={17}/>Scan library</button><button type="button" className={libraryConfigured ? cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink') : buttonPrimary} onClick={onOpenConfig}><Icon name="settings" size={17}/>Open Config</button></div></div>}
      {!loading && results.length > 0 && groups.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong py-14 text-center"><Icon name="filter" size={26} className="mx-auto mb-3 text-muted-dim"/><h2 className="mb-1 text-lg font-bold">No matching titles</h2><p className="mb-4 text-sm text-muted">Try changing or clearing the active filters.</p><button type="button" className="cursor-pointer text-sm font-bold text-accent-bright" onClick={clearFilters}>Clear filters</button></div>}
      <BulkDownloadDialog
        open={active && bulkConfirm === 'start'}
        results={reviewResults}
        scopeControl={scopeControl}
        hiddenKeys={hiddenKeys}
        busy={bulkBusy === 'start'}
        outcome={bulkOutcome}
        onConfirm={(selections) => void handleBulkDownloads('start', selections)}
        onClose={() => setBulkConfirm(null)}
      />
      <BulkCancelDialog
        open={active && bulkConfirm === 'cancel'}
        busy={bulkBusy === 'cancel'}
        scopeControl={scopeControl}
        resultKeys={bulkScope === 'filtered' ? reviewKeys : undefined}
        onConfirm={(selections, deleteFiles) => void handleBulkDownloads('cancel', selections, deleteFiles)}
        onClose={() => { if (!bulkBusy) setBulkConfirm(null) }}
      />
    </section>
  )
}
