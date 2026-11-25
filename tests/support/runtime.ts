import { autocheckState, setState } from '../../server/scan-state.js'
import { resetQbRuntime } from '../../server/qbittorrent.js'
import { resetOwnedRuntime } from '../../server/download-store.js'

/** Returns the in-memory scan, client, ledger, and schedule state to a fresh process. */
export function resetRuntimeForTests(): void {
  setState({
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
  })
  resetQbRuntime()
  resetOwnedRuntime()
  autocheckState.next = null
  autocheckState.signature = ''
  autocheckState.pending = false
}
