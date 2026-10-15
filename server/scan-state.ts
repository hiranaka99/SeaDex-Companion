import { normalizeResults } from './result-model.js'
import { statSync } from 'node:fs'
import { RESULTS_FILE, USER_RULES_FILE } from './paths.js'
import type { ScanState } from './types.js'

export const scanState: ScanState = {
  running: false,
  progress: 0,
  total: 0,
  message: 'Idle',
  results: [],
  error: null,
  last_run: null,
  cancelled: false,
  trigger: null,
  source_errors: {},
}

export const autocheckState: { next: number | null; signature: string; pending: boolean } = {
  next: null,
  signature: '',
  pending: false,
}

let resultRevision = 0
export function resultsRevision(): string {
  const stamp = (file: string) => { try { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}` } catch { return '' } }
  return `${resultRevision}:${stamp(RESULTS_FILE)}:${stamp(USER_RULES_FILE)}`
}

export function setState(values: Omit<Partial<ScanState>, 'results'> & { results?: readonly unknown[] }): void {
  if ('results' in values) { resultRevision += 1; values = { ...values, results: normalizeResults(values.results) } }
  Object.assign(scanState, values)
}

export function getState(): ScanState {
  return { ...scanState, results: scanState.results }
}


let activeScanController: AbortController | null = null
export function beginScan(controller: AbortController): boolean {
  if (activeScanController) return false
  activeScanController = controller
  return true
}
export function endScan(controller: AbortController): void {
  if (activeScanController === controller) activeScanController = null
}
export function cancelScan(): boolean {
  if (!activeScanController || activeScanController.signal.aborted) return false
  activeScanController.abort()
  return true
}
