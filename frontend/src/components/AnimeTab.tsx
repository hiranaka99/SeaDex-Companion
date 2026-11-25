import { errorMessage } from '../../../shared/errors.js'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ResultItem, Config, Release, Status, GroupedCard, CardStatus, LibraryFilterRequest } from '../types'
import {
  groupResults,
  seasonLabel,
  cardSizeDelta,
  hasCardUpgrade,
  STATUS_LABEL,
  formatBytes,
  upgradeDownloadEstimate,
  prowlarrReady,
  findsPrivateTorrent,
} from '../utils'
import { Fragment } from 'react'
import { displayDateTime, displayTimeAgo } from '../datetime'
import Card from './Card'
import BulkDownloadDialog from './BulkDownloadDialog'
import BulkCancelDialog from './BulkCancelDialog'
import ErrorBoundary from './ErrorBoundary'
import Icon, { IconName } from './Icons'
import { useToast } from './Toast'
import * as api from '../api'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import type { BulkOperationState } from './OperationCenter'
import BulkScopeSelector from './BulkScopeSelector'
import { useLibraryMotion } from '../useLibraryMotion'
import { useBulkActions } from '../useBulkActions'
import { useHiddenCards } from '../useHiddenCards'
import { describeSchedule, timeUntilCheck } from '../schedule-text'
import { groupReleaseChanges, latestReleaseChange } from '../release-changes'
import { preferencesAreDefault } from '../../../shared/settings'
import { upgradeParts } from '../../../shared/download-plan'
import { releaseResultIdentity } from '../../../shared/release-changes'
import { useLibraryFilters, type LibrarySort, type LibraryStatusFilter } from '../useLibraryFilters'
import { STATUS_MEANING, STATUS_ORDER, STATUS_PRESENTATION } from '../status-presentation'

interface Props {
  active: boolean
  openResultKey: string | null
  onResultOpened: () => void
  bulkOperationActive?: boolean
  bulkReviewRequest: number
  onBulkReviewReset: () => void
  results: ResultItem[]
  config: Config | null
  status: Status
  lastRun: string | null
  onScan: () => void
  loading: boolean
  loadError: string
  onReloadResults: () => void
  onOpenConfig: () => void
  onBulkOperationChange: (operation: BulkOperationState) => void
  operationsVisible: boolean
  onResultsChanged: () => Promise<void>
  /** Opens the library with one status filter, e.g. from a scan history total. */
  filterRequest?: (LibraryFilterRequest & { id: number }) | null
}

const PAGE_SIZE = 60
const UNDO_MS = 12000
const TITLE_ORDER = new Intl.Collator(undefined, { sensitivity: 'base' })
const SIZE_TITLE_ORDER = new Intl.Collator()
const STATUS_RANK: Record<string, number> = { review: 0, upgrade: 1, partial: 2, missing: 3, best: 4 }
const SORT_LABEL: Record<LibrarySort, string> = {
  recommended: 'Recommended order',
  title: 'Title A–Z',
  size: 'Largest size change',
  changed: 'Latest release change',
}

function cardKey(group: GroupedCard): string {
  return group.key
}

const hasMissingEpisodes = (group: GroupedCard) => group.seasons.some(season => (season.missing_episode_count || 0) > 0)

function SkeletonCards() {
  return (
    <div
      className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]"
      aria-label="Loading library"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-card border border-line bg-panel">
          <div className="library-card-body">
            <div className="library-card-poster skeleton" />
            <div className="library-card-info">
              <div className="flex flex-col gap-3 p-3">
                <div className="skeleton h-5 w-full rounded-md" />
                <div className="skeleton h-5 w-2/3 rounded-md" />
                <div className="skeleton h-4 w-24 rounded-md" />
              </div>
            </div>
          </div>
          <div className="flex gap-1.5 px-3.5 pb-3.5">
            <div className="skeleton h-8 w-11 rounded-md" />
            <div className="skeleton h-8 w-11 rounded-md" />
          </div>
          <div className="border-t border-line p-3">
            <div className="skeleton h-9 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A panel anchored under its trigger that closes on Escape, on an outside click, and when focus leaves it. */
function Popover({
  label,
  icon,
  badge,
  className,
  panelClassName,
  triggerClassName,
  chevron = true,
  children,
}: {
  label: ReactNode
  icon: IconName
  badge?: number
  className?: string
  panelClassName?: string
  triggerClassName?: string
  chevron?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  return (
    <div
      ref={root}
      className={cx('relative', className)}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={cx(
          'touch-target inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-control border px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors',
          open ? 'border-accent-bright bg-panel text-ink' : 'border-line bg-panel text-ink hover:bg-panel-raised',
          triggerClassName,
        )}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name={icon} size={16} className="shrink-0 text-muted" />
        {label}
        {badge ? (
          <span className="grid min-w-5 place-items-center rounded-full bg-accent/20 px-1.5 text-xs font-bold tabular-nums text-ink">
            {badge}
          </span>
        ) : null}
        {chevron && (
          <Icon
            name="chevron-down"
            size={14}
            className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className={cx(
          'library-popover absolute top-full right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-control border border-line-strong bg-panel-raised p-3 shadow-card',
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** What each status and filter means, with the same glyph it carries everywhere else. */
function StatusGuideList() {
  const rows: { key: string; icon: IconName; tone: string; label: string; meaning: string }[] = [
    ...STATUS_ORDER.map(status => ({
      key: status,
      ...STATUS_PRESENTATION[status],
      label: STATUS_LABEL[status],
      meaning: STATUS_MEANING[status],
    })),
    { key: 'episodes', icon: 'alert', tone: 'text-warn', label: 'Episodes missing', meaning: STATUS_MEANING.episodes },
    {
      key: 'unseen',
      icon: 'clock',
      tone: 'text-accent-bright',
      label: 'Unseen changes',
      meaning: STATUS_MEANING.unseen,
    },
  ]
  return (
    <dl className="m-0 grid gap-2.5">
      {rows.map(row => (
        <div key={row.key} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2">
          <Icon name={row.icon} size={15} className={cx('mt-0.5', row.tone)} />
          <dt className="text-sm font-semibold text-ink">{row.label}</dt>
          <dd className="col-start-2 m-0 text-xs leading-relaxed text-muted">{row.meaning}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function AnimeTab({
  active,
  openResultKey,
  onResultOpened,
  bulkOperationActive = false,
  bulkReviewRequest,
  onBulkReviewReset,
  results,
  config,
  status,
  lastRun,
  onScan,
  loading,
  loadError,
  onReloadResults,
  onOpenConfig,
  onBulkOperationChange,
  operationsVisible,
  onResultsChanged,
  filterRequest,
}: Props) {
  /** Whether Prowlarr can find a private-tracker release's torrent; stable so bulk review is not rebuilt each render. */
  const privateTorrent = useCallback((release: Release) => findsPrivateTorrent(release, config), [config])
  const { filters, update, reset: resetFilters } = useLibraryFilters(active)
  const { search, source: arr, status: statusFilter, sort, episodes: showEpisodes, unseen: showUnseen } = filters
  const showHidden = filters.hidden
  const [reviewingChanges, setReviewingChanges] = useState(false)
  const reviewInFlight = useRef(false)
  const unseenFilterRef = useRef<HTMLButtonElement>(null)
  const [page, setPage] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const bulk = useBulkActions({
    active,
    operationActive: bulkOperationActive,
    reviewRequest: bulkReviewRequest,
    onReviewReset: onBulkReviewReset,
    onOperationChange: onBulkOperationChange,
  })
  const toast = useToast()

  useEffect(() => {
    if (!openResultKey) setPage(0)
  }, [search, arr, statusFilter, sort, showHidden, showUnseen, showEpisodes])

  useEffect(() => {
    if (!filterRequest) return
    resetFilters()
    update('status', filterRequest.status)
  }, [filterRequest])

  useEffect(() => {
    if (!openResultKey) return
    const group = groupResults(results).find(group => group.seasons.some(season => season.key === openResultKey))
    if (group) {
      resetFilters()
      update('hidden', hiddenKeys.has(cardKey(group)))
    } else {
      toast.show('This title is no longer in the current library', 'info')
      onResultOpened()
    }
  }, [openResultKey])

  const allGroups = useMemo(() => groupResults(results), [results])
  // One Sonarr and one Radarr keep the familiar two choices; additional instances are listed by name.
  const sources = useMemo(() => {
    const named = [...new Set(allGroups.map(group => group.source))].sort((left, right) => left.localeCompare(right))
    return named.some(name => name !== 'Sonarr' && name !== 'Radarr') ? named : ['Sonarr', 'Radarr']
  }, [allGroups])
  useEffect(() => {
    // A source restored from the URL waits for the results that name it.
    if (arr && allGroups.length && !sources.includes(arr)) update('source', '')
  }, [arr, sources, allGroups.length])
  const titleFor = useCallback((key: string) => allGroups.find(group => cardKey(group) === key)?.title, [allGroups])
  const { hiddenKeys, toggleHidden: toggleHiddenKey } = useHiddenCards(config?.hidden, titleFor)
  const toggleHidden = useCallback((group: GroupedCard) => toggleHiddenKey(cardKey(group)), [toggleHiddenKey])
  // Filtering preserves this order, so typing never sorts the collection again.
  const orderedGroups = useMemo(() => {
    const ordered = [...allGroups]
    if (showUnseen || sort === 'changed')
      return ordered.sort(
        (a, b) => latestReleaseChange(b) - latestReleaseChange(a) || TITLE_ORDER.compare(a.title, b.title),
      )
    if (sort === 'size') {
      const deltas = new Map(allGroups.map(group => [group, Math.abs(cardSizeDelta(group))]))
      return ordered.sort((a, b) => deltas.get(b)! - deltas.get(a)! || SIZE_TITLE_ORDER.compare(a.title, b.title))
    }
    return ordered.sort(
      (a, b) =>
        (sort === 'title' ? 0 : STATUS_RANK[a.status] - STATUS_RANK[b.status]) || TITLE_ORDER.compare(a.title, b.title),
    )
  }, [allGroups, sort, showUnseen])
  // Build searchable text once per scan, rather than once per keystroke/filter.
  const searchText = useMemo(
    () =>
      new Map(
        allGroups.map(group => [
          group,
          `${group.title} ${group.seasons.map(season => `${season.title} ${season.best_group || ''} ${season.have.join(' ')} ${seasonLabel(season)}`).join(' ')}`.toLowerCase(),
        ]),
      ),
    [allGroups],
  )
  const searchQuery = search.trim().toLowerCase()
  const scopeGroups = useMemo(
    () =>
      orderedGroups.filter(group => {
        if (hiddenKeys.has(cardKey(group)) !== showHidden || (arr && group.source !== arr)) return false
        return !searchQuery || searchText.get(group)!.includes(searchQuery)
      }),
    [orderedGroups, hiddenKeys, showHidden, arr, searchText, searchQuery],
  )
  const matchesStatus = useCallback(
    (group: GroupedCard) =>
      !statusFilter || (statusFilter === 'upgrade' ? hasCardUpgrade(group) : group.status === statusFilter),
    [statusFilter],
  )
  // Status counts honour the two toggles; each toggle counts within the chosen status and the other toggle.
  const toggledGroups = useMemo(
    () =>
      scopeGroups.filter(
        group => (!showEpisodes || hasMissingEpisodes(group)) && (!showUnseen || latestReleaseChange(group) > 0),
      ),
    [scopeGroups, showEpisodes, showUnseen],
  )
  const statusCounts = useMemo(() => {
    const counts: Record<LibraryStatusFilter, number> = {
      '': toggledGroups.length,
      review: 0,
      upgrade: 0,
      partial: 0,
      missing: 0,
      best: 0,
    }
    for (const group of toggledGroups) {
      if (group.status !== 'upgrade') counts[group.status]++
      if (hasCardUpgrade(group)) counts.upgrade++
    }
    return counts
  }, [toggledGroups])
  const episodeCount = useMemo(
    () =>
      scopeGroups.filter(
        group => matchesStatus(group) && hasMissingEpisodes(group) && (!showUnseen || latestReleaseChange(group) > 0),
      ).length,
    [scopeGroups, matchesStatus, showUnseen],
  )
  const unseenGroups = useMemo(
    () =>
      scopeGroups.filter(
        group => matchesStatus(group) && latestReleaseChange(group) > 0 && (!showEpisodes || hasMissingEpisodes(group)),
      ),
    [scopeGroups, matchesStatus, showEpisodes],
  )
  const groups = useMemo(() => toggledGroups.filter(matchesStatus), [toggledGroups, matchesStatus])

  const handleReviewChanges = useCallback(
    async (ids: string[]) => {
      if (reviewInFlight.current || !ids.length) return
      reviewInFlight.current = true
      setReviewingChanges(true)
      const focused = document.activeElement
      const wanted = new Set(ids)
      // Kept so Undo can put exactly these changes back where they were.
      const reviewed = results.flatMap(result =>
        (result.unseen_changes || [])
          .filter(change => wanted.has(change.id))
          .map(change => ({ key: releaseResultIdentity(result), change })),
      )
      try {
        await api.reviewReleaseChanges(ids)
        await onResultsChanged()
        const count = reviewed.length || ids.length
        toast.show(
          `${count} ${count === 1 ? 'change' : 'changes'} marked reviewed`,
          'success',
          reviewed.length ? UNDO_MS : undefined,
          reviewed.length
            ? {
                label: 'Undo',
                onClick: () => {
                  void api
                    .restoreReleaseChanges(reviewed)
                    .then(() => onResultsChanged())
                    .then(() => toast.show('Changes are unseen again', 'success'))
                    .catch(error => toast.show(`Could not undo: ${errorMessage(error)}`, 'error'))
                },
              }
            : undefined,
        )
        window.requestAnimationFrame(() => {
          if (focused && !focused.isConnected) unseenFilterRef.current?.focus()
        })
      } catch (error) {
        toast.show(`Could not mark changes reviewed: ${errorMessage(error)}`, 'error')
      } finally {
        reviewInFlight.current = false
        setReviewingChanges(false)
      }
    },
    [onResultsChanged, toast, results],
  )

  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  const requestedIndex = openResultKey
    ? groups.findIndex(group => group.seasons.some(season => season.key === openResultKey))
    : -1
  const currentPage = requestedIndex >= 0 ? Math.floor(requestedIndex / PAGE_SIZE) : Math.min(page, pageCount - 1)
  const visibleGroups = useMemo(
    () => groups.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [groups, currentPage],
  )
  const statusTotals = useMemo(
    () =>
      groups.reduce<Record<string, number>>((acc, group) => {
        acc[group.status] = (acc[group.status] || 0) + 1
        return acc
      }, {}),
    [groups],
  )
  const shownUpgrades = useMemo(() => groups.filter(hasCardUpgrade).length, [groups])
  const shownReviews = useMemo(() => groups.filter(group => group.status === 'review').length, [groups])
  const sectionLabels = sort === 'recommended' && !showUnseen && Object.keys(statusTotals).length > 1
  const motionRevision = useMemo(() => JSON.stringify(visibleGroups.map(cardKey)), [visibleGroups])
  useLibraryMotion(gridRef, motionRevision, active && !loading)
  // Persist a history destination's page before Card clears the open request.
  useLayoutEffect(() => {
    if (requestedIndex >= 0) setPage(Math.floor(requestedIndex / PAGE_SIZE))
  }, [requestedIndex])
  useEffect(() => {
    setPage(value => Math.min(value, pageCount - 1))
  }, [pageCount])
  const changePage = (next: number) => {
    setPage(Math.max(0, Math.min(next, pageCount - 1)))
    window.requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ block: 'start' })
      resultsRef.current?.focus({ preventScroll: true })
    })
  }

  const totalDelta = useMemo(() => groups.reduce((sum, group) => sum + cardSizeDelta(group), 0), [groups])
  const downloadEstimate = useMemo(() => upgradeDownloadEstimate(groups.flatMap(group => group.seasons)), [groups])
  // The same rule bulk review applies, so the button is offered exactly when the review has something to show.
  const upgradeSeasonCount = useMemo(
    () => new Set(results.filter(result => upgradeParts(result).length > 0).map(result => result.key)).size,
    [results],
  )
  const hasUpgrades = upgradeSeasonCount > 0
  const [space, setSpace] = useState<api.DownloadSpaceLocation[]>([])
  useEffect(() => {
    if (!active || loading || !hasUpgrades) return
    let current = true
    api
      .getDownloadSpace()
      .then(response => current && setSpace(response.locations || []))
      .catch(() => current && setSpace([]))
    return () => {
      current = false
    }
  }, [active, loading, hasUpgrades, results])
  const knownSpace = space.filter(location => location.free_bytes !== null)
  const freeBytes = knownSpace.length ? Math.min(...knownSpace.map(location => location.free_bytes!)) : null
  const spaceShort = freeBytes !== null && downloadEstimate.bytes > freeBytes
  const libraryConfigured = Boolean(
    (config?.sonarr_url && config.sonarr_key_configured) || (config?.radarr_url && config.radarr_key_configured),
  )
  const autoCheckLabel = timeUntilCheck(status.next_check)
  const scheduleDescription = describeSchedule(config?.scan_schedule)
  const lastScanLabel = lastRun ? `Last scan ${displayTimeAgo(lastRun)}` : 'No completed scan'
  const statusFilters: { value: LibraryStatusFilter; label: string; icon: IconName; tone: string }[] = [
    { value: '', label: 'All', icon: 'library', tone: 'text-ink' },
    ...STATUS_ORDER.map(status => ({ value: status, label: STATUS_LABEL[status], ...STATUS_PRESENTATION[status] })),
  ]
  const activeOptions = [
    arr,
    showHidden ? 'Hidden titles' : '',
    showUnseen || sort === 'recommended' ? '' : SORT_LABEL[sort],
  ].filter(Boolean)
  const activeFilters = [
    search.trim() ? `Search: ${search.trim()}` : '',
    ...activeOptions,
    statusFilter ? statusFilters.find(filter => filter.value === statusFilter)?.label : '',
    showEpisodes ? 'Episodes missing' : '',
    showUnseen ? 'Unseen changes' : '',
  ].filter(Boolean)
  const openBulkReview = (action: 'start' | 'cancel') =>
    bulk.open(action, {
      filtered: groups.flatMap(group => group.seasons),
      all: [...results],
      description: activeFilters.join(' · ') || 'Current library results',
    })
  const scopeControl = (
    <BulkScopeSelector
      value={bulk.scope}
      onChange={bulk.setScope}
      filteredCount={bulk.reviewCounts.filtered}
      allCount={bulk.reviewCounts.all}
      description={bulk.review?.description || 'Current library results'}
      disabled={bulk.busy !== null || Boolean(bulk.job)}
    />
  )
  const dialogFailed = (what: string) => () => {
    bulk.close()
    toast.show(`${what} could not be shown. Your downloads are unchanged; try opening it again.`, 'error')
  }
  const loadingCount = (count: number) => (loading ? '–' : count)
  const toggleChip = (on: boolean) =>
    cx(
      'toolbar-status-filter touch-target inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold whitespace-nowrap transition-colors',
      on ? 'bg-accent/14 text-ink' : 'text-muted hover:bg-panel hover:text-ink',
    )
  const episodesToggle = (className?: string) => (
    <button
      type="button"
      className={cx(toggleChip(showEpisodes), className)}
      aria-pressed={showEpisodes}
      onClick={() => update('episodes', !showEpisodes)}
    >
      <Icon name="alert" size={15} className="shrink-0 text-warn" />
      <span>Episodes missing</span>
      <span className="toolbar-status-count text-xs tabular-nums text-muted">{loadingCount(episodeCount)}</span>
    </button>
  )

  return (
    <section>
      <header className="app-page-header mb-5 flex flex-wrap items-start justify-between gap-4 max-[600px]:mb-4 max-[600px]:gap-3">
        <div>
          <h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Anime library</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted max-[600px]:hidden">
            <span className="inline-flex items-center gap-1.5" title={lastRun ? displayDateTime(lastRun) : undefined}>
              <Icon name="clock" size={15} />
              {lastScanLabel}
            </span>
            {autoCheckLabel !== null && (
              <span title={scheduleDescription || undefined}>
                {scheduleDescription} · next in ~{autoCheckLabel}
              </span>
            )}
            {status.webhook_scan.queued && (
              <span className="text-accent-bright">
                {status.webhook_scan.sources.length ? 'Webhook scan queued' : 'Library check queued'}
              </span>
            )}
          </div>
        </div>
        <div className="library-actions flex flex-wrap items-center gap-2 max-[600px]:w-full">
          <button
            type="button"
            className={cx(
              buttonBase,
              'library-action justify-center wrap-anywhere max-[600px]:text-xs',
              hasUpgrades ? 'border-line bg-panel text-ink hover:bg-panel-raised' : 'library-action-emphasis',
            )}
            onClick={onScan}
            disabled={!libraryConfigured || status.running || bulk.busy !== null || bulkOperationActive}
          >
            {status.running ? (
              <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
            ) : (
              <Icon name="play" size={17} />
            )}
            <span>{status.running ? 'Scanning…' : 'Scan library'}</span>
          </button>
          <button
            type="button"
            className={cx(
              buttonBase,
              'library-action justify-center wrap-anywhere max-[600px]:text-xs',
              hasUpgrades ? 'library-action-emphasis' : 'border-line bg-panel text-ink hover:bg-panel-raised',
            )}
            onClick={() => openBulkReview('start')}
            disabled={status.running || bulk.busy !== null || bulkOperationActive || !hasUpgrades}
          >
            <Icon name="download" size={17} />
            <span>Bulk download</span>
          </button>
          <button
            type="button"
            className="library-cancel-downloads touch-target inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-muted transition-colors hover:bg-bad/10 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50"
            title="Review and cancel downloads that have not finished"
            onClick={() => openBulkReview('cancel')}
            disabled={status.running || bulk.busy !== null || bulkOperationActive}
          >
            <Icon name="trash" size={17} />
            <span className="max-[600px]:sr-only">Cancel downloads</span>
          </button>
        </div>
      </header>

      {loadError && (
        <div
          className="mb-5 flex flex-wrap items-center gap-2.5 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad"
          role="alert"
        >
          <Icon name="alert" size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">Could not load scanned results: {loadError}</span>
          <button
            type="button"
            className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')}
            onClick={onReloadResults}
          >
            <Icon name="refresh" size={15} />
            Retry
          </button>
          <button
            type="button"
            className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')}
            onClick={onOpenConfig}
          >
            Open Config
          </button>
        </div>
      )}

      <div
        className={cx(
          'library-toolbar library-toolbar-refined z-20 mb-5 max-[600px]:mb-3 rounded-2xl border border-line',
          operationsVisible ? 'relative' : 'sticky top-0',
        )}
      >
        <div className="toolbar-controls flex flex-wrap items-center gap-2.5">
          <label className="toolbar-search relative min-w-0 flex-1 max-[600px]:basis-full">
            <span className="sr-only">Search anime</span>
            <Icon
              name="search"
              size={17}
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-dim"
            />
            <input
              type="search"
              className={cx(control, 'w-full pl-10')}
              placeholder="Search titles and release groups"
              value={search}
              onChange={event => update('search', event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by status"
            className={cx(control, 'hidden min-w-0 flex-1 cursor-pointer max-[600px]:block')}
            value={statusFilter}
            onChange={event => update('status', event.target.value as LibraryStatusFilter)}
          >
            {statusFilters.map(filter => (
              <option key={filter.value} value={filter.value}>
                {filter.label} ({loadingCount(statusCounts[filter.value])})
              </option>
            ))}
          </select>
          {episodesToggle('max-[600px]:hidden')}
          <button
            ref={unseenFilterRef}
            type="button"
            className={cx(
              toggleChip(showUnseen),
              'max-[600px]:border max-[600px]:border-line max-[600px]:bg-panel max-[600px]:px-3 max-[600px]:py-2.5',
            )}
            aria-label={`Unseen changes (${unseenGroups.length} ${unseenGroups.length === 1 ? 'title' : 'titles'})`}
            aria-pressed={showUnseen}
            onClick={() => update('unseen', !showUnseen)}
          >
            <Icon name="clock" size={15} className="shrink-0 text-accent-bright" />
            <span className="min-[601px]:hidden">Unseen</span>
            <span className="max-[600px]:hidden">Unseen changes</span>
            <span className="toolbar-status-count text-xs tabular-nums text-muted">
              {loadingCount(unseenGroups.length)}
            </span>
          </button>
          <Popover
            label={<span className="max-[600px]:sr-only">Source &amp; sort</span>}
            icon="filter"
            badge={activeOptions.length}
            className="toolbar-view shrink-0"
            triggerClassName="max-[600px]:min-h-11 max-[600px]:min-w-11 max-[600px]:gap-1 max-[600px]:px-2.5"
          >
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-xs font-semibold text-muted">
                Source
                <select
                  aria-label="Source"
                  className={cx(control, 'w-full cursor-pointer')}
                  value={arr}
                  onChange={event => update('source', event.target.value)}
                >
                  <option value="">All sources</option>
                  {sources.map(source => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-muted">
                Sort by
                <select
                  aria-label="Sort library"
                  className={cx(control, 'w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-60')}
                  value={showUnseen ? 'changed' : sort}
                  disabled={showUnseen}
                  onChange={event => update('sort', event.target.value as LibrarySort)}
                >
                  {(Object.keys(SORT_LABEL) as LibrarySort[]).map(value => (
                    <option key={value} value={value}>
                      {SORT_LABEL[value]}
                    </option>
                  ))}
                </select>
                {showUnseen && (
                  <span className="font-normal text-muted-dim">Latest change first while Unseen changes is on</span>
                )}
              </label>
              <label className="touch-target flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-accent"
                  checked={showHidden}
                  onChange={event => update('hidden', event.target.checked)}
                />
                Show hidden titles only
              </label>
              <label className="touch-target flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1.5 text-sm text-ink min-[601px]:hidden">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-accent"
                  checked={showEpisodes}
                  onChange={event => update('episodes', event.target.checked)}
                />
                <span className="flex-1">Only titles with missing episodes</span>
                <span className="text-xs tabular-nums text-muted">{loadingCount(episodeCount)}</span>
              </label>
              <details className="library-status-guide-inline border-t border-line pt-2 min-[601px]:hidden">
                <summary className="touch-target cursor-pointer py-1 text-xs font-semibold text-accent-bright">
                  What the statuses mean
                </summary>
                <div className="pt-2">
                  <StatusGuideList />
                </div>
              </details>
            </div>
          </Popover>
          <div
            className="toolbar-status-row hidden basis-full flex-wrap items-center gap-1 min-[601px]:flex"
            role="group"
            aria-label="Filter by status"
          >
            {statusFilters.map(filter => (
              <button
                key={filter.value || 'all'}
                type="button"
                className={toggleChip(statusFilter === filter.value)}
                aria-pressed={statusFilter === filter.value}
                onClick={() => update('status', filter.value)}
              >
                <Icon name={filter.icon} size={15} className={cx('shrink-0', filter.tone)} />
                <span>{filter.label}</span>
                <span className="toolbar-status-count text-xs tabular-nums text-muted">
                  {loadingCount(statusCounts[filter.value])}
                </span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              {activeFilters.length > 0 && (
                <button
                  type="button"
                  className="touch-target cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold text-accent-bright hover:bg-accent/10"
                  onClick={resetFilters}
                >
                  Clear filters
                </button>
              )}
              <Popover
                label={<span className="sr-only">What the statuses mean</span>}
                icon="info"
                className="toolbar-guide"
                triggerClassName="border-transparent bg-transparent px-2.5 py-2 text-xs text-muted hover:bg-panel"
                chevron={false}
                panelClassName="w-[min(24rem,calc(100vw-2rem))] p-4"
              >
                <h2 className="mt-0 mb-3 text-sm font-bold text-ink">What the statuses mean</h2>
                <StatusGuideList />
              </Popover>
            </div>
          </div>
        </div>
        {showUnseen && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
            <span className="min-w-0 flex-1 basis-48 text-xs text-muted">
              Latest changes first · stays unseen until reviewed
            </span>
            {unseenGroups.length > 0 && (
              <button
                type="button"
                className="touch-target ml-auto cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold text-accent-bright hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
                title="Mark all changes matching the current library filters reviewed, across all pages. You can undo this."
                disabled={reviewingChanges || loading}
                onClick={() =>
                  void handleReviewChanges(
                    unseenGroups.flatMap(group => groupReleaseChanges(group).map(({ change }) => change.id)),
                  )
                }
              >
                {reviewingChanges ? 'Marking reviewed…' : 'Mark all reviewed'}
              </button>
            )}
          </div>
        )}
        {statusFilter === 'upgrade' && (
          <p className="mt-2 mb-0 text-xs text-muted">Includes partially covered titles with available upgrades.</p>
        )}
        <p className="sr-only" role="status" aria-atomic="true">
          {groups.length} matching titles{activeFilters.length ? ` · ${activeFilters.join(' · ')}` : ''}
        </p>
        {activeFilters.length > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs text-muted min-[601px]:hidden"
            aria-label="Active library filters"
          >
            <span className="min-w-0 flex-1 wrap-anywhere">
              {[
                search.trim() ? `Search: ${search.trim()}` : '',
                ...activeOptions,
                showEpisodes ? 'Episodes missing' : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'Filtered'}
            </span>
            <button
              type="button"
              className="touch-target cursor-pointer rounded-md px-2 py-1 font-semibold text-accent-bright hover:underline"
              onClick={resetFilters}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {!loading && results.length > 0 && status.settings_changed && !status.running && (
        <div
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/30 bg-warn/8 px-4 py-3 text-sm text-ink"
          role="status"
        >
          <Icon name="info" size={18} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1 basis-56">
            Library scope or release preferences changed since the last scan. These results still reflect the earlier
            settings.
          </span>
          <button
            type="button"
            className={cx(buttonBase, 'border-warn/35 bg-warn/10 text-ink hover:bg-warn/18')}
            onClick={onScan}
            disabled={!libraryConfigured || bulk.busy !== null || bulkOperationActive}
          >
            <Icon name="play" size={16} />
            Scan library
          </button>
        </div>
      )}
      {!loading && results.length > 0 && (
        <div className="library-summary" aria-label="Library summary">
          {shownUpgrades > 0 ? (
            <p className="library-summary-facts">
              <span>
                <strong>{shownUpgrades}</strong> {shownUpgrades === 1 ? 'title' : 'titles'} can be upgraded
              </span>
              {downloadEstimate.bytes > 0 && (
                <span
                  title={
                    downloadEstimate.unknown
                      ? `${downloadEstimate.unknown} ${downloadEstimate.unknown === 1 ? 'download has' : 'downloads have'} no known size and ${downloadEstimate.unknown === 1 ? 'is' : 'are'} not counted`
                      : 'The default release of every upgrade shown, each torrent counted once'
                  }
                >
                  <strong>
                    {downloadEstimate.unknown ? '≥' : '≈'}
                    {formatBytes(downloadEstimate.bytes)}
                  </strong>{' '}
                  to download
                </span>
              )}
              {totalDelta !== 0 && (
                <span title="How much the library grows once the upgrades replace your current files">
                  library {totalDelta > 0 ? 'grows' : 'shrinks'} by{' '}
                  <strong>
                    {totalDelta > 0 ? '+' : '−'}
                    {formatBytes(Math.abs(totalDelta))}
                  </strong>
                </span>
              )}
              {freeBytes !== null && (
                <span
                  className={cx('inline-flex items-baseline gap-1', spaceShort && 'library-summary-warn')}
                  title={knownSpace
                    .map(location => `${location.label}: ${formatBytes(location.free_bytes!) || '0 B'} free`)
                    .join('\n')}
                >
                  <Icon name="hard-drive" size={14} className="self-center" />
                  <strong>{formatBytes(freeBytes) || '0 B'}</strong> free
                  {spaceShort && <span> · not enough for every upgrade</span>}
                </span>
              )}
            </p>
          ) : (
            <p className="library-summary-facts">
              <span>No upgrades available</span>
            </p>
          )}
          {shownReviews > 0 && (
            <p className="library-summary-review">
              <Icon name={STATUS_PRESENTATION.review.icon} size={14} className="self-center text-warn" />
              <span>
                <strong>{shownReviews}</strong> {shownReviews === 1 ? 'match needs' : 'matches need'} review
              </span>
            </p>
          )}
          <span className="library-summary-count">{groups.length} shown</span>
          <span
            className="library-scan-freshness min-[601px]:hidden"
            title={lastRun ? displayDateTime(lastRun) : undefined}
          >
            {lastScanLabel}
            {autoCheckLabel !== null && ` · next in ~${autoCheckLabel}`}
          </span>
        </div>
      )}
      {(loading || (status.running && results.length === 0)) && <SkeletonCards />}
      {!loading && results.length > 0 && groups.length > 0 && (
        <div ref={resultsRef} className="library-results" tabIndex={-1} role="region" aria-label="Library results">
          {pageCount > 1 && (
            <nav
              className="mb-4 flex flex-wrap items-center justify-between gap-2 max-[600px]:justify-end"
              aria-label="Library pages"
            >
              <span className="text-xs text-muted max-[600px]:hidden" role="status">
                {(currentPage * PAGE_SIZE + 1).toLocaleString()}–
                {Math.min((currentPage + 1) * PAGE_SIZE, groups.length).toLocaleString()} of{' '}
                {groups.length.toLocaleString()} titles
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')}
                  disabled={currentPage === 0}
                  onClick={() => changePage(currentPage - 1)}
                >
                  <Icon name="chevron-left" size={15} />
                  <span className="max-[600px]:sr-only">Previous</span>
                </button>
                <select
                  className={cx(control, 'text-xs')}
                  aria-label="Library page"
                  value={currentPage}
                  onChange={event => changePage(Number(event.target.value))}
                >
                  {Array.from({ length: pageCount }, (_, index) => (
                    <option key={index} value={index}>
                      Page {index + 1} of {pageCount}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={cx(buttonBase, 'touch-target border-line bg-panel text-xs text-ink')}
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => changePage(currentPage + 1)}
                >
                  <span className="max-[600px]:sr-only">Next</span>
                  <Icon name="chevron-right" size={15} />
                </button>
              </div>
            </nav>
          )}
          <div
            ref={gridRef}
            className="library-grid grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]"
          >
            {visibleGroups.map((group, index) => (
              <Fragment key={cardKey(group)}>
                {sectionLabels && (index === 0 || visibleGroups[index - 1].status !== group.status) && (
                  <h2 className="library-section-label" data-status={group.status}>
                    <Icon
                      name={STATUS_PRESENTATION[group.status as CardStatus].icon}
                      size={15}
                      className={cx('shrink-0', STATUS_PRESENTATION[group.status as CardStatus].tone)}
                    />
                    {STATUS_LABEL[group.status]}
                    <span>{statusTotals[group.status]}</span>
                  </h2>
                )}
                <Card
                  active={active}
                  openRequested={group.seasons.some(season => season.key === openResultKey)}
                  onOpened={onResultOpened}
                  group={group}
                  index={index}
                  config={config}
                  hidden={hiddenKeys.has(cardKey(group))}
                  onToggle={toggleHidden}
                  onRulesChanged={onResultsChanged}
                  onRescan={onScan}
                  reviewingChanges={reviewingChanges}
                  onReviewChanges={handleReviewChanges}
                />
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {!loading && !loadError && results.length === 0 && !status.running && (
        <div className="rounded-2xl border border-dashed border-line-strong bg-panel/45 px-6 py-16 text-center">
          <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent-bright">
            <Icon name="library" size={26} />
          </span>
          <h2 className="mb-2 text-lg font-bold">
            {libraryConfigured ? 'Your library is ready to be scanned' : 'Connect your library first'}
          </h2>
          <p className="mx-auto mb-5 max-w-md text-sm text-muted">
            {libraryConfigured
              ? 'Compare your Sonarr and Radarr collection with the best releases available on SeaDex.'
              : 'Configure Sonarr or Radarr before running your first scan.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className={
                libraryConfigured ? buttonPrimary : cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')
              }
              onClick={onScan}
              disabled={!libraryConfigured}
            >
              <Icon name="play" size={17} />
              Scan library
            </button>
            <button
              type="button"
              className={
                libraryConfigured ? cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink') : buttonPrimary
              }
              onClick={onOpenConfig}
            >
              <Icon name="settings" size={17} />
              Open Config
            </button>
          </div>
        </div>
      )}
      {!loading && results.length > 0 && groups.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line-strong px-4 py-14 text-center">
          <Icon name={showUnseen ? 'check' : 'filter'} size={26} className="mx-auto mb-3 text-muted-dim" />
          <h2 className="mb-1 text-lg font-bold">{showUnseen ? 'No unseen changes' : 'No matching titles'}</h2>
          <p className="mb-4 text-sm text-muted">
            {showUnseen
              ? 'New release changes will appear here after future scans. Other library filters still apply.'
              : 'Try changing or clearing the active filters.'}
          </p>
          <button
            type="button"
            className="touch-target cursor-pointer text-sm font-bold text-accent-bright"
            onClick={resetFilters}
          >
            Clear filters
          </button>
        </div>
      )}
      <ErrorBoundary resetKey={bulk.confirm} onError={dialogFailed('The bulk download review')}>
        <BulkDownloadDialog
          open={active && bulk.confirm === 'start'}
          results={bulk.reviewResults}
          scopeControl={scopeControl}
          hiddenKeys={hiddenKeys}
          busy={bulk.busy === 'start'}
          job={bulk.job}
          downloadMode={config?.download_mode || 'torrent_only'}
          preferTarget={Boolean(config?.release_preferences && !preferencesAreDefault(config.release_preferences))}
          sabEnabled={Boolean(config?.sabnzbd_url && config?.sabnzbd_key_configured)}
          privateTorrent={privateTorrent}
          privateUsenet={prowlarrReady(config) && config?.prowlarr_coverage?.usenet === true}
          onConfirm={(planId, acknowledge) => void bulk.start(planId, acknowledge)}
          onClose={bulk.close}
        />
      </ErrorBoundary>
      <ErrorBoundary resetKey={bulk.confirm} onError={dialogFailed('The download cancellation review')}>
        <BulkCancelDialog
          open={active && bulk.confirm === 'cancel'}
          busy={bulk.busy === 'cancel'}
          onConfirm={(recordIds, deleteFiles) => void bulk.cancel(recordIds, deleteFiles)}
          onClose={() => {
            if (!bulk.busy) bulk.close()
          }}
        />
      </ErrorBoundary>
    </section>
  )
}
