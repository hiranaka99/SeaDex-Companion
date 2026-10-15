import { HISTORY_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { titleKey } from './anilist.js'
import type { JsonObject, ScanTrigger } from './types.js'

function resultIdentity(result: JsonObject): string {
  const base = String(result.library_key || `${result.arr || 'Unknown'}:${result.group_id ?? result.anilist_id ?? result.title ?? 'unknown'}`)
  return `${base}:${Number(result.season || 0)}`
}

function resultFallbackIdentity(result: JsonObject): string {
  return `${String(result.arr || 'Unknown')}:${titleKey(String(result.title || 'unknown'))}:${Number(result.season || 0)}`
}

function automationStatus(result: JsonObject): string {
  return result.status === 'partial' && result.upgrade_available ? 'upgrade' : String(result.status || 'unknown')
}

function previousResultIndex(previous: JsonObject[]): { byKey: Map<string, JsonObject>; byFallback: Map<string, JsonObject> } {
  return {
    byKey: new Map(previous.map((result) => [resultIdentity(result), result])),
    byFallback: new Map(previous.map((result) => [resultFallbackIdentity(result), result])),
  }
}

export function matchPreviousResult(previous: JsonObject[], current: JsonObject): JsonObject | null {
  const index = previousResultIndex(previous)
  return index.byKey.get(resultIdentity(current)) || index.byFallback.get(resultFallbackIdentity(current)) || null
}

function releaseGroupSet(result: JsonObject): Set<string> {
  return new Set(((result.releases || []) as JsonObject[]).map((release) => String(release.releaseGroup || '').trim().toLowerCase()).filter(Boolean))
}

function bestQualitySummary(result: JsonObject): string {
  const qualities = [...new Set(((result.releases || []) as JsonObject[])
    .filter((release) => release.kind === 'best')
    .map((release) => String(release.quality || '').trim())
    .filter(Boolean))]
  return qualities.join(' / ')
}

/** Human-readable specifics of what changed on seadex.moe between two scans of the same title. */
export function describeResultChange(previous: JsonObject | null, current: JsonObject): string[] {
  if (!previous) return ['Newly added to your library']
  const details: string[] = []
  const from = automationStatus(previous)
  const hasReleases = Boolean((current.releases || []).length)
  if (from === 'missing' && hasReleases) details.push('Now listed on seadex.moe')
  else if (from === 'uncovered' && hasReleases) details.push('Releases now available on SeaDex')
  const fromBest = String(previous.best_group || '').trim()
  const toBest = String(current.best_group || '').trim()
  if (toBest && toBest !== fromBest) details.push(fromBest ? `Best release changed: ${fromBest} → ${toBest}` : `New best release: ${toBest}`)
  const fromQuality = bestQualitySummary(previous)
  const toQuality = bestQualitySummary(current)
  if (fromQuality && toQuality && toQuality !== fromQuality) details.push(`Quality changed: ${fromQuality} → ${toQuality}`)
  const previousGroups = releaseGroupSet(previous)
  const newAlternatives: string[] = []
  for (const release of (current.releases || []) as JsonObject[]) {
    if (release.kind !== 'alt') continue
    const group = String(release.releaseGroup || '').trim()
    if (!group || previousGroups.has(group.toLowerCase()) || group.toLowerCase() === toBest.toLowerCase()) continue
    if (!newAlternatives.some((existing) => existing.toLowerCase() === group.toLowerCase())) newAlternatives.push(group)
  }
  if (newAlternatives.length) {
    details.push(`${newAlternatives.length === 1 ? 'New alternative' : `New alternatives (${newAlternatives.length})`}: ${newAlternatives.slice(0, 3).join(', ')}${newAlternatives.length > 3 ? '…' : ''}`)
  }
  const previousUnavailable = new Set(((previous.unavailable_parts || []) as JsonObject[]).map((part) => String(part.label || '').trim()).filter(Boolean))
  const currentUnavailable = new Set(((current.unavailable_parts || []) as JsonObject[]).map((part) => String(part.label || '').trim()).filter(Boolean))
  for (const label of previousUnavailable) if (!currentUnavailable.has(label)) details.push(`${label} now covered`)
  for (const label of currentUnavailable) if (!previousUnavailable.has(label)) details.push(`${label} no longer available on SeaDex`)
  if (String(previous.notes || '').trim() !== String(current.notes || '').trim()) details.push('seadex.moe notes updated')
  return details.slice(0, 6)
}

export interface ScanHistoryChange extends JsonObject {
  type: 'new' | 'upgrade' | 'resolved' | 'changed' | 'removed'
  details: string[]
}

export interface ScanHistoryEntry extends JsonObject {
  id: string
  run_at: string
  trigger: ScanTrigger
  duration_seconds: number
  outcome: 'success' | 'partial' | 'cancelled' | 'failed'
  scanned_titles: number
  source_errors: Record<string, string>
  error?: string
  counts: Record<string, number>
  changes: ScanHistoryChange[]
}

export function buildScanHistoryEntry(previous: JsonObject[], current: JsonObject[], runAt: string, trigger: ScanTrigger = 'manual', metadata: { durationSeconds?: number; scannedTitles?: number; sourceErrors?: Record<string, string>; outcome?: ScanHistoryEntry['outcome']; error?: string } = {}): ScanHistoryEntry {
  const { byKey: before, byFallback: beforeByFallback } = previousResultIndex(previous)
  const after = new Map(current.map((result) => [resultIdentity(result), result]))
  const matchedBefore = new Set<string>()
  const counts = current.reduce<Record<string, number>>((summary, result) => {
    const status = automationStatus(result)
    summary[status] = (summary[status] || 0) + 1
    return summary
  }, {})
  const changes: ScanHistoryChange[] = []
  const describe = (result: JsonObject) => ({
    library_key: result.library_key, key: resultIdentity(result), title: String(result.title || 'Unknown title'), arr: String(result.arr || ''),
    season: Number(result.season || 0), best_group: result.best_group || null,
  })
  for (const [key, result] of after) {
    const old = before.get(key) || beforeByFallback.get(resultFallbackIdentity(result))
    const to = automationStatus(result)
    if (!old) changes.push({ type: 'new', ...describe(result), details: describeResultChange(null, result), from: null, to })
    else {
      matchedBefore.add(resultIdentity(old))
      const from = automationStatus(old)
      if (from !== 'upgrade' && to === 'upgrade') changes.push({ type: 'upgrade', ...describe(result), details: describeResultChange(old, result), from, to })
      else if (from === 'upgrade' && to !== 'upgrade') changes.push({ type: 'resolved', ...describe(result), details: [], from, to })
      else if (from !== to || String(old.best_group || '') !== String(result.best_group || '')) changes.push({ type: 'changed', ...describe(result), details: describeResultChange(old, result), from, to })
    }
  }
  for (const [key, result] of before) if (!after.has(key) && !matchedBefore.has(key)) changes.push({ type: 'removed', ...describe(result), details: [], from: automationStatus(result), to: null })
  const sourceErrors = metadata.sourceErrors || {}
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, run_at: runAt, trigger, duration_seconds: metadata.durationSeconds || 0, outcome: metadata.outcome || (Object.keys(sourceErrors).length ? 'partial' : 'success'), scanned_titles: metadata.scannedTitles ?? current.length, source_errors: sourceErrors, ...(metadata.error ? { error: metadata.error } : {}), counts, changes: changes.slice(0, 250) }
}

export function loadScanHistory(file = HISTORY_FILE): ScanHistoryEntry[] {
  const stored = readJson<JsonObject>(file, { version: 1, scans: [] }, 'Could not read scan history')
  return stored && typeof stored === 'object' && Array.isArray(stored.scans)
    ? stored.scans.filter((scan: unknown): scan is ScanHistoryEntry => Boolean(scan && typeof scan === 'object' && typeof (scan as JsonObject).id === 'string' && typeof (scan as JsonObject).run_at === 'string' && Array.isArray((scan as JsonObject).changes)))
      .slice(0, 30).map((scan: ScanHistoryEntry) => ({ ...scan, changes: scan.changes.filter(change => change && typeof change.title === 'string' && typeof change.type === 'string') }))
    : []
}

export function recordScanHistory(previous: JsonObject[], current: JsonObject[], runAt: string, file = HISTORY_FILE, trigger: ScanTrigger = 'manual', metadata: { durationSeconds?: number; scannedTitles?: number; sourceErrors?: Record<string, string>; outcome?: ScanHistoryEntry['outcome']; error?: string } = {}): ScanHistoryEntry {
  const entry = buildScanHistoryEntry(previous, current, runAt, trigger, metadata)
  writeJsonAtomic(file, { version: 1, scans: [entry, ...loadScanHistory(file)].slice(0, 30) }, true)
  return entry
}
