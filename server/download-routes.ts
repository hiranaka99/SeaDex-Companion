import { loadConfig } from './config.js'
import { currentGeneration } from './config-generation.js'
import { downloadJobs } from './download-jobs.js'
import { consumePlan, type StoredPlan } from './download-plans.js'
import { buildDownloadPlan, parseSelections } from './download-preflight.js'
import { cancelRecords, collectDownloadProgress, controlRecord, listCancelable } from './download-progress.js'
import { acceptDownloadPlan, receiptFromJob, type AcknowledgeFlags } from './download-submit.js'
import { resultsForRequest } from './downloads.js'
import { HttpError } from './http-error.js'
import { readJson, sendJson } from './http-response.js'
import { log } from './logging.js'
import { route, type Route } from './router.js'
import { sabnzbdConfigured, usenetAvailability } from './usenet.js'
import { applyUserRulesToResults } from './user-rules.js'
import { errorMessage } from '../shared/errors.js'
import { asRecord } from '../shared/guards.js'
import type { JsonObject, ResultItem } from './types.js'

/** The same rule-applied view the UI received, so validation and identities agree. */
function currentResults(): ResultItem[] {
  return applyUserRulesToResults(resultsForRequest())
}

/** Retrieves and burns the reviewed plan a submission names. */
function readPlan(body: JsonObject): StoredPlan {
  const planId = typeof body.plan_id === 'string' ? body.plan_id.trim() : ''
  if (!planId) throw new HttpError(400, 'A review plan_id is required', { ok: false })
  const plan = consumePlan(planId)
  if (!plan)
    throw new HttpError(410, 'This review has expired or was already used. Re-run the review before submitting.', {
      ok: false,
    })
  return plan
}

function acknowledgeFlags(body: JsonObject): AcknowledgeFlags {
  const acknowledge = asRecord(body.acknowledge)
  return { whole_source: acknowledge.whole_source === true, disk_space: acknowledge.disk_space === true }
}

// Submissions and cancellations change the same clients and ledger, so only one runs at a time.
let operationRunning = false

function requireIdle(message: string): void {
  if (operationRunning || downloadJobs.active()) throw new HttpError(409, message, { ok: false })
}

/** Claims the single operation slot and returns the function that frees it. */
function claimOperation(message: string): () => void {
  requireIdle(message)
  operationRunning = true
  return () => {
    operationRunning = false
  }
}

/** A download client that fails is a bad gateway; deliberate refusals keep their own status. */
async function throughClient<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(502, errorMessage(error), { ok: false })
  }
}

const NO_JOB = { id: null, finished: true, pending: [], added: [], failures: [], existing: [], targets: [] }

function sendJob(id: string | undefined): Route['handle'] {
  return ({ response }) => {
    const job = downloadJobs.get(id)
    if (id && !job) throw new HttpError(404, 'Download job not found')
    sendJson(response, 200, { ok: true, ...(job || NO_JOB) })
  }
}

export const downloadRoutes: Route[] = [
  route('POST', '/api/download_bulk/preflight', async ({ request, response }) => {
    const body = await readJson(request)
    const { review } = await buildDownloadPlan(loadConfig(), parseSelections(body.selections), {
      results: currentResults(),
      refresh: body.refresh === true,
    })
    sendJson(response, 200, review)
  }),
  route('POST', '/api/usenet/availability', async ({ request, response }) => {
    const body = await readJson(request)
    const selections = parseSelections(body.selections)
    const config = loadConfig()
    sendJson(response, 200, {
      ok: true,
      config_generation: currentGeneration(),
      providers_enabled: { animetosho: config.animetosho_enabled, amenzb: config.amenzb_enabled },
      sabnzbd_configured: sabnzbdConfigured(config),
      results: await usenetAvailability(config, selections, currentResults(), { refresh: body.refresh === true }),
    })
  }),
  // One reviewed release, answered once every source it needs has settled.
  route('POST', '/api/download', async ({ request, response }) => {
    const busy = 'Another download operation is already running'
    requireIdle(busy)
    const body = await readJson(request)
    const plan = readPlan(body)
    if (plan.selections.length !== 1)
      throw new HttpError(400, 'Use the download job endpoint for multi-release reviews', { ok: false })
    const release = claimOperation(busy)
    try {
      const { job, completion } = await acceptDownloadPlan(loadConfig(), plan, acknowledgeFlags(body), currentResults())
      await completion
      const settled = downloadJobs.get(job.id)
      const receipt = settled
        ? receiptFromJob(settled)
        : { error: 'The submission did not settle; check the download client before retrying.' }
      // An unsettled or partly failed send is a bad gateway that still carries the receipt for the browser.
      if ('error' in receipt) throw new HttpError(502, String(receipt.error), { ok: false, ...receipt })
      sendJson(response, 200, receipt)
    } finally {
      release()
    }
  }),
  // A reviewed batch, accepted as a job the browser then follows.
  route('POST', '/api/download-jobs', async ({ request, response }) => {
    const busy = 'Another bulk operation is already running'
    requireIdle(busy)
    const body = await readJson(request)
    const plan = readPlan(body)
    const release = claimOperation(busy)
    try {
      const { job, completion } = await acceptDownloadPlan(loadConfig(), plan, acknowledgeFlags(body), currentResults())
      // The job holds the operation slot until every unit has settled.
      void completion
        .then(
          result =>
            log(
              'INFO',
              `Bulk download job ${job.id} settled: ${result.count}/${result.rows.length} release(s) ready, ${result.failures.length} failure(s)`,
            ),
          error => log('ERROR', `Bulk download job ${job.id} crashed: ${errorMessage(error)}`),
        )
        .finally(release)
      sendJson(response, 202, { ok: true, job_id: job.id })
    } catch (error) {
      release()
      throw error
    }
  }),
  route('GET', '/api/download_bulk/status', sendJob(undefined)),
  route('GET', '/api/download-jobs', sendJob(undefined)),
  route('GET', '/api/download-jobs/latest', sendJob(undefined)),
  route('GET', /^\/api\/download-jobs\/([^/]+)$/, context => sendJob(context.params[0])(context)),
  route('GET', '/api/downloads', async ({ response }) =>
    sendJson(response, 200, await throughClient(() => collectDownloadProgress(loadConfig()))),
  ),
  route('GET', '/api/downloads/cancelable', async ({ response }) =>
    sendJson(response, 200, await throughClient(() => listCancelable(loadConfig()))),
  ),
  route('POST', '/api/downloads/cancel', async ({ request, response }) => {
    const body = await readJson(request)
    const release = claimOperation('A bulk operation is running; wait for it to finish before cancelling')
    try {
      sendJson(
        response,
        200,
        await throughClient(() => cancelRecords(loadConfig(), body.record_ids, body.remove_files === true)),
      )
    } finally {
      release()
    }
  }),
  route('POST', '/api/download_control', async ({ request, response }) => {
    const body = await readJson(request)
    const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : ''
    if (!recordId) throw new HttpError(400, 'A download record id is required', { ok: false })
    try {
      await controlRecord(loadConfig(), recordId, String(body.action || ''), body.delete_files === true)
    } catch (error) {
      if (error instanceof HttpError) throw error
      log('ERROR', `Download control failed: ${errorMessage(error)}`)
      throw new HttpError(502, errorMessage(error), { ok: false })
    }
    sendJson(response, 200, { ok: true })
  }),
]
