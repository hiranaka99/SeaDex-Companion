import { seasonTag } from '../shared/ids.js'
import { errorMessage } from '../shared/errors.js'
import { assessSeason, resolveSeasonChainEntry, type AssessmentSettings } from './assessment.js'
import { beginScan, endScan, getState, setNormalizedResults, setState } from './scan-state.js'
import { scanRequests } from './http.js'
import { log, timestamp } from './logging.js'
import { HISTORY_FILE } from './paths.js'
import { flushCache, loadCache, loadLastResults, saveLastResults } from './results.js'
import { normalizeResults } from './result-model.js'
import { loadUserRules, libraryItemKey, seasonMappingKey, applyUserRulesToResults } from './user-rules.js'
import { previousResultMatcher, recordScanHistory } from './history.js'
import { seadexBest } from './catalog.js'
import { loadLocalLibrary, arrItemUrl, isScopedScan, scopeIds, type LibraryLoad } from './library.js'
import { anilistChain, anilistSeason } from './anilist.js'

import { autoNotifyNew } from './notifications.js'
import { readLedger, usenetRuntime } from './usenet-runtime.js'
import { syncArrTags } from './arr-tags.js'
import { settleImports } from './import-follow.js'
import { arrInstances, configuredArrInstances, instanceSourceKey, sourceNameOf } from '../shared/arr-instances.js'
import { isDownloadable } from './matching.js'
import { prowlarrIndexers, prowlarrSettings, trackerIndexers, type ProwlarrSettings } from './prowlarr.js'
import { describeRegression } from '../shared/release-changes.js'
import { DEFAULT_RELEASE_PREFERENCES, normalizeReleasePreferences, normalizeTrackerMode } from '../shared/settings.js'
import type { Config, ScanScope, ScanTrigger, LocalItem, ResultItem, SeaDexEntry } from './types.js'

const trackerKeys = (trackers: readonly string[]): string[] =>
  [...new Set(trackers.map(tracker => tracker.trim().toLowerCase()).filter(Boolean))].sort()

/**
 * Identifies the settings a season is judged under; results computed under another signature are not comparable.
 * Reachable-tracker mode is also judged by the private trackers Prowlarr covers, so they are part of its signature.
 */
export function assessmentSignature(
  config: Pick<Config, 'release_preferences' | 'verify_release_files'> & Partial<Pick<Config, 'tracker_mode'>>,
  coveredTrackers: readonly string[] = [],
): string {
  const trackers = normalizeTrackerMode(config.tracker_mode)
  return JSON.stringify([
    normalizeReleasePreferences(config.release_preferences),
    config.verify_release_files !== false,
    // Results from before tracker modes listed every tracker, so private mode adds nothing to the signature.
    ...(trackers === 'public'
      ? ['public']
      : trackers === 'reachable'
        ? ['reachable', trackerKeys(coveredTrackers)]
        : []),
  ])
}

/** The covered trackers a reachable-mode signature was computed with; none for any other signature. */
function signatureCoverage(signature: string | undefined): string[] {
  try {
    const parts: unknown = JSON.parse(signature || 'null')
    if (Array.isArray(parts) && parts[2] === 'reachable' && Array.isArray(parts[3]))
      return parts[3].filter((tracker): tracker is string => typeof tracker === 'string')
  } catch {
    /* an unreadable signature covers nothing */
  }
  return []
}
/** What results saved without a signature were judged under: default preferences across every tracker. */
const DEFAULT_ASSESSMENT_SIGNATURE = assessmentSignature({
  release_preferences: DEFAULT_RELEASE_PREFERENCES,
  verify_release_files: true,
  tracker_mode: 'private',
})

/** Identifies which libraries, and which part of each, a scan covers. */
export function librarySignature(config: Config): string {
  return JSON.stringify(configuredArrInstances(config).map(instance => [instance.id, instance.url, instance.scope]))
}

/** True when scope, preference, or verification settings changed since the saved results were computed. */
export function resultSettingsChanged(
  config: Config,
  saved: { count: number; settings?: { assessment?: string; library?: string } },
): boolean {
  if (!saved.count) return false
  const assessment = saved.settings?.assessment ?? DEFAULT_ASSESSMENT_SIGNATURE
  // Only a scan reads what Prowlarr covers, so the saved coverage stands in for it here.
  if (assessment !== assessmentSignature(config, signatureCoverage(assessment))) return true
  return saved.settings?.library !== undefined && saved.settings.library !== librarySignature(config)
}

// Scans of single titles (webhooks, import checks) reuse a recent catalog instead of downloading it again.
const CATALOG_REUSE_MS = 15 * 60_000
let recentCatalog: { loadedAt: number; catalog: Map<number, SeaDexEntry> } | null = null
let catalogExpiry: NodeJS.Timeout | undefined
async function loadCatalog(load: typeof seadexBest, reuse: boolean): Promise<Map<number, SeaDexEntry>> {
  if (load !== seadexBest) return load()
  if (reuse && recentCatalog && Date.now() - recentCatalog.loadedAt < CATALOG_REUSE_MS) return recentCatalog.catalog
  const catalog = await load()
  recentCatalog = { loadedAt: Date.now(), catalog }
  clearTimeout(catalogExpiry)
  catalogExpiry = setTimeout(() => {
    recentCatalog = null
  }, CATALOG_REUSE_MS)
  catalogExpiry.unref?.()
  return catalog
}

/**
 * The private trackers of the catalog that Prowlarr has a torrent indexer for, which reachable-tracker mode
 * judges against. When Prowlarr cannot be read, the coverage of the saved results stands, so the scan stays
 * comparable with them instead of failing or becoming a baseline.
 */
async function readCoveredTrackers(
  settings: ProwlarrSettings,
  catalog: Map<number, SeaDexEntry>,
  listIndexers: typeof prowlarrIndexers,
  options: { fresh: boolean; signal: AbortSignal; savedSignature: string | undefined },
): Promise<string[]> {
  const privateTrackers = new Set<string>()
  for (const entry of catalog.values())
    for (const slot of Object.values(entry.seasons || {}))
      for (const candidate of slot.candidates || [])
        if (candidate.tracker && !isDownloadable(candidate)) privateTrackers.add(candidate.tracker)
  try {
    const indexers = await listIndexers({ ...settings, signal: options.signal }, undefined, options.fresh)
    return trackerKeys([...privateTrackers].filter(tracker => trackerIndexers(indexers, tracker).length > 0))
  } catch (error) {
    if (options.signal.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    log(
      'WARNING',
      `Prowlarr's indexers could not be read (${errorMessage(error)}). This scan uses the trackers Prowlarr covered at the last scan.`,
    )
    return signatureCoverage(options.savedSignature)
  }
}

export interface ScanDependencies {
  seadexBest?: typeof seadexBest
  localItems?: (config: Config, scope?: ScanScope) => Promise<LocalItem[]>
  anilistChain?: typeof anilistChain
  anilistSeason?: typeof anilistSeason
  loadCache?: typeof loadCache
  saveLastResults?: typeof saveLastResults
  autoNotifyNew?: typeof autoNotifyNew
  loadUserRules?: typeof loadUserRules
  onScanFinished?: (config: Config, results: ResultItem[]) => void
  /** Writes status tags back to Sonarr and Radarr when that is enabled. */
  syncArrTags?: typeof syncArrTags
  /** Lets finished downloads learn from the new results whether they were imported. */
  settleImports?: typeof settleImports
  recordScanHistory?: typeof recordScanHistory
  /** Lists Prowlarr's indexers, which decide the private trackers reachable-tracker mode can target. */
  prowlarrIndexers?: typeof prowlarrIndexers
}

/** Resolve dependencies once; overrides never disable another subsystem. */
export function createScanService(overrides: ScanDependencies = {}) {
  const dependencies = {
    seadexBest,
    anilistChain,
    anilistSeason,
    loadCache,
    saveLastResults,
    autoNotifyNew,
    loadUserRules,
    recordScanHistory,
    prowlarrIndexers,
    onScanFinished: (config: Config, results: ResultItem[]) =>
      usenetRuntime().resultsChanged(config, results, readLedger(), 'scan finished'),
    syncArrTags,
    settleImports,
    ...overrides,
    loadLibrary: overrides.localItems
      ? async (config: Config, scope: ScanScope = {}): Promise<LibraryLoad> => ({
          items: await overrides.localItems!(config, scope),
          sourceErrors: {},
          outOfScope: [],
        })
      : loadLocalLibrary,
  }
  return {
    async run(config: Config, trigger: ScanTrigger = 'manual', scope: ScanScope = {}): Promise<void> {
      const controller = new AbortController()
      if (!beginScan(controller)) throw new Error('Scan already running')
      return scanRequests.run(controller.signal, () => performScan(config, dependencies, trigger, scope, controller))
    },
  }
}
const defaultScanService = createScanService()
/** Runs a scan with the production dependencies. */
export function runScan(config: Config, trigger: ScanTrigger = 'manual', scope: ScanScope = {}): Promise<void> {
  return defaultScanService.run(config, trigger, scope)
}

async function performScan(
  config: Config,
  dependencies: Required<Omit<ScanDependencies, 'localItems'>> & { loadLibrary: typeof loadLocalLibrary },
  trigger: ScanTrigger,
  scope: ScanScope,
  controller: AbortController,
): Promise<void> {
  const started = Date.now()
  const previousState = getState()
  let stage = 'initializing'
  try {
    const instances = configuredArrInstances(config)
    const enabledSources = instances.map(instance => instance.name)
    const scoped = isScopedScan(scope)
    log(
      'INFO',
      `Scan started (trigger: ${trigger}; sources: ${enabledSources.join(', ') || 'none configured'}; Discord notifications: ${config.notify_enabled && config.webhook ? 'enabled' : 'disabled'})`,
    )
    setState({
      running: true,
      cancelled: false,
      trigger,
      source_errors: {},
      error: null,
      progress: 0,
      total: 0,
      message: 'Loading SeaDex best releases…',
    })
    stage = 'loading the SeaDex catalog'
    const best = await loadCatalog(dependencies.seadexBest, scoped)
    log('INFO', `SeaDex catalog loaded: ${best.size} best-release entr${best.size === 1 ? 'y' : 'ies'}`)
    setState({ message: 'Loading local library…' })
    stage = 'loading the Sonarr/Radarr library'
    const loaded = await dependencies.loadLibrary(config, scope)
    const items = loaded.items
    const sourceErrors = loaded.sourceErrors
    const sourceCounts = items.reduce<Record<string, number>>((counts, item) => {
      const source = String(item.arr || 'Unknown')
      counts[source] = (counts[source] || 0) + 1
      return counts
    }, {})
    const sourceDetails = Object.entries(sourceCounts)
      .map(([source, count]) => `${source}=${count}`)
      .join(', ')
    log(
      'INFO',
      `Local library loaded: ${items.length} item${items.length === 1 ? '' : 's'}${sourceDetails ? ` (${sourceDetails})` : ''}`,
    )
    setState({ total: items.length })
    const cache = dependencies.loadCache()
    const saved = loadLastResults()
    const previousResults = previousState.results.length ? previousState.results : saved?.results || []
    const rules = dependencies.loadUserRules()
    const trackers = normalizeTrackerMode(config.tracker_mode)
    // Reachable-tracker mode judges against what Prowlarr covers now. A scan of single titles accepts a recent list.
    const prowlarr = trackers === 'reachable' ? prowlarrSettings(config) : null
    let coveredTrackers: string[] = []
    if (prowlarr) {
      stage = 'reading the Prowlarr indexers'
      setState({ message: 'Checking which trackers Prowlarr can reach…' })
      coveredTrackers = await readCoveredTrackers(prowlarr, best, dependencies.prowlarrIndexers, {
        fresh: !scoped,
        signal: controller.signal,
        savedSignature: saved?.settings?.assessment,
      })
      log('INFO', `Private trackers Prowlarr can reach: ${coveredTrackers.join(', ') || 'none'}`)
    }
    const settings: AssessmentSettings = {
      preferences: normalizeReleasePreferences(config.release_preferences),
      verify: config.verify_release_files !== false,
      trackers,
      coveredTrackers,
    }
    const signatures = {
      assessment: assessmentSignature(config, coveredTrackers),
      library: librarySignature(config),
    }
    // Results judged under other preferences are a new baseline: their differences are neither SeaDex changes nor regressions.
    const settingsChanged =
      previousResults.length > 0 &&
      (saved?.settings?.assessment ?? DEFAULT_ASSESSMENT_SIGNATURE) !== signatures.assessment
    // Reuse saved title matches and sequel IDs to refresh the library in batches.
    // Unknown titles still go through the normal title matching rules.
    const prefetchIds: number[] = []
    for (const item of items) {
      const libraryKey = libraryItemKey(item)
      let needsAutomatic = false
      for (const season of Object.keys(item.seasons).map(Number)) {
        const ids = rules.season_mappings?.[seasonMappingKey(libraryKey, season)]
        if (ids) prefetchIds.push(...ids)
        else needsAutomatic = true
      }
      if (!needsAutomatic) continue
      const id = rules.mappings[libraryKey] || cache[`lookup:v3:${item.title}`]?.id
      if (!id) continue
      prefetchIds.push(id)
      const chain = cache[`chain:v8:${id}`]?.chain
      if (Array.isArray(chain)) for (const entry of chain) prefetchIds.push(...(entry.ids || [entry.id]))
    }
    // Scope IDs name an instance whether or not it is configured in this process.
    const scopedKeys = new Set(
      arrInstances(config).flatMap(instance =>
        (scopeIds(scope, instance) || []).map(id => `${instanceSourceKey(instance)}:item${id}`),
      ),
    )
    const retainedResults = previousResults.filter(result => {
      if (sourceErrors[sourceNameOf(result)]) return true
      if (scopedKeys.size > 0) return !scopedKeys.has(String(result.library_key || ''))
      return !['Sonarr', 'Radarr'].includes(String(result.arr || ''))
    })
    const results: ResultItem[] = []
    // The snapshot shown while scanning; each title's seasons are normalized once, as they are added.
    let published = normalizeResults(retainedResults)
    stage = 'resolving library titles'
    for (const [itemIndex, item] of items.entries()) {
      if (controller.signal.aborted) throw new DOMException('Scan cancelled', 'AbortError')
      const firstResult = results.length
      setState({ progress: itemIndex, message: `Resolving: ${item.title}` })
      const arrUrl = arrItemUrl(config, item)
      const libraryKey = libraryItemKey(item)
      const mappingId = rules.mappings[libraryKey]
      const seasonEntries = Object.entries(item.seasons)
        .map(([season, local]) => [Number(season), local] as const)
        .sort(([a], [b]) => a - b)
      const requiredSeasons = seasonEntries
        .filter(([season]) => !rules.season_mappings?.[seasonMappingKey(libraryKey, season)])
        .map(([season]) => season)
      const chain = requiredSeasons.length
        ? await dependencies.anilistChain(item.title, cache, { prefetchIds }, mappingId, { requiredSeasons })
        : []
      const automaticGroupId = chain[0]?.id
      if (requiredSeasons.length && !chain.length) {
        log(
          'WARNING',
          `${mappingId ? `Manual AniList override ${mappingId} produced no match for` : 'No AniList match for'}: ${item.title}`,
        )
      }
      const overrides = new Map<number, Awaited<ReturnType<typeof anilistSeason>>>()
      for (const [season] of seasonEntries) {
        const ids = rules.season_mappings?.[seasonMappingKey(libraryKey, season)]
        if (ids) overrides.set(season, await dependencies.anilistSeason(ids, cache, { prefetchIds }))
      }
      // Full manual coverage needs no title search or sequel traversal. Preserve
      // continuous-entry episode offsets using the selected entries themselves.
      if (!requiredSeasons.length && [...overrides.values()].every(entry => entry)) {
        const selected: typeof chain = []
        for (const entry of overrides.values()) {
          if (entry && entry.ids.join(',') !== selected.at(-1)?.ids.join(','))
            selected.push({ ...entry, season: selected.length + 1 })
        }
        // Apply inferred offsets only when every inferred match agrees with the
        // explicit choices. Unrelated manual entries must never form a split.
        if (
          seasonEntries.every(
            ([season]) =>
              resolveSeasonChainEntry(item, season, selected).entry?.ids.join(',') ===
              overrides.get(season)?.ids.join(','),
          )
        )
          chain.push(...selected)
      }
      const groupId =
        automaticGroupId ??
        mappingId ??
        cache[`lookup:v3:${item.title}`]?.id ??
        [...overrides.values()].find(entry => entry)?.id ??
        null
      for (const [season, local] of seasonEntries) {
        setState({ message: `Resolving: ${item.title} (${season ? `${seasonTag(season)}` : 'Movie'})` })
        const override = overrides.has(season)
          ? {
              entry: overrides.get(season)!,
              groupId,
              ids: rules.season_mappings![seasonMappingKey(libraryKey, season)],
            }
          : undefined
        const result = assessSeason({
          item,
          season,
          local,
          chain,
          best,
          libraryKey,
          mappingId,
          arrUrl,
          override,
          settings,
        })
        result.group_id = groupId
        results.push(result)
      }
      published = [...published, ...normalizeResults(results.slice(firstResult))]
      setNormalizedResults(published, { progress: itemIndex + 1 })
    }
    if (controller.signal.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    const lastRun = timestamp()
    // Compare and persist the same normalized snapshot used by scan state.
    // Raw catalog hashes can include private-tracker placeholders or unselected torrents.
    const finalResults = normalizeResults(applyUserRulesToResults([...retainedResults, ...results], rules))
    setState({
      progress: items.length,
      message: Object.keys(sourceErrors).length ? 'Done with integration errors' : 'Done',
      results: finalResults,
      last_run: lastRun,
      source_errors: sourceErrors,
    })
    stage = 'saving scan results'
    // A scan of single titles leaves the other results as they were judged, so the saved signatures stay.
    const resultSettings = scoped ? saved?.settings : signatures
    dependencies.saveLastResults(finalResults, lastRun, {
      baseline: settingsChanged,
      ...(resultSettings ? { settings: resultSettings } : {}),
    })
    try {
      dependencies.onScanFinished(config, finalResults)
    } catch (error) {
      log('WARNING', `Usenet prefetch after scan could not start: ${errorMessage(error)}`)
    }
    try {
      dependencies.settleImports(finalResults)
    } catch (error) {
      log('WARNING', `Could not update import tracking: ${errorMessage(error)}`)
    }
    try {
      const metadata = {
        durationSeconds: Math.round((Date.now() - started) / 100) / 10,
        scannedTitles: items.length,
        sourceErrors,
        settingsChanged,
      }
      dependencies.recordScanHistory(previousResults, finalResults, lastRun, HISTORY_FILE, trigger, metadata)
    } catch (error) {
      log('WARNING', `Could not save scan history: ${errorMessage(error)}`)
    }
    stage = 'writing status tags'
    try {
      await dependencies.syncArrTags(config, {
        items,
        outOfScope: loaded.outOfScope,
        results: finalResults,
        sourceErrors,
      })
    } catch (error) {
      log(
        'WARNING',
        `Status tags ${controller.signal.aborted ? 'were cancelled' : `could not be written: ${errorMessage(error)}`}`,
      )
    }
    stage = 'sending notifications'
    if (!Object.keys(sourceErrors).length) {
      const regressions: Record<string, string> = {}
      if (!settingsChanged) {
        const previousOf = previousResultMatcher(previousResults)
        for (const result of finalResults) {
          const old = previousOf(result)
          const regression = old ? describeRegression(old, result) : null
          if (regression) regressions[result.key] = regression.description
        }
      }
      try {
        await dependencies.autoNotifyNew(config, { previous: previousResults, regressions })
      } catch (error) {
        log(
          'WARNING',
          `Scan results were saved, but notifications ${controller.signal.aborted ? 'were cancelled' : `failed: ${errorMessage(error)}`}`,
        )
      }
    } else
      log('WARNING', `Notifications skipped after partial scan: ${Object.keys(sourceErrors).join(', ')} unavailable`)
    const statusCounts = finalResults.reduce<Record<string, number>>((counts, result) => {
      const status = String(result.status || 'unknown')
      counts[status] = (counts[status] || 0) + 1
      return counts
    }, {})
    const statusDetails = ['upgrade', 'best', 'partial', 'missing', 'uncovered']
      .filter(status => statusCounts[status])
      .map(status => `${statusCounts[status]} ${status}`)
      .join(', ')
    log(
      'INFO',
      `Scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ${finalResults.length} result${finalResults.length === 1 ? '' : 's'}${statusDetails ? ` (${statusDetails})` : ''}`,
    )
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    const message = errorMessage(error)
    const outcome = cancelled ? 'cancelled' : 'failed'
    if (cancelled) {
      log('INFO', `Scan cancelled while ${stage} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
      setState({ ...previousState, running: true, cancelled: true, error: null, message: 'Scan cancelled' })
    } else {
      log('ERROR', `Scan failed while ${stage} after ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`)
      setState({ ...previousState, running: true, cancelled: false, error: message })
    }
    {
      try {
        dependencies.recordScanHistory(
          previousState.results,
          previousState.results,
          timestamp(),
          HISTORY_FILE,
          trigger,
          {
            durationSeconds: Math.round((Date.now() - started) / 100) / 10,
            scannedTitles: 0,
            outcome,
            error: cancelled ? 'Cancelled by user' : message,
          },
        )
      } catch (historyError) {
        log('WARNING', `Could not save failed scan history: ${errorMessage(historyError)}`)
      }
    }
  } finally {
    try {
      // Metadata fetched by this scan is kept however the scan ended.
      flushCache()
    } catch (error) {
      log('WARNING', `AniList cache could not be saved: ${errorMessage(error)}`)
    }
    endScan(controller)
    setState({ running: false })
  }
}
