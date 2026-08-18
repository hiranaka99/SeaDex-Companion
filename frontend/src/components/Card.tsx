import { useCallback, useEffect, useRef, useState, ReactNode } from 'react'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { formatBytes, sizeDelta, seasonLabel, STATUS_LABEL } from '../utils'
import * as api from '../api'

const IconDL = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3z" />
    <path d="M4 19h16v2H4z" />
  </svg>
)

const IconSpinner = () => <span className="dl-spinner" aria-hidden="true" />

const IconOK = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
)

const IconEye = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
)

const IconEyeOff = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 9.5 7 9.5 7a17.4 17.4 0 0 1-2.9 3.9" />
    <path d="M6.6 6.6A16.8 16.8 0 0 0 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 4.4-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
)

const IconChevronDown = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
)

const IconChevronUp = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path d="M6 15l6-6 6 6" />
  </svg>
)

interface CardProps {
  group: GroupedCard
  index: number
  config: Config | null
  hidden?: boolean
  onToggle: () => void
}

const HIDE_DURATION_MS = 280

/**
 * Dual-audio releases get a light blue pill; every other release tag
 * (quality flags, broken files, ...) gets a purple pill.
 */
function tagClass(t: string): string {
  return t === 'Dual Audio' ? 'rel-tag rel-tag-blue' : 'rel-tag rel-tag-purple'
}

export default function Card({ group, index, config, hidden = false, onToggle }: CardProps) {
  const [hiding, setHiding] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const [activeBySeason, setActiveBySeason] = useState<Record<string, boolean>>({})
  const srcClass = group.arr === 'Sonarr' ? 'sonarr' : 'radarr'
  const st = group.status || 'upgrade'

  // Each season reports whether any of its releases is currently downloading;
  // the card spins its border while any season is active.
  const onSeasonActive = useCallback(
    (key: string, active: boolean) =>
      setActiveBySeason((prev) => (prev[key] === active ? prev : { ...prev, [key]: active })),
    []
  )
  const downloading = Object.values(activeBySeason).some(Boolean)

  const seasonCount = group.seasons.length
  // Total size change if every upgradable season were replaced by its best release.
  let delta = 0
  for (const r of group.seasons)
    if ((r.status || 'upgrade') === 'upgrade') delta += (r.best_size || 0) - (r.local_size || 0)

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    }
  }, [])

  const handleHide = () => {
    if (hiding) return
    if (hidden) {
      onToggle()
      return
    }
    setHiding(true)
    hideTimer.current = window.setTimeout(onToggle, HIDE_DURATION_MS)
  }

  return (
    <article
      className={
        'card status-' +
        st +
        (hiding ? ' is-hiding' : '') +
        (hidden ? ' is-hidden' : '') +
        (downloading ? ' is-downloading' : '')
      }
      style={{ animationDelay: Math.min(index * 40, 400) + 'ms' }}
    >
      <div
        className="card-banner"
        style={group.banner ? { backgroundImage: `url('${group.banner}')` } : undefined}
      >
        {group.image && (
          <img
            className="card-img"
            src={group.image}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        {group.arr_url ? (
          <a
            className={'card-source ' + srcClass}
            href={group.arr_url}
            target="_blank"
            rel="noopener"
            title={'Open in ' + group.arr}
          >
            {group.arr} <span className="arr">↗</span>
          </a>
        ) : (
          <span className={'card-source ' + srcClass}>{group.arr}</span>
        )}
        <span className={'card-status ' + st}>{STATUS_LABEL[st]}</span>
      </div>
      <div className="card-body">
        <div className="card-title-row">
          <div className="card-title">
            {group.anilist_id ? (
              <a href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">
                {group.title}
              </a>
            ) : (
              group.title
            )}
          </div>
          <div className="title-actions">
            <button
              className="expand-btn"
              type="button"
              title={expanded ? 'Collapse' : 'Expand'}
              aria-label={(expanded ? 'Collapse ' : 'Expand ') + group.title}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <IconChevronUp /> : <IconChevronDown />}
            </button>
            <button
              className={'hide-btn' + (hidden ? ' is-hidden' : '')}
              type="button"
              title={hidden ? 'Show this card' : 'Hide this card'}
              aria-label={(hidden ? 'Show ' : 'Hide ') + group.title}
              onClick={handleHide}
              disabled={hiding}
            >
              {hidden ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
        </div>
        {!expanded && (
          <button className="card-summary" type="button" onClick={() => setExpanded(true)}>
            <span className="summary-chip">
              {seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}
            </span>
            {delta !== 0 && (
              <span className={'summary-delta' + (delta > 0 ? ' up' : ' down')}>
                {(delta > 0 ? '+' : '') + formatBytes(delta)}
              </span>
            )}
            <span className="summary-hint">Show details</span>
          </button>
        )}
        {/* Seasons stay mounted while collapsed so download progress (and its
            polling) survives; the .hidden class just hides them visually. */}
        <div className={expanded ? undefined : 'hidden'}>
          {group.seasons.map((r) => (
            <Season key={r.key} r={r} config={config} onActiveChange={onSeasonActive} />
          ))}
        </div>
      </div>
    </article>
  )
}

interface SeasonProps {
  r: ResultItem
  config: Config | null
  onActiveChange: (key: string, active: boolean) => void
}

interface DisplayRelease {
  rel: Release
  index: number
}

/** Live download state for one release row (keyed by its release index). */
interface DlState {
  phase: 'idle' | 'sending' | 'downloading' | 'complete'
  progress: number // 0..1
  downloaded: number
  total_size: number
  speed: number
}

const IDLE_DL: DlState = {
  phase: 'idle',
  progress: 0,
  downloaded: 0,
  total_size: 0,
  speed: 0,
}

/**
 * Older cached scan results can still contain one row per tracker.  The
 * backend now removes those duplicates, but deduplicating here as well keeps
 * the card correct until the next scan and preserves the original download
 * index used by the API.
 */
function uniqueReleases(releases: Release[]): DisplayRelease[] {
  const selected = new Map<string, DisplayRelease>()

  releases.forEach((rel, index) => {
    const key = `${rel.part || ''}\u0000${rel.releaseGroup.trim().toLowerCase()}`
    const current = selected.get(key)
    if (!current || (rel.downloadable && !current.rel.downloadable)) {
      selected.set(key, { rel, index })
    }
  })

  return [...selected.values()].sort((a, b) => a.index - b.index)
}

/**
 * Group consecutive display releases by their cour part label so each cour
 * can be rendered with its own header and a divider separates the cours.
 */
function groupByCour(releases: DisplayRelease[]): { part: string; items: DisplayRelease[] }[] {
  const groups: { part: string; items: DisplayRelease[] }[] = []
  for (const dr of releases) {
    const part = dr.rel.part || ''
    const last = groups[groups.length - 1]
    if (last && last.part === part) {
      last.items.push(dr)
    } else {
      groups.push({ part, items: [dr] })
    }
  }
  return groups
}

function Season({ r, config, onActiveChange }: SeasonProps) {
  const [dl, setDl] = useState<Record<number, DlState>>({})
  const pollers = useRef<Record<number, number>>({})
  const st = r.status || 'upgrade'

  // True while any release in this season is being sent or downloaded.
  const active = Object.values(dl).some(
    (d) => d.phase === 'sending' || d.phase === 'downloading',
  )
  useEffect(() => {
    onActiveChange(r.key, active)
  }, [active, onActiveChange, r.key])

  const stopPolling = (release: number) => {
    const id = pollers.current[release]
    if (id) {
      window.clearInterval(id)
      delete pollers.current[release]
    }
  }

  const startPolling = (release: number) => {
    if (pollers.current[release]) return
    pollers.current[release] = window.setInterval(() => pollProgress(release), 3000)
  }

  const applyProgress = (release: number, p: api.DownloadProgress) => {
    if (!p.ok) return
    const complete = p.state === 'complete' || (p.found && p.progress >= 0.999)
    setDl((s) => ({
      ...s,
      [release]: {
        phase: complete ? 'complete' : 'downloading',
        progress: p.progress,
        downloaded: p.downloaded,
        total_size: p.total_size,
        speed: p.speed,
      },
    }))
    if (complete) stopPolling(release)
    else startPolling(release)
  }

  const pollProgress = (release: number) => {
    api.getDownloadProgress(r.key, release)
      .then((p) => applyProgress(release, p))
      .catch(() => {
        /* transient network/backend error — keep polling */
      })
  }

  // Re-attach to downloads that are already running in qBittorrent (e.g. after
  // a page reload or server restart): check each downloadable release once and
  // resume polling for any that are in progress or already complete. The
  // backend caches the qBittorrent response, so this burst stays cheap.
  useEffect(() => {
    const active = pollers.current
    const owned = (rel: Release) =>
      r.have.some((h) => h.toLowerCase() === rel.releaseGroup.toLowerCase())
    for (const { rel, index } of uniqueReleases(r.releases || [])) {
      if (!rel.downloadable || owned(rel)) continue
      api
        .getDownloadProgress(r.key, index)
        .then((p) => {
          if (!p.ok || !p.found) return
          if (p.state === 'paused') return // don't show a stuck bar for paused
          applyProgress(index, p)
        })
        .catch(() => {
          /* ignore — nothing to re-attach to */
        })
    }
    return () => {
      for (const k of Object.keys(active)) window.clearInterval(active[Number(k)])
    }
    // Runs once per mount (fresh after a reload), so the first-render `r` is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDownload = async (release: number) => {
    setDl((s) => ({ ...s, [release]: { ...IDLE_DL, phase: 'sending' } }))
    try {
      const res = await api.download(r.key, release)
      if (!res.ok) throw new Error(res.error || 'Download failed')
      pollProgress(release)
      startPolling(release)
    } catch (e: any) {
      stopPolling(release)
      setDl((s) => ({ ...s, [release]: IDLE_DL }))
      alert('Download failed: ' + e.message)
    }
  }

  let middle: ReactNode
  if (st === 'missing') {
    middle = <div className="season-note">Not listed on releases.moe</div>
  } else if (st === 'uncovered') {
    middle = <div className="season-note">This season is not covered on releases.moe</div>
  } else {
    const displayReleases = uniqueReleases(r.releases || [])
    const courGroups = groupByCour(displayReleases)
    middle = (
      <>
        {courGroups.map((group, gi) => (
          <div key={group.part || 'all'} className="cour-block">
            {gi > 0 && <div className="cour-divider" role="separator" />}
            {group.part && (
              <div className="cour-header">
                <span className="cour-header-label">{group.part}</span>
              </div>
            )}
            <div className="releases">
              {group.items.map(({ rel, index }) => {
                const isBest = rel.kind === 'best'
                // Sonarr's size covers both cours, while a split-cour row only
                // covers one. Comparing those values would produce a bogus delta.
                const delta = rel.part ? '' : sizeDelta(rel.size, r.local_size)
                const owned = r.have.some((h) => h.toLowerCase() === rel.releaseGroup.toLowerCase())
                const cat = (config ? String((config as any)[((r.arr || '').toLowerCase() + '_category')] || '') : '').trim()
                const dlState = dl[index] || IDLE_DL
                const sending = dlState.phase === 'sending' || dlState.phase === 'downloading'
                const disabled = owned || !rel.downloadable || sending
                const btnTitle = owned
                  ? 'You already have this release'
                  : sending
                  ? 'Downloading…'
                  : rel.downloadable
                  ? 'Send this release to qBittorrent (category: ' + (cat || r.arr) + ')'
                  : 'No magnet available (private tracker)'
                const pct = Math.min(100, Math.round(dlState.progress * 1000) / 10)
                // releases.moe marks dual-audio releases with a separate flag
                // (not part of the quality "tags" list), so surface it here too.
                const tags = [
                  ...(rel.dual_audio ? ['Dual Audio'] : []),
                  ...(rel.tags || []),
                ]
                return (
                  <div key={`${rel.part || ''}-${rel.releaseGroup}`} className="release-wrap">
                    <div
                      className={
                        'release-row ' +
                        (isBest ? 'best' : 'alt') +
                        (owned ? ' owned' : '') +
                        (sending ? ' downloading' : '')
                      }
                    >
                      <span className="rel-kind" title={rel.part || undefined}>
                        {isBest ? 'Best' : 'Alt'}
                      </span>
                      <div className="rel-main">
                        <span className={'badge ' + (isBest ? 'best' : 'alt')} title={rel.releaseGroup}>
                          {rel.releaseGroup}
                        </span>
                        {tags.length > 0 && (
                          <div className="rel-tags">
                            {tags.map((t) => (
                              <span key={t} className={tagClass(t)}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className={'size ' + (isBest ? 'best' : '')} title="Size of this release">
                        {formatBytes(rel.size)}
                      </span>
                      {delta && (
                        <span className="size-delta" title="Difference: release size minus your local size">
                          {delta}
                        </span>
                      )}
                      <button
                        className={'dl-btn' + (disabled ? ' disabled' : '')}
                        disabled={disabled}
                        title={btnTitle}
                        onClick={() => !disabled && handleDownload(index)}
                      >
                        {owned || dlState.phase === 'complete' ? (
                          <IconOK />
                        ) : sending ? (
                          <IconSpinner />
                        ) : (
                          <IconDL />
                        )}
                      </button>
                    </div>
                    {sending && (
                      <div className="dl-progress">
                        <div className="dl-progress-bar">
                          <div className="dl-progress-fill" style={{ width: Math.max(pct, 2) + '%' }} />
                        </div>
                        <div className="dl-progress-label">
                          {dlState.phase === 'sending'
                            ? 'Sending to qBittorrent…'
                            : dlState.total_size > 0
                            ? `${pct.toFixed(1)}% · ${formatBytes(dlState.downloaded)} / ${formatBytes(
                                dlState.total_size,
                              )}${dlState.speed > 0 ? ' · ' + formatBytes(dlState.speed) + '/s' : ''}`
                            : 'Waiting for torrent metadata…'}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {r.notes && r.notes !== '-' && (
          <div className="card-notes" title={r.notes}>
            {r.notes}
          </div>
        )}
      </>
    )
  }

  const have = r.have.length
    ? r.have.map((x, i) => (
        <span key={i} className="badge" title={x}>
          {x}
        </span>
      ))
    : [
        <span key="none" className="badge">
          none
        </span>,
      ]

  return (
    <div className="season">
      <div className="season-head">
        <span className="season-num">{seasonLabel(r)}</span>
        <div className="have-wrap" title="Release groups you already have">
          {have}
        </div>
        {r.local_size ? (
          <span className="size" title="Size of your current files">
            {formatBytes(r.local_size)}
          </span>
        ) : null}
        {(r.urls?.length ? r.urls : r.url ? [{ label: 'releases.moe', url: r.url }] : []).map(
          (source, i) => (
            <a
              className="card-link"
              href={source.url}
              target="_blank"
              rel="noopener"
              key={`${source.url}-${i}`}
            >
              {source.label === 'releases.moe' ? source.label : `SeaDEX ${source.label}`}{' '}
              <span className="arr">↗</span>
            </a>
          ),
        )}
      </div>
      {middle}
    </div>
  )
}
