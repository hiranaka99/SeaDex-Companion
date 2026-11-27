import { normalizeTorrentPath } from '../shared/download-plan.js'
import { rowKey } from '../shared/ids.js'
import type { PreflightBlocked } from '../shared/download-contracts.js'
import type { UsenetHashAvailability, UsenetUnitState } from '../shared/usenet-contracts.js'
import type { Config, PrivateSource } from './types.js'
import { resolveUsenetCopies, usenetSourceIds, type UsenetCopies } from './usenet-copies.js'
import {
  existingFields,
  unresolvedCode,
  type DownloadClientAdapter,
  type UnitPlan,
  type UnitReview,
  type UnitRow,
  type UsenetUnit,
} from './download-client-types.js'

const EXTRA_FILE_LIMIT = 10

/** The candidate a row names is not one that was fetched and checked; it keeps the `not_searched` code. */
const CHOSEN_NZB_COPY = 'The chosen NZB is no longer known or could not be fetched; search Prowlarr again.'

/** Usenet outcomes that have their own wording; every other non-available outcome is a failed lookup. */
const USENET_BLOCK: Partial<Record<UsenetUnitState, PreflightBlocked['code']>> = {
  not_configured: 'usenet_unconfigured',
  // Only a Prowlarr search still running elsewhere leaves a hash unchecked once the hash indexers answered.
  not_checked: 'not_searched',
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

interface UsenetRowPlan {
  available: UsenetHashAvailability[]
  /** The file lists a copy found through Prowlarr was checked against, by source. */
  listed: PrivateSource[]
  /** `detail` as `RowBlocks.add` takes it: appended to the code's copy, or replacing it. */
  blocked?: { code: PreflightBlocked['code']; detail?: string | { reason: string } }
}

/** The hint for a hash the hash indexers lack while nothing is known from Prowlarr about it. */
const SEARCH_PROWLARR_HINT = 'Search Prowlarr for this release in its details to look beyond the hash indexers.'

/** What the Usenet copies of one row's missing sources allow: units to plan, or why the row is blocked. */
function usenetRowPlan(row: UnitRow, copies: UsenetCopies): UsenetRowPlan {
  const { hashes, fileListSources: listed } = copies
  const blocked = (code: PreflightBlocked['code'], detail?: string | { reason: string }): UsenetRowPlan => ({
    available: [],
    listed,
    blocked: { code, detail },
  })
  // The candidate a row names must be one of the copies: fetched, graded and not rejected.
  if (listed.length && row.nzb && !hashes.some(copy => copy.state === 'available' && copy.entry_id === row.nzb))
    return blocked('not_searched', { reason: CHOSEN_NZB_COPY })
  if (copies.by === 'file_list') {
    // Every source of a private-tracker release needs a proven or chosen NZB.
    const miss = hashes.find(copy => copy.state !== 'available')
    if (!miss) return { available: hashes, listed }
    // The detail is what the search or the check last said: no candidate, a daily limit, an indexer that failed.
    return blocked(FILE_LIST_BLOCK[miss.state] ?? 'no_match', miss.error)
  }
  const { aggregate } = copies
  if (aggregate === 'available') return { available: hashes.filter(hash => hash.state === 'available'), listed }
  if (aggregate === 'no_match') {
    const absent = hashes.find(hash => hash.state === 'no_match' && hash.error)
    const unsearched = hashes.some(
      hash =>
        hash.state === 'no_match' && hash.provider !== 'prowlarr' && listed.some(source => source.id === hash.hash),
    )
    const detail = absent?.error ?? (unsearched ? SEARCH_PROWLARR_HINT : undefined)
    if (detail) return blocked('no_match', detail)
  }
  if (aggregate === 'unverified')
    return blocked('not_verified', hashes.find(hash => hash.state === 'unverified')?.error)
  const failed = hashes.find(hash => hash.state === 'lookup_failed')
  const unresolved = failed?.providers_failed?.length ? ` (${failed.providers_failed.join(', ')} unresolved)` : ''
  return blocked(
    USENET_BLOCK[aggregate] ?? 'lookup_failed',
    failed ? `${failed.error || 'provider unavailable'}${unresolved}` : undefined,
  )
}

/**
 * Usenet units: one per source and category, from the Usenet copies of the sources no acquisition covers yet.
 * An NZB always carries its whole source, so a row scoped to some files may need the user's acknowledgement.
 */
export function planUsenetUnits(
  config: Config,
  client: Pick<DownloadClientAdapter, 'protocol' | 'client' | 'endpointId'>,
  rows: UnitRow[],
  { blocks, intent, refresh }: UnitReview,
): UnitPlan<UsenetUnit> {
  return {
    sources: row => usenetSourceIds(config, row.source),
    async units({ ownership }) {
      const plans = new Map<string, UsenetRowPlan>()
      const lookups: { row: UnitRow; missing: string[] }[] = []
      for (const row of rows) {
        if (blocks.has(row)) continue
        const required = usenetSourceIds(config, row.source)
        if (!required.length) {
          const detail = row.source.private_sources?.length
            ? 'Private-tracker releases are found on Usenet through Prowlarr; set it up under Configuration.'
            : undefined
          plans.set(rowKey(row), { available: [], listed: [], blocked: { code: 'no_match', detail } })
          continue
        }
        const unresolved = required.map(hash => ownership(hash)).filter(owner => owner.unresolved)
        if (unresolved.length) {
          blocks.add(row, unresolvedCode(unresolved.every(owner => owner.unreachable)))
          continue
        }
        const missing = required.filter(hash => !ownership(hash).record)
        if (missing.length) lookups.push({ row, missing })
        else plans.set(rowKey(row), { available: [], listed: [] })
      }
      // Only the sources no acquisition covers yet are looked up; caching and pacing live in the resolver.
      const copies = await resolveUsenetCopies(
        config,
        lookups.map(({ row, missing }) => ({
          release: row.source,
          result: row.result,
          intent,
          only: missing,
          ...(refresh ? { refresh } : {}),
          ...(row.nzb ? { nzb: row.nzb } : {}),
        })),
      )
      lookups.forEach(({ row }, index) => plans.set(rowKey(row), usenetRowPlan(row, copies[index])))
      const units: UsenetUnit[] = []
      for (const row of rows) {
        const plan = plans.get(rowKey(row))
        if (!plan || blocks.has(row)) continue
        if (plan.blocked) {
          blocks.add(row, plan.blocked.code, plan.blocked.detail)
          continue
        }
        const requested = (row.source.selected_files || []).map(normalizeTorrentPath)
        const unitFor = (hash: string) => ({
          unit_id: `usenet:${hash}:${row.category}`,
          protocol: 'usenet' as const,
          client: client.client,
          source_hash: hash,
          category: row.category,
          labels: [row.label],
          selections: [{ key: row.key, release: row.release }],
        })
        for (const hash of usenetSourceIds(config, row.source)) {
          const existing = ownership(hash).record
          if (!existing) continue
          units.push({
            ...unitFor(hash),
            status: 'existing',
            ...existingFields(existing, client),
            whole_source: existing.protocol === 'usenet' || !existing.scope?.length,
            scope_expanded: false,
            size_bytes: 0,
            approximate: false,
            scope_unknown: false,
            requiresAck: false,
            send: {},
          })
        }
        for (const availability of plan.available) {
          const { record: existing, unresolved, unreachable } = ownership(availability.hash)
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
              ? plan.listed.find(source => source.id === availability.hash)
              : undefined
          units.push({
            ...unitFor(availability.hash),
            status: existing ? 'existing' : 'new',
            ...existingFields(existing, client),
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
            ...(availability.title ? { nzb_name: `${availability.title}.nzb` } : {}),
            requiresAck: scopeExpanded || scopeUnknown,
            send: {
              entryId: availability.entry_id,
              ...(listed ? { sourceFiles: listed.files } : {}),
            },
          })
        }
      }
      return units
    },
  }
}
