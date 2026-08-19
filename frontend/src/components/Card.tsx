import { useCallback, useEffect, useRef, useState, ReactNode } from 'react'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { formatBytes, sizeDelta, seasonLabel, STATUS_LABEL } from '../utils'
import * as api from '../api'
import { cx } from '../styles'

const IconDL = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3z" />
    <path d="M4 19h16v2H4z" />
  </svg>
)

const IconSpinner = () => <span className="block size-[15px] animate-spin rounded-full border-2 border-accent/35 border-t-accent-bright group-disabled/dl:border-ink/30 group-disabled/dl:border-t-ink" aria-hidden="true" />

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

function HideActionIcon({ hidden }: { hidden: boolean }) {
  return (
    <span className="relative block size-[18px]">
      <span className="absolute inset-0 transition-opacity duration-150 group-hover/hide:opacity-0">
        {hidden ? <IconEyeOff /> : <IconEye />}
      </span>
      <span className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover/hide:opacity-100">
        {hidden ? <IconEye /> : <IconEyeOff />}
      </span>
    </span>
  )
}

interface CardProps {
  group: GroupedCard
  index: number
  config: Config | null
  hidden?: boolean
  onToggle: () => void
}

const HIDE_DURATION_MS = 280

const CARD_BASE =
  'flex animate-rise flex-col overflow-hidden rounded-card border transition-[transform,opacity,border-color,box-shadow] duration-150 hover:-translate-y-[3px] hover:shadow-card'
const CARD_TONE: Record<string, string> = {
  upgrade: 'border-accent/55 bg-panel shadow-[0_0_0_1px_rgba(79,140,255,0.12),0_8px_24px_rgba(79,140,255,0.10)] hover:border-accent hover:shadow-[0_0_0_1px_rgba(79,140,255,0.25),0_10px_30px_rgba(0,0,0,0.35)] [--card-status-color:#4f8cff]',
  best: 'border-good/55 bg-[#0e1e17] shadow-[0_0_0_1px_rgba(52,211,153,0.12),0_8px_24px_rgba(52,211,153,0.10)] hover:border-good hover:shadow-[0_0_0_1px_rgba(52,211,153,0.25),0_10px_30px_rgba(0,0,0,0.35)] [--card-status-color:#34d399]',
  missing: 'border-[#3a4356] bg-[#1a1b1e] hover:border-[#4a5568] [--card-status-color:#8b97ab]',
  partial: 'border-warn/55 bg-[#211d10] shadow-[0_0_0_1px_rgba(251,191,36,0.12),0_8px_24px_rgba(251,191,36,0.08)] hover:border-warn hover:shadow-[0_0_0_1px_rgba(251,191,36,0.25),0_10px_30px_rgba(0,0,0,0.35)] [--card-status-color:#fbbf24]',
}
const SOURCE_TONE: Record<string, string> = {
  sonarr: 'border-accent/65 bg-[#0d1c42]/88 text-[#cfe0ff]',
  radarr: 'border-warn/65 bg-[#3a2806]/88 text-[#ffe6a8]',
}
const STATUS_BADGE: Record<string, string> = {
  upgrade: 'border-accent/65 bg-[#0d1c42]/88 text-[#cfe0ff]',
  best: 'border-good/65 bg-[#062e20]/88 text-[#b9f5dd]',
  missing: 'border-muted/50 bg-[#1e232e]/88 text-[#c3cad6]',
  partial: 'border-warn/65 bg-[#3a2806]/88 text-[#ffe6a8]',
}
const SEASON_TONE: Record<string, string> = {
  upgrade: 'bg-canvas-soft',
  best: 'bg-[#0a1712]',
  missing: 'bg-[#141518]',
  partial: 'bg-[#19160d]',
}
const SEASON_NUMBER_TONE: Record<string, string> = {
  upgrade: 'border-line-strong bg-accent/15 text-accent-bright',
  best: 'border-good/35 bg-good/12 text-good',
  missing: 'border-line-strong bg-accent/15 text-accent-bright',
  partial: 'border-warn/35 bg-warn/12 text-warn',
}
const NOTE_TONE: Record<string, string> = {
  upgrade: 'border-line-strong text-muted',
  best: 'border-good/35 text-good',
  missing: 'border-line-strong text-[#9aa5b8]',
  partial: 'border-warn/35 text-warn',
}
const NOTES_SURFACE: Record<string, string> = {
  upgrade: 'bg-canvas-soft',
  best: 'bg-[#0a1712]',
  missing: 'bg-[#141518]',
  partial: 'bg-[#19160d]',
}
const ICON_BUTTON =
  'grid size-9 cursor-pointer place-items-center rounded-control border border-line bg-panel-raised text-muted transition-all duration-150 hover:-translate-y-px hover:border-line-strong hover:text-ink'
const BADGE_BASE = 'inline-block rounded-[7px] border px-[9px] py-1 text-[12.5px] font-semibold'
const BADGE = `${BADGE_BASE} border-line bg-panel-raised text-muted`
const SIZE_BASE = 'shrink-0 whitespace-nowrap rounded-md border px-2 py-[3px] text-xs font-bold tabular-nums'
const SIZE = `${SIZE_BASE} border-line bg-panel-raised text-muted`

/**
 * Dual-audio releases get a light blue pill; every other release tag
 * (quality flags, broken files, ...) gets a purple pill.
 */
function tagClass(t: string): string {
  const base = 'max-w-full overflow-hidden rounded-full border px-2 py-0.5 text-[10.5px] font-bold tracking-[0.2px] text-ellipsis whitespace-nowrap'
  return t === 'Dual Audio'
    ? `${base} border-sky/40 bg-sky/12 text-sky`
    : `${base} border-purple/40 bg-purple/12 text-purple`
}

function releaseSurface(tone: string, isBest: boolean): string {
  if (tone === 'best') return isBest ? 'bg-good/14' : 'bg-[#10241b]'
  if (tone === 'partial') return isBest ? 'bg-warn/12' : 'bg-[#282216]'
  if (tone === 'missing') return 'bg-[#1f2024]'
  return isBest ? 'bg-good/5' : 'bg-panel'
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
      className={cx(
        CARD_BASE,
        CARD_TONE[st],
        hiding && 'pointer-events-none !translate-y-1 !scale-[0.98] opacity-0',
        hidden && 'border-dashed !border-line-strong opacity-60 hover:opacity-85',
        downloading && 'download-border',
      )}
      style={{ animationDelay: Math.min(index * 40, 400) + 'ms' }}
    >
      <div
        className={cx(
          "relative h-[150px] border-b border-line bg-panel-raised bg-cover bg-[center_20%] after:absolute after:inset-0 after:bg-[linear-gradient(180deg,rgba(11,14,20,0)_30%,rgba(11,14,20,0.85)_100%)] after:content-['']",
          st === 'missing' && 'grayscale',
          hidden && 'grayscale-70',
        )}
        style={group.banner ? { backgroundImage: `url('${group.banner}')` } : undefined}
      >
        {group.image && (
          <img
            className={cx('absolute right-3 bottom-[-2px] z-2 h-[110px] w-[78px] rounded-control border-2 border-white/15 object-cover shadow-[0_8px_20px_rgba(0,0,0,0.5)]', hidden && 'grayscale-70')}
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
            className={cx('group/source absolute top-3 left-3 z-2 inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-[5px] text-[11.5px] font-extrabold tracking-[0.5px] no-underline backdrop-blur-[6px] transition-[transform,filter] duration-150 hover:-translate-y-px hover:brightness-118 hover:no-underline', SOURCE_TONE[srcClass])}
            href={group.arr_url}
            target="_blank"
            rel="noopener"
            title={'Open in ' + group.arr}
          >
            {group.arr} <span className="text-[11px] transition-transform duration-150 group-hover/source:translate-x-0.5 group-hover/source:-translate-y-0.5">↗</span>
          </a>
        ) : (
          <span className={cx('absolute top-3 left-3 z-2 rounded-full border px-2.5 py-[5px] text-[11.5px] font-extrabold tracking-[0.5px] backdrop-blur-[6px]', SOURCE_TONE[srcClass])}>{group.arr}</span>
        )}
        <span className={cx('absolute top-3 right-3 z-2 rounded-full border px-2.5 py-[5px] text-[11.5px] font-extrabold tracking-[0.5px] backdrop-blur-[6px]', STATUS_BADGE[st])}>{STATUS_LABEL[st]}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-[18px]">
        <div className="flex min-h-[43px] items-start gap-2.5">
          <div className={cx('line-clamp-2 min-w-0 flex-1 text-[16.5px] leading-[1.3] font-bold', st === 'missing' && 'text-muted')} title={group.title}>
            {group.anilist_id ? (
              <a className={cx('hover:text-accent-bright hover:no-underline', st === 'missing' ? 'text-muted' : 'text-ink')} href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">
                {group.title}
              </a>
            ) : (
              group.title
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              className={ICON_BUTTON}
              type="button"
              title={expanded ? 'Collapse' : 'Expand'}
              aria-label={(expanded ? 'Collapse ' : 'Expand ') + group.title}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <IconChevronUp /> : <IconChevronDown />}
            </button>
            <button
              className={cx(ICON_BUTTON, 'group/hide disabled:cursor-wait', hidden && 'border-warn bg-warn/12 text-warn hover:border-warn hover:text-warn')}
              type="button"
              title={hidden ? 'Show this card' : 'Hide this card'}
              aria-label={(hidden ? 'Show ' : 'Hide ') + group.title}
              onClick={handleHide}
              disabled={hiding}
            >
              <HideActionIcon hidden={hidden} />
            </button>
          </div>
        </div>
        {!expanded && (
          <button className="group/summary flex w-full cursor-pointer items-center gap-2.5 rounded-control border border-line bg-canvas-soft px-[13px] py-[11px] text-[13px] text-muted transition-[border-color,background-color,color] duration-150 hover:border-line-strong hover:bg-panel hover:text-ink" type="button" onClick={() => setExpanded(true)}>
            <span className="whitespace-nowrap rounded-full border border-line-strong bg-accent/15 px-2.5 py-[3px] text-[12.5px] font-extrabold text-accent-bright">
              {seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}
            </span>
            {delta !== 0 && (
              <span className={cx('whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[12.5px] font-extrabold', delta > 0 ? 'border-good/35 bg-good/12 text-good' : 'border-bad/30 bg-bad/10 text-bad')}>
                {(delta > 0 ? '+' : '') + formatBytes(delta)}
              </span>
            )}
            <span className="ml-auto text-xs font-bold tracking-[0.3px] text-muted-dim group-hover/summary:text-accent-bright">Show details</span>
          </button>
        )}
        {/* Seasons stay mounted while collapsed so download progress polling survives. */}
        <div className={expanded ? undefined : 'hidden'}>
          {group.seasons.map((r) => (
            <Season key={r.key} r={r} config={config} tone={st} onActiveChange={onSeasonActive} />
          ))}
        </div>
      </div>
    </article>
  )
}

interface SeasonProps {
  r: ResultItem
  config: Config | null
  tone: string
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

function Season({ r, config, tone, onActiveChange }: SeasonProps) {
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
    middle = <div className={cx('rounded-lg border border-dashed bg-panel px-3 py-2.5 text-center text-[13px]', NOTE_TONE[tone])}>Not listed on releases.moe</div>
  } else if (st === 'uncovered') {
    middle = <div className={cx('rounded-lg border border-dashed bg-panel px-3 py-2.5 text-center text-[13px]', NOTE_TONE[tone])}>This season is not covered on releases.moe</div>
  } else {
    const displayReleases = uniqueReleases(r.releases || [])
    const courGroups = groupByCour(displayReleases)
    middle = (
      <>
        {courGroups.map((group, gi) => (
          <div key={group.part || 'all'} className="flex flex-col gap-1.5">
            {gi > 0 && <div className="my-1 h-px bg-line-strong" role="separator" />}
            {group.part && (
              <div className="flex items-center gap-2 py-0.5">
                <span className="rounded-full border border-line bg-panel-raised px-2.5 py-[3px] text-[11px] font-extrabold tracking-[0.8px] text-muted uppercase">{group.part}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
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
                  <div key={`${rel.part || ''}-${rel.releaseGroup}`} className="flex flex-col gap-1.5">
                    <div
                      className={cx(
                        'flex items-center gap-2 rounded-lg border px-[9px] py-[7px]',
                        sending ? 'border-accent' : isBest ? 'border-good/35' : 'border-bad/28',
                        releaseSurface(tone, isBest),
                        sending && 'shadow-[0_0_0_1px_rgba(79,140,255,0.15),0_4px_14px_rgba(79,140,255,0.12)]',
                      )}
                    >
                      <span className={cx('w-[34px] shrink-0 text-[10px] font-extrabold tracking-[0.8px] uppercase', isBest ? 'text-good' : 'text-bad')} title={rel.part || undefined}>
                        {isBest ? 'Best' : 'Alt'}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-row items-center gap-1.5">
                        <span className={cx(BADGE_BASE, 'w-fit max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-extrabold', isBest ? 'border-good/40 bg-good/14 text-good' : 'border-bad/40 bg-bad/12 text-bad')} title={rel.releaseGroup}>
                          {rel.releaseGroup}
                        </span>
                        {tags.length > 0 && (
                          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                            {tags.map((t) => (
                              <span key={t} className={tagClass(t)}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className={cx(SIZE_BASE, isBest ? 'border-good/35 bg-good/10 text-good' : 'border-line bg-panel-raised text-muted')} title="Size of this release">
                        {formatBytes(rel.size)}
                      </span>
                      {delta && (
                        <span className="whitespace-nowrap text-[11.5px] font-semibold text-muted-dim" title="Difference: release size minus your local size">
                          {delta}
                        </span>
                      )}
                      <button
                        className={cx(
                          'group/dl ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-control border text-sm font-extrabold transition-all duration-150 hover:-translate-y-px disabled:opacity-55',
                          owned
                            ? 'cursor-default border-good/50 bg-good/18 text-good hover:border-good hover:bg-good/22'
                            : disabled
                              ? 'cursor-not-allowed border-line bg-panel-raised text-muted-dim hover:translate-y-0 hover:border-line hover:bg-panel-raised'
                              : 'border-good/40 bg-good/12 text-good hover:border-good hover:bg-good/22',
                        )}
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
                      <div className="flex flex-col gap-[5px] rounded-lg border border-line bg-accent/7 px-2.5 pt-2 pb-[9px]">
                        <div className="h-2 overflow-hidden rounded-full border border-line bg-panel-raised">
                          <div className="h-full rounded-full bg-linear-to-r from-accent to-good transition-[width] duration-500" style={{ width: Math.max(pct, 2) + '%' }} />
                        </div>
                        <div className="overflow-hidden text-xs font-semibold text-ellipsis whitespace-nowrap text-accent-bright tabular-nums">
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
          <div className={cx('[overflow-wrap:anywhere] whitespace-pre-line rounded-lg border border-line px-[11px] py-[9px] text-[13px] text-muted', NOTES_SURFACE[tone])} title={r.notes}>
            {r.notes}
          </div>
        )}
      </>
    )
  }

  const have = r.have.length
    ? r.have.map((x, i) => (
        <span key={i} className={BADGE} title={x}>
          {x}
        </span>
      ))
    : [
        <span key="none" className={BADGE}>
          none
        </span>,
      ]

  return (
    <div className={cx('flex flex-col gap-[9px] rounded-control border border-line p-3', SEASON_TONE[tone])}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('min-w-[46px] rounded-full border px-[9px] py-[3px] text-center text-xs font-extrabold tracking-[0.5px]', SEASON_NUMBER_TONE[tone])}>{seasonLabel(r)}</span>
        <div className="flex flex-1 flex-wrap gap-[5px]" title="Release groups you already have">
          {have}
        </div>
        {r.local_size ? (
          <span className={cx(SIZE, 'ml-auto')} title="Size of your current files">
            {formatBytes(r.local_size)}
          </span>
        ) : null}
        {(r.urls?.length ? r.urls : r.url ? [{ label: 'releases.moe', url: r.url }] : []).map(
          (source, i) => (
            <a
              className="group/link inline-flex items-center gap-1.5 text-[13.5px] font-bold text-accent-bright hover:no-underline"
              href={source.url}
              target="_blank"
              rel="noopener"
              key={`${source.url}-${i}`}
            >
              {source.label === 'releases.moe' ? source.label : `SeaDEX ${source.label}`}{' '}
              <span className="transition-transform duration-150 group-hover/link:translate-x-[3px] group-hover/link:-translate-y-[3px]">↗</span>
            </a>
          ),
        )}
      </div>
      {middle}
    </div>
  )
}
