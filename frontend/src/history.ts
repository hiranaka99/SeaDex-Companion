import type { ScanHistoryChange, ScanHistoryEntry } from '../../shared/contracts.js'
import { parseTimestamp } from '../../shared/datetime-format.js'
import { presentReleaseChange, releaseChangeDetail, type ChangePresentation } from './release-changes.js'

/** Change types in the order a reader cares about them: actionable first, bookkeeping last. */
export const changeTypeOrder = ['regression', 'upgrade', 'resolved', 'changed', 'new', 'removed'] as const
type ChangeType = (typeof changeTypeOrder)[number]
/** One name per change type, used by the filter, the section headings and (lowercased) the scan summaries. */
const CHANGE_TYPE_NAMES: Record<ChangeType, string> = {
  regression: 'No longer best',
  upgrade: 'Upgrade available',
  resolved: 'Resolved',
  changed: 'Updated',
  new: 'Added',
  removed: 'Removed',
}
export const changeTypeLabel: Record<string, string> = Object.fromEntries(
  changeTypeOrder.map(type => [type, CHANGE_TYPE_NAMES[type]]),
)

export function summarizeChanges(changes: ScanHistoryChange[]): Array<{ type: string; count: number; label: string }> {
  return changeTypeOrder
    .map(type => ({
      type,
      count: changes.filter(change => change.type === type).length,
      label: CHANGE_TYPE_NAMES[type].toLowerCase(),
    }))
    .filter(entry => entry.count > 0)
}

export function pluralize(count: number, singular: string, plural = singular + 's'): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

export type HistoryRow =
  | { kind: 'change'; change: ScanHistoryChange }
  | { kind: 'group'; type: 'new' | 'removed'; changes: ScanHistoryChange[] }

export const historyRowType = (row: HistoryRow): string => (row.kind === 'group' ? row.type : row.change.type)

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

/** Consecutive rows of one change type, each run introduced by a heading inside an expanded scan. */
export function sectionRows(rows: HistoryRow[]): Array<{ type: string; rows: HistoryRow[] }> {
  const sections: Array<{ type: string; rows: HistoryRow[] }> = []
  for (const row of rows) {
    const type = historyRowType(row)
    const last = sections[sections.length - 1]
    if (last && last.type === type) last.rows.push(row)
    else sections.push({ type, rows: [row] })
  }
  return sections
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
  // Only today's scans carry an age; earlier days are named by their heading, so every scan under one heading reads alike.
  const age =
    days !== 0 || minutes < 0
      ? null
      : minutes < 1
        ? 'just now'
        : minutes < 60
          ? `${minutes} min ago`
          : `${Math.floor(minutes / 60)} h ago`
  return {
    dayKey: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    dayLabel,
    time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    age,
  }
}

/** The library's own status names, so history and the library never describe one state two ways. */
export const historyStatusLabel: Record<string, string> = {
  upgrade: 'Upgrade available',
  best: 'Best owned',
  missing: 'Not on SeaDex',
  uncovered: 'Not on SeaDex',
  partial: 'Partially on SeaDex',
}
/** History stores the scanner's status; "uncovered" is shown as the library shows it. */
export const historyStatusKind = (status: string): string => (status === 'uncovered' ? 'missing' : status)

export interface HistoryStatus {
  /** The status before this scan, or null when the title is new or the status did not change. */
  from: string | null
  fromLabel: string | null
  to: string
  toLabel: string
  changed: boolean
}

export function historyStatus(change: ScanHistoryChange): HistoryStatus | null {
  const { from, to } = change
  if (change.type === 'removed' || !to) return null
  const label = (status: string) => historyStatusLabel[status] || status
  const changed = Boolean(from) && from !== to
  return {
    from: changed ? from : null,
    fromLabel: changed && from ? label(from) : null,
    to: historyStatusKind(to),
    toLabel: label(to),
    changed: changed || !from,
  }
}

/** Plain text for a status, e.g. "Upgrade available → Best owned" or "Upgrade available · unchanged". */
export function historyStatusText(change: ScanHistoryChange): string | null {
  const status = historyStatus(change)
  if (!status) return null
  if (status.fromLabel) return `${status.fromLabel} → ${status.toLabel}`
  return status.changed ? status.toLabel : `${status.toLabel} · unchanged`
}

/**
 * Release-level detail for a row. The status line and the section heading already say what happened to the
 * title, so a change without release detail adds a line only when it names a release or a recommendation edit.
 */
export function historyDetails(change: ScanHistoryChange): ChangePresentation[] {
  if (change.release_changes?.length) return change.release_changes.map(presentReleaseChange)
  const details = change.details?.filter(detail => detail.trim()) || []
  if (details.length) return details.map(releaseChangeDetail)
  if ((change.type === 'upgrade' || change.type === 'regression') && change.best_group)
    return [{ summary: 'Best release', release: change.best_group }]
  if (change.type === 'changed' && change.from === change.to)
    return [{ summary: 'Release recommendation updated', ...(change.best_group ? { release: change.best_group } : {}) }]
  return []
}

export interface VisitDigest {
  /** "since-visit" covers every scan newer than the last one seen here; "latest" covers only the newest scan. */
  scope: 'since-visit' | 'latest'
  scans: ScanHistoryEntry[]
  /** Titles a scan in the window made upgradable and whose latest change still leaves them upgradable. */
  upgrades: ScanHistoryChange[]
  /** Titles a scan in the window brought to the best release and still best. */
  resolved: ScanHistoryChange[]
  /** Scans in the window that failed, were cancelled, or could not reach a source. */
  attention: ScanHistoryEntry[]
  /** Everything else, counted once per title by its latest change. */
  other: Array<{ type: string; count: number; label: string }>
}

const scanNeedsAttention = (scan: ScanHistoryEntry) =>
  Boolean(scan.error && scan.outcome !== 'cancelled') ||
  scan.outcome === 'failed' ||
  scan.outcome === 'partial' ||
  Object.keys(scan.source_errors || {}).length > 0

/**
 * What changed since the reader last opened history, netted per title so a title upgraded and then
 * resolved within the window counts once, as resolved. Scans are newest first.
 */
export function visitDigest(scans: ScanHistoryEntry[], seenId: string | null): VisitDigest | null {
  if (!scans.length) return null
  const seenIndex = seenId ? scans.findIndex(scan => scan.id === seenId) : -1
  const scope = seenId && seenIndex !== 0 ? 'since-visit' : 'latest'
  const window = scope === 'latest' ? scans.slice(0, 1) : seenIndex > 0 ? scans.slice(0, seenIndex) : scans
  const byTitle = new Map<string, { latest: ScanHistoryChange; types: Set<string> }>()
  for (const scan of window)
    for (const change of scan.changes) {
      const key = change.key + ':' + change.season
      const entry = byTitle.get(key)
      if (entry) entry.types.add(change.type)
      else byTitle.set(key, { latest: change, types: new Set([change.type]) })
    }
  const upgrades: ScanHistoryChange[] = []
  const resolved: ScanHistoryChange[] = []
  const rest: ScanHistoryChange[] = []
  for (const { latest, types } of byTitle.values()) {
    if (latest.to === 'upgrade' && (types.has('upgrade') || types.has('regression'))) upgrades.push(latest)
    else if (latest.to === 'best' && types.has('resolved')) resolved.push(latest)
    else rest.push(latest)
  }
  return {
    scope,
    scans: window,
    upgrades,
    resolved,
    attention: window.filter(scanNeedsAttention),
    other: summarizeChanges(rest),
  }
}
