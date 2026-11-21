// Authenticated SABnzbd API client (https://sabnzbd.org/wiki/configuration/5.1/api).
// Every read and control targets explicit nzo_ids; the API never sends the
// broad forms (`value=all|failed|completed`, category purges, global
// pause/resume). The API key appears exactly once per request, in the query
// string only (never duplicated in a form body), and is redacted from all
// error text. Mutating submission timeouts map to SabnzbdAmbiguousError so
// callers never auto-retry an unknown outcome; reads never claim absence on
// failure — they report `read_complete: false` instead.

const READ_TIMEOUT_MS = 15_000
const ADD_TIMEOUT_MS = 20_000
const MAX_JSON_BYTES = 8 * 1024 * 1024
const ID_CHUNK_SIZE = 20
const MAX_ERROR_TEXT = 200
const API_PATH_SUFFIX = '/api'

export interface SabnzbdSettings { apiUrl: string; apiKey: string; signal?: AbortSignal }

export interface SabQueueJob {
  nzo_id: string
  name: string
  status: string
  category: string
  total_bytes: number
  remaining_bytes: number
  downloaded_bytes: number
  speed_bytes_per_sec: number
  percentage: number
  labels: string[]
}

export interface SabHistoryJob {
  nzo_id: string
  name: string
  status: string
  fail_message: string
  category: string
  total_bytes: number
  downloaded_bytes: number
  storage: string | null
  loaded: boolean
}

export interface SabQueueRead {
  jobs: SabQueueJob[]
  globalPaused: boolean
  incomplete_free_bytes: number | null
  complete_free_bytes: number | null
  read_complete: boolean
}

export interface SabHistoryRead {
  jobs: SabHistoryJob[]
  read_complete: boolean
}

export class SabnzbdError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SabnzbdError'
  }
}

export class SabnzbdAuthError extends SabnzbdError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SabnzbdAuthError'
  }
}

// A mutating submission's outcome could not be established (timeout, abort,
// connection loss). Callers must treat acceptance as unknown and must NOT
// retry automatically.
export class SabnzbdAmbiguousError extends SabnzbdError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SabnzbdAmbiguousError'
  }
}

const AUTH_KEY_MESSAGE = 'SABnzbd rejected the API key; the full API key (not the NZB add-only key) is required'

// --- helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Provider text is never trusted for display: strip markup, collapse
// whitespace, redact the API key if it ever echoes back, cap the length.
function safeText(text: unknown, apiKey?: string): string {
  if (typeof text !== 'string') return ''
  let out = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (apiKey && out.includes(apiKey)) out = out.split(apiKey).join('[redacted]')
  return out.length > MAX_ERROR_TEXT ? out.slice(0, MAX_ERROR_TEXT) : out
}

function describeError(error: unknown, apiKey?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return safeText(message, apiKey) || 'unknown error'
}

function providerErrorText(payload: unknown, apiKey?: string): string | null {
  if (!isRecord(payload)) return null
  for (const field of ['error', 'errormsg']) {
    const text = safeText(payload[field], apiKey)
    if (text) return text
  }
  return null
}

function isApiKeyRejection(text: string): boolean {
  return /api key (incorrect|required)/i.test(text)
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}

// Queue payload sizes are decimal megabytes.
function mbToBytes(value: unknown): number {
  const n = toNumber(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000 * 1000) : 0
}

// Queue speed is a decimal kilobyte/second string.
function kbToBytes(value: unknown): number {
  const n = toNumber(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
}

// Queue diskspace values are gigabyte-float strings; absence or an
// unparseable value is unknown space, never zero.
function gbToBytes(value: unknown): number | null {
  const n = toNumber(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e9) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function byteCount(value: unknown): number {
  const n = toNumber(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + ID_CHUNK_SIZE))
  }
  return chunks
}

function requestSignal(settings: SabnzbdSettings, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs)
  return settings.signal ? AbortSignal.any([settings.signal, timer]) : timer
}

function buildApiUrl(settings: SabnzbdSettings, params: Record<string, string>): string {
  return `${settings.apiUrl}?${new URLSearchParams(params).toString()}`
}

function keyParams(settings: SabnzbdSettings): Record<string, string> {
  return { apikey: settings.apiKey, output: 'json' }
}

// Bounded body read: the cap is enforced while streaming, never after an
// unbounded buffer.
async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let completed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      if (value) {
        total += value.byteLength
        if (total > MAX_JSON_BYTES) throw new Error(`response exceeded ${MAX_JSON_BYTES} bytes`)
        chunks.push(value)
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

interface JsonResult {
  ok: boolean
  status: number
  payload: unknown
}

// Transport, body-read and JSON-parse failures throw; HTTP failures that
// carry a JSON body return so callers can classify the error text.
async function requestJson(
  settings: SabnzbdSettings,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<JsonResult> {
  const response = await fetchImpl(url, { ...init, signal: requestSignal(settings, timeoutMs) })
  const bodyText = new TextDecoder().decode(await readBoundedBytes(response))
  if (!response.ok) {
    let errorPayload: unknown
    try {
      errorPayload = JSON.parse(bodyText)
    } catch {
      throw new Error(`SABnzbd responded HTTP ${response.status} without a JSON error body`)
    }
    return { ok: false, status: response.status, payload: errorPayload }
  }
  try {
    return { ok: true, status: response.status, payload: JSON.parse(bodyText) }
  } catch {
    throw new Error('SABnzbd response was not valid JSON')
  }
}

function readSection(result: JsonResult, section: 'queue' | 'history', apiKey: string): Record<string, unknown> {
  const errorText = providerErrorText(result.payload, apiKey)
  if (errorText) throw new SabnzbdError(`SABnzbd ${section} read failed: ${errorText}`)
  if (!result.ok) throw new SabnzbdError(`SABnzbd ${section} read failed (HTTP ${result.status})`)
  if (!isRecord(result.payload) || !isRecord(result.payload[section])) {
    throw new SabnzbdError(`SABnzbd did not return a ${section} object`)
  }
  return result.payload[section]
}

function parseQueueSlot(slot: unknown, queue: Record<string, unknown>): SabQueueJob | null {
  if (!isRecord(slot)) return null
  const nzoId = text(slot.nzo_id)
  if (nzoId === '') return null
  const total = mbToBytes(slot.mb)
  const remaining = mbToBytes(slot.mbleft)
  const status = text(slot.status)
  // The API reports speed only for the queue as a whole; attribute it to the
  // slot that is actually transferring.
  const transferring = status.toLowerCase() === 'downloading'
  const percentage = toNumber(slot.percentage)
  return {
    nzo_id: nzoId,
    name: text(slot.filename),
    status,
    category: text(slot.cat),
    total_bytes: total,
    remaining_bytes: remaining,
    downloaded_bytes: Math.max(0, total - remaining),
    speed_bytes_per_sec: transferring ? kbToBytes(queue.kbpersec) : 0,
    percentage: Number.isFinite(percentage) && percentage > 0 ? percentage : 0,
    labels: Array.isArray(slot.labels) ? slot.labels.filter((label): label is string => typeof label === 'string') : [],
  }
}

function parseHistorySlot(slot: unknown): SabHistoryJob | null {
  if (!isRecord(slot)) return null
  const nzoId = text(slot.nzo_id)
  if (nzoId === '') return null
  const storage = text(slot.storage)
  return {
    nzo_id: nzoId,
    name: text(slot.name),
    status: text(slot.status),
    fail_message: text(slot.fail_message),
    category: text(slot.category),
    total_bytes: byteCount(slot.bytes),
    downloaded_bytes: byteCount(slot.downloaded),
    storage: storage === '' ? null : storage,
    loaded: slot.loaded === true,
  }
}

// --- reads -----------------------------------------------------------------

export async function sabQueueJobs(
  settings: SabnzbdSettings,
  nzoIds: string[],
  fetchImpl: typeof fetch,
): Promise<SabQueueRead> {
  const jobs: SabQueueJob[] = []
  const seen = new Set<string>()
  let globalPaused = false
  let incompleteFreeBytes: number | null = null
  let completeFreeBytes: number | null = null
  let readComplete = true
  for (const chunk of chunkIds(nzoIds)) {
    try {
      const url = buildApiUrl(settings, { ...keyParams(settings), mode: 'queue', nzo_ids: chunk.join(',') })
      const queue = readSection(await requestJson(settings, url, { method: 'GET' }, READ_TIMEOUT_MS, fetchImpl), 'queue', settings.apiKey)
      if (queue.paused_all === true) globalPaused = true
      if (incompleteFreeBytes === null) incompleteFreeBytes = gbToBytes(queue.diskspace1)
      if (completeFreeBytes === null) completeFreeBytes = gbToBytes(queue.diskspace2)
      if (Array.isArray(queue.slots)) {
        for (const slot of queue.slots) {
          const job = parseQueueSlot(slot, queue)
          if (job && !seen.has(job.nzo_id)) {
            seen.add(job.nzo_id)
            jobs.push(job)
          }
        }
      }
    } catch {
      // A failed chunk is never evidence of absence; keep partial results.
      readComplete = false
    }
  }
  return { jobs, globalPaused, incomplete_free_bytes: incompleteFreeBytes, complete_free_bytes: completeFreeBytes, read_complete: readComplete }
}

export async function sabHistoryJobs(
  settings: SabnzbdSettings,
  nzoIds: string[],
  fetchImpl: typeof fetch,
): Promise<SabHistoryRead> {
  const jobs: SabHistoryJob[] = []
  const seen = new Set<string>()
  let readComplete = true
  for (const chunk of chunkIds(nzoIds)) {
    // Active history first, then the archive, so a live record wins if the
    // same nzo_id somehow appears in both.
    for (const archive of [false, true]) {
      try {
        const params: Record<string, string> = { ...keyParams(settings), mode: 'history', nzo_ids: chunk.join(',') }
        if (archive) params.archive = '1'
        const url = buildApiUrl(settings, params)
        const history = readSection(await requestJson(settings, url, { method: 'GET' }, READ_TIMEOUT_MS, fetchImpl), 'history', settings.apiKey)
        if (Array.isArray(history.slots)) {
          for (const slot of history.slots) {
            const job = parseHistorySlot(slot)
            if (job && !seen.has(job.nzo_id)) {
              seen.add(job.nzo_id)
              jobs.push(job)
            }
          }
        }
      } catch {
        readComplete = false
      }
    }
  }
  return { jobs, read_complete: readComplete }
}

/** Queue-payload disk read without targeting any job; used by preflight reviews. */
export async function sabDiskSpace(
  settings: SabnzbdSettings,
  fetchImpl: typeof fetch,
): Promise<{ incomplete_free_bytes: number | null; complete_free_bytes: number | null }> {
  const url = buildApiUrl(settings, { ...keyParams(settings), mode: 'queue', limit: '0' })
  const queue = readSection(await requestJson(settings, url, { method: 'GET' }, READ_TIMEOUT_MS, fetchImpl), 'queue', settings.apiKey)
  return { incomplete_free_bytes: gbToBytes(queue.diskspace1), complete_free_bytes: gbToBytes(queue.diskspace2) }
}

// --- connection test ---------------------------------------------------------

export async function sabTestConnection(
  settings: SabnzbdSettings,
  fetchImpl: typeof fetch,
): Promise<{ version: string }> {
  let versionResult: JsonResult
  try {
    // mode=version needs no API key.
    versionResult = await requestJson(
      settings,
      buildApiUrl(settings, { mode: 'version', output: 'json' }),
      { method: 'GET' },
      READ_TIMEOUT_MS,
      fetchImpl,
    )
  } catch (error) {
    throw new SabnzbdError(`Could not reach SABnzbd: ${describeError(error, settings.apiKey)}`, { cause: error })
  }
  const versionText = providerErrorText(versionResult.payload, settings.apiKey)
  if (versionText) throw new SabnzbdError(`Could not reach SABnzbd: ${versionText}`)
  if (!versionResult.ok) throw new SabnzbdError(`SABnzbd version check failed (HTTP ${versionResult.status})`)
  const version = isRecord(versionResult.payload) ? text(versionResult.payload.version).trim() : ''
  if (version === '') throw new SabnzbdError('SABnzbd responded without reporting a version')

  // A targeted authenticated queue read proves the key has full API access;
  // an add-only NZB key answers this with `API Key Incorrect`.
  let queueResult: JsonResult
  try {
    queueResult = await requestJson(
      settings,
      buildApiUrl(settings, { ...keyParams(settings), mode: 'queue', limit: '1' }),
      { method: 'GET' },
      READ_TIMEOUT_MS,
      fetchImpl,
    )
  } catch (error) {
    throw new SabnzbdError(`Could not reach SABnzbd: ${describeError(error, settings.apiKey)}`, { cause: error })
  }
  const keyText = providerErrorText(queueResult.payload, settings.apiKey)
  if (keyText) {
    if (isApiKeyRejection(keyText)) throw new SabnzbdAuthError(AUTH_KEY_MESSAGE)
    throw new SabnzbdError(`SABnzbd rejected the API key check: ${keyText}`)
  }
  if (!queueResult.ok) throw new SabnzbdError(`SABnzbd API key check failed (HTTP ${queueResult.status})`)
  if (!isRecord(queueResult.payload) || !isRecord(queueResult.payload.queue)) {
    throw new SabnzbdError('SABnzbd did not return a queue object for the API key check')
  }
  return { version }
}

// --- submission --------------------------------------------------------------

export async function sabAddNzb(
  settings: SabnzbdSettings,
  nzb: Uint8Array,
  nzoName: string,
  category: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const form = new FormData()
  form.set('mode', 'addfile')
  // The NZB payload lives only in the multipart file field; the key lives
  // only in the query string.
  // Copied so caller-side mutation of the buffer cannot alter the submission.
  form.set('name', new Blob([new Uint8Array(nzb)], { type: 'application/x-nzb+xml' }), 'download.nzb')
  form.set('nzbname', nzoName)
  form.set('cat', category)
  form.set('pp', '-1') // Category post-processing defaults.
  const url = buildApiUrl(settings, { apikey: settings.apiKey, output: 'json' })
  let result: JsonResult
  try {
    result = await requestJson(settings, url, { method: 'POST', body: form }, ADD_TIMEOUT_MS, fetchImpl)
  } catch (error) {
    throw new SabnzbdAmbiguousError(`SABnzbd NZB submission outcome unknown: ${describeError(error, settings.apiKey)}`, { cause: error })
  }
  const errorText = providerErrorText(result.payload, settings.apiKey)
  if (errorText) {
    if (isApiKeyRejection(errorText)) throw new SabnzbdAuthError(`SABnzbd rejected the NZB submission: ${errorText}`)
    throw new SabnzbdError(`SABnzbd rejected the NZB submission: ${errorText}`)
  }
  if (!result.ok) throw new SabnzbdError(`SABnzbd NZB submission failed (HTTP ${result.status})`)
  if (!isRecord(result.payload) || result.payload.status !== true) {
    throw new SabnzbdError('SABnzbd did not accept the NZB submission')
  }
  const rawIds = result.payload.nzo_ids
  const usable = Array.isArray(rawIds) && rawIds.length > 0 && rawIds.every((id) => typeof id === 'string' && id !== '')
  if (!usable) {
    // An accepted job without usable native IDs is not a usable receipt.
    throw new SabnzbdError('SABnzbd accepted the NZB but returned no usable nzo_ids')
  }
  return (rawIds as string[]).slice()
}

// --- controls ----------------------------------------------------------------
// SABnzbd answers many control operations with `status: true` even when the
// operation did not take effect, so every control is confirmed with a fresh
// targeted read. Confirmation reads that fail can never prove absence.

async function runControl(
  settings: SabnzbdSettings,
  params: Record<string, string>,
  operation: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = buildApiUrl(settings, { ...keyParams(settings), ...params })
  let result: JsonResult
  try {
    result = await requestJson(settings, url, { method: 'GET' }, READ_TIMEOUT_MS, fetchImpl)
  } catch (error) {
    throw new SabnzbdError(`SABnzbd ${operation} request failed: ${describeError(error, settings.apiKey)}`, { cause: error })
  }
  const errorText = providerErrorText(result.payload, settings.apiKey)
  if (errorText) {
    if (isApiKeyRejection(errorText)) throw new SabnzbdAuthError(`SABnzbd ${operation} failed: ${errorText}`)
    throw new SabnzbdError(`SABnzbd ${operation} failed: ${errorText}`)
  }
  if (!result.ok) throw new SabnzbdError(`SABnzbd ${operation} failed (HTTP ${result.status})`)
  if (!isRecord(result.payload) || result.payload.status !== true) {
    throw new SabnzbdError(`SABnzbd ${operation} failed: SABnzbd reported the operation was not successful`)
  }
}

export async function sabPauseJob(settings: SabnzbdSettings, nzoId: string, fetchImpl: typeof fetch): Promise<void> {
  await runControl(settings, { mode: 'queue', name: 'pause', value: nzoId }, 'job pause', fetchImpl)
  const read = await sabQueueJobs(settings, [nzoId], fetchImpl)
  if (!read.read_complete) throw new SabnzbdError('could not confirm the pause: SABnzbd queue state could not be read')
  const job = read.jobs.find((entry) => entry.nzo_id === nzoId)
  if (!job) throw new SabnzbdError(`could not confirm the pause: ${safeText(nzoId)} is no longer in the SABnzbd queue`)
  if (job.status !== 'Paused') {
    throw new SabnzbdError(`could not confirm the pause: ${safeText(nzoId)} reports status ${safeText(job.status) || 'unknown'}`)
  }
}

export async function sabResumeJob(settings: SabnzbdSettings, nzoId: string, fetchImpl: typeof fetch): Promise<void> {
  await runControl(settings, { mode: 'queue', name: 'resume', value: nzoId }, 'job resume', fetchImpl)
  const read = await sabQueueJobs(settings, [nzoId], fetchImpl)
  if (!read.read_complete) throw new SabnzbdError('could not confirm the resume: SABnzbd queue state could not be read')
  const job = read.jobs.find((entry) => entry.nzo_id === nzoId)
  if (!job) throw new SabnzbdError(`could not confirm the resume: ${safeText(nzoId)} is no longer in the SABnzbd queue`)
  if (job.status === 'Paused') throw new SabnzbdError(`could not confirm the resume: ${safeText(nzoId)} is still paused`)
}

export async function sabDeleteQueueJob(
  settings: SabnzbdSettings,
  nzoId: string,
  delFiles: boolean,
  fetchImpl: typeof fetch,
): Promise<void> {
  await runControl(settings, { mode: 'queue', name: 'delete', value: nzoId, del_files: delFiles ? '1' : '0' }, 'queue delete', fetchImpl)
  const read = await sabQueueJobs(settings, [nzoId], fetchImpl)
  if (!read.read_complete) throw new SabnzbdError('could not confirm the queue deletion: SABnzbd queue state could not be read')
  const job = read.jobs.find((entry) => entry.nzo_id === nzoId)
  // Absence from the queue is success even if the job already moved into
  // history (post-processing race); the history record stays addressable.
  if (job) {
    throw new SabnzbdError(`could not confirm the queue deletion: ${safeText(nzoId)} is still in the SABnzbd queue with status ${safeText(job.status) || 'unknown'}`)
  }
}

export async function sabDeleteHistoryJob(
  settings: SabnzbdSettings,
  nzoId: string,
  delFiles: boolean,
  fetchImpl: typeof fetch,
): Promise<void> {
  // archive=0 removes the record outright instead of moving it to the archive.
  await runControl(settings, { mode: 'history', name: 'delete', value: nzoId, archive: '0', del_files: delFiles ? '1' : '0' }, 'history delete', fetchImpl)
  const read = await sabHistoryJobs(settings, [nzoId], fetchImpl)
  if (!read.read_complete) throw new SabnzbdError('could not confirm the history deletion: SABnzbd history state could not be read')
  const job = read.jobs.find((entry) => entry.nzo_id === nzoId)
  if (job) {
    throw new SabnzbdError(`could not confirm the history deletion: ${safeText(nzoId)} is still in SABnzbd history or archive with status ${safeText(job.status) || 'unknown'}`)
  }
}

// --- endpoint identity ---------------------------------------------------------

// Credential-free normalized identity for job ownership: scheme, lowercase
// host (with non-default port), and path with a trailing /api removed. A
// rotated key or an added trailing slash must not orphan existing jobs.
export function sabEndpointId(apiUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error('Invalid SABnzbd API URL: expected an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid SABnzbd API URL: only http and https endpoints are supported')
  }
  let path = parsed.pathname
  while (path.endsWith('/')) path = path.slice(0, -1)
  if (path.endsWith(API_PATH_SUFFIX)) path = path.slice(0, -API_PATH_SUFFIX.length)
  return `${parsed.protocol}//${parsed.host}${path}`
}
