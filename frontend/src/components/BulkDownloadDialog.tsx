import { rowKey } from '../../../shared/ids.js'
import { ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Release, ResultItem } from '../types'
import { formatBytes, seasonLabel } from '../utils'
import { cx } from '../styles'
import Icon from './Icons'
import * as api from '../api'
import Modal from './Modal'
import { bulkDialog } from './bulk-dialog-styles'
import { releaseIdentity } from '../../../shared/releases'
import { jobResult, type SubmissionRow, type DownloadJobStatus, type DownloadProtocol } from '../api'
import BulkPlanSummary from './BulkPlanSummary'
import { jobProgress } from '../bulk-operation'
import { OutcomeLabel, ReleaseSummary, UsenetStatus } from './BulkReviewParts'
import {
  buildReview,
  byTitleSeasonPart,
  optionAvailabilityKey,
  reviewProtocol,
  usenetEligibility,
  type IndexedRelease,
  type ReviewGroup,
} from '../bulk-review'
import { usePreflight, useReviewAvailability, useReviewChecks } from '../useBulkReviewChecks'
import { checkBlockedReason, plannedProof, usageText, verifyProgressText } from '../usenet-review'
import { awaitsCheck, type DownloadRoutes } from '../download-routes'

type ViewId = 'ready' | 'unavailable'

interface Props {
  open: boolean
  results: ResultItem[]
  scopeControl: ReactNode
  busy: boolean
  /** Live/last bulk submission state while the dialog stays open. */
  job: DownloadJobStatus | null
  /** What each release can be sent through under the current configuration and Prowlarr coverage. */
  routes: DownloadRoutes
  /** Release preferences are set, so their target is chosen where several releases are offered. */
  preferTarget?: boolean
  onConfirm: (plan_id: string, acknowledge: { whole_source?: boolean; disk_space?: boolean }) => void
  onClose: () => void
}

export default function BulkDownloadDialog({
  open,
  results,
  scopeControl,
  busy,
  job,
  routes,
  preferTarget = false,
  onConfirm,
  onClose,
}: Props) {
  const downloadMode = routes.mode
  /** A public magnet, or a private-tracker torrent Prowlarr can find, in a mode that sends torrents. */
  const sendsTorrent = (release: Release) => routes.release(release, undefined).torrent.sendable
  // The review keeps its selected snapshot; the server validates identities against current results.
  const usenetEnabled = routes.usenetReady
  const reviewCandidates = useMemo(
    () => buildReview(results, (_result, { release }) => routes.usenetSearchable(release), routes),
    [results, routes],
  )
  const usenetSelections = useMemo(
    () =>
      usenetEnabled
        ? [
            ...new Map(
              reviewCandidates.ready
                .flatMap(group =>
                  group.options
                    .filter(({ release }) => routes.usenetSearchable(release))
                    .map(option => ({
                      key: group.result.key,
                      release: option.index,
                      identity: releaseIdentity(option.release),
                    })),
                )
                .map(selection => [rowKey(selection), selection]),
            ).values(),
          ]
        : [],
    [reviewCandidates, usenetEnabled, routes],
  )
  const availabilityRevision = useSyncExternalStore(api.subscribeUsenetAvailability, api.getUsenetAvailabilityRevision)
  const [retry, setRetry] = useState(0)
  const observation = useReviewAvailability(usenetSelections, {
    open,
    enabled: usenetEnabled,
    paused: Boolean(job),
    revision: availabilityRevision,
    retry,
  })
  const { availability: currentAvailability, checking: usenetChecking, forceRefresh: forceAvailability } = observation
  const availabilityOf = (result: ResultItem, option: IndexedRelease) =>
    currentAvailability?.rows[optionAvailabilityKey(result, option)]
  // A release counts for Usenet with a proven copy, or while a search through Prowlarr can still look for one.
  const usenetEligible = useMemo(
    () => usenetEligibility(currentAvailability?.rows ?? null, routes),
    [routes, currentAvailability],
  )
  const review = useMemo(() => buildReview(results, usenetEligible, routes), [results, usenetEligible, routes])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [protocols, setProtocols] = useState<Record<string, DownloadProtocol>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<ViewId>('ready')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const enabledGroups = useMemo(() => review.ready.filter(group => enabled[group.id] !== false), [review, enabled])
  const selectedGroups = useMemo(
    () => enabledGroups.filter(group => selected[group.id] !== undefined),
    [enabledGroups, selected],
  )
  const selectedOptions = useMemo(
    () =>
      selectedGroups.map(
        group => group.options.find(option => option.index === selected[group.id]) || group.options[0],
      ),
    [selectedGroups, selected],
  )
  const protocolFor = (group: ReviewGroup, option: IndexedRelease): DownloadProtocol =>
    reviewProtocol(routes, currentAvailability?.rows, group.result, option, protocols[group.id])
  const unavailableChoices = reviewCandidates.ready.filter(group => {
    if (enabled[group.id] === false || selected[group.id] === undefined || protocols[group.id] !== 'usenet')
      return false
    const option = group.options.find(option => option.index === selected[group.id]) || group.options[0]
    return !usenetEligible(group.result, option)
  })
  const selections = useMemo(
    () =>
      selectedGroups.map((group, index) => {
        const option = selectedOptions[index]
        return {
          key: group.result.key,
          release: option.index,
          identity: releaseIdentity(option.release),
          protocol: protocolFor(group, option),
        }
      }),
    [selectedGroups, selectedOptions, protocols, routes, currentAvailability],
  )
  // Rows chosen for Usenet without a proven copy are searched and checked now, one NZB per source.
  const usenetRows = useMemo(() => selections.filter(selection => selection.protocol === 'usenet'), [selections])
  const {
    checks: usenetChecks,
    asked: checksAsked,
    usage: indexerUsage,
  } = useReviewChecks(observation, usenetRows, open && usenetEnabled && !job)
  const {
    preflight: currentPreflight,
    error: checkError,
    wholeSource,
    diskSpace,
    setWholeSource,
    setDiskSpace,
    forceRefresh: forcePreflight,
  } = usePreflight(selections, { open, busy, job, revision: availabilityRevision, retry, hold: usenetChecks > 0 })

  useEffect(() => {
    if (!open || busy || job) return
    // Only single-option groups get an automatic pick. Multi-option groups stay
    // pending (collapsed + highlighted) until the user actively chooses one,
    // unless saved release preferences already name their target.
    const preferred = (group: ReviewGroup) =>
      group.options.length === 1
        ? group.options[0]
        : preferTarget
          ? group.options.find(option => option.release.target)
          : undefined
    setSelected(
      Object.fromEntries(
        reviewCandidates.ready.flatMap(group => {
          const option = preferred(group)
          return option ? [[group.id, option.index]] : []
        }),
      ),
    )
    setEnabled(Object.fromEntries(reviewCandidates.ready.map(group => [group.id, true])))
    setProtocols({})
    setExpanded({})
    setView(reviewCandidates.ready.length || !reviewCandidates.blocked.length ? 'ready' : 'unavailable')
    cancelRef.current?.focus()
  }, [open, reviewCandidates, preferTarget])

  if (!open) return null
  const locked = busy || Boolean(job)
  const finished = Boolean(job?.finished)

  const checking = !currentPreflight && !checkError && !job
  const pendingChoices = review.choices.filter(
    group => enabled[group.id] !== false && selected[group.id] === undefined,
  ).length
  const blockedSorted = [...review.blocked].sort(byTitleSeasonPart)
  const readySorted = [...review.ready].sort(byTitleSeasonPart)
  const serverBlocked = currentPreflight?.blocked || []
  const serverBlockedIds = new Set(serverBlocked.map(row => rowKey(row)))

  // Per-row live outcome while the batch is in flight (and after it finishes).
  const result = job ? jobResult(job) : null
  const groupStatus = (group: ReviewGroup): 'success' | 'failure' | 'pending' | 'existing' | 'partial' | null => {
    if (!result || enabled[group.id] === false || selected[group.id] === undefined) return null
    const index = selected[group.id] ?? group.options[0].index
    const row = result.rows.find(entry => entry.key === group.result.key && entry.release === index)
    if (!row) return null
    return row.status === 'added'
      ? 'success'
      : row.status === 'existing'
        ? 'existing'
        : row.status === 'partial'
          ? 'partial'
          : row.status === 'failed'
            ? 'failure'
            : 'pending'
  }
  const rowProtocols = (group: ReviewGroup): DownloadProtocol[] => {
    const index = selected[group.id] ?? group.options[0].index
    return (
      result?.rows.find((entry: SubmissionRow) => entry.key === group.result.key && entry.release === index)
        ?.protocols || []
    )
  }
  const inflightProgress = job && !job.finished ? jobProgress(job) : null
  const needsWhole = currentPreflight?.requires_whole_ack === true
  const needsSpace = currentPreflight?.requires_space_ack === true
  const newUnits = (currentPreflight?.new_torrents || 0) + (currentPreflight?.new_nzbs || 0)

  return (
    <Modal open={open} labelledBy="bulk-download-title" onClose={onClose}>
      <section className={cx(bulkDialog.shell, 'max-w-3xl')} aria-busy={busy}>
        <header className={bulkDialog.header}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-good/12 text-good">
            <Icon name="download" size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-download-title" className="m-0 text-lg font-extrabold">
              Review bulk downloads
            </h2>
          </div>
          <button
            type="button"
            className={bulkDialog.closeButton}
            onClick={onClose}
            aria-label={busy ? 'Continue batch in background' : 'Close'}
          >
            <Icon name="close" size={18} />
          </button>
          <p className="m-0 basis-full text-sm text-muted">
            {job && !job.finished
              ? 'Sending your fixed selection to the download clients. Closing this review keeps the batch running in the background.'
              : finished
                ? 'Review the submitted selection and each outcome below. Operation Center shows the batch results and any error details.'
                : 'Choose a release and download method for each season or cour you want to upgrade.'}
          </p>
        </header>

        <div className={bulkDialog.body}>
          {scopeControl}
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <button
              type="button"
              className={cx(
                'touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors',
                view === 'ready'
                  ? 'border-good/60 bg-good/25 text-ink'
                  : 'border-good/30 bg-good/10 text-ink hover:bg-good/18',
              )}
              onClick={() => setView('ready')}
              aria-pressed={view === 'ready'}
            >
              {review.ready.length} eligible
            </button>
            {(review.blocked.length > 0 || serverBlocked.length > 0) && (
              <button
                type="button"
                className={cx(
                  'touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors',
                  view === 'unavailable'
                    ? 'border-warn/60 bg-warn/25 text-ink'
                    : 'border-warn/30 bg-warn/10 text-ink hover:bg-warn/18',
                )}
                onClick={() => setView('unavailable')}
                aria-pressed={view === 'unavailable'}
              >
                {Math.max(review.blocked.length, serverBlocked.length)} unavailable
              </button>
            )}
            {review.ready.length > 0 && (
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-accent/50 bg-accent/15 px-3 py-1.5 font-extrabold text-accent-bright transition-colors hover:bg-accent/25"
                  disabled={locked}
                  onClick={() => setEnabled(Object.fromEntries(review.ready.map(group => [group.id, true])))}
                >
                  Check all
                </button>
                <button
                  type="button"
                  className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-line-strong bg-panel px-3 py-1.5 text-ink transition-colors hover:border-ink/25 hover:bg-canvas-soft"
                  disabled={locked}
                  onClick={() => setEnabled(Object.fromEntries(review.ready.map(group => [group.id, false])))}
                >
                  Uncheck all
                </button>
              </div>
            )}
            {downloadMode === 'choose' && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-accent/50 bg-accent/12 px-3 py-1.5 font-extrabold text-accent-bright transition-colors hover:bg-accent/20"
                  disabled={locked || !review.ready.length}
                  title="Use qBittorrent for every eligible group"
                  onClick={() => setProtocols(Object.fromEntries(review.ready.map(group => [group.id, 'torrent'])))}
                >
                  All torrents
                </button>
                <button
                  type="button"
                  className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-sky/50 bg-sky/12 px-3 py-1.5 font-extrabold text-sky transition-colors hover:bg-sky/20"
                  disabled={
                    locked ||
                    !review.ready.some(group => group.options.some(option => usenetEligible(group.result, option)))
                  }
                  title="Use SABnzbd wherever the release is on Usenet, or can be searched and checked there"
                  onClick={() =>
                    setProtocols(
                      Object.fromEntries(
                        review.ready.map(group => {
                          const option =
                            group.options.find(({ index }) => index === selected[group.id]) || group.options[0]
                          return [group.id, usenetEligible(group.result, option) ? 'usenet' : 'torrent'] as const
                        }),
                      ),
                    )
                  }
                >
                  All Usenet where available
                </button>
              </div>
            )}
          </div>
          {usenetChecking && usenetChecks === 0 && (
            <p className="m-0 text-xs text-muted" role="status">
              Refreshing Usenet availability. Known cached sources remain available; unchecked sources are still
              checking.
            </p>
          )}
          {usenetChecks > 0 && (
            <p className="m-0 text-xs text-muted" role="status">
              {verifyProgressText(usenetChecks)}
            </p>
          )}
          {(usenetChecks > 0 || checksAsked) && usageText(indexerUsage) && (
            <p className="m-0 text-xs text-muted wrap-anywhere">{usageText(indexerUsage)}</p>
          )}
          {currentAvailability?.error && (
            <p className="m-0 text-xs text-warn wrap-anywhere" role="status">
              Usenet refresh failed: {currentAvailability.error}. Last-known availability remains visible. Refresh the
              review to try again.
            </p>
          )}
          {!finished && (
            <button
              type="button"
              className="touch-target self-start cursor-pointer rounded-lg px-2 py-1 text-xs font-bold text-accent-bright hover:bg-accent/10 disabled:opacity-50"
              disabled={locked}
              onClick={() => {
                forceAvailability()
                forcePreflight()
                setRetry(current => current + 1)
              }}
            >
              Refresh review
            </button>
          )}

          {view === 'ready' && (
            <section>
              {readySorted.length ? (
                <div className="space-y-1.5">
                  {readySorted.map(group => {
                    const isChoice = group.options.length > 1
                    const status = groupStatus(group)
                    const statusClass =
                      status === 'success'
                        ? 'border-good/50 bg-good/8'
                        : status === 'failure'
                          ? 'border-bad/50 bg-bad/8'
                          : status === 'pending'
                            ? 'border-accent/45 bg-accent/8'
                            : status === 'partial'
                              ? 'border-warn/50 bg-warn/8'
                              : ''
                    const statusIcon =
                      status === 'success' ? (
                        <Icon name="check" size={13} className="text-good" />
                      ) : status === 'failure' ? (
                        <Icon name="alert" size={13} className="text-bad" />
                      ) : status === 'pending' ? (
                        <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                      ) : status === 'partial' ? (
                        <Icon name="alert" size={13} className="text-warn" />
                      ) : null
                    const statusText =
                      status === 'success'
                        ? 'text-good'
                        : status === 'failure'
                          ? 'text-bad'
                          : status === 'pending'
                            ? 'text-accent-bright'
                            : status === 'partial'
                              ? 'text-warn'
                              : 'text-ink'
                    const protocolButtons = (option: IndexedRelease) =>
                      downloadMode === 'choose' ? (
                        <span
                          className="flex shrink-0 items-center gap-1"
                          role="radiogroup"
                          aria-label={`Download method for ${group.result.title}`}
                        >
                          <button
                            type="button"
                            role="radio"
                            aria-checked={protocolFor(group, option) === 'torrent'}
                            disabled={locked || !sendsTorrent(option.release)}
                            title={
                              option.release.torrent_available
                                ? 'Send to qBittorrent'
                                : sendsTorrent(option.release)
                                  ? 'Find on the private tracker through Prowlarr and send to qBittorrent'
                                  : 'No magnet available (private tracker)'
                            }
                            onClick={() => setProtocols(current => ({ ...current, [group.id]: 'torrent' }))}
                            className={cx(
                              'cursor-pointer rounded-md border px-2 py-1 text-[0.6875rem] font-bold',
                              protocolFor(group, option) === 'torrent'
                                ? 'border-accent bg-accent/15 text-accent-bright'
                                : 'border-line text-muted hover:text-ink',
                              (!sendsTorrent(option.release) || locked) && 'cursor-not-allowed opacity-50',
                            )}
                          >
                            Torrent
                          </button>
                          {(usenetEligible(group.result, option) || protocolFor(group, option) === 'usenet') && (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={protocolFor(group, option) === 'usenet'}
                              disabled={locked || !usenetEligible(group.result, option)}
                              title={
                                !usenetEligible(group.result, option)
                                  ? 'The selected Usenet source is unavailable. Choose Torrent or exclude this release.'
                                  : awaitsCheck(availabilityOf(group.result, option))
                                    ? 'Search and check Usenet for this release, and send it to SABnzbd when a copy is found'
                                    : 'Send to SABnzbd (whole Usenet source)'
                              }
                              onClick={() => setProtocols(current => ({ ...current, [group.id]: 'usenet' }))}
                              className={cx(
                                'cursor-pointer rounded-md border px-2 py-1 text-[0.6875rem] font-bold',
                                protocolFor(group, option) === 'usenet'
                                  ? 'border-sky bg-sky/15 text-sky'
                                  : 'border-line text-muted hover:text-ink',
                                (locked || !usenetEligible(group.result, option)) && 'cursor-not-allowed opacity-50',
                              )}
                            >
                              Usenet
                            </button>
                          )}
                        </span>
                      ) : null
                    if (!isChoice) {
                      const option =
                        group.options.find(({ index }) => index === (selected[group.id] ?? group.options[0].index)) ||
                        group.options[0]
                      const release = option.release
                      const localSize = group.part
                        ? group.result.local_size_by_part?.[group.part] || 0
                        : group.result.local_size
                      const delta = release.size && localSize ? release.size - localSize : null
                      const isServerBlocked = serverBlockedIds.has(
                        rowKey({ key: group.result.key, release: option.index }),
                      )
                      const blockReason = serverBlocked.find(
                        row => row.key === group.result.key && row.release === option.index,
                      )?.reason
                      const availability = availabilityOf(group.result, option)
                      return (
                        <label
                          key={group.id}
                          className={cx(
                            bulkDialog.row,
                            locked ? 'cursor-default' : 'cursor-pointer',
                            statusClass,
                            !status &&
                              (isServerBlocked
                                ? 'border-warn/40 bg-warn/6'
                                : enabled[group.id] !== false
                                  ? bulkDialog.rowSelected
                                  : bulkDialog.rowUnchecked),
                          )}
                        >
                          <input
                            type="checkbox"
                            disabled={locked}
                            className="size-3.5 shrink-0 accent-good"
                            checked={enabled[group.id] !== false}
                            onChange={event =>
                              setEnabled(current => ({ ...current, [group.id]: event.target.checked }))
                            }
                          />
                          {statusIcon}
                          <span className={cx('font-semibold', statusText)}>{group.result.title}</span>
                          <span className={bulkDialog.seasonBadge}>
                            {seasonLabel(group.result)}
                            {group.part && (
                              <>
                                {' '}
                                <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span>
                              </>
                            )}
                          </span>
                          <span
                            className="ml-auto flex items-center gap-1.5 tabular-nums"
                            title={`${release.releaseGroup} · ${release.tracker}`}
                          >
                            <span className="text-ink/70" title="Current local size">
                              {formatBytes(localSize) || '—'}
                            </span>
                            <span className="text-ink/60">→</span>
                            <span className="font-bold text-ink" title="Selected release size">
                              {formatBytes(release.size) || 'Unknown'}
                            </span>
                            {delta !== null && delta !== 0 && (
                              <span className="text-ink/60">
                                ({delta > 0 ? '+' : '−'}
                                {formatBytes(Math.abs(delta))})
                              </span>
                            )}
                          </span>
                          {protocolButtons(option)}
                          <span className="basis-full">
                            <ReleaseSummary release={release} />
                          </span>
                          {usenetEnabled && (
                            <UsenetStatus
                              row={availability}
                              loading={Boolean(currentAvailability?.loading)}
                              planned={plannedProof(currentPreflight, { key: group.result.key, release: option.index })}
                            />
                          )}
                          {/* A check the daily limit held back already says so in the availability line above. */}
                          {isServerBlocked && !status && blockReason !== checkBlockedReason(availability) && (
                            <span className="basis-full text-xs font-semibold text-warn">{blockReason}</span>
                          )}
                          {!status && unavailableChoices.some(choice => choice.id === group.id) && (
                            <span className="basis-full text-xs font-semibold text-warn">
                              Selected Usenet source is unavailable. Choose Torrent or exclude this release.
                            </span>
                          )}
                          <OutcomeLabel status={status} protocols={rowProtocols(group)} />
                        </label>
                      )
                    }

                    const chosenIndex = selected[group.id]
                    const chosen = chosenIndex !== undefined
                    const isPending = enabled[group.id] !== false && !chosen
                    const isExpanded = expanded[group.id] === true
                    const chosenOption = group.options.find(({ index }) => index === chosenIndex) || null
                    const localSize = group.part
                      ? group.result.local_size_by_part?.[group.part] || 0
                      : group.result.local_size
                    return (
                      <div
                        key={group.id}
                        className={cx(
                          'overflow-hidden rounded-lg border transition-colors',
                          statusClass ||
                            (isPending
                              ? 'border-warn/55 bg-warn/8'
                              : enabled[group.id] !== false
                                ? bulkDialog.rowSelected
                                : bulkDialog.rowUnchecked),
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <label className="touch-target grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-panel-raised">
                            <input
                              type="checkbox"
                              disabled={locked}
                              className="size-4 accent-good"
                              checked={enabled[group.id] !== false}
                              onChange={event =>
                                setEnabled(current => ({ ...current, [group.id]: event.target.checked }))
                              }
                              aria-label={`Include ${group.result.title} · ${seasonLabel(group.result)}${group.part ? ` · ${group.part}` : ''}`}
                            />
                          </label>
                          <button
                            type="button"
                            className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs"
                            onClick={() => setExpanded(current => ({ ...current, [group.id]: !isExpanded }))}
                            aria-expanded={isExpanded}
                          >
                            {statusIcon}
                            <span className={cx('font-semibold', statusText)}>{group.result.title}</span>
                            <span className={bulkDialog.seasonBadge}>
                              {seasonLabel(group.result)}
                              {group.part && (
                                <>
                                  {' '}
                                  <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span>
                                </>
                              )}
                            </span>
                            {chosen ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-extrabold text-accent-bright">
                                <Icon name="check" size={12} />
                                Selected
                              </span>
                            ) : (
                              <span
                                className={cx(
                                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-extrabold',
                                  enabled[group.id] !== false
                                    ? 'border-warn/45 bg-warn/15 text-warn'
                                    : 'border-line-strong bg-canvas-soft text-muted',
                                )}
                              >
                                <Icon name="alert" size={12} />
                                Choose 1 of {group.options.length}
                              </span>
                            )}
                            {chosenOption && (
                              <span className="basis-full">
                                <ReleaseSummary release={chosenOption.release} />
                              </span>
                            )}
                            {usenetEnabled && chosenOption && (
                              <UsenetStatus
                                row={availabilityOf(group.result, chosenOption)}
                                loading={Boolean(currentAvailability?.loading)}
                                planned={plannedProof(currentPreflight, {
                                  key: group.result.key,
                                  release: chosenOption.index,
                                })}
                              />
                            )}
                            <OutcomeLabel status={status} protocols={rowProtocols(group)} />
                            <span className="ml-auto flex items-center gap-1.5">
                              {chosenOption && (
                                <span
                                  className="flex items-center gap-1.5 tabular-nums"
                                  title={`${chosenOption.release.releaseGroup} · ${chosenOption.release.tracker}`}
                                >
                                  {localSize ? (
                                    <>
                                      <span className="text-ink/70" title="Current local size">
                                        {formatBytes(localSize) || '—'}
                                      </span>
                                      <span className="text-ink/60">→</span>
                                    </>
                                  ) : null}
                                  <span className="font-bold text-ink">
                                    {formatBytes(chosenOption.release.size) || 'Unknown'}
                                  </span>
                                </span>
                              )}
                              <Icon
                                name="chevron-right"
                                size={15}
                                className={cx(
                                  'shrink-0 text-muted transition-transform',
                                  isExpanded ? 'rotate-90' : '',
                                )}
                              />
                            </span>
                          </button>
                          {chosenOption && protocolButtons(chosenOption)}
                          {unavailableChoices.some(choice => choice.id === group.id) && (
                            <span className="basis-full text-xs font-semibold text-warn">
                              Selected Usenet source is unavailable. Choose Torrent or exclude this release.
                            </span>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="border-t border-line px-3 py-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              {group.options.map(option => {
                                const { index, release } = option
                                const checked = chosenIndex === index
                                return (
                                  <label
                                    key={index}
                                    className={cx(
                                      'flex items-start gap-2.5 rounded-lg border p-3 transition-colors',
                                      locked ? 'cursor-default' : 'cursor-pointer',
                                      checked
                                        ? 'border-accent bg-accent/10'
                                        : 'border-line bg-panel hover:border-line-strong',
                                    )}
                                  >
                                    <input
                                      type="radio"
                                      disabled={locked}
                                      name={group.id}
                                      className="mt-0.5 accent-accent"
                                      checked={checked}
                                      onChange={() => {
                                        setSelected(current => ({ ...current, [group.id]: index }))
                                        setProtocols(current => {
                                          const next = { ...current }
                                          delete next[group.id]
                                          return next
                                        })
                                      }}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <ReleaseSummary release={release} />
                                      <span className="mt-1 block text-xs font-bold text-ink">
                                        {formatBytes(release.size) || 'Unknown size'}
                                      </span>
                                      {usenetEnabled && (
                                        <UsenetStatus
                                          row={availabilityOf(group.result, option)}
                                          loading={Boolean(currentAvailability?.loading)}
                                        />
                                      )}
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                            <div className="mt-2.5 whitespace-pre-line break-words text-xs leading-relaxed text-ink/75">
                              <span className="font-bold text-ink">Note:</span>{' '}
                              {group.result.notes_by_part?.[group.part] ||
                                (group.result.notes && group.result.notes !== '-'
                                  ? group.result.notes
                                  : 'No release note provided.')}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="m-0 text-xs text-muted">
                  {usenetChecking
                    ? 'Checking whether these upgrades are available on Usenet…'
                    : 'No eligible upgrades in this scope. Change the review scope to check other library titles.'}
                </p>
              )}
            </section>
          )}

          {view === 'ready' && review.ready.length > 0 && (
            <BulkPlanSummary
              selectionCount={selections.length}
              preflight={currentPreflight}
              error={checkError}
              checking={checking}
              finished={finished}
              wholeSource={wholeSource}
              diskSpace={diskSpace}
              onWholeSource={setWholeSource}
              onDiskSpace={setDiskSpace}
            />
          )}
          {view === 'unavailable' && (
            <section>
              <h3 className="mb-3 text-xs font-extrabold tracking-[0.12em] text-warn uppercase">
                Not downloadable right now
              </h3>
              <div className="space-y-1.5">
                {blockedSorted.map(group => {
                  return (
                    <div
                      key={group.id}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs"
                    >
                      {protocols[group.id] === 'usenet' && selected[group.id] !== undefined && (
                        <label className="touch-target inline-flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={locked}
                            className="size-4 accent-good"
                            checked={enabled[group.id] !== false}
                            onChange={event =>
                              setEnabled(current => ({ ...current, [group.id]: event.target.checked }))
                            }
                            aria-label={`Include unavailable Usenet choice · ${group.result.title}`}
                          />
                          <span>
                            {enabled[group.id] === false
                              ? 'Excluded from batch'
                              : 'Selected Usenet source unavailable. Uncheck to exclude.'}
                          </span>
                        </label>
                      )}
                      <span className="font-semibold text-ink">{group.result.title}</span>
                      <span className="rounded border border-warn/25 px-1.5 py-0.5 text-xs font-extrabold text-warn">
                        {seasonLabel(group.result)}
                        {group.part && (
                          <>
                            {' '}
                            <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span>
                          </>
                        )}
                      </span>
                      <span
                        className="ml-auto min-w-0 truncate text-muted"
                        title={group.options.map(({ release }) => release.releaseGroup).join(' · ')}
                      >
                        {group.options.length
                          ? `Private: ${group.options.map(({ release }) => release.releaseGroup).join(' · ')}`
                          : 'No public magnet available'}
                      </span>
                      {usenetEnabled &&
                        group.options.map(option => (
                          <UsenetStatus
                            key={option.index}
                            row={availabilityOf(group.result, option)}
                            loading={Boolean(currentAvailability?.loading)}
                          />
                        ))}
                    </div>
                  )
                })}
                {serverBlocked.map(row => {
                  const item = results.find(entry => entry.key === row.key)
                  if (!item) return null
                  return (
                    <div
                      key={rowKey(row)}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs"
                    >
                      <span className="font-semibold text-ink">{item.title}</span>
                      <span className="rounded border border-warn/25 px-1.5 py-0.5 text-xs font-extrabold text-warn">
                        {seasonLabel(item)}
                      </span>
                      <span className="ml-auto min-w-0 text-muted">{row.reason}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        <footer className={bulkDialog.footer}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {!job && pendingChoices > 0 && (
              <span className="inline-flex items-center gap-1 font-bold text-warn">
                <Icon name="alert" size={13} />
                Resolve {pendingChoices} release choice{pendingChoices === 1 ? '' : 's'} first
              </span>
            )}
            {!job && unavailableChoices.length > 0 && (
              <span className="inline-flex items-center gap-1 font-bold text-warn">
                <Icon name="alert" size={13} />
                Resolve {unavailableChoices.length} unavailable Usenet choice
                {unavailableChoices.length === 1 ? '' : 's'} or exclude them
              </span>
            )}
            {!job && serverBlocked.length > 0 && (
              <span className="text-muted">
                {serverBlocked.length} selected row{serverBlocked.length === 1 ? '' : 's'} will be skipped
              </span>
            )}
          </span>
          <div className={bulkDialog.footerActions}>
            {inflightProgress ? (
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                <span className="text-xs text-muted" role="status">
                  Sending… {inflightProgress.settled}/{inflightProgress.total}
                </span>
                <button
                  type="button"
                  className={cx(
                    'touch-target inline-flex items-center gap-2 rounded-control border border-accent/35 bg-accent/12 px-4 py-2.5 text-sm font-bold text-accent-bright transition-colors',
                  )}
                  onClick={onClose}
                >
                  Continue in background
                </button>
              </div>
            ) : (
              <>
                <button
                  ref={cancelRef}
                  type="button"
                  className={bulkDialog.neutralButton}
                  onClick={onClose}
                  disabled={busy}
                >
                  {finished ? 'Close' : 'Cancel'}
                </button>
                {!finished && (
                  <button
                    type="button"
                    className={bulkDialog.downloadButton}
                    onClick={() =>
                      currentPreflight &&
                      unavailableChoices.length === 0 &&
                      onConfirm(currentPreflight.plan_id, {
                        whole_source: wholeSource || undefined,
                        disk_space: diskSpace || undefined,
                      })
                    }
                    disabled={
                      busy ||
                      checking ||
                      !currentPreflight ||
                      selections.length === 0 ||
                      newUnits === 0 ||
                      pendingChoices > 0 ||
                      unavailableChoices.length > 0 ||
                      (needsWhole && !wholeSource) ||
                      (needsSpace && !diskSpace)
                    }
                    title={
                      unavailableChoices.length
                        ? 'Choose another method or exclude unavailable Usenet choices'
                        : !currentPreflight
                          ? 'Waiting for the review to finish'
                          : newUnits === 0
                            ? 'Nothing new to send'
                            : 'Start the download batch'
                    }
                  >
                    {busy ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good" />
                    ) : (
                      <Icon name="download" size={17} />
                    )}
                    Start {newUnits || ''} download{newUnits === 1 ? '' : 's'}
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </section>
    </Modal>
  )
}
