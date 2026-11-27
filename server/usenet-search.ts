// The Prowlarr file-list search: finds a Usenet copy of a release the hash indexers do not carry.
//
// Search stage: one Newznab request per indexer and query lists the posts that could be the release. It
// costs no grab, may run in the background, and what it finds is persisted. Verify stage: a listed post is
// fetched and its NZB graded against the files SeaDex lists. A fetch counts as a grab on the indexer, so it
// runs only for a user action, within a daily limit, and what it learned is written at once.
//
// The Prowlarr key and download references never reach a log line, an error message or an availability
// row. Titles and indexer names are cleaned before they are stored or shown.

import { createHash } from 'node:crypto'
import { formatDateTime } from '../shared/datetime-format.js'
import { isInfoHash } from '../shared/ids.js'
import { VIDEO_FILE } from '../shared/releases.js'
import type { ProwlarrIndexerUsage, UsenetFailureCode, UsenetHashAvailability } from '../shared/usenet-contracts.js'
import { log } from './logging.js'
import {
  ProwlarrError,
  downloadPathFromRef,
  downloadRef,
  knownProwlarrIndexers,
  privateSearchSettings,
  prowlarrDownload,
  prowlarrFingerprint,
  prowlarrIndexers,
  prowlarrSettings,
  searchIndexer,
  type ProwlarrFailureScope,
  type ProwlarrIndexer,
  type ProwlarrSearchResult,
  type ProwlarrSettings,
} from './prowlarr.js'
import { gradeNzb, nzbFiles, type NzbFile, type NzbGrade, type SourceFile } from './source-files.js'
import type { Config, PrivateSource } from './types.js'
import { NZB_MAX_BYTES, gunzipOnce, safeText } from './usenet-provider-types.js'
import { LookupScheduler, ProviderPausedError, type ChannelPause, type LookupJob } from './usenet-scheduler.js'
import {
  RETRY_MIN_MS,
  failedAvailability,
  lastCheckedAt,
  matchAvailability,
  notConfigured,
  recordAvailability,
  searchRecordState,
  standing,
} from './usenet-search-state.js'
import {
  UsenetSearchStore,
  type SearchRecord,
  type SearchedIndexer,
  type StoredCandidate,
  type StoredCheck,
} from './usenet-search-store.js'
import {
  CANDIDATE_LIMIT,
  candidateEntryId,
  isPlausible,
  isStrong,
  queryLadder,
  rankCandidates,
  sourceFacts,
  type SearchQuery,
  type SearchTerms,
  type SourceFacts,
} from './usenet-search-terms.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A post whose NZB cannot be read is not fetched again for this long. */
const UNREADABLE_RETRY_MS = 7 * DAY
/** Last line of defense behind the client's own timeouts: no request holds a slot or a lookup forever. */
const SEARCH_GUARD_MS = 50_000
/** A download may be redirected from Prowlarr to the indexer, and each of the two has a minute. */
const FETCH_GUARD_MS = 130_000
const NAME_LIMIT = 60
const TITLE_LIMIT = 500

const NOT_SET_UP = 'Prowlarr is not set up.'
const NO_USENET_INDEXER = 'Prowlarr has no Usenet indexer.'
const NZB_UNKNOWN = 'The NZB found through Prowlarr is no longer known. Re-run the review before submitting.'
const NZB_CHANGED = 'The NZB changed since it was checked. Re-run the review before submitting.'

/**
 * Paces and prioritizes every request to a Usenet indexer in Prowlarr, one channel `prowlarr:<indexer id>`
 * per indexer. It is apart from the scheduler of the hash indexers, so a slow search never takes a slot
 * from hash lookups.
 */
export const searchScheduler = new LookupScheduler({ concurrency: 3, foregroundReserved: 1, minIntervalMs: 2_000 })

/** Search records, fetched NZBs, usage counters and the sweep summary, on the default paths. */
export const searchStore = new UsenetSearchStore()

/** What a search is built from; a `PrivateSearchContext` fits. */
export type UsenetSearchContext = SearchTerms

/** One source as an availability row, read from the store without any request. */
export interface UsenetSearchSnapshot {
  /** Never carries a download reference. `checked_at`, `stale` and `refreshing` are left to the caller. */
  availability: UsenetHashAvailability
  /** Epoch ms of the search or check the row reports; 0 when it reports none. */
  checkedAt: number
  /** A search is due for the source. */
  stale: boolean
  /** A search or a check of the source is running. */
  running: boolean
}

/** A snapshot taken when a call settled, with what the call itself did. */
export interface UsenetSourceOutcome extends UsenetSearchSnapshot {
  /** Queries each indexer received because of this call. */
  queries: { indexer: string; count: number }[]
  /** The daily search limit kept a background search from asking at least one indexer. */
  deferred: boolean
  /** Earliest epoch ms at which a refused indexer has a background search left. */
  deferredUntil?: number
  /** NZBs fetched by this call. */
  fetched: number
  /** Why no NZB could be fetched although candidates wait to be checked, as text for the user. */
  reason?: string
  /** A changed Prowlarr connection discarded the work. */
  cancelled?: boolean
}

/** A lookup that failed as a whole: Prowlarr itself could not be asked. Kept in memory until the next attempt. */
interface LookupFailure {
  code: UsenetFailureCode
  message: string
  retryAt: number
}

interface SearchResult {
  /** Every enabled indexer was asked, so a caller that wanted that needs nothing more. */
  complete: boolean
  deferred: boolean
  deferredUntil?: number
  queries: { indexer: string; count: number }[]
  cancelled?: true
  unconfigured?: string
}

interface VerifyResult {
  fetched: number
  reason?: string
  cancelled?: true
  unconfigured?: string
}

interface SearchFlight {
  promise: Promise<SearchResult>
  controller: AbortController
  /** Requests waiting for or holding a slot, so a caller that starts waiting can promote them. */
  jobs: Set<LookupJob>
  background: boolean
  /** Only callers whose check may be cancelled wait for this search, so cancelling them cancels it. */
  loose: boolean
}

interface VerifyFlight {
  promise: Promise<VerifyResult>
  controller: AbortController
  limit: number
  /** Only callers whose check may be cancelled wait for this walk. */
  loose: boolean
  /** The wait for the slot of the next fetch. Aborting it gives up the wait and never a fetch under way. */
  queued?: AbortController
  /** The check was cancelled: the fetch under way is finished and stored, and none follows. */
  withdrawn?: true
}

/** One call of `resolveSource`. */
interface ResolveCall {
  cancellable: boolean
  /** `cancelSourceCheck` withdrew the call: it starts no check any more. */
  withdrawn: boolean
}

interface SearchRequest {
  config: Config
  settings: ProwlarrSettings
  fingerprint: string
  source: PrivateSource
  terms: UsenetSearchContext
  refresh: boolean
}

/** One indexer during one search. */
interface IndexerRun {
  indexer: ProwlarrIndexer
  name: string
  channel: string
  /** Still asked; false once it failed, was refused or is paused. */
  active: boolean
  /** Every query it was sent got an answer. */
  answered: boolean
  /** Left out by the daily search limit: neither an answer nor a failure. */
  deferred: boolean
  retryAt: number
  queries: number
}

const NOTHING: SearchResult = { complete: false, deferred: false, queries: [] }
const SEARCH_CANCELLED: SearchResult = { complete: true, deferred: false, queries: [], cancelled: true }
const VERIFY_CANCELLED: VerifyResult = { fetched: 0, cancelled: true }
const ANSWERED = { kind: 'answered' }

const searches = new Map<string, SearchFlight>()
const verifies = new Map<string, VerifyFlight>()
/** Calls of `resolveSource` under way per source: between its search and its check no flight exists. */
const resolving = new Map<string, Set<ResolveCall>>()
const failures = new Map<string, LookupFailure>()
/** Why an indexer did not answer its latest search. A record keeps only that it did not. */
const indexerFailures = new Map<string, { code: UsenetFailureCode; message: string }>()
/** File lists of the sources seen by this process, to grade an NZB that is fetched again for a submission. */
const sourceFiles = new Map<string, SourceFile[]>()
const lastLogged = new Map<string, number>()
/** Channels paused because Prowlarr reported their indexer disabled, with the time it named. */
const disabledUntil = new Map<string, number>()
/** Usenet indexers as last read from Prowlarr; snapshots judge staleness by them without a request. */
let known: { fingerprint: string; indexers: ProwlarrIndexer[] } | undefined
/** Bumped when the Prowlarr connection changes; results of older work are discarded. */
let epoch = 0

const sourceKey = (fingerprint: string, sourceId: string) => `${fingerprint}\u0000${sourceId}`
const indexerKey = (fingerprint: string, indexerId: number) => `${fingerprint}\u0000${indexerId}`
const channelOf = (indexerId: number) => `prowlarr:${indexerId}`
const indexerName = (indexer: { id: number; name: string }) =>
  safeText(indexer.name, NAME_LIMIT) || `Indexer ${indexer.id}`
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

/**
 * Prowlarr settings for a file-list search. A private-tracker release (a `files:` source) needs private
 * trackers in Release preferences; a public torrent the hash indexers lack (an info hash) only needs Prowlarr.
 */
function connectionFor(config: Config, sourceId: string): ProwlarrSettings | null {
  return isInfoHash(sourceId) ? prowlarrSettings(config) : privateSearchSettings(config)
}

/** Identity of the configured Prowlarr connection, whether or not Prowlarr is switched on. */
function connectionFingerprint(config: Config): string | null {
  return config.prowlarr_url && config.prowlarr_key
    ? prowlarrFingerprint({ baseUrl: config.prowlarr_url, apiKey: config.prowlarr_key })
    : null
}

class GuardTimeout extends Error {}

/** Settles with `work`, or rejects once the work is cancelled or still pending after `guardMs`. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal, guardMs: number): Promise<T> {
  const stop = Promise.withResolvers<never>()
  const cancel = () => stop.reject(signal.reason)
  const timer = setTimeout(() => stop.reject(new GuardTimeout()), guardMs)
  timer.unref?.()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    return await Promise.race([work, stop.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

/** Any error of a request as a typed failure. Only the client's own texts are kept: they never carry an address. */
function requestFailure(error: unknown, operation: string, scope: ProwlarrFailureScope = 'indexer'): ProwlarrError {
  if (error instanceof ProwlarrError) return error
  if (error instanceof GuardTimeout)
    return new ProwlarrError('timeout', `The ${operation} did not finish in time`, undefined, scope)
  return new ProwlarrError('network', `The ${operation} failed`, undefined, scope)
}

const failedOutcome = (failure: ProwlarrError) => ({
  kind: 'failed',
  code: failure.code,
  ...(failure.retryAfterMs ? { retry_after_ms: failure.retryAfterMs } : {}),
})

/** When an indexer that just failed may be asked again: after its pause and its `Retry-After`, at least a minute on. */
function retryTime(channel: string, failure: ProwlarrError, now: number): number {
  const asked = Math.max(now + RETRY_MIN_MS, now + (failure.retryAfterMs ?? 0), searchScheduler.pausedUntil(channel))
  // A stored time is a whole number of milliseconds.
  return Math.ceil(asked)
}

/** Warnings repeat at most once a minute per subject; a sweep must not fill the log. */
function warnOnce(subject: string, message: string): void {
  const now = Date.now()
  if (now - (lastLogged.get(subject) ?? 0) < MINUTE) return
  lastLogged.set(subject, now)
  log('WARNING', message)
}

function rememberFailure(key: string, failure: ProwlarrError): void {
  const now = Date.now()
  failures.set(key, {
    code: failure.code,
    message: failure.message,
    retryAt: now + Math.max(RETRY_MIN_MS, failure.retryAfterMs ?? 0),
  })
  warnOnce('prowlarr', `Prowlarr NZB lookup failed: ${failure.message}`)
}

/**
 * Names each indexer's channel and pauses the channel of one Prowlarr has disabled after failures. The
 * pause ends early once Prowlarr no longer reports the indexer disabled, unless failures of this module's
 * own requests have extended it since.
 */
function noteIndexers(fingerprint: string, indexers: ProwlarrIndexer[]): void {
  known = { fingerprint, indexers }
  const now = Date.now()
  for (const indexer of indexers) {
    const channel = channelOf(indexer.id)
    searchScheduler.describe(channel, { label: indexerName(indexer) })
    const until = indexer.disabledTill ?? 0
    if (until > now) {
      searchScheduler.pause(channel, until, 'server')
      disabledUntil.set(channel, until)
    } else if (disabledUntil.has(channel)) {
      if (searchScheduler.pausedUntil(channel) === disabledUntil.get(channel)) searchScheduler.resume(channel)
      disabledUntil.delete(channel)
    }
  }
}

/** The enabled Usenet indexers, from the client's short-lived cache. */
async function usenetIndexers(
  settings: ProwlarrSettings,
  fingerprint: string,
  started: number,
): Promise<ProwlarrIndexer[]> {
  const indexers = (await prowlarrIndexers(settings)).filter(indexer => indexer.protocol === 'usenet')
  if (started === epoch) noteIndexers(fingerprint, indexers)
  return indexers
}

/** Background searches an indexer may get in 24 hours; 0 is no limit. Half of Prowlarr's own limit is left to others. */
function searchLimit(config: Config, indexer: ProwlarrIndexer): number {
  const own = indexer.queryLimitPerDay ? Math.max(1, Math.floor(indexer.queryLimitPerDay / 2)) : 0
  const configured = Math.max(0, config.prowlarr_search_limit)
  return own && configured ? Math.min(own, configured) : own || configured
}

/** Why no NZB can be fetched from an indexer right now, as text for the user. Undefined when one can. */
function fetchBlock(
  config: Config,
  fingerprint: string,
  indexerId: number,
  name: string,
  now: number,
): string | undefined {
  const channel = channelOf(indexerId)
  if (searchScheduler.isPaused(channel, now))
    return searchScheduler.pausedFailure(channel, searchScheduler.pausedUntil(channel)).message
  const limit = config.prowlarr_fetch_limit
  if (!(limit > 0) || searchStore.usage(fingerprint, indexerId, now).fetches < limit) return undefined
  const next = new Date(searchStore.nextAvailableAt(fingerprint, indexerId, 'fetch', limit, now))
  return `Daily NZB check limit reached for ${name}. Next check at ${formatDateTime(next, config.datetime_format)}.`
}

/** Why none of a record's unchecked candidates can be fetched right now. Undefined when one can, or none waits. */
function verifyBlock(config: Config, fingerprint: string, record: SearchRecord, now: number): string | undefined {
  let reason: string | undefined
  for (const candidate of record.candidates) {
    if (standing(candidate, now) !== 'unchecked') continue
    const block = fetchBlock(config, fingerprint, candidate.indexer_id, candidate.indexer, now)
    if (!block) return undefined
    reason ??= block
  }
  return reason
}

function snapshotOf(config: Config, fingerprint: string, sourceId: string, now: number): UsenetSearchSnapshot {
  const key = sourceKey(fingerprint, sourceId)
  const record = searchStore.get(fingerprint, sourceId)
  const derived = searchRecordState(record, now, known?.fingerprint === fingerprint ? known.indexers : undefined)
  const failure = failures.get(key)
  const running = resolving.has(key) || searches.has(key) || verifies.has(key)
  if (!record || derived.state === 'not_checked') {
    // Prowlarr itself could not be asked: that is all that is known about the source.
    if (failure)
      return {
        availability: failedAvailability(sourceId, failure.code, failure.message),
        checkedAt: 0,
        stale: now >= failure.retryAt,
        running,
      }
    const availability: UsenetHashAvailability = { hash: sourceId, provider: 'prowlarr', state: 'not_checked' }
    return { availability, checkedAt: 0, stale: true, running }
  }
  const waiting = derived.state === 'unverified' ? verifyBlock(config, fingerprint, record, now) : undefined
  const silent = derived.failed && indexerFailures.get(indexerKey(fingerprint, derived.failed.indexer_id))
  const availability = recordAvailability(record, derived, now, {
    ...(waiting ? { waiting } : {}),
    ...(silent ? { silent } : {}),
  })
  // A failed refresh keeps what was known before, next to its error.
  if (failure) availability.refresh_error = failure.message
  return {
    availability,
    checkedAt: derived.state === 'lookup_failed' ? 0 : lastCheckedAt(record),
    stale: derived.stale,
    running,
  }
}

function outcomeOf(
  config: Config,
  fingerprint: string,
  sourceId: string,
  result: Partial<SearchResult & VerifyResult>,
): UsenetSourceOutcome {
  const done = {
    queries: [...(result.queries ?? [])],
    deferred: result.deferred ?? false,
    ...(result.deferredUntil ? { deferredUntil: result.deferredUntil } : {}),
    fetched: result.fetched ?? 0,
    ...(result.reason ? { reason: result.reason } : {}),
  }
  if (result.cancelled)
    return {
      availability: failedAvailability(sourceId, 'network', 'lookup cancelled'),
      checkedAt: 0,
      stale: true,
      running: false,
      ...done,
      cancelled: true,
    }
  if (result.unconfigured)
    return {
      availability: notConfigured(sourceId, result.unconfigured),
      checkedAt: 0,
      stale: false,
      running: false,
      ...done,
    }
  const key = sourceKey(fingerprint, sourceId)
  // The caller's own `resolveSource` is still counted, and is no reason to poll.
  return {
    ...snapshotOf(config, fingerprint, sourceId, Date.now()),
    running: searches.has(key) || verifies.has(key),
    ...done,
  }
}

/** A search result as a candidate. Undefined when Prowlarr's link has no form a fetch could be rebuilt from. */
function candidateOf(result: ProwlarrSearchResult, indexer: string): StoredCandidate | undefined {
  const ref = downloadRef(result)
  if (!ref) return undefined
  return {
    entry_id: candidateEntryId(result.indexer_id, result.guid),
    indexer_id: result.indexer_id,
    indexer,
    title: safeText(result.title, TITLE_LIMIT),
    size: result.size,
    ...(result.files !== undefined ? { files: result.files } : {}),
    ...(result.grabs !== undefined ? { grabs: result.grabs } : {}),
    ...(result.posted_at !== undefined ? { posted_at: result.posted_at } : {}),
    ...(result.info_url ? { info_url: result.info_url } : {}),
    download: { link: ref.link, file: ref.file },
  }
}

/** Merges what one search found into the stored record. Reads and writes without waiting in between. */
function storeSearch(
  fingerprint: string,
  sourceId: string,
  facts: SourceFacts,
  indexers: ProwlarrIndexer[],
  runs: IndexerRun[],
  found: Map<string, StoredCandidate>,
): void {
  const at = Date.now()
  const current = searchStore.get(fingerprint, sourceId)
  const enabled = new Set(indexers.map(indexer => indexer.id))
  const merged = new Map<string, StoredCandidate>()
  // An indexer that left Prowlarr can no longer be fetched from; what was learned from it stays.
  for (const candidate of current?.candidates ?? [])
    if (enabled.has(candidate.indexer_id) || candidate.check || candidate.rejected)
      merged.set(candidate.entry_id, candidate)
  for (const [entry, candidate] of found) {
    const old = merged.get(entry)
    merged.set(entry, {
      ...candidate,
      ...(old?.check ? { check: old.check } : {}),
      ...(old?.rejected ? { rejected: old.rejected } : {}),
    })
  }
  // A rejected candidate is never ranked, and one that cost a fetch is never dropped.
  const everything = [...merged.values()]
  const ranked = rankCandidates(
    everything.filter(candidate => !candidate.rejected),
    facts,
  )
  const kept = [...ranked, ...everything.filter(candidate => candidate.rejected)]
  let room = CANDIDATE_LIMIT - kept.filter(candidate => candidate.check || candidate.rejected).length
  const candidates = kept.filter(candidate => Boolean(candidate.check || candidate.rejected) || room-- > 0)

  const ran = new Map(runs.map(run => [run.indexer.id, run]))
  const previous = new Map(current?.indexers.map(entry => [entry.id, entry]))
  const listed: SearchedIndexer[] = []
  const retries: number[] = []
  for (const indexer of indexers) {
    const run = ran.get(indexer.id)
    const old = previous.get(indexer.id)
    const name = indexerName(indexer)
    if (run && !run.deferred) {
      listed.push({ id: indexer.id, name, answered: run.answered, at })
      if (!run.answered) retries.push(run.retryAt)
    } else if (old) {
      // Not asked this time: what it said before stands, and so does its retry time.
      listed.push({ ...old, name })
      if (!old.answered) retries.push(current?.retry_at ?? 0)
    }
  }
  const full = runs.length === indexers.length
  const absent = !candidates.length && listed.length === indexers.length && listed.every(entry => entry.answered)
  const streak = current && !current.candidates.length ? (current.negative_streak ?? 0) : 0
  searchStore.put({
    source_id: sourceId,
    fingerprint,
    // Only a search of every indexer renews the result; a retry of one indexer adds to it.
    searched_at: full && runs.some(run => run.answered) ? at : (current?.searched_at ?? at),
    last_attempt_at: at,
    retry_at: retries.length ? Math.max(at + RETRY_MIN_MS, Math.min(...retries)) : 0,
    ...(absent ? { negative_streak: full ? streak + 1 : Math.max(streak, 1) } : {}),
    indexers: listed,
    candidates,
  })
}

async function runSearch(flight: SearchFlight, request: SearchRequest): Promise<SearchResult> {
  const { config, settings, fingerprint, source, terms, refresh } = request
  const key = sourceKey(fingerprint, source.id)
  const started = epoch
  const { signal } = flight.controller
  const cancelled = () => started !== epoch || signal.aborted
  let indexers: ProwlarrIndexer[]
  try {
    indexers = await usenetIndexers(settings, fingerprint, started)
  } catch (error) {
    if (cancelled()) return SEARCH_CANCELLED
    rememberFailure(key, requestFailure(error, 'search', 'prowlarr'))
    return { ...NOTHING, complete: true }
  }
  if (cancelled()) return SEARCH_CANCELLED
  if (!indexers.length) return { ...NOTHING, complete: true, unconfigured: NO_USENET_INDEXER }

  const startedAt = Date.now()
  const before = searchStore.get(fingerprint, source.id)
  const due =
    refresh || !before ? indexers.map(indexer => indexer.id) : searchRecordState(before, startedAt, indexers).ask
  const runs = indexers
    .filter(indexer => due.includes(indexer.id))
    .map((indexer): IndexerRun => ({
      indexer,
      name: indexerName(indexer),
      channel: channelOf(indexer.id),
      active: true,
      answered: true,
      deferred: false,
      retryAt: 0,
      queries: 0,
    }))
  if (!runs.length) return NOTHING

  const facts = sourceFacts(source.files, terms.releaseGroup)
  const found = new Map<string, StoredCandidate>()
  const stored = new Map(before?.candidates.map(candidate => [candidate.entry_id, candidate]))
  let fatal: ProwlarrError | undefined
  let deferredUntil = 0

  const fail = (run: IndexerRun, retryAt: number, code: UsenetFailureCode, message: string) => {
    run.active = false
    run.answered = false
    run.retryAt = Math.max(run.retryAt, retryAt)
    indexerFailures.set(indexerKey(fingerprint, run.indexer.id), { code, message })
  }
  /** Whether the daily limit keeps a background search from this indexer; the indexer is then left out. */
  const refused = (run: IndexerRun): boolean => {
    const limit = searchLimit(config, run.indexer)
    if (!limit || searchStore.usage(fingerprint, run.indexer.id).searches < limit) return false
    run.active = false
    run.answered = false
    run.deferred = true
    const next = searchStore.nextAvailableAt(fingerprint, run.indexer.id, 'search', limit)
    deferredUntil = deferredUntil ? Math.min(deferredUntil, next) : next
    return true
  }
  const ask = async (run: IndexerRun, query: SearchQuery): Promise<void> => {
    const job: LookupJob = { channel: run.channel, background: flight.background, controller: flight.controller }
    if (job.background && refused(run)) return
    flight.jobs.add(job)
    try {
      await searchScheduler.acquire(job)
    } catch (error) {
      flight.jobs.delete(job)
      if (error instanceof ProviderPausedError) {
        const rateLimited = searchScheduler.pausedFailure(run.channel, error.until).code === 'rate_limited'
        fail(
          run,
          error.until,
          rateLimited ? 'rate_limited' : 'server',
          rateLimited
            ? `${run.name} is rate limiting requests and is not asked for now.`
            : `Requests to ${run.name} are failing; it is not asked for now.`,
        )
      } else if (!cancelled()) fail(run, 0, 'network', `${run.name} could not be searched.`)
      return
    }
    let results: ProwlarrSearchResult[]
    try {
      signal.throwIfAborted()
      // Background work is counted and limited, read with the slot in hand because other sources use the
      // same budget. A search someone waits for is paced only, also when it started in the background.
      if (job.background) {
        if (refused(run)) return
        searchStore.countSearch(fingerprint, run.indexer.id)
      }
      run.queries++
      results = await bounded(searchIndexer({ ...settings, signal }, run.indexer, query), signal, SEARCH_GUARD_MS)
    } catch (error) {
      if (cancelled()) return
      const failure = requestFailure(error, 'search')
      // Prowlarr refusing its key fails everything; anything else is this indexer's failure only.
      if (failure.scope === 'prowlarr') fatal ??= failure
      else {
        searchScheduler.recordOutcome(run.channel, failedOutcome(failure))
        fail(run, retryTime(run.channel, failure, Date.now()), failure.code, failure.message)
        warnOnce(run.channel, `Prowlarr search of ${run.name} failed: ${failure.message}`)
      }
      return
    } finally {
      searchScheduler.release()
      flight.jobs.delete(job)
    }
    searchScheduler.recordOutcome(run.channel, ANSWERED)
    for (const result of results) {
      const candidate = candidateOf(result, run.name)
      if (candidate && isPlausible(candidate, facts)) found.set(candidate.entry_id, candidate)
    }
  }
  /** A strong candidate ends the search, unless it is already known to be no copy of the release. */
  const settled = () =>
    [...found.values()].some(candidate => {
      const old = stored.get(candidate.entry_id)
      const seen = old ? standing(old, startedAt) : 'unchecked'
      return seen !== 'graded' && seen !== 'rejected' && isStrong(candidate, facts)
    })

  // Prowlarr leaves an indexer it disabled alone, so asking would only be refused.
  for (const run of runs) {
    const until = run.indexer.disabledTill ?? 0
    if (until > startedAt) fail(run, until, 'server', `${run.name} is disabled in Prowlarr after repeated failures.`)
  }
  for (const query of queryLadder(source.files, terms)) {
    const active = runs.filter(run => run.active)
    if (!active.length) break
    await Promise.all(active.map(run => ask(run, query)))
    if (cancelled()) return SEARCH_CANCELLED
    if (fatal || settled()) break
  }

  const queries = runs.filter(run => run.queries).map(run => ({ indexer: run.name, count: run.queries }))
  if (fatal) {
    rememberFailure(key, fatal)
    return { complete: true, deferred: false, queries }
  }
  for (const run of runs) if (run.answered) indexerFailures.delete(indexerKey(fingerprint, run.indexer.id))
  const deferred = runs.some(run => run.deferred)
  // Indexers the limit left out are neither listed as answered nor as failed: the record stays stale for them.
  if (runs.some(run => !run.deferred)) storeSearch(fingerprint, source.id, facts, indexers, runs, found)
  failures.delete(key)
  return {
    complete: runs.length === indexers.length && !deferred,
    deferred,
    ...(deferred ? { deferredUntil } : {}),
    queries,
  }
}

/**
 * The running search of a source, promoted when someone waits for it, or a new one. `loose` is a caller
 * whose check may be cancelled; a search stays loose only while no other kind of caller waits for it.
 */
function sharedSearch(request: SearchRequest, background: boolean, loose: boolean): Promise<SearchResult> {
  const key = sourceKey(request.fingerprint, request.source.id)
  const running = searches.get(key)
  if (running) {
    if (!loose) running.loose = false
    if (!background && running.background) {
      running.background = false
      for (const job of running.jobs) job.background = false
      searchScheduler.pump()
    }
    // "Search again" asks every indexer; a running search that asked only some is followed by one that does.
    return request.refresh
      ? running.promise.then(result => (result.complete ? result : sharedSearch(request, background, loose)))
      : running.promise
  }
  // Prowlarr itself failed a moment ago: it is not asked again before its retry time unless told to.
  const failure = failures.get(key)
  if (!request.refresh && failure && Date.now() < failure.retryAt) return Promise.resolve(NOTHING)
  const flight: SearchFlight = {
    controller: new AbortController(),
    jobs: new Set(),
    background,
    loose,
    promise: Promise.resolve()
      .then(() => runSearch(flight, request))
      .catch((error): SearchResult => {
        rememberFailure(key, requestFailure(error, 'search', 'prowlarr'))
        return { ...NOTHING, complete: true }
      })
      .finally(() => {
        if (searches.get(key) === flight) searches.delete(key)
      }),
  }
  searches.set(key, flight)
  return flight.promise
}

/**
 * Search stage: asks the Usenet indexers that are due for a source and merges what they list into the
 * stored record. Nothing is asked while the record is fresh; `refresh` asks every indexer regardless. One
 * request per indexer and query, each on that indexer's channel; a query goes to every indexer at once, and
 * the first query that finds a strong candidate is the last. Never fetches an NZB.
 *
 * A search already running for the source is shared, and a caller that is not `background` promotes it. An
 * indexer that fails, is paused or is disabled in Prowlarr is recorded as not answered while the others go
 * on; a refused Prowlarr key fails the lookup and writes nothing. Background searches are counted and stop
 * at the daily limit per indexer (`deferred`); a search someone waits for is only paced.
 *
 * `cancellable` marks a search made for a check `cancelSourceCheck` may withdraw (see there).
 */
export async function searchSource(
  config: Config,
  source: PrivateSource,
  context: UsenetSearchContext,
  {
    background = false,
    refresh = false,
    cancellable = false,
  }: { background?: boolean; refresh?: boolean; cancellable?: boolean } = {},
): Promise<UsenetSourceOutcome> {
  const settings = connectionFor(config, source.id)
  if (!settings) return outcomeOf(config, '', source.id, { unconfigured: NOT_SET_UP })
  const fingerprint = prowlarrFingerprint(settings)
  sourceFiles.set(source.id, source.files)
  const request: SearchRequest = { config, settings, fingerprint, source, terms: context, refresh }
  return outcomeOf(config, fingerprint, source.id, await sharedSearch(request, background, cancellable))
}

function checkOf(grade: NzbGrade, at: number, sha256: string): StoredCheck {
  return {
    at,
    proof: grade.proof,
    files_matched: grade.files_matched,
    names_matched: grade.names_matched,
    files_expected: grade.files_expected,
    sizes_known: grade.sizes_known,
    ...(grade.ratio ? { ratio: grade.ratio } : {}),
    nzb_sha256: sha256,
  }
}

/** Writes a candidate's check before anything else happens, so a fetch is never spent twice after a crash. */
function saveCheck(fingerprint: string, sourceId: string, entryId: string, check: StoredCheck | undefined): void {
  const record = searchStore.get(fingerprint, sourceId)
  const candidate = record?.candidates.find(entry => entry.entry_id === entryId)
  if (!record || !candidate) return
  if (check) candidate.check = check
  else delete candidate.check
  searchStore.put(record, { durable: true })
}

/** Calibration: the ratios of exact matches say what a correct post looks like on this installation's indexers. */
function logGrade(indexer: string, grade: NzbGrade): void {
  const ratio = grade.ratio ? `ratio ${grade.ratio[0].toFixed(4)} to ${grade.ratio[1].toFixed(4)}` : 'no ratio measured'
  log('INFO', `Usenet NZB from ${indexer} graded ${grade.proof}; ${ratio}`)
}

/**
 * One NZB through Prowlarr, on the indexer's channel and counted against the daily limit before it is asked
 * for. Aborting `queued` gives up the wait for the slot (`withdrawn`); once the request is sent only
 * `controller` stops it.
 */
async function fetchNzb(
  config: Config,
  settings: ProwlarrSettings,
  fingerprint: string,
  candidate: StoredCandidate,
  indexer: string,
  controller: AbortController,
  queued: AbortController = controller,
): Promise<
  | { kind: 'fetched'; nzb: Uint8Array; files: NzbFile[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; failure: ProwlarrError }
  | { kind: 'cancelled' }
  | { kind: 'withdrawn' }
> {
  const channel = channelOf(candidate.indexer_id)
  const { signal } = controller
  try {
    await searchScheduler.acquire({ channel, background: false, controller: queued })
  } catch (error) {
    if (signal.aborted) return { kind: 'cancelled' }
    if (queued.signal.aborted) return { kind: 'withdrawn' }
    const until = error instanceof ProviderPausedError ? error.until : searchScheduler.pausedUntil(channel)
    return { kind: 'blocked', reason: searchScheduler.pausedFailure(channel, until).message }
  }
  try {
    signal.throwIfAborted()
    // Given up between getting the slot and using it: nothing was asked for yet.
    if (queued.signal.aborted) return { kind: 'withdrawn' }
    // Read with the slot in hand: checks of other sources spend the same daily limit.
    const block = fetchBlock(config, fingerprint, candidate.indexer_id, indexer, Date.now())
    if (block) return { kind: 'blocked', reason: block }
    searchStore.countFetch(fingerprint, candidate.indexer_id)
    const path = downloadPathFromRef(settings, { indexer_id: candidate.indexer_id, ...candidate.download })
    const bytes = await bounded(
      prowlarrDownload({ ...settings, signal }, { download_path: path }, NZB_MAX_BYTES),
      signal,
      FETCH_GUARD_MS,
    )
    let fetched: { kind: 'fetched'; nzb: Uint8Array; files: NzbFile[] }
    try {
      const nzb = await gunzipOnce(bytes, NZB_MAX_BYTES)
      // `nzbFiles` validates the NZB before it reads it.
      fetched = { kind: 'fetched', nzb, files: nzbFiles(nzb) }
    } catch {
      throw new ProwlarrError('invalid_response', 'The indexer did not send a valid NZB', undefined, 'indexer')
    }
    searchScheduler.recordOutcome(channel, ANSWERED)
    return fetched
  } catch (error) {
    if (signal.aborted) return { kind: 'cancelled' }
    const failure = requestFailure(error, 'NZB download')
    // What an indexer did, its channel learns; a failure of Prowlarr says nothing about the indexer.
    if (failure.scope === 'indexer') searchScheduler.recordOutcome(channel, failedOutcome(failure))
    return { kind: 'failed', failure }
  } finally {
    searchScheduler.release()
  }
}

async function runVerify(
  flight: VerifyFlight,
  config: Config,
  settings: ProwlarrSettings,
  fingerprint: string,
  source: PrivateSource,
): Promise<VerifyResult> {
  const key = sourceKey(fingerprint, source.id)
  const started = epoch
  const cancelled = () => started !== epoch || flight.controller.signal.aborted
  let indexers: ProwlarrIndexer[]
  try {
    indexers = await usenetIndexers(settings, fingerprint, started)
  } catch (error) {
    if (cancelled()) return VERIFY_CANCELLED
    rememberFailure(key, requestFailure(error, 'NZB check', 'prowlarr'))
    return { fetched: 0 }
  }
  if (cancelled()) return VERIFY_CANCELLED
  if (!indexers.length) return { fetched: 0, unconfigured: NO_USENET_INDEXER }
  const names = new Map(indexers.map(indexer => [indexer.id, indexerName(indexer)]))
  const videos = source.files.filter(file => VIDEO_FILE.test(file.name)).length
  /** Indexers this walk no longer fetches from, and candidates it has dealt with. */
  const stopped = new Set<number>()
  const tried = new Set<string>()
  let fetched = 0
  let reason: string | undefined
  while (fetched < flight.limit && !flight.withdrawn) {
    const now = Date.now()
    const record = searchStore.get(fingerprint, source.id)
    if (!record || searchRecordState(record, now).state === 'available') break
    // The record is ranked best first. A candidate of an indexer that left Prowlarr cannot be fetched.
    const candidate = record.candidates.find(
      entry =>
        standing(entry, now) === 'unchecked' &&
        !tried.has(entry.entry_id) &&
        !stopped.has(entry.indexer_id) &&
        names.has(entry.indexer_id),
    )
    if (!candidate) break
    tried.add(candidate.entry_id)
    const indexer = names.get(candidate.indexer_id)!
    const block = fetchBlock(config, fingerprint, candidate.indexer_id, indexer, now)
    flight.queued = block ? undefined : new AbortController()
    const step = flight.queued
      ? await fetchNzb(config, settings, fingerprint, candidate, indexer, flight.controller, flight.queued)
      : ({ kind: 'blocked', reason: block! } as const)
    flight.queued = undefined
    if (step.kind === 'cancelled' || cancelled()) return VERIFY_CANCELLED
    // The check was cancelled while it waited: the candidate stays unchecked, and no grab was spent.
    if (step.kind === 'withdrawn') break
    if (step.kind === 'blocked') {
      // Paused or out of fetches for today: no error, the candidates of this indexer just wait.
      reason ??= step.reason
      stopped.add(candidate.indexer_id)
      continue
    }
    fetched++
    const at = Date.now()
    if (step.kind === 'fetched') {
      const grade = gradeNzb(step.files, source.files)
      const sha256 = searchStore.storeNzb(step.nzb)
      saveCheck(fingerprint, source.id, candidate.entry_id, checkOf(grade, at, sha256))
      logGrade(indexer, grade)
      failures.delete(key)
      continue
    }
    const { failure } = step
    const unreadable = failure.code === 'invalid_response'
    // Prowlarr itself failing fails the check. A file that cannot be read is that candidate's fault only.
    if (failure.scope === 'prowlarr' && !unreadable) {
      rememberFailure(key, failure)
      break
    }
    saveCheck(fingerprint, source.id, candidate.entry_id, {
      at,
      proof: 'unverified',
      files_matched: 0,
      names_matched: 0,
      files_expected: videos,
      sizes_known: false,
      unavailable: {
        code: failure.code,
        retry_at: unreadable ? at + UNREADABLE_RETRY_MS : retryTime(channelOf(candidate.indexer_id), failure, at),
      },
    })
    if (unreadable) continue
    // The indexer refused or could not answer: nothing more is fetched from it, and nothing is concluded.
    stopped.add(candidate.indexer_id)
    warnOnce(`fetch:${candidate.indexer_id}`, `Prowlarr NZB fetch from ${indexer} failed: ${failure.message}`)
  }
  return { fetched, ...(!fetched && reason ? { reason } : {}) }
}

/**
 * The running check of a source when it fetches at least as much, otherwise a walk that goes on after it.
 * `loose` is a caller whose check may be cancelled; a walk stays loose only while no other kind of caller
 * waits for it.
 */
function sharedVerify(
  config: Config,
  settings: ProwlarrSettings,
  fingerprint: string,
  source: PrivateSource,
  limit: number,
  loose: boolean,
): Promise<VerifyResult> {
  const key = sourceKey(fingerprint, source.id)
  const running = verifies.get(key)
  if (running) {
    if (!loose) running.loose = false
    // A cancelled walk ends after the fetch it is in, so whoever comes now may have to go on after it.
    if (running.limit >= limit && !running.withdrawn) return running.promise
    return running.promise.then(async first => {
      if (first.cancelled || first.unconfigured || first.fetched >= limit) return first
      const rest = await sharedVerify(config, settings, fingerprint, source, limit - first.fetched, loose)
      return { ...rest, fetched: first.fetched + rest.fetched }
    })
  }
  const flight: VerifyFlight = {
    controller: new AbortController(),
    limit,
    loose,
    promise: Promise.resolve()
      .then(() => runVerify(flight, config, settings, fingerprint, source))
      .catch((error): VerifyResult => {
        rememberFailure(key, requestFailure(error, 'NZB check', 'prowlarr'))
        return { fetched: 0 }
      })
      .finally(() => {
        if (verifies.get(key) === flight) verifies.delete(key)
      }),
  }
  verifies.set(key, flight)
  return flight.promise
}

/**
 * Verify stage: walks the stored candidates of a source, best first, leaving out the checked and the
 * rejected ones, and fetches and grades their NZBs until one is proven (`exact` or `near_exact`) or `limit`
 * fetches were made. Never searches.
 *
 * - Each fetch takes a foreground slot on the indexer's channel and is counted before it is sent. An indexer
 *   that is paused or has no fetch left today is skipped without an error; when that leaves nothing to
 *   fetch, `reason` says why.
 * - A graded NZB is stored and its candidate's check written at once.
 * - An indexer that refuses or cannot answer marks its candidate unavailable until a retry time and is not
 *   fetched from again in this walk: the source is then `lookup_failed`, never `no_match`, unless another
 *   candidate is proven. A body that is no NZB marks that candidate only. Prowlarr failing ends the walk.
 * - A check already running for the source is shared; a caller that may fetch more goes on after it.
 * - `cancellable` marks a check `cancelSourceCheck` may withdraw (see there).
 */
export async function verifySource(
  config: Config,
  source: PrivateSource,
  { limit, cancellable = false }: { limit: number; cancellable?: boolean },
): Promise<UsenetSourceOutcome> {
  const settings = connectionFor(config, source.id)
  if (!settings) return outcomeOf(config, '', source.id, { unconfigured: NOT_SET_UP })
  const fingerprint = prowlarrFingerprint(settings)
  sourceFiles.set(source.id, source.files)
  if (!(limit > 0)) return outcomeOf(config, fingerprint, source.id, {})
  const verified = await sharedVerify(config, settings, fingerprint, source, limit, cancellable)
  return outcomeOf(config, fingerprint, source.id, verified)
}

/**
 * Does what a caller asks for one source: searches when no fresh record exists, or always with `refresh`,
 * then checks up to `limit` candidates. `background` is for the sweep: the search runs at background
 * priority within the daily search limit, and no NZB is fetched whatever `limit` says.
 *
 * Candidates are checked while none was graded yet (`unverified`). A source that already has graded
 * candidates and no proof is checked further only with `refresh`, so a review cannot spend a fetch on it
 * each time it opens. Use a limit of 3 for an explicit search and a single download, 1 for a bulk review.
 *
 * `cancellable` is for the rows a bulk review selected: `cancelSourceCheck` withdraws what such a call
 * still waits for.
 */
export async function resolveSource(
  config: Config,
  source: PrivateSource,
  context: UsenetSearchContext,
  {
    limit = 0,
    refresh = false,
    background = false,
    cancellable = false,
  }: { limit?: number; refresh?: boolean; background?: boolean; cancellable?: boolean } = {},
): Promise<UsenetSourceOutcome> {
  const settings = connectionFor(config, source.id)
  if (!settings) return outcomeOf(config, '', source.id, { unconfigured: NOT_SET_UP })
  const key = sourceKey(prowlarrFingerprint(settings), source.id)
  const call: ResolveCall = { cancellable, withdrawn: false }
  const calls = resolving.get(key) ?? new Set<ResolveCall>()
  resolving.set(key, calls.add(call))
  try {
    const searched = await searchSource(config, source, context, { background, refresh, cancellable })
    const { state } = searched.availability
    const unproven = state === 'unverified' || (refresh && (state === 'no_match' || state === 'lookup_failed'))
    // Prowlarr failing a moment ago would fail the fetch as well.
    const failing = Date.now() < (failures.get(key)?.retryAt ?? 0)
    const done = background || !(limit > 0) || searched.cancelled || call.withdrawn || !unproven || failing
    if (done) return searched
    const verified = await verifySource(config, source, { limit, cancellable })
    return {
      ...verified,
      queries: searched.queries,
      deferred: searched.deferred,
      ...(searched.deferredUntil ? { deferredUntil: searched.deferredUntil } : {}),
    }
  } finally {
    calls.delete(call)
    if (!calls.size) resolving.delete(key)
  }
}

/**
 * Withdraws the checks `cancellable` callers asked for one source, because its review was cancelled or its
 * row was switched to a torrent.
 *
 * - A check still waiting for its slot is dropped, and so is a search only such callers wait for. Nothing
 *   they had not stored yet is kept, and no grab is spent.
 * - An NZB that is already being fetched is fetched to the end, graded and stored: its grab is spent. No
 *   further candidate is fetched after it.
 * - Work that an explicit search, a single review or the sweep also waits for goes on untouched.
 */
export function cancelSourceCheck(config: Config, sourceId: string): void {
  const settings = connectionFor(config, sourceId)
  if (!settings) return
  const key = sourceKey(prowlarrFingerprint(settings), sourceId)
  for (const call of resolving.get(key) ?? []) if (call.cancellable) call.withdrawn = true
  const search = searches.get(key)
  if (search?.loose) {
    // Whoever asks next starts a search of their own.
    searches.delete(key)
    search.controller.abort()
  }
  const check = verifies.get(key)
  if (check?.loose) {
    check.withdrawn = true
    check.queued?.abort()
  }
}

/**
 * What is stored about a source right now, as an availability row. Makes no request and waits for nothing.
 * `not_configured` when Prowlarr may not be used for the source; the store is not read then.
 */
export function searchSnapshot(config: Config, sourceId: string): UsenetSearchSnapshot {
  const settings = connectionFor(config, sourceId)
  if (!settings)
    return { availability: notConfigured(sourceId, NOT_SET_UP), checkedAt: 0, stale: false, running: false }
  return snapshotOf(config, prowlarrFingerprint(settings), sourceId, Date.now())
}

/** A stored candidate an NZB may be sent for: fetched, graded and not rejected. */
function sendable(fingerprint: string, sourceId: string, entryId: string): StoredCandidate | undefined {
  const candidates = searchStore.get(fingerprint, sourceId)?.candidates
  const candidate = candidates?.find(entry => entry.entry_id === entryId)
  return candidate && !candidate.rejected && candidate.check && !candidate.check.unavailable ? candidate : undefined
}

/**
 * The candidate the user chose by its entry ID, as an `available` row the planner can send, with the proof
 * its NZB reached. Undefined unless the candidate was fetched and graded and is not rejected. Never
 * searches or fetches.
 */
export function chosenSearchCandidate(
  config: Config,
  sourceId: string,
  entryId: string,
): UsenetHashAvailability | undefined {
  const settings = connectionFor(config, sourceId)
  const candidate = settings ? sendable(prowlarrFingerprint(settings), sourceId, entryId) : undefined
  return candidate && matchAvailability(sourceId, candidate)
}

/**
 * The NZB of a checked candidate, for an accepted submission: the stored bytes, with no request. When they
 * were evicted the NZB is fetched once more, within the daily limit, and returned only when it is the same
 * file or grades to the same proof against `files` (by default the file list this process last saw for the
 * source). Otherwise the candidate's check is replaced by what the new file shows, or dropped when nothing
 * could be compared, and the error tells the user to run the review again.
 */
export async function searchNzbBytes(
  config: Config,
  sourceId: string,
  entryId: string,
  files: SourceFile[] | undefined = sourceFiles.get(sourceId),
): Promise<Uint8Array> {
  const settings = prowlarrSettings(config)
  if (!settings) throw new Error('Prowlarr is no longer configured.')
  const fingerprint = prowlarrFingerprint(settings)
  const candidate = sendable(fingerprint, sourceId, entryId)
  const check = candidate?.check
  if (!candidate || !check) throw new Error(NZB_UNKNOWN)
  const stored = check.nzb_sha256 ? searchStore.readNzb(check.nzb_sha256) : null
  if (stored) return stored

  const started = epoch
  const step = await fetchNzb(config, settings, fingerprint, candidate, candidate.indexer, new AbortController())
  if (step.kind === 'blocked') throw new Error(`The checked NZB has to be fetched again first. ${step.reason}`)
  if (step.kind === 'failed')
    throw new Error(`The checked NZB could not be fetched again (${step.failure.message}). Re-run the review.`)
  if (step.kind !== 'fetched' || started !== epoch) throw new Error(NZB_UNKNOWN)
  const sha256 = createHash('sha256').update(step.nzb).digest('hex')
  if (sha256 === check.nzb_sha256) {
    searchStore.storeNzb(step.nzb)
    return step.nzb
  }
  // Another file under the same entry: it is sent only when it proves as much as the one that was checked.
  const grade = files?.length ? gradeNzb(step.files, files) : undefined
  if (grade) {
    saveCheck(fingerprint, sourceId, entryId, checkOf(grade, Date.now(), searchStore.storeNzb(step.nzb)))
    logGrade(candidate.indexer, grade)
    if (grade.proof === check.proof) return step.nzb
  } else saveCheck(fingerprint, sourceId, entryId, undefined)
  throw new Error(NZB_CHANGED)
}

/**
 * Marks a candidate as not the listed release, after an import showed other files. It is never ranked,
 * checked or reported as available again, and its source is `no_match` with its candidates until another
 * one is proven. Written at once. False when the candidate is not known.
 */
export function rejectSearchCandidate(config: Config, sourceId: string, entryId: string): boolean {
  const fingerprint = connectionFingerprint(config)
  const record = fingerprint ? searchStore.get(fingerprint, sourceId) : undefined
  const candidate = record?.candidates.find(entry => entry.entry_id === entryId)
  if (!record || !candidate) return false
  if (!candidate.rejected) {
    candidate.rejected = { at: Date.now(), reason: 'import_mismatch' }
    searchStore.put(record, { durable: true })
  }
  return true
}

/**
 * NZB fetches left today, and any pause, for each Usenet indexer Prowlarr is known to have. Never waits
 * for Prowlarr: an indexer list that was not read yet gives an empty answer and is read in the background.
 */
export function prowlarrIndexerUsage(config: Config): ProwlarrIndexerUsage[] {
  const settings = prowlarrSettings(config)
  if (!settings) return []
  const fingerprint = prowlarrFingerprint(settings)
  const listed = knownProwlarrIndexers(settings)?.filter(indexer => indexer.protocol === 'usenet')
  if (listed) noteIndexers(fingerprint, listed)
  const now = Date.now()
  const limit = config.prowlarr_fetch_limit
  return (listed ?? (known?.fingerprint === fingerprint ? known.indexers : [])).map(indexer => {
    const left = limit > 0 ? Math.max(0, limit - searchStore.usage(fingerprint, indexer.id, now).fetches) : null
    const paused = searchScheduler.pausedUntil(channelOf(indexer.id)) - now
    return {
      indexer: indexerName(indexer),
      fetches_left: left,
      ...(left === 0
        ? {
            next_fetch_seconds: seconds(
              searchStore.nextAvailableAt(fingerprint, indexer.id, 'fetch', limit, now) - now,
            ),
          }
        : {}),
      ...(paused > 0 ? { paused_seconds: seconds(paused) } : {}),
    }
  })
}

/**
 * Whether every one of `indexers` has spent its background searches of the last 24 hours, so a background
 * search of the source would ask none of them. False without indexers or without a limit.
 */
export function backgroundSearchesSpent(
  config: Config,
  sourceId: string,
  indexers: ProwlarrIndexer[],
  now = Date.now(),
): boolean {
  const settings = connectionFor(config, sourceId)
  if (!settings || !indexers.length) return false
  const fingerprint = prowlarrFingerprint(settings)
  return indexers.every(indexer => {
    const limit = searchLimit(config, indexer)
    return limit > 0 && searchStore.usage(fingerprint, indexer.id, now).searches >= limit
  })
}

/** Active pauses of Usenet indexers in Prowlarr, for status reporting. */
export function usenetSearchPauses(): ChannelPause[] {
  return searchScheduler.pauses()
}

function cancelWork(): void {
  epoch++
  const checks = [...verifies.values()]
  const cancelled = [...searches.values(), ...checks]
  searches.clear()
  verifies.clear()
  failures.clear()
  indexerFailures.clear()
  lastLogged.clear()
  disabledUntil.clear()
  known = undefined
  for (const flight of cancelled) flight.controller.abort()
  // A fetch waits for its slot on a controller of its own.
  for (const check of checks) check.queued?.abort()
  // Channels are named by indexer ID, and another Prowlarr numbers other indexers the same way.
  searchScheduler.reset()
}

/**
 * For a changed Prowlarr URL or key: running searches and checks are cancelled and what they learn is
 * discarded, the indexers' pacing is forgotten, and the records, counters and stored NZBs of every other
 * connection are dropped. The client's indexer list is reset by the caller (`resetProwlarrRuntime`).
 */
export function invalidateUsenetSearch(config: Config): void {
  cancelWork()
  const removed = searchStore.retainFingerprint(connectionFingerprint(config))
  if (removed) log('INFO', `Usenet search store dropped ${removed} record(s) of another Prowlarr connection`)
}

/** Writes pending search records now, for a graceful shutdown. False when the write failed. */
export function flushUsenetSearch(): boolean {
  return searchStore.flush()
}

/**
 * Drops the records, with their stored NZBs, of sources that are not in `keep`. Pass every source the
 * current results reference and every source an active download record names.
 */
export function retainSearchSources(keep: ReadonlySet<string>): number {
  for (const sourceId of sourceFiles.keys()) if (!keep.has(sourceId)) sourceFiles.delete(sourceId)
  return searchStore.retainSources(keep)
}

/** Tests: cancels work and clears memory without touching the files; `restoreFromDisk` simulates a restart. */
export function resetUsenetSearch(restoreFromDisk = false): void {
  cancelWork()
  sourceFiles.clear()
  searchStore.reset(restoreFromDisk)
}
