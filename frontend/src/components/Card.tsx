import { errorMessage } from '../../../shared/errors.js'
import { useReleaseActions } from '../useReleaseActions'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { GroupedCard, ResultItem, Config } from '../types'
import { upgradeAvailable } from '../../../shared/download-plan'
import { seasonLabel, STATUS_LABEL, cardSizeDelta, formatBytes } from '../utils'
import { displayDateTimeMinutes } from '../datetime'
import * as api from '../api'
import { buttonBase, cx } from '../styles'
import Icon from './Icons'
import BrandLogo from './BrandLogo'
import { useToast } from './Toast'
import DownloadsPanel from './DownloadsPanel'
import { clientName, type DownloadEntry } from '../download-entry'
import ConfirmDialog from './ConfirmDialog'
import ErrorBoundary from './ErrorBoundary'
import Modal from './Modal'

import MappingDialog from './MappingDialog'
import SeasonBadge from './SeasonBadge'
import LibrarySizeChange from './LibrarySizeChange'
import DetailsSeason, { detailsSeasonName } from './DetailsSeason'
import { QUALITY_ICONS } from './DetailsQuality'
import type { IconName as QualityIconName } from './Icons'
import { releaseOverview, releaseQuality } from '../release-status'
import { groupReleaseChanges, presentReleaseChange } from '../release-changes'
import ReleaseChangeLine from './ReleaseChangeLine'
import { STATUS_PRESENTATION } from '../status-presentation'

interface CardProps {
  active: boolean
  openRequested?: boolean
  onOpened?: () => void
  group: GroupedCard
  index: number
  config: Config | null
  onRulesChanged: () => Promise<void>
  onRescan: () => void
  reviewingChanges: boolean
  onReviewChanges: (ids: string[]) => Promise<void>
}

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
  // The cours that need a decision open too, so the jump lands on releases instead of more summaries.
  for (const cour of target.querySelectorAll<HTMLDetailsElement>('.details-cour[data-needs-action]')) cour.open = true
  window.requestAnimationFrame(() => {
    const top = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top
    body.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    target.focus({ preventScroll: true })
    // A short tint marks where the jump landed, then fades instead of leaving a focus ring around the section.
    target.classList.remove('details-landing')
    // Reading offsetWidth forces a reflow so the animation restarts when the class is added again.
    // oxlint-disable-next-line typescript/no-meaningless-void-operator -- the read is the side effect.
    void target.offsetWidth
    target.classList.add('details-landing')
    target.addEventListener('animationend', () => target.classList.remove('details-landing'), { once: true })
  })
}

const CARD_BASE =
  'group/card relative flex flex-col overflow-hidden rounded-card border border-line bg-panel transition-opacity duration-200'
function Card({
  active,
  openRequested,
  onOpened,
  group,
  index,
  config,
  onRulesChanged,
  onRescan,
  reviewingChanges,
  onReviewChanges,
}: CardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<DownloadEntry | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [mappingSeason, setMappingSeason] = useState<ResultItem | null>(null)
  const [ruleBusy, setRuleBusy] = useState('')
  const closing = useRef(false)
  const openFrame = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const copyRef = useRef<HTMLDivElement>(null)
  const [copyOverflows, setCopyOverflows] = useState(false)
  const toast = useToast()
  const srcClass = group.arr === 'Sonarr' ? 'sonarr' : 'radarr'
  // An additional instance is named on the card, so the same anime in two libraries can be told apart.
  const namedSource = group.source !== group.arr
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
    if (!active) {
      setDetailsOpen(false)
      setMappingOpen(false)
      setRemoveTarget(null)
    } else if (openRequested) {
      handleOpenDetails()
      onOpened?.()
    }
  }, [active, openRequested])
  const detailsShown = useRef(false)
  detailsShown.current = detailsOpen && !closing.current
  const {
    activeDownloads,
    busyDownload,
    handleDownloadAction,
    season: seasonActions,
  } = useReleaseActions(group, config, {
    notify: toast.show,
    detailsOpen: detailsOpen && !closing.current,
    detailsShown: () => detailsShown.current,
    onRemove: entry => {
      setDeleteFiles(false)
      setRemoveTarget(entry)
    },
  })

  const seasonCount = group.seasons.length
  const unseenChanges = useMemo(() => groupReleaseChanges(group), [group.seasons])
  const changeIds = unseenChanges.map(({ change }) => change.id)
  const upgradableSeasonCount = group.seasons.filter(upgradeAvailable).length
  const delta = cardSizeDelta(group)

  useEffect(() => {
    return () => {
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
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [detailsOpen])

  const handleOpenDetails = () => {
    setDetailsVisible(false)
    setDetailsOpen(true)
  }
  const handleSeasonSelect = (index: number) => {
    handleOpenDetails()
    window.setTimeout(() => jumpToDetails(`${titleId}-season-${index}`), 280)
  }

  const toggleExclusion = async (season: ResultItem, part: string, excluded: boolean) => {
    if (!season.library_key) return
    const id = `${season.key}:${part || '*'}`
    setRuleBusy(id)
    try {
      await api.setExclusion(season.library_key, season.season, part, excluded)
      await onRulesChanged()
      toast.show(
        `${part || seasonLabel(season)} ${excluded ? 'ignored' : 'restored'} for bulk downloads and notifications`,
        'success',
      )
    } catch (error) {
      toast.show('Could not update the exclusion: ' + errorMessage(error), 'error')
    } finally {
      setRuleBusy('')
    }
  }

  const applyMapping = async (anilistIds: number[] | null) => {
    const libraryKey = mappingSeason?.library_key || group.seasons[0]?.library_key
    if (!libraryKey) throw new Error('Run a new scan before correcting this match')
    if (mappingSeason?.season) await api.setSeasonMappingOverride(libraryKey, mappingSeason.season, anilistIds)
    else await api.setMappingOverride(libraryKey, anilistIds?.[0] ?? null)
    setMappingOpen(false)
    toast.show(
      anilistIds
        ? `AniList match saved${mappingSeason ? ` for ${detailsSeasonName(mappingSeason)}` : ''}; rescanning library`
        : 'Automatic AniList matching restored; rescanning library',
      'success',
    )
    onRescan()
  }

  // SeaDex does list these seasons; the saved preferences exclude every release, which is not the same as unlisted.
  const outsidePreferences = group.status === 'missing' && group.seasons.every(season => season.preference_blocked)
  // Likewise, seasons SeaDex lists only on private trackers are listed, just not in public-tracker mode.
  const privateOnly = group.status === 'missing' && group.seasons.every(season => season.private_only)
  const statusBadge = (
    <div className="library-status-badge" data-library-status={group.status}>
      <span className="library-status-label">
        <Icon name={STATUS_PRESENTATION[group.status].icon} size={14} className="shrink-0" />
        <span>
          {outsidePreferences
            ? 'Outside your preferences'
            : privateOnly
              ? 'No public release'
              : STATUS_LABEL[group.status]}
        </span>
      </span>
      {group.status === 'partial' && upgradableSeasonCount > 0 && (
        <span className="library-status-upgrades">
          <Icon name="arrow-up" size={13} className="shrink-0" />
          <span>
            {upgradableSeasonCount}{' '}
            {group.arr === 'Radarr'
              ? upgradableSeasonCount === 1
                ? 'movie'
                : 'movies'
              : upgradableSeasonCount === 1
                ? 'season'
                : 'seasons'}{' '}
            upgradable
          </span>
        </span>
      )}
    </div>
  )

  const overview = releaseOverview(group.seasons, group.arr)
  const unit = group.arr === 'Radarr' ? 'movie' : 'season'
  const qualities = group.seasons.map(season => releaseQuality(season))
  const indexesWhere = (keep: (index: number) => boolean) => group.seasons.map((_, index) => index).filter(keep)
  const reviewTargets = indexesWhere(index => qualities[index].kind === 'review')
  const upgradeTargets = indexesWhere(
    index => upgradeAvailable(group.seasons[index]) && qualities[index].kind !== 'review',
  )
  // The summary's button walks the seasons that explain it, in the order the summary names them.
  const action: { targets: number[]; label: string; icon: QualityIconName } | null = reviewTargets.length
    ? {
        targets: reviewTargets,
        label: reviewTargets.length === 1 ? 'Review match' : `Review ${reviewTargets.length} matches`,
        icon: 'refresh',
      }
    : upgradeTargets.length
      ? {
          targets: upgradeTargets,
          label: upgradeTargets.length === 1 ? 'Review upgrade' : `Review ${upgradeTargets.length} upgrades`,
          icon: 'arrow-up',
        }
      : overview.kind === 'partial' || overview.kind === 'incomplete'
        ? (() => {
            const targets = indexesWhere(index => qualities[index].kind === overview.kind)
            if (!targets.length) return null
            return {
              targets,
              label:
                overview.kind === 'incomplete'
                  ? 'Show missing episodes'
                  : `Check ${targets.length === 1 ? unit : `${targets.length} ${unit}s`}`,
              icon: QUALITY_ICONS[overview.kind],
            }
          })()
        : null
  const sectionId = (index: number) => `${titleId}-season-${index}`
  // Seasons waiting on a decision open with the modal, and so does a title's only season.
  const decisionTargets = new Set([...reviewTargets, ...upgradeTargets])
  const nextActionFor = (index: number) => {
    if (!action) return null
    const position = action.targets.indexOf(index)
    const next = position >= 0 ? action.targets[position + 1] : undefined
    return next === undefined ? null : { id: sectionId(next), label: detailsSeasonName(group.seasons[next]) }
  }
  const missingEpisodes = group.seasons.reduce((sum, season) => sum + (season.missing_episode_count || 0), 0)
  const verdictFacts = [
    delta > 0 && `+${formatBytes(delta)} if upgraded`,
    missingEpisodes > 0 && overview.kind !== 'incomplete' && `${missingEpisodes} episodes missing`,
    overview.kind === 'incomplete' && `${missingEpisodes} episode${missingEpisodes === 1 ? '' : 's'} missing`,
    overview.description,
  ]
    .filter(Boolean)
    .join(' · ')
  const manualMatch = group.seasons.some(season => season.mapping_override)
  const titleLink =
    'touch-target inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-accent-bright hover:bg-panel-raised hover:no-underline'
  const managementLinks = detailsOpen ? (
    <nav className="anime-details-links" aria-label="Anime links">
      {group.arr_url && (
        <a className={titleLink} href={group.arr_url} target="_blank" rel="noopener">
          <Icon name="server" size={14} />
          Open in {group.source}
          <span className="sr-only"> (new tab)</span>
        </a>
      )}
      {typeof group.anilist_id === 'number' && (
        <a className={titleLink} href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">
          AniList
          <Icon name="chevron-right" size={14} />
          <span className="sr-only"> (new tab)</span>
        </a>
      )}
      <button
        type="button"
        className={cx(
          titleLink,
          'cursor-pointer text-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-60',
        )}
        onClick={() => {
          setMappingSeason(null)
          setMappingOpen(true)
        }}
        disabled={!group.seasons[0]?.library_key}
        aria-describedby={!group.seasons[0]?.library_key ? `${titleId}-match-hint` : undefined}
      >
        <Icon name="refresh" size={14} />
        {manualMatch ? 'Change manual match' : 'Correct match'}
      </button>
      {manualMatch && (
        <span className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-panel-raised px-2 py-0.5 text-xs font-semibold text-ink">
          Manual match
        </span>
      )}
      {!group.seasons[0]?.library_key && (
        <span id={`${titleId}-match-hint`} className="basis-full text-xs text-muted">
          Run a new scan to enable manual matching.
        </span>
      )}
    </nav>
  ) : null

  return (
    <>
      <article
        data-library-key={group.key}
        data-library-status={group.status}
        data-needs-action={group.status === 'review' || upgradableSeasonCount > 0 ? 'true' : 'false'}
        className={cx(CARD_BASE, 'library-card-readable')}
      >
        <div className={cx('library-card-body', st === 'missing' && 'grayscale')}>
          <div className="library-card-poster">
            <span className="absolute inset-0 grid place-items-center text-muted-dim" aria-hidden="true">
              <Icon name="library" size={32} />
            </span>
            {group.image && (
              <img
                className="absolute inset-0 h-full w-full object-cover"
                src={group.image}
                alt=""
                loading={index < 4 ? 'eager' : 'lazy'}
                decoding="async"
                onError={event => {
                  event.currentTarget.style.display = 'none'
                }}
              />
            )}
          </div>
          <div className="library-card-info">
            {group.banner && (
              <img
                src={group.banner}
                alt=""
                loading={index < 4 ? 'eager' : 'lazy'}
                decoding="async"
                className="library-card-banner"
                onError={event => {
                  event.currentTarget.style.display = 'none'
                }}
              />
            )}
            <div
              ref={copyRef}
              className="library-card-copy app-scrollbar"
              tabIndex={copyOverflows ? 0 : undefined}
              role={copyOverflows ? 'group' : undefined}
              aria-label={copyOverflows ? `${group.title}: scroll to read the full title` : undefined}
            >
              <h3
                className="anime-art-title relative m-0 text-lg leading-snug font-bold text-white wrap-anywhere"
                title={group.title}
              >
                {group.title}
              </h3>
            </div>
            <div className="library-status-banner app-scrollbar">{statusBadge}</div>
          </div>
        </div>
        <div
          className="library-card-seasons flex flex-wrap gap-1.5 px-3.5 pb-3.5 max-[600px]:px-3 max-[600px]:pb-3"
          role="group"
          aria-label={`${group.title}: ${seasonCount} ${unit}${seasonCount === 1 ? '' : 's'}`}
        >
          {group.seasons.slice(0, 6).map((season, seasonIndex) => (
            <SeasonBadge
              key={season.key}
              season={season}
              onSelect={() => handleSeasonSelect(seasonIndex)}
              fallback={st}
              animeTitle={group.title}
              className="rounded-md border px-2 py-1 text-xs font-extrabold"
            />
          ))}
          {seasonCount > 6 && (
            <button
              type="button"
              className="relative cursor-pointer rounded-md border border-line bg-panel-raised px-2 py-1 text-xs font-bold text-muted hover:text-ink"
              onClick={handleOpenDetails}
              title={`View all ${seasonCount} seasons in Details`}
            >
              +{seasonCount - 6}
              <span className="sr-only"> more seasons; open Details to view all {seasonCount} seasons</span>
            </button>
          )}
        </div>
        {unseenChanges.length > 0 && (
          <div
            className="library-unseen-summary mx-3.5 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 max-[600px]:mx-3"
            aria-label={`Unseen changes for ${group.title}`}
          >
            <div className="min-w-0 flex-1 space-y-1">
              {unseenChanges.slice(0, 2).map(({ season, change }) => (
                <ReleaseChangeLine
                  key={change.id}
                  detail={presentReleaseChange(change)}
                  context={seasonLabel(season)}
                />
              ))}
              {unseenChanges.length > 2 && (
                <p className="m-0 text-xs text-muted">+{unseenChanges.length - 2} more in Details</p>
              )}
            </div>
            <button
              type="button"
              className="touch-target cursor-pointer rounded-lg px-2 py-2 text-xs font-semibold text-muted hover:bg-panel-raised hover:text-ink disabled:cursor-wait disabled:opacity-60"
              aria-label={`Mark changes for ${group.title} reviewed`}
              disabled={reviewingChanges}
              onClick={() => void onReviewChanges(changeIds)}
            >
              Mark reviewed
            </button>
          </div>
        )}
        {activeDownloads.length > 0 && (
          <div className="border-t border-line px-3.5 py-3 max-[600px]:px-3">
            <DownloadsPanel
              downloads={activeDownloads}
              busyId={busyDownload}
              onPause={entry => void handleDownloadAction(entry, 'pause')}
              onResume={entry => void handleDownloadAction(entry, 'resume')}
              onRemove={entry => {
                setDeleteFiles(false)
                setRemoveTarget(entry)
              }}
            />
          </div>
        )}
        <footer className="mt-auto flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3.5 py-3 max-[600px]:px-3">
          <div className="flex min-w-0 grow basis-24 flex-wrap items-center gap-x-2 gap-y-1 wrap-anywhere">
            {delta !== 0 ? (
              <LibrarySizeChange delta={delta} title={group.title} note={delta > 0 ? 'if upgraded' : undefined} />
            ) : (
              <span className="text-xs text-muted-dim">
                {seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}
              </span>
            )}
            {group.seasons.some(season => (season.missing_episode_count || 0) > 0) && (
              <span className="text-xs text-warn">
                {group.seasons.reduce((sum, season) => sum + (season.missing_episode_count || 0), 0)} episodes missing
              </span>
            )}
          </div>
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
            {group.arr_url ? (
              <a
                className={cx(
                  'library-card-source touch-target shrink-0 rounded-lg transition-colors hover:bg-panel-raised',
                  namedSource
                    ? 'inline-flex h-8 max-w-36 items-center gap-1.5 px-1.5 hover:no-underline'
                    : 'grid size-8 place-items-center',
                )}
                href={group.arr_url}
                target="_blank"
                rel="noopener"
                title={`Open ${group.title} in ${group.source}`}
                aria-label={`Open ${group.title} in ${group.source} (new tab)`}
              >
                <BrandLogo name={srcClass} size={20} />
                {namedSource && (
                  <span className="min-w-0 truncate text-xs font-semibold text-muted">{group.source}</span>
                )}
              </a>
            ) : (
              <span
                className={cx(
                  'library-card-source shrink-0 rounded-lg',
                  namedSource
                    ? 'inline-flex h-8 max-w-36 items-center gap-1.5 px-1.5'
                    : 'grid size-8 place-items-center',
                )}
                title={group.source}
                role={namedSource ? undefined : 'img'}
                aria-label={namedSource ? undefined : `Source: ${group.source}`}
              >
                <BrandLogo name={srcClass} size={20} />
                {namedSource && (
                  <span className="min-w-0 truncate text-xs font-semibold text-muted">{group.source}</span>
                )}
              </span>
            )}
            <button
              className="touch-target inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent/10"
              type="button"
              aria-label={`Details for ${group.title}`}
              onClick={handleOpenDetails}
            >
              Details <Icon name="chevron-right" size={15} />
            </button>
          </div>
        </footer>
      </article>
      <ErrorBoundary
        resetKey={detailsOpen}
        onError={() => {
          closing.current = false
          setDetailsVisible(false)
          setDetailsOpen(false)
          toast.show(`Details for ${group.title} could not be shown. Try opening them again.`, 'error')
        }}
      >
        {detailsOpen && (
          <Modal
            open={detailsOpen}
            labelledBy={titleId}
            onClose={requestClose}
            className="overflow-clip bg-transparent p-0"
          >
            <div
              className={cx(
                'details-backdrop absolute inset-0 bg-black/65',
                detailsVisible && 'details-backdrop-visible',
              )}
            />
            <div
              className={cx(
                'anime-details-frame absolute inset-0 flex items-center justify-center transition-opacity duration-200 ease-out',
                detailsVisible ? 'opacity-100' : 'opacity-0',
              )}
              onMouseDown={event => {
                if (event.target === event.currentTarget) requestClose()
              }}
            >
              <aside className="anime-details-panel flex min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-2xl bg-canvas shadow-[0_24px_60px_rgba(0,0,0,.45)]">
                <div
                  className={cx(
                    'anime-details-hero relative shrink-0 border-b border-line',
                    group.banner && 'anime-details-hero-art',
                  )}
                >
                  {group.banner && (
                    <div
                      className="anime-details-banner pointer-events-none absolute inset-0 bg-panel bg-cover bg-center"
                      style={{ backgroundImage: `url('${group.banner}')` }}
                      aria-hidden="true"
                    />
                  )}
                  <header className="anime-details-header relative flex items-start">
                    {group.image && <img src={group.image} alt="" className="anime-details-cover" />}
                    <div className="min-w-0 flex-1">
                      <h2
                        id={titleId}
                        className="m-0 text-2xl leading-tight font-extrabold tracking-tight wrap-anywhere max-[600px]:text-xl"
                      >
                        {group.title}
                      </h2>
                      <p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">
                        {group.source} · {seasonCount}{' '}
                        {group.arr === 'Radarr'
                          ? seasonCount === 1
                            ? 'movie'
                            : 'movies'
                          : seasonCount === 1
                            ? 'season'
                            : 'seasons'}
                      </p>
                      {managementLinks}
                    </div>
                    <button
                      ref={closeRef}
                      type="button"
                      className="anime-details-close grid shrink-0 cursor-pointer place-items-center rounded-control border border-line-strong bg-panel text-ink hover:bg-panel-raised"
                      onClick={requestClose}
                      aria-label="Close details"
                    >
                      <Icon name="close" />
                    </button>
                  </header>
                </div>
                <div className="anime-details-body app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                  <div className="anime-details-content">
                    <section
                      className="details-verdict"
                      data-quality={overview.kind}
                      aria-label="Release quality summary"
                    >
                      <Icon name={QUALITY_ICONS[overview.kind]} size={20} className="details-verdict-icon shrink-0" />
                      <div className="details-verdict-copy min-w-0">
                        <h3 className="m-0 text-base font-extrabold tracking-tight wrap-anywhere">{overview.title}</h3>
                        {verdictFacts && (
                          <p className="details-verdict-facts m-0 text-xs wrap-anywhere">{verdictFacts}</p>
                        )}
                      </div>
                      {/* A title's only season already opens below the summary, so a jump to it would go nowhere. */}
                      {action && seasonCount > 1 && (
                        <div className="details-index">
                          <button
                            type="button"
                            className={cx(
                              buttonBase,
                              'min-h-11 border-accent/40 bg-accent/10 px-3 text-xs text-accent-bright hover:bg-accent/16',
                            )}
                            onClick={() => jumpToDetails(sectionId(action.targets[0]))}
                          >
                            <Icon name={action.icon} size={15} />
                            {action.label}
                          </button>
                        </div>
                      )}
                    </section>
                    {unseenChanges.length > 0 && (
                      <details className="details-changes" aria-label="What changed">
                        <summary className="touch-target flex cursor-pointer list-none items-center gap-1.5 py-2 text-sm font-semibold text-accent-bright">
                          <Icon name="chevron-right" size={15} className="disclosure-chevron" />
                          What changed ({unseenChanges.length})
                        </summary>
                        <section className="pt-1 pb-2">
                          <ul className="m-0 list-none divide-y divide-line p-0">
                            {unseenChanges.map(({ season, change }) => (
                              <li key={change.id} className="min-w-0 py-2 first:pt-0 last:pb-0">
                                <ReleaseChangeLine
                                  detail={presentReleaseChange(change)}
                                  context={detailsSeasonName(season)}
                                />
                                <time className="block text-xs text-muted" dateTime={change.detected_at}>
                                  Detected {displayDateTimeMinutes(change.detected_at)}
                                </time>
                              </li>
                            ))}
                          </ul>
                          <button
                            type="button"
                            className={cx(
                              buttonBase,
                              'mt-3 min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised',
                            )}
                            disabled={reviewingChanges}
                            onClick={() => void onReviewChanges(changeIds)}
                          >
                            <Icon name="check" size={15} />
                            {reviewingChanges ? 'Marking reviewed…' : 'Mark reviewed'}
                          </button>
                        </section>
                      </details>
                    )}
                    {group.seasons.map((season, index) => (
                      <DetailsSeason
                        key={season.key}
                        sectionId={sectionId(index)}
                        defaultOpen={seasonCount === 1 || decisionTargets.has(index)}
                        nextAction={nextActionFor(index)}
                        onJump={jumpToDetails}
                        r={season}
                        config={config}
                        actions={seasonActions(season)}
                        ruleBusy={ruleBusy}
                        onToggleExclusion={(part, excluded) => void toggleExclusion(season, part, excluded)}
                        onCorrectMatch={() => {
                          setMappingSeason(season)
                          setMappingOpen(true)
                        }}
                        onCorrectTitleMatch={() => {
                          setMappingSeason(null)
                          setMappingOpen(true)
                        }}
                      />
                    ))}
                  </div>
                </div>
              </aside>
            </div>
          </Modal>
        )}
      </ErrorBoundary>
      <ConfirmDialog
        open={removeTarget !== null}
        title={
          !removeTarget
            ? 'Remove download?'
            : removeTarget.phase === 'acceptance_unknown'
              ? 'Stop tracking this download?'
              : `Remove download from ${clientName(removeTarget.client)}?`
        }
        description={
          !removeTarget
            ? ''
            : removeTarget.phase === 'acceptance_unknown'
              ? `${clientName(removeTarget.client)} never confirmed this download. SeaDex Companion forgets it without changing anything in ${clientName(removeTarget.client)}. Check ${clientName(removeTarget.client)} first: if the download is there, it keeps running and this release should not be sent again.`
              : `The download will be removed from ${clientName(removeTarget.client)}. Its downloaded files are kept unless you choose to delete them below.`
        }
        confirmLabel={
          !removeTarget
            ? 'Remove'
            : removeTarget.phase === 'acceptance_unknown'
              ? 'Stop tracking'
              : `Remove from ${clientName(removeTarget.client)}`
        }
        dangerous
        onConfirm={async () => {
          if (removeTarget && !(await handleDownloadAction(removeTarget, 'remove', deleteFiles)))
            throw new Error(
              `Could not remove this download. Please retry or open ${clientName(removeTarget.client)} to manage it.`,
            )
        }}
        onClose={() => {
          setRemoveTarget(null)
          setDeleteFiles(false)
        }}
      >
        {removeTarget?.capabilities.remove_files && (
          <label className="mb-5 flex cursor-pointer items-center gap-3 rounded-xl border border-bad/25 bg-bad/7 p-3 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-bad"
              checked={deleteFiles}
              onChange={event => setDeleteFiles(event.target.checked)}
            />
            <span>
              <span className="block font-bold text-bad">Also delete downloaded files</span>
              <span className="mt-0.5 block text-xs text-muted">This cannot be undone.</span>
            </span>
          </label>
        )}
      </ConfirmDialog>
      <MappingDialog
        open={mappingOpen}
        title={group.title}
        season={mappingSeason?.season || undefined}
        currentAniListId={mappingSeason ? mappingSeason.anilist_id : group.anilist_id}
        currentAniListIds={mappingSeason?.anilist_ids}
        hasOverride={
          mappingSeason
            ? Boolean(mappingSeason.season_mapping_override)
            : group.seasons.some(season => season.mapping_override)
        }
        onApply={applyMapping}
        onClose={() => setMappingOpen(false)}
      />
    </>
  )
}

export default memo(Card)
