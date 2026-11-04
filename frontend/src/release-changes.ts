import type { GroupedCard } from './types.js'

export function groupReleaseChanges(group: GroupedCard) {
  return group.seasons.flatMap(season => (season.unseen_changes || []).map(change => ({ season, change })))
    .sort((a, b) => b.change.detected_at.localeCompare(a.change.detected_at))
}

export function latestReleaseChange(group: GroupedCard): number {
  return Math.max(0, ...group.seasons.flatMap(season => (season.unseen_changes || []).map(change => Date.parse(change.detected_at) || 0)))
}
