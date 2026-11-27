import { isRecord } from '../shared/guards.js'
import { randomUUID } from 'node:crypto'
import { RELEASE_CHANGES_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { releaseResultIdentity } from '../shared/release-changes.js'
import type { ScanComparison } from './scan-comparison.js'
import type { ReleaseChange, ResultItem } from '../shared/contracts.js'

type ChangeStore = Record<string, ReleaseChange[]>

const CHANGE_KINDS: ReleaseChange['kind'][] = ['best', 'alternative', 'updated', 'removed', 'regression']

/** A stored or submitted release change with the fields every reader relies on. */
export function isReleaseChange(change: unknown): change is ReleaseChange {
  if (!change || typeof change !== 'object') return false
  const candidate = change as ReleaseChange
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 100 &&
    typeof candidate.description === 'string' &&
    CHANGE_KINDS.includes(candidate.kind) &&
    typeof candidate.detected_at === 'string' &&
    Number.isFinite(Date.parse(candidate.detected_at)) &&
    (candidate.part === undefined || typeof candidate.part === 'string')
  )
}

export function loadReleaseChanges(file = RELEASE_CHANGES_FILE): ChangeStore {
  const stored = readJson<unknown>(file, {}, 'Could not read unseen release changes')
  if (!isRecord(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored)
      .filter(([, changes]) => Array.isArray(changes))
      .map(([key, changes]) => [key, (changes as unknown[]).filter(isReleaseChange)]),
  )
}

/**
 * Adds each season's release changes and regression to the changes waiting for review. A baseline scan adds
 * nothing: results computed under different preferences are not comparable, so their differences are neither
 * SeaDex changes nor regressions. Earlier unseen changes are kept, and move with a title re-added under a new
 * item ID. A season new to the library starts with none, and the changes of seasons that are gone are dropped.
 */
export function recordReleaseChanges(
  comparison: ScanComparison,
  file = RELEASE_CHANGES_FILE,
  detectedAt = new Date().toISOString(),
): void {
  const stored = loadReleaseChanges(file)
  const next: ChangeStore = {}
  for (const season of comparison.seasons) {
    if (!season.previous) continue
    const additions = comparison.baseline
      ? []
      : [...season.releaseChanges, ...(season.regression ? [season.regression] : [])].map(change => ({
          ...change,
          id: randomUUID(),
          detected_at: detectedAt,
        }))
    const changes = [...(stored[releaseResultIdentity(season.previous)] || []), ...additions]
    if (changes.length) next[releaseResultIdentity(season.current)] = changes
  }
  if (JSON.stringify(next) !== JSON.stringify(stored)) writeJsonAtomic(file, next)
}

export function withReleaseChanges(results: ResultItem[], file = RELEASE_CHANGES_FILE): ResultItem[] {
  const changes = loadReleaseChanges(file)
  return results.map(result => ({ ...result, unseen_changes: changes[releaseResultIdentity(result)] || [] }))
}

/** Acknowledge explicit event IDs so a concurrent scan cannot clear a newer event. */
export function reviewReleaseChanges(ids: string[], file = RELEASE_CHANGES_FILE): number {
  const reviewed = new Set(ids),
    stored = loadReleaseChanges(file)
  let count = 0
  const next: ChangeStore = {}
  for (const [key, changes] of Object.entries(stored)) {
    const remaining = changes.filter(change => !reviewed.has(change.id))
    count += changes.length - remaining.length
    if (remaining.length) next[key] = remaining
  }
  if (count) writeJsonAtomic(file, next)
  return count
}

/**
 * Undoes a review: puts the given changes back as unseen under the result they belonged to.
 * Changes that are still unseen are left alone, so a repeated undo adds nothing twice.
 */
export function restoreReleaseChanges(
  entries: { key: string; change: ReleaseChange }[],
  file = RELEASE_CHANGES_FILE,
): number {
  const stored = loadReleaseChanges(file)
  const present = new Set(Object.values(stored).flatMap(changes => changes.map(change => change.id)))
  let count = 0
  for (const { key, change } of entries) {
    if (present.has(change.id)) continue
    present.add(change.id)
    stored[key] = [...(stored[key] || []), change].sort((a, b) => a.detected_at.localeCompare(b.detected_at))
    count++
  }
  if (count) writeJsonAtomic(file, stored)
  return count
}
