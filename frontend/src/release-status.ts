import { releaseOwned, isSeasonUpgradable } from '../../shared/download-plan.js'
import type { Release, ResultItem } from './types.js'

export interface CourReleases {
  part: string
  items: { rel: Release; index: number }[]
  unavailable?: string
}

export type ReleaseQuality = 'best' | 'upgrade' | 'partial' | 'review' | 'missing' | 'incomplete'
export interface QualityStatus { kind: ReleaseQuality; label: string }

/** Include unavailable cours so the overview cannot hide a gap in coverage. */
export function releaseCours(season: ResultItem): CourReleases[] {
  const groups = new Map<string, CourReleases>()
  season.releases.forEach((rel, index) => {
    const part = rel.part || ''
    if (!groups.has(part)) groups.set(part, { part, items: [] })
    groups.get(part)!.items.push({ rel, index })
  })
  const partNames = new Set([...Object.keys(season.have_by_part || {}), ...Object.keys(season.owned_by_part || {})])
  for (const { label, reason } of season.unavailable_parts || []) {
    if (!label.startsWith('Cour ') && !groups.has(label) && !partNames.has(label)) continue
    if (!groups.has(label)) groups.set(label, { part: label, items: [] })
    groups.get(label)!.unavailable = reason
  }
  for (const part of partNames) if (part && !groups.has(part)) groups.set(part, { part, items: [] })
  return [...groups.values()].sort((a, b) => a.part.localeCompare(b.part, undefined, { numeric: true }))
}

/** Groups found in local files, which need not constitute a complete cour. */
export function currentReleases(season: ResultItem, part?: string): string[] {
  if (part !== undefined && season.precise_part_ownership) return season.have_by_part?.[part] ?? season.owned_by_part?.[part] ?? []
  return season.have
}

export function releaseQuality(season: ResultItem, cour?: CourReleases): QualityStatus {
  if (season.match_status === 'unmatched' || (!season.anilist_id && season.status === 'missing')) return { kind: 'review', label: 'Match needs review' }
  if (cour?.unavailable || (!cour && (season.status === 'missing' || season.status === 'uncovered'))) return { kind: 'missing', label: 'Not on SeaDex' }
  if (!cour && season.status === 'partial') return { kind: 'partial', label: 'Partially on SeaDex' }
  if (!cour && (season.missing_episode_count || 0) > 0) return { kind: 'incomplete', label: 'Episodes missing' }

  const groups = cour ? [cour] : releaseCours(season)
  const ownsBest = groups.length > 0 && groups.every(group => group.items.some(({ rel }) => rel.kind === 'best' && releaseOwned(season, rel)))
  const confirmedOwnership = cour ? season.precise_part_ownership : season.status === 'best' && (!groups.some(group => group.part) || season.precise_part_ownership)
  if (ownsBest && confirmedOwnership) return { kind: 'best', label: 'Best owned' }
  if (cour && !cour.items.some(({ rel }) => rel.kind === 'best')) return { kind: 'partial', label: 'No release details' }
  if (isSeasonUpgradable(season) && !ownsBest) return { kind: 'upgrade', label: 'Upgrade available' }
  return { kind: 'partial', label: 'Ownership unconfirmed' }
}

export function releaseOverview(seasons: ResultItem[], arr: string) {
  const statuses = seasons.map(season => releaseQuality(season))
  const count = (kind: ReleaseQuality) => statuses.filter(status => status.kind === kind).length
  const best = count('best'), review = count('review'), partial = count('partial'), missing = count('missing'), incomplete = count('incomplete')
  const partialCoverage = seasons.filter((season, index) => season.status === 'partial' && statuses[index].kind === 'partial').length
  const upgrades = seasons.filter((season, index) => isSeasonUpgradable(season) && statuses[index].kind !== 'review').length
  const unit = arr === 'Radarr' ? 'movie' : 'season'
  const quantity = (n: number) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const description = [best && `${best} best owned`, upgrades && `${upgrades} upgradable`, review && `${review} ${review === 1 ? 'needs' : 'need'} a match review`, partialCoverage && `${partialCoverage} partially on SeaDex`, partial > partialCoverage && `${partial - partialCoverage} ownership unconfirmed`, missing && `${missing} not on SeaDex`, incomplete && `${incomplete} with missing episodes`].filter(Boolean).join(' · ')
  if (seasons.length > 0 && best === seasons.length) return { kind: 'best' as const, title: `You have the best release${seasons.length === 1 ? '' : 's'}`, description: `${seasons.length === 1 ? 'Your ' + unit + ' matches' : 'All ' + quantity(seasons.length) + ' match'} SeaDex recommendations.` }
  if (review) return { kind: 'review' as const, title: `${quantity(review)} ${review === 1 ? 'needs' : 'need'} a match review`, description }
  if (upgrades) return { kind: 'upgrade' as const, title: `${quantity(upgrades)} can be upgraded`, description }
  if (incomplete) return { kind: 'incomplete' as const, title: 'Your library has missing episodes', description }
  if (missing === seasons.length) return { kind: 'missing' as const, title: 'No releases found on SeaDex', description }
  return { kind: 'partial' as const, title: 'Some releases still need checking', description }
}
