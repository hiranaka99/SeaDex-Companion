// Finds the torrents of releases SeaDex lists on private trackers through the indexers configured in Prowlarr.
//
// SeaDex withholds a private torrent's info hash but lists its files with exact sizes. A candidate is
// accepted only when its own file list matches that list: the .torrent file must hold exactly the listed
// files. Titles and sizes reported by indexers only choose which few candidates are fetched and checked.
// Usenet copies of the same releases are found by `server/usenet-search.ts`.

import type { Config, PrivateSource } from './types.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import { errorMessage } from '../shared/errors.js'
import { log } from './logging.js'
import {
  ProwlarrError,
  prowlarrDownload,
  prowlarrFingerprint,
  prowlarrIndexers,
  privateSearchSettings,
  searchProwlarr,
  trackerIndexers,
  type ProwlarrRelease,
  type ProwlarrSettings,
} from './prowlarr.js'
import { parseTorrentFile, TORRENT_FILE_MAX_BYTES } from './torrent-file.js'
import { sameFiles, type SourceFile } from './source-files.js'
import { searchTitles } from './search-titles.js'
import { usenetParts } from './usenet-runtime.js'

/** What the search terms are built from. No search names a category: Prowlarr drops every result outside it. */
export interface PrivateSearchContext {
  /** Every cleaned title the release may be listed under (see `searchTitles`). */
  titles: string[]
  releaseGroup: string
  tracker: string
}

/** The search context of one release of a library result. */
export function searchContext(
  result: Parameters<typeof searchTitles>[0],
  release: { releaseGroup: string; tracker: string },
): PrivateSearchContext {
  return { titles: searchTitles(result), releaseGroup: release.releaseGroup, tracker: release.tracker }
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TTL = { match: HOUR, no_match: 30 * MINUTE, failed: MINUTE, unconfigured: 5 * MINUTE }
/** Each candidate fetched through Prowlarr counts as a grab on its indexer. */
const CANDIDATE_LIMIT = 3
/** At most this many titles are searched; every query goes to every selected indexer. */
const TITLE_LIMIT = 4
const SEARCH_CONCURRENCY = 2

interface Entry {
  at: number
  ttl: number
  value: PrivateTorrentLookup
}

/**
 * The private torrents found or missed recently and the lookups under way, with the clock that dates them and
 * the fetch Prowlarr is asked with. A Usenet runtime (`usenet-runtime.ts`) builds it and owns it.
 */
export class PrivateTorrentCache {
  readonly torrents = new Map<string, Entry>()
  readonly inFlight = new Map<string, Promise<PrivateTorrentLookup>>()
  readonly now: () => number
  readonly fetch: typeof fetch
  private epoch = 0
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  /** Forget every observation, for a changed Prowlarr connection. Running work is discarded when it settles. */
  invalidate(): void {
    this.epoch++
    this.torrents.clear()
    this.inFlight.clear()
  }

  /** A check that holds until the next invalidation. */
  stamp(): () => boolean {
    const at = this.epoch
    return () => at === this.epoch
  }

  /** Runs `work` once fewer than `SEARCH_CONCURRENCY` lookups run. */
  async limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.running >= SEARCH_CONCURRENCY) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.running++
    try {
      return await work()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

const sourceKey = (settings: ProwlarrSettings, id: string) => `${prowlarrFingerprint(settings)}\u0000${id}`

function failed(error: unknown): Failure {
  if (error instanceof ProwlarrError) return { kind: 'failed', code: error.code, message: error.message }
  return { kind: 'failed', code: 'network', message: errorMessage(error).slice(0, 200) }
}

const totalBytes = (files: SourceFile[]) => files.reduce((sum, file) => sum + file.length, 0)
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Results of several queries, each listed once. Stops early once `enough` is satisfied. */
async function searchAll(
  settings: ProwlarrSettings,
  queries: string[],
  indexerIds: number[],
  enough: (results: ProwlarrRelease[]) => boolean,
  fetchImpl: typeof fetch,
): Promise<ProwlarrRelease[]> {
  const seen = new Map<string, ProwlarrRelease>()
  for (const query of new Set(queries.filter(Boolean))) {
    for (const release of await searchProwlarr(settings, query, indexerIds, fetchImpl))
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
  fetchImpl: typeof fetch,
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
    context.titles.slice(0, TITLE_LIMIT),
    indexers.map(indexer => indexer.id),
    found => Boolean(id) && found.some(release => namesTorrent(release, id)),
    fetchImpl,
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
      bytes = await prowlarrDownload(settings, candidate, TORRENT_FILE_MAX_BYTES, fetchImpl)
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

/** Finds the private-tracker torrent through Prowlarr and checks its files. */
export async function resolvePrivateTorrent(
  config: Config,
  source: PrivateSource,
  context: PrivateSearchContext,
  refresh = false,
): Promise<PrivateTorrentLookup> {
  const settings = privateSearchSettings(config)
  if (!settings) return { kind: 'unconfigured', reason: 'Prowlarr is not set up.' }
  const key = sourceKey(settings, source.id)
  const current = usenetParts().privateSources
  if (!refresh) {
    const hit = current.torrents.get(key)
    if (hit && current.now() - hit.at < hit.ttl) return hit.value
  }
  // One lookup runs once, however many callers ask at the same time.
  const shared = current.inFlight.get(key)
  if (shared) return shared
  const valid = current.stamp()
  const promise = current
    .limited(() => findTorrent(settings, source, context, current.fetch))
    .catch((error): PrivateTorrentLookup => failed(error))
    .then(value => {
      if (valid()) {
        if (value.kind === 'failed') log('WARNING', `Prowlarr torrent lookup failed: ${value.message}`)
        current.torrents.set(key, { at: current.now(), ttl: TTL[value.kind], value })
      }
      return value
    })
    .finally(() => {
      if (current.inFlight.get(key) === promise) current.inFlight.delete(key)
    })
  current.inFlight.set(key, promise)
  return promise
}
