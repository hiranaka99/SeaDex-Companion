import type { Config, ResultItem } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { currentGeneration } from './config-generation.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
import type { EstimatableRelease } from '../shared/download-estimate.js'
import type { UsenetAvailabilityResult, UsenetFailureCode, UsenetHashAvailability, UsenetProvider, UsenetUnitState } from '../shared/usenet-contracts.js'
import { lookupAnimeTosho, fetchAnimeToshoNzb } from './animetosho.js'
import { lookupAmeNZB, fetchAmeNZBNzb } from './amenzb.js'
import { HASH_PATTERN, type ProviderLookup, type ProviderSettings } from './usenet-provider-types.js'

const POSITIVE_TTL_MS = 15 * 60_000
const NEGATIVE_TTL_MS = 5 * 60_000
const PROCESSING_TTL_MS = 2 * 60_000
const FAILURE_TTL_MS = 60_000
const CACHE_LIMIT = 4000
const LOOKUP_CONCURRENCY = 4
const FILE_NAME_LIMIT = 200

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
}

function acquireSlot(): Promise<void> {
  if (activeLookups < LOOKUP_CONCURRENCY) { activeLookups++; return Promise.resolve() }
  return new Promise<void>(resolve => waitingForSlot.push({ run: () => { activeLookups++; resolve() } }))
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

async function providerLookup(config: Config, provider: UsenetProvider, hash: string, refresh: boolean): Promise<ProviderLookup> {
  const key = `${currentGeneration()}:${provider}:${hash}`
  if (!refresh) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.lookup
  }
  const running = inFlight.get(key)
  if (running) return running
  const settings = providerSettings(config, provider)
  if (!settings) return { kind: 'failed', code: 'invalid_config', message: 'Provider is not enabled or not configured' }
  const promise = (async () => {
    await acquireSlot()
    try {
      return provider === 'animetosho'
        ? await lookupAnimeTosho(settings, hash, globalThis.fetch)
        : await lookupAmeNZB(settings, hash, globalThis.fetch)
    } catch (error) {
      log('WARNING', `Usenet provider lookup failed (${provider}): ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`)
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
export async function resolveUsenetHash(config: Config, hash: string, refresh = false): Promise<UsenetHashAvailability> {
  if (!HASH_PATTERN.test(hash)) return { hash, state: 'unsupported_hash' }
  const enabled = usenetProvidersEnabled(config)
  const queried: { provider: UsenetProvider; result: UsenetHashAvailability }[] = []
  let failed: UsenetHashAvailability | null = null
  const providersFailed: UsenetProvider[] = []
  for (const provider of ['animetosho', 'amenzb'] as UsenetProvider[]) {
    if (!enabled[provider]) continue
    const lookup = await providerLookup(config, provider, hash, refresh)
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

export async function resolveUsenetRelease(config: Config, release: EstimatableRelease, refresh = false): Promise<{ hashes: UsenetHashAvailability[]; aggregate: UsenetUnitState }> {
  const hashes = torrentHashes(release)
  if (!hashes.length) return { hashes: [{ hash: '', state: 'unsupported_hash' }], aggregate: 'unsupported_hash' }
  const results = await Promise.all(hashes.map(hash => resolveUsenetHash(config, hash, refresh)))
  return { hashes: results, aggregate: aggregateHashStates(results.map(result => result.state)) }
}

export async function usenetAvailability(config: Config, selections: { key: string; release: number; identity?: string }[], refresh = false, results: ResultItem[]): Promise<UsenetAvailabilityResult[]> {
  const checkedAt = new Date().toISOString()
  return Promise.all(selections.map(async selection => {
    const result = results.find(candidate => candidate.key === selection.key)
    const release = result?.releases?.[selection.release]
    if (!release) return { key: selection.key, release: selection.release, ...(selection.identity ? { identity: selection.identity } : {}), hashes: [{ hash: '', state: 'unsupported_hash' as UsenetUnitState }], aggregate: 'unsupported_hash' as UsenetUnitState, checked_at: checkedAt }
    const { hashes, aggregate } = await resolveUsenetRelease(config, release, refresh)
    return { key: selection.key, release: selection.release, ...(selection.identity ? { identity: selection.identity } : {}), hashes, aggregate, checked_at: checkedAt }
  }))
}

/** Server-side NZB retrieval for an accepted submission. Never trusts browser-supplied URLs. */
export async function fetchUsenetNzb(config: Config, provider: UsenetProvider, entryId: string, sourceHash: string): Promise<Uint8Array> {
  const lookup = await providerLookup(config, provider, sourceHash, false)
  if (lookup.kind !== 'match' || lookup.match.entry_id !== entryId) throw new Error('The provider mirror for this download is no longer available. Re-run the review before submitting.')
  const settings = providerSettings(config, provider)
  if (!settings) throw new Error('The Usenet provider used by this plan is no longer configured')
  return provider === 'animetosho'
    ? await fetchAnimeToshoNzb(settings, lookup.match, globalThis.fetch)
    : await fetchAmeNZBNzb(settings, lookup.match, globalThis.fetch)
}
