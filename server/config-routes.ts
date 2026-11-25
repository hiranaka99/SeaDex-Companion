import { loadConfig, publicConfig } from './config.js'
import { saveSettings, testSubmittedIntegration } from './config-service.js'
import { readJson, sendJson } from './http-response.js'
import { readLogTail } from './logging.js'
import { route, type Route } from './router.js'
import { checkForUpdates } from './updates.js'

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
  route('GET', '/api/update-check', async ({ response }) => sendJson(response, 200, await checkForUpdates())),
  route('GET', '/api/logs', ({ response, url }) => {
    const requested = Number.parseInt(url.searchParams.get('lines') || String(DEFAULT_LOG_LINES), 10)
    const count = Math.max(1, Math.min(Number.isFinite(requested) ? requested : DEFAULT_LOG_LINES, MAX_LOG_LINES))
    const lines = readLogTail().slice(-count)
    sendJson(response, 200, { lines, total: lines.length })
  }),
]
