/** Lets request handlers ask the process owner (server/index.ts) for a graceful restart. */
let restartHandler: (() => void) | null = null

export function onRestartRequest(handler: (() => void) | null): void {
  restartHandler = handler
}

export function requestRestart(): boolean {
  if (!restartHandler) return false
  restartHandler()
  return true
}
