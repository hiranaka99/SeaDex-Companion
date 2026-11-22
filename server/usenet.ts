import type { Config, ResultItem } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
import { releaseIdentity } from '../shared/releases.js'
import type { EstimatableRelease } from '../shared/download-estimate.js'
import type { UsenetAvailabilityResult, UsenetFailureCode, UsenetHashAvailability, UsenetProvider, UsenetUnitState } from '../shared/usenet-contracts.js'
import { lookupAnimeTosho, fetchAnimeToshoNzb } from './animetosho.js'
import { lookupAmeNZB, fetchAmeNZBNzb } from './amenzb.js'
import { HASH_PATTERN, LOOKUP_TIMEOUT_MS, type ProviderLookup, type ProviderSettings } from './usenet-provider-types.js'

const POSITIVE_TTL_MS = 15 * 60_000
const NEGATIVE_TTL_MS = 5 * 60_000
const PROCESSING_TTL_MS = 2 * 60_000
const FAILURE_TTL_MS = 60_000
const CACHE_LIMIT = 4000
const LOOKUP_CONCURRENCY = 4
const LOOKUP_GUARD_MS = LOOKUP_TIMEOUT_MS + 5_000
const FILE_NAME_LIMIT = 200

/**
 * Minimum spacing between provider requests. Background sweeps run at these
 * rates indefinitely; 1 req/2s per indexer stays well inside what the public
 * AnimeTosho mirror and AmeNZB tolerate (stalling and rate-limit errors were
 * observed at 1 req/s during startup sweeps).
 */
const PROVIDER_MIN_INTERVAL_MS: Record<UsenetProvider, number> = { animetosho: 2_000, amenzb: 2_000 }

export function setUsenetProviderMinIntervalMs(provider: UsenetProvider, ms: number): void {
  PROVIDER_MIN_INTERVAL_MS[provider] = ms
}

interface ProviderPacer {
  lastStartedAt: number
  timer?: NodeJS.Timeout
}
const providerPacers: Record<UsenetProvider, ProviderPacer> = {
  animetosho: { lastStartedAt: 0 },
  amenzb: { lastStartedAt: 0 },
}

interface LookupJob {
  provider: UsenetProvider
  background: boolean
  controller: AbortController
}
type LookupResult = ProviderLookup | { kind: 'cancelled' }

interface LookupWaiter {
  job: LookupJob
  run: () => void
  cancel: () => void
}

/** Assign global capacity only when a provider request can actually start. */
function pumpLookups(): void {
  for (const pacer of Object.values(providerPacers)) {
    clearTimeout(pacer.timer)
    pacer.timer = undefined
  }
  while (activeLookups < LOOKUP_CONCURRENCY && waitingForSlot.length) {
    const now = Date.now()
    const ready = (entry: LookupWaiter) => now >= providerPacers[entry.job.provider].lastStartedAt + PROVIDER_MIN_INTERVAL_MS[entry.job.provider]
    let index = waitingForSlot.findIndex(entry => !entry.job.background && ready(entry))
    if (index === -1) index = waitingForSlot.findIndex(ready)
    if (index === -1) break
    const entry = waitingForSlot.splice(index, 1)[0]
    entry.job.controller.signal.removeEventListener('abort', entry.cancel)
    activeLookups++
    providerPacers[entry.job.provider].lastStartedAt = now
    entry.run()
  }
  if (activeLookups >= LOOKUP_CONCURRENCY) return
  for (const provider of ['animetosho', 'amenzb'] as UsenetProvider[]) {
    if (!waitingForSlot.some(entry => entry.job.provider === provider)) continue
    const pacer = providerPacers[provider]
    const wait = Math.max(0, pacer.lastStartedAt + PROVIDER_MIN_INTERVAL_MS[provider] - Date.now())
    pacer.timer = setTimeout(() => { pacer.timer = undefined; pumpLookups() }, wait)
  }
}

/** Provider failure warnings repeat at most once per minute per provider; sweeps must not spam the log. */
const lastFailureLogged = new Map<UsenetProvider, { at: number; message: string }>()
function logProviderFailure(provider: UsenetProvider, message: string): void {
  const previous = lastFailureLogged.get(provider)
  if (previous && previous.message === message && Date.now() - previous.at < 60_000) return
  lastFailureLogged.set(provider, { at: Date.now(), message })
  log('WARNING', `Usenet provider lookup failed (${provider}): ${message}`)
}

/**
 * Rejects when `work` has not settled within `guardMs`. The provider fetches
 * carry their own timeouts; this wall-clock guard is the last line of defense
 * so one never-settling call cannot poison inFlight/cache for the lifetime of
 * the process. The guard timer never keeps the event loop alive.
 */
export async function raceWithWallClockGuard<T>(work: Promise<T>, guardMs: number): Promise<T> {
  const guard = Promise.withResolvers<never>()
  const timer = setTimeout(() => guard.reject(new Error('lookup exceeded the wall-clock guard')), guardMs)
  timer.unref?.()
  try {
    return await Promise.race([work, guard.promise])
  } finally {
    clearTimeout(timer)
  }
}

export function usenetConfigured(config: Config): boolean {
  return Boolean((config.animetosho_enabled && config.animetosho_url) || (config.amenzb_enabled && config.amenzb_url && config.amenzb_key))
}

export function sabnzbdConfigured(config: Config): boolean {
  return Boolean(sabnzbdApiUrl(config) && config.sabnzbd_key)
}

export function usenetProvidersEnabled(config: Config): Record<UsenetProvider, boolean> {
  return {
    animetosho: Boolean(config.animetosho_enabled && config.animetosho_url),
    amenzb: Boolean(config.amenzb_enabled && config.amenzb_url && config.amenzb_key),
  }
}

function providerSettings(config: Config, provider: UsenetProvider): ProviderSettings | null {
  if (provider === 'animetosho') return config.animetosho_enabled && config.animetosho_url ? { baseUrl: config.animetosho_url } : null
  return config.amenzb_enabled && config.amenzb_url && config.amenzb_key ? { baseUrl: config.amenzb_url, apiKey: config.amenzb_key } : null
}

let cache = new Map<string, { at: number; ttl: number; lookup: ProviderLookup }>()
let inFlight = new Map<string, { promise: Promise<LookupResult>; job: LookupJob }>()
let activeLookups = 0
let lookupEpoch = 0
const waitingForSlot: LookupWaiter[] = []

export function invalidateUsenetLookups(): void {
  lookupEpoch++
  cache = new Map()
  const cancelled = inFlight
  inFlight = new Map()
  for (const { job } of cancelled.values()) job.controller.abort()
  pumpLookups()
}

function acquireSlot(job: LookupJob): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (job.controller.signal.aborted) { reject(job.controller.signal.reason); return promise }
  const entry: LookupWaiter = {
    job,
    run: resolve,
    cancel: () => {
      const index = waitingForSlot.indexOf(entry)
      if (index !== -1) waitingForSlot.splice(index, 1)
      reject(job.controller.signal.reason)
      pumpLookups()
    },
  }
  job.controller.signal.addEventListener('abort', entry.cancel, { once: true })
  waitingForSlot.push(entry)
  pumpLookups()
  return promise
}

function releaseSlot(): void {
  activeLookups--
  pumpLookups()
}

async function cancelableLookup<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancellation = Promise.withResolvers<never>()
  const cancel = () => cancellation.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try { return await Promise.race([work, cancellation.promise]) }
  finally { signal.removeEventListener('abort', cancel) }
}

function ttlFor(lookup: ProviderLookup): number {
  if (lookup.kind === 'match' || lookup.kind === 'deleted') return POSITIVE_TTL_MS
  if (lookup.kind === 'processing') return PROCESSING_TTL_MS
  if (lookup.kind === 'no_match') return NEGATIVE_TTL_MS
  return FAILURE_TTL_MS
}

async function providerLookup(config: Config, provider: UsenetProvider, hash: string, refresh: boolean, background: boolean): Promise<LookupResult> {
  const key = `${currentGeneration()}:${provider}:${hash}`
  if (!refresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.lookup
    // A refresh must never join a running lookup: an explicit Re-check is the
    // user's escape route when an earlier request wedged on a dead network path.
    const running = inFlight.get(key)
    if (running) {
      if (!background) { running.job.background = false; pumpLookups() }
      return running.promise
    }
  }
  const settings = providerSettings(config, provider)
  if (!settings) return { kind: 'failed', code: 'invalid_config', message: 'Provider is not enabled or not configured' }
  if (refresh) inFlight.get(key)?.job.controller.abort()
  const job: LookupJob = { provider, background, controller: new AbortController() }
  settings.signal = job.controller.signal
  const promise = (async () => {
    let acquired = false
    try {
      await acquireSlot(job)
      acquired = true
      job.controller.signal.throwIfAborted()
      return await raceWithWallClockGuard(
        cancelableLookup(
          provider === 'animetosho'
            ? lookupAnimeTosho(settings, hash, globalThis.fetch)
            : lookupAmeNZB(settings, hash, globalThis.fetch),
          job.controller.signal,
        ),
        LOOKUP_GUARD_MS,
      )
    } catch (error) {
      if (job.controller.signal.aborted) return { kind: 'cancelled' as const }
      job.controller.abort()
      logProviderFailure(provider, error instanceof Error ? error.message.slice(0, 160) : 'unknown error')
      return { kind: 'failed' as const, code: 'network' as UsenetFailureCode, message: 'Provider lookup failed' }
    } finally {
      if (acquired) releaseSlot()
    }
  })()
  const flight = { promise, job }
  const generation = currentGeneration()
  inFlight.set(key, flight)
  try {
    const lookup = await promise
    if (lookup.kind !== 'cancelled' && inFlight.get(key) === flight && currentGeneration() === generation && !job.controller.signal.aborted) {
      cache.set(key, { at: Date.now(), ttl: ttlFor(lookup), lookup })
      if (cache.size > CACHE_LIMIT) {
        const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, cache.size - CACHE_LIMIT)
        for (const [stale] of oldest) cache.delete(stale)
      }
    }
    return lookup
  } finally {
    if (inFlight.get(key) === flight) inFlight.delete(key)
  }
}

function hashState(provider: UsenetProvider, lookup: ProviderLookup): UsenetHashAvailability {
  switch (lookup.kind) {
    case 'match':
      return {
        hash: lookup.match.source_hash, state: 'available', provider, entry_id: lookup.match.entry_id,
        ...(lookup.match.title ? { title: lookup.match.title } : {}),
        ...(typeof lookup.match.total_bytes === 'number' ? { total_bytes: lookup.match.total_bytes } : {}),
        files_known: lookup.match.files_complete,
        ...(lookup.match.file_count !== undefined ? { file_count: lookup.match.file_count } : {}),
        ...(lookup.match.files ? { file_count: lookup.match.files.length, file_names: lookup.match.files.map(file => file.name) } : {}),
      }
    case 'processing':
      return { hash: lookup.source_hash, state: 'processing', provider, entry_id: lookup.entry_id, ...(lookup.title ? { title: lookup.title } : {}) }
    case 'deleted':
      return { hash: '', state: 'no_match', provider, entry_id: lookup.entry_id }
    case 'no_match':
      return { hash: '', state: 'no_match' }
    case 'failed':
      return { hash: '', state: 'lookup_failed', ...(provider ? { provider } : {}), error_code: lookup.code, error: lookup.message.slice(0, 200) }
  }
}

/** AnimeTosho first, then AmeNZB. A usable match from either is sufficient; failures never become no-match. */
export async function resolveUsenetHash(config: Config, hash: string, refresh = false, background = false): Promise<UsenetHashAvailability> {
  if (!HASH_PATTERN.test(hash)) return { hash, state: 'unsupported_hash' }
  const epoch = lookupEpoch
  const generation = currentGeneration()
  const enabled = usenetProvidersEnabled(config)
  const queried: { provider: UsenetProvider; result: UsenetHashAvailability }[] = []
  let failed: UsenetHashAvailability | null = null
  const providersFailed: UsenetProvider[] = []
  for (const provider of ['animetosho', 'amenzb'] as UsenetProvider[]) {
    if (!enabled[provider]) continue
    const lookup = await providerLookup(config, provider, hash, refresh, background)
    if (lookup.kind === 'cancelled' || epoch !== lookupEpoch || generation !== currentGeneration()) {
      return { hash, state: 'lookup_failed', error_code: 'network', error: 'lookup cancelled' }
    }
    const result = hashState(provider, lookup)
    if (result.state === 'available') return { ...result, hash }
    if (result.state === 'lookup_failed') { failed ??= result; providersFailed.push(provider) }
    else queried.push({ provider, result })
  }
  if (failed) {
    // An unresolved provider could still hold the match; absence is never definitive while one failed.
    return { hash, state: 'lookup_failed', error_code: failed.error_code, error: failed.error, providers_failed: providersFailed }
  }
  if (!queried.length) return { hash, state: 'not_configured' }
  const processing = queried.find(entry => entry.result.state === 'processing')
  if (processing) return { ...processing.result, hash }
  return { hash, state: 'no_match' }
}

/** A release is 'available' only when every required source hash matched. Mixed coverage is 'incomplete'. */
export function aggregateHashStates(states: UsenetUnitState[]): UsenetUnitState {
  if (!states.length) return 'unsupported_hash'
  if (states.every(state => state === 'available')) return 'available'
  if (states.includes('not_configured')) return 'not_configured'
  if (states.includes('unsupported_hash')) return 'unsupported_hash'
  if (states.includes('lookup_failed')) return 'lookup_failed'
  if (states.includes('available')) return 'incomplete'
  if (states.includes('processing')) return 'processing'
  return 'no_match'
}

export async function resolveUsenetRelease(config: Config, release: EstimatableRelease, refresh = false, background = false): Promise<{ hashes: UsenetHashAvailability[]; aggregate: UsenetUnitState }> {
  const hashes = torrentHashes(release)
  if (!hashes.length) return { hashes: [{ hash: '', state: 'unsupported_hash' }], aggregate: 'unsupported_hash' }
  const results = await Promise.all(hashes.map(hash => resolveUsenetHash(config, hash, refresh, background)))
  return { hashes: results, aggregate: aggregateHashStates(results.map(result => result.state)) }
}

export class UsenetSelectionError extends Error {
  constructor(public readonly status: 400 | 409, message: string) { super(message) }
}

export async function usenetAvailability(config: Config, selections: { key: string; release: number; identity?: string }[], refresh = false, results: ResultItem[], background = false): Promise<UsenetAvailabilityResult[]> {
  const checkedAt = new Date().toISOString()
  const selected = selections.map(selection => {
    const result = results.find(candidate => candidate.key === selection.key)
    const release = Number.isSafeInteger(selection.release) && selection.release >= 0 ? result?.releases?.[selection.release] : undefined
    if (!release) throw new UsenetSelectionError(400, 'The selected release no longer exists. Refresh the results before checking availability.')
    const identity = releaseIdentity(release)
    if (selection.identity !== undefined && selection.identity !== identity) {
      throw new UsenetSelectionError(409, 'The selected release changed. Refresh the results before checking availability.')
    }
    return { selection, release, identity }
  })
  return Promise.all(selected.map(async ({ selection, release, identity }) => {
    const { hashes, aggregate } = await resolveUsenetRelease(config, release, refresh, background)
    const publicHashes = hashes.map(hash => hash.file_names && hash.file_names.length > FILE_NAME_LIMIT
      ? { ...hash, files_known: false, file_names: hash.file_names.slice(0, FILE_NAME_LIMIT) }
      : hash)
    return { key: selection.key, release: selection.release, identity, hashes: publicHashes, aggregate, checked_at: checkedAt }
  }))
}

/** Server-side NZB retrieval for an accepted submission. Never trusts browser-supplied URLs. */
export async function fetchUsenetNzb(config: Config, provider: UsenetProvider, entryId: string, sourceHash: string): Promise<Uint8Array> {
  const lookup = await providerLookup(config, provider, sourceHash, false, false)
  if (lookup.kind !== 'match' || lookup.match.entry_id !== entryId) throw new Error('The provider mirror for this download is no longer available. Re-run the review before submitting.')
  const settings = providerSettings(config, provider)
  if (!settings) throw new Error('The Usenet provider used by this plan is no longer configured')
  return provider === 'animetosho'
    ? await fetchAnimeToshoNzb(settings, lookup.match, globalThis.fetch)
    : await fetchAmeNZBNzb(settings, lookup.match, globalThis.fetch)
}
