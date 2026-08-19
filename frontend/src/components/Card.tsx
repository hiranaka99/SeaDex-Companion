import { useCallback, useEffect, useId, useRef, useState, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { formatBytes, sizeDelta, seasonLabel, STATUS_LABEL } from '../utils'
import * as api from '../api'
import { cx } from '../styles'
import Icon from './Icons'
import { useToast } from './Toast'

const IconSpinner = () => <span className="block size-[15px] animate-spin rounded-full border-2 border-accent/35 border-t-accent-bright group-disabled/dl:border-ink/30 group-disabled/dl:border-t-ink" aria-hidden="true" />

function HideActionIcon({ hidden }: { hidden: boolean }) {
  return (
    <span className="relative block size-[18px]">
      <span className="absolute inset-0 transition-opacity duration-150 group-hover/hide:opacity-0">
        <Icon name={hidden ? 'eye-off' : 'eye'} size={18} />
      </span>
      <span className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover/hide:opacity-100">
        <Icon name={hidden ? 'eye' : 'eye-off'} size={18} />
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
  'group/card flex animate-rise flex-col overflow-hidden rounded-card border bg-panel transition-[transform,opacity,border-color,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-card'
const CARD_TONE: Record<string, string> = {
  upgrade: 'border-accent/35 hover:border-accent/70 [--card-status-color:#4f8cff]',
  best: 'border-good/30 hover:border-good/60 [--card-status-color:#34d399]',
  missing: 'border-line hover:border-muted/60 [--card-status-color:#8b97ab]',
  partial: 'border-warn/30 hover:border-warn/60 [--card-status-color:#fbbf24]',
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
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

  useEffect(() => {
    if (!detailsOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetailsOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape) }
  }, [detailsOpen])

  const handleHide = () => {
    if (hiding) return
    if (hidden) {
      onToggle()
      return
    }
    setHiding(true)
    hideTimer.current = window.setTimeout(onToggle, HIDE_DURATION_MS)
  }

  return <>
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
          "relative aspect-[16/8] min-h-[145px] border-b border-line bg-panel-raised bg-cover bg-[center_20%] after:absolute after:inset-0 after:bg-[linear-gradient(180deg,rgba(11,14,20,.08)_20%,rgba(11,14,20,.88)_100%)] after:content-['']",
          st === 'missing' && 'grayscale',
          hidden && 'grayscale-70',
        )}
        style={group.banner ? { backgroundImage: `url('${group.banner}')` } : undefined}
      >
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
        <span className={cx('absolute top-3 right-3 z-2 rounded-full border px-2.5 py-[5px] text-[11px] font-extrabold backdrop-blur-md', STATUS_BADGE[st])}>{STATUS_LABEL[st]}</span>
        <div className="absolute inset-x-4 bottom-3 z-2 flex items-end gap-3">
          {group.image && (
            <img className={cx('h-[74px] w-[52px] shrink-0 rounded-lg border border-white/15 object-cover shadow-lg', hidden && 'grayscale')} src={group.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none' }} />
          )}
          <div className="line-clamp-2 min-w-0 flex-1 text-[17px] leading-snug font-extrabold text-white drop-shadow-md" title={group.title}>{group.title}</div>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-1.5" aria-label={`${seasonCount} seasons`}>
          {group.seasons.slice(0, 6).map((season) => <span key={season.key} className={cx('rounded-md border px-2 py-1 text-[10px] font-extrabold', SEASON_NUMBER_TONE[season.status === 'uncovered' ? 'partial' : season.status || st])}>{seasonLabel(season)}</span>)}
          {seasonCount > 6 && <span className="rounded-md border border-line px-2 py-1 text-[10px] font-bold text-muted">+{seasonCount - 6}</span>}
        </div>
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
          {delta !== 0 ? <span className={cx('text-xs font-extrabold tabular-nums', delta > 0 ? 'text-good' : 'text-bad')}>{delta > 0 ? '+' : ''}{formatBytes(delta)} <span className="font-medium text-muted-dim">change</span></span> : <span className="text-xs text-muted-dim">{seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}</span>}
          <button className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-accent-bright transition-colors hover:bg-accent/10" type="button" onClick={() => setDetailsOpen(true)}>Details <Icon name="chevron-right" size={15}/></button>
          <button className={cx(ICON_BUTTON, 'group/hide size-8 disabled:cursor-wait', hidden && 'border-warn/35 bg-warn/10 text-warn')} type="button" title={hidden ? 'Show this card' : 'Hide this card'} aria-label={(hidden ? 'Show ' : 'Hide ') + group.title} onClick={handleHide} disabled={hiding}><HideActionIcon hidden={hidden}/></button>
        </div>
      </div>
    </article>
    {detailsOpen && createPortal(
      <div className="fixed inset-0 z-[80] flex justify-end bg-black/65 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false) }}>
        <aside className="app-scrollbar h-full w-full max-w-[720px] animate-slide-in overflow-y-auto border-l border-line-strong bg-canvas shadow-[-24px_0_60px_rgba(0,0,0,.45)]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="relative h-48 overflow-hidden border-b border-line bg-panel bg-cover bg-center" style={group.banner ? { backgroundImage: `url('${group.banner}')` } : undefined}><div className="absolute inset-0 bg-linear-to-t from-canvas via-canvas/55 to-black/15"/><button ref={closeRef} type="button" className="absolute top-4 right-4 z-2 grid size-10 cursor-pointer place-items-center rounded-xl border border-white/15 bg-black/40 text-white backdrop-blur-md hover:bg-black/60" onClick={() => setDetailsOpen(false)} aria-label="Close details"><Icon name="close"/></button><div className="absolute inset-x-5 bottom-5 z-1 flex items-end gap-4">{group.image && <img src={group.image} alt="" className="h-24 w-16 rounded-lg border border-white/15 object-cover shadow-xl"/>}<div className="min-w-0"><span className={cx('mb-2 inline-block rounded-full border px-2.5 py-1 text-[11px] font-extrabold', STATUS_BADGE[st])}>{STATUS_LABEL[st]}</span><h2 id={titleId} className="m-0 text-2xl leading-tight font-extrabold text-white">{group.title}</h2></div></div></div>
          <div className="space-y-4 p-5 max-[600px]:p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">{group.arr_url && <a className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 font-bold hover:no-underline" href={group.arr_url} target="_blank" rel="noopener"><Icon name="server" size={15}/>Open in {group.arr}</a>}{group.anilist_id && <a className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 font-bold hover:no-underline" href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">Open in AniList ↗</a>}<span className="ml-auto">{seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}</span></div>
            {group.seasons.map((season) => <Season key={season.key} r={season} config={config} tone={st} onActiveChange={onSeasonActive}/>)}
          </div>
        </aside>
      </div>, document.body,
    )}
  </>
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
  const toast = useToast()
  const st = r.status || 'upgrade'

  // True while any release in this season is being sent or downloaded.
  const active = Object.values(dl).some(
    (d) => d.phase === 'sending' || d.phase === 'downloading',
  )
  useEffect(() => {
    onActiveChange(r.key, active)
  }, [active, onActiveChange, r.key])
  useEffect(() => () => onActiveChange(r.key, false), [onActiveChange, r.key])

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
      toast.show('Download failed: ' + e.message, 'error')
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
                          <Icon name="check" size={18} />
                        ) : sending ? (
                          <IconSpinner />
                        ) : (
                          <Icon name="download" size={18} />
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
