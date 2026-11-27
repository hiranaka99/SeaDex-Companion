import { downloadRecords, type OwnedDownloadRecord } from './download-store.js'
import { log } from './logging.js'
import { searchContext } from './private-sources.js'
import {
  ProwlarrError,
  knownProwlarrIndexers,
  prowlarrFingerprint,
  prowlarrIndexers,
  prowlarrSettings,
  type ProwlarrIndexer,
} from './prowlarr.js'
import { loadLastResults } from './results.js'
import { exclusionRuleKey, loadUserRules } from './user-rules.js'
import { torrentHashes } from '../shared/download-plan.js'
import {
  cachedHashState,
  privateUsenetSources,
  prowlarrFallbackSource,
  resolveUsenetRelease,
  retainUsenetHashes,
  sabnzbdConfigured,
  usenetProviderPauses,
  usenetProvidersEnabled,
} from './usenet.js'
import {
  backgroundSearchesSpent,
  resolveSource,
  retainSearchSources,
  searchSnapshot,
  searchStore,
  type UsenetSourceOutcome,
} from './usenet-search.js'
import type { ProwlarrSearchStatus, UsenetPrefetchProgress, UsenetSearchSummary } from '../shared/contracts.js'
import type { UsenetUnitState } from '../shared/usenet-contracts.js'
import type { Config, PrivateSource, Release, ResultItem } from './types.js'

/**
 * Background Usenet availability prefetch. After each scan (and at startup or
 * Usenet-relevant config changes) the saved results are walked once at
 * background priority so opening a card or reviewing a plan hits a warm cache.
 * All provider traffic goes through the resolver's cache, per-provider rate
 * limiter and provider pauses; a sweep is superseded by the next one.
 *
 * Two stages: the hash lookups of every planned release, then, when the
 * background search is switched on, a Prowlarr file-list search of each source
 * the hash indexers cannot provide. The search stage never fetches an NZB.
 */

let enabled = false
let sweepEpoch = 0
const idle = (): UsenetPrefetchProgress => ({ running: false, checked: 0, total: 0 })
let progress = idle()

/** Live progress of the background availability sweep, for the sidebar. */
export function usenetPrefetchProgress(): UsenetPrefetchProgress {
  if (!progress.running) return idle()
  const now = Date.now()
  const paused = usenetProviderPauses().map(pause => ({
    provider: { id: pause.channel, label: pause.label },
    resume_in_seconds: Math.max(1, Math.ceil((pause.until - now) / 1000)),
    rate_limited: pause.reason === 'rate_limited',
  }))
  return {
    ...progress,
    ...(progress.search ? { search: { ...progress.search } } : {}),
    ...(paused.length ? { paused } : {}),
  }
}

/** Prefetch only runs in the real server; tests opt in explicitly. */
export function enableUsenetPrefetch(): void {
  enabled = true
}

/** The hash lookups run with SABnzbd, a download mode that may use Usenet, and a hash indexer. */
export function usenetPrefetchEligible(config: Config): boolean {
  if (config.download_mode === 'torrent_only' || !sabnzbdConfigured(config)) return false
  const providers = usenetProvidersEnabled(config)
  return providers.animetosho || providers.amenzb
}

/**
 * The search stage runs when switched on, with SABnzbd, a download mode that may use Usenet, and Prowlarr. It
 * needs no hash indexer, because private-tracker releases have no hash. Whether Prowlarr has a Usenet indexer
 * is read when the sweep starts.
 */
export function usenetSearchSweepEligible(config: Config): boolean {
  return (
    config.prowlarr_background_search &&
    config.download_mode !== 'torrent_only' &&
    sabnzbdConfigured(config) &&
    prowlarrSettings(config) !== null
  )
}

/** Results the user is most likely to download from are checked first; owned best releases last. */
const STATUS_PRIORITY: Partial<Record<ResultItem['status'], number>> = { missing: 0, partial: 0, upgrade: 1, best: 3 }
const statusPriority = (result: ResultItem) => STATUS_PRIORITY[result.status] ?? 2

/** Releases the sweep should check, in priority order, without excluded seasons or parts. */
export function prefetchPlan(
  results: ResultItem[],
  exclusions: ReadonlySet<string> = new Set(loadUserRules().exclusions),
): { key: string; releases: Release[] }[] {
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

/** The plan, or without user exclusions when they cannot be read. */
function readablePlan(results: ResultItem[]): ReturnType<typeof prefetchPlan> {
  try {
    return prefetchPlan(results)
  } catch (error) {
    log(
      'WARNING',
      `Usenet availability prefetch could not read exclusions: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return prefetchPlan(results, new Set())
  }
}

interface SearchItem {
  source: PrivateSource
  release: Release
  result: ResultItem | undefined
}

/**
 * The sources of the planned releases a file-list search can look for, in plan order and once each: the
 * private-tracker sources of a release without a hash, and each hash that every enabled hash indexer answered
 * "no NZB" for, when SeaDex lists its files. A failed or still-processing hash lookup never qualifies.
 */
function fileListSources(
  config: Config,
  plan: ReturnType<typeof prefetchPlan>,
  results: ResultItem[],
  hashState: (hash: string) => UsenetUnitState | undefined,
): SearchItem[] {
  const byKey = new Map(results.map(result => [result.key, result]))
  const seen = new Set<string>()
  const items: SearchItem[] = []
  for (const entry of plan) {
    const result = byKey.get(entry.key)
    for (const release of entry.releases) {
      const sources = [
        ...privateUsenetSources(config, release),
        ...torrentHashes(release).flatMap(hash =>
          hashState(hash) === 'no_match' ? (prowlarrFallbackSource(config, release, hash) ?? []) : [],
        ),
      ]
      for (const source of sources) {
        if (seen.has(source.id)) continue
        seen.add(source.id)
        items.push({ source, release, result })
      }
    }
  }
  return items
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
 * Keep cached observations only for hashes the current results still reference, and search records only for
 * the sources they reference or an active download record names.
 */
function pruneCache(results: ResultItem[]): void {
  if (!results.length) return
  const releases = results.flatMap(result => result.releases || [])
  const hashes = new Set(releases.flatMap(release => torrentHashes(release)))
  const removed = retainUsenetHashes(hashes)
  if (removed) log('INFO', `Usenet cache dropped ${removed} observation(s) for releases no longer in the results`)
  let ledger: OwnedDownloadRecord[]
  try {
    ledger = downloadRecords().filter(activeRecord)
  } catch {
    // Without the ledger nothing tells which records a download still needs.
    log('WARNING', 'Usenet search records were not pruned: the download ledger could not be read')
    return
  }
  const sources = new Set([
    ...hashes,
    ...releases.flatMap(release => (release.private_sources || []).map(source => source.id)),
    ...ledger.flatMap(record => [record.source_hash, record.source_alias ?? '']).filter(Boolean),
  ])
  const dropped = retainSearchSources(sources)
  if (dropped) log('INFO', `Usenet search store dropped ${dropped} record(s) for releases no longer in the results`)
}

/** Starts a background sweep over the saved results; any running sweep is superseded. */
export function prefetchUsenetAvailability(config: Config, results: ResultItem[], reason: string): void {
  const epoch = ++sweepEpoch
  progress = idle()
  if (!enabled) return
  pruneCache(results)
  const stages = { hashes: usenetPrefetchEligible(config), search: usenetSearchSweepEligible(config) }
  if (!stages.hashes && !stages.search) return
  void runSweep(epoch, config, results, reason, stages)
}

/** Cancels any running sweep (scanned data cleared). */
export function stopUsenetPrefetch(): void {
  sweepEpoch++
  progress = idle()
}

/** The Usenet indexers in Prowlarr, or why the search stage cannot run. Never rejects. */
async function sweepIndexers(config: Config): Promise<ProwlarrIndexer[] | { error: string }> {
  const settings = prowlarrSettings(config)
  if (!settings) return { error: 'Prowlarr is not set up' }
  try {
    return (await prowlarrIndexers(settings)).filter(indexer => indexer.protocol === 'usenet')
  } catch (error) {
    // The client's own texts never carry an address or the key.
    return { error: error instanceof ProwlarrError ? error.message : 'the indexer list could not be read' }
  }
}

async function runSweep(
  epoch: number,
  config: Config,
  results: ResultItem[],
  reason: string,
  stages: { hashes: boolean; search: boolean },
): Promise<void> {
  const ownsProgress = () => epoch === sweepEpoch
  // Read once, while the hash lookups run.
  const indexers = stages.search ? sweepIndexers(config) : undefined
  const plan = readablePlan(results)
  const releases = plan.reduce((total, entry) => total + entry.releases.length, 0)
  if (!releases || !ownsProgress()) return
  const states = new Map<string, UsenetUnitState>()
  let hashProgress = { checked: 0, total: 0 }
  try {
    if (stages.hashes) {
      const started = Date.now()
      progress = { running: true, checked: 0, total: releases }
      log('INFO', `Usenet availability prefetch started (${releases} releases; ${reason})`)
      let checked = 0
      for (const entry of plan) {
        if (!ownsProgress()) return
        const answers = await Promise.all(
          entry.releases.map(release => resolveUsenetRelease(config, release, false, true)),
        )
        if (!ownsProgress()) return
        for (const answer of answers) for (const hash of answer.hashes) if (hash.hash) states.set(hash.hash, hash.state)
        checked += entry.releases.length
        progress = { running: true, checked, total: releases }
      }
      if (!ownsProgress()) return
      log(
        'INFO',
        `Usenet availability prefetch finished (${checked} releases in ${((Date.now() - started) / 1000).toFixed(0)}s)`,
      )
      hashProgress = { checked, total: releases }
    }
    if (!indexers) return
    const listed = await indexers
    if (!ownsProgress()) return
    if (!Array.isArray(listed)) {
      log('WARNING', `Prowlarr background search skipped: ${listed.error}`)
      return
    }
    if (!listed.length) {
      log('INFO', 'Prowlarr background search skipped: Prowlarr has no Usenet indexer')
      return
    }
    const due = fileListSources(config, plan, results, hash => states.get(hash)).filter(item => {
      const snapshot = searchSnapshot(config, item.source.id)
      return snapshot.stale && !snapshot.running
    })
    if (due.length) await searchStage(ownsProgress, config, due, listed, hashProgress)
  } catch {
    if (ownsProgress()) log('WARNING', 'Usenet availability prefetch failed')
  } finally {
    if (ownsProgress()) progress = idle()
  }
}

type Tally = Omit<UsenetSearchSummary, 'finished_at' | 'queries'>

/** Adds one source's search to the tally. A source no indexer was asked for is only counted when deferred. */
function countOutcome(tally: Tally, outcome: UsenetSourceOutcome): void {
  if (outcome.deferred) tally.deferred++
  const sent = outcome.queries.some(entry => entry.count > 0)
  const { state, candidate_count } = outcome.availability
  if (!sent && (outcome.deferred || state !== 'lookup_failed')) return
  tally.searched++
  if (candidate_count) tally.with_candidates++
  else if (state === 'lookup_failed') tally.failed++
  else tally.without_candidates++
}

/**
 * Searches each due source in turn at background priority, within the daily search limit of each indexer;
 * an indexer at its limit is left out of the search by `resolveSource`. Once every indexer is at its limit
 * the rest is left for a later sweep. A finished stage stores and logs its summary; a superseded one neither.
 */
async function searchStage(
  ownsProgress: () => boolean,
  config: Config,
  due: SearchItem[],
  indexers: ProwlarrIndexer[],
  hashProgress: { checked: number; total: number },
): Promise<void> {
  const report = (checked: number) => {
    progress = { running: true, ...hashProgress, search: { checked, total: due.length } }
  }
  report(0)
  const started = Date.now()
  log('INFO', `Prowlarr background search started (${due.length} release(s); ${indexers.length} Usenet indexer(s))`)
  const tally: Tally = { searched: 0, with_candidates: 0, without_candidates: 0, failed: 0, deferred: 0 }
  const queries = new Map<string, number>()
  for (const [index, item] of due.entries()) {
    if (backgroundSearchesSpent(config, item.source.id, indexers)) {
      tally.deferred += due.length - index
      break
    }
    const outcome = await resolveSource(config, item.source, searchContext(item.result, item.release), {
      background: true,
    })
    // A changed Prowlarr connection cancels the search, and the settings change starts another sweep.
    if (!ownsProgress() || outcome.cancelled) return
    countOutcome(tally, outcome)
    for (const entry of outcome.queries) queries.set(entry.indexer, (queries.get(entry.indexer) ?? 0) + entry.count)
    report(index + 1)
  }
  const settings = prowlarrSettings(config)
  if (!ownsProgress() || !settings) return
  const summary: UsenetSearchSummary = {
    finished_at: new Date(Date.now()).toISOString(),
    ...tally,
    queries: [...queries].map(([indexer, count]) => ({ indexer, count })),
  }
  searchStore.setSummary(summary, prowlarrFingerprint(settings))
  const sent = summary.queries.map(entry => `${entry.indexer} ${entry.count}`).join(', ') || 'none'
  log(
    'INFO',
    `Prowlarr background search finished (${tally.searched} release(s) searched: ${tally.with_candidates} with candidates, ${tally.without_candidates} without, ${tally.failed} failed; ${tally.deferred} deferred by the daily search limit; queries: ${sent}; ${((Date.now() - started) / 1000).toFixed(0)}s)`,
  )
}

/**
 * What a background search of the current results would cost and what the latest one found, for the
 * Prowlarr settings card. Read from memory and the store only: Prowlarr is never waited for, and an indexer
 * list that is not known yet counts no indexer while it is read in the background.
 */
export function usenetSearchStatus(config: Config, results: ResultItem[]): ProwlarrSearchStatus {
  const settings = prowlarrSettings(config)
  if (!settings) return { eligible_sources: 0, pending_sources: 0, usenet_indexers: 0 }
  const indexers = knownProwlarrIndexers(settings)?.filter(indexer => indexer.protocol === 'usenet') ?? []
  const sources = results.length
    ? fileListSources(config, readablePlan(results), results, hash => cachedHashState(config, hash))
    : []
  const summary = searchStore.summary()
  return {
    eligible_sources: sources.length,
    pending_sources: sources.filter(item => searchSnapshot(config, item.source.id).stale).length,
    usenet_indexers: indexers.length,
    ...(summary ? { summary } : {}),
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
