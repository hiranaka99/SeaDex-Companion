import type { Config, ResultItem } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
import { releaseIdentity } from '../shared/releases.js'
import type { EstimatableRelease } from '../shared/download-estimate.js'
import type { UsenetAvailabilityResult, UsenetHashAvailability, UsenetProvider, UsenetUnitState } from '../shared/usenet-contracts.js'
import { lookupAnimeTosho, fetchAnimeToshoNzb } from './animetosho.js'
import { lookupAmeNZB, fetchAmeNZBNzb } from './amenzb.js'
import { HASH_PATTERN, LOOKUP_TIMEOUT_MS, type ProviderLookup, type ProviderSettings } from './usenet-provider-types.js'
import { PersistentUsenetCache, providerFingerprint, usenetCacheKey } from './usenet-cache.js'

const POSITIVE_TTL_MS = 24 * 60 * 60_000
const NEGATIVE_TTL_MS = 60 * 60_000
const PROCESSING_TTL_MS = 2 * 60_000
const FAILURE_TTL_MS = 60_000
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
type LookupResult = { lookup: ProviderLookup; checkedAt: number } | { kind: 'cancelled' }

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

const cache = new PersistentUsenetCache()
let inFlight = new Map<string, { promise: Promise<LookupResult>; job: LookupJob }>()
interface RefreshChain { promise: Promise<UsenetHashAvailability>; cancelled: boolean }
let refreshChains = new Map<string, RefreshChain>()
let activeLookups = 0
let lookupEpoch = 0
const waitingForSlot: LookupWaiter[] = []

function cancelUsenetWork(): void {
  lookupEpoch++
  const cancelled = inFlight
  inFlight = new Map()
  for (const chain of refreshChains.values()) chain.cancelled = true
  refreshChains = new Map()
  for (const { job } of cancelled.values()) job.controller.abort()
  pumpLookups()
}

export function invalidateUsenetLookups(config: Config): void {
  cancelUsenetWork()
  cache.retainCompatible({
    animetosho: providerFingerprint('animetosho', { baseUrl: config.animetosho_url }),
    amenzb: providerFingerprint('amenzb', { baseUrl: config.amenzb_url, apiKey: config.amenzb_key }),
  })
}

export function resetUsenetLookups(restoreFromDisk = false): void {
  cancelUsenetWork()
  cache.reset(restoreFromDisk)
  for (const pacer of Object.values(providerPacers)) pacer.lastStartedAt = 0
  lastFailureLogged.clear()
}

export function flushUsenetCache(): boolean { return cache.flush() }

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
  if (lookup.kind === 'match') return POSITIVE_TTL_MS
  if (lookup.kind === 'processing') return PROCESSING_TTL_MS
  if (lookup.kind === 'no_match' || lookup.kind === 'deleted') return NEGATIVE_TTL_MS
  return FAILURE_TTL_MS
}

async function providerLookup(config: Config, provider: UsenetProvider, hash: string, refresh: boolean, background: boolean): Promise<LookupResult> {
  const settings = providerSettings(config, provider)
  if (!settings) return { lookup: { kind: 'failed', code: 'invalid_config', message: 'Provider is not enabled or not configured' }, checkedAt: 0 }
  const fingerprint = providerFingerprint(provider, settings)
  const key = usenetCacheKey(provider, fingerprint, hash)
  if (!refresh) {
    const running = inFlight.get(key)
    if (running) {
      if (!background) { running.job.background = false; pumpLookups() }
      return running.promise
    }
    const hit = cache.get(key)
    if (hit?.failure && Date.now() < hit.retryAt) return { lookup: hit.failure, checkedAt: 0 }
    if (hit?.lookup && !hit.failure && Date.now() - hit.checkedAt < ttlFor(hit.lookup)) return { lookup: hit.lookup, checkedAt: hit.checkedAt }
  }
  if (refresh) inFlight.get(key)?.job.controller.abort()
  const job: LookupJob = { provider, background, controller: new AbortController() }
  settings.signal = job.controller.signal
  const generation = currentGeneration()
  const epoch = lookupEpoch
  const work = (async (): Promise<ProviderLookup | { kind: 'cancelled' }> => {
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
      if (job.controller.signal.aborted) return { kind: 'cancelled' }
      logProviderFailure(provider, error instanceof Error ? error.message.slice(0, 160) : 'unknown error')
      return { kind: 'failed', code: 'network', message: 'Provider lookup failed' }
    } finally {
      if (acquired) releaseSlot()
    }
  })()
  const flight: { promise: Promise<LookupResult>; job: LookupJob } = {
    job,
    promise: work.then((lookup): LookupResult => {
      if (lookup.kind === 'cancelled' || inFlight.get(key) !== flight || currentGeneration() !== generation || lookupEpoch !== epoch || job.controller.signal.aborted) return { kind: 'cancelled' }
      const at = Date.now()
      const previous = cache.get(key)
      if (lookup.kind === 'failed') {
        logProviderFailure(provider, lookup.message)
        cache.set({ provider, fingerprint, hash, checkedAt: previous?.checkedAt || 0, lastAttemptAt: at, retryAt: at + FAILURE_TTL_MS, ...(previous?.lookup ? { lookup: previous.lookup } : {}), failure: lookup }, settings)
        job.controller.abort()
        return { lookup, checkedAt: 0 }
      }
      cache.set({ provider, fingerprint, hash, checkedAt: at, lastAttemptAt: at, retryAt: 0, lookup }, settings)
      return { lookup, checkedAt: at }
    }).finally(() => {
      if (inFlight.get(key) === flight) inFlight.delete(key)
    }),
  }
  inFlight.set(key, flight)
  return flight.promise
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

function availabilityMetadata(states: UsenetHashAvailability[]): Pick<UsenetAvailabilityResult, 'checked_at' | 'stale' | 'refreshing' | 'refresh_error'> {
  const times = states.map(state => state.checked_at).filter((time): time is string => Boolean(time)).sort()
  const errors = [...new Set(states.map(state => state.refresh_error).filter((error): error is string => Boolean(error)))]
  return { checked_at: times[0] || '', stale: states.some(state => state.stale === true), refreshing: states.some(state => state.refreshing === true), ...(errors.length ? { refresh_error: errors.join('; ').slice(0, 200) } : {}) }
}

/** Authoritative checks await fresh provider facts and never turn a failed refresh into stale success. */
async function resolveHash(config: Config, hash: string, refresh: boolean, background: boolean, ownsWork = () => true): Promise<UsenetHashAvailability> {
  if (!HASH_PATTERN.test(hash)) return { hash, state: 'unsupported_hash' }
  const epoch = lookupEpoch
  const generation = currentGeneration()
  const enabled = usenetProvidersEnabled(config)
  const queried: UsenetHashAvailability[] = []
  const providersFailed: UsenetProvider[] = []
  for (const provider of ['animetosho', 'amenzb'] as UsenetProvider[]) {
    if (!enabled[provider]) continue
    if (!ownsWork()) return { hash, state: 'lookup_failed', error_code: 'network', error: 'lookup cancelled' }
    const result = await providerLookup(config, provider, hash, refresh, background)
    if ('kind' in result || epoch !== lookupEpoch || generation !== currentGeneration() || !ownsWork()) {
      return { hash, state: 'lookup_failed', error_code: 'network', error: 'lookup cancelled' }
    }
    const state = { ...hashState(provider, result.lookup), hash, checked_at: result.checkedAt ? new Date(result.checkedAt).toISOString() : '', stale: false, refreshing: false }
    queried.push(state)
    if (state.state === 'available') return { ...state, ...availabilityMetadata(queried) }
    if (state.state === 'lookup_failed') providersFailed.push(provider)
  }
  const metadata = availabilityMetadata(queried)
  const failed = queried.find(state => state.state === 'lookup_failed')
  if (failed) return { hash, state: 'lookup_failed', error_code: failed.error_code, error: failed.error, providers_failed: providersFailed, ...metadata }
  if (!queried.length) return { hash, state: 'not_configured', ...metadata }
  const processing = queried.find(state => state.state === 'processing')
  if (processing) return { ...processing, hash, ...metadata }
  return { hash, state: 'no_match', ...metadata }
}

/** AnimeTosho first, then AmeNZB. A usable match from either is sufficient. */
export async function resolveUsenetHash(config: Config, hash: string, refresh = false, background = false): Promise<UsenetHashAvailability> {
  return resolveHash(config, hash, refresh, background)
}

function configuredProviderKeys(config: Config, hash: string) {
  return (['animetosho', 'amenzb'] as UsenetProvider[]).flatMap(provider => {
    const settings = providerSettings(config, provider)
    return settings ? [{ provider, key: usenetCacheKey(provider, providerFingerprint(provider, settings), hash) }] : []
  })
}


function scheduleHashRefresh(config: Config, hash: string, refresh: boolean, background: boolean): void {
  const keys = configuredProviderKeys(config, hash)
  if (!HASH_PATTERN.test(hash) || !keys.length) return
  const key = keys.map(entry => entry.key).join('|')
  const previous = refreshChains.get(key)
  if (previous && !refresh) {
    if (!background) {
      for (const entry of keys) {
        const running = inFlight.get(entry.key)
        if (running) running.job.background = false
      }
      pumpLookups()
    }
    return
  }
  if (refresh) {
    if (previous) previous.cancelled = true
    for (const entry of keys) inFlight.get(entry.key)?.job.controller.abort()
  }
  const chain: RefreshChain = {
    cancelled: false,
    promise: Promise.resolve().then(() => resolveHash(config, hash, refresh, background, () => !chain.cancelled)).finally(() => {
      if (refreshChains.get(key) === chain) refreshChains.delete(key)
    }),
  }
  refreshChains.set(key, chain)
  void chain.promise.catch(error => log('WARNING', `Usenet availability refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`))
}

function hashSnapshot(config: Config, hash: string): { result: UsenetHashAvailability; needsRefresh: boolean } {
  if (!HASH_PATTERN.test(hash)) return { result: { hash, state: 'unsupported_hash', stale: false, refreshing: false }, needsRefresh: false }
  const keys = configuredProviderKeys(config, hash)
  const queried: UsenetHashAvailability[] = []
  let needsRefresh = false
  let unknown = false
  const now = Date.now()
  for (const { provider, key } of keys) {
    const record = cache.get(key)
    const stale = Boolean(record?.lookup && (record.failure || now - record.checkedAt >= ttlFor(record.lookup)))
    const running = inFlight.has(key)
    if (!record || ((stale || !record.lookup) && now >= record.retryAt)) needsRefresh = true
    if (!record?.lookup && !record?.failure) unknown = true
    const result = record?.lookup ? hashState(provider, record.lookup)
      : record?.failure ? hashState(provider, record.failure) : { hash, state: 'not_checked' as const }
    const state = { ...result, hash, checked_at: record?.checkedAt ? new Date(record.checkedAt).toISOString() : '', stale, refreshing: running, ...(record?.failure ? { refresh_error: record.failure.message.slice(0, 200) } : {}) }
    queried.push(state)
    if (state.state === 'available') return { result: { ...state, ...availabilityMetadata(queried) }, needsRefresh }
  }
  const metadata = availabilityMetadata(queried)
  const failed = queried.find(state => state.state === 'lookup_failed')
  const processing = queried.find(state => state.state === 'processing')
  const result: UsenetHashAvailability = !keys.length ? { hash, state: 'not_configured', ...metadata }
    : failed ? { ...failed, hash, providers_failed: queried.filter(state => state.state === 'lookup_failed').map(state => state.provider!), ...metadata }
    : processing ? { ...processing, hash, ...metadata }
    : { hash, state: unknown ? 'not_checked' : 'no_match', ...metadata }
  return { result, needsRefresh }
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
  if (states.includes('not_checked')) return 'not_checked'
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
  const scheduled = new Set<string>()
  return selected.map(({ selection, release, identity }) => {
    const sourceHashes = torrentHashes(release)
    const hashes: UsenetHashAvailability[] = sourceHashes.length ? sourceHashes.map(hash => {
      const snapshot = hashSnapshot(config, hash)
      if ((refresh || snapshot.needsRefresh) && !scheduled.has(hash)) {
        scheduled.add(hash)
        scheduleHashRefresh(config, hash, refresh, background)
      }
      return { ...snapshot.result, refreshing: snapshot.result.refreshing === true || refreshChains.has(configuredProviderKeys(config, hash).map(entry => entry.key).join('|')) }
    }) : [{ hash: '', state: 'unsupported_hash', stale: false, refreshing: false }]
    const publicHashes = hashes.map(hash => hash.file_names && hash.file_names.length > FILE_NAME_LIMIT
      ? { ...hash, files_known: false, file_names: hash.file_names.slice(0, FILE_NAME_LIMIT) }
      : hash)
    return { key: selection.key, release: selection.release, identity, hashes: publicHashes, aggregate: aggregateHashStates(hashes.map(hash => hash.state)), ...availabilityMetadata(hashes) }
  })
}

/** Server-side NZB retrieval for an accepted submission. Never trusts browser-supplied URLs. */
export async function fetchUsenetNzb(config: Config, provider: UsenetProvider, entryId: string, sourceHash: string): Promise<Uint8Array> {
  const result = await providerLookup(config, provider, sourceHash, false, false)
  if ('kind' in result || result.lookup.kind !== 'match' || result.lookup.match.entry_id !== entryId) throw new Error('The provider mirror for this download is no longer available. Re-run the review before submitting.')
  const lookup = result.lookup
  const settings = providerSettings(config, provider)
  if (!settings) throw new Error('The Usenet provider used by this plan is no longer configured')
  return provider === 'animetosho'
    ? await fetchAnimeToshoNzb(settings, lookup.match, globalThis.fetch)
    : await fetchAmeNZBNzb(settings, lookup.match, globalThis.fetch)
}
