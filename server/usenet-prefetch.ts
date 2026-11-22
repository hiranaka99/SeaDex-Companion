import { log } from './logging.js'
import { loadLastResults } from './results.js'
import { exclusionRuleKey, loadUserRules } from './user-rules.js'
import { torrentHashes } from '../shared/download-plan.js'
import { resolveUsenetRelease, retainUsenetHashes, sabnzbdConfigured, usenetProviderPauses, usenetProvidersEnabled } from './usenet.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'
import type { Config, Release, ResultItem } from './types.js'

/**
 * Background Usenet availability prefetch. After each scan (and at startup or
 * Usenet-relevant config changes) the saved results are walked once at
 * background priority so opening a card or reviewing a plan hits a warm cache.
 * All provider traffic goes through the resolver's cache, per-provider rate
 * limiter and provider pauses; a sweep is superseded by the next one.
 */

export interface UsenetPrefetchProgress {
  running: boolean
  checked: number
  total: number
  /** Providers the sweep is currently waiting on after rate limiting or repeated failures. */
  paused?: { provider: UsenetProvider; resume_in_seconds: number; rate_limited: boolean }[]
}

let enabled = false
let sweepEpoch = 0
let progress = { running: false, checked: 0, total: 0 }

/** Live progress of the background availability sweep, for the sidebar. */
export function usenetPrefetchProgress(): UsenetPrefetchProgress {
  if (!progress.running) return { running: false, checked: 0, total: 0 }
  const now = Date.now()
  const paused = usenetProviderPauses().map(pause => ({ provider: pause.provider, resume_in_seconds: Math.max(1, Math.ceil((pause.until - now) / 1000)), rate_limited: pause.reason === 'rate_limited' }))
  return { ...progress, ...(paused.length ? { paused } : {}) }
}

/** Prefetch only runs in the real server; tests opt in explicitly. */
export function enableUsenetPrefetch(): void {
  enabled = true
}

export function usenetPrefetchEligible(config: Config): boolean {
  if (config.download_mode === 'torrent_only' || !sabnzbdConfigured(config)) return false
  const providers = usenetProvidersEnabled(config)
  return providers.animetosho || providers.amenzb
}

/** Results the user is most likely to download from are checked first; owned best releases last. */
const STATUS_PRIORITY: Partial<Record<ResultItem['status'], number>> = { missing: 0, partial: 0, upgrade: 1, best: 3 }
const statusPriority = (result: ResultItem) => STATUS_PRIORITY[result.status] ?? 2

/** Releases the sweep should check, in priority order, without excluded seasons or parts. */
export function prefetchPlan(results: ResultItem[], exclusions: ReadonlySet<string> = new Set(loadUserRules().exclusions)): { key: string; releases: Release[] }[] {
  const excluded = (result: ResultItem, release: Release) => {
    if (result.excluded) return true
    if (release.part && result.excluded_parts?.includes(release.part)) return true
    if (!result.library_key) return false
    if (exclusions.has(exclusionRuleKey(result.library_key, result.season))) return true
    return Boolean(release.part && exclusions.has(exclusionRuleKey(result.library_key, result.season, release.part)))
  }
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) => statusPriority(left.result) - statusPriority(right.result) || left.index - right.index)
    .map(({ result }) => ({
      key: result.key,
      releases: (result.releases || [])
        .filter(release => !excluded(result, release))
        .sort((left, right) => Number(left.kind !== 'best') - Number(right.kind !== 'best')),
    }))
    .filter(entry => entry.releases.length > 0)
}

/** Keep cached observations only for hashes the current results still reference. */
function pruneCache(results: ResultItem[]): void {
  if (!results.length) return
  const hashes = new Set(results.flatMap(result => (result.releases || []).flatMap(release => torrentHashes(release))))
  const removed = retainUsenetHashes(hashes)
  if (removed) log('INFO', `Usenet cache dropped ${removed} observation(s) for releases no longer in the results`)
}

/** Starts a background sweep over the saved results; any running sweep is superseded. */
export function prefetchUsenetAvailability(config: Config, results: ResultItem[], reason: string): void {
  const epoch = ++sweepEpoch
  progress = { running: false, checked: 0, total: 0 }
  if (!enabled) return
  pruneCache(results)
  if (!usenetPrefetchEligible(config)) return
  void runSweep(epoch, config, results, reason)
}

/** Cancels any running sweep (scanned data cleared). */
export function stopUsenetPrefetch(): void {
  sweepEpoch++
  progress = { running: false, checked: 0, total: 0 }
}

async function runSweep(epoch: number, config: Config, results: ResultItem[], reason: string): Promise<void> {
  const ownsProgress = () => epoch === sweepEpoch
  let plan: ReturnType<typeof prefetchPlan>
  try { plan = prefetchPlan(results) }
  catch (error) {
    log('WARNING', `Usenet availability prefetch could not read exclusions: ${error instanceof Error ? error.message : 'unknown error'}`)
    plan = prefetchPlan(results, new Set())
  }
  const releases = plan.reduce((total, entry) => total + entry.releases.length, 0)
  if (!releases || !ownsProgress()) return
  const started = Date.now()
  progress = { running: true, checked: 0, total: releases }
  log('INFO', `Usenet availability prefetch started (${releases} releases; ${reason})`)
  let checked = 0
  try {
    for (const entry of plan) {
      if (!ownsProgress()) return
      await Promise.all(entry.releases.map(release => resolveUsenetRelease(config, release, false, true)))
      if (!ownsProgress()) return
      checked += entry.releases.length
      progress = { running: true, checked, total: releases }
    }
    if (!ownsProgress()) return
    log('INFO', `Usenet availability prefetch finished (${checked} releases in ${((Date.now() - started) / 1000).toFixed(0)}s)`)
  } catch {
    if (ownsProgress()) log('WARNING', 'Usenet availability prefetch failed')
  } finally {
    if (ownsProgress()) progress = { running: false, checked: 0, total: 0 }
  }
}

/** Scan-completion hook wired into the default scan service. */
export function prefetchAfterScan(config: Config, results: ResultItem[]): void {
  prefetchUsenetAvailability(config, results, 'scan finished')
}

/** Re-sweep the persisted results after a Usenet-relevant configuration change. */
export function prefetchSavedResults(config: Config): void {
  const saved = loadLastResults()?.results || []
  prefetchUsenetAvailability(config, saved, 'configuration saved')
}
