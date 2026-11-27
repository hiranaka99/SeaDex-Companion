import { useEffect, useRef, useState } from 'react'
import { releaseOwned } from '../../../shared/download-plan'
import type { Config, ResultItem } from '../types'
import { currentReleases, releaseCours, releaseQuality } from '../release-status'
import type { DownloadRoutes } from '../download-routes'
import { buttonBase, cx } from '../styles'
import {
  IDLE_DOWNLOAD,
  sendKey,
  type LowSpaceHold,
  type SeasonAvailability,
  type DetailsDownloadState,
} from '../useCardDownloads'
import Icon from './Icons'
import DetailsQuality, { QUALITY_ICONS, QUALITY_TONES } from './DetailsQuality'
import type { DownloadEntry } from '../download-entry'
import ReleaseDetails from './ReleaseDetails'

import type { DownloadProtocol } from '../api'
import { releaseIdentity } from '../../../shared/releases'
import { PREFERENCE_BLOCKED_REASON } from '../../../shared/settings'

export function detailsSeasonName(season: ResultItem): string {
  return season.arr === 'Radarr' || season.season === 0
    ? 'Movie'
    : typeof season.season === 'number'
      ? `Season ${season.season}`
      : 'Release'
}

function RecommendationNotes({ notes }: { notes?: string | null }) {
  if (!notes || notes === '-') return null
  return (
    <details className="release-notes">
      <summary className="touch-target flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs font-semibold text-accent-bright">
        <Icon name="chevron-right" size={14} className="disclosure-chevron" />
        Why these releases?
      </summary>
      <div className="max-w-[70ch] pb-3 whitespace-pre-line text-sm leading-relaxed text-muted wrap-anywhere">
        {notes}
      </div>
    </details>
  )
}

function CurrentRelease({ groups, unscoped = false }: { groups: string[]; unscoped?: boolean }) {
  return (
    <span className="details-current-release details-clamp" title={groups.join(', ') || undefined}>
      <span>{unscoped ? 'Season files: ' : 'Your release: '}</span>
      <strong>{groups.length ? groups.join(', ') : 'None found'}</strong>
      {unscoped && <span> · cour ownership unconfirmed</span>}
    </span>
  )
}

interface Props {
  sectionId: string
  r: ResultItem
  config: Config | null
  dl: Record<number, DetailsDownloadState>
  busyDownload: string | null
  /** Index of the release being sent in this season, -1 when another season is sending, null when idle. */
  sendingIndex: number | null
  /** What each release can be sent through. */
  routes: DownloadRoutes
  availability: SeasonAvailability | undefined
  protocolFor: (index: number) => DownloadProtocol
  onProtocol: (index: number, protocol: DownloadProtocol) => void
  onRefreshAvailability: () => void
  /** Searches Prowlarr for one release of this season. */
  onSearchProwlarr: (release: number) => void
  /** Fetches and checks the best search result of one release of this season. */
  onCheckProwlarr: (release: number) => void
  onOpened: () => void
  /** `sendAnyway` sends after a low free-space warning. */
  /** `nzb` sends an unproven NZB the user chose for a private-tracker release. */
  onDownload: (release: number, sendAnyway?: boolean, nzb?: string) => void
  /** A send of a release in this season that is waiting for the low-space decision. */
  lowSpace: LowSpaceHold | null
  sendErrors: Record<string, string>
  onCancelLowSpace: () => void
  onDismissSendError: (release: number) => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
  ruleBusy: string
  onToggleExclusion: (part: string, excluded: boolean) => void
  onCorrectMatch: () => void
  onCorrectTitleMatch: () => void
  /** Starts expanded: the only season of a title, or one that needs a decision. Later changes never collapse it. */
  defaultOpen: boolean
  /** The next season that needs a decision, reached from the end of this one. */
  nextAction: { id: string; label: string } | null
  onJump: (id: string) => void
}

export default function DetailsSeason({
  sectionId,
  r,
  config,
  dl,
  busyDownload,
  sendingIndex,
  routes,
  availability,
  protocolFor,
  onProtocol,
  onRefreshAvailability,
  onSearchProwlarr,
  onCheckProwlarr,
  onOpened,
  onDownload,
  lowSpace,
  sendErrors,
  onCancelLowSpace,
  onDismissSendError,
  onPause,
  onResume,
  onRemove,
  ruleBusy,
  onToggleExclusion,
  onCorrectMatch,
  onCorrectTitleMatch,
  defaultOpen,
  nextAction,
  onJump,
}: Props) {
  const root = useRef<HTMLElement>(null)
  const { usenetAllowed } = routes
  const [initiallyOpen] = useState(defaultOpen)
  const groups = releaseCours(r)
  const split = groups.some(group => group.part)
  const seasonName = detailsSeasonName(r)
  const quality = releaseQuality(r)
  const ignored = Boolean(r.excluded)
  const mismatchedGroups = [...new Set(Object.values(r.mismatched_by_part || {}).flat())]
  // A season of a matched title is matched on its own; anything else needs the title's match.
  const seasonMatch = r.arr === 'Sonarr' && !!r.season && r.group_id !== null
  const blockedByPreferences = Boolean(r.preference_blocked) && (r.status === 'missing' || r.status === 'uncovered')
  const sources = (r.urls?.length ? r.urls : r.url ? [{ label: 'seadex.moe', url: r.url }] : []).filter(
    source => source.label === 'seadex.moe',
  )
  const activeReleases = Object.entries(dl)
    .filter(([, state]) => state.transfers.some(transfer => transfer.phase !== 'complete'))
    .map(([index]) => index)
    .join(',')
  const releaseSignature = JSON.stringify(r.releases.map(releaseIdentity))
  useEffect(() => {
    if (usenetAllowed && root.current?.querySelector<HTMLDetailsElement>('.details-season-disclosure')?.open) onOpened()
  }, [releaseSignature, usenetAllowed])

  useEffect(() => {
    if (!activeReleases || !root.current) return
    root.current.querySelector<HTMLDetailsElement>('.details-season-disclosure')!.open = true
    for (const index of activeReleases.split(',')) {
      let parent: HTMLElement | null =
        root.current.querySelector(`[data-release-index="${index}"]`)?.parentElement || null
      while (parent && parent !== root.current) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
        parent = parent.parentElement
      }
    }
  }, [activeReleases])

  const exclusion = (part = '') => {
    const excluded = ignored || Boolean(part && r.excluded_parts?.includes(part))
    const name = part || seasonName
    const blockedReason =
      part && ignored
        ? 'Restore the season to change individual cour rules.'
        : !r.library_key
          ? 'Run a new scan to enable season rules.'
          : ''
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2">
        <button
          type="button"
          className={cx(
            buttonBase,
            'min-h-11 min-w-0 max-w-full px-3 text-xs',
            excluded
              ? 'border-warn/40 bg-warn/10 text-warn'
              : 'border-transparent bg-transparent text-muted hover:bg-panel-raised hover:text-ink',
          )}
          // A toggle keeps one name; its pressed state says whether the rule is on. The visible label names its scope,
          // since a split season shows one of these for the season and one for every cour.
          aria-pressed={excluded}
          aria-label={`Ignore ${name} for bulk downloads and notifications`}
          aria-describedby={blockedReason ? `${sectionId}-rule-${part || 'season'}` : undefined}
          disabled={!r.library_key || Boolean(ruleBusy) || Boolean(part && ignored)}
          onClick={() => onToggleExclusion(part, !excluded)}
        >
          <Icon name="ban" size={15} />
          {excluded ? `${name} ignored for bulk` : `Ignore ${name} for bulk`}
        </button>
        {blockedReason && (
          <span id={`${sectionId}-rule-${part || 'season'}`} className="text-xs text-muted">
            {blockedReason}
          </span>
        )}
      </span>
    )
  }

  const renderReleases = (items: (typeof groups)[number]['items']) => (
    <div className="flex min-w-0 flex-col gap-3">
      {items.map(({ rel, index }) => (
        <div key={releaseIdentity(rel)} data-release-index={index}>
          <ReleaseDetails
            result={r}
            release={rel}
            config={config}
            state={dl[index] || IDLE_DOWNLOAD}
            busy={busyDownload !== null}
            sending={sendingIndex === index}
            sendLocked={sendingIndex !== null}
            protocol={protocolFor(index)}
            availability={
              availability?.byRelease[index]?.identity === releaseIdentity(rel)
                ? availability.byRelease[index]
                : undefined
            }
            availabilityLoading={Boolean(availability?.loading)}
            routes={routes}
            onProtocol={protocol => onProtocol(index, protocol)}
            onRefreshAvailability={onRefreshAvailability}
            onSearchProwlarr={() => onSearchProwlarr(index)}
            onCheckProwlarr={() => onCheckProwlarr(index)}
            onDownload={() => onDownload(index)}
            onDownloadNzb={nzb => onDownload(index, false, nzb)}
            lowSpace={lowSpace?.release === index ? lowSpace : null}
            onSendAnyway={() => onDownload(index, true)}
            onCancelLowSpace={onCancelLowSpace}
            sendError={sendErrors[sendKey(r.key, index)] || null}
            onDismissSendError={() => onDismissSendError(index)}
            onPause={onPause}
            onResume={onResume}
            onRemove={onRemove}
          />
        </div>
      ))}
    </div>
  )

  /**
   * An upgrade that only exists on a private tracker: nothing here can send it, so the status says so up front instead
   * of promising a download the release row cannot start.
   */
  const torrentOnly = routes.mode === 'torrent_only'
  const manualOnly = (items: (typeof groups)[number]['items'], kind: string) => {
    const wanted = items.filter(({ rel }) => !releaseOwned(r, rel))
    return (
      torrentOnly &&
      kind === 'upgrade' &&
      wanted.length > 0 &&
      wanted.every(({ rel }) => !routes.release(rel, undefined).torrent.sendable)
    )
  }
  const manualNote = <span className="details-summary-note text-muted">Manual download only · no public magnet</span>
  const ownershipId = `${sectionId}-ownership`
  const matchLabel = seasonMatch
    ? `${r.season_mapping_override ? 'Change' : 'Correct'} Season ${r.season} match`
    : 'Choose AniList match'
  const courStatuses = new Map(groups.filter(group => group.part).map(group => [group.part, releaseQuality(r, group)]))
  const seasonLinks = [
    ...sources.map(source => (
      <a
        key={source.url}
        href={source.url}
        target="_blank"
        rel="noopener"
        className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright"
        aria-label={`Open ${seasonName} on SeaDex (new tab)`}
      >
        SeaDex
        <Icon name="chevron-right" size={14} />
      </a>
    )),
    ...(r.arr === 'Sonarr' && !!r.season && r.anilist_id
      ? [
          <a
            key="anilist"
            href={`https://anilist.co/anime/${r.anilist_id}`}
            target="_blank"
            rel="noopener"
            className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright"
            aria-label={`Open Season ${r.season} in AniList (new tab)`}
          >
            AniList
            <Icon name="chevron-right" size={14} />
          </a>,
        ]
      : []),
  ]

  return (
    <section
      ref={root}
      id={sectionId}
      tabIndex={-1}
      className="details-season min-w-0"
      aria-label={seasonName}
      data-needs-review={quality.kind === 'review' || undefined}
    >
      <details
        className="details-season-disclosure"
        open={initiallyOpen || undefined}
        onToggle={event => {
          if (usenetAllowed && (event.target as HTMLDetailsElement).open) onOpened()
        }}
      >
        <summary
          className="details-summary cursor-pointer"
          // A short name for the control; the ownership lines are its description.
          aria-label={`${seasonName}: ${quality.label}`}
          aria-describedby={ownershipId}
        >
          <span className="details-summary-title">
            <span className="details-season-name">{seasonName}</span>
            <DetailsQuality status={quality} />
          </span>
          <span id={ownershipId} className="details-summary-body">
            {split && r.precise_part_ownership ? (
              <span className="details-current-release">
                Your releases:
                <span className="details-owned-cours">
                  {groups
                    .filter(group => group.part)
                    .map(group => {
                      const status = courStatuses.get(group.part)!
                      const owned = currentReleases(r, group.part).join(', ') || 'None found'
                      return (
                        <span key={group.part} className="details-owned-cour" title={`${group.part}: ${owned}`}>
                          <Icon
                            name={QUALITY_ICONS[status.kind]}
                            size={13}
                            className={cx('details-owned-cour-glyph', QUALITY_TONES[status.kind])}
                          />
                          <span className="sr-only">{status.label}, </span>
                          <span className="details-owned-cour-text">
                            {group.part}: <strong>{owned}</strong>
                          </span>
                        </span>
                      )
                    })}
                </span>
              </span>
            ) : (
              <CurrentRelease groups={r.have} unscoped={split} />
            )}
            {(r.missing_episode_count || 0) > 0 && (
              <span className="details-summary-note text-warn">
                {r.missing_episode_count} episode{r.missing_episode_count === 1 ? '' : 's'} missing
              </span>
            )}
            {mismatchedGroups.length > 0 && (
              <span className="details-summary-note text-warn">
                Your {mismatchedGroups.join(', ')} files differ from the listed release
              </span>
            )}
            {!split && groups.length === 1 && manualOnly(groups[0].items, quality.kind) && manualNote}
            {r.season_mapping_override && <span className="details-summary-note text-muted">Manual season match</span>}
            {ignored && <span className="details-summary-note text-warn">Ignored for bulk</span>}
            {!ignored && !!r.excluded_parts?.length && (
              <span className="details-summary-note text-warn">Ignored for bulk: {r.excluded_parts.join(', ')}</span>
            )}
            {activeReleases && (
              <span className="details-summary-note text-accent-bright">Download activity · expand for controls</span>
            )}
          </span>
          <Icon name="chevron-right" size={16} className="disclosure-chevron text-muted" />
        </summary>
        <div className="details-season-content">
          {availability?.error && (
            <p className="mb-3 text-xs text-warn wrap-anywhere" role="alert">
              Usenet refresh failed: {availability.error}. Last-known results remain visible. Re-check the sources to
              try again.
            </p>
          )}
          {quality.kind === 'review' && (
            <div className="details-review-prompt">
              <p className="m-0 text-sm text-ink">
                {seasonMatch
                  ? `No AniList entry matched ${seasonName}, so its SeaDex releases cannot be checked.`
                  : 'No AniList entry matched this title, so its SeaDex releases cannot be checked.'}
              </p>
              <p className="mt-1 mb-0 text-xs text-muted">
                Choose the right AniList entry and the library rescans with it.
              </p>
              <button
                type="button"
                className={cx(
                  buttonBase,
                  'mt-3 min-h-11 border-transparent bg-accent px-3 text-xs text-on-accent enabled:hover:bg-accent-bright',
                )}
                disabled={!r.library_key || Boolean(ruleBusy)}
                onClick={seasonMatch ? onCorrectMatch : onCorrectTitleMatch}
                aria-label={matchLabel}
              >
                <Icon name="search" size={15} />
                {matchLabel}
              </button>
              {!r.library_key && (
                <p className="mt-2 mb-0 text-xs text-muted">Run a new scan to enable manual matching.</p>
              )}
            </div>
          )}
          {!split && quality.kind !== 'review' && (r.status === 'missing' || r.status === 'uncovered') && (
            <p className="mb-3 text-sm text-muted">
              {blockedByPreferences
                ? 'SeaDex lists releases for this season, but your release preferences exclude all of them. Each release below says why.'
                : r.private_only
                  ? 'SeaDex lists releases for this season only on private trackers, which are turned off in Release preferences.'
                  : r.status === 'uncovered'
                    ? 'This season has no releases on SeaDex.'
                    : 'Not listed on seadex.moe.'}
            </p>
          )}
          {!split && <RecommendationNotes notes={r.notes} />}
          {groups.length === 0 && r.status !== 'missing' && r.status !== 'uncovered' && (
            <p className="mb-3 text-sm text-muted">
              No release details are available. Run a new library scan to refresh this title.
            </p>
          )}
          {groups.map((cour, courIndex) => {
            if (!cour.part) return <div key="season">{renderReleases(cour.items)}</div>
            const courStatus = courStatuses.get(cour.part) || releaseQuality(r, cour)
            const courLinks = (r.urls || []).filter(source => source.label === cour.part)
            const needsAction = courStatus.kind === 'upgrade' || courStatus.kind === 'review'
            const courManual = manualOnly(cour.items, courStatus.kind)
            const courIgnored = Boolean(r.excluded_parts?.includes(cour.part)) && !ignored
            return (
              <details
                id={`${sectionId}-cour-${courIndex}`}
                key={cour.part}
                className="details-cour"
                // A season that opens for a decision opens the cours holding it too, the same as "Review upgrade".
                open={(initiallyOpen && needsAction) || undefined}
                aria-label={`${seasonName} · ${cour.part}`}
                data-needs-action={needsAction || undefined}
              >
                <summary className="details-summary cursor-pointer" aria-label={`${cour.part}: ${courStatus.label}`}>
                  <span className="details-summary-title">
                    <span className="details-season-name">{cour.part}</span>
                    <DetailsQuality status={courStatus} />
                  </span>
                  {/* The season summary above already names the files of every cour. */}
                  {(courIgnored || courManual) && (
                    <span className="details-summary-body">
                      {courManual && manualNote}
                      {courIgnored && <span className="details-summary-note text-warn">Ignored for bulk</span>}
                    </span>
                  )}
                  <Icon name="chevron-right" size={16} className="disclosure-chevron text-muted" />
                </summary>
                <div className="details-cour-content">
                  {cour.unavailable && (
                    <p className="mb-3 text-sm text-muted wrap-anywhere">
                      {cour.unavailable === PREFERENCE_BLOCKED_REASON
                        ? 'SeaDex lists releases for this cour, but your release preferences exclude all of them. Each release below says why.'
                        : cour.unavailable}
                    </p>
                  )}
                  {cour.items.length === 0 && !cour.unavailable && (
                    <p className="mb-3 text-sm text-muted">No release details are available for this cour.</p>
                  )}
                  <RecommendationNotes notes={r.notes_by_part?.[cour.part]} />
                  {renderReleases(cour.items)}
                  <div className="details-secondary-actions" aria-label={`${cour.part} options`} role="group">
                    {courLinks.map(source => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noopener"
                        className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright"
                        aria-label={`Open ${seasonName} ${cour.part} on SeaDex (new tab)`}
                      >
                        SeaDex · {cour.part}
                        <Icon name="chevron-right" size={14} />
                      </a>
                    ))}
                    {exclusion(cour.part)}
                  </div>
                </div>
              </details>
            )
          })}
          {r.precise_part_ownership &&
            !split &&
            r.have.length > 0 &&
            r.releases.some(
              rel =>
                rel.kind === 'best' &&
                !releaseOwned(r, rel) &&
                !mismatchedGroups.some(group => group.toLowerCase() === rel.releaseGroup.toLowerCase()) &&
                !r.releases.some(
                  other => other.files_match && other.releaseGroup.toLowerCase() === rel.releaseGroup.toLowerCase(),
                ) &&
                r.have.some(group => group.toLowerCase() === rel.releaseGroup.toLowerCase()),
            ) && (
              <p className="mt-3 text-xs text-muted">
                The release group appears in your files, but complete ownership is not confirmed.
              </p>
            )}
          <div
            className="details-secondary-actions details-season-actions"
            role="group"
            aria-label={`${seasonName} options`}
          >
            {seasonLinks}
            {r.arr === 'Sonarr' && !!r.season && quality.kind !== 'review' && (
              <button
                type="button"
                className={cx(
                  buttonBase,
                  'min-h-11 border-transparent bg-transparent px-3 text-xs text-muted hover:bg-panel-raised hover:text-ink',
                )}
                disabled={!r.library_key || Boolean(ruleBusy)}
                onClick={onCorrectMatch}
                aria-label={`${r.season_mapping_override ? 'Change' : 'Correct'} Season ${r.season} match`}
              >
                <Icon name="refresh" size={15} />
                {r.season_mapping_override ? 'Change season match' : 'Correct season match'}
              </button>
            )}
            {exclusion()}
            {nextAction && (
              <button
                type="button"
                className={cx(
                  buttonBase,
                  'details-next-action ml-auto min-h-11 border-accent/40 bg-accent/10 px-3 text-xs text-accent-bright hover:bg-accent/16',
                )}
                onClick={() => onJump(nextAction.id)}
              >
                Next: {nextAction.label}
                <Icon name="chevron-right" size={15} />
              </button>
            )}
          </div>
        </div>
      </details>
    </section>
  )
}
