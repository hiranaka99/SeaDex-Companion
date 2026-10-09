import type { ResultItem } from '../types'
import { seasonLabel } from '../utils'
import { cx } from '../styles'

const TONES: Record<string, { classes: string; color: string; label: string }> = {
  upgrade: { classes: 'border-line-strong bg-accent/15', color: 'var(--color-accent-bright)', label: 'Upgradable' },
  best: { classes: 'border-good/35 bg-good/12', color: 'var(--color-good)', label: 'BEST release owned' },
  alt: { classes: 'border-bad/35 bg-bad/12', color: 'var(--color-bad)', label: 'ALT release owned' },
  missing: { classes: 'border-line-strong bg-canvas-soft', color: 'var(--color-muted)', label: 'Not on SeaDex' },
  partial: { classes: 'border-warn/35 bg-warn/12', color: 'var(--color-warn)', label: 'Partially on SeaDex' },
}

export default function SeasonBadge({ season, fallback, className, animeTitle = season.title }: { season: ResultItem; fallback: string; className: string; animeTitle?: string }) {
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

  const badgeClass = cx(className, 'season-badge inline-flex min-h-8 min-w-11 items-center justify-center text-ink')

  // Hard stops give each cour an equal segment, in cour order from left to right.
  const gradient = (opacity: number) => `linear-gradient(to right, ${tones.map((partTone, index) => {
    const color = `color-mix(in srgb, ${partTone.color} ${opacity}%, transparent)`
    return `${color} ${index * 100 / tones.length}%, ${color} ${(index + 1) * 100 / tones.length}%`
  }).join(', ')})`

  return (
    <span className={cx(badgeClass, mixed ? 'border-transparent' : tone.classes)} title={title} style={mixed ? { background: `${gradient(12)} padding-box, linear-gradient(var(--color-canvas-soft), var(--color-canvas-soft)) padding-box, ${gradient(35)} border-box` } : undefined}>
      <span className="sr-only">{animeTitle} · </span>{seasonLabel(season)}<span className="sr-only">: {title}</span>
    </span>
  )
}
