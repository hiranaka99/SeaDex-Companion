import type { Config } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { HttpError } from './http-error.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
import { INFO_HASH_PATTERN } from '../shared/ids.js'
import type { EstimatableRelease } from '../shared/download-estimate.js'
import type {
  UsenetAvailabilityResult,
  UsenetHashAvailability,
  UsenetProvider,
  UsenetSource,
  UsenetUnitState,
} from '../shared/usenet-contracts.js'
import type { SourceFile } from './source-files.js'
import { searchNzbBytes, usenetSearchPauses } from './usenet-search.js'
import { LOOKUP_TIMEOUT_MS } from './indexer-http.js'
import type { ProviderLookup, ProviderSettings } from './usenet-provider-types.js'
import { PersistentUsenetCache, providerFingerprint, usenetCacheKey } from './usenet-cache.js'
import { providerSettings, USENET_PROVIDER_IDS, USENET_PROVIDERS } from './usenet-providers.js'
import { usenetParts } from './usenet-runtime.js'
import { FlightTable, LookupEpoch, WarningThrottle, type Flight } from './lookup-flights.js'
import {
  LookupScheduler,
  ProviderPausedError,
  TRANSIENT_CODES,
  type ChannelPause,
  type LookupOutcome,
  type LookupPacing,
} from './usenet-scheduler.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A usable source rarely disappears, and submission fetches and validates the real NZB anyway. */
const POSITIVE_TTL_MS = 7 * DAY
/** Consecutive absences back off: a source missing for weeks is unlikely to appear within the hour. */
const NEGATIVE_TTL_STEPS_MS = [HOUR, 6 * HOUR, DAY, 7 * DAY]
/** Recent AnimeTosho entries gain their NZB within hours; older ones are classified as absent. */
const PROCESSING_TTL_MS = 10 * MINUTE
const FAILURE_TTL_MS = MINUTE
const LOOKUP_GUARD_MS = LOOKUP_TIMEOUT_MS + 5_000
/** The most file names a public availability row lists. */
export const FILE_NAME_LIMIT = 200
/** Background lookups wait out a pause and retry instead of recording a failure. */
const BACKGROUND_ATTEMPTS = 3

/**
 * What the hash-indexer lookups run on: their scheduler, cache, clock and fetch, and the lookups under way. A
 * Usenet runtime (`usenet-runtime.ts`) builds it, owns it and drives its lifecycle.
 */
export class HashLookupParts {
  /** Paces and prioritizes every hash-indexer request, one channel per provider. */
  readonly scheduler: LookupScheduler
  readonly cache: PersistentUsenetCache
  readonly now: () => number
  readonly fetch: typeof fetch
  /** Provider failure warnings repeat at most once per minute per provider; sweeps must not spam the log. */
  readonly warnings = new WarningThrottle({ now: () => this.now() })
  /** Invalidated when provider configuration changes; results of older work are discarded. */
  readonly epoch = new LookupEpoch()
  /** One provider lookup of one hash, across the attempts it takes, by cache key. */
  readonly lookups = new FlightTable<LookupResult>(this.epoch)
  /** The background refresh of one hash across its providers, by `refreshKey`. */
  readonly refreshes = new FlightTable<UsenetHashAvailability>(this.epoch)

  /** The parts with this clock, fetch, cache file and pacing over the defaults. */
  constructor(options: { now: () => number; fetch: typeof fetch; cacheFile?: string; pacing?: Partial<LookupPacing> }) {
    this.now = options.now
    this.fetch = options.fetch
    this.cache = new PersistentUsenetCache(options.cacheFile)
    this.scheduler = new LookupScheduler(
      { concurrency: 4, foregroundReserved: 1, minIntervalMs: 2_000, ...options.pacing },
      this.now,
    )
    for (const provider of USENET_PROVIDER_IDS)
      this.scheduler.describe(provider, { label: USENET_PROVIDERS[provider].label })
  }

  /** Changed hash-indexer settings: running lookups are cancelled and observations of other settings dropped. */
  invalidate(config: Config): void {
    this.epoch.invalidate()
    this.cache.retainCompatible(
      Object.fromEntries(
        USENET_PROVIDER_IDS.map(provider => [
          provider,
          providerFingerprint(provider, USENET_PROVIDERS[provider].connection(config)),
        ]),
      ) as Record<UsenetProvider, string>,
    )
  }

  /** Writes pending observations now. False when the write failed. */
  flush(): boolean {
    return this.cache.flush()
  }

  /** Forgets observations for source hashes that are not in `hashes`. */
  retain(hashes: ReadonlySet<string>): number {
    return this.cache.retainHashes(hashes)
  }

  /**
   * Replaced by another runtime: running lookups are cancelled and what they learn is discarded, and the cache
   * writes nothing it had pending, as a process that exits.
   */
  discard(): void {
    this.epoch.invalidate()
    this.cache.reset()
  }
}

/** The hash-indexer parts of the runtime in use. */
const parts = (): HashLookupParts => usenetParts().hash

/** Active pauses of the hash indexers and of the Usenet indexers in Prowlarr, for status reporting. */
export function usenetProviderPauses(): ChannelPause[] {
  return [...parts().scheduler.pauses(), ...usenetSearchPauses()]
}

export function usenetProvidersEnabled(config: Config): Record<UsenetProvider, boolean> {
  return Object.fromEntries(
    USENET_PROVIDER_IDS.map(provider => [provider, USENET_PROVIDERS[provider].usable(config)]),
  ) as Record<UsenetProvider, boolean>
}

export function usenetConfigured(config: Config): boolean {
  return USENET_PROVIDER_IDS.some(provider => USENET_PROVIDERS[provider].usable(config))
}

export function sabnzbdConfigured(config: Config): boolean {
  return Boolean(sabnzbdApiUrl(config) && config.sabnzbd_key)
}

function logProviderFailure(provider: UsenetProvider, message: string): void {
  parts().warnings.warn(provider, `Usenet provider lookup failed (${provider}): ${message}`)
}

/** An error no provider client classified: logged in bounded form and reported as a network failure. */
function unexpectedFailure(provider: UsenetProvider, error: unknown): ProviderLookup {
  logProviderFailure(provider, error instanceof Error ? error.message.slice(0, 160) : 'unknown error')
  return { kind: 'failed', code: 'network', message: 'Provider lookup failed' }
}

/** What one provider lookup came to: an answer worth caching, or nothing because the work was superseded. */
type LookupResult = { kind: 'settled'; lookup: ProviderLookup; checkedAt: number } | typeof CANCELLED
const CANCELLED = { kind: 'cancelled' } as const

const isAbsence = (lookup: ProviderLookup | undefined) => lookup?.kind === 'no_match' || lookup?.kind === 'deleted'

function ttlFor(lookup: ProviderLookup, negativeStreak = 1): number {
  if (lookup.kind === 'match') return POSITIVE_TTL_MS
  if (lookup.kind === 'processing') return PROCESSING_TTL_MS
  if (isAbsence(lookup))
    return NEGATIVE_TTL_STEPS_MS[Math.min(Math.max(negativeStreak, 1), NEGATIVE_TTL_STEPS_MS.length) - 1]
  return FAILURE_TTL_MS
}

/** What an error no provider client classified tells the channel: the provider is not answering. */
const UNEXPECTED: LookupOutcome = { kind: 'failed', code: 'network' }

/** Schedules attempts until the provider answers. Background work waits out a pause rather than recording a transient failure. */
async function runLookup(
  flight: Flight<LookupResult>,
  provider: UsenetProvider,
  settings: ProviderSettings,
  hash: string,
): Promise<ProviderLookup | { kind: 'cancelled' }> {
  const { signal } = flight
  for (let attempt = 1; ; attempt++) {
    let answer: ProviderLookup
    try {
      answer = await flight.wait(
        parts().scheduler.schedule({
          channel: provider,
          background: flight.background,
          signal,
          guardMs: LOOKUP_GUARD_MS,
          work: () => USENET_PROVIDERS[provider].lookup(settings, hash, parts().fetch),
          outcome: settled => (settled.ok ? settled.value : UNEXPECTED),
        }),
      )
    } catch (error) {
      if (error instanceof ProviderPausedError) return parts().scheduler.pausedFailure(provider, error.until)
      if (signal.aborted) return CANCELLED
      answer = unexpectedFailure(provider, error)
    }
    const retry =
      answer.kind === 'failed' &&
      flight.background &&
      attempt < BACKGROUND_ATTEMPTS &&
      TRANSIENT_CODES.has(answer.code) &&
      parts().scheduler.isPaused(provider)
    if (!retry) return answer
  }
}

/** One provider's answer for one hash: a fresh cached observation, the lookup already running, or a new request. */
async function providerLookup(
  config: Config,
  provider: UsenetProvider,
  hash: string,
  refresh: boolean,
  background: boolean,
): Promise<LookupResult> {
  const connection = providerSettings(config, provider)
  if (!connection)
    return {
      kind: 'settled',
      lookup: { kind: 'failed', code: 'invalid_config', message: 'Provider is not enabled or not configured' },
      checkedAt: 0,
    }
  const fingerprint = providerFingerprint(provider, connection)
  const key = usenetCacheKey(provider, fingerprint, hash)
  // A refresh starts a lookup of its own, which cancels the one running.
  if (!refresh) {
    const running = parts().lookups.join(key, background)
    if (running) return running.promise
    const hit = parts().cache.get(key)
    if (hit?.failure && parts().now() < hit.retryAt) return { kind: 'settled', lookup: hit.failure, checkedAt: 0 }
    if (hit?.lookup && !hit.failure && parts().now() - hit.checkedAt < ttlFor(hit.lookup, hit.negativeStreak))
      return { kind: 'settled', lookup: hit.lookup, checkedAt: hit.checkedAt }
  }
  return parts().lookups.start(key, { background }, flight =>
    runLookup(flight, provider, { ...connection, signal: flight.signal }, hash).then((lookup): LookupResult => {
      if (lookup.kind === 'cancelled' || !flight.current) return CANCELLED
      const at = parts().now()
      const previous = parts().cache.get(key)
      if (lookup.kind === 'failed') {
        // A failed refresh keeps the previous observation next to the retry state.
        logProviderFailure(provider, lookup.message)
        const retryAt =
          at + Math.max(FAILURE_TTL_MS, lookup.retry_after_ms || 0, parts().scheduler.pausedUntil(provider) - at)
        parts().cache.set(
          {
            provider,
            fingerprint,
            hash,
            checkedAt: previous?.checkedAt || 0,
            lastAttemptAt: at,
            retryAt,
            ...(previous?.lookup ? { lookup: previous.lookup } : {}),
            failure: lookup,
            ...(previous?.negativeStreak ? { negativeStreak: previous.negativeStreak } : {}),
          },
          connection,
        )
        flight.abort()
        return { kind: 'settled', lookup, checkedAt: 0 }
      }
      const negativeStreak = isAbsence(lookup)
        ? (isAbsence(previous?.lookup) ? previous?.negativeStreak || 1 : 0) + 1
        : 0
      parts().cache.set(
        {
          provider,
          fingerprint,
          hash,
          checkedAt: at,
          lastAttemptAt: at,
          retryAt: 0,
          lookup,
          ...(negativeStreak ? { negativeStreak } : {}),
        },
        connection,
      )
      return { kind: 'settled', lookup, checkedAt: at }
    }),
  ).promise
}

/** One provider's lookup as the availability state of a source hash. The caller fills in the hash. */
function hashState(provider: UsenetProvider, lookup: ProviderLookup): UsenetHashAvailability {
  switch (lookup.kind) {
    case 'match':
      return {
        hash: lookup.match.source_hash,
        state: 'available',
        provider,
        entry_id: lookup.match.entry_id,
        ...(lookup.match.title ? { title: lookup.match.title } : {}),
        ...(typeof lookup.match.total_bytes === 'number' ? { total_bytes: lookup.match.total_bytes } : {}),
        files_known: lookup.match.files_complete,
        ...(lookup.match.file_count !== undefined ? { file_count: lookup.match.file_count } : {}),
        ...(lookup.match.files
          ? { file_count: lookup.match.files.length, file_names: lookup.match.files.map(file => file.name) }
          : {}),
      }
    case 'processing':
      return {
        hash: lookup.source_hash,
        state: 'processing',
        provider,
        entry_id: lookup.entry_id,
        ...(lookup.title ? { title: lookup.title } : {}),
      }
    case 'deleted':
      return { hash: '', state: 'no_match', provider, entry_id: lookup.entry_id }
    case 'no_match':
      return { hash: '', state: 'no_match', provider }
    case 'failed':
      return {
        hash: '',
        state: 'lookup_failed',
        provider,
        error_code: lookup.code,
        error: lookup.message.slice(0, 200),
      }
  }
}

export function availabilityMetadata(
  states: UsenetHashAvailability[],
): Pick<UsenetAvailabilityResult, 'checked_at' | 'stale' | 'refreshing' | 'refresh_error'> {
  const times = states
    .map(state => state.checked_at)
    .filter((time): time is string => Boolean(time))
    .sort()
  const errors = [
    ...new Set(states.map(state => state.refresh_error).filter((error): error is string => Boolean(error))),
  ]
  return {
    checked_at: times[0] || '',
    stale: states.some(state => state.stale === true),
    refreshing: states.some(state => state.refreshing === true),
    ...(errors.length ? { refresh_error: errors.join('; ').slice(0, 200) } : {}),
  }
}

/**
 * The state of one hash once no provider had a usable match: a failure outranks "still processing",
 * which outranks absence. `absent` is what absence means to the caller.
 */
function withoutMatch(
  hash: string,
  queried: UsenetHashAvailability[],
  absent: 'no_match' | 'not_checked',
): UsenetHashAvailability {
  const checked = [
    ...new Set(
      queried
        .filter(state => state.state === 'no_match' || state.state === 'processing')
        .map(state => state.provider)
        .filter((provider): provider is UsenetSource => Boolean(provider)),
    ),
  ]
  const metadata = { ...availabilityMetadata(queried), ...(checked.length ? { providers_checked: checked } : {}) }
  if (!queried.length) return { hash, state: 'not_configured', ...availabilityMetadata(queried) }
  const failed = queried.filter(state => state.state === 'lookup_failed')
  if (failed.length) return { ...failed[0], hash, providers_failed: failed.map(state => state.provider!), ...metadata }
  const processing = queried.find(state => state.state === 'processing')
  if (processing) return { ...processing, hash, ...metadata }
  return { hash, state: absent, ...metadata }
}

const isoTime = (time: number | undefined): string => (time ? new Date(time).toISOString() : '')

/**
 * AnimeTosho first, then AmeNZB; a usable match from either is sufficient. Authoritative checks
 * await fresh provider facts and never turn a failed refresh into stale success.
 */
export async function resolveUsenetHash(
  config: Config,
  hash: string,
  refresh = false,
  background = false,
  ownsWork = () => true,
): Promise<UsenetHashAvailability> {
  if (!INFO_HASH_PATTERN.test(hash)) return { hash, state: 'unsupported_hash' }
  const cancelled: UsenetHashAvailability = {
    hash,
    state: 'lookup_failed',
    error_code: 'network',
    error: 'lookup cancelled',
  }
  const current = parts().epoch.stamp()
  const queried: UsenetHashAvailability[] = []
  for (const provider of USENET_PROVIDER_IDS) {
    if (!USENET_PROVIDERS[provider].usable(config)) continue
    if (!ownsWork()) return cancelled
    const result = await providerLookup(config, provider, hash, refresh, background)
    if (result.kind === 'cancelled' || !current() || !ownsWork()) return cancelled
    const state = {
      ...hashState(provider, result.lookup),
      hash,
      checked_at: isoTime(result.checkedAt),
      stale: false,
      refreshing: false,
    }
    queried.push(state)
    if (state.state === 'available') return { ...state, ...availabilityMetadata(queried) }
  }
  return withoutMatch(hash, queried, 'no_match')
}

function configuredProviderKeys(config: Config, hash: string): { provider: UsenetProvider; key: string }[] {
  return USENET_PROVIDER_IDS.flatMap(provider => {
    const settings = providerSettings(config, provider)
    return settings ? [{ provider, key: usenetCacheKey(provider, providerFingerprint(provider, settings), hash) }] : []
  })
}

/** Identity of the background refresh of one hash under the current provider configuration. */
const refreshKey = (config: Config, hash: string): string =>
  configuredProviderKeys(config, hash)
    .map(entry => entry.key)
    .join('|')

function scheduleHashRefresh(config: Config, hash: string, refresh: boolean, background: boolean): void {
  const keys = configuredProviderKeys(config, hash)
  if (!INFO_HASH_PATTERN.test(hash) || !keys.length) return
  const key = refreshKey(config, hash)
  if (parts().refreshes.has(key) && !refresh) {
    // Someone is now waiting on work that started in the background.
    if (!background) for (const entry of keys) parts().lookups.join(entry.key, false)
    return
  }
  // A refresh cancels the refresh it replaces, and the lookups that one waits on.
  if (refresh) for (const entry of keys) parts().lookups.get(entry.key)?.abort()
  const chain = parts().refreshes.start(key, { background }, flight =>
    resolveUsenetHash(config, hash, refresh, background, () => flight.current),
  )
  void chain.promise.catch(error =>
    log('WARNING', `Usenet availability refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`),
  )
}

/** What the cache knows about one hash right now, and whether that is worth refreshing. Never waits on a provider. */
function hashSnapshot(config: Config, hash: string): { result: UsenetHashAvailability; needsRefresh: boolean } {
  if (!INFO_HASH_PATTERN.test(hash))
    return { result: { hash, state: 'unsupported_hash', stale: false, refreshing: false }, needsRefresh: false }
  const queried: UsenetHashAvailability[] = []
  let needsRefresh = false
  let unknown = false
  const now = parts().now()
  for (const { provider, key } of configuredProviderKeys(config, hash)) {
    const record = parts().cache.get(key)
    const stale = Boolean(
      record?.lookup && (record.failure || now - record.checkedAt >= ttlFor(record.lookup, record.negativeStreak)),
    )
    if (!record || ((stale || !record.lookup) && now >= record.retryAt)) needsRefresh = true
    if (!record?.lookup && !record?.failure) unknown = true
    const observed = record?.lookup ?? record?.failure
    const state: UsenetHashAvailability = {
      ...(observed ? hashState(provider, observed) : { state: 'not_checked' }),
      hash,
      checked_at: isoTime(record?.checkedAt),
      stale,
      refreshing: parts().lookups.has(key),
      ...(record?.failure ? { refresh_error: record.failure.message.slice(0, 200) } : {}),
    }
    queried.push(state)
    if (state.state === 'available') return { result: { ...state, ...availabilityMetadata(queried) }, needsRefresh }
  }
  return { result: withoutMatch(hash, queried, unknown ? 'not_checked' : 'no_match'), needsRefresh }
}

/**
 * What the cache knows about one hash right now, without waiting on a provider. A missing or stale observation,
 * or any with `refresh`, is refreshed in the background, at most once per hash in `refreshed`.
 */
export function observeUsenetHash(
  config: Config,
  hash: string,
  refresh: boolean,
  refreshed: Set<string>,
): UsenetHashAvailability {
  const snapshot = hashSnapshot(config, hash)
  if ((refresh || snapshot.needsRefresh) && !refreshed.has(hash)) {
    refreshed.add(hash)
    scheduleHashRefresh(config, hash, refresh, false)
  }
  return {
    ...snapshot.result,
    refreshing: snapshot.result.refreshing === true || parts().refreshes.has(refreshKey(config, hash)),
  }
}

/** What the hash indexers answered for one hash as far as the cache knows, without any request or refresh. */
export function cachedHashState(config: Config, hash: string): UsenetUnitState {
  return hashSnapshot(config, hash).result.state
}

/** A release is 'available' only when every required source hash matched. Mixed coverage is 'incomplete'. */
export function aggregateHashStates(states: UsenetUnitState[]): UsenetUnitState {
  if (!states.length) return 'unsupported_hash'
  if (states.every(state => state === 'available')) return 'available'
  const outranking: UsenetUnitState[] = ['not_configured', 'unsupported_hash', 'lookup_failed']
  const decisive = outranking.find(state => states.includes(state))
  if (decisive) return decisive
  if (states.includes('available')) return 'incomplete'
  if (states.includes('processing')) return 'processing'
  if (states.includes('unverified')) return 'unverified'
  if (states.includes('not_checked')) return 'not_checked'
  return 'no_match'
}

export async function resolveUsenetRelease(
  config: Config,
  release: EstimatableRelease,
  refresh = false,
  background = false,
): Promise<{ hashes: UsenetHashAvailability[]; aggregate: UsenetUnitState }> {
  const hashes = torrentHashes(release)
  if (!hashes.length) return { hashes: [{ hash: '', state: 'unsupported_hash' }], aggregate: 'unsupported_hash' }
  const results = await Promise.all(hashes.map(hash => resolveUsenetHash(config, hash, refresh, background)))
  return { hashes: results, aggregate: aggregateHashStates(results.map(result => result.state)) }
}

/** A selection that no longer points at the release the browser saw. */
export class UsenetSelectionError extends HttpError {
  constructor(status: 400 | 409, message: string) {
    super(status, message, { ok: false })
  }
}

/**
 * Server-side NZB retrieval for an accepted submission. Never trusts browser-supplied URLs.
 *
 * An NZB found through Prowlarr is the stored one that was checked, so sending it costs no request. `files`
 * is the file list of its source, for the case that the stored bytes are gone and a new fetch has to be graded.
 */
export async function fetchUsenetNzb(
  config: Config,
  provider: UsenetSource,
  entryId: string,
  sourceHash: string,
  files?: SourceFile[],
): Promise<Uint8Array> {
  if (provider === 'prowlarr') return searchNzbBytes(config, sourceHash, entryId, files)
  const result = await providerLookup(config, provider, sourceHash, false, false)
  const lookup = result.kind === 'settled' ? result.lookup : undefined
  if (lookup?.kind === 'failed' && lookup.code === 'rate_limited') throw new Error(lookup.message)
  if (lookup?.kind !== 'match' || lookup.match.entry_id !== entryId)
    throw new Error(
      'The provider mirror for this download is no longer available. Re-run the review before submitting.',
    )
  const settings = providerSettings(config, provider)
  if (!settings) throw new Error('The Usenet provider used by this plan is no longer configured')
  return USENET_PROVIDERS[provider].fetchNzb(settings, lookup.match, parts().fetch)
}
