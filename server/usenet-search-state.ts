// What a stored search record says about its source: its state and freshness, and the availability row built
// from it. Everything here is pure. Whatever only the running process knows (pauses, usage limits, why an
// indexer was silent) is handed in by `server/usenet-search.ts`.
//
// A row names candidates by their entry IDs and never carries a download reference.

import type {
  UsenetCandidate,
  UsenetFailureCode,
  UsenetHashAvailability,
  UsenetProof,
} from '../shared/usenet-contracts.js'
import type { SearchRecord, StoredCandidate } from './usenet-search-store.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** How long a stored result stands before the source is searched again. */
const PROVEN_FRESH_MS = 30 * DAY
const CANDIDATES_FRESH_MS = 7 * DAY
/** Consecutive absences back off: a release missing for weeks is unlikely to be posted within the day. */
const ABSENT_FRESH_STEPS_MS = [DAY, 3 * DAY, 7 * DAY, 30 * DAY]
/** An indexer that failed is not asked again sooner than this, whatever its pause. */
export const RETRY_MIN_MS = MINUTE

/** What a failed NZB fetch says about its indexer, after the indexer's name. */
const FETCH_FAILURE: Record<UsenetFailureCode, string> = {
  rate_limited: 'is limiting NZB downloads for now',
  unauthorized: 'refused the NZB download; check the indexer in Prowlarr',
  server: 'could not send the NZB',
  timeout: 'did not send the NZB in time',
  network: 'could not be reached for the NZB',
  invalid_response: 'did not send a usable NZB',
  invalid_config: 'is turned off in Prowlarr',
}

export type SearchState = 'available' | 'unverified' | 'no_match' | 'lookup_failed' | 'not_checked'

/** What a stored record says about its source at one moment. It names candidates and never carries their references. */
export interface SearchRecordState {
  state: SearchState
  /** The proven candidate of an available source, and how its NZB proved it. */
  entry_id?: string
  proof?: UsenetProof
  /** Whom a failed lookup waits for. `code` is known when it was an NZB fetch that failed. */
  failed?: { indexer_id: number; indexer: string; code?: UsenetFailureCode; retry_at: number }
  /** Epoch ms until which the stored result stands; 0 without a record. */
  fresh_until: number
  /** A search is due: the result aged out, or an enabled indexer has still to answer and may be asked. */
  stale: boolean
  /** IDs of the enabled indexers a search has to ask: all once the result aged out, otherwise those due. */
  ask: number[]
}

export type Standing = 'proven' | 'graded' | 'blocked' | 'unchecked' | 'rejected'

const SENT_AUTOMATICALLY: ReadonlySet<UsenetProof> = new Set<UsenetProof>(['exact', 'near_exact'])

/**
 * How a stored candidate counts right now. `graded`: its NZB was read and is no proof, or cannot be read at
 * all, which is the post's fault. `blocked`: its indexer could not send it, and may be asked again later.
 */
export function standing(candidate: StoredCandidate, now: number): Standing {
  if (candidate.rejected) return 'rejected'
  const check = candidate.check
  if (!check) return 'unchecked'
  if (!check.unavailable) return SENT_AUTOMATICALLY.has(check.proof) ? 'proven' : 'graded'
  if (now >= check.unavailable.retry_at) return 'unchecked'
  return check.unavailable.code === 'invalid_response' ? 'graded' : 'blocked'
}

/** When a candidate's NZB was graded; 0 when it never was. */
const gradedAt = (candidate: StoredCandidate): number =>
  candidate.check && !candidate.check.unavailable ? candidate.check.at : 0

/** When a record's source was last searched or one of its NZBs graded, whichever is later. */
export const lastCheckedAt = (record: SearchRecord): number =>
  Math.max(record.searched_at, ...record.candidates.map(gradedAt))

/**
 * The state and freshness of a search record. `enabled` is Prowlarr's current Usenet indexers; without it
 * only the record's own indexers are judged.
 *
 * | Stored result | State | Fresh for |
 * | --- | --- | --- |
 * | A candidate proven (`exact`, `near_exact`) and not rejected | `available` | 30 days |
 * | A candidate whose fetch failed and may not be retried yet, none proven | `lookup_failed` | 7 days |
 * | A candidate graded or rejected, none proven | `no_match` | 7 days |
 * | Candidates, none checked | `unverified` | 7 days |
 * | No candidate, an indexer has not answered | `lookup_failed` | until its retry time, at least a minute |
 * | No candidate, every indexer answered | `no_match` | 1, 3, 7, then 30 days on consecutive absences |
 * | No record, or nothing asked yet | `not_checked` | |
 *
 * A record is also stale when an enabled indexer is missing from it, or is listed as not answered and its
 * retry time passed; `ask` then names only those indexers.
 */
export function searchRecordState(
  record: SearchRecord | undefined,
  now: number,
  enabled?: readonly { id: number }[],
): SearchRecordState {
  const everyone = (enabled ?? []).map(indexer => indexer.id)
  if (!record) return { state: 'not_checked', fresh_until: 0, stale: true, ask: everyone }
  const wanted = enabled && new Set(everyone)
  const listed = record.indexers.filter(indexer => !wanted || wanted.has(indexer.id))
  const unanswered = listed.filter(indexer => !indexer.answered)
  const retryAt = Math.max(record.retry_at, record.last_attempt_at + RETRY_MIN_MS)
  const standings = record.candidates.map(candidate => standing(candidate, now))
  const proven = record.candidates[standings.indexOf('proven')]
  const blocked = record.candidates[standings.indexOf('blocked')]
  const checked = lastCheckedAt(record)

  let state: SearchState
  let failed: SearchRecordState['failed']
  let aged: number
  if (proven) {
    state = 'available'
    aged = checked + PROVEN_FRESH_MS
  } else if (record.candidates.length) {
    aged = checked + CANDIDATES_FRESH_MS
    if (blocked) {
      state = 'lookup_failed'
      const { code, retry_at } = blocked.check!.unavailable!
      failed = { indexer_id: blocked.indexer_id, indexer: blocked.indexer, code, retry_at }
    } else state = standings.some(entry => entry === 'graded' || entry === 'rejected') ? 'no_match' : 'unverified'
  } else if (unanswered.length) {
    state = 'lookup_failed'
    failed = { indexer_id: unanswered[0].id, indexer: unanswered[0].name, retry_at: retryAt }
    aged = retryAt
  } else if (!listed.length) {
    state = 'not_checked'
    aged = 0
  } else {
    state = 'no_match'
    const step = Math.min(Math.max(record.negative_streak ?? 1, 1), ABSENT_FRESH_STEPS_MS.length) - 1
    aged = record.searched_at + ABSENT_FRESH_STEPS_MS[step]
  }

  const asked = new Set(record.indexers.map(indexer => indexer.id))
  const pending = [
    ...everyone.filter(id => !asked.has(id)),
    ...(now >= retryAt ? unanswered.map(indexer => indexer.id) : []),
  ]
  // A failed lookup without candidates ages by its retry time, and then only the silent indexers are asked.
  const old = now >= aged && !(state === 'lookup_failed' && !record.candidates.length)
  return {
    state,
    ...(proven ? { entry_id: proven.entry_id, proof: proven.check!.proof } : {}),
    ...(failed ? { failed } : {}),
    fresh_until: aged,
    stale: now >= aged || pending.length > 0,
    ask: old ? everyone : pending,
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function isoTime(time: number): string | undefined {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** A stored candidate for the browser: what was learned about it, and never its download reference. */
function publicCandidate(candidate: StoredCandidate, now: number): UsenetCandidate {
  const check = candidate.check
  const graded = check && !check.unavailable ? check : undefined
  const failed = check?.unavailable && now < check.unavailable.retry_at ? check.unavailable : undefined
  const posted = candidate.posted_at === undefined ? undefined : isoTime(candidate.posted_at)
  return {
    entry_id: candidate.entry_id,
    title: candidate.title,
    indexer: candidate.indexer,
    ...(candidate.size !== null ? { size: candidate.size } : {}),
    ...(candidate.info_url ? { info_url: candidate.info_url } : {}),
    files_matched: graded?.files_matched ?? 0,
    names_matched: graded?.names_matched ?? 0,
    files_expected: check?.files_expected ?? 0,
    sizes_known: graded?.sizes_known ?? false,
    ...(failed ? { unavailable: `${candidate.indexer} ${FETCH_FAILURE[failed.code]}.` } : {}),
    checked: Boolean(graded),
    ...(graded ? { proof: graded.proof } : {}),
    ...(posted ? { posted_at: posted } : {}),
    ...(candidate.files !== undefined ? { files: candidate.files } : {}),
    ...(candidate.rejected ? { rejected: true } : {}),
  }
}

/** A checked candidate as the row the planner sends. */
export function matchAvailability(sourceId: string, candidate: StoredCandidate): UsenetHashAvailability {
  return {
    hash: sourceId,
    state: 'available',
    provider: 'prowlarr',
    entry_id: candidate.entry_id,
    title: candidate.title,
    ...(candidate.size !== null ? { total_bytes: candidate.size } : {}),
    // An NZB names the posted files, PAR2 sets included; that is no complete source manifest.
    files_known: false,
    ...(candidate.files !== undefined ? { file_count: candidate.files } : {}),
    ...(candidate.check ? { proof: candidate.check.proof } : {}),
  }
}

export const notConfigured = (sourceId: string, reason: string): UsenetHashAvailability => ({
  hash: sourceId,
  state: 'not_configured',
  provider: 'prowlarr',
  error: reason,
})

export const failedAvailability = (
  sourceId: string,
  code: UsenetFailureCode,
  message: string,
): UsenetHashAvailability => ({
  hash: sourceId,
  state: 'lookup_failed',
  provider: 'prowlarr',
  error_code: code,
  error: message,
  providers_failed: ['prowlarr'],
})

function noMatchText(record: SearchRecord, now: number): string {
  if (!record.candidates.length) return 'Prowlarr found no Usenet post that could be this release.'
  const found = plural(record.candidates.length, 'possible NZB')
  return record.candidates.some(candidate => standing(candidate, now) === 'unchecked')
    ? `Prowlarr found ${found}; none of those checked so far could be shown to be this release.`
    : `Prowlarr found ${found}, but none could be shown to be this release.`
}

/** Whom a failed lookup waits for, and why as far as the running process remembers. */
function failedText(
  failed: NonNullable<SearchRecordState['failed']>,
  remembered: { code: UsenetFailureCode; message: string } | undefined,
): { code: UsenetFailureCode; message: string } {
  if (failed.code) return { code: failed.code, message: `${failed.indexer} ${FETCH_FAILURE[failed.code]}.` }
  if (!remembered) return { code: 'network', message: `${failed.indexer} did not answer the search.` }
  const named = remembered.message.includes(failed.indexer)
  return { code: remembered.code, message: named ? remembered.message : `${failed.indexer}: ${remembered.message}` }
}

/** What the running process knows beside a record, for the row built from it. */
export interface RecordRowContext {
  /** Why none of the unchecked candidates of an `unverified` source can be fetched right now. */
  waiting?: string
  /** Why the indexer a failed lookup waits for did not answer its latest search. */
  silent?: { code: UsenetFailureCode; message: string }
}

/**
 * A record whose state is not `not_checked`, as an availability row: the proven candidate of an available
 * source, otherwise the state with every candidate for the user to judge.
 */
export function recordAvailability(
  record: SearchRecord,
  derived: SearchRecordState,
  now: number,
  { waiting, silent }: RecordRowContext = {},
): UsenetHashAvailability {
  const base = { hash: record.source_id, provider: 'prowlarr' as const }
  const count = record.candidates.length
  const listed = count
    ? { candidate_count: count, candidates: record.candidates.map(candidate => publicCandidate(candidate, now)) }
    : {}
  const proven = record.candidates.find(candidate => candidate.entry_id === derived.entry_id)
  if (proven) return { ...matchAvailability(record.source_id, proven), candidate_count: count }
  if (derived.state === 'unverified')
    return { ...base, state: 'unverified', ...listed, ...(waiting ? { error: waiting } : {}) }
  if (derived.state === 'no_match') return { ...base, state: 'no_match', error: noMatchText(record, now), ...listed }
  const { code, message } = failedText(derived.failed!, silent)
  return { ...failedAvailability(record.source_id, code, message), ...listed }
}
