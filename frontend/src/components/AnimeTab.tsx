import { useEffect, useMemo, useState } from 'react'
import { ResultItem, Config, Status, GroupedCard } from '../types'
import { groupResults, formatBytes, seasonLabel } from '../utils'
import Card from './Card'
import BulkDownloadDialog, { BulkOutcome } from './BulkDownloadDialog'
import BulkCancelDialog from './BulkCancelDialog'
import Icon, { IconName } from './Icons'
import { useToast } from './Toast'
import * as api from '../api'
import { buttonBase, buttonPrimary, control, cx } from '../styles'

interface Props {
  results: ResultItem[]
  config: Config | null
  status: Status
  lastRun: string | null
  onScan: () => void
  loading: boolean
}

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

export default function AnimeTab({ results, config, status, lastRun, onScan, loading }: Props) {
  const [search, setSearch] = useState('')
  const [arr, setArr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState('recommended')
  const [showHidden, setShowHidden] = useState(false)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm] = useState<'start' | 'cancel' | null>(null)
  const [bulkBusy, setBulkBusy] = useState<'start' | 'cancel' | null>(null)
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null)
  const toast = useToast()

  useEffect(() => {
    if (config?.hidden) setHiddenKeys(new Set(config.hidden))
  }, [config?.hidden])

  const allGroups = useMemo(() => groupResults(results), [results])
  const counts = useMemo(() => ({
    upgrade: allGroups.filter((group) => group.status === 'upgrade').length,
    partial: allGroups.filter((group) => group.status === 'partial').length,
    missing: allGroups.filter((group) => group.status === 'missing').length,
    best: allGroups.filter((group) => group.status === 'best').length,
  }), [allGroups])

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
    const query = search.trim().toLowerCase()
    const filtered = allGroups.filter((group) => {
      if (hiddenKeys.has(cardKey(group)) !== showHidden) return false
      if (arr && group.arr !== arr) return false
      if (statusFilter && group.status !== statusFilter) return false
      if (!query) return true
      const haystack = group.seasons.map((season) => `${season.title} ${season.best_group || ''} ${season.have.join(' ')} ${seasonLabel(season)}`).join(' ')
      return `${group.title} ${haystack}`.toLowerCase().includes(query)
    })
    const rank: Record<string, number> = { upgrade: 0, partial: 1, missing: 2, best: 3 }
    filtered.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      if (sort === 'size') return Math.abs(cardDelta(b)) - Math.abs(cardDelta(a)) || a.title.localeCompare(b.title)
      return rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    })
    return filtered
  }, [allGroups, search, arr, statusFilter, sort, showHidden, hiddenKeys])

  const totalDelta = groups.reduce((sum, group) => sum + cardDelta(group), 0)
  const upgradeSeasonCount = useMemo(() => new Set(
    results
      .filter((result) => result.status === 'upgrade' || (result.status === 'partial' && result.upgrade_available))
      .map((result) => result.key),
  ).size, [results])
  const progress = status.total ? Math.round((status.progress / status.total) * 100) : 0
  const autoCheckMinutes = status.next_check ? Math.max(0, Math.round((status.next_check - Date.now() / 1000) / 60)) : null
  const autoCheckLabel = autoCheckMinutes == null ? null : (() => { const hours = Math.floor(autoCheckMinutes / 60); const minutes = autoCheckMinutes % 60; return hours > 0 ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`) : `${minutes} min` })()
  const clearFilters = () => { setSearch(''); setArr(''); setStatusFilter(''); setSort('recommended'); setShowHidden(false) }
  const statusFilters: { value: string; label: string; count: number; tone: string; icon: IconName }[] = [
    { value: '', label: 'All', count: allGroups.length, tone: 'text-ink', icon: 'library' },
    { value: 'upgrade', label: 'Upgradable', count: counts.upgrade, tone: 'text-accent-bright', icon: 'sparkles' },
    { value: 'partial', label: 'Partial', count: counts.partial, tone: 'text-warn', icon: 'alert' },
    { value: 'missing', label: 'Missing', count: counts.missing, tone: 'text-warn', icon: 'alert' },
    { value: 'best', label: 'Best quality', count: counts.best, tone: 'text-good', icon: 'check' },
  ]

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
    try {
      if (action === 'start') {
        const allHashes = new Set<string>()
        for (const selection of selections) for (const hash of hashesForSelection(selection)) allHashes.add(hash)
        // The request settles each torrent one at a time (metadata is fetched
        // with a 15 second budget per torrent), so poll the live batch status
        // while it is in flight and color each title as soon as its own
        // torrent settles instead of only after the whole batch finished.
        setBulkOutcome({ requested: new Set(), failed: new Set(), pending: new Set(allHashes), inflight: true })
        const request = api.bulkDownloads('start', selections)
        pollId = window.setInterval(() => {
          void api.getBulkDownloadStatus().then((status) => {
            setBulkOutcome((current) => current ? {
              requested: new Set(status.added.map((hash) => hash.toLowerCase())),
              failed: new Set(status.failures.map((failure) => failure.hash.toLowerCase())),
              pending: new Set(status.pending.map((hash) => hash.toLowerCase())),
              inflight: true,
            } : current)
          }).catch(() => { /* transient poll failure — keep polling */ })
        }, 700)
        const result = await request
        let status: api.BulkDownloadStatus | null = null
        try { status = await api.getBulkDownloadStatus() } catch { /* fall back to the request result */ }
        const failures = status && status.failures.length ? status.failures : (result.failures || [])
        if (result.count > 0) {
          toast.show(`Sent ${result.count} torrent${result.count === 1 ? '' : 's'} to qBittorrent`, 'success')
        } else if (!failures.length) {
          toast.show('No downloadable upgrades found', 'info')
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
      } else {
        const result = await api.bulkDownloads(action, selections, deleteFiles)
        toast.show(result.count
          ? `Cancelled ${result.count} download${result.count === 1 ? '' : 's'}; ${deleteFiles ? 'downloaded files were deleted' : 'files were kept'}`
          : 'No active bulk downloads found', result.count ? 'success' : 'info')
        setBulkConfirm(null)
      }
    } catch (error: any) {
      toast.show(`Bulk ${action === 'start' ? 'download' : 'cancel'} failed: ${error.message}`, 'error')
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
      if (pollId !== null) window.clearInterval(pollId)
      setBulkBusy(null)
    }
  }

  return (
    <section>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-5">
        <div><p className="mb-1 text-xs font-bold tracking-[0.14em] text-accent-bright uppercase">Overview</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Anime library</h1><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="clock" size={15}/>{lastRun ? `Last scan ${lastRun}` : 'No completed scan'}</span>{autoCheckLabel !== null && <span>Next check in ~{autoCheckLabel}</span>}</div></div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" className={cx(buttonBase, 'border-good/35 bg-good/10 text-good hover:bg-good/18')} onClick={() => { setBulkOutcome(null); setBulkConfirm('start') }} disabled={status.running || bulkBusy !== null || upgradeSeasonCount === 0}>{bulkBusy === 'start' ? <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good"/> : <Icon name="download" size={17}/>}<span>Bulk download</span></button>
          <button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={() => setBulkConfirm('cancel')} disabled={status.running || bulkBusy !== null}>{bulkBusy === 'cancel' ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={17}/>}<span>Bulk cancel</span></button>
          <span className="mx-1 h-9 w-px shrink-0 bg-line-strong" aria-hidden="true" />
          <button className={buttonPrimary} onClick={onScan} disabled={status.running || bulkBusy !== null}>{status.running ? <span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"/> : <Icon name="play" size={17}/>}<span>{status.running ? 'Scanning library…' : 'Scan library'}</span></button>
        </div>
      </header>

      {status.running && <div className="mb-5 rounded-xl border border-accent/25 bg-accent/6 p-4" aria-live="polite"><div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="truncate font-semibold text-accent-bright">{status.message || 'Scanning…'}</span><span className="shrink-0 tabular-nums text-muted">{status.total ? `${status.progress}/${status.total}` : ''} · {progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }}/></div></div>}
      {status.error && !status.running && <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="mt-0.5 shrink-0"/>{status.error}</div>}

      <div className="sticky top-0 z-20 mb-5 rounded-2xl border border-line bg-canvas/92 p-3 shadow-[0_12px_28px_rgba(0,0,0,.22)] backdrop-blur-xl max-[900px]:top-16">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-[220px] flex-1"><span className="sr-only">Search anime</span><Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-dim"/><input type="search" className={cx(control, 'w-full pl-10')} placeholder="Search titles and release groups" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
          <select aria-label="Source" className={cx(control, 'cursor-pointer')} value={arr} onChange={(event) => setArr(event.target.value)}><option value="">All sources</option><option value="Sonarr">Sonarr</option><option value="Radarr">Radarr</option></select>
          <select aria-label="Sort library" className={cx(control, 'cursor-pointer')} value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">Recommended order</option><option value="title">Title A–Z</option><option value="size">Largest size change</option></select>
          <button type="button" className={cx('inline-flex cursor-pointer items-center gap-2 rounded-control border px-3.5 py-2.5 text-sm font-semibold transition-colors', showHidden ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line bg-panel text-muted hover:text-ink')} onClick={() => setShowHidden((value) => !value)}><Icon name={showHidden ? 'eye-off' : 'eye'} size={17}/>{showHidden ? 'Hidden only' : 'Hidden'}</button>
        </div>
        <div className="mt-3 flex items-center gap-1 overflow-x-auto pb-0.5" aria-label="Filter by status">
          {statusFilters.map((filter) => <button key={filter.value} type="button" className={cx('inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors', statusFilter === filter.value ? 'bg-accent/14 text-accent-bright' : 'text-muted hover:bg-panel hover:text-ink')} onClick={() => setStatusFilter(filter.value)}><Icon name={filter.icon} size={15} className={cx('shrink-0', filter.tone)}/><span>{filter.label}</span><span className={cx('text-[10px] tabular-nums', filter.tone)}>{filter.count}</span></button>)}
          <span className="ml-auto shrink-0 px-2 text-xs text-muted-dim">{groups.length} shown{totalDelta !== 0 && ` · ${(totalDelta > 0 ? '+' : '') + formatBytes(totalDelta)}`}</span>
        </div>
      </div>

      {(loading || (status.running && results.length === 0)) && <SkeletonCards/>}
      {!loading && results.length > 0 && groups.length > 0 && <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]">{groups.map((group, index) => <Card key={cardKey(group)} group={group} index={index} config={config} hidden={hiddenKeys.has(cardKey(group))} onToggle={() => void toggleHidden(cardKey(group))}/>)}</div>}
      {!loading && results.length === 0 && !status.running && <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center"><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent-bright"><Icon name="library" size={26}/></span><h2 className="mb-2 text-lg font-bold">Your library is ready to be scanned</h2><p className="mx-auto mb-5 max-w-md text-sm text-muted">Compare your Sonarr and Radarr collection with the best releases available on SeaDex.</p><button type="button" className={buttonPrimary} onClick={onScan}><Icon name="play" size={17}/>Scan library</button></div>}
      {!loading && results.length > 0 && groups.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong py-14 text-center"><Icon name="filter" size={26} className="mx-auto mb-3 text-muted-dim"/><h2 className="mb-1 text-lg font-bold">No matching titles</h2><p className="mb-4 text-sm text-muted">Try changing or clearing the active filters.</p><button type="button" className="cursor-pointer text-sm font-bold text-accent-bright" onClick={clearFilters}>Clear filters</button></div>}
      <BulkDownloadDialog
        open={bulkConfirm === 'start'}
        results={results}
        hiddenKeys={hiddenKeys}
        busy={bulkBusy === 'start'}
        outcome={bulkConfirm === 'start' ? bulkOutcome : null}
        onConfirm={(selections) => void handleBulkDownloads('start', selections)}
        onClose={() => { if (!bulkBusy) { setBulkConfirm(null); setBulkOutcome(null) } }}
      />
      <BulkCancelDialog
        open={bulkConfirm === 'cancel'}
        busy={bulkBusy === 'cancel'}
        onConfirm={(selections, deleteFiles) => void handleBulkDownloads('cancel', selections, deleteFiles)}
        onClose={() => { if (!bulkBusy) setBulkConfirm(null) }}
      />
    </section>
  )
}
