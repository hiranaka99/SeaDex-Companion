import { useEffect, useMemo, useState } from 'react'
import { ResultItem, Config, Status, GroupedCard } from '../types'
import { groupResults, formatBytes, seasonLabel } from '../utils'
import Card from './Card'
import Icon from './Icons'
import { useToast } from './Toast'
import * as api from '../api'
import { buttonPrimary, control, cx } from '../styles'

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
  return group.seasons.reduce((total, season) => total + ((season.status || 'upgrade') === 'upgrade' ? (season.best_size || 0) - (season.local_size || 0) : 0), 0)
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
  const progress = status.total ? Math.round((status.progress / status.total) * 100) : 0
  const autoCheck = status.next_check ? Math.max(0, Math.round((status.next_check - Date.now() / 1000) / 60)) : null
  const activeFilterCount = Number(Boolean(search)) + Number(Boolean(arr)) + Number(Boolean(statusFilter)) + Number(showHidden) + Number(sort !== 'recommended')
  const clearFilters = () => { setSearch(''); setArr(''); setStatusFilter(''); setSort('recommended'); setShowHidden(false) }
  const metrics = [
    { label: 'Total titles', value: allGroups.length, tone: 'text-ink', icon: 'library' as const },
    { label: 'Upgrades', value: counts.upgrade, tone: 'text-accent-bright', icon: 'sparkles' as const },
    { label: 'Partial / missing', value: counts.partial + counts.missing, tone: 'text-warn', icon: 'alert' as const },
    { label: 'Already best', value: counts.best, tone: 'text-good', icon: 'check' as const },
  ]

  return (
    <section>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-5">
        <div><p className="mb-1 text-xs font-bold tracking-[0.14em] text-accent-bright uppercase">Overview</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Anime library</h1><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="clock" size={15}/>{lastRun ? `Last scan ${lastRun}` : 'No completed scan'}</span>{autoCheck !== null && <span>Next check in ~{autoCheck} min</span>}</div></div>
        <button className={buttonPrimary} onClick={onScan} disabled={status.running}>{status.running ? <span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"/> : <Icon name="play" size={17}/>}<span>{status.running ? 'Scanning library…' : 'Scan library'}</span></button>
      </header>

      <div className="mb-5 grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2 max-[520px]:grid-cols-1">
        {metrics.map((metric) => <div key={metric.label} className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2"><span className={cx('grid size-8 shrink-0 place-items-center rounded-lg bg-canvas-soft', metric.tone)}><Icon name={metric.icon} size={17}/></span><span className={cx('text-lg font-extrabold tabular-nums', metric.tone)}>{metric.value}</span><span className="truncate text-xs font-medium text-muted">{metric.label}</span></div>)}
      </div>

      {status.running && <div className="mb-5 rounded-xl border border-accent/25 bg-accent/6 p-4" aria-live="polite"><div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="truncate font-semibold text-accent-bright">{status.message || 'Scanning…'}</span><span className="shrink-0 tabular-nums text-muted">{status.total ? `${status.progress}/${status.total}` : ''} · {progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }}/></div></div>}
      {status.error && !status.running && <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="mt-0.5 shrink-0"/>{status.error}</div>}

      <div className="sticky top-0 z-20 mb-5 rounded-2xl border border-line bg-canvas/92 p-3 shadow-[0_12px_28px_rgba(0,0,0,.22)] backdrop-blur-xl max-[900px]:top-16">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-[220px] flex-1"><span className="sr-only">Search anime</span><Icon name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-dim"/><input type="search" className={cx(control, 'w-full pl-10')} placeholder="Search titles and release groups" value={search} onChange={(event) => setSearch(event.target.value)}/></label>
          <select aria-label="Source" className={cx(control, 'cursor-pointer')} value={arr} onChange={(event) => setArr(event.target.value)}><option value="">All sources</option><option value="Sonarr">Sonarr</option><option value="Radarr">Radarr</option></select>
          <select aria-label="Sort library" className={cx(control, 'cursor-pointer')} value={sort} onChange={(event) => setSort(event.target.value)}><option value="recommended">Recommended order</option><option value="title">Title A–Z</option><option value="size">Largest size change</option></select>
          <button type="button" className={cx('inline-flex cursor-pointer items-center gap-2 rounded-control border px-3.5 py-2.5 text-sm font-semibold transition-colors', showHidden ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line bg-panel text-muted hover:text-ink')} onClick={() => setShowHidden((value) => !value)}><Icon name={showHidden ? 'eye-off' : 'eye'} size={17}/>{showHidden ? 'Hidden only' : 'Hidden'}</button>
          {activeFilterCount > 0 && <button type="button" className="cursor-pointer px-2 text-xs font-semibold text-accent-bright hover:text-ink" onClick={clearFilters}>Clear {activeFilterCount}</button>}
        </div>
        <div className="mt-3 flex items-center gap-1 overflow-x-auto pb-0.5" aria-label="Filter by status">
          {[['', 'All', allGroups.length], ['upgrade', 'Upgradable', counts.upgrade], ['partial', 'Partial', counts.partial], ['missing', 'Missing', counts.missing], ['best', 'Best quality', counts.best]].map(([value, label, count]) => <button key={String(value)} type="button" className={cx('shrink-0 cursor-pointer rounded-lg px-3 py-2 text-xs font-bold transition-colors', statusFilter === value ? 'bg-accent/14 text-accent-bright' : 'text-muted hover:bg-panel hover:text-ink')} onClick={() => setStatusFilter(String(value))}>{label}<span className="ml-1.5 text-[10px] opacity-65">{count}</span></button>)}
          <span className="ml-auto shrink-0 px-2 text-xs text-muted-dim">{groups.length} shown{totalDelta !== 0 && ` · ${(totalDelta > 0 ? '+' : '') + formatBytes(totalDelta)}`}</span>
        </div>
      </div>

      {(loading || (status.running && results.length === 0)) && <SkeletonCards/>}
      {!loading && results.length > 0 && groups.length > 0 && <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]">{groups.map((group, index) => <Card key={cardKey(group)} group={group} index={index} config={config} hidden={hiddenKeys.has(cardKey(group))} onToggle={() => void toggleHidden(cardKey(group))}/>)}</div>}
      {!loading && results.length === 0 && !status.running && <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center"><span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent-bright"><Icon name="library" size={26}/></span><h2 className="mb-2 text-lg font-bold">Your library is ready to be scanned</h2><p className="mx-auto mb-5 max-w-md text-sm text-muted">Compare your Sonarr and Radarr collection with the best releases available on SeaDex.</p><button type="button" className={buttonPrimary} onClick={onScan}><Icon name="play" size={17}/>Scan library</button></div>}
      {!loading && results.length > 0 && groups.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong py-14 text-center"><Icon name="filter" size={26} className="mx-auto mb-3 text-muted-dim"/><h2 className="mb-1 text-lg font-bold">No matching titles</h2><p className="mb-4 text-sm text-muted">Try changing or clearing the active filters.</p><button type="button" className="cursor-pointer text-sm font-bold text-accent-bright" onClick={clearFilters}>Clear filters</button></div>}
    </section>
  )
}
