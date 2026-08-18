import { useMemo, useState } from 'react'
import { ResultItem, Config, Status } from '../types'
import { groupResults, formatBytes, seasonLabel } from '../utils'
import Card from './Card'
import * as api from '../api'

interface Props {
  results: ResultItem[]
  config: Config | null
  mutedKeys: Set<string>
  status: Status
  lastRun: string | null
  onScan: () => void
  onMute: (key: string, muted: boolean) => void
}

export default function AnimeTab({ results, config, mutedKeys, status, lastRun, onScan, onMute }: Props) {
  const [search, setSearch] = useState('')
  const [arr, setArr] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [hideLocked, setHideLocked] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState('📣 Notify Discord')
  const [notifyBusy, setNotifyBusy] = useState(false)

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = groupResults(results).filter((g) => {
      if (arr && g.arr !== arr) return false
      if (statusFilter && g.status !== statusFilter) return false
      if (hideLocked && g.seasons.every((r) => mutedKeys.has(r.key))) return false
      if (!q) return true
      const hay = g.seasons
        .map((r) => r.title + ' ' + (r.best_group || '') + ' ' + r.have.join(' ') + ' ' + seasonLabel(r))
        .join(' ')
      return (g.title + ' ' + hay).toLowerCase().includes(q)
    })
    // Order: upgradable (blue) first, then missing from SeaDex (grey), then
    // already best quality (green); alphabetical within each status.
    const rank: Record<string, number> = { upgrade: 0, missing: 1, best: 2 }
    filtered.sort(
      (a, b) =>
        (rank[a.status] - rank[b.status]) ||
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    )
    return filtered
  }, [results, search, arr, statusFilter, hideLocked, mutedKeys])

  // Sum of (best − local) size across every visible upgradable season.
  let total = 0
  for (const g of groups)
    for (const r of g.seasons)
      if ((r.status || 'upgrade') === 'upgrade') total += (r.best_size || 0) - (r.local_size || 0)

  const pct = status.total ? Math.round((status.progress / status.total) * 100) : 0
  const autoCheck = status.next_check
    ? `Auto-check in ~${Math.max(0, Math.round((status.next_check - Date.now() / 1000) / 60))} min`
    : ''

  const handleNotify = async () => {
    if (!results.length) {
      alert('No results to send. Run a scan first.')
      return
    }
    setNotifyBusy(true)
    setNotifyMsg('Sending…')
    try {
      const r = await api.notify()
      if (r.ok) setNotifyMsg(`✓ Sent ${r.sent}/${r.total}`)
      else throw new Error(r.error || 'Notify failed')
    } catch (e: any) {
      alert('Notify failed: ' + e.message)
      setNotifyMsg('📣 Notify Discord')
    }
    setTimeout(() => {
      setNotifyMsg('📣 Notify Discord')
      setNotifyBusy(false)
    }, 2500)
  }

  return (
    <section className="tab">
      <header className="tab-header">
        <div>
          <h2>
            My Anime Library{' '}
            {total && results.length > 0 && (
              <span
                className="total-delta"
                title="Total size change if you replace all current files with the best releases"
              >
                {(total > 0 ? '+' : '') + formatBytes(total)}
              </span>
            )}
          </h2>
          <p className="subtitle">{lastRun ? 'Last scan: ' + lastRun : 'No scan yet'}</p>
          {autoCheck && <p className="subtitle">{autoCheck}</p>}
        </div>
        <div className="actions">
          <button
            className="btn btn-ghost"
            title="Send all upgrades to Discord"
            onClick={handleNotify}
            disabled={notifyBusy}
          >
            {notifyMsg}
          </button>
          <button className="btn btn-primary" onClick={onScan} disabled={status.running}>
            {status.running && <span className="spinner" />}
            <span>{status.running ? 'Scanning…' : '▶ Scan Library'}</span>
          </button>
        </div>
      </header>

      {status.running && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: pct + '%' }} />
          </div>
          <span className="progress-label">
            {status.message || ''}
            {status.total ? `  (${status.progress}/${status.total})` : ''}
          </span>
        </div>
      )}

      {status.error && !status.running && <div className="error-box">⚠ {status.error}</div>}

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search title or release group…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select" value={arr} onChange={(e) => setArr(e.target.value)}>
          <option value="">All sources</option>
          <option value="Sonarr">Sonarr</option>
          <option value="Radarr">Radarr</option>
        </select>
        <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="upgrade">Upgradable</option>
          <option value="best">Already best quality</option>
          <option value="missing">Missing from SeaDex</option>
        </select>
        <label className="check-filter" title="Hide cards where every season is locked (🔕)">
          <input type="checkbox" checked={hideLocked} onChange={(e) => setHideLocked(e.target.checked)} /> Hide locked
        </label>
        <span className="count-badge">{groups.length}</span>
      </div>

      <div className="grid">
        {groups.map((g, i) => (
          <Card
            key={String(g.anilist_id)}
            group={g}
            index={i}
            mutedKeys={mutedKeys}
            config={config}
            onMute={onMute}
          />
        ))}
      </div>

      {results.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🗺️</div>
          <h3>No anime yet</h3>
          <p>
            Click <b>Scan Library</b> to compare your Sonarr/Radarr collection
            <br />
            against the best releases on releases.moe.
          </p>
        </div>
      )}
    </section>
  )
}