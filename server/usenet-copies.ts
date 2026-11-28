import type { Config, ResultItem } from './types.js'
import { log } from './logging.js'
import { releaseForbidden, torrentHashes } from '../shared/download-plan.js'
import { releaseIdentity } from '../shared/releases.js'
import type { PrivateSource, Release } from '../shared/contracts.js'
import type { UsenetAvailabilityResult, UsenetHashAvailability, UsenetUnitState } from '../shared/usenet-contracts.js'
import { knownProwlarrIndexers, privateSearchSettings, prowlarrSettings } from './prowlarr.js'
import { searchContext } from './private-sources.js'
import {
  aggregateHashStates,
  availabilityMetadata,
  FILE_NAME_LIMIT,
  observeUsenetHash,
  resolveUsenetHash,
  UsenetSelectionError,
} from './usenet.js'
import {
  cancelSourceCheck,
  chosenSearchCandidate,
  resolveSource,
  searchSnapshot,
  type UsenetSourceOutcome,
} from './usenet-search.js'

/**
 * The Usenet copy resolver: where a Usenet copy of a release can come from, and what finding it may cost.
 *
 * A release with a torrent hash is looked up by hash on the hash indexers (AnimeTosho, AmeNZB). A hash every
 * enabled hash indexer answered "no NZB" for may have a copy found through Prowlarr instead, searched for by
 * the file list SeaDex gives (the Prowlarr fallback); a failed or still-processing lookup never qualifies. A
 * private-tracker release has no hash and is found through Prowlarr only, by its `files:<sha1>` sources.
 *
 * Callers name their intent and never combine these steps themselves. The intent decides what is waited for
 * and what may be spent; an NZB fetch counts as a grab on the indexer.
 *
 * | Intent          | Hash indexers       | Prowlarr searches                 | NZB fetches                          |
 * | --------------- | ------------------- | --------------------------------- | ------------------------------------ |
 * | `look`          | cache (1)           | never                             | never                                |
 * | `search`        | cache (1)           | always, started (2)               | up to 3 (3)                          |
 * | `check`         | cache (1)           | without a fresh record, started   | 1, while `not_checked`, `unverified` |
 * | `single_review` | awaited             | without a fresh record, awaited   | up to 3, while `unverified`          |
 * | `bulk_review`   | awaited             | never                             | never                                |
 * | `acceptance`    | awaited             | never                             | never                                |
 * | `sweep`         | awaited, background | `searchInBackground`, when stale  | never                                |
 *
 * (1) A missing or stale observation is refreshed in the background and never waited for.
 * (2) Started work is reported through later snapshots; the answer never waits for it.
 * (3) Also for a source already `no_match` or `lookup_failed`.
 *
 * A chosen NZB (`nzb`) is read as it was checked and costs nothing. Submission fetches an NZB again only when
 * its stored bytes were evicted (`searchNzbBytes`); that is not a lookup and does not pass through here.
 */
export type CopyIntent = 'look' | 'search' | 'check' | 'single_review' | 'bulk_review' | 'acceptance' | 'sweep'

type ProwlarrSpend =
  /** Prowlarr is not consulted: the sweep searches in a stage of its own. */
  | { kind: 'none' }
  /** What is stored, without any request. */
  | { kind: 'read' }
  /** Work started for the row and reported through later snapshots; the answer never waits for it. */
  | { kind: 'start'; fetches: number; refresh?: true; onlyUnsettled?: true; cancellable?: true }
  /** Work the answer waits for. */
  | { kind: 'await'; fetches: number }

interface Budget {
  hashes: 'cached' | 'await' | 'await_background'
  prowlarr: ProwlarrSpend
  /**
   * A private-tracker source is reported `not_configured` when Prowlarr's indexer list has no Usenet indexer.
   * Reading that list may refresh it in the background, so a review or an acceptance, which never asks
   * Prowlarr about a private-tracker release, does not look.
   */
  indexerList?: true
}

const BUDGETS: Record<CopyIntent, Budget> = {
  look: { hashes: 'cached', prowlarr: { kind: 'read' }, indexerList: true },
  search: { hashes: 'cached', prowlarr: { kind: 'start', fetches: 3, refresh: true }, indexerList: true },
  check: {
    hashes: 'cached',
    prowlarr: { kind: 'start', fetches: 1, onlyUnsettled: true, cancellable: true },
    indexerList: true,
  },
  single_review: { hashes: 'await', prowlarr: { kind: 'await', fetches: 3 } },
  bulk_review: { hashes: 'await', prowlarr: { kind: 'read' } },
  acceptance: { hashes: 'await', prowlarr: { kind: 'read' } },
  sweep: { hashes: 'await_background', prowlarr: { kind: 'none' } },
}

export interface CopyRequest {
  release: Release
  /** The library result the release belongs to: its titles are the search terms. */
  result: ResultItem | undefined
  intent: CopyIntent
  /** Only these sources, for example the ones no acquisition covers yet. Every source of the release by default. */
  only?: readonly string[]
  /** The entry ID of the NZB the user chose. It is taken as it was checked, and nothing is searched for it. */
  nzb?: string
  /** Ask the hash indexers again even when their answer is fresh. */
  refresh?: boolean
}

export interface UsenetCopies {
  /** By torrent hash, or, for a private-tracker release, by file list through Prowlarr only. */
  by: 'hash' | 'file_list'
  /** One row per source asked about, with complete file manifests. A copy found through Prowlarr has `provider: 'prowlarr'`. */
  hashes: UsenetHashAvailability[]
  aggregate: UsenetUnitState
  /** By hash only: Prowlarr reports a copy the hash indexers lack (`found`), or may be searched for one (`searchable`). */
  prowlarr?: 'found' | 'searchable'
  /** The sources Prowlarr may be searched for by file list, with the file list a copy is checked against. */
  fileListSources: PrivateSource[]
}

/** Private-tracker sources Prowlarr can search for, when the release has no public torrent hash. */
function privateUsenetSources(
  config: Config,
  release: Pick<Release, 'info_hashes' | 'private_sources'>,
): PrivateSource[] {
  if (torrentHashes(release).length || !privateSearchSettings(config)) return []
  return release.private_sources || []
}

/** Whether Prowlarr has a Usenet indexer: false only when its current indexer list says so, never while unknown. */
function prowlarrHasUsenet(config: Config): boolean | undefined {
  const settings = prowlarrSettings(config)
  if (!settings) return false
  return knownProwlarrIndexers(settings)?.some(indexer => indexer.protocol === 'usenet')
}

/**
 * A public torrent as a source Prowlarr can search for once the hash indexers lack it: its hash and exact file
 * list. Null without a Prowlarr that may have a Usenet indexer, or when SeaDex lists no complete file list to
 * check a copy against.
 */
function prowlarrFallbackSource(
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

/**
 * The sources of a release that Prowlarr may be searched for by file list: its private-tracker sources when it
 * has no hash, otherwise each hash the hash indexers answered "no NZB" for (`hashState`) whose files SeaDex lists.
 */
export function fileListSources(
  config: Config,
  release: Release,
  hashState: (hash: string) => UsenetUnitState | undefined,
): PrivateSource[] {
  const sources = privateUsenetSources(config, release)
  if (sources.length) return sources
  return torrentHashes(release).flatMap(hash =>
    hashState(hash) === 'no_match' ? (prowlarrFallbackSource(config, release, hash) ?? []) : [],
  )
}

/** The Usenet source identities a release is acquired by: its torrent hashes, or its private sources' file-list IDs. */
export function usenetSourceIds(config: Config, release: Pick<Release, 'info_hashes' | 'private_sources'>): string[] {
  const hashes = torrentHashes(release)
  return hashes.length ? hashes : privateUsenetSources(config, release).map(source => source.id)
}

/** What one call has already started, so rows sharing a hash or a source start the work once. */
interface CallState {
  refreshed: Set<string>
  started: Set<string>
}

const isoTime = (time: number): string => (time ? new Date(time).toISOString() : '')

/** What is stored about a source's Prowlarr search, as an availability row. */
function storedCopy(config: Config, sourceId: string): UsenetHashAvailability {
  const snapshot = searchSnapshot(config, sourceId)
  return {
    ...snapshot.availability,
    checked_at: isoTime(snapshot.checkedAt),
    stale: snapshot.stale,
    refreshing: snapshot.running,
  }
}

const noUsenetIndexer = (source: PrivateSource): UsenetHashAvailability => ({
  hash: source.id,
  state: 'not_configured',
  provider: 'prowlarr',
  error: 'Prowlarr has no Usenet indexer.',
  checked_at: '',
  stale: false,
  refreshing: false,
})

/** The copy of one source found through Prowlarr, after the work the intent allows. */
async function prowlarrCopy(
  config: Config,
  source: PrivateSource,
  request: CopyRequest,
  call: CallState,
): Promise<UsenetHashAvailability> {
  if (request.nzb) {
    const chosen = chosenSearchCandidate(config, source.id, request.nzb)
    if (chosen) return chosen
  }
  const spend = BUDGETS[request.intent].prowlarr
  if (spend.kind === 'await' && !request.nzb)
    return (
      await resolveSource(config, source, searchContext(request.result, request.release), { limit: spend.fetches })
    ).availability
  if (spend.kind === 'start' && !call.started.has(source.id)) {
    const { state } = searchSnapshot(config, source.id).availability
    if (!spend.onlyUnsettled || state === 'not_checked' || state === 'unverified') {
      call.started.add(source.id)
      const options = {
        limit: spend.fetches,
        ...(spend.refresh ? { refresh: true } : {}),
        ...(spend.cancellable ? { cancellable: true } : {}),
      }
      // Failures come back as states of the source; only a defect lands here, and its text is not logged.
      void resolveSource(config, source, searchContext(request.result, request.release), options).catch(error =>
        log('WARNING', `Prowlarr NZB search stopped: ${error instanceof Error ? error.name : 'unknown error'}`),
      )
    }
  }
  return storedCopy(config, source.id)
}

/** What the hash indexers answer for each hash, from the cache or awaited, as the intent says. */
async function hashAnswers(
  config: Config,
  hashes: string[],
  request: CopyRequest,
  call: CallState,
): Promise<UsenetHashAvailability[]> {
  const refresh = request.refresh === true
  const mode = BUDGETS[request.intent].hashes
  if (mode === 'cached') return hashes.map(hash => observeUsenetHash(config, hash, refresh, call.refreshed))
  return Promise.all(hashes.map(hash => resolveUsenetHash(config, hash, refresh, mode === 'await_background')))
}

async function resolveCopies(config: Config, request: CopyRequest, call: CallState): Promise<UsenetCopies> {
  const { release } = request
  const wanted = (id: string) => !request.only || request.only.includes(id)
  const privateSources = privateUsenetSources(config, release)
  if (privateSources.length) {
    const sources = privateSources.filter(source => wanted(source.id))
    // Without a Usenet indexer Prowlarr cannot find a copy; say so instead of offering a search.
    const noUsenet = BUDGETS[request.intent].indexerList && prowlarrHasUsenet(config) === false
    const hashes = await Promise.all(
      sources.map(source =>
        noUsenet ? Promise.resolve(noUsenetIndexer(source)) : prowlarrCopy(config, source, request, call),
      ),
    )
    return {
      by: 'file_list',
      hashes,
      aggregate: aggregateHashStates(hashes.map(hash => hash.state)),
      fileListSources: sources,
    }
  }
  const required = torrentHashes(release).filter(wanted)
  if (!required.length)
    return {
      by: 'hash',
      hashes: [{ hash: '', state: 'unsupported_hash', stale: false, refreshing: false }],
      aggregate: 'unsupported_hash',
      fileListSources: [],
    }
  const answers = await hashAnswers(config, required, request, call)
  const states = new Map(answers.map(answer => [answer.hash, answer.state]))
  const sources = fileListSources(config, release, hash => states.get(hash))
  if (!sources.length || BUDGETS[request.intent].prowlarr.kind === 'none')
    return {
      by: 'hash',
      hashes: answers,
      aggregate: aggregateHashStates(answers.map(answer => answer.state)),
      fileListSources: sources,
    }
  let found = false
  const hashes = await Promise.all(
    answers.map(async (answer): Promise<UsenetHashAvailability> => {
      const source = sources.find(entry => entry.id === answer.hash)
      if (!source) return answer
      const copy = await prowlarrCopy(config, source, request, call)
      // Nothing to report from Prowlarr yet, or nothing it can do: what the hash indexers said stands.
      if (copy.state === 'not_configured' || (copy.state === 'not_checked' && !copy.refreshing)) return answer
      found = true
      return { ...copy, ...(answer.providers_checked ? { providers_checked: answer.providers_checked } : {}) }
    }),
  )
  return {
    by: 'hash',
    hashes,
    aggregate: aggregateHashStates(hashes.map(hash => hash.state)),
    prowlarr: found ? 'found' : 'searchable',
    fileListSources: sources,
  }
}

/**
 * The Usenet copies of each requested release, after the work its intent allows (see `CopyIntent`). Rows of
 * one call that share a hash or a source start their background work once.
 */
export function resolveUsenetCopies(config: Config, requests: readonly CopyRequest[]): Promise<UsenetCopies[]> {
  const call: CallState = { refreshed: new Set(), started: new Set() }
  return Promise.all(requests.map(request => resolveCopies(config, request, call)))
}

/**
 * Withdraws the checks `check` rows started for a release, because its review was cancelled or its row was
 * switched to a torrent. Covers every source Prowlarr may be searched for, whatever is known about it.
 */
export function cancelCopyChecks(config: Config, release: Release): void {
  for (const source of fileListSources(config, release, () => 'no_match')) cancelSourceCheck(config, source.id)
}

/**
 * The sweep's search stage for one source: a search at background priority, counted against the daily
 * search limit, and never an NZB fetch.
 */
export function searchInBackground(
  config: Config,
  item: { source: PrivateSource; release: Release; result: ResultItem | undefined },
): Promise<UsenetSourceOutcome> {
  return resolveSource(config, item.source, searchContext(item.result, item.release), { background: true })
}

interface RowRef {
  key: string
  release: number
}

const rowId = (row: RowRef) => `${row.key}\u0000${row.release}`

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
 *
 * The public projection bounds filename lists; a truncated list is no longer a complete manifest.
 */
export async function usenetAvailability(
  config: Config,
  selections: { key: string; release: number; identity?: string }[],
  results: ResultItem[],
  {
    refresh = false,
    search = [],
    verify = [],
    cancelVerify = [],
  }: { refresh?: boolean; search?: RowRef[]; verify?: RowRef[]; cancelVerify?: RowRef[] } = {},
): Promise<UsenetAvailabilityResult[]> {
  const resultsByKey = new Map(results.map(result => [result.key, result]))
  const releaseAt = (row: RowRef) =>
    Number.isSafeInteger(row.release) && row.release >= 0
      ? resultsByKey.get(row.key)?.releases?.[row.release]
      : undefined
  const listed = selections.map(selection => {
    const release = releaseAt(selection)
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
  // A release excluded for its episode numbering is never downloaded, so nothing is looked up or searched for it.
  const selected = listed.filter(({ release }) => !releaseForbidden(release))
  // Withdrawn before anything starts, so a row that is cancelled and selected again starts over.
  for (const row of cancelVerify) {
    const release = releaseAt(row)
    if (release) cancelCopyChecks(config, release)
  }
  // Prowlarr is asked only for the rows named: each checked NZB counts against the indexer's grab limit.
  const searched = new Set(search.map(rowId))
  const verified = new Set(verify.map(rowId))
  const copies = await resolveUsenetCopies(
    config,
    selected.map(({ selection, release }) => ({
      release,
      result: resultsByKey.get(selection.key),
      intent: searched.has(rowId(selection)) ? 'search' : verified.has(rowId(selection)) ? 'check' : 'look',
      refresh,
    })),
  )
  return selected.map(({ selection, identity }, index) => {
    const found = copies[index]
    const hashes = found.hashes.map(hash =>
      hash.file_names && hash.file_names.length > FILE_NAME_LIMIT
        ? { ...hash, files_known: false, file_names: hash.file_names.slice(0, FILE_NAME_LIMIT) }
        : hash,
    )
    const marker =
      found.by === 'file_list' || found.prowlarr === 'found'
        ? { search: 'prowlarr' as const }
        : found.prowlarr === 'searchable'
          ? { fallback: 'prowlarr' as const }
          : {}
    return {
      key: selection.key,
      release: selection.release,
      identity,
      hashes,
      aggregate: found.aggregate,
      ...marker,
      ...availabilityMetadata(found.hashes),
    }
  })
}
