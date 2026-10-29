import { useCardDownloads, IDLE_DOWNLOAD } from '../useCardDownloads'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { seasonLabel, STATUS_LABEL, cardSizeDelta, isSeasonUpgradable } from '../utils'
import * as api from '../api'
import { buttonBase, cx } from '../styles'
import Icon, { IconName } from './Icons'
import BrandLogo from './BrandLogo'
import { useToast } from './Toast'
import DownloadsPanel, { DownloadEntry } from './DownloadsPanel'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'

import MappingDialog from './MappingDialog'
import SeasonBadge from './SeasonBadge'
import LibrarySizeChange from './LibrarySizeChange'
import ReleaseDetails, { type DetailsDownloadState } from './ReleaseDetails'

function HideActionIcon({ hidden }: { hidden: boolean }) {
  return <Icon name={hidden ? 'eye' : 'eye-off'} size={18} />
}

interface CardProps {
  active: boolean
  openRequested?: boolean
  onOpened?: () => void
  group: GroupedCard
  index: number
  config: Config | null
  hidden?: boolean
  onToggle: (group: GroupedCard) => void
  onRulesChanged: () => Promise<void>
  onRescan: () => void
}

const HIDE_DURATION_MS = 280

function detailsSeasonName(season: ResultItem): string {
  return season.arr === 'Radarr' || season.season === 0 ? 'Movie' : typeof season.season === 'number' ? `Season ${season.season}` : seasonLabel(season)
}

function detailsStatus(season: ResultItem): string {
  if (season.match_status === 'unmatched') return 'Match needs review'
  return season.status === 'uncovered' ? 'Not on SeaDex' : STATUS_LABEL[season.status as keyof typeof STATUS_LABEL] || 'Upgradable'
}

function RecommendationNotes({ notes }: { notes: string | null | undefined }) {
  if (!notes || notes === '-') return null
  return <details className="release-notes rounded-lg border border-line bg-panel px-3 py-2"><summary className="touch-target cursor-pointer py-1 text-sm font-semibold text-ink">Why these releases?</summary><div className="mt-2 max-w-[70ch] whitespace-pre-line text-sm leading-relaxed text-muted wrap-anywhere">{notes}</div></details>
}

function jumpToDetails(id: string) {
  const target = document.getElementById(id)
  const body = target?.closest<HTMLElement>('.anime-details-body')
  if (!target || !body) return
  const top = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top
  body.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  target.focus({ preventScroll: true })
}

const CARD_BASE =
  'group/card relative flex flex-col overflow-hidden rounded-card border border-line bg-panel transition-opacity duration-200'
const CARD_STATUS: Record<string, { icon: IconName; color: string }> = {
  upgrade: { icon: 'arrow-up', color: 'text-accent-bright' },
  best: { icon: 'check', color: 'text-good' },
  missing: { icon: 'minus', color: 'text-muted' },
  partial: { icon: 'alert', color: 'text-warn' },
  review: { icon: 'alert', color: 'text-warn' },
}
const ICON_BUTTON =
  'grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel-raised hover:text-ink'
function Card({ active, openRequested, onOpened, group, index, config, hidden = false, onToggle, onRulesChanged, onRescan }: CardProps) {
  const [hiding, setHiding] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<DownloadEntry | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [ruleBusy, setRuleBusy] = useState('')
  const hideTimer = useRef<number | null>(null)
  const closing = useRef(false)
  const openFrame = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const copyRef = useRef<HTMLDivElement>(null)
  const [copyOverflows, setCopyOverflows] = useState(false)
  const toast = useToast()
  const srcClass = group.arr === 'Sonarr' ? 'sonarr' : 'radarr'
  const st = group.status === 'review' ? 'partial' : group.status || 'upgrade'

  useEffect(() => {
    const copy = copyRef.current
    if (!copy) return
    const update = () => setCopyOverflows(copy.scrollHeight > copy.clientHeight + 1)
    const observer = new ResizeObserver(update)
    observer.observe(copy)
    Array.from(copy.children).forEach(child => observer.observe(child))
    update()
    return () => observer.disconnect()
  }, [group.title, group.status])

  useEffect(() => {
    if (!active) { setDetailsOpen(false); setMappingOpen(false); setRemoveTarget(null) }
    else if (openRequested) { handleOpenDetails(); onOpened?.() }
  }, [active, openRequested])
  const { dlBySeason, activeDownloads, busyDownload, handleDownload, handleDownloadAction } = useCardDownloads(group, toast.show)

  const seasonCount = group.seasons.length
  const upgradableSeasonCount = group.seasons.filter(isSeasonUpgradable).length
  const delta = cardSizeDelta(group)

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
      if (openFrame.current !== null) window.cancelAnimationFrame(openFrame.current)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  const requestClose = () => {
    if (closing.current) return
    closing.current = true
    if (openFrame.current !== null) {
      window.cancelAnimationFrame(openFrame.current)
      openFrame.current = null
    }
    setDetailsVisible(false)
    closeTimer.current = window.setTimeout(() => {
      closing.current = false
      setDetailsOpen(false)
    }, 220)
  }

  useEffect(() => {
    if (!detailsOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    openFrame.current = window.requestAnimationFrame(() => {
      setDetailsVisible(true)
      openFrame.current = null
    })
    closeRef.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [detailsOpen])

  const handleHide = () => {
    if (hiding) return
    if (hidden) {
      onToggle(group)
      return
    }
    setHiding(true)
    hideTimer.current = window.setTimeout(() => onToggle(group), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : HIDE_DURATION_MS)
  }

  const handleOpenDetails = () => {
    setDetailsVisible(false)
    setDetailsOpen(true)
  }

  const toggleExclusion = async (season: ResultItem, part: string, excluded: boolean) => {
    if (!season.library_key) return
    const id = `${season.key}:${part || '*'}`
    setRuleBusy(id)
    try {
      await api.setExclusion(season.library_key, season.season, part, excluded)
      await onRulesChanged()
      toast.show(`${part || seasonLabel(season)} ${excluded ? 'ignored' : 'restored'} for bulk downloads and notifications`, 'success')
    } catch (error: any) {
      toast.show('Could not update the exclusion: ' + error.message, 'error')
    } finally { setRuleBusy('') }
  }

  const applyMapping = async (anilistId: number | null) => {
    const libraryKey = group.seasons[0]?.library_key
    if (!libraryKey) throw new Error('Run a new scan before correcting this match')
    await api.setMappingOverride(libraryKey, anilistId)
    setMappingOpen(false)
    toast.show(anilistId ? `Manual AniList match saved; rescanning ${group.title}` : 'Automatic AniList matching restored; rescanning library', 'success')
    onRescan()
  }

  const statusBadge = <div className="library-status-badge" data-library-status={group.status}>
    <span className="library-status-label"><Icon name={CARD_STATUS[group.status].icon} size={14} className="shrink-0"/><span>{STATUS_LABEL[group.status]}</span></span>
    {group.status === 'partial' && upgradableSeasonCount > 0 && <span className="library-status-upgrades"><Icon name="arrow-up" size={13} className="shrink-0"/><span>{upgradableSeasonCount} {group.arr === 'Radarr' ? (upgradableSeasonCount === 1 ? 'movie' : 'movies') : (upgradableSeasonCount === 1 ? 'season' : 'seasons')} upgradable</span></span>}
  </div>

  const detailIndex = useMemo(() => detailsOpen ? group.seasons.flatMap((season, seasonIndex) => {
    const id = `${titleId}-season-${seasonIndex}`
    const name = detailsSeasonName(season)
    const entries = [{ id, name, status: detailsStatus(season), upgrade: isSeasonUpgradable(season) }]
    for (const [courIndex, cour] of groupByCour(indexedReleases(season.releases || [])).entries()) {
      if (!cour.part) continue
      const owned = season.precise_part_ownership ? season.owned_by_part?.[cour.part] || [] : season.have
      const upgrade = isSeasonUpgradable(season) && cour.items.some(({ rel }) => rel.kind === 'best' && rel.downloadable && !owned.some(name => name.toLowerCase() === rel.releaseGroup.toLowerCase()))
      entries.push({ id: `${id}-cour-${courIndex}`, name: `${name} · ${cour.part}`, status: upgrade ? 'Upgradable' : owned.length ? 'Release owned' : 'No matching files owned', upgrade })
    }
    return entries
  }) : [], [detailsOpen, group.seasons, titleId])
  const nextUpgrade = detailIndex.find(entry => entry.upgrade)
  const managementLinks = detailsOpen ? <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Anime links">{group.arr_url && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={group.arr_url} target="_blank" rel="noopener"><Icon name="server" size={15}/>Open in {group.arr}</a>}{typeof group.anilist_id === 'number' && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">Open in AniList <Icon name="chevron-right" size={14}/></a>}<button type="button" className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-muted hover:bg-panel-raised hover:text-ink')} onClick={() => setMappingOpen(true)} disabled={!group.seasons[0]?.library_key} title={!group.seasons[0]?.library_key ? 'Run a new scan to enable manual matching' : undefined}><Icon name="refresh" size={14}/>{group.seasons.some((season) => season.mapping_override) ? 'Change manual match' : 'Correct match'}</button>{group.seasons.some((season) => season.mapping_override) && <span className="rounded-full border border-purple/35 bg-purple/10 px-2 py-1 text-xs font-bold text-ink">Manual match</span>}</nav> : null

  return <>
    <article
      data-library-key={String(group.anilist_id ?? `${group.arr}:${group.title}`)}
      className={cx(
        CARD_BASE, 'library-card-readable',
        hiding && 'library-card-hiding pointer-events-none opacity-0',
        hidden && 'border-dashed !border-line-strong',
      )}
    >
      <div className={cx('library-card-body', st === 'missing' && 'grayscale', hidden && 'grayscale-70')}>
        <div className="library-card-poster">
          <span className="absolute inset-0 grid place-items-center text-muted-dim" aria-hidden="true"><Icon name="library" size={32}/></span>
          {group.image && <img className="absolute inset-0 h-full w-full object-cover" src={group.image} alt="" loading={index < 4 ? 'eager' : 'lazy'} decoding="async" onError={event => { event.currentTarget.style.display = 'none' }}/>}
        </div>
        <div className="library-card-info">
        {group.banner && <img src={group.banner} alt="" loading={index < 4 ? 'eager' : 'lazy'} decoding="async" className="library-card-banner" onError={event => { event.currentTarget.style.display = 'none' }}/>}
        <div ref={copyRef} className="library-card-copy app-scrollbar" tabIndex={copyOverflows ? 0 : undefined} role={copyOverflows ? 'group' : undefined} aria-label={copyOverflows ? `${group.title}: scroll to read the full title` : undefined}>
        <h2 className="anime-art-title relative m-0 text-lg leading-snug font-bold text-white wrap-anywhere" title={group.title}>{group.title}</h2>
        </div>
        <div className="library-status-banner app-scrollbar">{statusBadge}</div>
        </div>
      </div>
        <div className="library-card-seasons flex flex-wrap gap-1.5 px-3.5 pb-3.5 max-[600px]:px-3 max-[600px]:pb-3" aria-label={`${seasonCount} seasons`}>
          {group.seasons.slice(0, 6).map((season) => <SeasonBadge key={season.key} season={season} fallback={st} animeTitle={group.title} className="rounded-md border px-2 py-1 text-xs font-extrabold"/>)}
          {seasonCount > 6 && <span className="relative rounded-md border border-line bg-panel-raised px-2 py-1 text-xs font-bold text-muted" title={`View all ${seasonCount} seasons in Details`}>+{seasonCount - 6}<span className="sr-only"> more seasons; open Details to view all {seasonCount} seasons</span></span>}
        </div>
      {activeDownloads.length > 0 && <div className="border-t border-line px-3.5 py-3 max-[600px]:px-3">
            <DownloadsPanel
              downloads={activeDownloads}
              busyId={busyDownload}
              onPause={(entry) => void handleDownloadAction(entry, 'pause')}
              onResume={(entry) => void handleDownloadAction(entry, 'resume')}
              onRemove={(entry) => { setDeleteFiles(false); setRemoveTarget(entry) }}
            />
      </div>}
        <footer className="mt-auto flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3.5 py-3 max-[600px]:px-3">
          <div className="flex min-w-0 grow basis-24 flex-wrap items-center gap-x-2 gap-y-1 wrap-anywhere">
            {delta !== 0 ? <LibrarySizeChange delta={delta} title={group.title}/> : <span className="text-xs text-muted-dim">{seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}</span>}
            {group.seasons.some(season => (season.missing_episode_count || 0) > 0) && <span className="text-xs text-warn">{group.seasons.reduce((sum, season) => sum + (season.missing_episode_count || 0), 0)} episodes missing</span>}
          </div>
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
            {group.arr_url ? (
              <a
                className="library-card-source touch-target grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-panel-raised"
                href={group.arr_url}
                target="_blank"
                rel="noopener"
                title={`Open ${group.title} in ${group.arr}`}
                aria-label={`Open ${group.title} in ${group.arr} (new tab)`}
              ><BrandLogo name={srcClass} size={20}/></a>
            ) : (
              <span className="library-card-source grid size-8 shrink-0 place-items-center rounded-lg" title={group.arr} role="img" aria-label={`Source: ${group.arr}`}><BrandLogo name={srcClass} size={20}/></span>
            )}
            <button className="touch-target inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent/10" type="button" aria-label={`Details for ${group.title}`} onClick={handleOpenDetails}>Details <Icon name="chevron-right" size={15}/></button>
            <button className={cx(ICON_BUTTON, 'touch-target size-8 shrink-0 disabled:cursor-wait', hidden && 'text-warn')} type="button" title={hidden ? 'Show this card' : 'Hide this card'} aria-label={(hidden ? 'Show ' : 'Hide ') + group.title} onClick={handleHide} disabled={hiding}><HideActionIcon hidden={hidden}/></button>
          </div>
        </footer>
    </article>
    {detailsOpen && (
      <Modal open={detailsOpen} labelledBy={titleId} onClose={requestClose} className="overflow-clip bg-transparent p-0">
        <div className={cx('details-backdrop absolute inset-0 bg-black/65', detailsVisible && 'details-backdrop-visible')} />
        <div className={cx('anime-details-frame absolute inset-0 flex items-center justify-center transition-opacity duration-200 ease-out', detailsVisible ? 'opacity-100' : 'opacity-0')} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
          <aside className="anime-details-panel flex min-h-0 min-w-0 w-full max-w-[864px] flex-col overflow-hidden rounded-2xl bg-canvas shadow-[0_24px_60px_rgba(0,0,0,.45)]">
            <div className={cx('anime-details-hero relative shrink-0 border-b border-line', group.banner && 'anime-details-hero-art')}>
              {group.banner && <div className="anime-details-banner pointer-events-none absolute inset-0 bg-panel bg-cover bg-center" style={{ backgroundImage: `url('${group.banner}')` }} aria-hidden="true"/>}
            <header className="anime-details-header relative flex items-start">
              {group.image && <img src={group.image} alt="" className="h-14 w-10 shrink-0 rounded-md object-cover max-[600px]:hidden"/>}
              <div className="min-w-0 flex-1"><h2 id={titleId} className="m-0 text-2xl leading-tight font-extrabold tracking-tight wrap-anywhere max-[600px]:text-xl">{group.title}</h2><p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">{group.arr} · {seasonCount} {group.arr === 'Radarr' ? (seasonCount === 1 ? 'movie' : 'movies') : (seasonCount === 1 ? 'season' : 'seasons')} · {STATUS_LABEL[group.status]}</p></div>
              <button ref={closeRef} type="button" className="anime-details-close grid shrink-0 cursor-pointer place-items-center rounded-control border border-line-strong bg-panel text-ink hover:bg-panel-raised" onClick={requestClose} aria-label="Close details"><Icon name="close"/></button>
            </header>
              {group.banner && <div className="anime-details-art-reveal" aria-hidden="true"/>}
            </div>
            <div className="anime-details-body app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="anime-details-content space-y-5">
                {detailIndex.length > 1 && <nav className="details-index space-y-2" aria-label="Season and cour navigation">
                  {nextUpgrade && <button type="button" className={cx(buttonBase, 'min-h-11 min-w-0 max-w-full border-accent/40 bg-accent/10 px-3 text-xs text-accent-bright')} onClick={() => jumpToDetails(nextUpgrade.id)}><Icon name="arrow-up" size={15}/><span className="min-w-0 wrap-anywhere">Next upgrade: {nextUpgrade.name}</span></button>}
                  <details><summary className="touch-target cursor-pointer py-2 text-sm font-semibold text-ink">Browse {group.arr === 'Radarr' ? 'movies' : 'seasons & cours'}</summary><div className="details-index-links mt-2 grid gap-2">{detailIndex.map(entry => <button key={entry.id} type="button" className="min-w-0 cursor-pointer rounded-lg border border-line bg-panel px-3 py-2 text-left hover:bg-panel-raised" onClick={() => jumpToDetails(entry.id)}><span className="block text-sm font-semibold text-ink wrap-anywhere">{entry.name}</span><span className="block text-xs text-muted wrap-anywhere">{entry.status}</span></button>)}</div></details>
                </nav>}
                {group.status === 'review' && managementLinks}
                {group.seasons.map((season, index) => <Season
                  key={season.key}
                  sectionId={`${titleId}-season-${index}`}
                  r={season}
                  config={config}
                  dl={dlBySeason[season.key] || {}}
                  busyDownload={busyDownload}
                  onDownload={(release) => void handleDownload(season.key, release)}
                  onPause={(entry) => void handleDownloadAction(entry, 'pause')}
                  onResume={(entry) => void handleDownloadAction(entry, 'resume')}
                  onRemove={(entry) => { setDeleteFiles(false); setRemoveTarget(entry) }}
                  ruleBusy={ruleBusy}
                  onToggleExclusion={(part, excluded) => void toggleExclusion(season, part, excluded)}
                />)}
                {group.status !== 'review' && <details className="details-management border-t border-line pt-3"><summary className="touch-target cursor-pointer py-2 text-sm font-semibold text-muted">Links & matching</summary><div className="mt-2">{managementLinks}</div></details>}
              </div>
            </div>
          </aside>
        </div>
      </Modal>
    )}
    <ConfirmDialog
      open={removeTarget !== null}
      title="Remove torrent?"
      description="The torrent will be removed from qBittorrent. Its downloaded files are kept unless you choose to delete them below."
      confirmLabel="Remove torrent"
      dangerous
      onConfirm={async () => { if (removeTarget && !await handleDownloadAction(removeTarget, 'remove', deleteFiles)) throw new Error('Could not remove this torrent. Please retry or open qBittorrent to manage it.') }}
      onClose={() => { setRemoveTarget(null); setDeleteFiles(false) }}
    >
      <label className="mb-5 flex cursor-pointer items-center gap-3 rounded-xl border border-bad/25 bg-bad/7 p-3 text-sm text-ink">
        <input type="checkbox" className="size-4 accent-bad" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} />
        <span><span className="block font-bold text-bad">Also delete downloaded files</span><span className="mt-0.5 block text-xs text-muted">This cannot be undone.</span></span>
      </label>
    </ConfirmDialog>
    <MappingDialog open={mappingOpen} title={group.title} currentAniListId={group.anilist_id} hasOverride={group.seasons.some((season) => season.mapping_override)} onApply={applyMapping} onClose={() => setMappingOpen(false)}/>
  </>
}

export default memo(Card)

interface SeasonProps {
  sectionId: string
  r: ResultItem
  config: Config | null
  dl: Record<number, DlState>
  busyDownload: string | null
  onDownload: (release: number) => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
  ruleBusy: string
  onToggleExclusion: (part: string, excluded: boolean) => void
}

interface DisplayRelease {
  rel: Release
  index: number
}

/** Live download state for one release row (keyed by its release index). */
type DlState = DetailsDownloadState

const IDLE_DL: DlState = IDLE_DOWNLOAD

function indexedReleases(releases: Release[]): DisplayRelease[] {
  return releases.map((rel, index) => ({ rel, index }))
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

function Season({ sectionId, r, config, dl, busyDownload, onDownload, onPause, onResume, onRemove, ruleBusy, onToggleExclusion }: SeasonProps) {
  const groups = groupByCour(indexedReleases(r.releases || []))
  const split = groups.some(group => group.part)
  const displaySeasonHave = !r.precise_part_ownership || !split
  const sources = (r.urls?.length ? r.urls : r.url ? [{ label: 'seadex.moe', url: r.url }] : []).filter(source => source.label === 'seadex.moe')
  const seasonName = detailsSeasonName(r)
  const ignored = Boolean(r.excluded)
  const unavailable = r.status === 'missing' || r.status === 'uncovered'

  return (
    <section id={sectionId} tabIndex={-1} className="details-season min-w-0 border-t border-line pt-6 first:border-t-0 first:pt-0" aria-label={seasonName}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-44">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-lg font-bold tracking-tight">{seasonName}</h3>
            <span className="rounded-full border border-line-strong bg-panel px-2 py-1 text-xs font-semibold text-ink">{detailsStatus(r)}</span>
          </div>
          <p className="m-0 text-xs text-muted wrap-anywhere">{displaySeasonHave ? 'Current release: ' + (r.have.length ? r.have.join(', ') : 'None') : 'Split into ' + groups.length + ' cours'}{(r.missing_episode_count || 0) > 0 && <span className="text-warn"> · {r.missing_episode_count} episode{r.missing_episode_count === 1 ? '' : 's'} missing</span>}</p>
        </div>
        {sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex <Icon name="chevron-right" size={14}/></a>)}
        <button type="button" className={cx(buttonBase, 'min-h-11 min-w-0 max-w-full justify-center px-3 text-xs', ignored ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line-strong bg-panel text-ink hover:bg-panel-raised')} aria-pressed={ignored} aria-label={(ignored ? 'Include ' : 'Ignore ') + seasonName + ' in bulk downloads and notifications'} title={!r.library_key ? 'Run a new scan to enable season rules' : undefined} disabled={!r.library_key || Boolean(ruleBusy)} onClick={() => onToggleExclusion('', !ignored)}><Icon name="ban" size={15}/><span className="min-w-0 wrap-anywhere">{ignored ? 'Ignored for bulk' : 'Ignore for bulk'}</span></button>
      </div>

      {unavailable ? <p className="m-0 rounded-lg border border-dashed border-line-strong bg-panel px-4 py-3 text-sm text-muted">{r.status === 'uncovered' ? 'This season is not covered on seadex.moe' : r.match_status === 'unmatched' || !r.anilist_id ? 'AniList match needs review. Use Correct match to choose the right anime.' : 'Not listed on seadex.moe'}</p> : <>
        {!!r.unavailable_parts?.length && <div className="mb-4 flex flex-wrap items-start gap-2 rounded-lg border border-warn/35 bg-warn/8 px-3 py-2 text-xs text-warn" role="status"><Icon name="alert" size={15}/><div className="min-w-0 flex-1"><strong>Unavailable:</strong> {r.unavailable_parts.map(part => <span key={part.label + ':' + part.reason} className="block wrap-anywhere">{part.label} · {part.reason}</span>)}</div></div>}
        {groups.length === 0 && <p className="m-0 text-sm text-muted">No release details are available. Run a new library scan to refresh this title.</p>}
        {!split && <RecommendationNotes notes={r.notes}/>}
        {groups.map((group, groupIndex) => {
          const partIgnored = ignored || Boolean(r.excluded_parts?.includes(group.part))
          const owned = r.precise_part_ownership ? r.have_by_part?.[group.part] || [] : []
          const partSources = (r.urls || []).filter(source => source.label === group.part)
          return <div id={`${sectionId}-cour-${groupIndex}`} tabIndex={-1} key={group.part || 'all'} className={cx('details-cour min-w-0', groupIndex > 0 && 'mt-5 border-t border-line pt-5')}>
            {group.part && <div className="mb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1"><h4 className="m-0 text-sm font-bold">{group.part}</h4>{r.precise_part_ownership && <p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">{owned.length ? 'Current release: ' + owned.join(', ') : 'No matching files owned'}</p>}</div>
                <button type="button" className={cx(buttonBase, 'min-h-11 justify-center px-3 text-xs', partIgnored ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line-strong bg-panel text-ink hover:bg-panel-raised')} aria-pressed={partIgnored} aria-label={(partIgnored ? 'Include ' : 'Ignore ') + group.part + ' in bulk downloads and notifications'} title={ignored ? 'Restore the season to change individual cour rules.' : undefined} disabled={!r.library_key || ignored || Boolean(ruleBusy)} onClick={() => onToggleExclusion(group.part, !partIgnored)}><Icon name="ban" size={15}/>{partIgnored ? 'Ignored for bulk' : 'Ignore for bulk'}</button>
              </div>
              {partSources.length > 0 && <div className="mt-1 flex flex-wrap gap-2">{partSources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex · {group.part}<Icon name="chevron-right" size={14}/></a>)}</div>}
            </div>}
            {group.part && <RecommendationNotes notes={r.notes_by_part?.[group.part]}/>}
            <div className="mt-3 flex min-w-0 flex-col gap-3">{group.items.map(({ rel, index }) => {
              const state = dl[index] || IDLE_DL
              const ownedGroups = r.precise_part_ownership ? r.owned_by_part?.[rel.part || ''] || [] : r.have
              const ownedRelease = ownedGroups.some(name => name.toLowerCase() === rel.releaseGroup.toLowerCase())
              const summarize = state.phase === 'idle' && (ownedRelease || !rel.downloadable)
              const content = <ReleaseDetails result={r} release={rel} index={index} config={config} state={state} busy={busyDownload !== null} onDownload={() => onDownload(index)} onPause={onPause} onResume={onResume} onRemove={onRemove}/>
              return summarize ? <details key={index} className="owned-release-summary rounded-lg border border-line bg-panel px-3 py-2"><summary className="touch-target cursor-pointer py-1 text-sm text-muted wrap-anywhere"><span className="font-semibold text-ink">{rel.releaseGroup}</span> · {rel.kind === 'best' ? 'BEST' : 'ALTERNATIVE'} · {ownedRelease ? 'Already owned' : 'Individual download unavailable'}</summary><div className="mt-3">{content}</div></details> : <div key={index}>{content}</div>
            })}</div>
          </div>
        })}
      </>}
    </section>
  )
}
