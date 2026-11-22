import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, sendJson } from './http-response.js'
import { loadConfig } from './config.js'
import { resultsForRequest } from './downloads.js'
import { buildDownloadPlan, parseSelections } from './download-preflight.js'
import { consumePlan, type StoredPlan } from './download-plans.js'
import { acceptDownloadPlan, PlanRejected, receiptFromJob } from './download-submit.js'
import { downloadJobs, DownloadJobConflict } from './download-jobs.js'
import { cancelRecords, collectDownloadProgress, controlRecord, listCancelable, OwnershipError } from './download-progress.js'
import { usenetAvailability, sabnzbdConfigured, UsenetSelectionError } from './usenet.js'
import { applyUserRulesToResults } from './user-rules.js'
import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import type { ResultItem } from './types.js'
import type { BulkSubmissionResult } from '../shared/download-contracts.js'

const JOB_STATUS_PATH = /^\/api\/download-jobs\/[^/]+$/
let bulkOperationActive = false

/** The same rule-applied view the UI received, so validation and identities agree. */
function currentResults(): ResultItem[] {
  return applyUserRulesToResults(resultsForRequest()) as unknown as ResultItem[]
}

function readPlan(body: Record<string, unknown>): { plan: StoredPlan } | { error: [number, string] } {
  const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : ''
  if (!planId) return { error: [400, 'A review plan_id is required'] }
  const plan = consumePlan(planId)
  if (!plan) return { error: [410, 'This review has expired or was already used. Re-run the review before submitting.'] }
  return { plan }
}

function acknowledgeFlags(body: Record<string, unknown>) {
  const acknowledge = body.acknowledge && typeof body.acknowledge === 'object' ? body.acknowledge as Record<string, unknown> : {}
  return { whole_source: acknowledge.whole_source === true, disk_space: acknowledge.disk_space === true }
}

export async function handleDownloadRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method || 'GET'
  const path = url.pathname

  if (method === 'POST' && path === '/api/download_bulk/preflight') {
    const body = await readJson(request)
    const parsed = parseSelections(body.selections)
    if (parsed.error) return sendJson(response, parsed.error[0], { error: parsed.error[1] })
    const built = await buildDownloadPlan(loadConfig(), parsed.selections, { results: currentResults(), refresh: body.refresh === true })
    if ('error' in built) return sendJson(response, built.error[0], { error: built.error[1] })
    return sendJson(response, 200, built.review, { 'Cache-Control': 'no-store' })
  }

  if (method === 'POST' && path === '/api/usenet/availability') {
    const body = await readJson(request)
    const parsed = parseSelections(body.selections)
    if (parsed.error) return sendJson(response, parsed.error[0], { error: parsed.error[1] })
    const config = loadConfig()
    const results = currentResults()
    try {
      const availability = await usenetAvailability(config, parsed.selections, body.refresh === true, results)
      return sendJson(response, 200, {
        ok: true,
        config_generation: currentGeneration(),
        providers_enabled: { animetosho: config.animetosho_enabled, amenzb: config.amenzb_enabled },
        sabnzbd_configured: sabnzbdConfigured(config),
        results: availability,
      }, { 'Cache-Control': 'no-store' })
    } catch (error) {
      if (error instanceof UsenetSelectionError) return sendJson(response, error.status, { ok: false, error: error.message })
      throw error
    }
  }

  if (method === 'POST' && path === '/api/download') {
    if (bulkOperationActive || downloadJobs.active()) return sendJson(response, 409, { ok: false, error: 'Another download operation is already running' })
    const body = await readJson(request)
    const planRead = readPlan(body)
    if ('error' in planRead) return sendJson(response, planRead.error[0], { ok: false, error: planRead.error[1] })
    const plan = planRead.plan
    if (plan.selections.length !== 1) return sendJson(response, 400, { ok: false, error: 'Use the download job endpoint for multi-release reviews' })
    bulkOperationActive = true
    try {
      const { job, completion } = await acceptDownloadPlan(loadConfig(), plan, acknowledgeFlags(body), currentResults())
      await completion
      const finalJob = downloadJobs.get(job.id)
      const receipt = finalJob ? receiptFromJob(finalJob) : { error: 'The submission did not settle; check the download client before retrying.' }
      if ('error' in receipt) return sendJson(response, 502, { ok: false, ...receipt })
      return sendJson(response, 200, receipt)
    } catch (error) {
      if (error instanceof PlanRejected) return sendJson(response, error.status, { ok: false, error: error.message })
      if (error instanceof DownloadJobConflict) return sendJson(response, 409, { ok: false, error: error.message })
      throw error
    } finally {
      bulkOperationActive = false
    }
  }

  if (method === 'POST' && path === '/api/download-jobs') {
    if (bulkOperationActive || downloadJobs.active()) return sendJson(response, 409, { ok: false, error: 'Another bulk operation is already running' })
    const body = await readJson(request)
    const planRead = readPlan(body)
    if ('error' in planRead) return sendJson(response, planRead.error[0], { ok: false, error: planRead.error[1] })
    bulkOperationActive = true
    let completionOwnsOperation = false
    try {
      const { job, completion } = await acceptDownloadPlan(loadConfig(), planRead.plan, acknowledgeFlags(body), currentResults())
      completionOwnsOperation = true
      completion.then(
        (result: BulkSubmissionResult) => log('INFO', `Bulk download job ${job.id} settled: ${result.count}/${result.rows.length} release(s) ready, ${result.failures.length} failure(s)`),
        (error: unknown) => log('ERROR', `Bulk download job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`),
      ).finally(() => { bulkOperationActive = false })
      return sendJson(response, 202, { ok: true, job_id: job.id })
    } catch (error) {
      if (error instanceof PlanRejected) return sendJson(response, error.status, { ok: false, error: error.message })
      if (error instanceof DownloadJobConflict) return sendJson(response, 409, { ok: false, error: error.message })
      throw error
    } finally {
      if (!completionOwnsOperation) bulkOperationActive = false
    }
  }

  if (method === 'GET' && (path === '/api/download_bulk/status' || path === '/api/download-jobs' || path === '/api/download-jobs/latest' || JOB_STATUS_PATH.test(path))) {
    const id = path !== '/api/download_bulk/status' && path !== '/api/download-jobs' && path !== '/api/download-jobs/latest' ? path.slice('/api/download-jobs/'.length) : undefined
    const job = downloadJobs.get(id)
    if (id && !job) return sendJson(response, 404, { error: 'Download job not found' })
    return sendJson(response, 200, { ok: true, ...(job || { id: null, finished: true, pending: [], added: [], failures: [], existing: [], targets: [] }) }, { 'Cache-Control': 'no-store' })
  }

  if (method === 'GET' && path === '/api/downloads') {
    try {
      return sendJson(response, 200, await collectDownloadProgress(loadConfig()), { 'Cache-Control': 'no-store' })
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'GET' && path === '/api/downloads/cancelable') {
    try {
      return sendJson(response, 200, await listCancelable(loadConfig()), { 'Cache-Control': 'no-store' })
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (method === 'POST' && path === '/api/downloads/cancel') {
    const body = await readJson(request)
    if (bulkOperationActive || downloadJobs.active()) return sendJson(response, 409, { ok: false, error: 'A bulk operation is running; wait for it to finish before cancelling' })
    bulkOperationActive = true
    try {
      const result = await cancelRecords(loadConfig(), body.record_ids, body.remove_files === true)
      return sendJson(response, 200, result)
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      bulkOperationActive = false
    }
  }

  if (method === 'POST' && path === '/api/download_control') {
    const body = await readJson(request)
    const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : ''
    const action = String(body.action || '')
    if (!recordId) return sendJson(response, 400, { ok: false, error: 'A download record id is required' })
    try {
      await controlRecord(loadConfig(), recordId, action, body.delete_files === true)
      return sendJson(response, 200, { ok: true })
    } catch (error) {
      if (error instanceof OwnershipError) {
        const message = error.message
        const status = message === 'Download record not found.' ? 404 : message === 'Unknown download action' ? 400 : 409
        return sendJson(response, status, { ok: false, error: message })
      }
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', `Download control failed: ${message}`)
      return sendJson(response, 502, { ok: false, error: message })
    }
  }

  sendJson(response, 404, { error: 'Not found' })
}
