import { useEffect, useMemo, useState } from 'react'
import { ResultItem, Config, Status } from '../types'
import { groupResults, formatBytes, seasonLabel } from '../utils'
import Card from './Card'
import * as api from '../api'
import { actions, buttonPrimary, control, countBadge, cx, subtitle, tabHeader } from '../styles'

interface Props {
  results: ResultItem[]
  config: Config | null
  status: Status
  lastRun: string | null
  onScan: () => void
}

function cardKey(group: ReturnType<typeof groupResults>[number]): string {
  return group.anilist_id !== null ? String(group.anilist_id) : `${group.arr}:${group.title}`
}

export default function AnimeTab({ results, config, status, lastRun, onScan }: Props) {
  const [search, setSearch] = useState('')
  const [arr, setArr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())

  // Hidden state is persisted server-side (config.json) so it survives
  // restarts; seed the local set from config once it has loaded.
  useEffect(() => {
    if (config?.hidden) setHiddenKeys(new Set(config.hidden))
  }, [config?.hidden])

  const toggleHidden = (key: string) => {
    const next = new Set(hiddenKeys)
    const nowHidden = !next.has(key)
    if (nowHidden) next.add(key)
    else next.delete(key)
    setHiddenKeys(next)
    api.setHidden(key, nowHidden).catch((e) => console.error('Failed to persist hidden state:', e))
  }

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = groupResults(results).filter((g) => {
      if (hiddenKeys.has(cardKey(g)) !== showHidden) return false
      if (arr && g.arr !== arr) return false
      if (statusFilter && g.status !== statusFilter) return false
      if (!q) return true
      const hay = g.seasons
        .map((r) => r.title + ' ' + (r.best_group || '') + ' ' + r.have.join(' ') + ' ' + seasonLabel(r))
        .join(' ')
      return (g.title + ' ' + hay).toLowerCase().includes(q)
    })
    // Order: upgradable first, then partially covered, missing from SeaDex,
    // and already best quality; alphabetical within each status.
    const rank: Record<string, number> = { upgrade: 0, partial: 1, missing: 2, best: 3 }
    filtered.sort(
      (a, b) =>
        (rank[a.status] - rank[b.status]) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    )
    return filtered
  }, [results, search, arr, statusFilter, showHidden, hiddenKeys])

  // Sum of (best − local) size across every visible upgradable season.
  let total = 0
  for (const g of groups)
    for (const r of g.seasons)
      if ((r.status || 'upgrade') === 'upgrade') total += (r.best_size || 0) - (r.local_size || 0)

  const pct = status.total ? Math.round((status.progress / status.total) * 100) : 0
  const autoCheck = status.next_check
    ? `Auto-check in ~${Math.max(0, Math.round((status.next_check - Date.now() / 1000) / 60))} min`
    : ''

  return (
    <section>
      <header className={tabHeader}>
        <div>
          <h2>
            My Anime Library{' '}
            {total !== 0 && results.length > 0 && (
              <span
                className="ml-3 inline-block rounded-full border border-line-strong bg-accent/15 px-3 py-1 align-middle text-sm font-extrabold tracking-[0.3px] text-accent-bright"
                title="Total size change if you replace all current files with the best releases"
              >
                {(total > 0 ? '+' : '') + formatBytes(total)}
              </span>
            )}
          </h2>
          <p className={subtitle}>{lastRun ? 'Last scan: ' + lastRun : 'No scan yet'}</p>
          {autoCheck && <p className={subtitle}>{autoCheck}</p>}
        </div>
        <div className={actions}>
          <button className={buttonPrimary} onClick={onScan} disabled={status.running}>
            {status.running && <span className="size-[15px] animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            <span>{status.running ? 'Scanning…' : '▶ Scan Library'}</span>
          </button>
        </div>
      </header>

      {status.running && (
        <div className="mb-5 flex items-center gap-3.5">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-line bg-panel-raised">
            <div className="h-full rounded-full bg-linear-to-r from-accent to-good transition-[width] duration-400" style={{ width: pct + '%' }} />
          </div>
          <span className="min-w-[180px] text-right text-[12.5px] text-muted max-[820px]:min-w-0">
            {status.message || ''}
            {status.total ? `  (${status.progress}/${status.total})` : ''}
          </span>
        </div>
      )}

      {status.error && !status.running && <div className="mb-5 rounded-control border border-bad/35 bg-bad/10 px-[15px] py-3 text-sm text-red-200">⚠ {status.error}</div>}

      <div className="mb-[22px] flex flex-wrap items-center gap-3">
        <input
          type="search"
          className={cx(control, 'min-w-[220px] flex-1')}
          placeholder="Search title or release group…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={cx(control, 'cursor-pointer')} value={arr} onChange={(e) => setArr(e.target.value)}>
          <option value="">All sources</option>
          <option value="Sonarr">Sonarr</option>
          <option value="Radarr">Radarr</option>
        </select>
        <select className={cx(control, 'cursor-pointer')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="upgrade">Upgradable</option>
          <option value="partial">Partially on SeaDex</option>
          <option value="best">Already best quality</option>
          <option value="missing">Missing from SeaDex</option>
        </select>
        <label className="inline-flex cursor-pointer items-center gap-[7px] rounded-control border border-line bg-panel px-[13px] py-[9px] text-[13.5px] font-semibold text-muted select-none transition-colors duration-150 hover:border-line-strong hover:text-ink" title="Show only cards hidden with the eye button">
          <input className="m-0 size-4 cursor-pointer accent-accent" type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show only hidden
        </label>
        <span className={countBadge}>{groups.length}</span>
      </div>

      <div className="grid items-start gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(min(400px,100%),1fr))]">
        {groups.map((g, i) => (
          <Card
            key={cardKey(g)}
            group={g}
            index={i}
            config={config}
            hidden={hiddenKeys.has(cardKey(g))}
            onToggle={() => toggleHidden(cardKey(g))}
          />
        ))}
      </div>

      {results.length === 0 && (
        <div className="rounded-card border border-dashed border-line-strong bg-canvas-soft px-5 py-[70px] text-center text-muted">
          <div className="mb-3 text-[46px]">🗺️</div>
          <h3 className="mb-2 text-[19px] font-bold text-ink">No anime yet</h3>
          <p className="m-0 text-sm">
            Click <b>Scan Library</b> to compare your Sonarr/Radarr collection
            <br />
            against the best releases on releases.moe.
          </p>
        </div>
      )}
    </section>
  )
}
