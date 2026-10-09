import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { ResultItem, Release } from '../types'
import { formatBytes, resultGroupKey, seasonLabel } from '../utils'
import { buttonBase, cx } from '../styles'
import Icon from './Icons'
import * as api from '../api'
import type { BulkDownloadTarget } from '../api'
import Modal from './Modal'
import { releaseIdentity } from '../../../shared/releases'
import { estimateDownloads, type DownloadPreflight } from '../../../shared/download-estimate'

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

function buildReview(results: ResultItem[]): Review {
  const ready: ReviewGroup[] = []
  const blocked: ReviewGroup[] = []

  for (const result of results) {
    if (result.status !== 'upgrade' && !(result.status === 'partial' && result.upgrade_available)) continue
    if (result.excluded) continue
    const excludedParts = new Set(result.excluded_parts || [])
    const byPart = new Map<string, IndexedRelease[]>()
    result.releases.forEach((release, index) => {
      if (release.kind !== 'best') return
      const part = release.part || ''
      byPart.set(part, [...(byPart.get(part) || []), { index, release }])
    })
    for (const [part, bestReleases] of byPart) {
      if (excludedParts.has(part)) continue
      // Skip parts the user already owns at best quality, mirroring the card's
      // per-part "owned" check (the green "you already have this release" mark).
      // Without this, a split season that is upgradeable for one cour would also
      // re-offer the cour the user already has at best quality.
      const ownedGroups = (result.precise_part_ownership ? (result.owned_by_part?.[part] || []) : result.have).map((g) => g.toLowerCase())
      const bestGroupNames = new Set(bestReleases.map(({ release }) => release.releaseGroup.toLowerCase()))
      if ([...bestGroupNames].some((name) => ownedGroups.includes(name))) continue

      const downloadable = bestReleases.filter(({ release }) => release.downloadable && release.info_hashes.length > 0)
      const group = { id: `${result.key}::${part || 'all'}`, result, part, options: downloadable.length ? downloadable : bestReleases }
      if (downloadable.length) ready.push(group)
      else blocked.push(group)
    }
  }

  return { ready, choices: ready.filter((group) => group.options.length > 1), blocked }
}

type ViewId = 'ready' | 'unavailable'

export interface BulkOutcome {
  requested: Set<string>
  failed: Set<string>
  /** Hashes whose torrent has not settled yet (metadata still being fetched). */
  pending: Set<string>
  /** True while the bulk add request is still in flight. */
  inflight: boolean
}

interface Props {
  open: boolean
  results: ResultItem[]
  scopeControl: ReactNode
  hiddenKeys: Set<string>
  busy: boolean
  outcome?: BulkOutcome | null
  onConfirm: (selections: BulkDownloadTarget[]) => void
  onClose: () => void
}

function hiddenKey(result: ResultItem): string {
  return String(resultGroupKey(result))
}

function ReleaseSummary({ release }: { release: Release }) {
  const tags = [...new Set([release.quality, ...(release.dual_audio ? ['Dual Audio'] : []), ...(release.tags || [])].filter(Boolean))]
  return <span className="block min-w-0 text-xs text-muted wrap-anywhere"><strong className="font-semibold text-ink">{release.releaseGroup}</strong> · {release.tracker}{tags.length > 0 && ` · ${tags.join(' · ')}`}</span>
}

function OutcomeLabel({ status }: { status: 'success' | 'failure' | 'pending' | null }) {
  return status ? <span className="basis-full text-xs font-semibold">{status === 'success' ? 'Added to qBittorrent' : status === 'failure' ? 'Could not be added — review the operation error details' : 'Waiting for qBittorrent'}</span> : null
}

export default function BulkDownloadDialog({ open, results, scopeControl, hiddenKeys, busy, outcome, onConfirm, onClose }: Props) {
  // Review a fixed snapshot until the dialog closes. The server checks release
  // identities before adding anything if recommendations change meanwhile.
  const review = useMemo(() => buildReview(results), [results])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<ViewId>('ready')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const diskRef = useRef<HTMLElement>(null)
  const [preflight, setPreflight] = useState<{ signature: string; result: DownloadPreflight } | null>(null)
  const [preflightError, setPreflightError] = useState<{ signature: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [acceptSpaceWarning, setAcceptSpaceWarning] = useState(false)
  const enabledGroups = useMemo(() => review.ready.filter(group => enabled[group.id] !== false), [review, enabled])
  const selectedGroups = useMemo(() => enabledGroups.filter(group => selected[group.id] !== undefined), [enabledGroups, selected])
  const selectedOptions = useMemo(() => selectedGroups.map(group => group.options.find(option => option.index === selected[group.id]) || group.options[0]), [selectedGroups, selected])
  const selections = useMemo(() => selectedGroups.map((group, index) => ({ key: group.result.key, release: selectedOptions[index].index, identity: releaseIdentity(selectedOptions[index].release) })), [selectedGroups, selectedOptions])
  const signature = JSON.stringify(selections)

  useEffect(() => {
    if (!open || busy || outcome) return
    const controller = new AbortController()
    setPreflight(null)
    setPreflightError(null)
    setAcceptSpaceWarning(false)
    const timer = window.setTimeout(() => {
      void api.getBulkDownloadPreflight(JSON.parse(signature), AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
        .then(result => { if (!controller.signal.aborted) setPreflight({ signature, result }) })
        .catch(error => { if (!controller.signal.aborted) setPreflightError({ signature, message: error instanceof Error ? error.message : 'Could not check downloads' }) })
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [open, signature, retry, busy, outcome])

  useEffect(() => {
    if (!open || busy || outcome) return
    // Only single-option groups get an automatic pick. Multi-option groups stay
    // pending (collapsed + highlighted) until the user actively chooses one.
    setSelected(Object.fromEntries(review.ready.filter((group) => group.options.length === 1).map((group) => [group.id, group.options[0].index])))
    setEnabled(Object.fromEntries(review.ready.map((group) => [group.id, !hiddenKeys.has(hiddenKey(group.result))])))
    setExpanded({})
    setView(review.ready.length || !review.blocked.length ? 'ready' : 'unavailable')
    cancelRef.current?.focus()
  }, [open, review])


  if (!open) return null
  const locked = busy || Boolean(outcome)

  const currentPreflight = preflight?.signature === signature ? preflight.result : null
  const checkError = preflightError?.signature === signature ? preflightError.message : null
  const checking = !currentPreflight && !checkError && !outcome
  const estimate = currentPreflight || estimateDownloads(selectedOptions.map(option => ({ release: option.release, category: '' })))
  const lowSpace = currentPreflight?.disk_space.some(check => check.sufficient === false)
  const sizeText = estimate.unknown_torrents ? `${formatBytes(estimate.new_bytes) || '0 B'} + unknown` : estimate.new_bytes === 0 ? '0 B' : `${estimate.approximate_torrents ? '≈ ' : ''}${formatBytes(estimate.new_bytes)}`
  const automaticCount = review.ready.filter((group) => group.options.length === 1 && !hiddenKeys.has(hiddenKey(group.result))).length
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

  // Per-title live outcome while the bulk add is in flight (and after it
  // finishes): red when any of the selected release's hashes failed, green
  // when it was sent to qBittorrent, and a "working" state while it is still
  // waiting on metadata.
  const groupStatus = (group: ReviewGroup): 'success' | 'failure' | 'pending' | null => {
    if (!outcome || enabled[group.id] === false || selected[group.id] === undefined) return null
    const index = selected[group.id] ?? group.options[0].index
    const release = group.options.find(({ index: optionIndex }) => optionIndex === index)?.release || group.options[0].release
    const hashes = (release.info_hashes || []).map((hash) => String(hash).toLowerCase())
    if (hashes.some((hash) => outcome.failed.has(hash))) return 'failure'
    if (hashes.some((hash) => outcome.pending.has(hash))) return 'pending'
    if (hashes.length > 0 && hashes.every((hash) => outcome.requested.has(hash))) return 'success'
    return null
  }
  const inflightProgress = outcome?.inflight
    ? { settled: outcome.requested.size + outcome.failed.size, total: outcome.requested.size + outcome.failed.size + (outcome.pending?.size || 0) }
    : null

  return (
    <Modal open={open} labelledBy="bulk-download-title" onClose={onClose}>
      <section className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-raised shadow-[0_24px_70px_rgba(0,0,0,.55)]" aria-busy={busy}>
        <header className="bulk-download-header flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-good/12 text-good"><Icon name="download" size={19}/></span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-download-title" className="m-0 text-lg font-extrabold">Review bulk downloads</h2>
            <p className="mt-1 mb-0 text-sm text-muted">{outcome?.inflight ? 'Sending your fixed selection to qBittorrent. Closing this review keeps the batch running in the background.' : outcome ? 'Review the submitted selection and each outcome below. Operation Center shows the batch results and any error details.' : 'Choose a best release for each season or cour you want to upgrade.'}</p>
          </div>
          <button type="button" className="grid touch-target size-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onClose} aria-label={busy ? 'Continue batch in background' : 'Close'}><Icon name="close" size={18}/></button>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-5 max-[600px]:p-4">
          {scopeControl}
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <button type="button" className={cx('touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors', view === 'ready' ? 'border-good/60 bg-good/25 text-ink' : 'border-good/30 bg-good/10 text-ink hover:bg-good/18')} onClick={() => setView('ready')} aria-pressed={view === 'ready'}>{review.ready.length} eligible</button>
            {review.blocked.length > 0 && <button type="button" className={cx('touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors', view === 'unavailable' ? 'border-warn/60 bg-warn/25 text-ink' : 'border-warn/30 bg-warn/10 text-ink hover:bg-warn/18')} onClick={() => setView('unavailable')} aria-pressed={view === 'unavailable'}>{review.blocked.length} unavailable</button>}
            {review.ready.length > 0 && <div className="ml-auto flex gap-2"><button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-accent/50 bg-accent/15 px-3 py-1.5 font-extrabold text-accent-bright transition-colors hover:bg-accent/25" disabled={locked} onClick={() => setEnabled(Object.fromEntries(review.ready.map((group) => [group.id, true])))}>Check all</button><button type="button" className="touch-target cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 rounded-full border border-line-strong bg-panel px-3 py-1.5 text-ink transition-colors hover:border-ink/25 hover:bg-canvas-soft" disabled={locked} onClick={() => setEnabled(Object.fromEntries(review.ready.map((group) => [group.id, false])))}>Uncheck all</button></div>}
          </div>

          {view === 'ready' && (
            <section>
              <h3 className="mb-2 text-sm font-bold text-ink">Eligible upgrades</h3>
              {!outcome && <p className="mb-3 text-xs text-muted" role="status">{selections.length} ready to send{pendingChoices > 0 && ` · ${pendingChoices} need a release choice`}. Each selection covers a movie, season, or cour.</p>}
              {!outcome && <details className="mb-3 text-xs text-muted"><summary className="touch-target w-fit cursor-pointer font-semibold text-accent-bright">How to choose between best releases</summary><p className="mt-2 mb-0 leading-relaxed">SeaDex marks these releases as best. Options may differ in release group, source, or audio. Compare their tags and notes; file size alone does not explain the recommendation.</p></details>}
              {!outcome && automaticCount > 0 && <p className="m-0 mb-3 text-xs text-muted"><Icon name="check" size={14} className="mr-1.5 inline text-good"/>{automaticCount} selection{automaticCount === 1 ? '' : 's'} with a single public best option selected automatically.</p>}
              {readySorted.length ? (
                <div className="space-y-1.5">
                  {readySorted.map((group) => {
                    const isHidden = hiddenKeys.has(hiddenKey(group.result))
                    const isChoice = group.options.length > 1
                    if (!isChoice) {
                      const option = group.options.find(({ index }) => index === (selected[group.id] ?? group.options[0].index)) || group.options[0]
                      const release = option.release
                      const localSize = group.part ? (group.result.local_size_by_part?.[group.part] || 0) : group.result.local_size
                      const delta = release.size && localSize ? release.size - localSize : null
                      const status = groupStatus(group)
                      return (
                        <label key={group.id} className={cx('flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs transition-colors', locked ? 'cursor-default' : 'cursor-pointer', status === 'success' && 'border-good/50 bg-good/8', status === 'failure' && 'border-bad/50 bg-bad/8', status === 'pending' && 'border-accent/45 bg-accent/8', !status && (enabled[group.id] !== false ? 'border-line bg-panel hover:border-line-strong' : 'border-line/60 bg-canvas-soft text-muted'))}>
                          <input type="checkbox" disabled={locked} className="size-3.5 shrink-0 accent-accent" checked={enabled[group.id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [group.id]: event.target.checked }))} />
                          {status === 'success' && <Icon name="check" size={13} className="text-good"/>}
                          {status === 'failure' && <Icon name="alert" size={13} className="text-bad"/>}
                          {status === 'pending' && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/>}
                          <span className={cx('font-semibold', status === 'success' ? 'text-good' : status === 'failure' ? 'text-bad' : status === 'pending' ? 'text-accent-bright' : 'text-ink')}>{group.result.title}</span>
                          <span className="rounded border border-line-strong bg-canvas-soft px-1.5 py-0.5 text-xs font-extrabold text-ink">{seasonLabel(group.result)}{group.part ? ` · ${group.part}` : ''}</span>
                          {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                          <span className="ml-auto flex items-center gap-1.5 tabular-nums" title={`${release.releaseGroup} · ${release.tracker}`}>
                            <span className="text-muted" title="Current local size">{formatBytes(localSize) || '—'}</span>
                            <span className="text-muted-dim">→</span>
                            <span className="font-bold text-ink" title="Selected best release size">{formatBytes(release.size) || 'Unknown'}</span>
                            {delta !== null && delta !== 0 && <span className="text-muted-dim">({delta > 0 ? '+' : '−'}{formatBytes(Math.abs(delta))})</span>}
                          </span>
                          <span className="basis-full"><ReleaseSummary release={release}/></span>
                          <OutcomeLabel status={status}/>
                        </label>
                      )
                    }

                    const chosenIndex = selected[group.id]
                    const chosen = chosenIndex !== undefined
                    const isPending = enabled[group.id] !== false && !chosen
                    const isExpanded = expanded[group.id] === true
                    const chosenOption = group.options.find(({ index }) => index === chosenIndex) || null
                    const localSize = group.part ? (group.result.local_size_by_part?.[group.part] || 0) : group.result.local_size
                    const status = groupStatus(group)
                    return (
                      <div key={group.id} className={cx('overflow-hidden rounded-lg border transition-colors', status === 'success' ? 'border-good/50 bg-good/8' : status === 'failure' ? 'border-bad/50 bg-bad/8' : status === 'pending' ? 'border-accent/45 bg-accent/8' : isPending ? 'border-warn/55 bg-warn/8' : 'border-line bg-panel')}>
                        <div className="flex items-center gap-2 px-3 py-2">
                          <label className="touch-target grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-panel-raised"><input type="checkbox" disabled={locked} className="size-4 accent-accent" checked={enabled[group.id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [group.id]: event.target.checked }))} aria-label={`Include ${group.result.title} · ${seasonLabel(group.result)}${group.part ? ` · ${group.part}` : ''}`} /></label>
                          <button type="button" className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs" onClick={() => setExpanded((current) => ({ ...current, [group.id]: !isExpanded }))} aria-expanded={isExpanded}>
                            {status === 'success' && <Icon name="check" size={13} className="text-good"/>}
                            {status === 'failure' && <Icon name="alert" size={13} className="text-bad"/>}
                            {status === 'pending' && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/>}
                            <span className={cx('font-semibold', status === 'success' ? 'text-good' : status === 'failure' ? 'text-bad' : status === 'pending' ? 'text-accent-bright' : 'text-ink')}>{group.result.title}</span>
                            <span className="rounded border border-line-strong bg-canvas-soft px-1.5 py-0.5 text-xs font-extrabold text-ink">{seasonLabel(group.result)}{group.part ? ` · ${group.part}` : ''}</span>
                            {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                            {chosen ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-xs font-extrabold text-good"><Icon name="check" size={12}/>Selected</span>
                            ) : (
                              <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-extrabold', enabled[group.id] !== false ? 'border-warn/45 bg-warn/15 text-warn' : 'border-line-strong bg-canvas-soft text-muted')}><Icon name="alert" size={12}/>Choose 1 of {group.options.length}</span>
                            )}
                            {chosenOption && <span className="basis-full"><ReleaseSummary release={chosenOption.release}/></span>}
                            <OutcomeLabel status={status}/>
                            <span className="ml-auto flex items-center gap-1.5">
                              {chosenOption && (
                                <span className="flex items-center gap-1.5 tabular-nums" title={`${chosenOption.release.releaseGroup} · ${chosenOption.release.tracker}`}>
                                  {localSize ? <><span className="text-muted" title="Current local size">{formatBytes(localSize) || '—'}</span><span className="text-muted-dim">→</span></> : null}
                                  <span className="font-bold text-ink">{formatBytes(chosenOption.release.size) || 'Unknown'}</span>
                                </span>
                              )}
                              <Icon name="chevron-right" size={15} className={cx('shrink-0 text-muted transition-transform', isExpanded ? 'rotate-90' : '')}/>
                            </span>
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="border-t border-line px-3 py-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              {group.options.map(({ index, release }) => {
                                const checked = chosenIndex === index
                                return (
                                  <label key={index} className={cx('flex items-start gap-2.5 rounded-lg border p-3 transition-colors', locked ? 'cursor-default' : 'cursor-pointer', checked ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:border-line-strong')}>
                                    <input type="radio" disabled={locked} name={group.id} className="mt-0.5 accent-accent" checked={checked} onChange={() => setSelected((current) => ({ ...current, [group.id]: index }))} />
                                    <span className="min-w-0 flex-1">
                                      <ReleaseSummary release={release}/>
                                      <span className="mt-1 block text-xs font-bold text-ink">{formatBytes(release.size) || 'Unknown size'}</span>
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                            <div className="mt-2.5 whitespace-pre-line break-words text-xs leading-relaxed text-muted"><span className="font-bold text-ink">Note:</span> {group.result.notes_by_part?.[group.part] || (group.result.notes && group.result.notes !== '-' ? group.result.notes : 'No release note provided.')}</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : <p className="m-0 text-xs text-muted">No eligible upgrades in this scope. Change the review scope to check other library titles.</p>}
            </section>
          )}

          {view === 'ready' && review.ready.length > 0 && <>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-3 sm:grid-cols-5">
              <div><dt className="text-xs text-muted">Selected releases</dt><dd className="m-0 text-sm font-bold tabular-nums">{selections.length}</dd></div>
              <div><dt className="text-xs text-muted">New torrents</dt><dd className="m-0 text-sm font-bold tabular-nums">{estimate.new_torrents}</dd></div>
              <div><dt className="text-xs text-muted">New download size</dt><dd className="m-0 text-sm font-bold tabular-nums" data-testid="bulk-download-size">{checking ? 'Checking…' : sizeText}</dd></div>
              <div><dt className="text-xs text-muted">File scope</dt><dd className="m-0 text-sm font-bold tabular-nums">{estimate.selected_file_count > 0 ? `${estimate.selected_file_count} file${estimate.selected_file_count === 1 ? '' : 's'}${estimate.whole_torrents ? ` + ${estimate.whole_torrents} whole` : ''}` : `${estimate.whole_torrents} whole torrent${estimate.whole_torrents === 1 ? '' : 's'}`}</dd></div>
              <div className="col-span-2 flex items-baseline gap-2 sm:col-span-1 sm:block"><dt className="text-xs text-muted">Already in qBittorrent</dt><dd className={cx('m-0 text-sm font-bold tabular-nums', checkError ? 'text-warn' : 'text-ink')}>{checking || checkError ? 'Unknown' : estimate.existing_torrents}</dd></div>
            </dl>
            {!outcome && <section ref={diskRef} className="space-y-2 rounded-xl border border-line bg-canvas-soft p-3 text-xs" aria-label="Download disk space" aria-live="polite">
              <h3 className="m-0 text-xs font-bold">Disk space</h3>
              {checking && <p className="m-0 text-muted">Checking qBittorrent download paths and existing torrents…</p>}
              {checkError && <p className="m-0 text-warn">Check unavailable: {checkError}. Existing torrents and available space could not be verified.</p>}
              {currentPreflight?.disk_space.map((check, index) => <div key={index} className={cx('break-words', check.sufficient === false ? 'text-bad' : check.sufficient === true ? 'text-muted' : 'text-warn')}>
                <span className="font-bold">{check.path || 'Download path unavailable'}</span>: {check.free_bytes === null ? 'Free space unavailable' : `${formatBytes(check.free_bytes) || '0 B'} free`} · {formatBytes(check.required_bytes) || '0 B'} needed{check.unknown_torrents ? ' + unverified sizes' : ''}
                {check.sufficient === false && <span className="block font-bold">Not enough space for these downloads.</span>}
                {check.reason && <span className="block">{check.reason}</span>}
              </div>)}
              {currentPreflight && !estimate.new_torrents && <p className="m-0 text-muted">No new torrents to add. Existing torrents are kept unchanged.</p>}
              {(estimate.unknown_torrents > 0 || estimate.approximate_torrents > 0) && <p className="m-0 text-warn">Some saved releases lack file sizes. Run a new scan for a more accurate estimate.</p>}
              <details className="text-muted"><summary className="min-h-6 cursor-pointer font-bold text-ink">Estimate details and limitations</summary><p className="mt-2 mb-0 leading-relaxed">Shared torrents and files are counted once. Existing torrents are skipped. Space is a snapshot; other downloads, torrent overhead, and library imports may need additional room.</p></details>
              <button type="button" className="touch-target cursor-pointer rounded-lg px-2 py-1 font-bold text-accent-bright hover:bg-accent/10 disabled:opacity-50" disabled={checking || busy} onClick={() => setRetry(current => current + 1)}>Refresh check</button>
              {lowSpace && <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-warn/30 bg-warn/8 p-3 text-warn"><input type="checkbox" checked={acceptSpaceWarning} onChange={event => setAcceptSpaceWarning(event.target.checked)}/>Continue despite the disk space warning</label>}
            </section>}
          </>}
          {view === 'unavailable' && (
            <section>
              <h3 className="mb-3 text-xs font-extrabold tracking-[0.12em] text-warn uppercase">Unavailable from private indexers</h3>
              <div className="space-y-1.5">
                {blockedSorted.map((group) => {
                  const isHidden = hiddenKeys.has(hiddenKey(group.result))
                  return (
                    <div key={group.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-xs">
                      <span className="font-semibold text-ink">{group.result.title}</span>
                      <span className="rounded border border-warn/25 px-1.5 py-0.5 text-xs font-extrabold text-warn">{seasonLabel(group.result)}{group.part ? ` · ${group.part}` : ''}</span>
                      {isHidden && <span className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-extrabold text-warn"><Icon name="eye-off" size={12}/>Hidden</span>}
                      <span className="ml-auto min-w-0 truncate text-muted" title={group.options.map(({ release }) => release.releaseGroup).join(' · ')}>{group.options.length ? `Private: ${group.options.map(({ release }) => release.releaseGroup).join(' · ')}` : 'No public magnet available'}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        <footer className="bulk-download-footer flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-5 py-4">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {!outcome && pendingChoices > 0 && <span className="inline-flex items-center gap-1 font-bold text-warn"><Icon name="alert" size={13}/>Resolve {pendingChoices} release choice{pendingChoices === 1 ? '' : 's'} first</span>}
            {!outcome && lowSpace && !acceptSpaceWarning && <button type="button" className="touch-target cursor-pointer rounded-lg px-2 py-1 font-bold text-warn underline hover:bg-warn/10" onClick={() => diskRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus()}>Review disk space warning</button>}
          </span>
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap justify-end gap-2 [&_button]:max-w-full [&_button]:justify-center [&_button]:wrap-anywhere max-[600px]:[&_button]:px-3">
            {outcome?.inflight ? (
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><span className="text-xs text-muted" role="status">Sending… {inflightProgress ? `${inflightProgress.settled}/${inflightProgress.total} torrents` : ''}</span><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/12 text-accent-bright')} onClick={onClose}>Continue in background</button></div>
            ) : (
              <>
                <button ref={cancelRef} type="button" className={cx(buttonBase, 'border-line bg-panel-raised text-ink hover:text-ink')} onClick={onClose} disabled={busy}>{outcome ? 'Close' : 'Cancel'}</button>
                {!outcome && <button type="button" className={cx(buttonBase, 'border-good/35 bg-good/12 text-good hover:bg-good/20')} onClick={() => onConfirm(selections)} disabled={busy || checking || selections.length === 0 || pendingChoices > 0 || estimate.new_torrents === 0 || Boolean(lowSpace && !acceptSpaceWarning)}>{busy ? <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good"/> : <Icon name="download" size={17}/>}Download {estimate.new_torrents} torrent{estimate.new_torrents === 1 ? '' : 's'}</button>}
              </>
            )}
          </div>
        </footer>
      </section>
    </Modal>
  )
}
