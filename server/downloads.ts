import { upgradeParts, torrentHashes } from '../shared/download-plan.js'
import { applyUserRulesToResults } from './user-rules.js'
import { scanState } from './scan-state.js'
import { loadLastResults } from './results.js'
import type { JsonObject, ResultItem } from './types.js'

export function normalizeQbStates(states: string[]): string {
  if (!states.length) return 'unknown'
  if (states.some((state) => ['error', 'missingFiles', 'unknown'].includes(state))) return 'error'
  const downloading = new Set(['downloading', 'forcedDL', 'metaDL', 'queuedDL', 'stalledDL', 'checkingDL', 'allocating', 'checkingResumeData'])
  const uploading = new Set(['uploading', 'forcedUP', 'queuedUP', 'stalledUP'])
  const paused = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'])
  if (states.every((state) => uploading.has(state))) return 'complete'
  if (states.some((state) => downloading.has(state))) return 'downloading'
  if (states.every((state) => paused.has(state))) return 'paused'
  return 'unknown'
}

export interface BulkDownloadTarget {
  key: string
  release: number
  arr: string
  part: string
  hashes: string[]
  selectedFiles?: string[]
}

export function bulkDownloadTargets(results?: JsonObject[]): BulkDownloadTarget[] {
  const targets: BulkDownloadTarget[] = []
  const candidates = results === undefined ? applyUserRulesToResults(resultsForRequest()) : results
  for (const result of candidates) {
    if (!result.key) continue
    for (const part of upgradeParts(result as import('../shared/download-plan.js').RecommendationSeason)) {
      if (!part.downloadable) continue
      for (const { index: releaseIndex, release } of part.options) targets.push({
        key: String(result.key), release: releaseIndex, arr: String(result.arr || ''), part: part.part,
        hashes: torrentHashes(release), ...(release.selected_files?.length ? { selectedFiles: [...release.selected_files] } : {}),
      })
    }
  }
  return targets
}

export interface BulkCancelInfo {
  key: string
  release: number
  title: string
  season: number | null
  part: string
  releaseGroup: string
  tracker: string
  size: number
  library_key?: string
  associations?: { key: string; library_key?: string; season: number | null }[]
}

export interface ResultReleaseIndex {
  byHash: Map<string, BulkCancelInfo>
  byTarget: Map<string, Set<string>>
}

/**
 * Indexes every valid info hash in the current scan results so a qBittorrent
 * torrent can be mapped back to the release that created it. `byTarget` also
 * lets bulk cancellation resolve a (key, release) selection to its hashes.
 */
export function indexResultReleases(results: JsonObject[] = resultsForRequest(), selections?: readonly { key: string; release: number }[]): ResultReleaseIndex {
  const selected = selections ? new Set(selections.map(selection => `${selection.key}\0${selection.release}`)) : null
  const byHash = new Map<string, BulkCancelInfo>()
  const byTarget = new Map<string, Set<string>>()
  for (const result of results) {
    if (!result.key) continue
    const key = String(result.key)
    const season = result.season == null ? null : Number(result.season)
    for (const [releaseIndex, release] of (result.releases || []).entries()) {
      const targetKey = `${key}\0${releaseIndex}`
      if (selected && !selected.has(targetKey)) continue
      const info: BulkCancelInfo = {
        key,
        release: releaseIndex,
        title: String(result.title || ''),
        season,
        part: String(release.part || ''),
        releaseGroup: String(release.releaseGroup || ''),
        tracker: String(release.tracker || ''),
        size: Number(release.size || 0),
        library_key: result.library_key,
        associations: [{ key, library_key: result.library_key, season }],
      }
      for (const raw of (release.info_hashes || [])) {
        const hash = String(raw).toLowerCase()
        if (!/^[0-9a-f]{40}$/.test(hash)) continue
        const previous = byHash.get(hash)
        byHash.set(hash, { ...info, associations: [...(previous?.associations || []), ...info.associations!] })
        if (!byTarget.has(targetKey)) byTarget.set(targetKey, new Set())
        byTarget.get(targetKey)!.add(hash)
      }
    }
  }
  return { byHash, byTarget }
}

export function resultsForRequest(): ResultItem[] {
  return scanState.results.length ? scanState.results : (loadLastResults()?.results || [])
}
