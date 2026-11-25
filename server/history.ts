import { HISTORY_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { titleKey } from './anilist.js'
import { isSeasonUpgradable } from '../shared/download-plan.js'
import { isRecord } from '../shared/guards.js'
import { describeRegression, describeReleaseChanges } from '../shared/release-changes.js'
import { sourceKeyOf, sourceNameOf } from './arr-instances.js'
import type { ResultItem, ScanHistoryChange, ScanHistoryEntry, ScanTrigger } from '../shared/contracts.js'

/** Facts about one scan run that are recorded next to its result changes. */
export interface ScanRunMetadata {
  durationSeconds?: number
  scannedTitles?: number
  sourceErrors?: Record<string, string>
  outcome?: ScanHistoryEntry['outcome']
  error?: string
  /** The results were computed under different preferences, so status moves are not regressions. */
  settingsChanged?: boolean
}

function resultIdentity(result: ResultItem): string {
  const base = result.library_key || `${sourceKeyOf(result)}:${result.group_id ?? result.anilist_id ?? result.title}`
  return `${base}:${result.season || 0}`
}

function resultFallbackIdentity(result: ResultItem): string {
  return `${sourceKeyOf(result)}:${titleKey(result.title || 'unknown')}:${result.season || 0}`
}

/** A partial season with an open upgrade counts as an upgrade for history and notifications. */
function automationStatus(result: ResultItem): string {
  return isSeasonUpgradable(result) ? 'upgrade' : result.status || 'unknown'
}

function previousResultIndex(previous: ResultItem[]): {
  byKey: Map<string, ResultItem>
  byFallback: Map<string, ResultItem>
} {
  return {
    byKey: new Map(previous.map(result => [resultIdentity(result), result])),
    byFallback: new Map(previous.map(result => [resultFallbackIdentity(result), result])),
  }
}

export function matchPreviousResult(previous: ResultItem[], current: ResultItem): ResultItem | null {
  const index = previousResultIndex(previous)
  return index.byKey.get(resultIdentity(current)) || index.byFallback.get(resultFallbackIdentity(current)) || null
}

function releaseGroupSet(result: ResultItem): Set<string> {
  return new Set(result.releases.map(release => release.releaseGroup.trim().toLowerCase()).filter(Boolean))
}

function bestQualitySummary(result: ResultItem): string {
  const qualities = result.releases
    .filter(release => release.kind === 'best')
    .map(release => release.quality.trim())
    .filter(Boolean)
  return [...new Set(qualities)].join(' / ')
}

function unavailableLabels(result: ResultItem): Set<string> {
  return new Set((result.unavailable_parts || []).map(part => part.label.trim()).filter(Boolean))
}

/** Human-readable specifics of what changed on seadex.moe between two scans of the same title. */
export function describeResultChange(previous: ResultItem | null, current: ResultItem): string[] {
  if (!previous) return ['Newly added to your library']
  const details: string[] = []
  const from = automationStatus(previous)
  const hasReleases = current.releases.length > 0
  if (from === 'missing' && hasReleases) details.push('Now listed on seadex.moe')
  else if (from === 'uncovered' && hasReleases) details.push('Releases now available on SeaDex')
  const fromBest = (previous.best_group || '').trim()
  const toBest = (current.best_group || '').trim()
  if (toBest && toBest !== fromBest)
    details.push(fromBest ? `Best release changed: ${fromBest} → ${toBest}` : `New best release: ${toBest}`)
  const fromQuality = bestQualitySummary(previous)
  const toQuality = bestQualitySummary(current)
  if (fromQuality && toQuality && toQuality !== fromQuality)
    details.push(`Quality changed: ${fromQuality} → ${toQuality}`)
  const previousGroups = releaseGroupSet(previous)
  const newAlternatives: string[] = []
  for (const release of current.releases) {
    if (release.kind !== 'alt') continue
    const group = release.releaseGroup.trim()
    if (!group || previousGroups.has(group.toLowerCase()) || group.toLowerCase() === toBest.toLowerCase()) continue
    if (!newAlternatives.some(existing => existing.toLowerCase() === group.toLowerCase())) newAlternatives.push(group)
  }
  if (newAlternatives.length) {
    const heading = newAlternatives.length === 1 ? 'New alternative' : `New alternatives (${newAlternatives.length})`
    details.push(`${heading}: ${newAlternatives.slice(0, 3).join(', ')}${newAlternatives.length > 3 ? '…' : ''}`)
  }
  const previousUnavailable = unavailableLabels(previous)
  const currentUnavailable = unavailableLabels(current)
  for (const label of previousUnavailable) if (!currentUnavailable.has(label)) details.push(`${label} now covered`)
  for (const label of currentUnavailable)
    if (!previousUnavailable.has(label)) details.push(`${label} no longer available on SeaDex`)
  if ((previous.notes || '').trim() !== (current.notes || '').trim()) details.push('seadex.moe notes updated')
  const mismatched = (result: ResultItem) => [...new Set(Object.values(result.mismatched_by_part || {}).flat())].sort()
  const nowMismatched = mismatched(current).filter(group => !mismatched(previous).includes(group))
  if (nowMismatched.length) details.push(`Your ${nowMismatched.join(', ')} files differ from the listed release`)
  if (!previous.preference_blocked && current.preference_blocked)
    details.push('No listed release fits your release preferences')
  if (!details.length) details.push(...describeReleaseChanges(previous, current).map(change => change.description))
  return details.slice(0, 6)
}

export function buildScanHistoryEntry(
  previous: ResultItem[],
  current: ResultItem[],
  runAt: string,
  trigger: ScanTrigger = 'manual',
  metadata: ScanRunMetadata = {},
): ScanHistoryEntry {
  const { byKey: before, byFallback: beforeByFallback } = previousResultIndex(previous)
  const after = new Map(current.map(result => [resultIdentity(result), result]))
  const matchedBefore = new Set<string>()
  const counts: Record<string, number> = {}
  for (const result of current) counts[automationStatus(result)] = (counts[automationStatus(result)] || 0) + 1
  const changes: ScanHistoryChange[] = []
  const describe = (result: ResultItem) => ({
    library_key: result.library_key,
    key: resultIdentity(result),
    title: result.title || 'Unknown title',
    arr: sourceNameOf(result),
    season: result.season || 0,
    best_group: result.best_group || null,
  })
  for (const [key, result] of after) {
    const old = before.get(key) || beforeByFallback.get(resultFallbackIdentity(result))
    const to = automationStatus(result)
    if (!old) {
      changes.push({ type: 'new', ...describe(result), details: describeResultChange(null, result), from: null, to })
      continue
    }
    matchedBefore.add(resultIdentity(old))
    const from = automationStatus(old)
    const releaseChanges = describeReleaseChanges(old, result)
    if (from === to && (old.best_group || '') === (result.best_group || '') && !releaseChanges.length) continue
    const regression = metadata.settingsChanged ? null : describeRegression(old, result)
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
  for (const [key, result] of before) {
    if (!after.has(key) && !matchedBefore.has(key))
      changes.push({ type: 'removed', ...describe(result), details: [], from: automationStatus(result), to: null })
  }
  const sourceErrors = metadata.sourceErrors || {}
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    run_at: runAt,
    trigger,
    duration_seconds: metadata.durationSeconds || 0,
    outcome: metadata.outcome || (Object.keys(sourceErrors).length ? 'partial' : 'success'),
    scanned_titles: metadata.scannedTitles ?? current.length,
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
  previous: ResultItem[],
  current: ResultItem[],
  runAt: string,
  file = HISTORY_FILE,
  trigger: ScanTrigger = 'manual',
  metadata: ScanRunMetadata = {},
): ScanHistoryEntry {
  const entry = buildScanHistoryEntry(previous, current, runAt, trigger, metadata)
  writeJsonAtomic(file, { version: 1, scans: [entry, ...loadScanHistory(file)].slice(0, 30) }, true)
  return entry
}
