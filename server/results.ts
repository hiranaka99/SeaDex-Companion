import { normalizeResults } from './result-model.js'
import type { ResultItem } from './types.js'
import { existsSync, readFileSync } from 'node:fs'
import { CACHE_FILE, RESULTS_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { setState } from './scan-state.js'
import type { JsonObject } from './types.js'

export function loadCache(): JsonObject {
  const cache = readJson<unknown>(CACHE_FILE, {})
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache as JsonObject : {}
}
export function saveCache(cache: JsonObject): void { writeJsonAtomic(CACHE_FILE, cache, true) }
export function saveLastResults(results: JsonObject[], lastRun: string): void {
  writeJsonAtomic(RESULTS_FILE, { results, last_run: lastRun })
}
export function loadLastResults(): { results: ResultItem[]; last_run: string | null } | null {
  const saved = readJson<JsonObject | null>(RESULTS_FILE, null)
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.results)) return null
  return { results: normalizeResults(saved.results), last_run: typeof saved.last_run === 'string' ? saved.last_run : null }
}

export interface ScannedDataInfo {
  cache_entries: number
  results: number
  last_run: string | null
  cache_valid: boolean
  results_valid: boolean
}

export function scannedDataInfo(cacheFile = CACHE_FILE, resultsFile = RESULTS_FILE): ScannedDataInfo {
  let cache: JsonObject = {}
  let saved: JsonObject | null = null
  const cacheExists = existsSync(cacheFile)
  const resultsExists = existsSync(resultsFile)
  let cacheValid = true
  let resultsValid = true
  try { if (cacheExists) cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as JsonObject } catch { cacheValid = false }
  try { if (resultsExists) saved = JSON.parse(readFileSync(resultsFile, 'utf8')) as JsonObject } catch { resultsValid = false }
  const cacheShapeValid = !cacheExists || (cache !== null && typeof cache === 'object' && !Array.isArray(cache))
  const resultsShapeValid = !resultsExists || (saved !== null && typeof saved === 'object' && Array.isArray(saved.results) && (saved.last_run == null || typeof saved.last_run === 'string'))
  return {
    cache_entries: cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.keys(cache).length : 0,
    results: Array.isArray(saved?.results) ? saved.results.length : 0,
    last_run: typeof saved?.last_run === 'string' ? saved.last_run : null,
    cache_valid: cacheValid && cacheShapeValid,
    results_valid: resultsValid && resultsShapeValid,
  }
}

export function clearScannedData(cacheFile = CACHE_FILE, resultsFile = RESULTS_FILE): { cacheEntries: number; results: number } {
  const info = scannedDataInfo(cacheFile, resultsFile)
  writeJsonAtomic(cacheFile, {}, true)
  writeJsonAtomic(resultsFile, { results: [], last_run: null }, true)
  setState({ progress: 0, total: 0, message: 'Idle', results: [], error: null, last_run: null })
  return { cacheEntries: info.cache_entries, results: info.results }
}
