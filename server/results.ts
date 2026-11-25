import { isRecord } from '../shared/guards.js'
import { normalizeResults } from './result-model.js'
import { recordReleaseChanges } from './release-changes.js'
import type { ResultItem } from './types.js'
import type { ScannedDataInfo } from '../shared/contracts.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { CACHE_FILE, RESULTS_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { setState } from './scan-state.js'
import type { JsonObject } from './types.js'

export function loadCache(): JsonObject {
  const cache = readJson<unknown>(CACHE_FILE, {})
  return isRecord(cache) ? (cache as JsonObject) : {}
}
export function saveCache(cache: JsonObject): void {
  writeJsonAtomic(CACHE_FILE, cache, true)
}
/** Signatures of the settings the saved results were computed under. */
export interface ResultSettings {
  assessment?: string
  library?: string
}

export function saveLastResults(
  results: ResultItem[],
  lastRun: string,
  options: { settings?: ResultSettings; baseline?: boolean } = {},
): void {
  const previous = loadLastResults()?.results || []
  recordReleaseChanges(previous, results, undefined, undefined, { baseline: options.baseline })
  savedResults = null
  writeJsonAtomic(RESULTS_FILE, {
    results,
    last_run: lastRun,
    ...(options.settings ? { settings: options.settings } : {}),
  })
}

export interface SavedResults {
  results: ResultItem[]
  last_run: string | null
  settings?: ResultSettings
}

/**
 * The parsed results file, kept until the file changes. Until a scan runs, status polls and every request that
 * reads results fall back to this file, which can take tens of milliseconds to parse and normalize. Like the scan
 * state's results, the returned value is shared and must not be modified.
 */
let savedResults: { stamp: string; value: SavedResults | null } | null = null

function resultsFileStamp(): string {
  try {
    const stat = statSync(RESULTS_FILE)
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

export function loadLastResults(): SavedResults | null {
  // Stamped before reading, so a file replaced during the read is read again next time.
  const stamp = resultsFileStamp()
  if (savedResults?.stamp !== stamp) savedResults = { stamp, value: readLastResults() }
  return savedResults.value
}

function readLastResults(): SavedResults | null {
  const saved = readJson<JsonObject | null>(RESULTS_FILE, null)
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.results)) return null
  const settings =
    saved.settings && typeof saved.settings === 'object' && !Array.isArray(saved.settings)
      ? (saved.settings as JsonObject)
      : null
  return {
    results: normalizeResults(saved.results),
    last_run: typeof saved.last_run === 'string' ? saved.last_run : null,
    ...(settings
      ? {
          settings: {
            ...(typeof settings.assessment === 'string' ? { assessment: settings.assessment } : {}),
            ...(typeof settings.library === 'string' ? { library: settings.library } : {}),
          },
        }
      : {}),
  }
}

/** The settings signatures of the saved results, without normalizing the results themselves. */
export function loadResultSettings(): { count: number; settings?: ResultSettings } {
  const saved = readJson<JsonObject | null>(RESULTS_FILE, null)
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.results)) return { count: 0 }
  const settings =
    saved.settings && typeof saved.settings === 'object' && !Array.isArray(saved.settings)
      ? (saved.settings as JsonObject)
      : null
  return {
    count: saved.results.length,
    ...(settings
      ? {
          settings: {
            ...(typeof settings.assessment === 'string' ? { assessment: settings.assessment } : {}),
            ...(typeof settings.library === 'string' ? { library: settings.library } : {}),
          },
        }
      : {}),
  }
}

export function scannedDataInfo(cacheFile = CACHE_FILE, resultsFile = RESULTS_FILE): ScannedDataInfo {
  let cache: JsonObject = {}
  let saved: JsonObject | null = null
  const cacheExists = existsSync(cacheFile)
  const resultsExists = existsSync(resultsFile)
  let cacheValid = true
  let resultsValid = true
  try {
    if (cacheExists) cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as JsonObject
  } catch {
    cacheValid = false
  }
  try {
    if (resultsExists) saved = JSON.parse(readFileSync(resultsFile, 'utf8')) as JsonObject
  } catch {
    resultsValid = false
  }
  const cacheShapeValid = !cacheExists || (cache !== null && typeof cache === 'object' && !Array.isArray(cache))
  const resultsShapeValid =
    !resultsExists ||
    (saved !== null &&
      typeof saved === 'object' &&
      Array.isArray(saved.results) &&
      (saved.last_run == null || typeof saved.last_run === 'string'))
  return {
    cache_entries: isRecord(cache) ? Object.keys(cache).length : 0,
    results: Array.isArray(saved?.results) ? saved.results.length : 0,
    last_run: typeof saved?.last_run === 'string' ? saved.last_run : null,
    cache_valid: cacheValid && cacheShapeValid,
    results_valid: resultsValid && resultsShapeValid,
  }
}

export function clearScannedData(
  cacheFile = CACHE_FILE,
  resultsFile = RESULTS_FILE,
): { cacheEntries: number; results: number } {
  const info = scannedDataInfo(cacheFile, resultsFile)
  savedResults = null
  writeJsonAtomic(cacheFile, {}, true)
  writeJsonAtomic(resultsFile, { results: [], last_run: null }, true)
  setState({ progress: 0, total: 0, message: 'Idle', results: [], error: null, last_run: null })
  return { cacheEntries: info.cache_entries, results: info.results }
}
