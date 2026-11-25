import type { ScanHistoryChange } from '../../shared/contracts.js'
import { parseTimestamp } from '../../shared/datetime-format.js'
import { presentReleaseChange, releaseChangeDetail, type ChangePresentation } from './release-changes.js'

/** Change types in the order a reader cares about them: actionable first, bookkeeping last. */
export const changeTypeOrder = ['regression', 'upgrade', 'resolved', 'changed', 'new', 'removed'] as const
export const changeTypeLabel: Record<string, string> = {
  regression: 'No longer best',
  upgrade: 'Now upgradable',
  resolved: 'Resolved',
  new: 'New title',
  removed: 'Removed',
  changed: 'Updated',
}
/** Short noun phrases for the per-scan summary line, e.g. "3 upgradable · 170 removed". */
const changeTypeSummary: Record<string, string> = {
  regression: 'no longer best',
  upgrade: 'upgradable',
  resolved: 'resolved',
  changed: 'updated',
  new: 'added',
  removed: 'removed',
}

export function summarizeChanges(changes: ScanHistoryChange[]): Array<{ type: string; count: number; label: string }> {
  return changeTypeOrder
    .map(type => ({
      type,
      count: changes.filter(change => change.type === type).length,
      label: changeTypeSummary[type],
    }))
    .filter(entry => entry.count > 0)
}

export function pluralize(count: number, singular: string, plural = singular + 's'): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

export type HistoryRow =
  | { kind: 'change'; change: ScanHistoryChange }
  | { kind: 'group'; type: 'new' | 'removed'; changes: ScanHistoryChange[] }

const isBareLibraryChange = (change: ScanHistoryChange) =>
  (change.type === 'new' || change.type === 'removed') &&
  !change.release_changes?.length &&
  !change.details?.some(detail => detail.trim())

/**
 * Orders a scan's changes by importance and folds long runs of identical
 * "added to / removed from your library" entries into one expandable group so
 * a first scan or a library reset does not bury the changes that matter.
 */
export function groupChanges(changes: ScanHistoryChange[], threshold = 5): HistoryRow[] {
  const rank = (change: ScanHistoryChange) => {
    const index = changeTypeOrder.indexOf(change.type)
    return index < 0 ? changeTypeOrder.length : index
  }
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => rank(a.change) - rank(b.change) || a.index - b.index)
    .map(entry => entry.change)
  const groupOf = new Map<ScanHistoryChange, Extract<HistoryRow, { kind: 'group' }>>()
  for (const type of ['new', 'removed'] as const) {
    const bare = ordered.filter(change => change.type === type && isBareLibraryChange(change))
    if (bare.length < threshold) continue
    const group = { kind: 'group' as const, type, changes: bare }
    for (const change of bare) groupOf.set(change, group)
  }
  const rows: HistoryRow[] = []
  const placed = new Set<unknown>()
  for (const change of ordered) {
    const group = groupOf.get(change)
    if (!group) rows.push({ kind: 'change', change })
    else if (!placed.has(group)) {
      placed.add(group)
      rows.push(group)
    }
  }
  return rows
}

/** A search matches the title, or a season token such as "S02" or "season 2". */
export function matchesHistoryQuery(change: ScanHistoryChange, query: string): boolean {
  const text = query.trim().toLowerCase()
  if (!text) return true
  const season = /^(?:s|season\s*)(\d{1,3})$/.exec(text)
  if (season) return change.season === Number(season[1])
  return change.title.toLowerCase().includes(text)
}

export function scanTimes(
  runAt: string,
  now = new Date(),
): { dayKey: string; dayLabel: string; time: string; age: string | null } {
  const date = parseTimestamp(runAt)
  if (!date) return { dayKey: 'unknown', dayLabel: 'Earlier', time: runAt, age: null }
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  const dayLabel =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : date.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
          })
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)
  const age =
    minutes < 0
      ? null
      : minutes < 1
        ? 'just now'
        : minutes < 60
          ? `${minutes} min ago`
          : minutes < 1440
            ? `${Math.floor(minutes / 60)} h ago`
            : null
  return {
    dayKey: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    dayLabel,
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    age,
  }
}

export const historyStatusLabel: Record<string, string> = {
  upgrade: 'Upgradable',
  best: 'Best quality',
  missing: 'Not on SeaDex',
  uncovered: 'No releases',
  partial: 'Partially on SeaDex',
}

export function historyStatus(change: ScanHistoryChange): string | null {
  const from = change.from,
    to = change.to
  if (change.type === 'removed' || !to) return null
  if (!from) return historyStatusLabel[to] || to
  if (from !== to) return `${historyStatusLabel[from] || from} → ${historyStatusLabel[to] || to}`
  return (
    (
      {
        upgrade: 'Still upgradable',
        best: 'Still best quality',
        missing: 'Still not on SeaDex',
        uncovered: 'Still no releases',
        partial: 'Still partially on SeaDex',
      } as Record<string, string>
    )[to] ||
    historyStatusLabel[to] ||
    to
  )
}

export function historyDetails(change: ScanHistoryChange): ChangePresentation[] {
  if (change.release_changes?.length) return change.release_changes.map(presentReleaseChange)
  const details = change.details?.filter(detail => detail.trim()) || []
  if (details.length) return details.map(releaseChangeDetail)
  if (change.type === 'new') return [{ summary: 'Added to your library' }]
  if (change.type === 'removed') return [{ summary: 'Removed from your library' }]
  if (change.type === 'regression') return [{ summary: 'No longer on the best release' }]
  if (change.type === 'upgrade')
    return [{ summary: 'An upgrade is now available', ...(change.best_group ? { release: change.best_group } : {}) }]
  if (change.to === 'best' && change.from !== 'best') return [{ summary: 'You now have the best release' }]
  if (change.from !== change.to) return [{ summary: 'Library status changed' }]
  return [{ summary: 'Release recommendation updated', ...(change.best_group ? { release: change.best_group } : {}) }]
}
