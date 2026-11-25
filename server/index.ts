import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthError, isAuthenticated } from './auth.js'
import { authRoutes } from './auth-routes.js'
import { qbEndpointId } from './client-identity.js'
import { loadConfig, migrateConfig } from './config.js'
import { configRoutes } from './config-routes.js'
import { downloadJobs } from './download-jobs.js'
import { downloadRoutes } from './download-routes.js'
import { downloadRecords, migrateOwnedDownloads } from './download-store.js'
import { HttpError } from './http-error.js'
import { clientAddress, sendJson } from './http-response.js'
import { LAUNCHER_ENV, READY_MESSAGE, RESTART_EXIT_CODE } from './launcher.js'
import { libraryRoutes } from './library-routes.js'
import { onRestartRequest } from './lifecycle.js'
import { log } from './logging.js'
import { DATA_DIR, STATIC_DIR } from './paths.js'
import { loadLastResults } from './results.js'
import { matchRoute, type Route } from './router.js'
import { scanRoutes } from './scan-routes.js'
import { startScheduler } from './scheduler.js'
import { APP_VERSION, reportUpdateState } from './updates.js'
import { serveStatic } from './static-files.js'
import { flushUsenetCache, invalidateUsenetLookups } from './usenet.js'
import { enableUsenetPrefetch, prefetchUsenetAvailability, stopUsenetPrefetch } from './usenet-prefetch.js'
import { errorMessage } from '../shared/errors.js'

const routes: Route[] = [...scanRoutes, ...authRoutes, ...configRoutes, ...libraryRoutes, ...downloadRoutes]

async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method || 'GET'
  const path = url.pathname
  const match = matchRoute(routes, method, path)
  if (match?.route.access === 'public') return match.route.handle({ request, response, url, params: match.params })
  // Everything under /api needs a session, whether or not the path exists.
  if (path.startsWith('/api/')) {
    if (!isAuthenticated(request)) return sendJson(response, 401, { error: 'Authentication required' })
    if (match) return match.route.handle({ request, response, url, params: match.params })
  } else if ((method === 'GET' || method === 'HEAD') && serveStatic(path, response, method === 'HEAD')) return
  sendJson(response, 404, { error: 'Not found' })
}

/** Turns a thrown error into the response; only failures the server did not choose are logged as errors. */
function sendFailure(request: IncomingMessage, response: ServerResponse, url: URL, error: unknown): void {
  const message = errorMessage(error)
  const where = `${request.method || 'GET'} ${url.pathname}`
  const status = error instanceof HttpError ? error.status : 500
  if (error instanceof AuthError)
    log('WARNING', `Request rejected: ${where} → HTTP ${status} (client: ${clientAddress(request)}; ${message})`)
  else if (!(error instanceof HttpError))
    log('ERROR', `Request failed: ${where} (client: ${clientAddress(request)}; ${message})`)
  if (response.headersSent) response.end()
  else sendJson(response, status, { ...(error instanceof HttpError ? error.fields : {}), error: message })
}

export function makeServer() {
  migrateConfig()
  const config = loadConfig()
  invalidateUsenetLookups(config)
  try {
    migrateOwnedDownloads(qbEndpointId(config))
  } catch (error) {
    log('ERROR', `Acquisition ledger migration deferred: ${errorMessage(error)}`)
  }
  downloadJobs.restore()
  return createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' })
      return
    }
    void handle(request, response, url).catch(error => sendFailure(request, response, url, error))
  })
}

function reportRestoredState(): void {
  const config = loadConfig()
  const saved = loadLastResults()?.results
  log(
    'INFO',
    `Runtime state restored (saved results: ${saved?.length || 0}; owned acquisitions: ${downloadRecords().length}; hidden titles: ${config.hidden.length}; auto-check: ${config.scan_schedule.enabled ? config.scan_schedule.mode : 'disabled'})`,
  )
  enableUsenetPrefetch()
  // Delay the startup sweep so the first interactive lookups after boot own the providers.
  if (saved) setTimeout(() => prefetchUsenetAvailability(config, saved, 'startup'), 30_000).unref()
}

function main(): void {
  const port = Number.parseInt(process.env.PORT || '8080', 10)
  const scheduler = startScheduler()
  const server = makeServer()
  let shuttingDown = false
  // A restart exits with the launcher's restart code whatever else fails, so the
  // launcher starts the newly installed version instead of stopping the container.
  const shutdown = (signal: string, restart = false) => {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', restart ? 'Restarting to apply an update' : `${signal} received; shutting down`)
    clearInterval(scheduler)
    stopUsenetPrefetch()
    const deadline = setTimeout(() => {
      log('ERROR', 'Graceful shutdown timed out')
      process.exit(restart ? RESTART_EXIT_CODE : 1)
    }, 10_000)
    deadline.unref()
    server.close(error => {
      clearTimeout(deadline)
      if (error) log('ERROR', `Shutdown failed: ${error.message}`)
      else log('INFO', 'Server stopped')
      const cacheSaved = flushUsenetCache()
      process.exit(restart ? RESTART_EXIT_CODE : error || !cacheSaved ? 1 : 0)
    })
  }
  if (process.env[LAUNCHER_ENV] === '1') onRestartRequest(() => shutdown('restart', true))
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  server.listen(port, '0.0.0.0', () => {
    log(
      'INFO',
      `Server listening on 0.0.0.0:${port} (Node ${process.version}; data: ${DATA_DIR}; static: ${STATIC_DIR})`,
    )
    // Tells the launcher this version started, so it is kept instead of rolled back.
    process.send?.({ type: READY_MESSAGE, version: APP_VERSION })
    try {
      reportRestoredState()
      reportUpdateState()
    } catch (error) {
      log('ERROR', `Runtime configuration could not be restored: ${errorMessage(error)}`)
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
