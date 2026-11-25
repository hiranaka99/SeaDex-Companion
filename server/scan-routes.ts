import { authenticateBasic } from './auth-routes.js'
import { loadConfig } from './config.js'
import { HttpError } from './http-error.js'
import { readJson, sendEmpty, sendJson } from './http-response.js'
import { log } from './logging.js'
import { loadLastResults } from './results.js'
import { route, type Route } from './router.js'
import { runScan } from './scan.js'
import { autocheckState, cancelScan, getState, resultsRevision, setState } from './scan-state.js'
import { queueWebhookScan, resetWebhookScanState, webhookScanState } from './scheduler.js'
import { usenetPrefetchProgress } from './usenet-prefetch.js'
import { errorMessage } from '../shared/errors.js'
import type { Status } from '../shared/contracts.js'
import type { Config } from './types.js'

export const scanRoutes: Route[] = [
  route('GET', '/healthz', ({ response }) => sendJson(response, 200, { status: 'ok' }), 'public'),
  route('HEAD', '/healthz', ({ response }) => sendEmpty(response, 200), 'public'),
  route(
    'POST',
    /^\/api\/webhooks\/(sonarr|radarr)$/,
    async ({ request, response, params }) => {
      const source = params[0] as 'sonarr' | 'radarr'
      await authenticateBasic(request)
      const data = await readJson(request)
      const queued = queueWebhookScan(source, data.eventType, source === 'sonarr' ? data.series?.id : data.movie?.id)
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
