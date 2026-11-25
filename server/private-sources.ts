// Finds releases SeaDex lists on private trackers through the indexers configured in Prowlarr.
//
// SeaDex withholds a private torrent's info hash but lists its files with exact sizes. A candidate is
// accepted only when its own file list matches that list: a .torrent file must hold exactly the listed
// files, and an NZB must name every listed video file with its exact size in its subjects. Titles and
// sizes reported by indexers only choose which few candidates are fetched and checked.

import { createHash } from 'node:crypto'
import type { Config, PrivateSource } from './types.js'
import type { UsenetFailureCode, UsenetHashAvailability } from '../shared/usenet-contracts.js'
import { errorMessage } from '../shared/errors.js'
import { log } from './logging.js'
import {
  ProwlarrError,
  prowlarrDownload,
  prowlarrFingerprint,
  prowlarrIndexers,
  prowlarrSettings,
  privateSearchSettings,
  searchProwlarr,
  trackerIndexers,
  type ProwlarrRelease,
  type ProwlarrSettings,
} from './prowlarr.js'
import { parseTorrentFile, TORRENT_FILE_MAX_BYTES } from './torrent-file.js'
import { nzbFileMatches, nzbFiles, nzbHasFiles, sameFiles, type NzbFile, type SourceFile } from './source-files.js'
import { gunzipOnce, NZB_MAX_BYTES } from './usenet-provider-types.js'
import { isInfoHash } from '../shared/ids.js'
import { VIDEO_FILE } from '../shared/releases.js'
import { cleanSearchTitle, searchCategories, searchTitles } from './search-titles.js'

/** What the search terms are built from. */
export interface PrivateSearchContext {
  /** Cleaned titles to search under, most likely first (see `searchTitles`). */
  titles: string[]
  releaseGroup: string
  tracker: string
  /** Newznab categories for Usenet searches; tracker searches leave categories to the indexer. */
  categories: number[]
}

/** The search context of one release of a library result. */
export function searchContext(
  result: (NonNullable<Parameters<typeof searchTitles>[0]> & { arr?: string }) | undefined,
  release: { releaseGroup: string; tracker: string },
): PrivateSearchContext {
  return {
    titles: searchTitles(result),
    releaseGroup: release.releaseGroup,
    tracker: release.tracker,
    categories: searchCategories(result?.arr),
  }
}

type Failure = { kind: 'failed'; code: UsenetFailureCode; message: string }
/** Prowlarr is not set up, or has no indexer that could hold the release. */
type Unconfigured = { kind: 'unconfigured'; reason: string }
type NoMatch = { kind: 'no_match'; reason: string }

export interface PrivateTorrentMatch {
  kind: 'match'
  hash: string
  /** The .torrent file whose files were checked; it is what qBittorrent receives. */
  torrent: Uint8Array
  indexer: string
  title: string
}
export type PrivateTorrentLookup = PrivateTorrentMatch | NoMatch | Failure | Unconfigured

export interface PrivateNzbMatch {
  kind: 'match'
  /** Indexer ID plus a digest of the result GUID; never a URL. */
  entry_id: string
  indexer: string
  title: string
  size: number | null
  files: NzbFile[]
  /** Server-only download proxy path, to fetch the NZB again once its bytes were dropped from memory. */
  download_path: string
  /** The NZB that was checked, kept so submission sends the same bytes without another grab. */
  nzb: Uint8Array | null
}
/** An NZB that was fetched and checked but not proven; the user may still choose it. */
export interface PrivateNzbCandidate extends Omit<PrivateNzbMatch, 'kind'> {
  info_url?: string
  files_matched: number
  names_matched: number
  files_expected: number
  sizes_known: boolean
  /** Why the NZB could not be fetched; such a candidate is shown but never sent. */
  unavailable?: string
}

/** Prowlarr itself refused (bad key, rate limit): the whole lookup fails rather than one candidate. */
const LOOKUP_FAILURES = new Set<UsenetFailureCode>(['unauthorized', 'rate_limited', 'invalid_config'])
/** Failures that say nothing about the candidate, only that it could not be reached right now. */
const TRANSIENT_FAILURES = new Set<UsenetFailureCode>(['network', 'timeout', 'server'])
/** No proven NZB; `candidates` are the ones checked, for the user to judge. */
export type PrivateNzbNoMatch = NoMatch & { candidates?: PrivateNzbCandidate[] }
export type PrivateNzbLookup = PrivateNzbMatch | PrivateNzbNoMatch | Failure | Unconfigured | { kind: 'not_checked' }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TTL = {
  torrent: { match: HOUR, no_match: 30 * MINUTE },
  nzb: { match: 12 * HOUR, no_match: 6 * HOUR },
  failure: MINUTE,
  unconfigured: 5 * MINUTE,
}
/** Each candidate fetched through Prowlarr counts as a grab on its indexer. */
const CANDIDATE_LIMIT = 3
/** Indexers report the posted size, which adds yEnc and PAR2 overhead to the payload. */
const NZB_SIZE_RANGE = [0.97, 1.35] as const
/** Checked NZBs kept in memory for submission; older ones are fetched again when needed. */
const NZB_BYTES_BUDGET = 128 * 1024 * 1024
const SEARCH_CONCURRENCY = 2

interface Entry<T> {
  at: number
  ttl: number
  value: T
}

const torrents = new Map<string, Entry<PrivateTorrentLookup>>()
const nzbs = new Map<string, Entry<PrivateNzbLookup>>()
const inFlight = new Map<string, Promise<unknown>>()
let epoch = 0

/** Forget every observation, for a changed Prowlarr connection. Running work is discarded when it settles. */
export function invalidatePrivateSources(): void {
  epoch++
  torrents.clear()
  nzbs.clear()
  inFlight.clear()
}

let running = 0
const waiting: (() => void)[] = []
async function limited<T>(work: () => Promise<T>): Promise<T> {
  while (running >= SEARCH_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

const sourceKey = (settings: ProwlarrSettings, id: string) => `${prowlarrFingerprint(settings)}\u0000${id}`

function ttlOf(kind: 'torrent' | 'nzb', value: { kind: string }): number {
  if (value.kind === 'match') return TTL[kind].match
  if (value.kind === 'no_match') return TTL[kind].no_match
  if (value.kind === 'unconfigured') return TTL.unconfigured
  return TTL.failure
}

function fresh<T>(entry: Entry<T> | undefined): T | undefined {
  return entry && Date.now() - entry.at < entry.ttl ? entry.value : undefined
}

function failed(error: unknown): Failure {
  if (error instanceof ProwlarrError) return { kind: 'failed', code: error.code, message: error.message }
  return { kind: 'failed', code: 'network', message: errorMessage(error).slice(0, 200) }
}

const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const totalBytes = (files: SourceFile[]) => files.reduce((sum, file) => sum + file.length, 0)
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Results of several queries, each listed once. Stops early once `enough` is satisfied. */
async function searchAll(
  settings: ProwlarrSettings,
  queries: string[],
  indexerIds: number[],
  enough: (results: ProwlarrRelease[]) => boolean,
  categories: number[] = [],
): Promise<ProwlarrRelease[]> {
  const seen = new Map<string, ProwlarrRelease>()
  for (const query of [...new Set(queries.filter(Boolean))]) {
    for (const release of await searchProwlarr(settings, query, indexerIds, globalThis.fetch, categories))
      seen.set(`${release.indexer_id}\u0000${release.guid}`, release)
    if (enough([...seen.values()])) break
  }
  return [...seen.values()]
}

/** The torrent ID in a tracker page address, such as AnimeBytes' `torrents.php?id=1&torrentid=2`. */
export function trackerTorrentId(page: string | undefined): string | null {
  return page?.match(/[?&]torrentid=(\d+)/i)?.[1] ?? page?.match(/\/torrents?\/(\d+)(?:[/?#]|$)/i)?.[1] ?? null
}

function namesTorrent(release: ProwlarrRelease, id: string | null): boolean {
  if (!id) return false
  const pattern = new RegExp(`(?:torrentid(?:=|%3d)|/torrents?/)${id}(?!\\d)`, 'i')
  return release.links.some(link => pattern.test(link))
}

async function findTorrent(
  settings: ProwlarrSettings,
  source: PrivateSource,
  context: PrivateSearchContext,
): Promise<PrivateTorrentLookup> {
  const tracker = context.tracker || 'the tracker'
  const indexers = trackerIndexers(await prowlarrIndexers(settings), context.tracker)
  if (!indexers.length) return { kind: 'unconfigured', reason: `Prowlarr has no ${tracker} indexer.` }
  const id = trackerTorrentId(source.page)
  const expected = totalBytes(source.files)
  const sameSize = (release: ProwlarrRelease) =>
    release.size !== null && Math.abs(release.size - expected) <= Math.max(1024, expected * 0.0005)
  const plausible = (release: ProwlarrRelease) =>
    release.protocol === 'torrent' && (namesTorrent(release, id) || sameSize(release))
  // A tracker is searched by title alone, as Sonarr searches it, in each of the release's titles in turn,
  // until the tracker's own torrent ID turns up.
  const results = await searchAll(
    settings,
    context.titles,
    indexers.map(indexer => indexer.id),
    found => Boolean(id) && found.some(release => namesTorrent(release, id)),
  )
  // The tracker's own torrent ID is checked first; a torrent of the same size is the fallback.
  const candidates = results
    .filter(plausible)
    .sort((left, right) => Number(namesTorrent(right, id)) - Number(namesTorrent(left, id)))
    .slice(0, CANDIDATE_LIMIT)
  for (const candidate of candidates) {
    let bytes: Uint8Array
    let parsed: ReturnType<typeof parseTorrentFile>
    try {
      bytes = await prowlarrDownload(settings, candidate, TORRENT_FILE_MAX_BYTES)
      parsed = parseTorrentFile(bytes)
    } catch (error) {
      // An unreadable file is one failed candidate; an unreachable Prowlarr fails the lookup.
      if (error instanceof ProwlarrError && error.code !== 'invalid_response') throw error
      continue
    }
    if (sameFiles(parsed.files, source.files))
      return {
        kind: 'match',
        hash: parsed.info_hash,
        torrent: bytes,
        indexer: candidate.indexer,
        title: candidate.title,
      }
  }
  return {
    kind: 'no_match',
    reason: candidates.length
      ? `Prowlarr found ${plural(candidates.length, `possible ${tracker} torrent`)}, but none holds exactly the files SeaDex lists.`
      : `Prowlarr found no ${tracker} torrent of this release's size.`,
  }
}

const entryId = (release: ProwlarrRelease) =>
  `${release.indexer_id}-${createHash('sha1').update(release.guid).digest('hex').slice(0, 20)}`

async function findNzb(
  settings: ProwlarrSettings,
  source: PrivateSource,
  context: PrivateSearchContext,
): Promise<PrivateNzbLookup> {
  const indexers = (await prowlarrIndexers(settings)).filter(indexer => indexer.protocol === 'usenet')
  if (!indexers.length) return { kind: 'unconfigured', reason: 'Prowlarr has no Usenet indexer.' }
  const expected = totalBytes(source.files)
  const group = compact(context.releaseGroup)
  const plausible = (release: ProwlarrRelease) =>
    release.protocol === 'usenet' &&
    Boolean(group) &&
    compact(release.title).includes(group) &&
    (release.size === null ||
      (release.size >= expected * NZB_SIZE_RANGE[0] && release.size <= expected * NZB_SIZE_RANGE[1]))
  // Sonarr's anime queries: every scene title, in the anime categories, here led by the release group. All
  // titles are searched, as Sonarr does; candidates are ranked afterwards across every answer.
  const groupTerm = cleanSearchTitle(context.releaseGroup)
  const results = await searchAll(
    settings,
    context.titles.map(title => `${groupTerm} ${title}`.trim()),
    indexers.map(indexer => indexer.id),
    () => false,
    context.categories,
  )
  const closeness = (release: ProwlarrRelease) =>
    release.size === null ? Number.POSITIVE_INFINITY : Math.abs(release.size / expected - 1.05)
  const candidates = results
    .filter(plausible)
    .sort((left, right) => closeness(left) - closeness(right))
    .slice(0, CANDIDATE_LIMIT)
  const unproven: PrivateNzbCandidate[] = []
  const fetchFailures: ProwlarrError[] = []
  const expectedVideos = source.files.filter(file => VIDEO_FILE.test(file.name)).length
  for (const candidate of candidates) {
    let nzb: Uint8Array
    let files: NzbFile[]
    try {
      nzb = await gunzipOnce(await prowlarrDownload(settings, candidate, NZB_MAX_BYTES), NZB_MAX_BYTES)
      files = nzbFiles(nzb)
    } catch (error) {
      const failure =
        error instanceof ProwlarrError ? error : new ProwlarrError('invalid_response', errorMessage(error))
      if (LOOKUP_FAILURES.has(failure.code)) throw failure
      fetchFailures.push(failure)
      // Shown so the user can still judge it on the indexer, but never sent: nothing could be checked.
      unproven.push({
        entry_id: entryId(candidate),
        indexer: candidate.indexer,
        title: candidate.title,
        size: candidate.size,
        files: [],
        download_path: candidate.download_path,
        nzb: null,
        ...(candidate.info_url ? { info_url: candidate.info_url } : {}),
        files_matched: 0,
        names_matched: 0,
        files_expected: expectedVideos,
        sizes_known: false,
        unavailable: failure.message,
      })
      continue
    }
    const checked = {
      entry_id: entryId(candidate),
      indexer: candidate.indexer,
      title: candidate.title,
      size: candidate.size,
      files,
      download_path: candidate.download_path,
      nzb,
    }
    if (nzbHasFiles(files, source.files)) return { kind: 'match', ...checked }
    unproven.push({
      ...checked,
      ...(candidate.info_url ? { info_url: candidate.info_url } : {}),
      ...nzbFileMatches(files, source.files),
    })
  }
  // When no candidate could be reached at all, the search failed; it did not find an absence.
  if (
    candidates.length &&
    fetchFailures.length === candidates.length &&
    fetchFailures.every(failure => TRANSIENT_FAILURES.has(failure.code))
  )
    throw fetchFailures[0]
  return {
    kind: 'no_match',
    reason: candidates.length
      ? `Prowlarr found ${plural(candidates.length, 'possible NZB')}, but none names every file of this release with its exact size.`
      : 'Prowlarr found no NZB by this release group with a matching size.',
    ...(unproven.length ? { candidates: unproven } : {}),
  }
}

/** Runs one lookup once, however many callers ask at the same time, and caches what it settles to. */
async function cached<T extends { kind: string }>(
  cache: Map<string, Entry<T>>,
  kind: 'torrent' | 'nzb',
  key: string,
  refresh: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!refresh) {
    const hit = fresh(cache.get(key))
    if (hit) return hit
  }
  const flightKey = `${kind}\u0000${key}`
  const running = inFlight.get(flightKey) as Promise<T> | undefined
  if (running) return running
  const started = epoch
  const promise = limited(work)
    .catch(error => failed(error) as unknown as T)
    .then(value => {
      if (started === epoch) {
        if (value.kind === 'failed')
          log('WARNING', `Prowlarr ${kind} lookup failed: ${(value as unknown as Failure).message}`)
        cache.set(key, { at: Date.now(), ttl: ttlOf(kind, value), value })
        if (kind === 'nzb') trimNzbBytes()
      }
      return value
    })
    .finally(() => {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey)
    })
  inFlight.set(flightKey, promise)
  return promise
}

/** Every checked NZB an observation holds: its match, or the candidates it could not prove. */
function checkedNzbs(lookup: PrivateNzbLookup): { entry_id: string; nzb: Uint8Array | null }[] {
  if (lookup.kind === 'match') return [lookup]
  if (lookup.kind === 'no_match') return lookup.candidates || []
  return []
}

/** Drops the bytes of the oldest checked NZBs once they exceed the memory budget; what was learned stays. */
function trimNzbBytes(): void {
  let total = 0
  const held = [...nzbs.values()].sort((left, right) => right.at - left.at).flatMap(entry => checkedNzbs(entry.value))
  for (const checked of held) {
    if (!checked.nzb) continue
    total += checked.nzb.byteLength
    if (total > NZB_BYTES_BUDGET) checked.nzb = null
  }
}

const unconfigured: Unconfigured = { kind: 'unconfigured', reason: 'Prowlarr is not set up.' }

/** Finds the private-tracker torrent through Prowlarr and checks its files. */
export async function resolvePrivateTorrent(
  config: Config,
  source: PrivateSource,
  context: PrivateSearchContext,
  refresh = false,
): Promise<PrivateTorrentLookup> {
  const settings = privateSearchSettings(config)
  if (!settings) return unconfigured
  return cached(torrents, 'torrent', sourceKey(settings, source.id), refresh, () =>
    findTorrent(settings, source, context),
  )
}

/**
 * Prowlarr settings for an NZB search. A private-tracker release (a `files:` source) needs private trackers
 * in Release preferences; a public torrent the hash indexers lack (an info-hash source) only needs Prowlarr.
 */
function nzbSearchSettings(config: Config, sourceId: string): ProwlarrSettings | null {
  return isInfoHash(sourceId) ? prowlarrSettings(config) : privateSearchSettings(config)
}

/**
 * Finds a Usenet copy through Prowlarr: of a private-tracker release, or of a public torrent the hash
 * indexers do not have. Without `search`, only an earlier
 * result is returned, so bulk reviews never grab NZBs from indexers on their own.
 */
export async function resolvePrivateNzb(
  config: Config,
  source: PrivateSource,
  context: PrivateSearchContext,
  { search, refresh = false }: { search: boolean; refresh?: boolean },
): Promise<PrivateNzbLookup> {
  const settings = nzbSearchSettings(config, source.id)
  if (!settings) return unconfigured
  const key = sourceKey(settings, source.id)
  if (!search) return fresh(nzbs.get(key)) ?? { kind: 'not_checked' }
  return cached(nzbs, 'nzb', key, refresh, () => findNzb(settings, source, context))
}

/** What is known about a Usenet copy right now, without asking Prowlarr. */
export function privateNzbSnapshot(
  config: Config,
  sourceId: string,
): { lookup: PrivateNzbLookup; checkedAt: number; running: boolean } {
  const settings = nzbSearchSettings(config, sourceId)
  if (!settings) return { lookup: unconfigured, checkedAt: 0, running: false }
  const key = sourceKey(settings, sourceId)
  const entry = nzbs.get(key)
  return {
    lookup: fresh(entry) ?? { kind: 'not_checked' },
    checkedAt: fresh(entry) ? entry!.at : 0,
    running: inFlight.has(`nzb\u0000${key}`),
  }
}

/** Starts a search in the background; the next availability read reports its result. */
export function searchPrivateNzbInBackground(
  config: Config,
  source: PrivateSource,
  context: PrivateSearchContext,
): void {
  void resolvePrivateNzb(config, source, context, { search: true, refresh: true }).catch(error =>
    log('WARNING', `Prowlarr NZB search failed: ${errorMessage(error)}`),
  )
}

/** A checked NZB of a private source by its entry ID: the proven match, or a candidate the user chose. */
function checkedNzb(settings: ProwlarrSettings, sourceId: string, entry: string) {
  const lookup = fresh(nzbs.get(sourceKey(settings, sourceId)))
  if (lookup?.kind === 'match') return lookup.entry_id === entry ? lookup : undefined
  if (lookup?.kind === 'no_match') return lookup.candidates?.find(candidate => candidate.entry_id === entry)
  return undefined
}

/** The NZB candidate the user chose for a private source, as a match the planner can send. Never searches. */
export function chosenPrivateNzb(config: Config, sourceId: string, entry: string): PrivateNzbMatch | undefined {
  const settings = nzbSearchSettings(config, sourceId)
  const candidate = settings ? checkedNzb(settings, sourceId, entry) : undefined
  // A candidate that could not be fetched was never checked, so it is never sent.
  if (!candidate || ('unavailable' in candidate && candidate.unavailable)) return undefined
  return { ...candidate, kind: 'match' }
}

/** The checked NZB for an accepted submission, fetched again through Prowlarr when memory no longer holds it. */
export async function privateNzbBytes(config: Config, sourceId: string, entry: string): Promise<Uint8Array> {
  const settings = prowlarrSettings(config)
  if (!settings) throw new Error('Prowlarr is no longer configured.')
  const match = checkedNzb(settings, sourceId, entry)
  if (!match) throw new Error('The NZB found through Prowlarr is no longer known. Re-run the review before submitting.')
  if (match.nzb) return match.nzb
  const nzb = await gunzipOnce(await prowlarrDownload(settings, match, NZB_MAX_BYTES), NZB_MAX_BYTES)
  // The same entry must still be the same post: every file it named before, with the same size.
  const now = new Set(nzbFiles(nzb).map(file => `${file.name}\u0000${file.size}`))
  if (!match.files.every(file => now.has(`${file.name}\u0000${file.size}`)))
    throw new Error('The NZB changed since it was checked. Re-run the review before submitting.')
  return nzb
}

/** A Usenet lookup as the availability state of one private source. */
export function privateNzbState(sourceId: string, lookup: PrivateNzbLookup): UsenetHashAvailability {
  switch (lookup.kind) {
    case 'match':
      return {
        hash: sourceId,
        state: 'available',
        provider: 'prowlarr',
        entry_id: lookup.entry_id,
        title: lookup.title,
        ...(lookup.size !== null ? { total_bytes: lookup.size } : {}),
        // Subjects name the posted files, PAR2 sets included; that is no complete source manifest.
        files_known: false,
        file_count: lookup.files.length,
      }
    case 'no_match':
      return {
        hash: sourceId,
        state: 'no_match',
        provider: 'prowlarr',
        error: lookup.reason,
        ...(lookup.candidates?.length
          ? {
              candidates: lookup.candidates.map(candidate => ({
                entry_id: candidate.entry_id,
                title: candidate.title,
                indexer: candidate.indexer,
                ...(candidate.size !== null ? { size: candidate.size } : {}),
                ...(candidate.info_url ? { info_url: candidate.info_url } : {}),
                files_matched: candidate.files_matched,
                names_matched: candidate.names_matched,
                files_expected: candidate.files_expected,
                sizes_known: candidate.sizes_known,
                ...(candidate.unavailable ? { unavailable: candidate.unavailable } : {}),
              })),
            }
          : {}),
      }
    case 'failed':
      return {
        hash: sourceId,
        state: 'lookup_failed',
        provider: 'prowlarr',
        error_code: lookup.code,
        error: lookup.message,
        providers_failed: ['prowlarr'],
      }
    case 'unconfigured':
      return { hash: sourceId, state: 'not_configured', provider: 'prowlarr', error: lookup.reason }
    case 'not_checked':
      return { hash: sourceId, state: 'not_checked', provider: 'prowlarr' }
  }
}
