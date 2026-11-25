import { authenticateBasic } from './auth-routes.js'
import { findArrInstance, instanceSourceKey } from './arr-instances.js'
import { loadConfig } from './config.js'
import { currentGeneration } from './config-generation.js'
import { resultsForRequest } from './downloads.js'
import { HttpError } from './http-error.js'
import { readJson, sendEmpty, sendJson } from './http-response.js'
import { log } from './logging.js'
import { loadLastResults, loadResultSettings } from './results.js'
import { route, type Route } from './router.js'
import { resultSettingsChanged, runScan } from './scan.js'
import { autocheckState, cancelScan, getState, resultsRevision, setState } from './scan-state.js'
import {
  isImportAttentionEvent,
  isLibraryImportEvent,
  queueWebhookScan,
  requestImportFollow,
  resetWebhookScanState,
  webhookScanState,
} from './scheduler.js'
import { usenetPrefetchProgress } from './usenet-prefetch.js'
import { errorMessage } from '../shared/errors.js'
import type { Status } from '../shared/contracts.js'
import type { Config } from './types.js'

// Reading the saved results on every status poll would be wasteful; the answer only changes with results or settings.
let settingsFlag: { key: string; changed: boolean } | null = null
function settingsChangedSinceScan(): boolean {
  const key = `${resultsRevision()}:${currentGeneration()}`
  if (settingsFlag?.key !== key) {
    let changed = false
    try {
      changed = resultSettingsChanged(loadConfig(), loadResultSettings())
    } catch {
      /* an unreadable configuration is reported by its own endpoints */
    }
    settingsFlag = { key, changed }
  }
  return settingsFlag.changed
}

export const scanRoutes: Route[] = [
  route('GET', '/healthz', ({ response }) => sendJson(response, 200, { status: 'ok' }), 'public'),
  route('HEAD', '/healthz', ({ response }) => sendEmpty(response, 200), 'public'),
  route(
    'POST',
    /^\/api\/webhooks\/(sonarr|radarr)(?:\/([a-z0-9]+))?$/,
    async ({ request, response, params }) => {
      const source = params[0] as 'sonarr' | 'radarr'
      await authenticateBasic(request)
      const data = await readJson(request)
      // An additional instance has its own webhook address, so its item IDs are never confused with another library's.
      const instance = findArrInstance(params[1] ? loadConfig() : {}, params[1] || source)
      if (!instance || instance.kind !== source) throw new HttpError(404, 'Unknown instance')
      if (isImportAttentionEvent(data.eventType)) {
        requestImportFollow()
        return sendJson(response, 202, { accepted: true, action: 'import_check' })
      }
      const itemId = source === 'sonarr' ? data.series?.id : data.movie?.id
      const libraryKey = `${instanceSourceKey(instance)}:item${itemId}`
      // Only import events depend on the results, and Sonarr sends one per imported file of every show.
      const known =
        isLibraryImportEvent(source, data.eventType) &&
        resultsForRequest().some(result => result.library_key === libraryKey)
      const queued = queueWebhookScan(source, data.eventType, itemId, undefined, { instanceId: instance.id, known })
      if (!queued.accepted) return sendEmpty(response, 204)
      sendJson(response, 202, { accepted: true, action: 'scan_queued', due_at: queued.dueAt })
    },
    'public',
  ),
  route('GET', '/api/status', ({ response }) => {
    const state = getState()
    sendJson(response, 200, {
      running: state.running,
      progress: state.progress,
      total: state.total,
      message: state.message,
      error: state.error,
      cancelled: state.cancelled,
      trigger: state.trigger,
      source_errors: state.source_errors,
      last_run: state.last_run || (!state.running ? (loadLastResults()?.last_run ?? null) : null),
      next_check: autocheckState.next,
      usenet_prefetch: usenetPrefetchProgress(),
      results_revision: resultsRevision(),
      settings_changed: !state.running && settingsChangedSinceScan(),
      webhook_scan: {
        queued: webhookScanState.dueAt !== null,
        due_at: webhookScanState.dueAt,
        sources: [...webhookScanState.sources],
      },
    } satisfies Status)
  }),
  route('POST', '/api/scan', ({ response }) => {
    if (getState().running) {
      log('WARNING', 'Manual scan request ignored: a scan is already running')
      throw new HttpError(409, 'Scan already running', { ok: false })
    }
    let config: Config
    try {
      config = loadConfig()
    } catch (error) {
      log('ERROR', `Manual scan could not start: ${errorMessage(error)}`)
      throw new HttpError(500, errorMessage(error), { ok: false })
    }
    resetWebhookScanState()
    autocheckState.pending = false
    setState({ running: true })
    void runScan(config, 'manual')
    sendJson(response, 200, { ok: true })
  }),
  route('POST', '/api/scan/cancel', ({ response }) => {
    if (!cancelScan()) throw new HttpError(409, 'No scan is running', { ok: false })
    sendJson(response, 202, { ok: true })
  }),
]
