import { releaseIdentity } from '../shared/releases.js'
import { estimateDownloads } from '../shared/download-estimate.js'
import {
  isSeasonUpgradable,
  normalizeTorrentPath,
  planTorrents,
  releaseOffered,
  releaseOwned,
  torrentHashes,
} from '../shared/download-plan.js'
import { rowKey, seasonTag } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import type {
  DiskSpaceCheck,
  DownloadMode,
  DownloadPreflight,
  DownloadProtocol,
  DownloadSelection,
  DownloadSelectionRef,
  PreflightBlocked,
} from '../shared/download-contracts.js'
import type { UsenetHashAvailability, UsenetUnitState } from '../shared/usenet-contracts.js'
import type { Config, PrivateSource, Release, ResultItem } from './types.js'
import { downloadCategory } from './config.js'
import { currentGeneration } from './config-generation.js'
import { putPlan, type StoredPlan, type StoredPlanSelection } from './download-plans.js'
import { downloadRecords, type OwnedDownloadRecord } from './download-store.js'
import { downloadClients } from './download-clients.js'
import type { ClientPresence, DownloadClientAdapter, SubmissionUnit } from './download-client-types.js'
import { HttpError } from './http-error.js'
import {
  aggregateHashStates,
  privateUsenetSources,
  prowlarrFallbackSource,
  resolveUsenetRelease,
  sabnzbdConfigured,
  usenetConfigured,
  usenetSourceIds,
} from './usenet.js'
import { privateSearchSettings } from './prowlarr.js'
import { resolvePrivateTorrent, searchContext, type PrivateSearchContext } from './private-sources.js'
import { chosenSearchCandidate, resolveSource, searchSnapshot } from './usenet-search.js'

/** What a review resolves to before it is shown or sent: the public summary, the units behind it, and the rows that survive. */
export interface PlannedDownloads {
  review: Omit<DownloadPreflight, 'plan_id' | 'expires_in'>
  units: SubmissionUnit[]
  selections: StoredPlanSelection[]
}

const EXTRA_FILE_LIMIT = 10
/** NZBs a single review may fetch through Prowlarr for one source. Bulk reviews and acceptances fetch none. */
const REVIEW_FETCHES = 3

/** Whether a source found through Prowlarr may be searched and checked now, or only read from what is stored. */
export type ResolveMode = 'stored' | 'search'

/** Why a release the user's preferences exclude is blocked; it keeps the `invalid` code. */
const EXCLUDED_RELEASE_COPY = 'Your release preferences exclude this release.'
/** The candidate a row names is not one that was fetched and checked; it keeps the `not_searched` code. */
const CHOSEN_NZB_COPY = 'The chosen NZB is no longer known or could not be fetched; search Prowlarr again.'

const BLOCK_COPY: Record<PreflightBlocked['code'], string> = {
  invalid: 'A selected release is unavailable.',
  not_upgradable: 'This season is not marked for an upgrade.',
  owned: 'This release group already owns the current episodes.',
  excluded: 'This cour is excluded from downloads.',
  protocol_required: 'Choose a protocol for this release.',
  mode_conflict: 'The saved download mode does not allow this protocol.',
  no_torrent: 'This release has no supported public torrent hash.',
  private_no_match: 'Prowlarr found no copy of this private-tracker release with exactly its files.',
  private_lookup_failed: 'Could not search Prowlarr for this private-tracker release.',
  not_searched: 'This release has not been searched on Usenet yet. Open the review again, or search it in its details.',
  not_verified: 'Usenet results for this release have not been checked yet.',
  usenet_unconfigured: 'Usenet acquisition needs SABnzbd and a provider before it can be used.',
  no_match: 'Not found on Usenet indexers.',
  processing: 'Not found on Usenet indexers yet; the indexer has not finished converting this source.',
  incomplete: 'Usenet is unavailable: some source torrents have no matching NZB.',
  lookup_failed: 'Could not check Usenet availability for this release.',
  conflict: 'The same source was requested through both protocols; choose one acquisition.',
  acceptance_unknown:
    'An earlier send of this release was never confirmed by the download client. Check the client; if the download is not there, stop tracking that entry to send it again.',
  client_unreachable:
    'Could not reach the download client to check what was already sent. Try again once it is reachable.',
  category_missing:
    'SABnzbd has no category with this name, so the download would never be imported. Create the category in SABnzbd or change it under Configuration → Downloads.',
}

/** Usenet outcomes that have their own wording; every other non-available outcome is a failed lookup. */
const USENET_BLOCK: Partial<Record<UsenetUnitState, PreflightBlocked['code']>> = {
  not_configured: 'usenet_unconfigured',
  no_match: 'no_match',
  processing: 'processing',
  incomplete: 'incomplete',
}

/** What a source found through Prowlarr blocks its row with while it has no proven copy; anything else is no match. */
const FILE_LIST_BLOCK: Partial<Record<UsenetUnitState, PreflightBlocked['code']>> = {
  not_checked: 'not_searched',
  unverified: 'not_verified',
  lookup_failed: 'lookup_failed',
  not_configured: 'usenet_unconfigured',
}

/** Rows that cannot be sent, in the order they were ruled out. A row keeps the first reason found for it. */
class BlockedRows {
  readonly entries: PreflightBlocked[] = []
  private readonly rows = new Set<string>()

  /** `detail` is appended to the code's standard copy; `{ reason }` replaces that copy outright. */
  add(row: DownloadSelectionRef, code: PreflightBlocked['code'], detail?: string | { reason: string }): void {
    if (this.has(row)) return
    this.rows.add(rowKey(row))
    this.entries.push({
      key: row.key,
      release: row.release,
      code,
      reason: typeof detail === 'object' ? detail.reason : detail ? `${BLOCK_COPY[code]} ${detail}` : BLOCK_COPY[code],
    })
  }

  has(row: DownloadSelectionRef): boolean {
    return this.rows.has(rowKey(row))
  }
}

/** A selection that passed validation: the release it points at and how it will be sent. */
interface ResolvedRow extends DownloadSelectionRef {
  identity: string
  protocol: DownloadProtocol
  source: Release
  category: string
  label: string
  /** Prowlarr search terms for this release: titles, release group, tracker and categories. */
  search: PrivateSearchContext
  /** An unproven NZB the user chose for this private-tracker release. */
  nzb?: string
}

/** Units by ID. Rows that need the same source through the same client share one unit. */
class PlannedUnits {
  private readonly units = new Map<string, SubmissionUnit>()

  add(unit: SubmissionUnit): void {
    const existing = this.units.get(unit.unit_id)
    if (!existing) {
      this.units.set(unit.unit_id, unit)
      return
    }
    existing.selections = [
      ...new Map([...existing.selections, ...unit.selections].map(row => [rowKey(row), row])).values(),
    ]
    for (const label of unit.labels) if (!existing.labels.includes(label)) existing.labels.push(label)
    existing.requiresAck ||= unit.requiresAck
  }

  /** Drops the matching units and returns them. */
  remove(matches: (unit: SubmissionUnit) => boolean): SubmissionUnit[] {
    const removed = [...this.units.values()].filter(matches)
    for (const unit of removed) this.units.delete(unit.unit_id)
    return removed
  }

  all(): SubmissionUnit[] {
    return [...this.units.values()]
  }
}

/** Who already owns a source hash, as far as the ledger and a fresh client read can tell. */
interface Ownership {
  record?: OwnedDownloadRecord
  /** An earlier send was never confirmed, or the client could not be asked. */
  unresolved?: true
  unreachable?: true
}

interface PlanContext {
  config: Config
  clients: Record<DownloadProtocol, DownloadClientAdapter>
  presence: Record<DownloadProtocol, ClientPresence>
  blocks: BlockedRows
  units: PlannedUnits
  ownership(hash: string): Ownership
  /** Private-tracker torrents found through Prowlarr, by their real info hash. */
  privateTorrents: Map<string, { file: Uint8Array; sourceId: string }>
  /** `search` for a single review; a bulk review and an acceptance only read stored Prowlarr results for Usenet. */
  resolve: ResolveMode
}

function selectionLabel(result: ResultItem, release: Release): string {
  return `${result.title || result.key}${result.season ? ` ${seasonTag(result.season)}` : ''}${release.part ? ` · ${release.part}` : ''} [${release.releaseGroup}]`
}

/** Entry IDs of NZBs found through Prowlarr: indexer ID and a GUID digest. */
const NZB_CHOICE = /^\d+-[0-9a-f]{20}$/

/** Validates the request body's selections. The saved mode, not the browser, decides which protocols are allowed. */
export function parseSelections(raw: unknown): DownloadSelection[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'No download selections provided')
  return raw.map(item => {
    const selection = isRecord(item) ? item : {}
    const key = typeof selection.key === 'string' ? selection.key.trim() : ''
    const { release, identity, protocol, nzb } = selection
    if (!key) throw new HttpError(400, 'No key provided')
    if (typeof release !== 'number' || !Number.isInteger(release) || release < 0)
      throw new HttpError(400, 'Release must be a non-negative integer')
    if (identity !== undefined && typeof identity !== 'string')
      throw new HttpError(400, 'Release identity must be a string')
    if (protocol !== undefined && protocol !== 'torrent' && protocol !== 'usenet')
      throw new HttpError(400, 'Protocol must be torrent or usenet')
    if (nzb !== undefined && (typeof nzb !== 'string' || !NZB_CHOICE.test(nzb) || protocol !== 'usenet'))
      throw new HttpError(400, 'A chosen NZB needs the Usenet protocol and a valid entry ID')
    return {
      key,
      release,
      ...(identity ? { identity } : {}),
      ...(protocol ? { protocol } : {}),
      ...(nzb ? { nzb } : {}),
    }
  })
}

/** The protocol a row is sent with under the saved mode, or the reason it cannot be sent. */
function resolveProtocol(
  mode: DownloadMode,
  requested: DownloadProtocol | undefined,
): DownloadProtocol | 'mode_conflict' | 'protocol_required' {
  if (mode === 'choose') return requested ?? 'protocol_required'
  const only = mode === 'torrent_only' ? 'torrent' : 'usenet'
  return requested && requested !== only ? 'mode_conflict' : only
}

/** Checks every selection against the current results, the user's exclusions and the saved mode. */
function resolveRows(
  config: Config,
  selections: DownloadSelection[],
  results: ResultItem[],
  blocks: BlockedRows,
): ResolvedRow[] {
  // A single release is an explicit choice; a batch only takes best releases the library still needs.
  const batch = selections.length !== 1
  const resultsByKey = new Map(results.map(result => [result.key, result]))
  const seenParts = new Set<string>()
  const rows: ResolvedRow[] = []
  for (const selection of selections) {
    const result = resultsByKey.get(selection.key)
    const release = result?.releases[selection.release]
    if (!result || !release) {
      blocks.add(selection, 'invalid')
      continue
    }
    if (selection.identity && selection.identity !== releaseIdentity(release)) {
      throw new HttpError(409, 'A selected release changed. Reopen the review to see the latest recommendations.')
    }
    if (batch) {
      if (!isSeasonUpgradable(result) || result.excluded) {
        blocks.add(selection, 'not_upgradable')
        continue
      }
      if (!releaseOffered(release)) {
        if (release.excluded_by)
          blocks.add(selection, 'invalid', { reason: `${EXCLUDED_RELEASE_COPY} (${release.excluded_by})` })
        else blocks.add(selection, 'invalid')
        continue
      }
      const part = `${selection.key}\u0000${release.part || ''}`
      if (seenParts.has(part)) throw new HttpError(400, 'Choose only one best release per season or cour')
      seenParts.add(part)
    }
    if (result.excluded_parts?.includes(release.part || '')) {
      blocks.add(selection, 'excluded')
      continue
    }
    if (batch && releaseOwned(result, release)) {
      blocks.add(selection, 'owned')
      continue
    }
    const protocol = resolveProtocol(config.download_mode, selection.protocol)
    if (protocol === 'mode_conflict' || protocol === 'protocol_required') {
      blocks.add(selection, protocol)
      continue
    }
    if (protocol === 'usenet' && (!usenetConfigured(config) || !sabnzbdConfigured(config))) {
      blocks.add(selection, 'usenet_unconfigured')
      continue
    }
    if (selection.nzb && protocol !== 'usenet') {
      blocks.add(selection, 'invalid', {
        reason: 'A chosen NZB can only be sent over Usenet.',
      })
      continue
    }
    rows.push({
      key: selection.key,
      release: selection.release,
      identity: releaseIdentity(release),
      protocol,
      source: release,
      category: downloadCategory(config, result, protocol),
      label: selectionLabel(result, release),
      search: searchContext(result, release),
      ...(selection.nzb ? { nzb: selection.nzb } : {}),
    })
  }
  return rows
}

/** Fields that tie a unit to the acquisition already covering it. */
function existingFields(owned: OwnedDownloadRecord | undefined, client: DownloadClientAdapter) {
  if (!owned) return {}
  return {
    existing_record_id: owned.id,
    existing_native_id: owned.native_id,
    existing_unbound: owned.protocol !== client.protocol || owned.endpoint !== client.endpointId,
  }
}

const unresolvedCode = (unreachable: boolean | undefined): PreflightBlocked['code'] =>
  unreachable ? 'client_unreachable' : 'acceptance_unknown'

/** Torrent units reuse the shared per-hash deduplication and file-scope union rules. */
function planTorrentUnits(context: PlanContext, rows: ResolvedRow[]): void {
  const { blocks, units, clients, presence } = context
  for (const row of rows)
    if (!torrentHashes(row.source).length)
      blocks.add(
        row,
        'no_torrent',
        row.source.private_sources?.length && !privateSearchSettings(context.config)
          ? 'Set up Prowlarr with this tracker under Configuration to download private-tracker releases.'
          : undefined,
      )
  const usable = rows.filter(row => !blocks.has(row))
  const planned = planTorrents(usable.map(row => ({ release: row.source, category: row.category, label: row.label })))
  const sized = estimateDownloads(
    usable.map(row => ({ release: row.source, category: row.category })),
    [...presence.torrent.ids],
  )
  const estimates = new Map(sized.torrents.map(entry => [entry.hash, entry]))
  for (const row of usable) {
    const sources = planned.filter(entry => torrentHashes(row.source).includes(entry.hash))
    if (!sources.length) {
      blocks.add(row, 'no_torrent')
      continue
    }
    for (const entry of sources) {
      const { record: owned, unresolved, unreachable } = context.ownership(entry.hash)
      if (unresolved) {
        blocks.add(row, unresolvedCode(unreachable))
        continue
      }
      const estimate = estimates.get(entry.hash)
      const found = context.privateTorrents.get(entry.hash)
      units.add({
        unit_id: `torrent:${entry.hash}:${entry.category}`,
        protocol: 'torrent',
        client: 'qbittorrent',
        source_hash: entry.hash,
        category: entry.category,
        status: owned || presence.torrent.ids.has(entry.hash) ? 'existing' : 'new',
        ...existingFields(owned, clients.torrent),
        whole_source: !entry.selectedFiles,
        scope_expanded: false,
        size_bytes: estimate?.existing ? 0 : (estimate?.bytes ?? null),
        approximate: estimate?.approximate ?? true,
        scope_unknown: estimate?.bytes === null && !estimate?.existing,
        labels: [row.label],
        selections: [{ key: row.key, release: row.release }],
        requestedPaths: entry.selectedFiles || [],
        requiresAck: false,
        ...(found ? { torrentFile: found.file, sourceAlias: found.sourceId } : {}),
      })
    }
  }
}

/**
 * Finds the private-tracker torrents of torrent rows through Prowlarr and gives each row the real info hash
 * and file list, so ownership, deduplication and file selection work as for any public torrent.
 */
async function resolvePrivateTorrentRows(
  context: Pick<PlanContext, 'config' | 'blocks' | 'privateTorrents'>,
  rows: ResolvedRow[],
): Promise<void> {
  const { config, blocks } = context
  if (!privateSearchSettings(config)) return
  await Promise.all(
    rows.map(async row => {
      const sources = row.source.private_sources || []
      if (row.protocol !== 'torrent' || blocks.has(row) || torrentHashes(row.source).length || !sources.length) return
      const search = row.search
      const found = await Promise.all(sources.map(source => resolvePrivateTorrent(config, source, search)))
      const miss = found.find(lookup => lookup.kind !== 'match')
      if (miss?.kind === 'failed') return blocks.add(row, 'private_lookup_failed', `(${miss.message})`)
      if (miss?.kind === 'no_match' || miss?.kind === 'unconfigured')
        return blocks.add(row, 'private_no_match', miss.reason)
      const hashes: string[] = []
      found.forEach((lookup, index) => {
        if (lookup.kind !== 'match') return
        hashes.push(lookup.hash)
        context.privateTorrents.set(lookup.hash, { file: lookup.torrent, sourceId: sources[index].id })
      })
      row.source = {
        ...row.source,
        info_hashes: hashes,
        // SeaDex's file names, now under the real hash: the checked torrent holds exactly these files.
        torrent_files: hashes.map((hash, index) => ({ hash, files: sources[index].files })),
      }
    }),
  )
}

interface UsenetRowPlan {
  available: UsenetHashAvailability[]
  /** `detail` as `BlockedRows.add` takes it: appended to the code's copy, or replacing it. */
  blocked?: { code: PreflightBlocked['code']; detail?: string | { reason: string } }
}

/**
 * The Usenet copy of one source that Prowlarr is searched for by its file list.
 *
 * - A candidate the user chose is taken as it was checked, whatever its proof; nothing is searched for the row.
 * - A single review searches the source if no fresh result is stored and checks its best candidates.
 * - A bulk review and an acceptance read what is stored, so they never cost a search or an NZB fetch.
 */
async function fileListCopy(
  context: PlanContext,
  row: ResolvedRow,
  source: PrivateSource,
): Promise<UsenetHashAvailability> {
  const { config } = context
  const chosen = row.nzb ? chosenSearchCandidate(config, source.id, row.nzb) : undefined
  if (chosen) return chosen
  if (context.resolve === 'search' && !row.nzb)
    return (await resolveSource(config, source, row.search, { limit: REVIEW_FETCHES })).availability
  return searchSnapshot(config, source.id).availability
}

/** Whether one of the copies is the candidate the row names. A row that names none always passes. */
const hasChosenNzb = (row: ResolvedRow, copies: UsenetHashAvailability[]): boolean =>
  !row.nzb || copies.some(copy => copy.state === 'available' && copy.entry_id === row.nzb)

const CHOSEN_NZB_BLOCK: UsenetRowPlan = {
  available: [],
  blocked: { code: 'not_searched', detail: { reason: CHOSEN_NZB_COPY } },
}

/** A Usenet copy of a private-tracker release: every source still missing needs a proven or chosen NZB. */
async function resolvePrivateUsenetRow(
  context: PlanContext,
  row: ResolvedRow,
  missing: string[],
): Promise<UsenetRowPlan> {
  const sources = privateUsenetSources(context.config, row.source).filter(source => missing.includes(source.id))
  const copies = await Promise.all(sources.map(source => fileListCopy(context, row, source)))
  if (!hasChosenNzb(row, copies)) return CHOSEN_NZB_BLOCK
  const miss = copies.find(copy => copy.state !== 'available')
  if (!miss) return { available: copies }
  // The detail is what the search or the check last said: no candidate, a daily limit, an indexer that failed.
  return { available: [], blocked: { code: FILE_LIST_BLOCK[miss.state] ?? 'no_match', detail: miss.error } }
}

/** Looks up the sources of one row that no acquisition covers yet. */
async function resolveUsenetRow(
  context: PlanContext,
  row: ResolvedRow,
  missingHashes: string[],
  refresh: boolean | undefined,
): Promise<UsenetRowPlan> {
  const { config } = context
  const found = await resolveUsenetRelease(config, { ...row.source, info_hashes: missingHashes }, refresh)
  if (found.aggregate === 'available') return { available: found.hashes.filter(hash => hash.state === 'available') }
  // Only a hash every hash indexer answered "no NZB" for may have a copy found through Prowlarr instead.
  let searchable = false
  const hashes = await Promise.all(
    found.hashes.map(async (state): Promise<UsenetHashAvailability> => {
      if (state.state !== 'no_match') return state
      const source = prowlarrFallbackSource(config, row.source, state.hash)
      if (!source) return state
      searchable = true
      const copy = await fileListCopy(context, row, source)
      // Prowlarr has no Usenet indexer to ask: what the hash indexers said stands.
      if (copy.state === 'not_configured') return state
      if (copy.state !== 'not_checked') return copy
      return {
        ...state,
        error: 'Search Prowlarr for this release in its details to look beyond the hash indexers.',
      }
    }),
  )
  if (searchable && !hasChosenNzb(row, hashes)) return CHOSEN_NZB_BLOCK
  const aggregate = aggregateHashStates(hashes.map(hash => hash.state))
  if (aggregate === 'available') return { available: hashes.filter(hash => hash.state === 'available') }
  const absent = hashes.find(hash => hash.state === 'no_match' && hash.error)
  if (aggregate === 'no_match' && absent) return { available: [], blocked: { code: 'no_match', detail: absent.error } }
  const unchecked = hashes.find(hash => hash.state === 'unverified')
  if (aggregate === 'unverified') return { available: [], blocked: { code: 'not_verified', detail: unchecked?.error } }
  const failed = hashes.find(hash => hash.state === 'lookup_failed')
  const unresolved = failed?.providers_failed?.length ? ` (${failed.providers_failed.join(', ')} unresolved)` : ''
  return {
    available: [],
    blocked: {
      code: USENET_BLOCK[aggregate] ?? 'lookup_failed',
      detail: failed ? `${failed.error || 'provider unavailable'}${unresolved}` : undefined,
    },
  }
}

/** An NZB always carries its whole source, so a row scoped to some files may need the user's acknowledgement. */
async function planUsenetUnits(context: PlanContext, rows: ResolvedRow[], refresh: boolean | undefined): Promise<void> {
  const { config, blocks, units, clients } = context
  // Lookups run concurrently per row; provider-level concurrency and caching live in the resolver.
  const lookups = new Map<string, Promise<UsenetRowPlan>>()
  for (const row of rows) {
    if (blocks.has(row)) continue
    const required = usenetSourceIds(config, row.source)
    if (!required.length) {
      const detail = row.source.private_sources?.length
        ? 'Private-tracker releases are found on Usenet through Prowlarr; set it up under Configuration.'
        : undefined
      lookups.set(rowKey(row), Promise.resolve({ available: [], blocked: { code: 'no_match', detail } }))
      continue
    }
    const unresolved = required.map(hash => context.ownership(hash)).filter(owner => owner.unresolved)
    if (unresolved.length) {
      blocks.add(row, unresolvedCode(unresolved.every(owner => owner.unreachable)))
      continue
    }
    const missing = required.filter(hash => !context.ownership(hash).record)
    const privateRow = !torrentHashes(row.source).length
    lookups.set(
      rowKey(row),
      !missing.length
        ? Promise.resolve({ available: [] })
        : privateRow
          ? resolvePrivateUsenetRow(context, row, missing)
          : resolveUsenetRow(context, row, missing, refresh),
    )
  }
  for (const row of rows) {
    const lookup = lookups.get(rowKey(row))
    if (!lookup || blocks.has(row)) continue
    const plan = await lookup
    if (plan.blocked) {
      blocks.add(row, plan.blocked.code, plan.blocked.detail)
      continue
    }
    const requested = (row.source.selected_files || []).map(normalizeTorrentPath)
    const unitFor = (hash: string) => ({
      unit_id: `usenet:${hash}:${row.category}`,
      protocol: 'usenet' as const,
      client: 'sabnzbd' as const,
      source_hash: hash,
      category: row.category,
      labels: [row.label],
      selections: [{ key: row.key, release: row.release }],
      requestedPaths: requested,
    })
    for (const hash of usenetSourceIds(config, row.source)) {
      const existing = context.ownership(hash).record
      if (!existing) continue
      units.add({
        ...unitFor(hash),
        status: 'existing',
        ...existingFields(existing, clients.usenet),
        whole_source: existing.protocol === 'usenet' || !existing.scope?.length,
        scope_expanded: false,
        size_bytes: 0,
        approximate: false,
        scope_unknown: false,
        requiresAck: false,
      })
    }
    for (const availability of plan.available) {
      const { record: existing, unresolved, unreachable } = context.ownership(availability.hash)
      if (unresolved) {
        blocks.add(row, unresolvedCode(unreachable))
        continue
      }
      const filesKnown = availability.files_known === true
      const extraFiles = filesKnown
        ? (availability.file_names || []).filter(name => !requested.includes(normalizeTorrentPath(name)))
        : []
      const scopeExpanded = requested.length > 0 && (!filesKnown || extraFiles.length > 0)
      const scopeUnknown = requested.length > 0 && !filesKnown
      // The file list a copy found through Prowlarr was checked against.
      const listed =
        availability.provider === 'prowlarr'
          ? (privateUsenetSources(config, row.source).find(source => source.id === availability.hash) ??
            prowlarrFallbackSource(config, row.source, availability.hash))
          : null
      units.add({
        ...unitFor(availability.hash),
        status: existing ? 'existing' : 'new',
        ...existingFields(existing, clients.usenet),
        whole_source: true,
        scope_expanded: scopeExpanded,
        size_bytes: availability.total_bytes ?? null,
        // Provider totals are encoded payload sizes; PAR2 and unpacking need more, so treat as a lower bound.
        approximate: true,
        scope_unknown: scopeUnknown || (!existing && availability.total_bytes === undefined),
        ...(extraFiles.length
          ? { known_extra_files: extraFiles.slice(0, EXTRA_FILE_LIMIT), extra_file_count: extraFiles.length }
          : {}),
        ...(availability.provider ? { provider: availability.provider } : {}),
        ...(availability.proof ? { proof: availability.proof } : {}),
        entryId: availability.entry_id,
        ...(listed ? { sourceFiles: listed.files } : {}),
        ...(availability.title ? { nzb_name: `${availability.title}.nzb` } : {}),
        requiresAck: scopeExpanded || scopeUnknown,
      })
    }
  }
}

/** A source asked for through both protocols in one review is sent through neither: the user has to choose. */
function blockContestedSources(units: PlannedUnits, blocks: BlockedRows): void {
  const protocolsByHash = new Map<string, Set<DownloadProtocol>>()
  const sourceOf = (unit: SubmissionUnit) => unit.sourceAlias ?? unit.source_hash
  for (const unit of units.all()) {
    if (unit.status === 'new')
      protocolsByHash.set(sourceOf(unit), (protocolsByHash.get(sourceOf(unit)) || new Set()).add(unit.protocol))
  }
  const contested = (unit: SubmissionUnit) =>
    unit.status === 'new' && (protocolsByHash.get(sourceOf(unit))?.size || 0) > 1
  for (const unit of units.remove(contested)) {
    for (const selection of unit.selections)
      blocks.add(selection, 'conflict', `(${unit.source_hash.slice(0, 12)}… via ${unit.protocol})`)
  }
}

async function collectDiskChecks(
  clients: Record<DownloadProtocol, DownloadClientAdapter>,
  newUnits: SubmissionUnit[],
): Promise<DiskSpaceCheck[]> {
  const checks: DiskSpaceCheck[] = []
  for (const client of Object.values(clients)) {
    const units = newUnits.filter(unit => unit.protocol === client.protocol)
    if (units.length) checks.push(...(await client.diskChecks(units)))
  }
  return checks
}

/**
 * Protocol-aware planning. Validates selections against the live results and saved mode,
 * resolves Usenet availability without enqueueing, and deduplicates actual client units per
 * source hash. Nothing is stored or sent: a review and an acceptance both start here.
 *
 * `resolve` says what a Usenet copy found through Prowlarr may cost. With `stored`, the default, only stored
 * results are read: no search and no NZB fetch. `search` is for a single review, which searches a source
 * without a fresh result and checks its candidates.
 */
export async function planDownloads(
  config: Config,
  selections: DownloadSelection[],
  options: { results: ResultItem[]; refresh?: boolean; resolve?: ResolveMode },
): Promise<PlannedDownloads> {
  const blocks = new BlockedRows()
  const rows = resolveRows(config, selections, options.results, blocks)
  const privateTorrents: PlanContext['privateTorrents'] = new Map()
  await resolvePrivateTorrentRows({ config, blocks, privateTorrents }, rows)
  const rowSources = (row: ResolvedRow) =>
    row.protocol === 'torrent' ? torrentHashes(row.source) : usenetSourceIds(config, row.source)

  const selectedHashes = new Set(rows.flatMap(rowSources))
  const records = downloadRecords().filter(record => selectedHashes.has(record.source_hash))
  const unconfirmed = new Set(
    records
      .filter(record => record.state === 'acceptance_unknown' || !record.native_id)
      .map(record => record.source_hash),
  )
  for (const row of rows) if (rowSources(row).some(hash => unconfirmed.has(hash))) blocks.add(row, 'acceptance_unknown')
  const sendable = (protocol: DownloadProtocol) => rows.filter(row => row.protocol === protocol && !blocks.has(row))
  const torrentRows = sendable('torrent')

  const clients = downloadClients(config)
  const presence: Record<DownloadProtocol, ClientPresence> = {
    torrent:
      torrentRows.length || records.some(record => record.protocol === 'torrent')
        ? await clients.torrent.presence(records)
        : { ids: new Set(), complete: false },
    usenet: await clients.usenet.presence(records),
  }
  const ownership = (hash: string): Ownership => {
    const owned = records.filter(record => record.source_hash === hash)
    if (owned.some(record => record.state === 'acceptance_unknown' || !record.native_id)) return { unresolved: true }
    const elsewhere = owned.find(record => !record.endpoint || record.endpoint !== clients[record.protocol].endpointId)
    if (elsewhere) return { record: elsewhere }
    if (owned.some(record => !presence[record.protocol].complete)) return { unresolved: true, unreachable: true }
    return { record: owned.find(record => presence[record.protocol].ids.has(record.native_id)) }
  }

  // A client files a download with an unknown category under its default one, where Sonarr and Radarr never import it.
  for (const client of Object.values(clients)) {
    const clientRows = sendable(client.protocol)
    const unknown = clientRows.length ? await client.unknownCategories?.(clientRows.map(row => row.category)) : null
    for (const row of clientRows)
      if (unknown?.includes(row.category.trim())) blocks.add(row, 'category_missing', `(category: ${row.category})`)
  }

  const units = new PlannedUnits()
  const context: PlanContext = {
    config,
    clients,
    presence,
    blocks,
    units,
    ownership,
    privateTorrents,
    resolve: options.resolve ?? 'stored',
  }
  // Torrent units are listed before Usenet units.
  if (torrentRows.length) planTorrentUnits(context, torrentRows)
  await planUsenetUnits(
    context,
    rows.filter(row => row.protocol === 'usenet'),
    options.refresh,
  )
  blockContestedSources(units, blocks)
  for (const unit of units.all()) unit.selections = unit.selections.filter(selection => !blocks.has(selection))
  units.remove(unit => !unit.selections.length)

  const all = units.all()
  const newUnits = all.filter(unit => unit.status === 'new')
  const disk_space = await collectDiskChecks(clients, newUnits)
  return {
    units: all,
    selections: rows.map(row => ({
      key: row.key,
      release: row.release,
      identity: row.identity,
      protocol: row.protocol,
      ...(row.nzb ? { nzb: row.nzb } : {}),
    })),
    review: {
      ok: true,
      mode: config.download_mode,
      selection_count: selections.length,
      units: all.map(
        ({
          requestedPaths: _requestedPaths,
          requiresAck: _requiresAck,
          entryId: _entryId,
          torrentFile: _torrentFile,
          sourceAlias: _sourceAlias,
          sourceFiles: _sourceFiles,
          ...unit
        }) => unit,
      ),
      new_torrents: newUnits.filter(unit => unit.protocol === 'torrent').length,
      new_nzbs: newUnits.filter(unit => unit.protocol === 'usenet').length,
      existing_units: all.length - newUnits.length,
      blocked: blocks.entries,
      requires_whole_ack: newUnits.some(unit => unit.requiresAck),
      requires_space_ack: disk_space.some(check => check.sufficient !== true),
      total_new_bytes: newUnits.reduce((sum, unit) => sum + (unit.size_bytes || 0), 0),
      unknown_bytes: newUnits.filter(unit => unit.size_bytes === null).length,
      approximate_bytes: newUnits.some(unit => unit.approximate),
      disk_space,
    },
  }
}

/**
 * Plans a review and pins its resolved selections into an expiring server-side plan the browser confirms by ID.
 * A review of one release may search Prowlarr and check NZBs for it; a bulk review reads what is stored.
 */
export async function buildDownloadPlan(
  config: Config,
  selections: DownloadSelection[],
  options: { results: ResultItem[]; refresh?: boolean },
): Promise<{ review: DownloadPreflight; plan: StoredPlan }> {
  const resolve: ResolveMode = selections.length === 1 ? 'search' : 'stored'
  const planned = await planDownloads(config, selections, { ...options, resolve })
  const plan = putPlan({
    config_generation: currentGeneration(),
    selections: planned.selections,
    requires_whole_ack: planned.review.requires_whole_ack,
    requires_space_ack: planned.review.requires_space_ack,
  })
  return {
    plan,
    review: {
      ...planned.review,
      plan_id: plan.id,
      expires_in: Math.max(0, Math.floor((plan.expires_at - Date.now()) / 1000)),
    },
  }
}
