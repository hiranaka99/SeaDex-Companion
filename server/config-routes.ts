import { removeArrTags } from './arr-tags.js'
import { integrationConfig, loadConfig, publicConfig } from './config.js'
import { saveSettings, testSubmittedIntegration } from './config-service.js'
import { HttpError } from './http-error.js'
import { readJson, sendJson } from './http-response.js'
import { arrScopeOptions, isArrService } from './integration-tests.js'
import { readLogTail } from './logging.js'
import { route, type Route } from './router.js'
import { getState } from './scan-state.js'
import { downloadJobs } from './download-jobs.js'
import { requestRestart } from './lifecycle.js'
import { checkForUpdates, installUpdate, updateStatus } from './updates.js'
import { errorMessage } from '../shared/errors.js'
import { asRecord } from '../shared/guards.js'

const DEFAULT_LOG_LINES = 500
const MAX_LOG_LINES = 2000

export const configRoutes: Route[] = [
  route('GET', '/api/config', ({ response }) => sendJson(response, 200, publicConfig(loadConfig()))),
  route('POST', '/api/config', async ({ request, response }) =>
    sendJson(response, 200, publicConfig(saveSettings(await readJson(request)))),
  ),
  route('POST', '/api/config/test', async ({ request, response }) => {
    const data = await readJson(request)
    sendJson(response, 200, {
      ok: true,
      message: await testSubmittedIntegration(String(data.service || '').toLowerCase(), data.config),
    })
  }),
  route('POST', '/api/arr/options', async ({ request, response }) => {
    const data = await readJson(request)
    const service = String(data.service || '').toLowerCase()
    if (!isArrService(service)) throw new HttpError(400, 'Unknown Sonarr or Radarr instance')
    let options: Awaited<ReturnType<typeof arrScopeOptions>>
    try {
      options = await arrScopeOptions(integrationConfig(loadConfig(), service, asRecord(data.config)), service)
    } catch (error) {
      throw new HttpError(502, errorMessage(error), { ok: false })
    }
    sendJson(response, 200, { ok: true, ...options })
  }),
  route('POST', '/api/arr-tags/remove', async ({ response }) => {
    if (getState().running)
      throw new HttpError(409, 'Wait for the current scan to finish before removing status tags', { ok: false })
    const result = await removeArrTags(loadConfig())
    const failed = Object.entries(result.errors)
    if (failed.length)
      throw new HttpError(502, failed.map(([name, message]) => `${name}: ${message}`).join('; '), {
        ok: false,
        removed: result.removed,
      })
    sendJson(response, 200, { ok: true, removed: result.removed })
  }),
  route('GET', '/api/update-check', async ({ response }) => sendJson(response, 200, await checkForUpdates())),
  route('GET', '/api/update/status', ({ response }) => sendJson(response, 200, updateStatus())),
  route('POST', '/api/update/install', async ({ response }) => {
    if (getState().running) throw new HttpError(409, 'Wait for the current scan to finish before updating')
    if (downloadJobs.active()) throw new HttpError(409, 'Wait for the bulk download to finish before updating')
    const { version } = await installUpdate()
    // Restart only after the browser has the answer; it then waits for the new version.
    response.once('finish', () => setTimeout(requestRestart, 250))
    sendJson(response, 202, { ok: true, version, restarting: true })
  }),
  route('GET', '/api/logs', ({ response, url }) => {
    const requested = Number.parseInt(url.searchParams.get('lines') || String(DEFAULT_LOG_LINES), 10)
    const count = Math.max(1, Math.min(Number.isFinite(requested) ? requested : DEFAULT_LOG_LINES, MAX_LOG_LINES))
    const lines = readLogTail().slice(-count)
    sendJson(response, 200, { lines, total: lines.length })
  }),
]
