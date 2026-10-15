// Compatibility exports for existing integrations and tests. Runtime modules import their owners directly.
export * from './paths.js'
export * from './logging.js'
export * from './persistence.js'
export * from './config.js'
export * from './scan-state.js'
export * from './http.js'
export * from './results.js'
export * from './user-rules.js'
export * from './history.js'
export * from './matching.js'
export * from './catalog.js'
export * from './library.js'
export * from './updates.js'
export * from './anilist.js'
export * from './scan.js'
export * from './notifications.js'
export * from './qbittorrent.js'
export * from './download-store.js'
export * from './downloads.js'
import { setState, autocheckState } from './scan-state.js'
import { resetQbRuntime } from './qbittorrent.js'
import { resetOwnedRuntime } from './download-store.js'
export function resetRuntimeForTests(): void {
  setState({ running: false, progress: 0, total: 0, message: 'Idle', results: [], error: null, last_run: null, cancelled: false, trigger: null, source_errors: {} })
  resetQbRuntime(); resetOwnedRuntime()
  autocheckState.next = null; autocheckState.signature = ''; autocheckState.pending = false
}
