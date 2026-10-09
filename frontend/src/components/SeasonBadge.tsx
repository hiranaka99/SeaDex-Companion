import { useId } from 'react'
import type { ResultItem } from '../types'
import { seasonLabel } from '../utils'
import { cx } from '../styles'
import Icon from './Icons'

const TONES: Record<string, { classes: string; color: string; label: string }> = {
  upgrade: { classes: 'border-line-strong bg-accent/15', color: 'var(--color-accent-bright)', label: 'Upgradable' },
  best: { classes: 'border-good/35 bg-good/12', color: 'var(--color-good)', label: 'BEST release owned' },
  alt: { classes: 'border-bad/35 bg-bad/12', color: 'var(--color-bad)', label: 'ALT release owned' },
  missing: { classes: 'border-line-strong bg-accent/15', color: 'var(--color-accent-bright)', label: 'Not on SeaDex' },
  partial: { classes: 'border-warn/35 bg-warn/12', color: 'var(--color-warn)', label: 'Partially on SeaDex' },
}

export default function SeasonBadge({ season, fallback, className }: { season: ResultItem; fallback: string; className: string }) {
  const explanationId = useId()
  const releases = season.releases || []
  const status = season.status === 'uncovered' || season.status === 'review' ? 'partial' : season.status || fallback
  const defaultTone = TONES[status] || TONES.upgrade
  const owns = (release: typeof releases[number]) => {
    const ownedGroups = season.precise_part_ownership
      ? (season.owned_by_part?.[release.part || ''] || [])
      : season.have
    return ownedGroups.some(group => group.toLowerCase() === release.releaseGroup.toLowerCase())
  }
  const parts = [...new Set(releases.map(release => release.part || ''))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const split = parts.length > 1
  const tones = parts.map(part => {
    const owned = releases.filter(release => (release.part || '') === part && owns(release))
    if (split && owned.some(release => release.kind === 'best')) return TONES.best
    if (owned.some(release => release.kind === 'alt')) return TONES.alt
    return defaultTone
  })
  const tone = tones[0] || defaultTone
  const mixed = tones.some(partTone => partTone !== tone)
  const title = split
    ? parts.map((part, index) => `${part}: ${tones[index].label}`).join('; ')
    : tone.label

  const badgeClass = cx(className, 'touch-target min-h-8 min-w-11 cursor-pointer text-ink transition-colors hover:brightness-125')

  // Hard stops give each cour an equal segment, in cour order from left to right.
  const gradient = (opacity: number) => `linear-gradient(to right, ${tones.map((partTone, index) => {
    const color = `color-mix(in srgb, ${partTone.color} ${opacity}%, transparent)`
    return `${color} ${index * 100 / tones.length}%, ${color} ${(index + 1) * 100 / tones.length}%`
  }).join(', ')})`

  return (
    <>
      <button type="button" popoverTarget={explanationId} className={cx(badgeClass, mixed ? 'border-transparent' : tone.classes)} title={title} aria-label={`${seasonLabel(season)}: ${title}. Show season status`} style={mixed ? { background: `${gradient(12)} padding-box, linear-gradient(var(--color-canvas-soft), var(--color-canvas-soft)) padding-box, ${gradient(35)} border-box` } : undefined}>
        {seasonLabel(season)}
      </button>
      <div id={explanationId} popover="auto" role="region" aria-label={`${seasonLabel(season)} status`} className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-card border border-line-strong bg-panel-raised p-4 text-ink shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="m-0 text-sm font-bold">{seasonLabel(season)} status</h3><button type="button" popoverTarget={explanationId} popoverTargetAction="hide" aria-label="Close season status" className="grid size-11 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink"><Icon name="close" size={18}/></button></div>
        {split ? <ul className="m-0 space-y-2 pl-5 text-sm">{parts.map((part, index) => <li key={part}><strong>{part || 'Season'}:</strong> {tones[index].label}</li>)}</ul> : <p className="m-0 text-sm">{title}</p>}
      </div>
    </>
  )
}
