import { useEffect, useMemo, useRef, useState } from 'react'
import { ResultItem, Release } from '../types'
import { formatBytes, seasonLabel } from '../utils'
import { buttonBase, cx } from '../styles'
import Icon from './Icons'
import { BulkDownloadTarget } from '../api'

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
    if (result.status !== 'upgrade') continue
    const byPart = new Map<string, IndexedRelease[]>()
    result.releases.forEach((release, index) => {
      if (release.kind !== 'best') return
      const part = release.part || ''
      byPart.set(part, [...(byPart.get(part) || []), { index, release }])
    })
    for (const [part, bestReleases] of byPart) {
      const downloadable = bestReleases.filter(({ release }) => release.downloadable && release.info_hashes.length > 0)
      const group = { id: `${result.key}::${part || 'all'}`, result, part, options: downloadable.length ? downloadable : bestReleases }
      if (downloadable.length) ready.push(group)
      else blocked.push(group)
    }
  }

  return { ready, choices: ready.filter((group) => group.options.length > 1), blocked }
}

interface Props {
  open: boolean
  results: ResultItem[]
  busy: boolean
  onConfirm: (selections: BulkDownloadTarget[]) => void
  onClose: () => void
}

export default function BulkDownloadDialog({ open, results, busy, onConfirm, onClose }: Props) {
  const review = useMemo(() => buildReview(results), [results])
  const [selected, setSelected] = useState<Record<string, number>>({})
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setSelected(Object.fromEntries(review.ready.map((group) => [group.id, group.options[0].index])))
    cancelRef.current?.focus()
  }, [open, review])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, busy, onClose])

  if (!open) return null

  const selections = review.ready.map((group) => ({ key: group.result.key, release: selected[group.id] ?? group.options[0].index }))
  const automaticCount = review.ready.length - review.choices.length

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/65 px-4 py-6 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-raised shadow-[0_24px_70px_rgba(0,0,0,.55)]" role="dialog" aria-modal="true" aria-labelledby="bulk-download-title">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-good/12 text-good"><Icon name="download" size={19}/></span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-download-title" className="m-0 text-lg font-extrabold">Review bulk downloads</h2>
            <p className="mt-1 mb-0 text-sm text-muted">Choose between equivalent best releases and review upgrades unavailable on public trackers.</p>
          </div>
          <button type="button" className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" size={18}/></button>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full border border-good/30 bg-good/10 px-3 py-1.5 text-good">{review.ready.length} ready</span>
            {review.choices.length > 0 && <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-accent-bright">{review.choices.length} need a choice</span>}
            {review.blocked.length > 0 && <span className="rounded-full border border-warn/30 bg-warn/10 px-3 py-1.5 text-warn">{review.blocked.length} unavailable</span>}
          </div>

          {review.choices.length > 0 && (
            <section>
              <h3 className="mb-3 text-xs font-extrabold tracking-[0.12em] text-accent-bright uppercase">Choose a best release</h3>
              <div className="space-y-3">
                {review.choices.map((group) => (
                  <div key={group.id} className="rounded-xl border border-line bg-canvas-soft p-3.5">
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      <span className="font-bold text-ink">{group.result.title}</span>
                      <span className="rounded-md border border-line-strong bg-panel px-2 py-0.5 text-[11px] font-extrabold text-muted">{seasonLabel(group.result)}{group.part ? ` · ${group.part}` : ''}</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.options.map(({ index, release }) => {
                        const checked = (selected[group.id] ?? group.options[0].index) === index
                        return (
                          <label key={index} className={cx('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors', checked ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:border-line-strong')}>
                            <input type="radio" name={group.id} className="mt-0.5 accent-blue-500" checked={checked} onChange={() => setSelected((current) => ({ ...current, [group.id]: index }))} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold text-ink" title={release.releaseGroup}>{release.releaseGroup}</span>
                              <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted"><span>{release.tracker}</span><span className="font-bold text-good">{formatBytes(release.size) || 'Unknown size'}</span></span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    <div className="mt-2.5 whitespace-pre-line break-words rounded-lg border border-line bg-panel/70 px-3 py-2 text-xs leading-relaxed text-muted"><span className="font-bold text-ink">Note:</span> {group.result.notes && group.result.notes !== '-' ? group.result.notes : 'No release note provided.'}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {automaticCount > 0 && <p className="m-0 text-xs text-muted"><Icon name="check" size={14} className="mr-1.5 inline text-good"/>{automaticCount} release{automaticCount === 1 ? '' : 's'} with a single public best option will be selected automatically.</p>}

          {review.blocked.length > 0 && (
            <section>
              <h3 className="mb-3 text-xs font-extrabold tracking-[0.12em] text-warn uppercase">Unavailable from private indexers</h3>
              <div className="space-y-2">
                {review.blocked.map((group) => (
                  <div key={group.id} className="rounded-xl border border-warn/25 bg-warn/6 px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-ink">{group.result.title}</span><span className="rounded-md border border-warn/25 px-2 py-0.5 text-[11px] font-extrabold text-warn">{seasonLabel(group.result)}{group.part ? ` · ${group.part}` : ''}</span></div>
                    <div className="mt-1.5 text-xs text-muted">{group.options.map(({ release }) => `${release.releaseGroup} (${release.tracker}, ${formatBytes(release.size) || 'unknown size'})`).join(' · ') || 'No public magnet is available.'}</div>
                    <div className="mt-1 whitespace-pre-line break-words text-xs text-muted"><span className="font-bold text-ink">Note:</span> {group.result.notes && group.result.notes !== '-' ? group.result.notes : 'No release note provided.'}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-5 py-4">
          <span className="text-xs text-muted">Private-indexer releases will be skipped.</span>
          <div className="flex gap-2">
            <button ref={cancelRef} type="button" className={cx(buttonBase, 'border-line bg-panel-raised text-muted hover:text-ink')} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className={cx(buttonBase, 'border-good/35 bg-good/12 text-good hover:bg-good/20')} onClick={() => onConfirm(selections)} disabled={busy || selections.length === 0}>{busy ? <span className="size-4 animate-spin rounded-full border-2 border-good/35 border-t-good"/> : <Icon name="download" size={17}/>}Download {selections.length || ''}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}
