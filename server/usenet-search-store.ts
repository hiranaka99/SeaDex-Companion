// Storage for the Prowlarr file-list search: one record per source and Prowlarr connection, the NZBs that
// were fetched to check candidates, per-indexer usage counters and the latest sweep summary. It makes no
// request and knows nothing about ranking or grading. A download reference is sensitive, so the file is
// written with mode 0600, only allow-listed fields are stored, and no log line here carries a link, a title
// or a key.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { UsenetSearchSummary } from '../shared/contracts.js'
import { errorMessage } from '../shared/errors.js'
import { isRecord } from '../shared/guards.js'
import { FILES_SOURCE_PATTERN, INFO_HASH_PATTERN } from '../shared/ids.js'
import type { UsenetFailureCode, UsenetProof } from '../shared/usenet-contracts.js'
import { log } from './logging.js'
import { NZB_STORE_DIR, USENET_SEARCH_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { safeText } from './provider-http.js'
import { NZB_MAX_BYTES } from './usenet-provider-types.js'

/** One Usenet indexer a source was searched on. */
export interface SearchedIndexer {
  id: number
  name: string
  /** False when the indexer failed or was paused, so its silence is not an absence. */
  answered: boolean
  at: number
}

/** What fetching and grading a candidate's NZB showed. */
export interface StoredCheck {
  at: number
  proof: UsenetProof
  files_matched: number
  names_matched: number
  files_expected: number
  sizes_known: boolean
  /** Lowest and highest ratio of a file's segment bytes to its listed size. */
  ratio?: [number, number]
  /** Names the NZB in the NZB store. It stays when the bytes were evicted; `hasNzb` tells. */
  nzb_sha256?: string
  /** The fetch failed, so the other fields say nothing about the post. */
  unavailable?: { code: UsenetFailureCode; retry_at: number }
}

export interface StoredCandidate {
  /** Indexer ID, a dash, and 20 hex characters of the SHA-1 of the result GUID. */
  entry_id: string
  indexer_id: number
  indexer: string
  title: string
  size: number | null
  files?: number
  grabs?: number
  posted_at?: number
  info_url?: string
  /** The `link` and `file` parameters of Prowlarr's download address, without its key. Server-only. */
  download: { link: string; file: string }
  check?: StoredCheck
  rejected?: { at: number; reason: 'import_mismatch' }
}

/** Search result of one source on one Prowlarr connection. Times are epoch milliseconds. */
export interface SearchRecord {
  source_id: string
  fingerprint: string
  searched_at: number
  last_attempt_at: number
  retry_at: number
  negative_streak?: number
  indexers: SearchedIndexer[]
  candidates: StoredCandidate[]
}

export type UsageKind = 'search' | 'fetch'

export interface IndexerUsage {
  searches: number
  fetches: number
}

export interface UsenetSearchStoreOptions {
  /** Size on disk the NZB store is brought back under by evicting NZBs checked more than a day ago. */
  nzbBudgetBytes?: number
  /** Size on disk the NZB store never stays above, whatever was checked recently. */
  nzbHardLimitBytes?: number
}

export const NZB_STORE_BUDGET_BYTES = 256 * 1024 * 1024
export const NZB_STORE_HARD_LIMIT_BYTES = 512 * 1024 * 1024

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Search-only updates are batched; an update that records a fetch is written at once. */
const WRITE_DELAY_MS = 30_000
const WRITE_RETRY_MS = 60_000
/** An NZB checked this recently is evicted only at the hard limit. */
const NZB_PROTECTED_MS = DAY
/** A stored NZB waits this long for the record that names it before it counts as unreferenced. */
const NZB_PENDING_MS = 10 * 60_000
/** Safety bounds for one record; the finder keeps far fewer. */
const CANDIDATE_LIMIT = 200
const INDEXER_LIMIT = 200
const TITLE_LIMIT = 500
const NAME_LIMIT = 120
const LINK_LIMIT = 8192
const FILE_NAME_LIMIT = 1024
const URL_LIMIT = 2048

/** What `prowlarrFingerprint` produces; repeated here so the store does not import the Prowlarr client. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/
const ENTRY_PATTERN = /^\d+-[0-9a-f]{20}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const NZB_FILE_PATTERN = /^([0-9a-f]{64})\.nzb\.gz(\.tmp)?$/
/** A whole download address in place of its `link` parameter would carry the Prowlarr key. */
const KEY_PARAMETER = /api_?key=/i
/** Query parameters that carry a credential, as `infoUrl` in the Prowlarr client knows them. */
const CREDENTIAL_PARAMS = /^(?:api_?key|apikey|key|passkey|token|auth|r|i)$/i

const PROOFS: Record<UsenetProof, true> = {
  exact: true,
  near_exact: true,
  probable: true,
  size_only: true,
  unverified: true,
}
const FAILURE_CODES: Record<UsenetFailureCode, true> = {
  network: true,
  timeout: true,
  invalid_response: true,
  unauthorized: true,
  rate_limited: true,
  server: true,
  invalid_config: true,
}

interface Dropped {
  records: number
  /** Candidates and indexer entries left out of a record that was kept. */
  entries: number
}

interface UsageSeries {
  fingerprint: string
  indexer_id: number
  /** Counts by epoch hour. */
  hours: Map<number, IndexerUsage>
}

/** A time or a count: a safe non-negative integer. */
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const recordKey = (fingerprint: string, sourceId: string) => `${fingerprint}\u0000${sourceId}`
const usageKey = (fingerprint: string, indexerId: number) => `${fingerprint}\u0000${indexerId}`
const usageField = (kind: UsageKind) => (kind === 'search' ? 'searches' : 'fetches')

/** An hour's counts leave the window 24 hours after the hour ends, so a limit holds in any 24 hours. */
const usageExpiry = (hour: number) => (hour + 1) * HOUR + DAY
const usageCounted = (hour: number, now: number) => hour * HOUR <= now && now < usageExpiry(hour)

/** The post's page for the browser: http(s), no user info, no credential-like parameter. */
function storedInfoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > URL_LIMIT) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined
  if ([...url.searchParams.keys()].some(name => CREDENTIAL_PARAMS.test(name))) return undefined
  return url.href.length <= URL_LIMIT ? url.href : undefined
}

function storedCheck(value: unknown): StoredCheck | undefined {
  if (
    !isRecord(value) ||
    !whole(value.at) ||
    typeof value.proof !== 'string' ||
    !Object.hasOwn(PROOFS, value.proof) ||
    !whole(value.files_matched) ||
    !whole(value.names_matched) ||
    !whole(value.files_expected) ||
    typeof value.sizes_known !== 'boolean'
  )
    return undefined
  // An optional part that is present must be usable: guessing here could spend a fetch or send an NZB.
  let ratio: [number, number] | undefined
  if (value.ratio !== undefined) {
    const parts = value.ratio
    if (
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      !parts.every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0)
    )
      return undefined
    ratio = [parts[0], parts[1]]
  }
  const sha256 = value.nzb_sha256
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256))) return undefined
  let unavailable: StoredCheck['unavailable']
  if (value.unavailable !== undefined) {
    const failure = value.unavailable
    if (
      !isRecord(failure) ||
      typeof failure.code !== 'string' ||
      !Object.hasOwn(FAILURE_CODES, failure.code) ||
      !whole(failure.retry_at)
    )
      return undefined
    unavailable = { code: failure.code as UsenetFailureCode, retry_at: failure.retry_at }
  }
  return {
    at: value.at,
    proof: value.proof as UsenetProof,
    files_matched: value.files_matched,
    names_matched: value.names_matched,
    files_expected: value.files_expected,
    sizes_known: value.sizes_known,
    ...(ratio ? { ratio } : {}),
    ...(sha256 ? { nzb_sha256: sha256 } : {}),
    ...(unavailable ? { unavailable } : {}),
  }
}

/**
 * A candidate with only its allow-listed fields. Display fields that are unusable are left out; an unusable
 * identity, download reference, check or rejection drops the candidate, because those decide whether a
 * fetch is spent or an NZB is sent.
 */
function storedCandidate(value: unknown): StoredCandidate | undefined {
  if (
    !isRecord(value) ||
    !whole(value.indexer_id) ||
    typeof value.entry_id !== 'string' ||
    !ENTRY_PATTERN.test(value.entry_id) ||
    !value.entry_id.startsWith(`${value.indexer_id}-`) ||
    typeof value.indexer !== 'string' ||
    typeof value.title !== 'string' ||
    !(value.size === null || whole(value.size))
  )
    return undefined
  const download = value.download
  if (
    !isRecord(download) ||
    typeof download.link !== 'string' ||
    typeof download.file !== 'string' ||
    !download.link ||
    download.link.length > LINK_LIMIT ||
    download.file.length > FILE_NAME_LIMIT ||
    KEY_PARAMETER.test(download.link) ||
    KEY_PARAMETER.test(download.file)
  )
    return undefined
  const check = value.check === undefined ? undefined : storedCheck(value.check)
  if (value.check !== undefined && !check) return undefined
  let rejected: StoredCandidate['rejected']
  if (value.rejected !== undefined) {
    const rejection = value.rejected
    if (!isRecord(rejection) || !whole(rejection.at) || rejection.reason !== 'import_mismatch') return undefined
    rejected = { at: rejection.at, reason: 'import_mismatch' }
  }
  const infoUrl = storedInfoUrl(value.info_url)
  return {
    entry_id: value.entry_id,
    indexer_id: value.indexer_id,
    indexer: safeText(value.indexer, NAME_LIMIT),
    title: safeText(value.title, TITLE_LIMIT),
    size: value.size,
    ...(whole(value.files) ? { files: value.files } : {}),
    ...(whole(value.grabs) ? { grabs: value.grabs } : {}),
    ...(whole(value.posted_at) ? { posted_at: value.posted_at } : {}),
    ...(infoUrl ? { info_url: infoUrl } : {}),
    download: { link: download.link, file: download.file },
    ...(check ? { check } : {}),
    ...(rejected ? { rejected } : {}),
  }
}

function storedIndexer(value: unknown): SearchedIndexer | undefined {
  if (
    !isRecord(value) ||
    !whole(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.answered !== 'boolean' ||
    !whole(value.at)
  )
    return undefined
  return { id: value.id, name: safeText(value.name, NAME_LIMIT), answered: value.answered, at: value.at }
}

/** A fresh, validated copy of a record, or undefined when its identity or times are unusable. */
function storedRecord(value: unknown, dropped: Dropped): SearchRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.source_id !== 'string' ||
    !(INFO_HASH_PATTERN.test(value.source_id) || FILES_SOURCE_PATTERN.test(value.source_id)) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(value.fingerprint) ||
    !whole(value.searched_at) ||
    !whole(value.last_attempt_at) ||
    !whole(value.retry_at) ||
    !Array.isArray(value.indexers) ||
    !Array.isArray(value.candidates)
  )
    return undefined
  // An indexer and an entry are each listed once; the first one wins, which keeps the caller's ranking.
  const indexers = new Map<number, SearchedIndexer>()
  for (const entry of value.indexers) {
    const indexer = indexers.size < INDEXER_LIMIT ? storedIndexer(entry) : undefined
    if (!indexer || indexers.has(indexer.id)) dropped.entries++
    else indexers.set(indexer.id, indexer)
  }
  const candidates = new Map<string, StoredCandidate>()
  for (const entry of value.candidates) {
    const candidate = candidates.size < CANDIDATE_LIMIT ? storedCandidate(entry) : undefined
    if (!candidate || candidates.has(candidate.entry_id)) dropped.entries++
    else candidates.set(candidate.entry_id, candidate)
  }
  return {
    source_id: value.source_id,
    fingerprint: value.fingerprint,
    searched_at: value.searched_at,
    last_attempt_at: value.last_attempt_at,
    retry_at: value.retry_at,
    ...(whole(value.negative_streak) && value.negative_streak > 0 ? { negative_streak: value.negative_streak } : {}),
    indexers: [...indexers.values()],
    candidates: [...candidates.values()],
  }
}

function storedSummary(value: unknown): UsenetSearchSummary | undefined {
  if (
    !isRecord(value) ||
    typeof value.finished_at !== 'string' ||
    value.finished_at.length > 40 ||
    Number.isNaN(Date.parse(value.finished_at)) ||
    !whole(value.searched) ||
    !whole(value.with_candidates) ||
    !whole(value.without_candidates) ||
    !whole(value.failed) ||
    !whole(value.deferred) ||
    !Array.isArray(value.queries)
  )
    return undefined
  const queries: UsenetSearchSummary['queries'] = []
  for (const entry of value.queries.slice(0, INDEXER_LIMIT))
    if (isRecord(entry) && typeof entry.indexer === 'string' && whole(entry.count))
      queries.push({ indexer: safeText(entry.indexer, NAME_LIMIT), count: entry.count })
  return {
    finished_at: new Date(Date.parse(value.finished_at)).toISOString(),
    searched: value.searched,
    with_candidates: value.with_candidates,
    without_candidates: value.without_candidates,
    failed: value.failed,
    deferred: value.deferred,
    queries,
  }
}

/** The stored NZBs a record names, as one comparable value. */
const nzbReferences = (record: SearchRecord | undefined): string =>
  (record?.candidates ?? [])
    .flatMap(candidate => (candidate.check?.nzb_sha256 ? [candidate.check.nzb_sha256] : []))
    .sort()
    .join()

/**
 * Search records, usage counters and the sweep summary persist as one atomic snapshot; NZBs are separate
 * files named by their SHA-256.
 *
 * - Records handed in and out are copies. Change what `get` returned and hand it back to `put`, without
 *   awaiting in between: `put` replaces the whole record, so a copy read before a wait can undo a check
 *   another caller recorded meanwhile.
 * - `put` with `durable`, `countFetch` and a `retainFingerprint` that removes something write the snapshot
 *   before they return, so a fetch is never spent twice after a crash. Everything else is written at most
 *   every 30 seconds and by `flush`.
 * - The file is read on first use, and every record is validated field by field.
 */
export class UsenetSearchStore {
  private readonly stored = new Map<string, SearchRecord>()
  private readonly counters = new Map<string, UsageSeries>()
  private latest?: { summary: UsenetSearchSummary; fingerprint?: string }
  /** Compressed size on disk of each stored NZB; read from the directory on first use. */
  private nzbs?: Map<string, number>
  /** NZBs this process stored that no record names yet, with the time each was stored. */
  private readonly pending = new Map<string, number>()
  private loaded = false
  private dirty = false
  private timer?: NodeJS.Timeout
  private readonly budget: number
  private readonly hardLimit: number

  constructor(
    private readonly file = USENET_SEARCH_FILE,
    private readonly nzbDir = NZB_STORE_DIR,
    options: UsenetSearchStoreOptions = {},
  ) {
    this.budget = options.nzbBudgetBytes ?? NZB_STORE_BUDGET_BYTES
    this.hardLimit = Math.max(this.budget, options.nzbHardLimitBytes ?? NZB_STORE_HARD_LIMIT_BYTES)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    // No parser message is logged: it quotes the text around the error, which can be part of a link.
    const unreadable = Symbol('unreadable')
    const stored = readJson<unknown>(this.file, unreadable)
    if (stored === unreadable) {
      if (existsSync(this.file)) log('WARNING', 'Usenet search store could not be read, starting empty')
      return
    }
    if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.records)) {
      log('WARNING', 'Usenet search store could not be restored (invalid schema), starting empty')
      return
    }
    const dropped: Dropped = { records: 0, entries: 0 }
    for (const value of stored.records) {
      const record = storedRecord(value, dropped)
      if (record) this.stored.set(recordKey(record.fingerprint, record.source_id), record)
      else dropped.records++
    }
    const now = Date.now()
    for (const value of Array.isArray(stored.usage) ? stored.usage : []) {
      if (
        !isRecord(value) ||
        typeof value.fingerprint !== 'string' ||
        !FINGERPRINT_PATTERN.test(value.fingerprint) ||
        !whole(value.indexer_id) ||
        !whole(value.hour) ||
        !whole(value.searches) ||
        !whole(value.fetches)
      ) {
        dropped.entries++
        continue
      }
      // Hours that left the window are dropped, and so is one a wrong clock placed far ahead.
      if (usageExpiry(value.hour) <= now || value.hour * HOUR > now + DAY) continue
      const bucket = this.bucket(value.fingerprint, value.indexer_id, value.hour)
      bucket.searches += value.searches
      bucket.fetches += value.fetches
    }
    const summary = storedSummary(stored.summary)
    if (summary) {
      const fingerprint = stored.summary_fingerprint
      this.latest = {
        summary,
        ...(typeof fingerprint === 'string' && FINGERPRINT_PATTERN.test(fingerprint) ? { fingerprint } : {}),
      }
    } else if (stored.summary !== undefined) dropped.entries++
    if (dropped.records || dropped.entries) {
      log(
        'WARNING',
        `Usenet search store ignored ${dropped.records} invalid records and ${dropped.entries} invalid entries`,
      )
      this.changed()
    }
  }

  /** A copy of the record of one source on one Prowlarr connection. */
  get(fingerprint: string, sourceId: string): SearchRecord | undefined {
    this.load()
    const record = this.stored.get(recordKey(fingerprint, sourceId))
    return record && structuredClone(record)
  }

  /** Copies of every record of one Prowlarr connection. */
  records(fingerprint: string): SearchRecord[] {
    this.load()
    const found: SearchRecord[] = []
    for (const record of this.stored.values())
      if (record.fingerprint === fingerprint) found.push(structuredClone(record))
    return found
  }

  /** Number of records, over every connection. */
  get size(): number {
    this.load()
    return this.stored.size
  }

  /**
   * Stores a validated copy of the record under its fingerprint and source ID, replacing the previous one.
   * Only the fields of `SearchRecord` and `StoredCandidate` are kept. A candidate or indexer entry that
   * does not validate is left out with a warning; a record whose identity or times do not validate is a
   * caller error and throws. Pass `durable` when the update records a fetch.
   */
  put(record: SearchRecord, options: { durable?: boolean } = {}): void {
    this.load()
    const dropped: Dropped = { records: 0, entries: 0 }
    const next = storedRecord(record, dropped)
    if (!next) throw new TypeError('Usenet search store was given an invalid record')
    if (dropped.entries) log('WARNING', `Usenet search store left ${dropped.entries} invalid entries out of a record`)
    const key = recordKey(next.fingerprint, next.source_id)
    const previous = this.stored.get(key)
    this.stored.set(key, next)
    this.changed()
    if (options.durable) this.flush()
    if (nzbReferences(previous) !== nzbReferences(next)) this.pruneNzbs()
  }

  /**
   * Drops the records and counters of every other Prowlarr connection, and their stored NZBs; null drops
   * everything. Returns the number of records removed. A removal is written before this returns.
   */
  retainFingerprint(fingerprint: string | null): number {
    this.load()
    let removed = 0
    let other = false
    for (const [key, record] of this.stored) {
      if (record.fingerprint === fingerprint) continue
      this.stored.delete(key)
      removed++
    }
    for (const [key, series] of this.counters) {
      if (series.fingerprint === fingerprint) continue
      this.counters.delete(key)
      other = true
    }
    if (this.latest && (fingerprint === null || (this.latest.fingerprint ?? fingerprint) !== fingerprint)) {
      this.latest = undefined
      other = true
    }
    if (fingerprint === null) this.pending.clear()
    if (removed || other) {
      this.changed()
      this.flush()
    }
    this.pruneNzbs()
    return removed
  }

  /**
   * Drops the records of sources that are not in `keep`, whatever their connection, and the stored NZBs
   * only they name. Returns the number of records removed.
   */
  retainSources(keep: ReadonlySet<string>): number {
    this.load()
    let removed = 0
    for (const [key, record] of this.stored) {
      if (keep.has(record.source_id)) continue
      this.stored.delete(key)
      removed++
    }
    if (removed) this.changed()
    this.pruneNzbs()
    return removed
  }

  private nzbPath(sha256: string): string {
    return join(this.nzbDir, `${sha256}.nzb.gz`)
  }

  private index(): Map<string, number> {
    if (this.nzbs) return this.nzbs
    const found = new Map<string, number>()
    let names: string[] = []
    try {
      if (existsSync(this.nzbDir)) names = readdirSync(this.nzbDir)
    } catch (error) {
      log('WARNING', `Usenet NZB store could not be listed: ${errorMessage(error)}`)
    }
    for (const name of names) {
      const match = NZB_FILE_PATTERN.exec(name)
      if (!match) continue
      const path = join(this.nzbDir, name)
      try {
        // A temporary file left behind is a write the process did not finish.
        if (match[2]) rmSync(path, { force: true })
        else found.set(match[1], statSync(path).size)
      } catch {
        /* The file is gone or cannot be touched; it is not counted. */
      }
    }
    this.nzbs = found
    return found
  }

  private removeNzb(sha256: string): boolean {
    try {
      rmSync(this.nzbPath(sha256), { force: true })
    } catch (error) {
      log('WARNING', `Usenet NZB store could not remove a file: ${errorMessage(error)}`)
      return false
    }
    this.nzbs?.delete(sha256)
    this.pending.delete(sha256)
    return true
  }

  /**
   * Stores an NZB gzipped under the SHA-256 of its uncompressed bytes and returns that hash. It never
   * throws: when the bytes cannot be written the NZB counts as evicted, and `hasNzb` says so. The file is
   * kept for the record that names it in `check.nzb_sha256`, so `put` that record next.
   */
  storeNzb(bytes: Uint8Array): string {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (!bytes.length || bytes.length > NZB_MAX_BYTES) {
      log('WARNING', 'Usenet NZB store refused an NZB of an unusable size')
      return sha256
    }
    const path = this.nzbPath(sha256)
    const temporary = `${path}.tmp`
    try {
      const packed = gzipSync(bytes)
      const sizes = this.index()
      mkdirSync(this.nzbDir, { recursive: true, mode: 0o700 })
      // Written beside its final name and renamed, so a torn file is never read as an NZB.
      writeFileSync(temporary, packed, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, path)
      sizes.set(sha256, packed.length)
      this.pending.set(sha256, Date.now())
    } catch (error) {
      log('ERROR', `Usenet NZB store could not save a file: ${errorMessage(error)}`)
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* Nothing was written. */
      }
    }
    return sha256
  }

  /** Whether a file for this NZB exists. `readNzb` also verifies its content. */
  hasNzb(sha256: string): boolean {
    return SHA256_PATTERN.test(sha256) && existsSync(this.nzbPath(sha256))
  }

  /**
   * The uncompressed NZB, or null when it is missing, unreadable or does not hash to its name. A file
   * that fails the check is removed, so `hasNzb` stops reporting it.
   */
  readNzb(sha256: string): Uint8Array | null {
    if (!SHA256_PATTERN.test(sha256)) return null
    let packed: Buffer
    try {
      packed = readFileSync(this.nzbPath(sha256))
    } catch {
      return null
    }
    try {
      const bytes = gunzipSync(packed, { maxOutputLength: NZB_MAX_BYTES })
      if (createHash('sha256').update(bytes).digest('hex') === sha256) return new Uint8Array(bytes)
    } catch {
      /* Not gzip, or larger than any NZB: handled as a failed check below. */
    }
    log('WARNING', 'Usenet NZB store removed a stored NZB that failed its integrity check')
    this.removeNzb(sha256)
    return null
  }

  /**
   * Removes the NZB files no candidate names, then enforces the size limits and returns the number of
   * files removed. Above the budget the NZBs go oldest first by the latest `check.at` of the candidates
   * naming them, but one checked in the last 24 hours goes only above the hard limit. Records are not
   * touched: an evicted candidate keeps its `check`. Runs by itself when `put` changes which NZBs a record
   * names and after both `retain` calls.
   */
  pruneNzbs(now = Date.now()): number {
    this.load()
    const sizes = this.index()
    if (!sizes.size) return 0
    const checkedAt = new Map<string, number>()
    for (const record of this.stored.values())
      for (const { check } of record.candidates)
        if (check?.nzb_sha256) checkedAt.set(check.nzb_sha256, Math.max(checkedAt.get(check.nzb_sha256) ?? 0, check.at))
    let removed = 0
    let total = 0
    const kept: { sha256: string; size: number; at: number }[] = []
    for (const [sha256, size] of [...sizes]) {
      let at = checkedAt.get(sha256)
      if (at !== undefined) this.pending.delete(sha256)
      else {
        // A just-stored NZB is waiting for its record; it ranks as checked when it was stored.
        const storedAt = this.pending.get(sha256)
        if (storedAt === undefined || now - storedAt >= NZB_PENDING_MS) {
          if (this.removeNzb(sha256)) removed++
          else total += size
          continue
        }
        at = storedAt
      }
      kept.push({ sha256, size, at })
      total += size
    }
    kept.sort((left, right) => left.at - right.at || left.sha256.localeCompare(right.sha256))
    for (const entry of kept) {
      // Sorted oldest first, so once an entry is protected every later one is too.
      if (total <= (now - entry.at < NZB_PROTECTED_MS ? this.hardLimit : this.budget)) break
      if (!this.removeNzb(entry.sha256)) continue
      total -= entry.size
      removed++
    }
    return removed
  }

  private bucket(fingerprint: string, indexerId: number, hour: number): IndexerUsage {
    const key = usageKey(fingerprint, indexerId)
    let series = this.counters.get(key)
    if (!series) {
      series = { fingerprint, indexer_id: indexerId, hours: new Map() }
      this.counters.set(key, series)
    }
    let bucket = series.hours.get(hour)
    if (!bucket) {
      bucket = { searches: 0, fetches: 0 }
      series.hours.set(hour, bucket)
    }
    return bucket
  }

  private count(kind: UsageKind, fingerprint: string, indexerId: number, now: number): void {
    if (!FINGERPRINT_PATTERN.test(fingerprint) || !whole(indexerId) || !whole(now))
      throw new TypeError('Usenet search store was given an invalid indexer to count')
    this.load()
    const hours = this.counters.get(usageKey(fingerprint, indexerId))?.hours
    for (const hour of hours?.keys() ?? []) if (usageExpiry(hour) <= now) hours?.delete(hour)
    this.bucket(fingerprint, indexerId, Math.floor(now / HOUR))[usageField(kind)]++
    this.changed()
  }

  /** Counts one background search on an indexer. Written with the next batched write. */
  countSearch(fingerprint: string, indexerId: number, now = Date.now()): void {
    this.count('search', fingerprint, indexerId, now)
  }

  /** Counts one NZB fetch on an indexer, and writes it before returning. Call it before the fetch. */
  countFetch(fingerprint: string, indexerId: number, now = Date.now()): void {
    this.count('fetch', fingerprint, indexerId, now)
    this.flush()
  }

  /** Searches and fetches counted on an indexer in the last 24 hours. */
  usage(fingerprint: string, indexerId: number, now = Date.now()): IndexerUsage {
    this.load()
    const total: IndexerUsage = { searches: 0, fetches: 0 }
    for (const [hour, bucket] of this.counters.get(usageKey(fingerprint, indexerId))?.hours ?? []) {
      if (!usageCounted(hour, now)) continue
      total.searches += bucket.searches
      total.fetches += bucket.fetches
    }
    return total
  }

  /**
   * The time at which the indexer's usage of one kind is below `limit` again: `now` when it already is,
   * otherwise the moment enough of the oldest hours have left the window. A limit of 0 means no limit.
   */
  nextAvailableAt(fingerprint: string, indexerId: number, kind: UsageKind, limit: number, now = Date.now()): number {
    if (!(limit > 0)) return now
    this.load()
    const field = usageField(kind)
    const hours = [...(this.counters.get(usageKey(fingerprint, indexerId))?.hours ?? [])]
      .filter(([hour]) => usageCounted(hour, now))
      .sort((left, right) => left[0] - right[0])
    let used = hours.reduce((sum, [, bucket]) => sum + bucket[field], 0)
    for (const [hour, bucket] of hours) {
      if (used < limit) break
      used -= bucket[field]
      if (used < limit) return usageExpiry(hour)
    }
    return now
  }

  /** The latest finished sweep, when one was recorded. */
  summary(): UsenetSearchSummary | undefined {
    this.load()
    return this.latest && structuredClone(this.latest.summary)
  }

  /**
   * Records the latest sweep summary, or clears it with undefined; written with the next batched write.
   * With the connection's fingerprint, `retainFingerprint` drops the summary together with that
   * connection's records; without it the summary stays until everything is dropped.
   */
  setSummary(summary: UsenetSearchSummary | undefined, fingerprint?: string): void {
    this.load()
    const next = summary === undefined ? undefined : storedSummary(summary)
    if ((summary !== undefined && !next) || (fingerprint !== undefined && !FINGERPRINT_PATTERN.test(fingerprint)))
      throw new TypeError('Usenet search store was given an invalid summary')
    this.latest = next && { summary: next, ...(fingerprint ? { fingerprint } : {}) }
    this.changed()
  }

  private changed(): void {
    this.dirty = true
    this.schedule(WRITE_DELAY_MS)
  }

  private schedule(delay: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delay)
    this.timer.unref?.()
  }

  private snapshot(now: number): unknown {
    const usage: { fingerprint: string; indexer_id: number; hour: number; searches: number; fetches: number }[] = []
    for (const [key, series] of this.counters) {
      for (const hour of series.hours.keys()) if (usageExpiry(hour) <= now) series.hours.delete(hour)
      if (!series.hours.size) this.counters.delete(key)
      for (const [hour, bucket] of series.hours)
        usage.push({ fingerprint: series.fingerprint, indexer_id: series.indexer_id, hour, ...bucket })
    }
    return {
      version: 1,
      records: [...this.stored.values()],
      usage,
      ...(this.latest
        ? {
            summary: this.latest.summary,
            ...(this.latest.fingerprint ? { summary_fingerprint: this.latest.fingerprint } : {}),
          }
        : {}),
    }
  }

  /** Writes pending changes now. Returns false, and retries after a minute, when the write fails. */
  flush(): boolean {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return true
    try {
      writeJsonAtomic(this.file, this.snapshot(Date.now()), false, 0o600)
      this.dirty = false
      return true
    } catch (error) {
      log('ERROR', `Usenet search store could not be persisted: ${errorMessage(error)}`)
      this.schedule(WRITE_RETRY_MS)
      return false
    }
  }

  /** Tests can clear memory without deleting persisted data, or reload it to simulate a restart. */
  reset(restoreFromDisk = false): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.stored.clear()
    this.counters.clear()
    this.pending.clear()
    this.latest = undefined
    this.nzbs = undefined
    this.loaded = !restoreFromDisk
    this.dirty = false
  }
}
