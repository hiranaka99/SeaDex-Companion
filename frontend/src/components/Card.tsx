import { useCardDownloads } from '../useCardDownloads'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { GroupedCard, ResultItem, Config } from '../types'
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
import DetailsSeason, { detailsSeasonName } from './DetailsSeason'
import { QUALITY_ICONS } from './DetailsQuality'
import { releaseOverview, releaseQuality } from '../release-status'
import { groupReleaseChanges } from '../release-changes'
import { RELEASE_CHANGE_LABELS } from '../../../shared/release-changes'

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
  reviewingChanges: boolean
  onReviewChanges: (ids: string[]) => Promise<void>
}

const HIDE_DURATION_MS = 280

function jumpToDetails(id: string) {
  const target = document.getElementById(id)
  const body = target?.closest<HTMLElement>('.anime-details-body')
  if (!target || !body) return
  let ancestor: HTMLElement | null = target
  while (ancestor && ancestor !== body) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement
  }
  const disclosure = target.querySelector<HTMLDetailsElement>(':scope > .details-season-disclosure')
  if (disclosure) disclosure.open = true
  window.requestAnimationFrame(() => {
    const top = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top
    body.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    target.focus({ preventScroll: true })
  })
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
function Card({ active, openRequested, onOpened, group, index, config, hidden = false, onToggle, onRulesChanged, onRescan, reviewingChanges, onReviewChanges }: CardProps) {
  const [hiding, setHiding] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<DownloadEntry | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [mappingSeason, setMappingSeason] = useState<ResultItem | null>(null)
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
  const unseenChanges = useMemo(() => groupReleaseChanges(group), [group.seasons])
  const changeIds = unseenChanges.map(({ change }) => change.id)
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

  const applyMapping = async (anilistIds: number[] | null) => {
    const libraryKey = mappingSeason?.library_key || group.seasons[0]?.library_key
    if (!libraryKey) throw new Error('Run a new scan before correcting this match')
    if (mappingSeason?.season) await api.setSeasonMappingOverride(libraryKey, mappingSeason.season, anilistIds)
    else await api.setMappingOverride(libraryKey, anilistIds?.[0] ?? null)
    setMappingOpen(false)
    toast.show(anilistIds ? `AniList match saved${mappingSeason ? ` for ${detailsSeasonName(mappingSeason)}` : ''}; rescanning library` : 'Automatic AniList matching restored; rescanning library', 'success')
    onRescan()
  }

  const statusBadge = <div className="library-status-badge" data-library-status={group.status}>
    <span className="library-status-label"><Icon name={CARD_STATUS[group.status].icon} size={14} className="shrink-0"/><span>{STATUS_LABEL[group.status]}</span></span>
    {group.status === 'partial' && upgradableSeasonCount > 0 && <span className="library-status-upgrades"><Icon name="arrow-up" size={13} className="shrink-0"/><span>{upgradableSeasonCount} {group.arr === 'Radarr' ? (upgradableSeasonCount === 1 ? 'movie' : 'movies') : (upgradableSeasonCount === 1 ? 'season' : 'seasons')} upgradable</span></span>}
  </div>

  const overview = releaseOverview(group.seasons, group.arr)
  const reviewIndex = group.seasons.findIndex(season => releaseQuality(season).kind === 'review')
  const actionIndex = reviewIndex >= 0 ? reviewIndex : group.seasons.findIndex(isSeasonUpgradable)
  const managementLinks = detailsOpen ? <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Anime links">{group.arr_url && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={group.arr_url} target="_blank" rel="noopener"><Icon name="server" size={15}/>Open in {group.arr}</a>}{typeof group.anilist_id === 'number' && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">Open in AniList <Icon name="chevron-right" size={14}/></a>}<button type="button" className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-muted hover:bg-panel-raised hover:text-ink')} onClick={() => { setMappingSeason(null); setMappingOpen(true) }} disabled={!group.seasons[0]?.library_key} title={!group.seasons[0]?.library_key ? 'Run a new scan to enable manual matching' : undefined}><Icon name="refresh" size={14}/>{group.seasons.some((season) => season.mapping_override) ? 'Change manual match' : 'Correct match'}</button>{group.seasons.some((season) => season.mapping_override) && <span className="rounded-full border border-purple/35 bg-purple/10 px-2 py-1 text-xs font-bold text-ink">Manual match</span>}</nav> : null

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
      {unseenChanges.length > 0 && <div className="library-unseen-summary mx-3.5 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 max-[600px]:mx-3" aria-label={`Unseen changes for ${group.title}`}>
        <div className="min-w-0 flex-1 space-y-1">{unseenChanges.slice(0, 2).map(({ season, change }) => <p key={change.id} className="m-0 text-xs font-semibold text-accent-bright wrap-anywhere">{RELEASE_CHANGE_LABELS[change.kind]} · {seasonLabel(season)}{change.part ? ` · ${change.part}` : ''}</p>)}{unseenChanges.length > 2 && <p className="m-0 text-xs text-muted">+{unseenChanges.length - 2} more in Details</p>}</div>
        <button type="button" className="touch-target cursor-pointer rounded-lg px-2 py-2 text-xs font-semibold text-muted hover:bg-panel-raised hover:text-ink disabled:cursor-wait disabled:opacity-60" aria-label={`Mark changes for ${group.title} reviewed`} disabled={reviewingChanges} onClick={() => void onReviewChanges(changeIds)}>Mark reviewed</button>
      </div>}
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
          <aside className="anime-details-panel flex min-h-0 min-w-0 w-full max-w-[736px] flex-col overflow-hidden rounded-2xl bg-canvas shadow-[0_24px_60px_rgba(0,0,0,.45)]">
            <div className={cx('anime-details-hero relative shrink-0 border-b border-line', group.banner && 'anime-details-hero-art')}>
              {group.banner && <div className="anime-details-banner pointer-events-none absolute inset-0 bg-panel bg-cover bg-center" style={{ backgroundImage: `url('${group.banner}')` }} aria-hidden="true"/>}
            <header className="anime-details-header relative flex items-start">
              {group.image && <img src={group.image} alt="" className="anime-details-cover"/>}
              <div className="min-w-0 flex-1"><h2 id={titleId} className="m-0 text-2xl leading-tight font-extrabold tracking-tight wrap-anywhere max-[600px]:text-xl">{group.title}</h2><p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">{group.arr} · {seasonCount} {group.arr === 'Radarr' ? (seasonCount === 1 ? 'movie' : 'movies') : (seasonCount === 1 ? 'season' : 'seasons')}</p></div>
              <button ref={closeRef} type="button" className="anime-details-close grid shrink-0 cursor-pointer place-items-center rounded-control border border-line-strong bg-panel text-ink hover:bg-panel-raised" onClick={requestClose} aria-label="Close details"><Icon name="close"/></button>
            </header>
            </div>
            <div className="anime-details-body app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="anime-details-content">
                <section className="details-verdict" data-quality={overview.kind} aria-label="Release quality summary">
                  <Icon name={QUALITY_ICONS[overview.kind]} size={26} className="shrink-0"/>
                  <div className="min-w-0 flex-1"><h3 className="m-0 text-lg font-extrabold tracking-tight wrap-anywhere">{overview.title}</h3><p className="mt-1 mb-0 text-xs wrap-anywhere">{overview.description}</p></div>
                  {actionIndex >= 0 && <div className="details-index"><button type="button" className={cx(buttonBase, 'min-h-11 border-accent/40 bg-accent/10 px-3 text-xs text-accent-bright')} onClick={() => jumpToDetails(`${titleId}-season-${actionIndex}`)}><Icon name={reviewIndex >= 0 ? 'refresh' : 'arrow-up'} size={15}/>{reviewIndex >= 0 ? 'Review match' : 'Review upgrade'}</button></div>}
                </section>
                {unseenChanges.length > 0 && <details className="details-changes mb-5 border-b border-line pb-3" aria-label="What changed"><summary className="touch-target cursor-pointer py-2 text-sm font-semibold text-accent-bright">What changed ({unseenChanges.length})</summary><section className="pt-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-bold text-ink">What changed <span className="font-normal text-muted">({unseenChanges.length})</span></h3><button type="button" className={cx(buttonBase, 'border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised')} disabled={reviewingChanges} onClick={() => void onReviewChanges(changeIds)}>{reviewingChanges ? 'Marking reviewed…' : 'Mark reviewed'}</button></div>
                  <ul className="m-0 list-none space-y-3 p-0">{unseenChanges.map(({ season, change }) => <li key={change.id} className="min-w-0 text-sm wrap-anywhere"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="font-semibold text-accent-bright">{RELEASE_CHANGE_LABELS[change.kind]}</span><span className="text-xs text-muted">{seasonLabel(season)}{change.part ? ` · ${change.part}` : ''}</span><time className="text-xs text-muted" dateTime={change.detected_at}>Detected {new Date(change.detected_at).toLocaleString()}</time></div><p className="mt-1 mb-0 max-w-[70ch] text-muted">{change.description}</p></li>)}</ul>
                </section></details>}
                <div className="details-list-heading"><h3 className="m-0 text-sm font-bold">Your {group.arr === 'Radarr' ? 'movies' : 'seasons'}</h3><span className="text-xs text-muted max-[600px]:hidden">Expand for release details</span></div>
                {group.status === 'review' && managementLinks}
                {group.seasons.map((season, index) => <DetailsSeason
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
                  onCorrectMatch={() => { setMappingSeason(season); setMappingOpen(true) }}
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
    <MappingDialog open={mappingOpen} title={group.title} season={mappingSeason?.season || undefined} currentAniListId={mappingSeason ? mappingSeason.anilist_id : group.anilist_id} currentAniListIds={mappingSeason?.anilist_ids} hasOverride={mappingSeason ? Boolean(mappingSeason.season_mapping_override) : group.seasons.some((season) => season.mapping_override)} onApply={applyMapping} onClose={() => setMappingOpen(false)}/>
  </>
}

export default memo(Card)
