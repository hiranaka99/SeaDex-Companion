import type { ScanHistoryChange } from '../../shared/contracts.js'
import { presentReleaseChange, releaseChangeDetail, type ChangePresentation } from './release-changes.js'

export const historyStatusLabel: Record<string, string> = {
  upgrade: 'Upgradable', best: 'Best quality', missing: 'Not on SeaDex', uncovered: 'No releases', partial: 'Partially on SeaDex',
}

export function historyStatus(change: ScanHistoryChange): string | null {
  const from = change.from, to = change.to
  if (change.type === 'removed' || !to) return null
  if (!from) return historyStatusLabel[to] || to
  if (from !== to) return `${historyStatusLabel[from] || from} → ${historyStatusLabel[to] || to}`
  return ({ upgrade: 'Still upgradable', best: 'Still best quality', missing: 'Still not on SeaDex',
    uncovered: 'Still no releases', partial: 'Still partially on SeaDex' } as Record<string, string>)[to] || (historyStatusLabel[to] || to)
}

export function historyDetails(change: ScanHistoryChange): ChangePresentation[] {
  if (change.release_changes?.length) return change.release_changes.map(presentReleaseChange)
  const details = change.details?.filter(detail => detail.trim()) || []
  if (details.length) return details.map(releaseChangeDetail)
  if (change.type === 'new') return [{ summary: 'Added to your library' }]
  if (change.type === 'removed') return [{ summary: 'Removed from your library' }]
  if (change.type === 'upgrade') return [{ summary: 'An upgrade is now available', ...(change.best_group ? { release: change.best_group } : {}) }]
  if (change.to === 'best' && change.from !== 'best') return [{ summary: 'You now have the best release' }]
  if (change.from !== change.to) return [{ summary: 'Library status changed' }]
  return [{ summary: 'Release recommendation updated', ...(change.best_group ? { release: change.best_group } : {}) }]
}
