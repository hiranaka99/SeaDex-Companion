import { normalizeTorrentPath as normalizeFile, releaseFilesMatch, releaseOwned } from '../../../shared/download-plan'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Config, Release, ResultItem } from '../types'
import { formatBytes, formatEta, seasonLabel, sizeDelta } from '../utils'
import type { DownloadRoutes } from '../download-routes'
import { buttonBase, cx, downloadTextTone } from '../styles'
import Icon from './Icons'
import { DownloadActions, ImportStatusLine } from './DownloadsPanel'
import { clientName, phaseLabel, type DownloadEntry } from '../download-entry'
import type { DownloadPhase, DownloadProtocol } from '../api'
import type { UsenetCandidate } from '../../../shared/usenet-contracts'
import { DiskLine } from './PlanReview'
import { releaseFileScope } from '../release-actions'
import type { ReleaseActions } from '../useReleaseActions'
import { DEFAULT_TRACKER_MODE } from '../../../shared/settings'
import { displayDateTimeMinutes } from '../datetime'
import { availabilityErrors } from '../usenet-observation'
import {
  candidateChoosable,
  candidateConfirmText,
  candidateFacts,
  candidateFinding,
  candidatesIntro,
  checkBlockedReason,
  describeUsenet,
} from '../usenet-review'

interface Props {
  result: ResultItem
  release: Release
  config: Config | null
  /** What this release can be sent through. */
  routes: DownloadRoutes
  /** The row's transfers, send state, availability and verdict, and what it can do. */
  actions: ReleaseActions
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
/** qBittorrent names a magnet by its hash until the metadata arrives. */
const HASH_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i
const ATTENTION_PHASES = new Set<DownloadPhase>(['error', 'missing', 'acceptance_unknown'])
/** Order of the per-phase counts in a multi-torrent summary: active work first. */
const PHASE_ORDER: DownloadPhase[] = [
  'downloading',
  'verifying',
  'repairing',
  'unpacking',
  'post_processing',
  'queued',
  'paused',
  'acceptance_unknown',
  'error',
  'missing',
  'unavailable',
  'seeding',
  'complete',
]

export default function ReleaseDetails({ result: r, release: rel, config, routes, actions }: Props) {
  const {
    transfers,
    busy,
    sending,
    sendLocked,
    lowSpace,
    error: sendError,
    availability: currentAvailability,
    availabilityLoading,
    route,
    verdict,
  } = actions
  const isBest = rel.kind === 'best'
  const localSize = rel.part ? r.local_size_by_part?.[rel.part] || 0 : r.local_size
  const delta = sizeDelta(rel.size, localSize)
  const active = transfers.filter(transfer => transfer.phase !== 'complete')
  const complete = transfers.length > 0 && active.length === 0
  const inClient = active.length > 0
  const publicOnly = (config?.tracker_mode || DEFAULT_TRACKER_MODE) === 'public'
  const usenetEnabled = routes.usenetAllowed
  const usenet = usenetEnabled
    ? describeUsenet(
        currentAvailability,
        routes.usenetReady,
        Boolean(rel.private_sources?.length),
        routes.prowlarrConfigured,
      )
    : null
  /** The row shows a Prowlarr result (a private-tracker release, or a public one the hash indexers lack). */
  const privateSearch = currentAvailability?.search === 'prowlarr'
  const prowlarrSearchable =
    (privateSearch && currentAvailability?.aggregate !== 'not_configured') ||
    currentAvailability?.fallback === 'prowlarr'
  const prowlarrSearched =
    privateSearch &&
    Boolean(currentAvailability?.hashes.some(item => item.provider === 'prowlarr' && item.state !== 'not_checked'))
  const availabilityRefreshing = availabilityLoading || currentAvailability?.refreshing === true
  const refreshError = currentAvailability ? availabilityErrors([currentAvailability]) : null
  const chosen: DownloadProtocol = verdict.protocol
  /** A private-tracker torrent the server finds through Prowlarr and checks file by file before sending. */
  const viaProwlarr = route.torrent.viaProwlarr
  const torrentUsable = route.torrent.sendable
  const usenetUsable = route.usenet.sendable
  const disabled = !verdict.enabled
  /** Owning this release already; sending it again is a deliberate re-download, not an upgrade. */
  const owned = releaseOwned(r, rel)

  const fileScope = useMemo(() => releaseFileScope(rel), [rel])
  const sizeLabel = fileScope.exact
    ? formatBytes(fileScope.bytes) || '0 B'
    : fileScope.approximateBytes !== null
      ? `~${formatBytes(fileScope.approximateBytes) || '0 B'}`
      : 'size unavailable'
  const fileCount = `${fileScope.files.length} selected file${fileScope.files.length === 1 ? '' : 's'}`
  const scopeLabel = fileScope.selected ? `${fileCount} · ${sizeLabel}` : `Whole release · ${sizeLabel}`
  /** Re-sending an owned release waits for a second click, so a duplicate download is never one stray tap away. */
  const [confirmingRedownload, setConfirmingRedownload] = useState(false)
  /** An unproven NZB is only sent after the person confirms it is the release. */
  const [confirmingNzb, setConfirmingNzb] = useState<UsenetCandidate | null>(null)
  // Search results that are no proven copy: checked ones can still be chosen, the others are listed as they are.
  const nzbCandidates =
    privateSearch && currentAvailability?.aggregate !== 'available'
      ? currentAvailability.hashes.flatMap(item => item.candidates || [])
      : []
  /** Why no NZB could be checked: a daily limit that was reached, or a paused indexer. */
  const checkBlocked = checkBlockedReason(currentAvailability)
  const nzbConfirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirmingNzb) nzbConfirmRef.current?.focus()
  }, [confirmingNzb])
  useEffect(() => {
    if (
      confirmingNzb &&
      !nzbCandidates.some(candidate => candidate.entry_id === confirmingNzb.entry_id && candidateChoosable(candidate))
    )
      setConfirmingNzb(null)
  })
  const rowRef = useRef<HTMLElement>(null)
  const downloadRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const lowSpaceRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  /**
   * Set when this row's own controls start a send or close an inline alert. Disabling or removing the button that had
   * focus would otherwise drop keyboard focus to the page body, in the middle of a modal.
   */
  const keepFocus = useRef(false)
  const focusIsHere = () => {
    const current = document.activeElement
    return !current || current === document.body || Boolean(rowRef.current?.contains(current))
  }
  // Each inline alert takes focus on its safe or next action, the way the re-download confirm always has.
  useEffect(() => {
    if (confirmingRedownload) confirmRef.current?.focus()
  }, [confirmingRedownload])
  useEffect(() => {
    if (lowSpace && focusIsHere()) lowSpaceRef.current?.focus()
  }, [lowSpace])
  useEffect(() => {
    if (sendError && keepFocus.current && focusIsHere()) retryRef.current?.focus()
  }, [sendError])
  useEffect(() => {
    if (!owned || inClient || complete) setConfirmingRedownload(false)
  }, [owned, inClient, complete])
  useEffect(() => {
    if (!keepFocus.current) return
    const current = document.activeElement
    // Focus already moved on: an alert took it, or the person went elsewhere.
    if (current && current !== document.body && current !== rowRef.current) {
      keepFocus.current = false
      return
    }
    const button = downloadRef.current
    if (button && !button.disabled) {
      button.focus()
      keepFocus.current = false
    } else rowRef.current?.focus({ preventScroll: true })
  })
  const holdFocus = (action: () => void) => () => {
    keepFocus.current = true
    action()
  }

  const catalogByHash = useMemo(
    () => new Map((rel.torrent_files || []).map(catalog => [catalog.hash.toLowerCase(), catalog.files])),
    [rel],
  )
  const catalogFiles = (transfer: DownloadEntry) =>
    transfer.source_hash ? catalogByHash.get(transfer.source_hash.toLowerCase()) : undefined

  /** Names a torrent by its file when the selection, SeaDex's file list, or the client knows it. */
  const transferName = (transfer: DownloadEntry): { label: string; path: string } | null => {
    const scope = transfer.scope || []
    if (scope.length === 1) return { label: baseName(scope[0]), path: scope[0] }
    const files = catalogFiles(transfer)
    if (files?.length === 1) return { label: baseName(files[0].name), path: files[0].name }
    const live = transfer.title.trim()
    if (live && live !== r.title && !live.startsWith('usenet:') && !HASH_NAME.test(live))
      return { label: live, path: live }
    if (scope.length > 1) return { label: `${scope.length} selected files`, path: scope.join('\n') }
    return null
  }

  /** Expected bytes of one torrent; SeaDex's file list fills in before the client has the metadata. */
  const expectedBytes = (transfer: DownloadEntry) => {
    if (transfer.total_size > 0) return transfer.total_size
    const files = catalogFiles(transfer)
    if (!files) return 0
    const scope = transfer.scope?.length ? new Set(transfer.scope.map(normalizeFile)) : null
    return files.reduce((sum, file) => sum + (!scope || scope.has(normalizeFile(file.name)) ? file.length : 0), 0)
  }

  const overall = (() => {
    let downloaded = 0
    let total = 0
    let speed = 0
    let unknown = 0
    let attention = 0
    const counts = new Map<DownloadPhase, number>()
    for (const transfer of transfers) {
      const bytes = expectedBytes(transfer) || (transfer.phase === 'complete' ? transfer.downloaded : 0)
      if (bytes > 0) {
        total += bytes
        downloaded += transfer.phase === 'complete' ? bytes : Math.min(transfer.downloaded, bytes)
      } else unknown++
      if (transfer.phase === 'downloading' && transfer.client === 'qbittorrent') speed += transfer.speed
      if (ATTENTION_PHASES.has(transfer.phase) || transfer.unbound) attention++
      counts.set(transfer.phase, (counts.get(transfer.phase) || 0) + 1)
    }
    const phaseSummary = [...counts]
      .sort(([a], [b]) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b))
      .map(([phase, count]) => `${count} ${phaseLabel(phase).toLowerCase()}`)
      .join(' · ')
    return {
      downloaded,
      total,
      speed,
      unknown,
      attention,
      phaseSummary,
      percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 1000) / 10) : 0,
      anyBar: transfers.some(transfer => transfer.phase !== 'complete'),
    }
  })()

  const buttonTitle = verdict.reason
  const buttonLabel = verdict.label

  // The kind label already says BEST, so a SeaDex "Best" tag would repeat it.
  const tags = [...new Set([...(rel.dual_audio ? ['Dual Audio'] : []), ...(rel.tags || [])])].filter(
    tag => !(isBest && tag.trim().toLowerCase() === 'best'),
  )
  const sameGroup = (group: string) => group.trim().toLowerCase() === rel.releaseGroup.trim().toLowerCase()
  const verified = releaseFilesMatch(r, rel)
  // The library holds another release this group lists for the same season or cour.
  const sibling =
    !verified &&
    r.releases.some(
      other => other.files_match && (other.part || '') === (rel.part || '') && sameGroup(other.releaseGroup),
    )
  const mismatched = !verified && !sibling && Boolean(r.mismatched_by_part?.[rel.part || '']?.some(sameGroup))
  // Naming the target only helps where several releases compete for the same season or cour.
  const competing = r.releases.filter(other => (other.part || '') === (rel.part || '')).length > 1
  const targeted = Boolean(rel.target) && competing && !verified && !complete && !inClient
  const recommended = verdict.recommended
  // While an inline alert asks for a decision, the button it holds back steps aside so the alert leads.
  const held = lowSpace !== null || confirmingRedownload || confirmingNzb !== null
  const buttonTone = complete
    ? 'border-good/40 bg-good/12 text-good'
    : disabled || held
      ? 'border-line bg-panel-raised text-muted'
      : owned
        ? 'border-line bg-transparent text-muted enabled:hover:bg-panel-raised enabled:hover:text-ink'
        : recommended
          ? 'border-transparent bg-accent text-on-accent enabled:hover:bg-accent-bright'
          : 'border-line-strong bg-panel text-ink enabled:hover:bg-panel-raised'
  const statusCopy = complete ? `Download completed in ${clientName(transfers[0].client)}` : ''
  const usenetCategory = r.arr === 'Sonarr' ? config?.sabnzbd_sonarr_category : config?.sabnzbd_radarr_category
  const destination = chosen === 'usenet' ? 'SABnzbd' : 'qBittorrent'
  const sendFacts = verdict.facts
  const usenetBytes = currentAvailability?.hashes[0]?.total_bytes || 0
  /** The two figures a send is decided on: what it downloads, and how the library grows if it replaces your files. */
  const downloadSize =
    chosen === 'usenet'
      ? usenetBytes
        ? `~${formatBytes(usenetBytes)}`
        : 'Size unavailable'
      : sizeLabel.replace(/^s/, 'S')
  const libraryChange = !owned && !verified && rel.size > 0 && localSize > 0 ? delta || 'No change' : ''
  /** A release SeaDex lists without a public magnet: it can only be fetched by hand from its tracker. */
  const manualOnly = chosen === 'torrent' && !torrentUsable && !inClient && !complete && !usenetUsable
  const tracker = rel.tracker.trim()
  /** No public magnet means the release sits on a private tracker. */
  const privateTracker = !rel.torrent_available
  // `rel.url` is the SeaDex page listing the release; only `tracker_url` leads to the tracker itself.
  const manualSource = rel.tracker_url
    ? { href: rel.tracker_url, label: `Open on ${tracker || 'the tracker'}` }
    : (() => {
        const href = rel.url || (r.urls || []).find(source => source.label === (rel.part || 'seadex.moe'))?.url || r.url
        return href ? { href, label: 'Open on SeaDex' } : null
      })()
  const lowSpaceChecks = lowSpace
    ? lowSpace.checks.filter(check =>
        lowSpace.reason === 'low' ? check.sufficient === false : check.free_bytes === null,
      )
    : []
  const silentClients = [...new Set(lowSpaceChecks.map(check => clientName(check.client)))]

  return (
    <article
      ref={rowRef}
      tabIndex={-1}
      className={cx(
        'release-row min-w-0 rounded-xl border p-4 max-[600px]:p-3.5',
        // Green means "you have this": SeaDex's pick that is still missing stays neutral, and its button leads.
        inClient
          ? 'border-accent bg-accent/5'
          : owned
            ? 'border-good/35 bg-good/5'
            : recommended
              ? 'border-line-strong bg-panel'
              : 'border-line bg-panel',
      )}
      data-owned={owned || undefined}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* SeaDex's ranking reads as a label of its own, apart from the group name it qualifies. */}
        <span
          className={cx(
            'release-kind shrink-0 rounded-md border px-1.5 py-px text-xs',
            isBest ? 'border-line-strong font-bold text-ink' : 'border-line font-semibold text-muted',
          )}
        >
          {isBest ? 'Best' : 'Alternative'}
        </span>
        <div className="release-identity flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="max-w-full text-sm font-semibold text-ink wrap-anywhere">{rel.releaseGroup}</span>
          {privateTracker && (
            <span
              className="release-private inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-canvas-soft px-2 py-0.5 text-xs font-semibold text-muted"
              title={tracker ? `${tracker} is a private tracker` : 'This release is on a private tracker'}
            >
              <Icon name="lock" size={12} />
              Private tracker{tracker ? ` · ${tracker}` : ''}
            </span>
          )}
          {owned && !verified && (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-good">
              <Icon name="check" size={13} />
              Owned
            </span>
          )}
          {/* Your own preference, not a SeaDex tag: plain accent text with a glyph rather than another chip. */}
          {targeted && (
            <span
              className="release-target inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent-bright"
              title="Your release preferences pick this release for bulk downloads"
            >
              <Icon name="sparkles" size={13} />
              Your target
              <span className="sr-only">: your release preferences pick this release for bulk downloads</span>
            </span>
          )}
          {tags.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {tags.map(tag => (
                <span
                  key={tag}
                  className={cx(
                    'max-w-full rounded-md border px-2 py-0.5 text-xs font-semibold text-ink wrap-anywhere',
                    tag === 'Dual Audio' ? 'border-sky/40 bg-sky/12' : 'border-purple/40 bg-purple/12',
                  )}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {verified && (
        <p className="m-0 mb-3 flex items-start gap-1.5 text-xs font-semibold text-good">
          <Icon name="check" size={14} className="mt-0.5 shrink-0" />
          <span>Your files match this release exactly.</span>
        </p>
      )}
      {sibling && (
        <p className="m-0 mb-3 flex items-start gap-1.5 text-xs text-muted" role="note">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            Your {rel.releaseGroup} files are the group's other release listed here, not this one.
          </span>
        </p>
      )}
      {mismatched && (
        <p className="m-0 mb-3 flex items-start gap-1.5 text-xs text-warn" role="note">
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold">Your {rel.releaseGroup} files differ from this release.</span>
            <span className="mt-0.5 block text-ink">
              Their sizes do not match the files SeaDex lists, so they are an earlier version or a different release by
              the same group.
            </span>
          </span>
        </p>
      )}
      {rel.excluded_by && (
        <p className="m-0 mb-3 flex items-start gap-1.5 text-xs text-muted" role="note">
          <Icon name="ban" size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold text-ink">Excluded by your release preferences: {rel.excluded_by}.</span>
            {/* A private-tracker release nothing can send says so below, where its download would be. */}
            <span className="mt-0.5 block">
              Bulk download skips it.{manualOnly ? '' : ' You can still download it here.'}
            </span>
          </span>
        </p>
      )}
      {usenetEnabled && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-xs">
          <span
            className={cx(
              'font-semibold',
              usenet
                ? usenet.usable
                  ? 'text-good'
                  : currentAvailability?.aggregate === 'not_checked' || currentAvailability?.aggregate === 'unverified'
                    ? 'text-muted'
                    : 'text-warn'
                : 'text-muted',
            )}
          >
            {usenet ? usenet.label : availabilityLoading ? 'Checking Usenet sources…' : 'Usenet: not checked'}
          </span>
          {usenet && !usenet.usable && currentAvailability?.aggregate !== 'not_checked' && (
            <span className={cx('min-w-0 basis-44 flex-1 wrap-anywhere', checkBlocked ? 'text-warn' : 'text-muted')}>
              {usenet.detail}
            </span>
          )}
          {rel.torrent_available && (
            <button
              type="button"
              className="touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-accent-bright hover:bg-accent/10"
              onClick={actions.refresh}
              title="Re-check AnimeTosho and AmeNZB for this season"
              aria-label={`Re-check Usenet sources · ${seasonLabel(r)}`}
            >
              <Icon name="refresh" size={13} />
              Re-check
            </button>
          )}
          {prowlarrSearchable && (
            <button
              type="button"
              className="touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-accent-bright hover:bg-accent/10"
              onClick={actions.search}
              title="Search the Usenet indexers in Prowlarr for this release. Each NZB checked counts toward the indexer's download limit."
              aria-label={`${prowlarrSearched ? 'Search Prowlarr again' : 'Search Prowlarr'} · ${seasonLabel(r)} · ${rel.releaseGroup}`}
            >
              <Icon name="search" size={13} />
              {prowlarrSearched ? 'Search again' : 'Search Prowlarr'}
            </button>
          )}
          {usenet?.action === 'check' && (
            <button
              type="button"
              className="touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-accent-bright hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={actions.check}
              disabled={availabilityRefreshing}
              title="Fetch the best result's NZB and compare its files with this release. It counts toward the indexer's download limit."
              aria-label={`Check now · ${seasonLabel(r)} · ${rel.releaseGroup}`}
            >
              <Icon name="check" size={13} />
              Check now
            </button>
          )}
          {currentAvailability?.checked_at && (
            <span className="basis-full text-muted">
              {currentAvailability.stale ? 'Last-known cached result' : 'Cached result'} · Last checked{' '}
              <time dateTime={currentAvailability.checked_at}>
                {displayDateTimeMinutes(currentAvailability.checked_at)}
              </time>
              {availabilityRefreshing ? ' · Refreshing…' : ''}
            </span>
          )}
          {availabilityRefreshing && currentAvailability?.checked_at === '' && (
            <span className="basis-full text-muted" role="status">
              Checking Usenet sources. No previous provider check.
            </span>
          )}
          {refreshError && (
            <span className="basis-full text-warn wrap-anywhere" role="status">
              Refresh failed: {refreshError}.{' '}
              {usenetUsable
                ? 'Last-known availability is still shown. The download review revalidates the source.'
                : 'Re-check the sources to try again.'}
            </span>
          )}
          {nzbCandidates.length > 0 && (
            <div className="release-nzb-candidates basis-full">
              <p className="m-0 text-muted">{candidatesIntro(nzbCandidates)}</p>
              <ul className="mt-1.5 mb-0 list-none divide-y divide-line rounded-lg border border-line p-0">
                {nzbCandidates.map(candidate => {
                  const finding = candidateFinding(candidate)
                  return (
                    <li
                      key={candidate.entry_id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 basis-60">
                        {candidate.info_url ? (
                          <a
                            className="font-semibold text-accent-bright wrap-anywhere"
                            href={candidate.info_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {candidate.title || 'Untitled post'}
                            <span className="sr-only"> on {candidate.indexer || 'the indexer'} (new tab)</span>
                          </a>
                        ) : (
                          <span className="font-semibold text-ink wrap-anywhere">
                            {candidate.title || 'Untitled post'}
                          </span>
                        )}
                        <span className="mt-0.5 block text-muted">{candidateFacts(candidate)}</span>
                        {finding.tone === 'warn' ? (
                          <span className="mt-0.5 flex items-start gap-1.5 text-warn">
                            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
                            <span className="min-w-0">{finding.text}</span>
                          </span>
                        ) : (
                          <span className={cx('mt-0.5 block', finding.tone === 'quiet' ? 'text-muted' : 'text-ink')}>
                            {finding.text}
                          </span>
                        )}
                      </div>
                      {candidateChoosable(candidate) && (
                        <button
                          type="button"
                          className={cx(
                            buttonBase,
                            'min-h-9 shrink-0 border-line-strong bg-panel px-2.5 text-xs text-ink enabled:hover:bg-panel-raised',
                          )}
                          disabled={!routes.usenetReady || inClient || complete || sendLocked || lowSpace !== null}
                          title={
                            routes.usenetReady ? 'Send this NZB to SABnzbd after confirming it' : 'Set up SABnzbd first'
                          }
                          aria-label={`Download this NZB · ${candidate.title}`}
                          onClick={() => {
                            setConfirmingRedownload(false)
                            setConfirmingNzb(candidate)
                          }}
                        >
                          <Icon name="download" size={14} />
                          Download this NZB
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0 flex-1 basis-44">
          {routes.mode === 'choose' && !inClient && !complete && (
            <div
              className="mb-2.5 flex flex-wrap items-center gap-1.5"
              role="radiogroup"
              aria-label={`Download method · ${seasonLabel(r)} · ${rel.releaseGroup}`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={chosen === 'torrent'}
                disabled={!torrentUsable}
                title={
                  rel.torrent_available
                    ? 'Download with qBittorrent'
                    : viaProwlarr
                      ? 'Find on the private tracker through Prowlarr and download with qBittorrent'
                      : 'No magnet available (private tracker)'
                }
                onClick={() => actions.pickProtocol('torrent')}
                className={cx(
                  'cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                  chosen === 'torrent'
                    ? 'border-accent bg-accent/14 text-ink'
                    : 'border-line bg-panel text-muted hover:text-ink',
                  !torrentUsable && 'cursor-not-allowed opacity-50',
                )}
              >
                Torrent
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={chosen === 'usenet'}
                disabled={!usenetUsable}
                title={usenet?.detail || 'Usenet availability not checked'}
                onClick={() => actions.pickProtocol('usenet')}
                className={cx(
                  'cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                  chosen === 'usenet'
                    ? 'border-sky bg-sky/14 text-ink'
                    : 'border-line bg-panel text-muted hover:text-ink',
                  !usenetUsable && 'cursor-not-allowed opacity-50',
                )}
              >
                Usenet
              </button>
            </div>
          )}
          {complete || inClient ? (
            <p className="m-0 text-sm font-semibold text-ink wrap-anywhere">
              {complete ? statusCopy : `${phaseLabel(active[0].phase)} in ${clientName(active[0].client)}`}
            </p>
          ) : manualOnly && publicOnly ? (
            <div className="release-manual">
              <p className="m-0 text-sm font-semibold text-ink">Not offered in public-tracker mode</p>
              <p className="mt-1 mb-0 max-w-[60ch] text-xs text-muted wrap-anywhere">
                {owned
                  ? 'You own this private-tracker release, so it is listed here and counts toward your library. '
                  : ''}
                Private-tracker releases are never downloaded or targeted while only public trackers are used.
              </p>
            </div>
          ) : manualOnly ? (
            <div className="release-manual">
              <p className="m-0 text-sm font-semibold text-ink">Manual download only</p>
              <p className="mt-1 mb-0 max-w-[60ch] text-xs text-muted wrap-anywhere">
                {tracker ? `${tracker} is a private tracker` : 'This release is on a private tracker'}, so there is no
                public magnet to send to qBittorrent. Download it from the tracker yourself
                {rel.size > 0 ? ` (${formatBytes(rel.size)})` : ''}.
              </p>
              {usenetEnabled && manualSource && (
                <a
                  className="touch-target mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-accent-bright"
                  href={manualSource.href}
                  target="_blank"
                  rel="noopener"
                >
                  {manualSource.label}
                  <Icon name="chevron-right" size={14} />
                  <span className="sr-only"> (new tab)</span>
                </a>
              )}
            </div>
          ) : chosen === 'torrent' && !torrentUsable ? (
            <p className="m-0 text-sm font-semibold text-ink wrap-anywhere">
              Usenet only — individual download unavailable
            </p>
          ) : (
            <>
              <dl className="release-sizes m-0 flex flex-wrap gap-x-6 gap-y-2 wrap-anywhere">
                <div>
                  <dt className="mb-0.5 text-xs text-muted">Download size</dt>
                  <dd className="m-0 text-sm font-semibold tabular-nums text-ink">{downloadSize}</dd>
                </div>
                {libraryChange && (
                  <div>
                    <dt className="mb-0.5 text-xs text-muted">Library change</dt>
                    <dd className="m-0 text-sm font-semibold tabular-nums text-ink">{libraryChange}</dd>
                  </div>
                )}
              </dl>
              {sendFacts && (
                <p className="release-send-facts mt-1.5 mb-0 text-xs text-muted wrap-anywhere">{sendFacts}</p>
              )}
            </>
          )}
          {chosen === 'usenet' && (
            <p className="mt-1 mb-0 text-xs text-muted">
              Usenet sources cannot be split;{' '}
              {usenetCategory ? `category: ${usenetCategory}` : 'the configured Usenet category will be used'}.
            </p>
          )}
          {chosen === 'torrent' && !inClient && !complete && torrentUsable && !fileScope.exact && (
            <p className="mt-1 mb-0 text-xs text-muted">
              {fileScope.selected
                ? `Selected-file size is unavailable.${rel.size > 0 ? ` The full release is ${formatBytes(rel.size)}.` : ''}`
                : fileScope.approximateBytes !== null
                  ? 'Approximate release estimate; file metadata is unavailable.'
                  : 'Download size is unavailable.'}
            </p>
          )}
        </div>
        {manualOnly && !usenetEnabled
          ? // Public-tracker mode never points to a private tracker.
            !publicOnly &&
            manualSource && (
              <a
                className={cx(
                  buttonBase,
                  'release-manual-link min-h-11 min-w-0 max-w-full justify-center border-line-strong bg-panel px-3 text-xs text-ink hover:bg-panel-raised hover:no-underline max-[600px]:w-full',
                )}
                href={manualSource.href}
                target="_blank"
                rel="noopener"
              >
                {manualSource.label}
                <Icon name="chevron-right" size={15} />
                <span className="sr-only"> (new tab)</span>
              </a>
            )
          : !inClient && (
              <button
                ref={downloadRef}
                type="button"
                className={cx(
                  buttonBase,
                  'release-download-button min-h-11 min-w-0 max-w-full justify-center px-3 text-xs max-[600px]:w-full',
                  buttonTone,
                )}
                disabled={disabled || sendLocked || lowSpace !== null || confirmingRedownload || confirmingNzb !== null}
                aria-busy={sending}
                title={buttonTitle}
                // The accessible name starts with the visible label so voice control can target it.
                aria-label={`${buttonLabel} · ${r.title} · ${seasonLabel(r)} · ${rel.releaseGroup}`}
                aria-description={buttonTitle}
                data-recommended={recommended || undefined}
                onClick={owned ? () => setConfirmingRedownload(true) : holdFocus(actions.send)}
              >
                {sending ? (
                  <span
                    className="size-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current"
                    aria-hidden="true"
                  />
                ) : complete ? (
                  <Icon name="check" size={17} />
                ) : (
                  <Icon name="download" size={17} />
                )}
                <span className="min-w-0 wrap-anywhere">
                  {sending ? `Sending to ${chosen === 'usenet' ? 'SABnzbd' : 'qBittorrent'}…` : buttonLabel}
                </span>
              </button>
            )}
      </div>
      {lowSpace && (
        <div className="release-alert release-alert-warn mt-3" role="alert">
          <p className="m-0 flex items-start gap-1.5 text-sm font-semibold text-warn">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
            <span>
              {lowSpace.reason === 'low' ? 'Not enough free space for this release' : 'Free space could not be checked'}
            </span>
          </p>
          <ul className="mt-2 mb-0 list-none divide-y divide-line p-0">
            {lowSpaceChecks.map((check, index) => (
              <DiskLine key={`${check.client}-${index}`} check={check} />
            ))}
          </ul>
          <p className="mt-2 mb-0 text-xs text-muted">
            {lowSpace.reason === 'low'
              ? 'The download stalls when the disk fills up and resumes once space is freed.'
              : `${silentClients.join(' and ') || 'The download client'} did not report free space, so the fit cannot be confirmed. The download stalls if the disk fills up.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-warn/45 bg-warn/12 px-3 text-xs text-warn enabled:hover:bg-warn/20',
              )}
              onClick={holdFocus(actions.sendAnyway)}
              disabled={sendLocked}
            >
              <Icon name="download" size={15} />
              Send anyway
            </button>
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-line bg-panel px-3 text-xs text-ink enabled:hover:bg-panel-raised',
              )}
              ref={lowSpaceRef}
              onClick={holdFocus(actions.cancelLowSpace)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {confirmingNzb && (
        <div className="release-alert release-alert-warn mt-3" role="alert">
          <p className="m-0 flex items-start gap-1.5 text-sm font-semibold text-warn">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
            <span>This NZB was not proven to be this release</span>
          </p>
          <p className="mt-1 mb-0 text-xs text-ink wrap-anywhere">
            {candidateConfirmText(confirmingNzb, rel.releaseGroup)} Download it only if you checked it on{' '}
            {confirmingNzb.indexer || 'the indexer'}. SABnzbd downloads the whole post
            {usenetCategory ? ` to the category ${usenetCategory}` : ''}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={nzbConfirmRef}
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-warn/45 bg-warn/12 px-3 text-xs text-warn enabled:hover:bg-warn/20',
              )}
              disabled={sendLocked || inClient || complete}
              onClick={holdFocus(() => {
                const entry = confirmingNzb.entry_id
                setConfirmingNzb(null)
                actions.sendNzb(entry)
              })}
            >
              <Icon name="download" size={15} />
              Download anyway
            </button>
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-transparent bg-transparent px-3 text-xs text-muted enabled:hover:text-ink',
              )}
              onClick={holdFocus(() => setConfirmingNzb(null))}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {confirmingRedownload && (
        <div className="release-alert release-alert-neutral mt-3" role="alert">
          <p className="m-0 flex items-start gap-1.5 text-sm font-semibold text-ink">
            <Icon name="info" size={15} className="mt-0.5 shrink-0" />
            <span>You already have this release</span>
          </p>
          <p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">
            Sending it again downloads{' '}
            {chosen === 'usenet' ? 'the whole Usenet source' : scopeLabel.replace(/^./, first => first.toLowerCase())}{' '}
            to {destination} alongside the files you have.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-line-strong bg-panel px-3 text-xs text-ink enabled:hover:bg-panel-raised',
              )}
              disabled={sendLocked || disabled}
              onClick={holdFocus(() => {
                setConfirmingRedownload(false)
                actions.send()
              })}
            >
              <Icon name="download" size={15} />
              Re-download anyway
            </button>
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-transparent bg-transparent px-3 text-xs text-muted enabled:hover:text-ink',
              )}
              onClick={holdFocus(() => setConfirmingRedownload(false))}
            >
              Keep current files
            </button>
          </div>
        </div>
      )}
      {sendError && !lowSpace && (
        <div className="release-alert release-alert-bad mt-3" role="alert">
          <p className="m-0 flex items-start gap-1.5 text-sm font-semibold text-bad">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
            <span>Could not send this release</span>
          </p>
          <p className="mt-1 mb-0 text-xs text-ink wrap-anywhere">{sendError}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-line-strong bg-panel px-3 text-xs text-ink enabled:hover:bg-panel-raised',
              )}
              ref={retryRef}
              onClick={holdFocus(actions.send)}
              disabled={sendLocked || disabled}
            >
              <Icon name="refresh" size={15} />
              Try again
            </button>
            <button
              type="button"
              className={cx(
                buttonBase,
                'min-h-11 border-transparent bg-transparent px-3 text-xs text-muted enabled:hover:text-ink',
              )}
              onClick={holdFocus(actions.dismissError)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {fileScope.files.length > 0 && !inClient && !complete && chosen !== 'usenet' && !manualOnly && (
        <details className="mt-3 min-w-0">
          <summary className="touch-target flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-semibold text-accent-bright [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" size={14} className="disclosure-chevron" />
            {fileScope.selected ? 'View' : 'Inspect'} {fileScope.files.length}{' '}
            {fileScope.selected ? 'selected' : 'release'} file{fileScope.files.length === 1 ? '' : 's'}
          </summary>
          <ul
            className="app-scrollbar mt-2 mb-0 max-h-52 list-none overflow-y-auto rounded-lg bg-canvas/50 px-3 py-2"
            aria-label={`${rel.releaseGroup} ${fileScope.selected ? 'selected' : 'release'} files`}
          >
            {fileScope.files.map(file => (
              <li key={file.name} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5 text-xs">
                <span className="min-w-0 flex-1 basis-40 text-muted wrap-anywhere">{file.name}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {file.size === null ? 'Size unavailable' : formatBytes(file.size) || '0 B'}
                </span>
              </li>
            ))}
          </ul>
          {/* The release as SeaDex lists it, kept here because only the selected files download. */}
          {fileScope.selected && rel.size > 0 && (!fileScope.exact || fileScope.bytes !== rel.size) && (
            <p className="mt-2 mb-0 text-xs text-muted">
              Full release · <span className="tabular-nums">{formatBytes(rel.size)}</span>. Only the selected files
              download.
            </p>
          )}
        </details>
      )}
      {transfers.length > 1 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
            <span className="font-semibold text-ink">{overall.phaseSummary}</span>
            {overall.total > 0 && (
              <span className="text-muted">
                {overall.percent.toFixed(1)}% · {formatBytes(overall.downloaded) || '0 B'} /{' '}
                {overall.unknown > 0 ? '~' : ''}
                {formatBytes(overall.total)}
              </span>
            )}
          </div>
          {overall.anyBar && (
            <div
              role="progressbar"
              aria-label={`Overall download progress · ${seasonLabel(r)} · ${rel.releaseGroup}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overall.percent}
              aria-valuetext={`${overall.phaseSummary} · ${overall.percent.toFixed(1)}%`}
              className="h-1.5 overflow-hidden rounded-full bg-panel-raised"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.max(overall.percent, 2)}%` }}
              />
            </div>
          )}
          {(overall.speed > 0 || overall.unknown > 0) && (
            <p className="mt-2 mb-0 text-xs text-muted wrap-anywhere">
              {[
                overall.speed > 0 ? `${formatBytes(overall.speed)}/s` : '',
                overall.speed > 0 ? formatEta(Math.max(0, overall.total - overall.downloaded), overall.speed) : '',
                overall.unknown > 0
                  ? `size not known yet for ${overall.unknown} torrent${overall.unknown === 1 ? '' : 's'}`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <details className="mt-2 min-w-0" open={overall.attention > 0 || undefined}>
            <summary className="touch-target flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-semibold text-accent-bright [&::-webkit-details-marker]:hidden">
              <Icon name="chevron-right" size={14} className="disclosure-chevron" />
              {transfers.length} torrents
              {overall.attention > 0 && (
                <span className="font-normal text-warn">· {overall.attention} need attention</span>
              )}
            </summary>
            {transfers.map(transfer => renderTransfer(transfer, true))}
          </details>
        </div>
      )}
      {transfers.length === 1 && renderTransfer(transfers[0], false)}
      <span className="sr-only" role="status" aria-atomic="true">
        {statusCopy && `${rel.releaseGroup} · ${statusCopy}`}
      </span>
    </article>
  )

  function renderTransfer(transfer: DownloadEntry, nested: boolean) {
    const percent = Math.max(0, Math.min(100, Math.round(transfer.progress * 1000) / 10))
    const showsBar = transfer.phase !== 'complete'
    const client = clientName(transfer.client)
    const name = transferName(transfer)
    return (
      <div key={transfer.record_id} className={cx('border-t border-line', nested ? 'mt-2 pt-2.5' : 'mt-3 pt-3')}>
        {name && (
          <p className="m-0 mb-1.5 text-xs font-semibold text-ink wrap-anywhere" title={name.path}>
            {name.label}
          </p>
        )}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
          <span className={cx('font-semibold', downloadTextTone(transfer.phase))}>
            {transfer.phase === 'complete' ? `Completed in ${client}` : `${phaseLabel(transfer.phase)} in ${client}`}
          </span>
          {transfer.total_size > 0 && (
            <span className="text-muted">
              {percent.toFixed(1)}% · {formatBytes(transfer.downloaded) || '0 B'} / {formatBytes(transfer.total_size)}
            </span>
          )}
        </div>
        {showsBar && (
          <div
            role="progressbar"
            aria-label={`Download progress · ${seasonLabel(r)} · ${rel.releaseGroup}${nested && name ? ` · ${name.label}` : ''}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transfer.phase === 'acceptance_unknown' ? undefined : percent}
            aria-valuetext={`${phaseLabel(transfer.phase)} · ${percent.toFixed(1)}%`}
            className="h-1.5 overflow-hidden rounded-full bg-panel-raised"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{
                width: `${Math.max(percent, transfer.phase === 'queued' || transfer.phase === 'acceptance_unknown' ? 2 : 0)}%`,
              }}
            />
          </div>
        )}
        {transfer.phase === 'error' && (
          <div className="mt-3 rounded-lg bg-bad/5 p-3">
            <p className="m-0 text-sm font-semibold text-bad">{client} reported a download error</p>
            <p className="mt-1 mb-2 text-xs text-ink wrap-anywhere">
              {transfer.error || `Open this download in ${client}, resolve the issue, then retry.`}
            </p>
          </div>
        )}
        {transfer.phase === 'acceptance_unknown' && (
          <p className="mt-2 mb-0 text-xs text-warn">
            {client} was asked to start this download but did not confirm it. It is picked up automatically if it
            appears in {client}. If it is not there, stop tracking it to send it again.
          </p>
        )}
        {transfer.phase === 'missing' && (
          <p className="mt-2 mb-0 text-xs text-bad">
            This download is no longer in {client}. Remove the entry and send it again if you still want it.
          </p>
        )}
        {transfer.unbound && (
          <p className="mt-2 mb-0 text-xs text-warn">
            This download belongs to a different client URL and cannot be controlled from here.
          </p>
        )}
        {transfer.import && transfer.import.state !== 'waiting' && (
          <div className="mt-2">
            <ImportStatusLine entry={transfer} />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted wrap-anywhere">
            {transfer.phase === 'downloading'
              ? [
                  transfer.speed > 0 && transfer.client === 'qbittorrent' ? `${formatBytes(transfer.speed)}/s` : '',
                  transfer.client === 'qbittorrent'
                    ? formatEta(Math.max(0, transfer.total_size - transfer.downloaded), transfer.speed)
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : transfer.phase === 'post_processing' || transfer.phase === 'unpacking'
                ? `${client} is preparing the files…`
                : ''}
          </span>
          <span className="ml-auto inline-flex gap-2">
            <DownloadActions
              entry={transfer}
              busy={busy}
              onPause={() => actions.pause(transfer)}
              onResume={() => actions.resume(transfer)}
              onRemove={() => actions.remove(transfer)}
              name={nested ? name?.label : undefined}
            />
          </span>
        </div>
      </div>
    )
  }
}
