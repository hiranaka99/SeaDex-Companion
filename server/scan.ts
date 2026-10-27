import { assessSeason } from './assessment.js'
import { beginScan, endScan, getState, setState } from './scan-state.js'
import { scanRequests } from './http.js'
import { log, timestamp, errorMessage } from './logging.js'
import { HISTORY_FILE } from './paths.js'
import { loadCache, loadLastResults, saveLastResults } from './results.js'
import { loadUserRules, libraryItemKey, applyUserRulesToResults } from './user-rules.js'
import { recordScanHistory, type ScanHistoryEntry } from './history.js'
import { seadexBest } from './catalog.js'
import { loadLocalLibrary, arrItemUrl } from './library.js'
import { anilistChain } from './anilist.js'

import { autoNotifyNew } from './notifications.js'
import { unhideNewBestReleases } from './hidden.js'
import type { Config, JsonObject, ScanScope, ScanTrigger, LocalItem, LocalSeason, ResultItem } from './types.js'

export interface ScanDependencies {
  seadexBest?: typeof seadexBest
  localItems?: (config: Config, scope?: ScanScope) => Promise<LocalItem[]>
  anilistChain?: typeof anilistChain
  loadCache?: typeof loadCache
  saveLastResults?: typeof saveLastResults
  autoNotifyNew?: typeof autoNotifyNew
  unhideNewBestReleases?: typeof unhideNewBestReleases
  loadUserRules?: typeof loadUserRules
  recordScanHistory?: (previous: JsonObject[], current: JsonObject[], runAt: string, file?: string, trigger?: ScanTrigger, metadata?: { durationSeconds?: number; scannedTitles?: number; sourceErrors?: Record<string, string>; outcome?: ScanHistoryEntry['outcome']; error?: string }) => ScanHistoryEntry
}

/** Resolve dependencies once; overrides never disable another subsystem. */
export function createScanService(overrides: ScanDependencies = {}) {
  const dependencies = {
    seadexBest, anilistChain, loadCache, saveLastResults, autoNotifyNew, unhideNewBestReleases, loadUserRules, recordScanHistory,
    ...overrides,
    loadLibrary: overrides.localItems ? async (config: Config, scope: ScanScope = {}) => ({ items: await overrides.localItems!(config, scope), sourceErrors: {} }) : loadLocalLibrary,
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
export function runScan(config: Config, dependencies?: ScanDependencies, trigger: ScanTrigger = 'manual', scope: ScanScope = {}): Promise<void> {
  return (dependencies ? createScanService(dependencies) : defaultScanService).run(config, trigger, scope)
}

async function performScan(config: Config, dependencies: Required<Omit<ScanDependencies, 'localItems'>> & { loadLibrary: typeof loadLocalLibrary }, trigger: ScanTrigger, scope: ScanScope, controller: AbortController): Promise<void> {
  const started = Date.now()
  const previousState = getState()
  let stage = 'initializing'
  try {
    const enabledSources = [config.sonarr_url && config.sonarr_key ? 'Sonarr' : '', config.radarr_url && config.radarr_key ? 'Radarr' : ''].filter(Boolean)
    log('INFO', `Scan started (trigger: ${trigger}; sources: ${enabledSources.join(', ') || 'none configured'}; Discord notifications: ${config.notify_enabled && config.webhook ? 'enabled' : 'disabled'})`)
    setState({ running: true, cancelled: false, trigger, source_errors: {}, error: null, progress: 0, total: 0, message: 'Loading SeaDex best releases…' })
    stage = 'loading the SeaDex catalog'
    const best = await dependencies.seadexBest()
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
    const sourceDetails = Object.entries(sourceCounts).map(([source, count]) => `${source}=${count}`).join(', ')
    log('INFO', `Local library loaded: ${items.length} item${items.length === 1 ? '' : 's'}${sourceDetails ? ` (${sourceDetails})` : ''}`)
    setState({ total: items.length })
    const cache = dependencies.loadCache()
    const previousResults = (previousState.results.length ? previousState.results : loadLastResults()?.results || [])
    const rules = dependencies.loadUserRules()
    const scopedKeys = new Set([...(scope.sonarrIds || []).map((id) => `Sonarr:item${id}`), ...(scope.radarrIds || []).map((id) => `Radarr:item${id}`)])
    const retainedResults = previousResults.filter((result) => {
      const source = String(result.arr || '')
      if (sourceErrors[source]) return true
      if (scopedKeys.size > 0) return !scopedKeys.has(String(result.library_key || ''))
      return !['Sonarr', 'Radarr'].includes(source)
    })
    const results: ResultItem[] = []
    stage = 'resolving library titles'
    for (const [itemIndex, item] of items.entries()) {
      if (controller.signal.aborted) throw new DOMException('Scan cancelled', 'AbortError')
      setState({ progress: itemIndex, message: `Resolving: ${item.title}` })
      const arrUrl = arrItemUrl(config, item)
      const libraryKey = libraryItemKey(item)
      const mappingId = rules.mappings[libraryKey]
      const chain = await dependencies.anilistChain(item.title, cache, {}, mappingId)
      const seasonEntries = Object.entries(item.seasons).map(([season, local]) => [Number(season), local as LocalSeason] as const).sort(([a], [b]) => a - b)
      if (!chain.length) {
        log('WARNING', `${mappingId ? `Manual AniList override ${mappingId} produced no match for` : 'No AniList match for'}: ${item.title}`)
        for (const [season, local] of seasonEntries) results.push({
          key: `${item.arr}:item${item.id}:${season}:missing`, group_id: null, arr: item.arr, title: item.title,
          library_key: libraryKey, mapping_override: Boolean(mappingId),
          season, status: 'missing', have: [...local.groups].sort(), local_size: local.size || 0,
          match_status: 'unmatched', missing_episode_count: local.missing_episode_count,
          best_group: null, best_size: 0, releases: [], url: null, notes: null, image: null,
          banner: null, anilist_id: null, arr_url: arrUrl,
        })
        setState({ progress: itemIndex + 1, results: [...retainedResults, ...results] })
        continue
      }
      for (const [season, local] of seasonEntries) {
        setState({ message: `Resolving: ${item.title} (${season ? `S${String(season).padStart(2, '0')}` : 'Movie'})` })
        results.push(assessSeason(item, season, local, chain, best, libraryKey, mappingId, arrUrl))
      }
      setState({ progress: itemIndex + 1, results: [...retainedResults, ...results] })
    }
    if (controller.signal.aborted) throw new DOMException('Scan cancelled', 'AbortError')
    const lastRun = timestamp()
    const finalResults = applyUserRulesToResults([...retainedResults, ...results], rules)
    setState({ progress: items.length, message: Object.keys(sourceErrors).length ? 'Done with integration errors' : 'Done', results: finalResults, last_run: lastRun, source_errors: sourceErrors })
    stage = 'saving scan results'
    ;dependencies.saveLastResults(finalResults, lastRun)
    try { dependencies.unhideNewBestReleases(previousResults, finalResults) }
    catch (error) { log('WARNING', `Could not restore hidden anime with new best releases: ${errorMessage(error)}`) }
    try {
      const metadata = { durationSeconds: Math.round((Date.now() - started) / 100) / 10, scannedTitles: items.length, sourceErrors }
      dependencies.recordScanHistory(previousResults, finalResults, lastRun, HISTORY_FILE, trigger, metadata)
    } catch (error) {
      log('WARNING', `Could not save scan history: ${errorMessage(error)}`)
    }
    stage = 'sending notifications'
    if (!Object.keys(sourceErrors).length) {
      try { await dependencies.autoNotifyNew(config, { previous: previousResults }) }
      catch (error) { log('WARNING', `Scan results were saved, but notifications ${controller.signal.aborted ? 'were cancelled' : `failed: ${errorMessage(error)}`}`) }
    }
    else log('WARNING', `Notifications skipped after partial scan: ${Object.keys(sourceErrors).join(', ')} unavailable`)
    const statusCounts = finalResults.reduce<Record<string, number>>((counts, result) => {
      const status = String(result.status || 'unknown')
      counts[status] = (counts[status] || 0) + 1
      return counts
    }, {})
    const statusDetails = ['upgrade', 'best', 'partial', 'missing', 'uncovered']
      .filter((status) => statusCounts[status])
      .map((status) => `${statusCounts[status]} ${status}`)
      .join(', ')
    log('INFO', `Scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ${finalResults.length} result${finalResults.length === 1 ? '' : 's'}${statusDetails ? ` (${statusDetails})` : ''}`)
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
      try { dependencies.recordScanHistory(previousState.results, previousState.results, timestamp(), HISTORY_FILE, trigger, { durationSeconds: Math.round((Date.now() - started) / 100) / 10, scannedTitles: 0, outcome, error: cancelled ? 'Cancelled by user' : message }) }
      catch (historyError) { log('WARNING', `Could not save failed scan history: ${errorMessage(historyError)}`) }
    }
  } finally {
    endScan(controller)
    setState({ running: false })
  }
}
