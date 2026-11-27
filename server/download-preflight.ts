import { releaseIdentity } from '../shared/releases.js'
import { isSeasonUpgradable, releaseOffered, releaseOwned } from '../shared/download-plan.js'
import { rowKey, seasonTag } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import {
  modeAllowsProtocol,
  type DiskSpaceCheck,
  type DownloadMode,
  type DownloadPreflight,
  type DownloadProtocol,
  type DownloadSelection,
  type DownloadSelectionRef,
  type PreflightBlocked,
} from '../shared/download-contracts.js'
import type { Config, Release, ResultItem } from './types.js'
import { downloadCategory } from './config.js'
import { currentGeneration } from './config-generation.js'
import { putPlan, type StoredPlan, type StoredPlanSelection } from './download-plans.js'
import { downloadRecords } from './download-store.js'
import type {
  ClientPresence,
  DownloadClients,
  PlanIntent,
  RowBlocks,
  SourceOwnership,
  SubmissionUnit,
  UnitPlan,
  UnitRow,
} from './download-client-types.js'
import { HttpError } from './http-error.js'
import { sabnzbdConfigured, usenetConfigured } from './usenet.js'
import { searchContext } from './private-sources.js'

/** What a review resolves to before it is shown or sent: the public summary, the units behind it, and the rows that survive. */
export interface PlannedDownloads {
  review: Omit<DownloadPreflight, 'plan_id' | 'expires_in'>
  units: SubmissionUnit[]
  selections: StoredPlanSelection[]
}

export type { PlanIntent } from './download-client-types.js'

/** Why a release the user's preferences exclude is blocked; it keeps the `invalid` code. */
const EXCLUDED_RELEASE_COPY = 'Your release preferences exclude this release.'

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

/** Rows that cannot be sent, in the order they were ruled out. A row keeps the first reason found for it. */
class BlockedRows implements RowBlocks {
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
interface ResolvedRow extends UnitRow {
  identity: string
  protocol: DownloadProtocol
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
  const only = modeAllowsProtocol(mode, 'torrent') ? 'torrent' : 'usenet'
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
      result,
      category: downloadCategory(config, result, protocol),
      label: selectionLabel(result, release),
      search: searchContext(result, release),
      ...(selection.nzb ? { nzb: selection.nzb } : {}),
    })
  }
  return rows
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

async function collectDiskChecks(clients: DownloadClients, newUnits: SubmissionUnit[]): Promise<DiskSpaceCheck[]> {
  const checks: DiskSpaceCheck[] = []
  for (const client of Object.values(clients)) {
    const units = newUnits.filter(unit => unit.protocol === client.protocol)
    if (units.length) checks.push(...(await client.diskChecks(units)))
  }
  return checks
}

/**
 * Validates selections against the live results and saved mode, has each client plan the units of its rows, and
 * settles ownership, contested sources and disk space across them. Nothing is stored or sent: a review and an
 * acceptance both start here.
 *
 * `intent` says what a Usenet copy may cost (see `CopyIntent`). An `acceptance`, the default, and a
 * `bulk_review` only read stored Prowlarr results: no search and no NZB fetch. A `single_review` searches a
 * source without a fresh result and checks its candidates.
 */
export async function planDownloads(
  config: Config,
  selections: DownloadSelection[],
  options: { results: ResultItem[]; clients: DownloadClients; refresh?: boolean; intent?: PlanIntent },
): Promise<PlannedDownloads> {
  const blocks = new BlockedRows()
  const rows = resolveRows(config, selections, options.results, blocks)
  const { clients } = options
  const review = { blocks, intent: options.intent ?? 'acceptance', ...(options.refresh ? { refresh: true } : {}) }
  // Each client plans its own rows; torrents come first, so their units are listed before Usenet units.
  const adapters = Object.values(clients)
  const plans = new Map<DownloadProtocol, UnitPlan>()
  for (const client of adapters)
    plans.set(
      client.protocol,
      await client.planUnits(
        rows.filter(row => row.protocol === client.protocol),
        review,
      ),
    )
  const rowSources = (row: ResolvedRow) => plans.get(row.protocol)?.sources(row) ?? []

  const selectedHashes = new Set(rows.flatMap(rowSources))
  const records = downloadRecords().filter(record => selectedHashes.has(record.source_hash))
  const unconfirmed = new Set(
    records
      .filter(record => record.state === 'acceptance_unknown' || !record.native_id)
      .map(record => record.source_hash),
  )
  for (const row of rows) if (rowSources(row).some(hash => unconfirmed.has(hash))) blocks.add(row, 'acceptance_unknown')
  const sendable = (protocol: DownloadProtocol) => rows.filter(row => row.protocol === protocol && !blocks.has(row))

  const presence = new Map<DownloadProtocol, ClientPresence>()
  for (const client of adapters)
    presence.set(
      client.protocol,
      sendable(client.protocol).length || records.some(record => record.protocol === client.protocol)
        ? await client.presence(records)
        : { ids: new Set(), complete: false },
    )
  const presenceOf = (protocol: DownloadProtocol) => presence.get(protocol) ?? { ids: new Set(), complete: false }
  const ownership = (hash: string): SourceOwnership => {
    const owned = records.filter(record => record.source_hash === hash)
    if (owned.some(record => record.state === 'acceptance_unknown' || !record.native_id)) return { unresolved: true }
    const elsewhere = owned.find(record => !record.endpoint || record.endpoint !== clients[record.protocol].endpointId)
    if (elsewhere) return { record: elsewhere }
    if (owned.some(record => !presenceOf(record.protocol).complete)) return { unresolved: true, unreachable: true }
    return { record: owned.find(record => presenceOf(record.protocol).ids.has(record.native_id)) }
  }

  // A client files a download with an unknown category under its default one, where Sonarr and Radarr never import it.
  for (const client of adapters) {
    const clientRows = sendable(client.protocol)
    const unknown = clientRows.length ? await client.unknownCategories?.(clientRows.map(row => row.category)) : null
    for (const row of clientRows)
      if (unknown?.includes(row.category.trim())) blocks.add(row, 'category_missing', `(category: ${row.category})`)
  }

  const units = new PlannedUnits()
  for (const client of adapters) {
    const plan = plans.get(client.protocol)
    if (!plan) continue
    for (const unit of await plan.units({ presence: presenceOf(client.protocol), ownership })) units.add(unit)
  }
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
      units: all.map(({ requiresAck: _requiresAck, sourceAlias: _sourceAlias, send: _send, ...unit }) => unit),
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
  options: { results: ResultItem[]; clients: DownloadClients; refresh?: boolean },
): Promise<{ review: DownloadPreflight; plan: StoredPlan }> {
  const intent: PlanIntent = selections.length === 1 ? 'single_review' : 'bulk_review'
  const planned = await planDownloads(config, selections, { ...options, intent })
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
