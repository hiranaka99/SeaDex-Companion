import { releaseIdentity } from '../shared/releases.js'
import { estimateDownloads } from '../shared/download-estimate.js'
import { isSeasonUpgradable, normalizeTorrentPath, planTorrents, releaseOwned, torrentHashes } from '../shared/download-plan.js'
import type { RecommendationSeason } from '../shared/download-plan.js'
import type { DiskSpaceCheck, DownloadPreflight, DownloadProtocol, PlannedUnit, PreflightBlocked } from '../shared/download-contracts.js'
import type { PlannedTorrent } from '../shared/download-plan.js'
import type { Config, Release, ResultItem } from './types.js'
import { downloadCategory } from './config.js'
import { currentGeneration } from './config-generation.js'
import { putPlan, type StoredPlan } from './download-plans.js'
import { downloadRecords, type OwnedDownloadRecord } from './download-store.js'
import { resolveUsenetRelease, sabnzbdConfigured, usenetConfigured } from './usenet.js'
import { qbGetDownloadStorage, qbGetTorrents } from './qbittorrent.js'
import { sabDiskSpace, sabHistoryJobs, sabMissingCategories, sabQueueJobs } from './sabnzbd.js'
import { qbEndpointId, sabEndpoint } from './client-identity.js'
import { errorMessage, log } from './logging.js'
import type { UsenetHashAvailability } from '../shared/usenet-contracts.js'

export interface SelectionInput { key: string; release: number; identity?: string; protocol?: DownloadProtocol }
/** Internal unit view kept for the acceptance service; the review response is the public projection. */
export interface SubmissionUnit extends UnitDraft { entryId?: string }
export type PreflightOutcome = { review: DownloadPreflight; plan: StoredPlan; units: SubmissionUnit[] } | { error: [number, string] }

const EXTRA_FILE_LIMIT = 10
/**
 * Estimated sizes (Usenet provider totals, torrent estimates) cannot be confirmed exactly.
 * They count as fitting when free space covers twice the estimate plus a fixed margin,
 * which absorbs PAR2 repair data and unpacking archives next to their parts.
 */
const ESTIMATE_HEADROOM_FACTOR = 2
const ESTIMATE_HEADROOM_BYTES = 5 * 1024 ** 3

/** Whether `free` bytes fit `required`, given how many units are sized only approximately or not at all. */
export function spaceVerdict(free: number | null, required: number, approximateUnits: number, unsizedUnits: number): boolean | null {
  if (free === null) return null
  if (required > free) return false
  if (unsizedUnits) return null
  if (approximateUnits) return free >= required * ESTIMATE_HEADROOM_FACTOR + ESTIMATE_HEADROOM_BYTES ? true : null
  return true
}

const rowId = (key: string, release: number) => `${key}\u0000${release}`

interface ResolvedRow {
  key: string
  releaseIndex: number
  identity: string
  protocol: DownloadProtocol
  result: ResultItem
  release: Release
  category: string
  label: string
}

function selectionLabel(result: ResultItem, release: Release): string {
  const season = result.season ? ` S${String(result.season).padStart(2, '0')}` : ''
  return `${result.title || result.key}${season}${release.part ? ` · ${release.part}` : ''} [${release.releaseGroup}]`
}

export function parseSelections(raw: unknown): { selections: SelectionInput[]; error?: [number, string] } {
  if (!Array.isArray(raw) || !raw.length) return { selections: [], error: [400, 'No download selections provided'] }
  const selections: SelectionInput[] = []
  for (const item of raw) {
    const selection = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const key = typeof selection.key === 'string' ? selection.key.trim() : ''
    const release = selection.release
    if (!key) return { selections: [], error: [400, 'No key provided'] }
    if (typeof release !== 'number' || !Number.isInteger(release) || release < 0) return { selections: [], error: [400, 'Release must be a non-negative integer'] }
    if (selection.identity !== undefined && typeof selection.identity !== 'string') return { selections: [], error: [400, 'Release identity must be a string'] }
    if (selection.protocol !== undefined && selection.protocol !== 'torrent' && selection.protocol !== 'usenet') return { selections: [], error: [400, 'Protocol must be torrent or usenet'] }
    selections.push({ key, release, ...(selection.identity ? { identity: selection.identity } : {}), ...(selection.protocol ? { protocol: selection.protocol as DownloadProtocol } : {}) })
  }
  return { selections }
}

const BLOCK_COPY: Record<string, string> = {
  invalid: 'A selected release is unavailable.',
  not_upgradable: 'This season is not marked for an upgrade.',
  owned: 'This release group already owns the current episodes.',
  excluded: 'This cour is excluded from downloads.',
  protocol_required: 'Choose a protocol for this release.',
  mode_conflict: 'The saved download mode does not allow this protocol.',
  no_torrent: 'This release has no supported public torrent hash.',
  usenet_unconfigured: 'Usenet acquisition needs SABnzbd and a provider before it can be used.',
  no_match: 'Not found on Usenet indexers.',
  processing: 'Not found on Usenet indexers yet; the indexer has not finished converting this source.',
  incomplete: 'Usenet is unavailable: some source torrents have no matching NZB.',
  lookup_failed: 'Could not check Usenet availability for this release.',
  conflict: 'The same source was requested through both protocols; choose one acquisition.',
  acceptance_unknown: 'An earlier send of this release was never confirmed by the download client. Check the client; if the download is not there, stop tracking that entry to send it again.',
  client_unreachable: 'Could not reach the download client to check what was already sent. Try again once it is reachable.',
  category_missing: 'SABnzbd has no category with this name, so the download would never be imported. Create the category in SABnzbd or change it under Configuration → Downloads.',
}

interface UnitDraft extends PlannedUnit {
  requestedPaths: string[]
  requiresAck: boolean
  entryId?: string
}

interface UsenetRowPlan {
  aggregate: string
  available: UsenetHashAvailability[]
  reason?: { code: string; detail?: string }
}

/**
 * Protocol-aware preflight. Validates selections against the live catalog and saved mode,
 * resolves Usenet availability without enqueueing, deduplicates actual client units per
 * source hash, and pins the reviewed selection set into an expiring server-side plan.
 */
export async function buildDownloadPlan(
  config: Config,
  rawSelections: unknown,
  options: { results: ResultItem[]; refresh?: boolean },
): Promise<PreflightOutcome> {
  const parsed = parseSelections(rawSelections)
  if (parsed.error) return { error: parsed.error }
  const single = parsed.selections.length === 1
  const resultsByKey = new Map(options.results.map(result => [result.key, result]))
  const mode = config.download_mode
  const blocked: PreflightBlocked[] = []
  const rows: ResolvedRow[] = []
  const seenParts = new Set<string>()

  for (const selection of parsed.selections) {
    const result = resultsByKey.get(selection.key)
    const release = result?.releases?.[selection.release]
    if (!result || !release) { blocked.push({ key: selection.key, release: selection.release, code: 'invalid', reason: BLOCK_COPY.invalid }); continue }
    if (selection.identity && selection.identity !== releaseIdentity(release)) {
      return { error: [409, 'A selected release changed. Reopen the review to see the latest recommendations.'] }
    }
    const season = result as RecommendationSeason
    if (!single) {
      if (!isSeasonUpgradable(season) || season.excluded) { blocked.push({ key: selection.key, release: selection.release, code: 'not_upgradable', reason: BLOCK_COPY.not_upgradable }); continue }
      if (release.kind !== 'best') { blocked.push({ key: selection.key, release: selection.release, code: 'invalid', reason: BLOCK_COPY.invalid }); continue }
      const partKey = `${selection.key}\u0000${release.part || ''}`
      if (seenParts.has(partKey)) return { error: [400, 'Choose only one best release per season or cour'] }
      seenParts.add(partKey)
    }
    if (season.excluded_parts?.includes(release.part || '')) { blocked.push({ key: selection.key, release: selection.release, code: 'excluded', reason: BLOCK_COPY.excluded }); continue }
    if (!single && releaseOwned(season, release)) { blocked.push({ key: selection.key, release: selection.release, code: 'owned', reason: BLOCK_COPY.owned }); continue }

    const requestedProtocol = selection.protocol
    let protocol: DownloadProtocol
    if (mode === 'torrent_only') {
      if (requestedProtocol === 'usenet') { blocked.push({ key: selection.key, release: selection.release, code: 'mode_conflict', reason: BLOCK_COPY.mode_conflict }); continue }
      protocol = 'torrent'
    } else if (mode === 'usenet_only') {
      if (requestedProtocol === 'torrent') { blocked.push({ key: selection.key, release: selection.release, code: 'mode_conflict', reason: BLOCK_COPY.mode_conflict }); continue }
      protocol = 'usenet'
    } else if (requestedProtocol === 'torrent' || requestedProtocol === 'usenet') protocol = requestedProtocol
    else { blocked.push({ key: selection.key, release: selection.release, code: 'protocol_required', reason: BLOCK_COPY.protocol_required }); continue }

    if (protocol === 'usenet' && (!usenetConfigured(config) || !sabnzbdConfigured(config))) {
      blocked.push({ key: selection.key, release: selection.release, code: 'usenet_unconfigured', reason: BLOCK_COPY.usenet_unconfigured })
      continue
    }
    rows.push({
      key: selection.key, releaseIndex: selection.release, identity: releaseIdentity(release), protocol, result, release,
      category: downloadCategory(config, result.arr, protocol), label: selectionLabel(result, release),
    })
  }

  const selectedHashes = new Set(rows.flatMap(row => torrentHashes(row.release)))
  const records = downloadRecords().filter(record => selectedHashes.has(record.source_hash))
  const unknownHashes = new Set(records.filter(record => record.state === 'acceptance_unknown' || !record.native_id).map(record => record.source_hash))
  const unknownRows = new Set<string>()
  for (const row of rows) if (torrentHashes(row.release).some(hash => unknownHashes.has(hash))) {
    unknownRows.add(rowId(row.key, row.releaseIndex))
    blocked.push({ key: row.key, release: row.releaseIndex, code: 'acceptance_unknown', reason: BLOCK_COPY.acceptance_unknown })
  }

  const units = new Map<string, UnitDraft>()
  const addUnit = (draft: UnitDraft) => {
    const existing = units.get(draft.unit_id)
    if (!existing) { units.set(draft.unit_id, draft); return }
    existing.selections = [...new Map([...existing.selections, ...draft.selections].map(row => [rowId(row.key, row.release), row])).values()]
    for (const label of draft.labels) if (!existing.labels.includes(label)) existing.labels.push(label)
    existing.requiresAck ||= draft.requiresAck
  }

  // Torrent units reuse the shared per-hash deduplication and file-scope union rules.
  const torrentRows = rows.filter(row => row.protocol === 'torrent' && !unknownRows.has(rowId(row.key, row.releaseIndex)))
  const torrentBlocked = new Set<string>()
  const plannedByRow = new Map<string, PlannedTorrent[]>()
  if (torrentRows.length) {
    const withoutHash = torrentRows.filter(row => torrentHashes(row.release).length === 0)
    for (const row of withoutHash) {
      blocked.push({ key: row.key, release: row.releaseIndex, code: 'no_torrent', reason: BLOCK_COPY.no_torrent })
      torrentBlocked.add(rowId(row.key, row.releaseIndex))
    }
    const usable = torrentRows.filter(row => !torrentBlocked.has(rowId(row.key, row.releaseIndex)))
    const planned = planTorrents(usable.map(row => ({ release: row.release, category: row.category, label: row.label })))
    for (const row of usable) plannedByRow.set(rowId(row.key, row.releaseIndex), planned.filter(entry => torrentHashes(row.release).includes(entry.hash)))
  }

  let qbExisting = new Set<string>()
  let qbReadComplete = false
  if (torrentRows.length || records.some(record => record.protocol === 'torrent' && rows.some(row => torrentHashes(row.release).includes(record.source_hash)))) {
    try {
      qbExisting = new Set((await qbGetTorrents(config, undefined, true)).map(torrent => String(torrent.hash || '').toLowerCase()))
      qbReadComplete = true
    } catch (error) { log('WARNING', `qBittorrent existing-torrent check failed during preflight: ${errorMessage(error)}`) }
  }
  const sabIds = records.filter(record => record.protocol === 'usenet' && record.state === 'accepted' && record.endpoint === sabEndpoint(config).endpointId && record.native_id).map(record => record.native_id)
  const { apiUrl, endpointId } = sabEndpoint(config)
  const sabSettings = { apiUrl, apiKey: config.sabnzbd_key }
  const [sabQueue, sabHistory] = sabIds.length
    ? await Promise.all([sabQueueJobs(sabSettings, sabIds, globalThis.fetch), sabHistoryJobs(sabSettings, sabIds, globalThis.fetch)])
    : [{ jobs: [], read_complete: true }, { jobs: [], read_complete: true }]
  const sabExisting = new Set([...sabQueue.jobs, ...sabHistory.jobs].map(job => job.nzo_id))
  const ownership = (hash: string): { record?: OwnedDownloadRecord; unresolved?: boolean; unreachable?: boolean } => {
    const owned = records.filter(record => record.source_hash === hash)
    if (owned.some(record => record.state === 'acceptance_unknown' || !record.native_id)) return { unresolved: true }
    const unbound = owned.find(record => !record.endpoint || record.endpoint !== (record.protocol === 'torrent' ? qbEndpointId(config) : endpointId))
    if (unbound) return { record: unbound }
    for (const record of owned) {
      const complete = record.protocol === 'torrent' ? qbReadComplete : sabQueue.read_complete && sabHistory.read_complete
      if (!complete) return { unresolved: true, unreachable: true }
    }
    return { record: owned.find(record => record.protocol === 'torrent' ? qbExisting.has(record.native_id) : sabExisting.has(record.native_id)) }
  }
  const blockUnknown = (row: ResolvedRow, unreachable = false) => {
    if (!blocked.some(entry => entry.key === row.key && entry.release === row.releaseIndex)) {
      const code = unreachable ? 'client_unreachable' : 'acceptance_unknown'
      blocked.push({ key: row.key, release: row.releaseIndex, code, reason: BLOCK_COPY[code] })
    }
  }
  // SABnzbd files an NZB with an unknown category under its default one, where Sonarr/Radarr never import it.
  const usenetRows = rows.filter(row => row.protocol === 'usenet' && !unknownRows.has(rowId(row.key, row.releaseIndex)))
  if (usenetRows.length && apiUrl && config.sabnzbd_key) {
    const missing = await sabMissingCategories(sabSettings, usenetRows.map(row => row.category), globalThis.fetch)
    if (missing?.length) for (const row of usenetRows) if (missing.includes(row.category.trim())) {
      unknownRows.add(rowId(row.key, row.releaseIndex))
      blocked.push({ key: row.key, release: row.releaseIndex, code: 'category_missing', reason: `${BLOCK_COPY.category_missing} (category: ${row.category})` })
    }
  }
  // Usenet lookups run concurrently per row; provider-level concurrency and caching live in the resolver.
  const usenetPlans = new Map<string, Promise<UsenetRowPlan>>()
  for (const row of rows) {
    if (row.protocol !== 'usenet' || unknownRows.has(rowId(row.key, row.releaseIndex))) continue
    const requiredHashes = torrentHashes(row.release)
    if (!requiredHashes.length) {
      usenetPlans.set(rowId(row.key, row.releaseIndex), Promise.resolve({ aggregate: 'no_match', available: [], reason: { code: 'no_match' } }))
      continue
    }
    const unresolved = requiredHashes.map(hash => ownership(hash)).filter(owner => owner.unresolved)
    if (unresolved.length) {
      unknownRows.add(rowId(row.key, row.releaseIndex))
      blockUnknown(row, unresolved.every(owner => owner.unreachable))
      continue
    }
    const missingHashes = requiredHashes.filter(hash => !ownership(hash).record)
    if (!missingHashes.length) {
      usenetPlans.set(rowId(row.key, row.releaseIndex), Promise.resolve({ aggregate: 'available', available: [] }))
      continue
    }
    usenetPlans.set(rowId(row.key, row.releaseIndex), resolveUsenetRelease(config, { ...row.release, info_hashes: missingHashes }, options.refresh).then(({ hashes, aggregate }) => {
      const available = hashes.filter(hash => hash.state === 'available')
      if (aggregate === 'available') return { aggregate, available }
      const failedHash = hashes.find(hash => hash.state === 'lookup_failed')
      const code = aggregate === 'not_configured' ? 'usenet_unconfigured' : aggregate
      return {
        aggregate,
        available: [],
        reason: { code: code in BLOCK_COPY ? code : 'lookup_failed', detail: failedHash ? `${failedHash.error || 'provider unavailable'}${failedHash.providers_failed?.length ? ` (${failedHash.providers_failed.join(', ')} unresolved)` : ''}` : undefined },
      }
    }))
  }
  const estimate = torrentRows.length
    ? estimateDownloads(torrentRows.filter(row => torrentHashes(row.release).length).map(row => ({ release: row.release, category: row.category })), [...qbExisting])
    : undefined
  const bytesByHash = new Map((estimate?.torrents || []).map(entry => [entry.hash, entry]))

  for (const row of torrentRows) {
    const id = rowId(row.key, row.releaseIndex)
    if (torrentBlocked.has(id)) continue
    const rowPlan = plannedByRow.get(id) || []
    if (!rowPlan.length) { blocked.push({ key: row.key, release: row.releaseIndex, code: 'no_torrent', reason: BLOCK_COPY.no_torrent }); continue }
    for (const entry of rowPlan) {
      const { record: owned, unresolved, unreachable } = ownership(entry.hash)
      if (unresolved) { blockUnknown(row, unreachable); continue }
      const clientHas = qbExisting.has(entry.hash)
      const estimateEntry = bytesByHash.get(entry.hash)
      const unit: UnitDraft = {
        unit_id: `torrent:${entry.hash}:${entry.category}`, protocol: 'torrent', client: 'qbittorrent',
        source_hash: entry.hash, category: entry.category,
        status: owned || clientHas ? 'existing' : 'new',
        ...(owned ? { existing_record_id: owned.id, existing_native_id: owned.native_id, existing_unbound: owned.protocol !== 'torrent' || owned.endpoint !== qbEndpointId(config) } : {}),
        whole_source: !entry.selectedFiles, scope_expanded: false,
        size_bytes: estimateEntry?.existing ? 0 : estimateEntry?.bytes ?? null,
        approximate: estimateEntry?.approximate ?? true,
        scope_unknown: estimateEntry?.bytes === null && !estimateEntry?.existing,
        labels: [row.label], selections: [{ key: row.key, release: row.releaseIndex }],
        requestedPaths: entry.selectedFiles || [], requiresAck: false,
      }
      addUnit(unit)
    }
  }

  for (const row of rows) {
    if (row.protocol !== 'usenet' || unknownRows.has(rowId(row.key, row.releaseIndex))) continue
    const plan = await usenetPlans.get(rowId(row.key, row.releaseIndex))!
    if (plan.reason) {
      blocked.push({ key: row.key, release: row.releaseIndex, code: plan.reason.code as PreflightBlocked['code'], reason: plan.reason.detail ? `${BLOCK_COPY[plan.reason.code]} ${plan.reason.detail}` : BLOCK_COPY[plan.reason.code] })
      continue
    }
    const requested = (row.release.selected_files || []).map(normalizeTorrentPath)
    for (const hash of torrentHashes(row.release)) {
      const existing = ownership(hash).record
      if (!existing) continue
      addUnit({
        unit_id: `usenet:${hash}:${row.category}`, protocol: 'usenet', client: 'sabnzbd', source_hash: hash, category: row.category,
        status: 'existing', existing_record_id: existing.id, existing_native_id: existing.native_id,
        existing_unbound: existing.protocol !== 'usenet' || existing.endpoint !== endpointId,
        whole_source: existing.protocol === 'usenet' || !existing.scope?.length, scope_expanded: false,
        size_bytes: 0, approximate: false, scope_unknown: false,
        labels: [row.label], selections: [{ key: row.key, release: row.releaseIndex }], requestedPaths: requested, requiresAck: false,
      })
    }
    for (const availability of plan.available) {
      const hash = availability.hash
      const filesKnown = availability.files_known === true
      const manifestNames = availability.file_names || []
      const extraFiles = filesKnown ? manifestNames.filter(name => !requested.includes(normalizeTorrentPath(name))) : []
      const scopeExpanded = requested.length > 0 && (filesKnown ? extraFiles.length > 0 : true)
      const scopeUnknown = requested.length > 0 && !filesKnown
      const { record: existing, unresolved, unreachable } = ownership(hash)
      if (unresolved) { blockUnknown(row, unreachable); continue }
      const unit: UnitDraft = {
        unit_id: `usenet:${hash}:${row.category}`, protocol: 'usenet', client: 'sabnzbd',
        source_hash: hash, category: row.category,
        status: existing ? 'existing' : 'new',
        ...(existing ? { existing_record_id: existing.id, existing_native_id: existing.native_id, existing_unbound: existing.protocol !== 'usenet' || existing.endpoint !== endpointId } : {}),
        whole_source: true, scope_expanded: scopeExpanded,
        size_bytes: availability.total_bytes ?? null,
        // Provider totals are encoded payload sizes; PAR2 and unpacking need more, so treat as a lower bound.
        approximate: true,
        scope_unknown: scopeUnknown || (!existing && availability.total_bytes === undefined),
        ...(extraFiles.length ? { known_extra_files: extraFiles.slice(0, EXTRA_FILE_LIMIT), extra_file_count: extraFiles.length } : {}),
        ...(availability.provider ? { provider: availability.provider } : {}),
        entryId: availability.entry_id,
        ...(availability.title ? { nzb_name: `${availability.title}.nzb` } : {}),
        labels: [row.label], selections: [{ key: row.key, release: row.releaseIndex }],
        requestedPaths: requested, requiresAck: scopeExpanded || scopeUnknown,
      }
      addUnit(unit)
    }
  }

  // Cross-protocol overlap on the same actual source requires an explicit single choice.
  const protocolsByHash = new Map<string, Set<DownloadProtocol>>()
  for (const unit of units.values()) if (unit.status === 'new') {
    protocolsByHash.set(unit.source_hash, (protocolsByHash.get(unit.source_hash) || new Set()).add(unit.protocol))
  }
  const contested = new Set([...protocolsByHash].filter(([, protocols]) => protocols.size > 1).map(([hash]) => hash))
  if (contested.size) {
    for (const [unitId, unit] of [...units]) if (unit.status === 'new' && contested.has(unit.source_hash)) {
      units.delete(unitId)
      for (const selection of unit.selections) {
        if (!blocked.some(entry => entry.key === selection.key && entry.release === selection.release)) {
          blocked.push({ key: selection.key, release: selection.release, code: 'conflict', reason: `${BLOCK_COPY.conflict} (${unit.source_hash.slice(0, 12)}… via ${unit.protocol})` })
        }
      }
    }
  }
  const blockedRows = new Set(blocked.map(selection => rowId(selection.key, selection.release)))
  for (const [id, unit] of units) {
    unit.selections = unit.selections.filter(selection => !blockedRows.has(rowId(selection.key, selection.release)))
    if (!unit.selections.length) units.delete(id)
  }

  const newUnits = [...units.values()].filter(unit => unit.status === 'new')
  const disk_space = await collectDiskChecks(config, newUnits)
  const requires_whole_ack = newUnits.some(unit => unit.requiresAck)
  const requires_space_ack = disk_space.some(check => check.sufficient !== true)
  const review: DownloadPreflight = {
    ok: true,
    plan_id: '',
    expires_in: 0,
    mode,
    selection_count: parsed.selections.length,
    units: [...units.values()].map(({ requestedPaths: _requestedPaths, requiresAck: _requiresAck, ...unit }) => unit),
    new_torrents: newUnits.filter(unit => unit.protocol === 'torrent').length,
    new_nzbs: newUnits.filter(unit => unit.protocol === 'usenet').length,
    existing_units: units.size - newUnits.length,
    blocked,
    requires_whole_ack,
    requires_space_ack,
    total_new_bytes: newUnits.reduce((sum, unit) => sum + (unit.size_bytes || 0), 0),
    unknown_bytes: newUnits.filter(unit => unit.size_bytes === null).length,
    approximate_bytes: newUnits.some(unit => unit.approximate),
    disk_space,
  }

  const plan = putPlan({
    config_generation: currentGeneration(),
    selections: rows.map(row => ({ key: row.key, release: row.releaseIndex, identity: row.identity, protocol: row.protocol })),
    requires_whole_ack,
    requires_space_ack,
  })
  review.plan_id = plan.id
  review.expires_in = Math.max(0, Math.floor((plan.expires_at - Date.now()) / 1000))
  const submitted = new Map([...units.values()].map(unit => [unit.unit_id, unit]))
  return { review, plan, units: review.units.map(unit => submitted.get(unit.unit_id)!).filter(Boolean) }
}

async function collectDiskChecks(config: Config, newUnits: UnitDraft[]): Promise<DiskSpaceCheck[]> {
  const checks: DiskSpaceCheck[] = []
  const torrentUnits = newUnits.filter(unit => unit.protocol === 'torrent')
  if (torrentUnits.length) {
    const categories = [...new Set(torrentUnits.map(unit => unit.category))]
    const locations = await qbGetDownloadStorage(config, categories)
    const grouped = new Map<string, DiskSpaceCheck>()
    const unsizedByCheck = new Map<DiskSpaceCheck, number>()
    for (const location of locations) {
      const key = location.path || `unknown:${location.category}`
      const check = grouped.get(key) || { client: 'qbittorrent' as const, path: location.path, categories: [], required_bytes: 0, unknown_units: 0, free_bytes: location.free_bytes, sufficient: null as boolean | null, ...(location.reason ? { reason: location.reason } : {}) }
      if (!check.categories.includes(location.category)) {
        check.categories.push(location.category)
        const scoped = torrentUnits.filter(unit => unit.category === location.category)
        check.required_bytes += scoped.reduce((sum, unit) => sum + (unit.size_bytes || 0), 0)
        check.unknown_units += scoped.filter(unit => unit.size_bytes === null || unit.approximate).length
        unsizedByCheck.set(check, (unsizedByCheck.get(check) || 0) + scoped.filter(unit => unit.size_bytes === null).length)
      }
      grouped.set(key, check)
    }
    for (const check of grouped.values()) {
      const unsized = unsizedByCheck.get(check) || 0
      check.sufficient = spaceVerdict(check.free_bytes, check.required_bytes, check.unknown_units - unsized, unsized)
      checks.push(check)
    }
  }
  const usenetUnits = newUnits.filter(unit => unit.protocol === 'usenet')
  if (usenetUnits.length) {
    const categories = [...new Set(usenetUnits.map(unit => unit.category))]
    const required = usenetUnits.reduce((sum, unit) => sum + (unit.size_bytes || 0), 0)
    const unknownUnits = usenetUnits.filter(unit => unit.size_bytes === null || unit.approximate).length
    const unsizedUnits = usenetUnits.filter(unit => unit.size_bytes === null).length
    const { apiUrl } = sabEndpoint(config)
    let incomplete: number | null = null
    let complete: number | null = null
    let reason: string | undefined
    try {
      if (!apiUrl || !config.sabnzbd_key) throw new Error('SABnzbd is not configured')
      const disk = await sabDiskSpace({ apiUrl, apiKey: config.sabnzbd_key }, globalThis.fetch)
      incomplete = disk.incomplete_free_bytes
      complete = disk.complete_free_bytes
      if (incomplete === null && complete === null) reason = 'SABnzbd did not report free space for its folders.'
    } catch (error) { reason = `Could not read SABnzbd storage information: ${errorMessage(error).slice(0, 120)}` }
    const folders: [string, number | null][] = [['SABnzbd incomplete folder', incomplete], ['SABnzbd completed folder', complete]]
    for (const [label, free] of folders) {
      checks.push({
        client: 'sabnzbd', path: null, label, categories,
        required_bytes: required, unknown_units: unknownUnits, free_bytes: free,
        sufficient: spaceVerdict(free, required, unknownUnits - unsizedUnits, unsizedUnits),
        reason: reason || 'Category folders on other disks are not checked.',
      })
    }
  }
  return checks
}
