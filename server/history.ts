import { HISTORY_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { upgradeAvailable } from '../shared/download-plan.js'
import { isRecord } from '../shared/guards.js'
import { sourceNameOf } from '../shared/arr-instances.js'
import { describeResultChange, resultIdentity, type ScanComparison } from './scan-comparison.js'
import type { ResultItem, ScanHistoryChange, ScanHistoryEntry, ScanTrigger } from '../shared/contracts.js'

/** Facts about one scan run that are recorded next to its result changes. */
export interface ScanRunMetadata {
  durationSeconds?: number
  scannedTitles?: number
  sourceErrors?: Record<string, string>
  outcome?: ScanHistoryEntry['outcome']
  error?: string
}

/** A partial season with an open upgrade counts as an upgrade in history. */
function automationStatus(result: ResultItem): string {
  return upgradeAvailable(result) ? 'upgrade' : result.status || 'unknown'
}

/** One scan's entry in history: how statuses moved, which seasons are new or removed, and what changed. */
export function buildScanHistoryEntry(
  comparison: ScanComparison,
  runAt: string,
  trigger: ScanTrigger = 'manual',
  metadata: ScanRunMetadata = {},
): ScanHistoryEntry {
  const counts: Record<string, number> = {}
  for (const { current } of comparison.seasons)
    counts[automationStatus(current)] = (counts[automationStatus(current)] || 0) + 1
  const changes: ScanHistoryChange[] = []
  const describe = (result: ResultItem) => ({
    library_key: result.library_key,
    key: resultIdentity(result),
    title: result.title || 'Unknown title',
    arr: sourceNameOf(result),
    season: result.season || 0,
    best_group: result.best_group || null,
  })
  for (const { current: result, previous: old, releaseChanges, regression } of comparison.seasons) {
    const to = automationStatus(result)
    if (!old) {
      changes.push({ type: 'new', ...describe(result), details: describeResultChange(null, result), from: null, to })
      continue
    }
    const from = automationStatus(old)
    if (from === to && (old.best_group || '') === (result.best_group || '') && !releaseChanges.length) continue
    const type = regression
      ? 'regression'
      : from !== 'upgrade' && to === 'upgrade'
        ? 'upgrade'
        : from === 'upgrade' && to !== 'upgrade'
          ? 'resolved'
          : 'changed'
    const listed = regression ? [regression] : releaseChanges
    const details = listed.length
      ? listed.map(change => change.description)
      : type === 'resolved'
        ? []
        : describeResultChange(old, result)
    changes.push({
      type,
      ...describe(result),
      from,
      to,
      details,
      ...(listed.length ? { release_changes: listed } : {}),
    })
  }
  for (const result of comparison.removed)
    changes.push({ type: 'removed', ...describe(result), details: [], from: automationStatus(result), to: null })
  const sourceErrors = metadata.sourceErrors || {}
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    run_at: runAt,
    trigger,
    duration_seconds: metadata.durationSeconds || 0,
    outcome: metadata.outcome || (Object.keys(sourceErrors).length ? 'partial' : 'success'),
    scanned_titles: metadata.scannedTitles ?? comparison.seasons.length,
    source_errors: sourceErrors,
    ...(metadata.error ? { error: metadata.error } : {}),
    counts,
    changes: changes.slice(0, 250),
  }
}

const isStoredChange = (change: unknown): change is ScanHistoryChange =>
  isRecord(change) && typeof change.title === 'string' && typeof change.type === 'string'
const isStoredScan = (scan: unknown): scan is ScanHistoryEntry =>
  isRecord(scan) && typeof scan.id === 'string' && typeof scan.run_at === 'string' && Array.isArray(scan.changes)

export function loadScanHistory(file = HISTORY_FILE): ScanHistoryEntry[] {
  const stored = readJson<unknown>(file, { version: 1, scans: [] }, 'Could not read scan history')
  if (!isRecord(stored) || !Array.isArray(stored.scans)) return []
  return stored.scans
    .filter(isStoredScan)
    .slice(0, 30)
    .map(scan => ({ ...scan, changes: scan.changes.filter(isStoredChange) }))
}

export function recordScanHistory(
  comparison: ScanComparison,
  runAt: string,
  file = HISTORY_FILE,
  trigger: ScanTrigger = 'manual',
  metadata: ScanRunMetadata = {},
): ScanHistoryEntry {
  const entry = buildScanHistoryEntry(comparison, runAt, trigger, metadata)
  writeJsonAtomic(file, { version: 1, scans: [entry, ...loadScanHistory(file)].slice(0, 30) }, true)
  return entry
}
