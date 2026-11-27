// The Usenet runtime: builds the hash-indexer lookups (their scheduler and cache), the Prowlarr finder (its
// scheduler and search store), the Prowlarr indexer list, the private torrent cache and the background sweep,
// and keeps them up to date. It reacts to four events only: it is created fresh, the configuration changed,
// the results changed, and the server shuts down. Which settings invalidate what, in which order, and which
// sources the stores keep are decided here and nowhere else.

import { downloadRecords, type OwnedDownloadRecord } from './download-store.js'
import { log } from './logging.js'
import { invalidatePrivateSources, privateTorrentCache, usePrivateTorrentCache } from './private-sources.js'
import { prowlarrIndexerList, resetProwlarrRuntime, useProwlarrIndexerList } from './prowlarr.js'
import { loadLastResults } from './results.js'
import { torrentHashes } from '../shared/download-plan.js'
import type { Config, ResultItem } from './types.js'
import {
  flushUsenetCache,
  hashLookupParts,
  invalidateUsenetLookups,
  retainUsenetHashes,
  useHashLookupParts,
  usenetScheduler,
} from './usenet.js'
import { startUsenetSweep, stopUsenetPrefetch, useSweepParts, usenetSweepEnabled } from './usenet-prefetch.js'
import { USENET_PROVIDERS } from './usenet-providers.js'
import type { LookupPacing, LookupScheduler } from './usenet-scheduler.js'
import {
  flushUsenetSearch,
  invalidateUsenetSearch,
  retainSearchSources,
  searchParts,
  searchScheduler,
  searchStore,
  useSearchParts,
} from './usenet-search.js'
import type { UsenetSearchStore } from './usenet-search-store.js'

/** Settings that change which hash indexer answers lookups. */
const HASH_INDEXER_KEYS = Object.values(USENET_PROVIDERS).flatMap(provider => provider.configKeys)
/**
 * Settings that change which Prowlarr answers searches. The two daily limits are not among them: a changed
 * limit applies to the next search or fetch and invalidates nothing.
 */
const PROWLARR_KEYS = ['prowlarr_enabled', 'prowlarr_url', 'prowlarr_key'] as const
/**
 * Settings that only decide whether the background sweep runs and what its search stage looks for. A changed
 * search limit restarts the sweep so it applies at once; it invalidates nothing.
 */
const USENET_ELIGIBILITY_KEYS = [
  'download_mode',
  'sabnzbd_url',
  'sabnzbd_key',
  'prowlarr_background_search',
  'prowlarr_search_limit',
  'tracker_mode',
] as const

export interface UsenetRuntimeOptions {
  /** The clock every lifetime, pacing interval, pause and usage counter is measured on. */
  now?: () => number
  /** How every request to a hash indexer or to Prowlarr is sent. */
  fetch?: typeof fetch
  /** Where the hash-indexer cache, the search store and the stored NZBs are kept; the data directory by default. */
  paths?: { cache?: string; search?: string; nzbs?: string }
  /** Pacing of the hash indexers and of Prowlarr's indexers over the defaults. */
  pacing?: { hashes?: Partial<LookupPacing>; search?: Partial<LookupPacing> }
  /** Background sweeps run. Only the real server switches them on. */
  sweep?: boolean
}

export interface UsenetRuntime {
  readonly hashScheduler: LookupScheduler
  readonly searchScheduler: LookupScheduler
  readonly searchStore: UsenetSearchStore
  /**
   * The configuration changed from `previous` to `config`; without `previous` the server is starting. Only
   * changed hash-indexer or Prowlarr settings invalidate anything, and those or a changed Usenet eligibility
   * setting sweep the saved results again. An unrelated change cancels nothing.
   */
  configChanged(previous: Config | undefined, config: Config): void
  /**
   * New results: the stores keep only what they or an active ledger record still name, and a sweep over the
   * results supersedes any running one. Pass `undefined` for a ledger that could not be read: then no search
   * record is dropped.
   */
  resultsChanged(
    config: Config,
    results: ResultItem[],
    ledger: readonly OwnedDownloadRecord[] | undefined,
    reason: string,
  ): void
  /** Stops the sweep and writes what is pending, for a graceful shutdown. False when a write failed. */
  shutdown(): boolean
}

/**
 * A ledger record is active until it is removed or settled. Settled is imported by Sonarr or Radarr, or, for
 * a download nobody follows an import for, finished in its client. Anything else may still need its search
 * record: a download that ends up not imported rejects the candidate it was sent for.
 */
function activeRecord(record: OwnedDownloadRecord): boolean {
  if (record.removed_at) return false
  if (record.import) return record.import.state !== 'imported'
  return record.last_phase !== 'complete' && record.last_phase !== 'seeding'
}

/**
 * The retention rule. The hash-indexer cache keeps the hashes the results reference. The search store keeps
 * those hashes, the results' private sources, and the source and source alias of each active ledger record.
 */
function liveSources(
  results: ResultItem[],
  ledger: readonly OwnedDownloadRecord[] | undefined,
): { hashes: Set<string>; sources?: Set<string> } {
  const releases = results.flatMap(result => result.releases || [])
  const hashes = new Set(releases.flatMap(release => torrentHashes(release)))
  if (!ledger) return { hashes }
  const sources = new Set([
    ...hashes,
    ...releases.flatMap(release => (release.private_sources || []).map(source => source.id)),
    ...ledger
      .filter(activeRecord)
      .flatMap(record => [record.source_hash, record.source_alias ?? ''])
      .filter(Boolean),
  ])
  return { hashes, sources }
}

/** The download ledger, or undefined when it cannot be read. */
export function readLedger(): readonly OwnedDownloadRecord[] | undefined {
  try {
    return downloadRecords()
  } catch {
    return undefined
  }
}

class Runtime implements UsenetRuntime {
  get hashScheduler(): LookupScheduler {
    this.assertInUse()
    return usenetScheduler
  }

  get searchScheduler(): LookupScheduler {
    this.assertInUse()
    return searchScheduler
  }

  get searchStore(): UsenetSearchStore {
    this.assertInUse()
    return searchStore
  }

  configChanged(previous: Config | undefined, config: Config): void {
    this.assertInUse()
    const changed = (keys: readonly (keyof Config)[]) => !previous || keys.some(key => previous[key] !== config[key])
    const hashIndexers = changed(HASH_INDEXER_KEYS)
    if (hashIndexers) invalidateUsenetLookups(config)
    const prowlarr = changed(PROWLARR_KEYS)
    if (prowlarr) {
      invalidatePrivateSources()
      // Search results, usage counters and stored NZBs are kept for the configured connection only.
      invalidateUsenetSearch(config)
      resetProwlarrRuntime()
    }
    // A starting server sweeps its saved results once the first interactive lookups had the providers.
    if (!previous) return
    if (hashIndexers || prowlarr || changed(USENET_ELIGIBILITY_KEYS))
      this.resultsChanged(config, loadLastResults()?.results || [], readLedger(), 'configuration saved')
  }

  resultsChanged(
    config: Config,
    results: ResultItem[],
    ledger: readonly OwnedDownloadRecord[] | undefined,
    reason: string,
  ): void {
    this.assertInUse()
    stopUsenetPrefetch()
    if (!usenetSweepEnabled()) return
    this.retain(results, ledger)
    startUsenetSweep(config, results, reason)
  }

  shutdown(): boolean {
    this.assertInUse()
    stopUsenetPrefetch()
    const cacheSaved = flushUsenetCache()
    const searchSaved = flushUsenetSearch()
    return cacheSaved && searchSaved
  }

  /** Prunes both stores by the retention rule. Results that are empty prune nothing. */
  private retain(results: ResultItem[], ledger: readonly OwnedDownloadRecord[] | undefined): void {
    if (!results.length) return
    const { hashes, sources } = liveSources(results, ledger)
    const removed = retainUsenetHashes(hashes)
    if (removed) log('INFO', `Usenet cache dropped ${removed} observation(s) for releases no longer in the results`)
    if (!sources) {
      // Without the ledger nothing tells which records a download still needs.
      log('WARNING', 'Usenet search records were not pruned: the download ledger could not be read')
      return
    }
    const dropped = retainSearchSources(sources)
    if (dropped) log('INFO', `Usenet search store dropped ${dropped} record(s) for releases no longer in the results`)
  }

  private assertInUse(): void {
    if (current !== this) throw new Error('This Usenet runtime was replaced by a newer one')
  }
}

let current: Runtime | undefined

/** The runtime in use: the default one, or the one created last. */
export function usenetRuntime(): UsenetRuntime {
  current ??= new Runtime()
  return current
}

/**
 * Creates a fresh runtime with its own clock, fetch, data paths and pacing, and puts it in use. The runtime it
 * replaces has its work cancelled and can no longer be used.
 */
export function createUsenetRuntime(options: UsenetRuntimeOptions = {}): UsenetRuntime {
  const now = options.now ?? (() => Date.now())
  const send: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const { paths = {}, pacing = {} } = options
  useHashLookupParts(hashLookupParts({ now, fetch: send, cacheFile: paths.cache, pacing: pacing.hashes }))
  useSearchParts(searchParts({ now, fetch: send, searchFile: paths.search, nzbDir: paths.nzbs, pacing: pacing.search }))
  useProwlarrIndexerList(prowlarrIndexerList({ now, fetch: send }))
  usePrivateTorrentCache(privateTorrentCache({ now, fetch: send }))
  useSweepParts({ enabled: options.sweep ?? false, now })
  current = new Runtime()
  return current
}
