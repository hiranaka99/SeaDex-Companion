import { scanState } from './scan-state.js'
import { loadLastResults } from './results.js'
import type { ResultItem } from './types.js'

/** The current scan results, falling back to the persisted last successful scan. */
export function resultsForRequest(): ResultItem[] {
  return scanState.results.length ? scanState.results : (loadLastResults()?.results || [])
}
