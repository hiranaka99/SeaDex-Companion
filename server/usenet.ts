import type { Config, ResultItem } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
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
  queue: { background: boolean; run: () => void }[]
  timer?: ReturnType<typeof setTimeout>
}
const providerPacers: Record<UsenetProvider, ProviderPacer> = {
  animetosho: { lastStartedAt: 0, queue: [] },
  amenzb: { lastStartedAt: 0, queue: [] },
}

/**
 * Starts provider requests no sooner than the provider's minimum interval
 * apart (the rate limit is about request spacing, not full serialization).
 * Interactive lookups overtake queued background lookups so opening a card
 * never waits behind a background sweep.
 */
function acquireProviderSlot(provider: UsenetProvider, background: boolean): Promise<void> {
  return new Promise<void>(resolve => {
    const pacer = providerPacers[provider]
    const entry = { background, run: () => { pacer.lastStartedAt = Date.now(); resolve() } }
    const firstBackground = pacer.queue.findIndex(item => item.background)
    pacer.queue.splice(background || firstBackground === -1 ? pacer.queue.length : firstBackground, 0, entry)
    pumpProvider(provider)
  })
}

function pumpProvider(provider: UsenetProvider): void {
  const pacer = providerPacers[provider]
  if (!pacer.queue.length || pacer.timer) return
  const wait = Math.max(0, pacer.lastStartedAt + PROVIDER_MIN_INTERVAL_MS[provider] - Date.now())
  if (wait > 0) { pacer.timer = setTimeout(() => { pacer.timer = undefined; pumpProvider(provider) }, wait); return }
  pacer.queue.shift()!.run()
  if (pacer.queue.length) pumpProvider(provider)
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
let inFlight = new Map<string, Promise<ProviderLookup>>()
let activeLookups = 0
const waitingForSlot: { run: () => void }[] = []

export function invalidateUsenetLookups(): void {
  cache = new Map()
  inFlight = new Map()
  for (const pacer of Object.values(providerPacers)) {
    if (pacer.timer) clearTimeout(pacer.timer)
    pacer.timer = undefined
    // Drain waiters instead of dropping them: an unresolved acquire would
    // wedge the queued lookup the same way a stuck fetch does.
    for (const entry of pacer.queue.splice(0)) entry.run()
    pacer.lastStartedAt = 0
  }
}

function acquireSlot(): Promise<void> {
  if (activeLookups < LOOKUP_CONCURRENCY) { activeLookups++; return Promise.resolve() }
  // The waiter inherits the releaser's slot: releaseSlot() skips the decrement when handing off, so the waiter must not increment.
  return new Promise<void>(resolve => waitingForSlot.push({ run: resolve }))
}

function releaseSlot(): void {
  const next = waitingForSlot.shift()
  if (next) next.run()
  else activeLookups--
}

function ttlFor(lookup: ProviderLookup): number {
  if (lookup.kind === 'match' || lookup.kind === 'deleted') return POSITIVE_TTL_MS
  if (lookup.kind === 'processing') return PROCESSING_TTL_MS
  if (lookup.kind === 'no_match') return NEGATIVE_TTL_MS
  return FAILURE_TTL_MS
}

async function providerLookup(config: Config, provider: UsenetProvider, hash: string, refresh: boolean, background: boolean): Promise<ProviderLookup> {
  const key = `${currentGeneration()}:${provider}:${hash}`
  if (!refresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.lookup
    // A refresh must never join a running lookup: an explicit Re-check is the
    // user's escape route when an earlier request wedged on a dead network path.
    const running = inFlight.get(key)
    if (running) return running
  }
  const settings = providerSettings(config, provider)
  if (!settings) return { kind: 'failed', code: 'invalid_config', message: 'Provider is not enabled or not configured' }
  const promise = (async () => {
    await acquireSlot()
    await acquireProviderSlot(provider, background)
    try {
      // The provider fetches carry their own timeouts; the wall-clock guard is
      // the last line of defense so one never-settling call cannot poison
      // inFlight/cache for the lifetime of the process.
      return await raceWithWallClockGuard(
        provider === 'animetosho'
          ? lookupAnimeTosho(settings, hash, globalThis.fetch)
          : lookupAmeNZB(settings, hash, globalThis.fetch),
        LOOKUP_GUARD_MS,
      )
    } catch (error) {
      logProviderFailure(provider, error instanceof Error ? error.message.slice(0, 160) : 'unknown error')
      return { kind: 'failed' as const, code: 'network' as UsenetFailureCode, message: 'Provider lookup failed' }
    } finally {
      releaseSlot()
    }
  })()
  inFlight.set(key, promise)
  try {
    const lookup = await promise
    cache.set(key, { at: Date.now(), ttl: ttlFor(lookup), lookup })
    if (cache.size > CACHE_LIMIT) {
      const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, cache.size - CACHE_LIMIT)
      for (const [stale] of oldest) cache.delete(stale)
    }
    return lookup
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key)
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
        ...(lookup.match.files ? { file_count: lookup.match.files.length, file_names: lookup.match.files.slice(0, FILE_NAME_LIMIT).map(file => file.name) } : {}),
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
  const enabled = usenetProvidersEnabled(config)
  const queried: { provider: UsenetProvider; result: UsenetHashAvailability }[] = []
  let failed: UsenetHashAvailability | null = null
  const providersFailed: UsenetProvider[] = []
  for (const provider of ['animetosho', 'amenzb'] as UsenetProvider[]) {
    if (!enabled[provider]) continue
    const lookup = await providerLookup(config, provider, hash, refresh, background)
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

export async function usenetAvailability(config: Config, selections: { key: string; release: number; identity?: string }[], refresh = false, results: ResultItem[], background = false): Promise<UsenetAvailabilityResult[]> {
  const checkedAt = new Date().toISOString()
  return Promise.all(selections.map(async selection => {
    const result = results.find(candidate => candidate.key === selection.key)
    const release = result?.releases?.[selection.release]
    if (!release) return { key: selection.key, release: selection.release, ...(selection.identity ? { identity: selection.identity } : {}), hashes: [{ hash: '', state: 'unsupported_hash' as UsenetUnitState }], aggregate: 'unsupported_hash' as UsenetUnitState, checked_at: checkedAt }
    const { hashes, aggregate } = await resolveUsenetRelease(config, release, refresh, background)
    return { key: selection.key, release: selection.release, ...(selection.identity ? { identity: selection.identity } : {}), hashes, aggregate, checked_at: checkedAt }
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
