import { upgradeParts } from '../../../shared/download-plan'
import { ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ResultItem, Release } from '../types'
import { formatBytes, resultGroupKey, seasonLabel } from '../utils'
import { cx } from '../styles'
import Icon from './Icons'
import * as api from '../api'
import Modal from './Modal'
import { bulkDialog } from './bulk-dialog-styles'
import { releaseIdentity } from '../../../shared/releases'
import { jobResult, type SubmissionRow, type DownloadJobStatus, type DownloadMode, type DownloadProtocol, type DownloadPreflight } from '../api'
import { DiskLine, spaceAckDetail } from './PlanReview'
import { availabilityKey, observeUsenetAvailability, type AvailabilitySnapshot } from '../usenet-observation'
import { displayDateTime } from '../datetime'

interface IndexedRelease {
  index: number
  release: Release
}

interface ReviewGroup {
  id: string
  result: ResultItem
  part: string
  options: IndexedRelease[]
}

interface Review {
  ready: ReviewGroup[]
  choices: ReviewGroup[]
  blocked: ReviewGroup[]
}

function buildReview(results: ResultItem[], usenetEligible: (result: ResultItem, option: IndexedRelease) => boolean, torrentEnabled = true): Review {
  const ready: ReviewGroup[] = []
  const blocked: ReviewGroup[] = []

  for (const result of results) for (const part of upgradeParts(result)) {
    const group = { id: `${result.key}::${part.part || 'all'}`, result, part: part.part, options: part.options }
    if (torrentEnabled && part.torrent_available || group.options.some(option => usenetEligible(result, option))) ready.push(group)
    else blocked.push(group)
  }

  return { ready, choices: ready.filter((group) => group.options.length > 1), blocked }
}

type ViewId = 'ready' | 'unavailable'

interface Props {
  open: boolean
  results: ResultItem[]
  scopeControl: ReactNode
  hiddenKeys: Set<string>
  busy: boolean
  /** Live/last bulk submission state while the dialog stays open. */
  job: DownloadJobStatus | null
  downloadMode: DownloadMode
  /** Release preferences are set, so their target is chosen where several releases are offered. */
  preferTarget?: boolean
  sabEnabled: boolean
  onConfirm: (plan_id: string, acknowledge: { whole_source?: boolean; disk_space?: boolean }) => void
  onClose: () => void
}

function hiddenKey(result: ResultItem): string {
  return String(resultGroupKey(result))
}

function ReleaseSummary({ release }: { release: Release }) {
  const tags = [...new Set(release.tags || [])].filter(tag => tag && tag !== release.quality && (!release.dual_audio || tag !== 'Dual Audio'))
  return <span className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1.5 text-xs wrap-anywhere">
    <span className="inline-flex items-baseline gap-1.5"><span className="text-muted">Group</span><strong className="font-semibold text-ink">{release.releaseGroup}</strong></span>
    {release.quality && <span className="inline-flex items-baseline gap-1.5"><span className="text-muted">Quality</span><span className="text-ink/85">{release.quality}</span></span>}
    {release.dual_audio && <span className="inline-flex items-baseline gap-1.5"><span className="text-muted">Audio</span><span className="text-ink/85">Dual Audio</span></span>}
    {tags.length > 0 && <span className="inline-flex min-w-0 items-baseline gap-1.5"><span className="shrink-0 text-muted">Tags</span><span className="text-ink/85">{tags.join(', ')}</span></span>}
  </span>
}

function OutcomeLabel({ status, protocols }: { status: 'success' | 'failure' | 'pending' | 'existing' | 'partial' | null; protocols: DownloadProtocol[] }) {
  if (!status) return null
  const clients = [...new Set(protocols.map(protocol => protocol === 'usenet' ? 'SABnzbd' : 'qBittorrent'))].join(' and ') || 'the download client'
  const copy = status === 'success' ? `Sent to ${clients}`
    : status === 'existing' ? 'Already queued in the client'
    : status === 'partial' ? `Partly sent — see Operation Center`
    : status === 'failure' ? 'Could not be added — review the operation error details'
    : `Waiting for ${clients}`
  const tone = status === 'success' ? 'text-good' : status === 'existing' ? 'text-muted' : status === 'failure' ? 'text-bad' : status === 'partial' ? 'text-warn' : 'text-accent-bright'
  return <span className={cx('basis-full text-xs font-semibold', tone)}>{copy}</span>
}

function UsenetStatus({ row, loading }: { row: api.UsenetAvailabilityResult | undefined; loading: boolean }) {
  if (!row) return <span className="basis-full text-xs text-muted">{loading ? 'Checking Usenet sources…' : 'Usenet: not checked'}</span>
  const labels = { available: 'Usenet source found', no_match: 'No Usenet match', processing: 'Usenet source processing', incomplete: 'Usenet source uncertain', unsupported_hash: 'Usenet unavailable', not_configured: 'Usenet not set up', lookup_failed: 'Usenet lookup failed', not_checked: row.refreshing ? 'Checking Usenet sources…' : 'Usenet: not checked' }
  const tone = row.aggregate === 'available' ? 'text-good' : row.aggregate === 'lookup_failed' ? 'text-warn' : 'text-ink/85'
  return <span className="basis-full block min-w-0 border-t border-line/70 pt-2.5 text-xs wrap-anywhere">
    <span className="flex flex-wrap items-start gap-x-6 gap-y-2">
      <span className="flex min-w-0 flex-col gap-0.5"><span className="text-muted">Availability</span><span className={cx('font-semibold', tone)}>{labels[row.aggregate]}</span></span>
      {row.checked_at && <>
        <span className="flex min-w-0 flex-col gap-0.5"><span className="text-muted">Cache</span><span className="text-ink/85">{row.stale ? 'Last-known cached result' : 'Cached result'}</span></span>
        <span className="flex min-w-0 flex-col gap-0.5"><span className="text-muted">Last checked</span><time className="tabular-nums text-ink/85" dateTime={row.checked_at}>{displayDateTime(row.checked_at)}</time></span>
      </>}
      {row.aggregate !== 'not_checked' && (row.refreshing || loading) && <span className="inline-flex items-center gap-1.5 self-end text-muted"><Icon name="refresh" size={12}/>Refreshing…</span>}
    </span>
    {row.refresh_error && <span className="mt-2.5 flex items-start gap-2 text-warn"><span className="mt-0.5 shrink-0"><Icon name="alert" size={14}/></span><span className="min-w-0"><strong className="block font-semibold">Refresh failed</strong><span className="mt-0.5 block max-w-prose leading-relaxed">{row.refresh_error}</span></span></span>}
  </span>
}

export default function BulkDownloadDialog({ open, results, scopeControl, hiddenKeys, busy, job, downloadMode, preferTarget = false, sabEnabled, onConfirm, onClose }: Props) {
  // The review keeps its selected snapshot; the server validates identities against current results.
  const usenetEnabled = downloadMode !== 'torrent_only' && sabEnabled
  const reviewCandidates = useMemo(() => buildReview(results, (_result, { release }) => usenetEnabled && (release.info_hashes?.length || 0) > 0, downloadMode !== 'usenet_only'), [results, usenetEnabled, downloadMode])
  const usenetSelections = useMemo(() => usenetEnabled ? [...new Map(reviewCandidates.ready.flatMap(group => group.options
    .filter(({ release }) => (release.info_hashes?.length || 0) > 0)
    .map(option => ({ key: group.result.key, release: option.index, identity: releaseIdentity(option.release) }))).map(selection => [`${selection.key}\u0000${selection.release}`, selection])).values()] : [], [reviewCandidates, usenetEnabled])
  const availabilityRevision = useSyncExternalStore(api.subscribeUsenetAvailability, api.getUsenetAvailabilityRevision)
  const usenetSignature = JSON.stringify([availabilityRevision, usenetSelections])
  const [usenetAvailability, setUsenetAvailability] = useState<(AvailabilitySnapshot & { signature: string }) | null>(null)
  const currentAvailability = usenetAvailability?.signature === usenetSignature ? usenetAvailability : null
  const availabilityRef = useRef(currentAvailability)
  availabilityRef.current = currentAvailability
  const currentSignature = useRef(usenetSignature)
  currentSignature.current = usenetSignature
  const usenetChecking = usenetEnabled && usenetSelections.length > 0 && (!currentAvailability || currentAvailability.loading || Object.values(currentAvailability.rows).some(row => row.refreshing))
  const usenetEligible = useMemo(() => (result: ResultItem, option: IndexedRelease) => usenetEnabled && currentAvailability?.sabnzbdConfigured === true && currentAvailability.rows[availabilityKey({ key: result.key, release: option.index, identity: releaseIdentity(option.release) })]?.aggregate === 'available', [usenetEnabled, currentAvailability])
  const review = useMemo(() => buildReview(results, usenetEligible, downloadMode !== 'usenet_only'), [results, usenetEligible, downloadMode])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [protocols, setProtocols] = useState<Record<string, DownloadProtocol>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<ViewId>('ready')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [preflight, setPreflight] = useState<{ signature: string; result: DownloadPreflight } | null>(null)
  const [preflightError, setPreflightError] = useState<{ signature: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const forceAvailability = useRef(false)
  const forcePreflight = useRef(false)
  const [wholeSource, setWholeSource] = useState(false)
  const [diskSpace, setDiskSpace] = useState(false)
  const enabledGroups = useMemo(() => review.ready.filter(group => enabled[group.id] !== false), [review, enabled])
  const selectedGroups = useMemo(() => enabledGroups.filter(group => selected[group.id] !== undefined), [enabledGroups, selected])
  const selectedOptions = useMemo(() => selectedGroups.map(group => group.options.find(option => option.index === selected[group.id]) || group.options[0]), [selectedGroups, selected])
  const protocolFor = (group: ReviewGroup, option: IndexedRelease): DownloadProtocol => {
    if (downloadMode === 'usenet_only') return 'usenet'
    const chosen = protocols[group.id]
    if (chosen) return chosen
    if (!option.release.torrent_available && usenetEligible(group.result, option)) return 'usenet'
    return 'torrent'
  }
  const unavailableChoices = reviewCandidates.ready.filter(group => {
    if (enabled[group.id] === false || selected[group.id] === undefined || protocols[group.id] !== 'usenet') return false
    const option = group.options.find(option => option.index === selected[group.id]) || group.options[0]
    return !usenetEligible(group.result, option)
  })
  const selections = useMemo(() => selectedGroups.map((group, index) => {
    const option = selectedOptions[index]
    return { key: group.result.key, release: option.index, identity: releaseIdentity(option.release), protocol: protocolFor(group, option) }
  }), [selectedGroups, selectedOptions, protocols, downloadMode, usenetEligible])
  const signature = JSON.stringify([availabilityRevision, selections])

  useEffect(() => {
    if (!open) { forceAvailability.current = false; return }
    if (!usenetEnabled || !usenetSelections.length || job) return
    const controller = new AbortController()
    const refresh = forceAvailability.current
    forceAvailability.current = false
    void observeUsenetAvailability(usenetSelections, { refresh, signal: controller.signal, initial: availabilityRef.current, onSnapshot: snapshot => {
      if (!controller.signal.aborted && currentSignature.current === usenetSignature) setUsenetAvailability({ ...snapshot, signature: usenetSignature })
    } })
    return () => controller.abort()
  }, [open, usenetSignature, usenetEnabled, retry, job])

  useEffect(() => {
    if (!open) { forcePreflight.current = false; return }
    if (busy || job?.id && job.finished) return
    const controller = new AbortController()
    setPreflight(null)
    setPreflightError(null)
    setWholeSource(false)
    setDiskSpace(false)
    const timer = window.setTimeout(() => {
      const refresh = forcePreflight.current
      forcePreflight.current = false
      void api.preflightDownload(JSON.parse(signature)[1], refresh, controller.signal)
        .then(result => { if (!controller.signal.aborted) setPreflight({ signature, result }) })
        .catch(error => { if (!controller.signal.aborted) setPreflightError({ signature, message: error instanceof Error ? error.message : 'Could not check downloads' }) })
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [open, signature, retry, busy, job, availabilityRevision])

  useEffect(() => {
    if (!open || busy || job) return
    // Only single-option groups get an automatic pick. Multi-option groups stay
    // pending (collapsed + highlighted) until the user actively chooses one,
    // unless saved release preferences already name their target.
    const preferred = (group: ReviewGroup) => group.options.length === 1 ? group.options[0] : preferTarget ? group.options.find(option => option.release.target) : undefined
    setSelected(Object.fromEntries(reviewCandidates.ready.flatMap((group) => { const option = preferred(group); return option ? [[group.id, option.index]] : [] })))
    setEnabled(Object.fromEntries(reviewCandidates.ready.map((group) => [group.id, !hiddenKeys.has(hiddenKey(group.result))])))
    setProtocols({})
    setExpanded({})
    setView(reviewCandidates.ready.length || !reviewCandidates.blocked.length ? 'ready' : 'unavailable')
    cancelRef.current?.focus()
  }, [open, reviewCandidates, preferTarget])

  if (!open) return null
  const locked = busy || Boolean(job)
  const finished = Boolean(job?.finished)

  const currentPreflight = preflight?.signature === signature ? preflight.result : null
  const checkError = preflightError?.signature === signature ? preflightError.message : null
  const checking = !currentPreflight && !checkError && !job
  const lowSpace = currentPreflight?.disk_space.some(check => check.sufficient === false)
  const unverifiedSpace = Boolean(checkError || currentPreflight?.requires_space_ack)
  const diskTone = checking ? 'border-accent/35 bg-accent/6' : lowSpace ? 'border-bad/45 bg-bad/6' : unverifiedSpace ? 'border-warn/40 bg-warn/6' : currentPreflight && currentPreflight.new_torrents + currentPreflight.new_nzbs > 0 ? 'border-good/35 bg-good/6' : 'border-line bg-canvas-soft'
  const diskTextTone = checking ? 'text-accent-bright' : lowSpace ? 'text-bad' : unverifiedSpace ? 'text-warn' : currentPreflight && currentPreflight.new_torrents + currentPreflight.new_nzbs > 0 ? 'text-good' : 'text-muted'
  const sizeText = currentPreflight
    ? `${currentPreflight.approximate_bytes ? '≈ ' : ''}${formatBytes(currentPreflight.total_new_bytes) || '0 B'}${currentPreflight.unknown_bytes ? ' + unknown' : ''}`
    : ''
  const pendingChoices = review.choices.filter((group) => enabled[group.id] !== false && selected[group.id] === undefined).length
  const blockedSorted = [...review.blocked].sort((a, b) =>
    a.result.title.localeCompare(b.result.title, undefined, { sensitivity: 'base' }) ||
    (a.result.season || 0) - (b.result.season || 0) ||
    a.part.localeCompare(b.part),
  )
  const readySorted = [...review.ready].sort((a, b) =>
    a.result.title.localeCompare(b.result.title, undefined, { sensitivity: 'base' }) ||
    (a.result.season || 0) - (b.result.season || 0) ||
    a.part.localeCompare(b.part),
  )
  const serverBlocked = currentPreflight?.blocked || []
  const serverBlockedIds = new Set(serverBlocked.map(row => `${row.key}\u0000${row.release}`))

  // Per-row live outcome while the batch is in flight (and after it finishes).
  const result = job ? jobResult(job) : null
  const groupStatus = (group: ReviewGroup): 'success' | 'failure' | 'pending' | 'existing' | 'partial' | null => {
    if (!result || enabled[group.id] === false || selected[group.id] === undefined) return null
    const index = selected[group.id] ?? group.options[0].index
    const row = result.rows.find(entry => entry.key === group.result.key && entry.release === index)
    if (!row) return null
    return row.status === 'added' ? 'success' : row.status === 'existing' ? 'existing' : row.status === 'partial' ? 'partial' : row.status === 'failed' ? 'failure' : 'pending'
  }
  const rowProtocols = (group: ReviewGroup): DownloadProtocol[] => {
    const index = selected[group.id] ?? group.options[0].index
    return result?.rows.find((entry: SubmissionRow) => entry.key === group.result.key && entry.release === index)?.protocols || []
  }
  const inflightProgress = job && !job.finished
    ? { settled: job.added.length + job.existing.length + job.failures.length, total: job.added.length + job.existing.length + job.failures.length + job.pending.length }
    : null
  const needsWhole = currentPreflight?.requires_whole_ack === true
  const needsSpace = currentPreflight?.requires_space_ack === true
  const newUnits = (currentPreflight?.new_torrents || 0) + (currentPreflight?.new_nzbs || 0)

  return (
    <Modal open={open} labelledBy="bulk-download-title" onClose={onClose}>
      <section className={cx(bulkDialog.shell, 'max-w-3xl')} aria-busy={busy}>
        <header className={bulkDialog.header}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-good/12 text-good"><Icon name="download" size={19}/></span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-download-title" className="m-0 text-lg font-extrabold">Review bulk downloads</h2>
          </div>
          <button type="button" className={bulkDialog.closeButton} onClick={onClose} aria-label={busy ? 'Continue batch in background' : 'Close'}><Icon name="close" size={18}/></button>
          <p className="m-0 basis-full text-sm text-muted">{job && !job.finished ? 'Sending your fixed selection to the download clients. Closing this review keeps the batch running in the background.' : finished ? 'Review the submitted selection and each outcome below. Operation Center shows the batch results and any error details.' : 'Choose a release and download method for each season or cour you want to upgrade.'}</p>
        </header>

        <div className={bulkDialog.body}>
          {scopeControl}
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <button type="button" className={cx('touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors', view === 'ready' ? 'border-good/60 bg-good/25 text-ink' : 'border-good/30 bg-good/10 text-ink hover:bg-good/18')} onClick={() => setView('ready')} aria-pressed={view === 'ready'}>{review.ready.length} eligible</button>
            {(review.blocked.length > 0 || serverBlocked.length > 0) && <button type="button" className={cx('touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors', view === 'unavailable' ? 'border-warn/60 bg-warn/25 text-ink' : 'border-warn/30 bg-warn/10 text-ink hover:bg-warn/18')} onClick={() => setView('unavailable')} aria-pressed={view === 'unavailable'}>{Math.max(review.blocked.length, serverBlocked.length)} unavailable</button>}
            {review.ready.length > 0 && <div className="ml-auto flex gap-2"><button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-accent/50 bg-accent/15 px-3 py-1.5 font-extrabold text-accent-bright transition-colors hover:bg-accent/25" disabled={locked} onClick={() => setEnabled(Object.fromEntries(review.ready.map((group) => [group.id, true])))}>Check all</button><button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-line-strong bg-panel px-3 py-1.5 text-ink transition-colors hover:border-ink/25 hover:bg-canvas-soft" disabled={locked} onClick={() => setEnabled(Object.fromEntries(review.ready.map((group) => [group.id, false])))}>Uncheck all</button></div>}
            {downloadMode === 'choose' && <div className="flex gap-2">
              <button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-accent/50 bg-accent/12 px-3 py-1.5 font-extrabold text-accent-bright transition-colors hover:bg-accent/20" disabled={locked || !review.ready.length} title="Use qBittorrent for every eligible group" onClick={() => setProtocols(Object.fromEntries(review.ready.map((group) => [group.id, 'torrent' as DownloadProtocol])))}>All torrents</button>
              <button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-sky/50 bg-sky/12 px-3 py-1.5 font-extrabold text-sky transition-colors hover:bg-sky/20" disabled={locked || !review.ready.some(group => group.options.some(option => usenetEligible(group.result, option)))} title="Use SABnzbd wherever the release is available on Usenet" onClick={() => setProtocols(Object.fromEntries(review.ready.map((group) => {
                const option = group.options.find(({ index }) => index === selected[group.id]) || group.options[0]
                return [group.id, usenetEligible(group.result, option) ? 'usenet' : 'torrent'] as const
              })))}>All Usenet where available</button>
            </div>}
          </div>
          {usenetChecking && <p className="m-0 text-xs text-muted" role="status">Refreshing Usenet availability. Known cached sources remain available; unchecked sources are still checking.</p>}
          {currentAvailability?.error && <p className="m-0 text-xs text-warn wrap-anywhere" role="status">Usenet refresh failed: {currentAvailability.error}. Last-known availability remains visible. Refresh the review to try again.</p>}
          {!finished && <button type="button" className="touch-target self-start cursor-pointer rounded-lg px-2 py-1 text-xs font-bold text-accent-bright hover:bg-accent/10 disabled:opacity-50" disabled={locked} onClick={() => { setWholeSource(false); setDiskSpace(false); setPreflight(null); setPreflightError(null); forceAvailability.current = true; forcePreflight.current = true; setRetry(current => current + 1) }}>Refresh review</button>}

          {view === 'ready' && (
            <section>
              {readySorted.length ? (
                <div className="space-y-1.5">
                  {readySorted.map((group) => {
                    const isHidden = hiddenKeys.has(hiddenKey(group.result))
                    const isChoice = group.options.length > 1
                    const status = groupStatus(group)
                    const statusClass = status === 'success' ? 'border-good/50 bg-good/8' : status === 'failure' ? 'border-bad/50 bg-bad/8' : status === 'pending' ? 'border-accent/45 bg-accent/8' : status === 'partial' ? 'border-warn/50 bg-warn/8' : ''
                    const statusIcon = status === 'success' ? <Icon name="check" size={13} className="text-good"/> : status === 'failure' ? <Icon name="alert" size={13} className="text-bad"/> : status === 'pending' ? <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : status === 'partial' ? <Icon name="alert" size={13} className="text-warn"/> : null
                    const statusText = status === 'success' ? 'text-good' : status === 'failure' ? 'text-bad' : status === 'pending' ? 'text-accent-bright' : status === 'partial' ? 'text-warn' : 'text-ink'
                    const protocolButtons = (option: IndexedRelease) => downloadMode === 'choose' ? <span className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label={`Download method for ${group.result.title}`}>
                      <button type="button" role="radio" aria-checked={protocolFor(group, option) === 'torrent'} disabled={locked || !option.release.torrent_available} title={option.release.torrent_available ? 'Send to qBittorrent' : 'No magnet available (private tracker)'} onClick={() => setProtocols(current => ({ ...current, [group.id]: 'torrent' }))} className={cx('cursor-pointer rounded-md border px-2 py-1 text-[0.6875rem] font-bold', protocolFor(group, option) === 'torrent' ? 'border-accent bg-accent/15 text-accent-bright' : 'border-line text-muted hover:text-ink', (!option.release.torrent_available || locked) && 'cursor-not-allowed opacity-50')}>Torrent</button>
                      {(usenetEligible(group.result, option) || protocolFor(group, option) === 'usenet') && <button type="button" role="radio" aria-checked={protocolFor(group, option) === 'usenet'} disabled={locked || !usenetEligible(group.result, option)} title={usenetEligible(group.result, option) ? 'Send to SABnzbd (whole Usenet source)' : 'The selected Usenet source is unavailable. Choose Torrent or exclude this release.'} onClick={() => setProtocols(current => ({ ...current, [group.id]: 'usenet' }))} className={cx('cursor-pointer rounded-md border px-2 py-1 text-[0.6875rem] font-bold', protocolFor(group, option) === 'usenet' ? 'border-sky bg-sky/15 text-sky' : 'border-line text-muted hover:text-ink', (locked || !usenetEligible(group.result, option)) && 'cursor-not-allowed opacity-50')}>Usenet</button>}
                    </span> : null
                    if (!isChoice) {
                      const option = group.options.find(({ index }) => index === (selected[group.id] ?? group.options[0].index)) || group.options[0]
                      const release = option.release
                      const localSize = group.part ? (group.result.local_size_by_part?.[group.part] || 0) : group.result.local_size
                      const delta = release.size && localSize ? release.size - localSize : null
                      const isServerBlocked = serverBlockedIds.has(`${group.result.key}\u0000${option.index}`)
                      return (
                        <label key={group.id} className={cx(bulkDialog.row, locked ? 'cursor-default' : 'cursor-pointer', statusClass, !status && (isServerBlocked ? 'border-warn/40 bg-warn/6' : enabled[group.id] !== false ? bulkDialog.rowSelected : bulkDialog.rowUnchecked))}>
                          <input type="checkbox" disabled={locked} className="size-3.5 shrink-0 accent-good" checked={enabled[group.id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [group.id]: event.target.checked }))} />
                          {statusIcon}
                          <span className={cx('font-semibold', statusText)}>{group.result.title}</span>
                          <span className={bulkDialog.seasonBadge}>{seasonLabel(group.result)}{group.part && <> <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span></>}</span>
                          {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                          <span className="ml-auto flex items-center gap-1.5 tabular-nums" title={`${release.releaseGroup} · ${release.tracker}`}>
                            <span className="text-ink/70" title="Current local size">{formatBytes(localSize) || '—'}</span>
                            <span className="text-ink/60">→</span>
                            <span className="font-bold text-ink" title="Selected release size">{formatBytes(release.size) || 'Unknown'}</span>
                            {delta !== null && delta !== 0 && <span className="text-ink/60">({delta > 0 ? '+' : '−'}{formatBytes(Math.abs(delta))})</span>}
                          </span>
                          {protocolButtons(option)}
                          <span className="basis-full"><ReleaseSummary release={release}/></span>
                          {usenetEnabled && <UsenetStatus row={currentAvailability?.rows[availabilityKey({ key: group.result.key, release: option.index, identity: releaseIdentity(release) })]} loading={Boolean(currentAvailability?.loading)}/>}
                          {isServerBlocked && !status && <span className="basis-full text-xs font-semibold text-warn">{serverBlocked.find(row => row.key === group.result.key && row.release === option.index)?.reason}</span>}
                          {!status && unavailableChoices.some(choice => choice.id === group.id) && <span className="basis-full text-xs font-semibold text-warn">Selected Usenet source is unavailable. Choose Torrent or exclude this release.</span>}
                          <OutcomeLabel status={status} protocols={rowProtocols(group)}/>
                        </label>
                      )
                    }

                    const chosenIndex = selected[group.id]
                    const chosen = chosenIndex !== undefined
                    const isPending = enabled[group.id] !== false && !chosen
                    const isExpanded = expanded[group.id] === true
                    const chosenOption = group.options.find(({ index }) => index === chosenIndex) || null
                    const localSize = group.part ? (group.result.local_size_by_part?.[group.part] || 0) : group.result.local_size
                    return (
                      <div key={group.id} className={cx('overflow-hidden rounded-lg border transition-colors', statusClass || (isPending ? 'border-warn/55 bg-warn/8' : enabled[group.id] !== false ? bulkDialog.rowSelected : bulkDialog.rowUnchecked))}>
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <label className="touch-target grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-panel-raised"><input type="checkbox" disabled={locked} className="size-4 accent-good" checked={enabled[group.id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [group.id]: event.target.checked }))} aria-label={`Include ${group.result.title} · ${seasonLabel(group.result)}${group.part ? ` · ${group.part}` : ''}`} /></label>
                          <button type="button" className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs" onClick={() => setExpanded((current) => ({ ...current, [group.id]: !isExpanded }))} aria-expanded={isExpanded}>
                            {statusIcon}
                            <span className={cx('font-semibold', statusText)}>{group.result.title}</span>
                            <span className={bulkDialog.seasonBadge}>{seasonLabel(group.result)}{group.part && <> <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span></>}</span>
                            {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                            {chosen ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-extrabold text-accent-bright"><Icon name="check" size={12}/>Selected</span>
                            ) : (
                              <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-extrabold', enabled[group.id] !== false ? 'border-warn/45 bg-warn/15 text-warn' : 'border-line-strong bg-canvas-soft text-muted')}><Icon name="alert" size={12}/>Choose 1 of {group.options.length}</span>
                            )}
                            {chosenOption && <span className="basis-full"><ReleaseSummary release={chosenOption.release}/></span>}
                            {usenetEnabled && chosenOption && <UsenetStatus row={currentAvailability?.rows[availabilityKey({ key: group.result.key, release: chosenOption.index, identity: releaseIdentity(chosenOption.release) })]} loading={Boolean(currentAvailability?.loading)}/>}
                            <OutcomeLabel status={status} protocols={rowProtocols(group)}/>
                            <span className="ml-auto flex items-center gap-1.5">
                              {chosenOption && (
                                <span className="flex items-center gap-1.5 tabular-nums" title={`${chosenOption.release.releaseGroup} · ${chosenOption.release.tracker}`}>
                                  {localSize ? <><span className="text-ink/70" title="Current local size">{formatBytes(localSize) || '—'}</span><span className="text-ink/60">→</span></> : null}
                                  <span className="font-bold text-ink">{formatBytes(chosenOption.release.size) || 'Unknown'}</span>
                                </span>
                              )}
                              <Icon name="chevron-right" size={15} className={cx('shrink-0 text-muted transition-transform', isExpanded ? 'rotate-90' : '')}/>
                            </span>
                          </button>
                          {chosenOption && protocolButtons(chosenOption)}
                          {unavailableChoices.some(choice => choice.id === group.id) && <span className="basis-full text-xs font-semibold text-warn">Selected Usenet source is unavailable. Choose Torrent or exclude this release.</span>}
                        </div>
                        {isExpanded && (
                          <div className="border-t border-line px-3 py-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              {group.options.map(({ index, release }) => {
                                const checked = chosenIndex === index
                                return (
                                  <label key={index} className={cx('flex items-start gap-2.5 rounded-lg border p-3 transition-colors', locked ? 'cursor-default' : 'cursor-pointer', checked ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:border-line-strong')}>
                                    <input type="radio" disabled={locked} name={group.id} className="mt-0.5 accent-accent" checked={checked} onChange={() => { setSelected(current => ({ ...current, [group.id]: index })); setProtocols(current => { const next = { ...current }; delete next[group.id]; return next }) }} />
                                    <span className="min-w-0 flex-1">
                                      <ReleaseSummary release={release}/>
                                      <span className="mt-1 block text-xs font-bold text-ink">{formatBytes(release.size) || 'Unknown size'}</span>
                                      {usenetEnabled && <UsenetStatus row={currentAvailability?.rows[availabilityKey({ key: group.result.key, release: index, identity: releaseIdentity(release) })]} loading={Boolean(currentAvailability?.loading)}/>}
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                            <div className="mt-2.5 whitespace-pre-line break-words text-xs leading-relaxed text-ink/75"><span className="font-bold text-ink">Note:</span> {group.result.notes_by_part?.[group.part] || (group.result.notes && group.result.notes !== '-' ? group.result.notes : 'No release note provided.')}</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : <p className="m-0 text-xs text-muted">{usenetChecking ? 'Checking whether these upgrades are available on Usenet…' : 'No eligible upgrades in this scope. Change the review scope to check other library titles.'}</p>}
            </section>
          )}

          {view === 'ready' && review.ready.length > 0 && <>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-3 sm:grid-cols-5">
              <div><dt className="text-xs text-muted">Selected releases</dt><dd className="m-0 text-sm font-bold text-accent-bright tabular-nums">{selections.length}</dd></div>
              <div><dt className="text-xs text-muted">New torrents</dt><dd className="m-0 text-sm font-bold tabular-nums">{currentPreflight?.new_torrents ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted">New NZBs</dt><dd className="m-0 text-sm font-bold tabular-nums">{currentPreflight?.new_nzbs ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted">New download size</dt><dd className={cx('m-0 text-sm font-bold tabular-nums', currentPreflight?.unknown_bytes ? 'text-warn' : 'text-accent-bright')} data-testid="bulk-download-size">{checking ? 'Checking…' : currentPreflight ? sizeText : '—'}</dd></div>
              <div className="col-span-2 flex items-baseline gap-2 sm:col-span-1 sm:block"><dt className="text-xs text-muted">Already queued</dt><dd className={cx('m-0 text-sm font-bold tabular-nums', checkError ? 'text-warn' : 'text-ink')}>{checking || checkError ? 'Unknown' : currentPreflight?.existing_units}</dd></div>
            </dl>
            {!finished && <section className={cx('space-y-2 rounded-xl border p-3 text-xs transition-colors', diskTone)} aria-label="Download storage and scope" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 text-xs font-bold">Storage &amp; source scope</h3>
                <span className={cx('inline-flex items-center gap-1.5 font-semibold', diskTextTone)}>
                  {checking ? <span className="size-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name={lowSpace || unverifiedSpace ? 'alert' : 'check'} size={13}/>}
                  {checking ? 'Checking…' : lowSpace ? 'Low space' : unverifiedSpace ? 'Needs acknowledgement' : newUnits > 0 ? 'Space available' : 'Nothing new to send'}
                </span>
              </div>
              {checking && <p className="m-0 text-ink/80">Checking download clients, existing acquisitions, and Usenet sources…</p>}
              {checkError && <p className="m-0 text-warn">Check unavailable: {checkError}. Run the review again before starting the batch.</p>}
              {currentPreflight?.disk_space.length ? <ul className="m-0 list-none divide-y divide-line">{currentPreflight.disk_space.map((check, index) => <DiskLine key={`${check.client}-${index}`} check={check}/>)}</ul> : <p className="m-0 text-muted">No disk-space data available from the configured clients.</p>}
              {currentPreflight && !newUnits && <p className="m-0 text-muted">Nothing new to send. Existing acquisitions are kept unchanged.</p>}
              {currentPreflight?.approximate_bytes && <p className="m-0 text-muted">Usenet sizes are provider estimates; repair and unpacking need extra room.</p>}
              {needsWhole && <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/8 p-3 text-warn"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-warn" checked={wholeSource} onChange={event => setWholeSource(event.target.checked)}/><span className="min-w-0"><span className="block font-bold">Download whole Usenet sources</span><span className="mt-0.5 block text-[0.6875rem] text-muted">Usenet sources cannot be split per episode. Files beyond the selected episodes will also be downloaded.</span></span></label>}
              {needsSpace && <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/8 p-3 text-warn"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-warn" checked={diskSpace} onChange={event => setDiskSpace(event.target.checked)}/><span className="min-w-0"><span className="block font-bold">Continue without confirmed free space</span><span className="mt-0.5 block text-[0.6875rem] text-muted">{spaceAckDetail(currentPreflight)}</span></span></label>}
            </section>}
          </>}
          {view === 'unavailable' && (
            <section>
              <h3 className="mb-3 text-xs font-extrabold tracking-[0.12em] text-warn uppercase">Not downloadable right now</h3>
              <div className="space-y-1.5">
                {blockedSorted.map((group) => {
                  const isHidden = hiddenKeys.has(hiddenKey(group.result))
                  return (
                    <div key={group.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs">
                      {protocols[group.id] === 'usenet' && selected[group.id] !== undefined && <label className="touch-target inline-flex cursor-pointer items-center gap-2"><input type="checkbox" disabled={locked} className="size-4 accent-good" checked={enabled[group.id] !== false} onChange={event => setEnabled(current => ({ ...current, [group.id]: event.target.checked }))} aria-label={`Include unavailable Usenet choice · ${group.result.title}`}/><span>{enabled[group.id] === false ? 'Excluded from batch' : 'Selected Usenet source unavailable. Uncheck to exclude.'}</span></label>}
                      <span className="font-semibold text-ink">{group.result.title}</span>
                      <span className="rounded border border-warn/25 px-1.5 py-0.5 text-xs font-extrabold text-warn">{seasonLabel(group.result)}{group.part && <> <span className="ml-1.5 border-l border-line-strong pl-1.5">{group.part}</span></>}</span>
                      {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                      <span className="ml-auto min-w-0 truncate text-muted" title={group.options.map(({ release }) => release.releaseGroup).join(' · ')}>{group.options.length ? `Private: ${group.options.map(({ release }) => release.releaseGroup).join(' · ')}` : 'No public magnet available'}</span>
                      {usenetEnabled && group.options.map(option => <UsenetStatus key={option.index} row={currentAvailability?.rows[availabilityKey({ key: group.result.key, release: option.index, identity: releaseIdentity(option.release) })]} loading={Boolean(currentAvailability?.loading)}/>)}
                    </div>
                  )
                })}
                {serverBlocked.map((row) => {
                  const item = results.find(entry => entry.key === row.key)
                  if (!item) return null
                  return (
                    <div key={`${row.key}\u0000${row.release}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs">
                      <span className="font-semibold text-ink">{item.title}</span>
                      <span className="rounded border border-warn/25 px-1.5 py-0.5 text-xs font-extrabold text-warn">{seasonLabel(item)}</span>
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
            {!job && pendingChoices > 0 && <span className="inline-flex items-center gap-1 font-bold text-warn"><Icon name="alert" size={13}/>Resolve {pendingChoices} release choice{pendingChoices === 1 ? '' : 's'} first</span>}
            {!job && unavailableChoices.length > 0 && <span className="inline-flex items-center gap-1 font-bold text-warn"><Icon name="alert" size={13}/>Resolve {unavailableChoices.length} unavailable Usenet choice{unavailableChoices.length === 1 ? '' : 's'} or exclude them</span>}
            {!job && serverBlocked.length > 0 && <span className="text-muted">{serverBlocked.length} selected row{serverBlocked.length === 1 ? '' : 's'} will be skipped</span>}
          </span>
          <div className={bulkDialog.footerActions}>
            {inflightProgress ? (
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><span className="text-xs text-muted" role="status">Sending… {inflightProgress.settled}/{inflightProgress.total}</span><button type="button" className={cx('touch-target inline-flex items-center gap-2 rounded-control border border-accent/35 bg-accent/12 px-4 py-2.5 text-sm font-bold text-accent-bright transition-colors')} onClick={onClose}>Continue in background</button></div>
            ) : (
              <>
                <button ref={cancelRef} type="button" className={bulkDialog.neutralButton} onClick={onClose} disabled={busy}>{finished ? 'Close' : 'Cancel'}</button>
                {!finished && <button type="button" className={bulkDialog.downloadButton} onClick={() => currentPreflight && unavailableChoices.length === 0 && onConfirm(currentPreflight.plan_id, { whole_source: wholeSource || undefined, disk_space: diskSpace || undefined })} disabled={busy || checking || !currentPreflight || selections.length === 0 || newUnits === 0 || pendingChoices > 0 || unavailableChoices.length > 0 || (needsWhole && !wholeSource) || (needsSpace && !diskSpace)} title={unavailableChoices.length ? 'Choose another method or exclude unavailable Usenet choices' : !currentPreflight ? 'Waiting for the review to finish' : newUnits === 0 ? 'Nothing new to send' : 'Start the download batch'}>{busy ? <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good"/> : <Icon name="download" size={17}/>}Start {newUnits || ''} download{newUnits === 1 ? '' : 's'}</button>}
              </>
            )}
          </div>
        </footer>
      </section>
    </Modal>
  )
}
