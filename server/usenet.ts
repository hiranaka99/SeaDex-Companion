import type { Config, ResultItem } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { HttpError } from './http-error.js'
import { log } from './logging.js'
import { torrentHashes } from '../shared/download-plan.js'
import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { releaseIdentity } from '../shared/releases.js'
import type { EstimatableRelease } from '../shared/download-estimate.js'
import type {
  UsenetAvailabilityResult,
  UsenetHashAvailability,
  UsenetProvider,
  UsenetSource,
  UsenetUnitState,
} from '../shared/usenet-contracts.js'
import type { PrivateSource, Release } from '../shared/contracts.js'
import { knownProwlarrIndexers, privateSearchSettings, prowlarrSettings } from './prowlarr.js'
import { searchContext } from './private-sources.js'
import type { SourceFile } from './source-files.js'
import {
  cancelSourceCheck,
  resolveSource,
  searchNzbBytes,
  searchSnapshot,
  usenetSearchPauses,
  type UsenetSearchContext,
} from './usenet-search.js'
import { LOOKUP_TIMEOUT_MS, type ProviderLookup, type ProviderSettings } from './usenet-provider-types.js'
import { PersistentUsenetCache, providerFingerprint, usenetCacheKey } from './usenet-cache.js'
import { providerSettings, USENET_PROVIDER_IDS, USENET_PROVIDERS } from './usenet-providers.js'
import {
  LookupScheduler,
  ProviderPausedError,
  TRANSIENT_CODES,
  type ChannelPause,
  type LookupJob,
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
const FILE_NAME_LIMIT = 200
/** Background lookups wait out a pause and retry instead of recording a failure. */
const BACKGROUND_ATTEMPTS = 3

/** Paces and prioritizes every hash-indexer request this module makes, one channel per provider. */
export const usenetScheduler = new LookupScheduler({ concurrency: 4, foregroundReserved: 1, minIntervalMs: 2_000 })
for (const provider of USENET_PROVIDER_IDS)
  usenetScheduler.describe(provider, { label: USENET_PROVIDERS[provider].label })

/** Active pauses of the hash indexers and of the Usenet indexers in Prowlarr, for status reporting. */
export function usenetProviderPauses(): ChannelPause[] {
  return [...usenetScheduler.pauses(), ...usenetSearchPauses()]
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

/** Private-tracker sources Prowlarr can search for, when the release has no public torrent hash. */
export function privateUsenetSources(
  config: Config,
  release: Pick<Release, 'info_hashes' | 'private_sources'>,
): PrivateSource[] {
  if (torrentHashes(release).length || !privateSearchSettings(config)) return []
  return release.private_sources || []
}

/**
 * A public torrent as a source Prowlarr can search for once the hash indexers lack it: its hash and exact file
 * list. Null without Prowlarr, or when SeaDex lists no complete file list to check a copy against.
 */
export function prowlarrFallbackSource(
  config: Config,
  release: Pick<Release, 'torrent_files'>,
  hash: string,
): PrivateSource | null {
  if (!prowlarrSettings(config) || prowlarrHasUsenet(config) === false) return null
  const files = (release.torrent_files || []).find(catalog => catalog.hash.toLowerCase() === hash)?.files
  if (!files?.length || !files.every(file => file.name && Number.isSafeInteger(file.length) && file.length >= 0))
    return null
  return { id: hash, files }
}

/** Whether Prowlarr has a Usenet indexer: false only when its current indexer list says so, never while unknown. */
export function prowlarrHasUsenet(config: Config): boolean | undefined {
  const settings = prowlarrSettings(config)
  if (!settings) return false
  return knownProwlarrIndexers(settings)?.some(indexer => indexer.protocol === 'usenet')
}

/** The Usenet source identities a release is acquired by: its torrent hashes, or its private sources' file-list IDs. */
export function usenetSourceIds(config: Config, release: Pick<Release, 'info_hashes' | 'private_sources'>): string[] {
  const hashes = torrentHashes(release)
  return hashes.length ? hashes : privateUsenetSources(config, release).map(source => source.id)
}

/** Provider failure warnings repeat at most once per minute per provider; sweeps must not spam the log. */
const lastFailureLogged = new Map<UsenetProvider, { at: number; message: string }>()
function logProviderFailure(provider: UsenetProvider, message: string): void {
  const previous = lastFailureLogged.get(provider)
  if (previous && previous.message === message && Date.now() - previous.at < MINUTE) return
  lastFailureLogged.set(provider, { at: Date.now(), message })
  log('WARNING', `Usenet provider lookup failed (${provider}): ${message}`)
}

/** An error no provider client classified: logged in bounded form and reported as a network failure. */
function unexpectedFailure(provider: UsenetProvider, error: unknown): ProviderLookup {
  logProviderFailure(provider, error instanceof Error ? error.message.slice(0, 160) : 'unknown error')
  return { kind: 'failed', code: 'network', message: 'Provider lookup failed' }
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

async function cancelableLookup<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancellation = Promise.withResolvers<never>()
  const cancel = () => cancellation.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    return await Promise.race([work, cancellation.promise])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** What one provider lookup came to: an answer worth caching, or nothing because the work was superseded. */
type LookupResult = { kind: 'settled'; lookup: ProviderLookup; checkedAt: number } | typeof CANCELLED
const CANCELLED = { kind: 'cancelled' } as const

interface Flight {
  promise: Promise<LookupResult>
  job: LookupJob
}
interface RefreshChain {
  promise: Promise<UsenetHashAvailability>
  cancelled: boolean
}

const cache = new PersistentUsenetCache()
let inFlight = new Map<string, Flight>()
let refreshChains = new Map<string, RefreshChain>()
/** Bumped when provider configuration changes; results of older work are discarded. */
let lookupEpoch = 0

function cancelUsenetWork(): void {
  lookupEpoch++
  const cancelled = inFlight
  inFlight = new Map()
  for (const chain of refreshChains.values()) chain.cancelled = true
  refreshChains = new Map()
  for (const { job } of cancelled.values()) job.controller.abort()
  usenetScheduler.pump()
}

export function invalidateUsenetLookups(config: Config): void {
  cancelUsenetWork()
  cache.retainCompatible(
    Object.fromEntries(
      USENET_PROVIDER_IDS.map(provider => [
        provider,
        providerFingerprint(provider, USENET_PROVIDERS[provider].connection(config)),
      ]),
    ) as Record<UsenetProvider, string>,
  )
}

export function resetUsenetLookups(restoreFromDisk = false): void {
  cancelUsenetWork()
  cache.reset(restoreFromDisk)
  usenetScheduler.reset()
  lastFailureLogged.clear()
}

export function flushUsenetCache(): boolean {
  return cache.flush()
}

/** Forget observations for source hashes that no current result references. */
export function retainUsenetHashes(hashes: ReadonlySet<string>): number {
  return cache.retainHashes(hashes)
}

const isAbsence = (lookup: ProviderLookup | undefined) => lookup?.kind === 'no_match' || lookup?.kind === 'deleted'

function ttlFor(lookup: ProviderLookup, negativeStreak = 1): number {
  if (lookup.kind === 'match') return POSITIVE_TTL_MS
  if (lookup.kind === 'processing') return PROCESSING_TTL_MS
  if (isAbsence(lookup))
    return NEGATIVE_TTL_STEPS_MS[Math.min(Math.max(negativeStreak, 1), NEGATIVE_TTL_STEPS_MS.length) - 1]
  return FAILURE_TTL_MS
}

/** Runs one provider request, turning unexpected errors into a typed failure. Cancellation propagates. */
async function requestLookup(
  provider: UsenetProvider,
  settings: ProviderSettings,
  hash: string,
  signal: AbortSignal,
): Promise<ProviderLookup> {
  try {
    return await raceWithWallClockGuard(
      cancelableLookup(USENET_PROVIDERS[provider].lookup(settings, hash), signal),
      LOOKUP_GUARD_MS,
    )
  } catch (error) {
    if (signal.aborted) throw error
    return unexpectedFailure(provider, error)
  }
}

/** Takes scheduler slots until the provider answers. Background work waits out a pause rather than recording a transient failure. */
async function runLookup(
  job: LookupJob,
  provider: UsenetProvider,
  settings: ProviderSettings,
  hash: string,
): Promise<ProviderLookup | { kind: 'cancelled' }> {
  const { signal } = job.controller
  try {
    for (let attempt = 1; ; attempt++) {
      await usenetScheduler.acquire(job)
      let lookup: ProviderLookup
      try {
        signal.throwIfAborted()
        lookup = await requestLookup(provider, settings, hash, signal)
      } finally {
        usenetScheduler.release()
      }
      usenetScheduler.recordOutcome(provider, lookup)
      const retry =
        lookup.kind === 'failed' &&
        job.background &&
        attempt < BACKGROUND_ATTEMPTS &&
        TRANSIENT_CODES.has(lookup.code) &&
        usenetScheduler.isPaused(provider)
      if (!retry) return lookup
    }
  } catch (error) {
    if (error instanceof ProviderPausedError) return usenetScheduler.pausedFailure(provider, error.until)
    if (signal.aborted) return CANCELLED
    return unexpectedFailure(provider, error)
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
  if (refresh) inFlight.get(key)?.job.controller.abort()
  else {
    const running = inFlight.get(key)
    if (running) {
      if (!background) {
        running.job.background = false
        usenetScheduler.pump()
      }
      return running.promise
    }
    const hit = cache.get(key)
    if (hit?.failure && Date.now() < hit.retryAt) return { kind: 'settled', lookup: hit.failure, checkedAt: 0 }
    if (hit?.lookup && !hit.failure && Date.now() - hit.checkedAt < ttlFor(hit.lookup, hit.negativeStreak))
      return { kind: 'settled', lookup: hit.lookup, checkedAt: hit.checkedAt }
  }
  const job: LookupJob = { channel: provider, background, controller: new AbortController() }
  const settings: ProviderSettings = { ...connection, signal: job.controller.signal }
  const epoch = lookupEpoch
  const flight: Flight = {
    job,
    promise: runLookup(job, provider, settings, hash)
      .then((lookup): LookupResult => {
        if (
          lookup.kind === 'cancelled' ||
          inFlight.get(key) !== flight ||
          lookupEpoch !== epoch ||
          job.controller.signal.aborted
        )
          return CANCELLED
        const at = Date.now()
        const previous = cache.get(key)
        if (lookup.kind === 'failed') {
          // A failed refresh keeps the previous observation next to the retry state.
          logProviderFailure(provider, lookup.message)
          const retryAt =
            at + Math.max(FAILURE_TTL_MS, lookup.retry_after_ms || 0, usenetScheduler.pausedUntil(provider) - at)
          cache.set(
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
          job.controller.abort()
          return { kind: 'settled', lookup, checkedAt: 0 }
        }
        const negativeStreak = isAbsence(lookup)
          ? (isAbsence(previous?.lookup) ? previous?.negativeStreak || 1 : 0) + 1
          : 0
        cache.set(
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
      })
      .finally(() => {
        if (inFlight.get(key) === flight) inFlight.delete(key)
      }),
  }
  inFlight.set(key, flight)
  return flight.promise
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

function availabilityMetadata(
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
  const epoch = lookupEpoch
  const queried: UsenetHashAvailability[] = []
  for (const provider of USENET_PROVIDER_IDS) {
    if (!USENET_PROVIDERS[provider].usable(config)) continue
    if (!ownsWork()) return cancelled
    const result = await providerLookup(config, provider, hash, refresh, background)
    if (result.kind === 'cancelled' || epoch !== lookupEpoch || !ownsWork()) return cancelled
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
  const previous = refreshChains.get(key)
  if (previous && !refresh) {
    // Someone is now waiting on work that started in the background.
    if (!background) {
      for (const entry of keys) {
        const running = inFlight.get(entry.key)
        if (running) running.job.background = false
      }
      usenetScheduler.pump()
    }
    return
  }
  if (refresh) {
    if (previous) previous.cancelled = true
    for (const entry of keys) inFlight.get(entry.key)?.job.controller.abort()
  }
  const chain: RefreshChain = {
    cancelled: false,
    promise: Promise.resolve()
      .then(() => resolveUsenetHash(config, hash, refresh, background, () => !chain.cancelled))
      .finally(() => {
        if (refreshChains.get(key) === chain) refreshChains.delete(key)
      }),
  }
  refreshChains.set(key, chain)
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
  const now = Date.now()
  for (const { provider, key } of configuredProviderKeys(config, hash)) {
    const record = cache.get(key)
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
      refreshing: inFlight.has(key),
      ...(record?.failure ? { refresh_error: record.failure.message.slice(0, 200) } : {}),
    }
    queried.push(state)
    if (state.state === 'available') return { result: { ...state, ...availabilityMetadata(queried) }, needsRefresh }
  }
  return { result: withoutMatch(hash, queried, unknown ? 'not_checked' : 'no_match'), needsRefresh }
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

/** NZBs an explicit search may fetch for one source, and a row selected in a bulk review. */
const SEARCH_FETCHES = 3
const VERIFY_FETCHES = 1

interface RowRef {
  key: string
  release: number
}

const rowId = (row: RowRef) => `${row.key}\u0000${row.release}`

/** Every source of a release that Prowlarr may be searched for by its file list, whatever is known about it. */
function fileListSources(config: Config, release: Release): PrivateSource[] {
  const sources = privateUsenetSources(config, release)
  if (sources.length) return sources
  return torrentHashes(release).flatMap(hash => prowlarrFallbackSource(config, release, hash) ?? [])
}

/**
 * Cached or unchecked snapshots for the selected releases, returned immediately. Missing and
 * stale observations are refreshed in the background, once per hash however many rows share it.
 *
 * A source found through Prowlarr reports what is stored about it, and nothing is ever awaited from
 * Prowlarr. Work starts only for the rows named, and reports through later snapshots:
 *
 * - `search`: the source is searched again and up to three of its candidates are fetched and checked.
 * - `verify`: a source nothing was concluded about yet (`not_checked`, `unverified`) is searched if it has no
 *   fresh result, and its best candidate is fetched and checked. Any other source is left as it is.
 * - `cancelVerify`: what `verify` rows still wait for is dropped first; a fetch under way finishes.
 */
export async function usenetAvailability(
  config: Config,
  selections: { key: string; release: number; identity?: string }[],
  results: ResultItem[],
  {
    refresh = false,
    background = false,
    search = [],
    verify = [],
    cancelVerify = [],
  }: { refresh?: boolean; background?: boolean; search?: RowRef[]; verify?: RowRef[]; cancelVerify?: RowRef[] } = {},
): Promise<UsenetAvailabilityResult[]> {
  const resultsByKey = new Map(results.map(result => [result.key, result]))
  // Prowlarr is asked only for the rows named: each checked NZB counts against the indexer's grab limit.
  const searched = new Set(search.map(rowId))
  const verified = new Set(verify.map(rowId))
  const selected = selections.map(selection => {
    const release =
      Number.isSafeInteger(selection.release) && selection.release >= 0
        ? resultsByKey.get(selection.key)?.releases?.[selection.release]
        : undefined
    if (!release)
      throw new UsenetSelectionError(
        400,
        'The selected release no longer exists. Refresh the results before checking availability.',
      )
    const identity = releaseIdentity(release)
    if (selection.identity !== undefined && selection.identity !== identity) {
      throw new UsenetSelectionError(
        409,
        'The selected release changed. Refresh the results before checking availability.',
      )
    }
    return { selection, release, identity }
  })
  // Withdrawn before anything starts, so a row that is cancelled and selected again starts over.
  for (const row of cancelVerify) {
    const release =
      Number.isSafeInteger(row.release) && row.release >= 0
        ? resultsByKey.get(row.key)?.releases?.[row.release]
        : undefined
    if (release) for (const source of fileListSources(config, release)) cancelSourceCheck(config, source.id)
  }
  const scheduled = new Set<string>()
  const started = new Set<string>()
  /** What is stored about one source's Prowlarr search, after starting the work its row asks for. Never waits. */
  const searchState = (
    source: PrivateSource,
    context: UsenetSearchContext,
    asked: 'search' | 'verify' | undefined,
  ): UsenetHashAvailability => {
    if (asked && !started.has(source.id)) {
      const { state } = searchSnapshot(config, source.id).availability
      const options =
        asked === 'search'
          ? { limit: SEARCH_FETCHES, refresh: true }
          : state === 'not_checked' || state === 'unverified'
            ? { limit: VERIFY_FETCHES, cancellable: true }
            : undefined
      if (options) {
        started.add(source.id)
        // Failures come back as states of the source; only a defect lands here, and its text is not logged.
        void resolveSource(config, source, context, options).catch(error =>
          log('WARNING', `Prowlarr NZB search stopped: ${error instanceof Error ? error.name : 'unknown error'}`),
        )
      }
    }
    const snapshot = searchSnapshot(config, source.id)
    return {
      ...snapshot.availability,
      checked_at: isoTime(snapshot.checkedAt),
      stale: snapshot.stale,
      refreshing: snapshot.running,
    }
  }
  return selected.map(({ selection, release, identity }) => {
    const privateSources = privateUsenetSources(config, release)
    const result = resultsByKey.get(selection.key)
    const context = searchContext(result, release)
    const asked = searched.has(rowId(selection)) ? 'search' : verified.has(rowId(selection)) ? 'verify' : undefined
    if (privateSources.length) {
      // Prowlarr without a Usenet indexer cannot find a copy; say so instead of offering a search.
      const noUsenet = prowlarrHasUsenet(config) === false
      const hashes = privateSources.map((source): UsenetHashAvailability => {
        if (noUsenet)
          return {
            hash: source.id,
            state: 'not_configured',
            provider: 'prowlarr',
            error: 'Prowlarr has no Usenet indexer.',
            checked_at: '',
            stale: false,
            refreshing: false,
          }
        return searchState(source, context, asked)
      })
      return {
        key: selection.key,
        release: selection.release,
        identity,
        hashes,
        aggregate: aggregateHashStates(hashes.map(hash => hash.state)),
        search: 'prowlarr' as const,
        ...availabilityMetadata(hashes),
      }
    }
    const sourceHashes = torrentHashes(release)
    const hashes: UsenetHashAvailability[] = sourceHashes.length
      ? sourceHashes.map(hash => {
          const snapshot = hashSnapshot(config, hash)
          if ((refresh || snapshot.needsRefresh) && !scheduled.has(hash)) {
            scheduled.add(hash)
            scheduleHashRefresh(config, hash, refresh, background)
          }
          return {
            ...snapshot.result,
            refreshing: snapshot.result.refreshing === true || refreshChains.has(refreshKey(config, hash)),
          }
        })
      : [{ hash: '', state: 'unsupported_hash', stale: false, refreshing: false }]
    // Where the hash indexers have nothing, Prowlarr may have found (or may be asked to find) a copy.
    let fallback = false
    let viaProwlarr = false
    const merged = hashes.map((state): UsenetHashAvailability => {
      if (state.state !== 'no_match') return state
      const source = prowlarrFallbackSource(config, release, state.hash)
      if (!source) return state
      fallback = true
      const found = searchState(source, context, asked)
      if (found.state === 'not_checked' && !found.refreshing) return state
      viaProwlarr = true
      return { ...found, ...(state.providers_checked ? { providers_checked: state.providers_checked } : {}) }
    })
    // The public projection bounds filename lists; a truncated list is no longer a complete manifest.
    const publicHashes = merged.map(hash =>
      hash.file_names && hash.file_names.length > FILE_NAME_LIMIT
        ? { ...hash, files_known: false, file_names: hash.file_names.slice(0, FILE_NAME_LIMIT) }
        : hash,
    )
    return {
      key: selection.key,
      release: selection.release,
      identity,
      hashes: publicHashes,
      aggregate: aggregateHashStates(merged.map(hash => hash.state)),
      ...(viaProwlarr ? { search: 'prowlarr' as const } : fallback ? { fallback: 'prowlarr' as const } : {}),
      ...availabilityMetadata(merged),
    }
  })
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
  return USENET_PROVIDERS[provider].fetchNzb(settings, lookup.match)
}
