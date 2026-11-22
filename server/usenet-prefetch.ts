import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import { loadLastResults } from './results.js'
import { resolveUsenetRelease, sabnzbdConfigured, usenetProvidersEnabled } from './usenet.js'
import type { Config, ResultItem } from './types.js'

/**
 * Background Usenet availability prefetch. After each scan (and at startup or
 * config changes) the saved results are walked once at background priority so
 * opening a card or reviewing a plan hits a warm cache. All provider traffic
 * goes through the resolver's cache and per-provider rate limiter; a sweep is
 * superseded by the next one or by any configuration change.
 */

let enabled = false
let sweepEpoch = 0
let progress = { running: false, checked: 0, total: 0 }
let progressGeneration = currentGeneration()

/** Live progress of the background availability sweep, for the sidebar. */
export function usenetPrefetchProgress(): { running: boolean; checked: number; total: number } {
  return progress.running && progressGeneration === currentGeneration() ? { ...progress } : { running: false, checked: 0, total: 0 }
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

/** Starts a background sweep over the saved results; any running sweep is superseded. */
export function prefetchUsenetAvailability(config: Config, results: ResultItem[], reason: string): void {
  const epoch = ++sweepEpoch
  progress = { running: false, checked: 0, total: 0 }
  progressGeneration = currentGeneration()
  if (!enabled || !usenetPrefetchEligible(config)) return
  void runSweep(epoch, progressGeneration, config, results, reason)
}

/** Cancels any running sweep (scanned data cleared). */
export function stopUsenetPrefetch(): void {
  sweepEpoch++
  progress = { running: false, checked: 0, total: 0 }
  progressGeneration = currentGeneration()
}

async function runSweep(epoch: number, generation: number, config: Config, results: ResultItem[], reason: string): Promise<void> {
  const ownsProgress = () => epoch === sweepEpoch && currentGeneration() === generation
  const releases = results.reduce((total, result) => total + (result.releases?.length || 0), 0)
  if (!releases || !ownsProgress()) return
  const started = Date.now()
  progress = { running: true, checked: 0, total: releases }
  log('INFO', `Usenet availability prefetch started (${releases} releases; ${reason})`)
  let checked = 0
  try {
    for (const result of results) {
      if (!ownsProgress()) return
      const rows = result.releases || []
      if (!rows.length) continue
      await Promise.all(rows.map(release => resolveUsenetRelease(config, release, false, true)))
      if (!ownsProgress()) return
      checked += rows.length
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

/** Re-sweep the persisted results after a configuration change. */
export function prefetchSavedResults(config: Config): void {
  const saved = loadLastResults()?.results || []
  prefetchUsenetAvailability(config, saved, 'configuration saved')
}
