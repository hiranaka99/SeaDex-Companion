import { releaseOwned } from '../../../shared/download-plan'
import type { ResultItem } from '../types'
import { seasonLabel } from '../utils'
import { cx } from '../styles'
import Icon, { IconName } from './Icons'

const TONES: Record<string, { classes: string; color: string; label: string; icon: IconName }> = {
  upgrade: { classes: 'border-line-strong bg-accent/15', color: 'var(--color-accent-bright)', label: 'Upgradable', icon: 'arrow-up' },
  best: { classes: 'border-good/35 bg-good/12', color: 'var(--color-good)', label: 'BEST release owned', icon: 'check' },
  alt: { classes: 'border-bad/35 bg-bad/12', color: 'var(--color-bad)', label: 'ALT release owned', icon: 'info' },
  missing: { classes: 'border-dashed border-line-strong bg-canvas-soft', color: 'var(--color-muted)', label: 'Not on SeaDex', icon: 'minus' },
  partial: { classes: 'border-warn/35 bg-warn/12', color: 'var(--color-warn)', label: 'Partially on SeaDex', icon: 'alert' },
}

export default function SeasonBadge({ season, fallback, className, animeTitle = season.title, onSelect }: { season: ResultItem; fallback: string; className: string; animeTitle?: string; onSelect?: () => void }) {
  const releases = season.releases || []
  const status = season.status === 'uncovered' ? 'partial' : season.status || fallback
  const defaultTone = TONES[status] || TONES.upgrade
  const owns = (release: typeof releases[number]) => releaseOwned(season, release)
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

  const badgeClass = cx(className, 'season-badge relative inline-flex min-h-8 min-w-11 items-center justify-center text-ink')

  // Hard stops give each cour an equal segment, in cour order from left to right.
  const gradient = (opacity: number) => `linear-gradient(to right, ${tones.map((partTone, index) => {
    const color = `color-mix(in srgb, ${partTone.color} ${opacity}%, transparent)`
    return `${color} ${index * 100 / tones.length}%, ${color} ${(index + 1) * 100 / tones.length}%`
  }).join(', ')})`

  const Tag = onSelect ? 'button' : 'span'
  return (
    <Tag {...(onSelect ? { type: 'button' as const, onClick: onSelect } : {})} className={cx(badgeClass, onSelect && 'touch-target cursor-pointer transition-colors hover:border-accent-bright', mixed ? 'border-transparent' : tone.classes)} title={title} style={mixed ? { background: `${gradient(12)} padding-box, linear-gradient(var(--color-canvas-soft), var(--color-canvas-soft)) padding-box, ${gradient(35)} border-box` } : undefined}>
      <span className="sr-only">{animeTitle} · </span><span className="season-badge-glyphs mr-1 inline-flex items-center gap-0.5" aria-hidden="true">{(tones.length ? tones : [defaultTone]).map((partTone, index) => <span key={index} className="inline-flex" style={{ color: partTone.color }}><Icon name={partTone.icon} size={12} /></span>)}</span>{seasonLabel(season)}<span className="sr-only">: {title}</span>{onSelect && <span className="sr-only">; opens Details</span>}
    </Tag>
  )
}
