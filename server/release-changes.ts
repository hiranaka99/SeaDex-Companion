import { randomUUID } from 'node:crypto'
import { RELEASE_CHANGES_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { describeReleaseChanges, releaseResultIdentity } from '../shared/release-changes.js'
import type { ReleaseChange, ResultItem } from '../shared/contracts.js'

type ChangeStore = Record<string, ReleaseChange[]>
export function loadReleaseChanges(file = RELEASE_CHANGES_FILE): ChangeStore {
  const stored = readJson<unknown>(file, {}, 'Could not read unseen release changes')
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(Object.entries(stored).filter(([, changes]) => Array.isArray(changes)).map(([key, changes]) => [key,
    (changes as unknown[]).filter((change): change is ReleaseChange => Boolean(change && typeof change === 'object' &&
      typeof (change as ReleaseChange).id === 'string' && typeof (change as ReleaseChange).description === 'string' &&
      ['best', 'alternative', 'updated', 'removed'].includes((change as ReleaseChange).kind) &&
      typeof (change as ReleaseChange).detected_at === 'string' && Number.isFinite(Date.parse((change as ReleaseChange).detected_at)) &&
      ((change as ReleaseChange).part === undefined || typeof (change as ReleaseChange).part === 'string'))),
  ]))
}

export function recordReleaseChanges(previous: ResultItem[], current: ResultItem[], file = RELEASE_CHANGES_FILE, detectedAt = new Date().toISOString()): void {
  const stored = loadReleaseChanges(file)
  const before = new Map(previous.map(result => [releaseResultIdentity(result), result]))
  const next: ChangeStore = {}
  for (const result of current) {
    const key = releaseResultIdentity(result), old = before.get(key)
    // New installations, cleared scan data, and newly discovered titles establish a baseline.
    const additions = old ? describeReleaseChanges(old, result).map(change => ({ ...change, id: randomUUID(), detected_at: detectedAt })) : []
    const changes = old ? [...(stored[key] || []), ...additions] : []
    if (changes.length) next[key] = changes
  }
  if (JSON.stringify(next) !== JSON.stringify(stored)) writeJsonAtomic(file, next)
}

export function withReleaseChanges(results: ResultItem[], file = RELEASE_CHANGES_FILE): ResultItem[] {
  const changes = loadReleaseChanges(file)
  return results.map(result => ({ ...result, unseen_changes: changes[releaseResultIdentity(result)] || [] }))
}

/** Acknowledge explicit event IDs so a concurrent scan cannot clear a newer event. */
export function reviewReleaseChanges(ids: string[], file = RELEASE_CHANGES_FILE): number {
  const reviewed = new Set(ids), stored = loadReleaseChanges(file)
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
