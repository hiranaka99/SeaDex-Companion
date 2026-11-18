import type { GroupedCard } from './types.js'

/** Action-first copy shared by library cards, release details, and scan history. */
export function releaseChangeDetail(description: string): { summary: string; release?: string } {
  const edit = description.match(/^(.+?) · ((?:Quality:|Torrent changed|Tags:|Dual audio:|Release size changed).*)$/)
  if (edit) return {
    summary: edit[2].split('; ').map(value => value === 'Torrent changed' ? 'Torrent updated' : value).join(' · '),
    release: edit[1],
  }
  const recommendation = description.match(/^(Best release changed|New best release|New alternative|New alternatives(?: \(\d+\))?|Alternative removed|Best release removed|Now an alternative): (.+)$/)
  if (recommendation) return { summary: recommendation[1], release: recommendation[2] }
  return { summary: description }
}

export function groupReleaseChanges(group: GroupedCard) {
  return group.seasons.flatMap(season => (season.unseen_changes || []).map(change => ({ season, change })))
    .sort((a, b) => b.change.detected_at.localeCompare(a.change.detected_at))
}

export function latestReleaseChange(group: GroupedCard): number {
  return Math.max(0, ...group.seasons.flatMap(season => (season.unseen_changes || []).map(change => Date.parse(change.detected_at) || 0)))
}
