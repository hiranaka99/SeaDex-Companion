import { estimateDownloads } from '../shared/download-estimate.js'
import { normalizeTorrentPath, planTorrents, torrentHashes, type PlannedTorrent } from '../shared/download-plan.js'
import type { OwnedDownloadRecord } from './download-store.js'
import type { Config, Release } from './types.js'
import { privateSearchSettings } from './prowlarr.js'
import { resolvePrivateTorrent } from './private-sources.js'
import {
  existingFields,
  unresolvedCode,
  type DownloadClientAdapter,
  type RowBlocks,
  type TorrentUnit,
  type UnitPlan,
  type UnitRow,
} from './download-client-types.js'

/** A private-tracker torrent found through Prowlarr, by its real info hash. */
interface FoundTorrent {
  file: Uint8Array
  sourceId: string
}

/**
 * Finds the private-tracker torrents of rows through Prowlarr. A found row is planned under the real info hash and
 * file list, so ownership, deduplication and file selection work as for any public torrent.
 */
async function resolvePrivateTorrents(
  config: Config,
  rows: UnitRow[],
  blocks: RowBlocks,
  found: Map<string, FoundTorrent>,
): Promise<Map<UnitRow, Release>> {
  const resolved = new Map<UnitRow, Release>()
  if (!privateSearchSettings(config)) return resolved
  await Promise.all(
    rows.map(async row => {
      const sources = row.source.private_sources || []
      if (blocks.has(row) || torrentHashes(row.source).length || !sources.length) return
      const lookups = await Promise.all(sources.map(source => resolvePrivateTorrent(config, source, row.search)))
      const miss = lookups.find(lookup => lookup.kind !== 'match')
      if (miss?.kind === 'failed') return blocks.add(row, 'private_lookup_failed', `(${miss.message})`)
      if (miss?.kind === 'no_match' || miss?.kind === 'unconfigured')
        return blocks.add(row, 'private_no_match', miss.reason)
      const hashes: string[] = []
      lookups.forEach((lookup, index) => {
        if (lookup.kind !== 'match') return
        hashes.push(lookup.hash)
        found.set(lookup.hash, { file: lookup.torrent, sourceId: sources[index].id })
      })
      resolved.set(row, {
        ...row.source,
        info_hashes: hashes,
        // SeaDex's file names, now under the real hash: the checked torrent holds exactly these files.
        torrent_files: hashes.map((hash, index) => ({ hash, files: sources[index].files })),
      })
    }),
  )
  return resolved
}

/** What a send adds to a torrent the app already added with only some of its files. */
interface Widening {
  /** Files to switch on; empty means every file, when the file list is not known. */
  addPaths: string[]
  /** The scope the record grows to; undefined is the whole torrent. */
  scope?: string[]
  /** Bytes of the files to switch on, when the file list knows them all. */
  bytes: number | null
}

/**
 * How a planned torrent widens the torrent the app added for it, or null when that torrent already holds every
 * requested file. Only a torrent this client holds, that the app added with a file scope, is ever widened.
 */
function widening(
  entry: PlannedTorrent,
  owned: OwnedDownloadRecord | undefined,
  client: Pick<DownloadClientAdapter, 'protocol' | 'endpointId'>,
  present: boolean,
): Widening | null {
  if (!owned || !present || owned.protocol !== client.protocol || owned.endpoint !== client.endpointId) return null
  if (!owned.scope?.length) return null
  const scope = new Set(owned.scope.map(normalizeTorrentPath))
  const catalog = new Map<string, { name: string; length: number }>()
  for (const release of entry.releases)
    for (const listed of release.torrent_files || [])
      if (listed.hash.toLowerCase() === entry.hash)
        for (const file of listed.files) catalog.set(normalizeTorrentPath(file.name), file)
  const wanted = entry.selectedFiles || [...catalog.values()].map(file => file.name)
  const addPaths = [...new Map(wanted.map(name => [normalizeTorrentPath(name), name])).entries()]
    .filter(([path]) => !scope.has(path))
    .map(([, name]) => name)
  // The whole torrent without a file list to compare: every file is switched on.
  if (!addPaths.length && (entry.selectedFiles || catalog.size)) return null
  const sizes = addPaths.map(name => catalog.get(normalizeTorrentPath(name))?.length)
  return {
    addPaths,
    ...(entry.selectedFiles ? { scope: [...new Set([...owned.scope, ...entry.selectedFiles])] } : {}),
    bytes:
      addPaths.length && sizes.every(size => Number.isSafeInteger(size) && size! >= 0)
        ? sizes.reduce((sum, size) => sum! + size!, 0)!
        : null,
  }
}

/**
 * Torrent units: one per info hash and category, with the shared per-hash deduplication and file-scope union rules.
 * A private-tracker release is first found through Prowlarr; it is then sent from its checked .torrent file.
 */
export async function planTorrentUnits(
  config: Config,
  client: Pick<DownloadClientAdapter, 'protocol' | 'client' | 'endpointId'>,
  rows: UnitRow[],
  blocks: RowBlocks,
): Promise<UnitPlan<TorrentUnit>> {
  const found = new Map<string, FoundTorrent>()
  const resolved = await resolvePrivateTorrents(config, rows, blocks, found)
  const release = (row: UnitRow) => resolved.get(row) ?? row.source
  return {
    sources: row => torrentHashes(release(row)),
    async units({ presence, ownership }) {
      for (const row of rows)
        if (!torrentHashes(release(row)).length)
          blocks.add(
            row,
            'no_torrent',
            row.source.private_sources?.length && !privateSearchSettings(config)
              ? 'Set up Prowlarr with this tracker under Configuration to download private-tracker releases.'
              : undefined,
          )
      const usable = rows.filter(row => !blocks.has(row))
      const planned = planTorrents(
        usable.map(row => ({ release: release(row), category: row.category, label: row.label })),
      )
      const sized = estimateDownloads(
        usable.map(row => ({ release: release(row), category: row.category })),
        [...presence.ids],
      )
      const estimates = new Map(sized.torrents.map(entry => [entry.hash, entry]))
      const units: TorrentUnit[] = []
      for (const row of usable) {
        const hashes = torrentHashes(release(row))
        const sources = planned.filter(entry => hashes.includes(entry.hash))
        if (!sources.length) {
          blocks.add(row, 'no_torrent')
          continue
        }
        for (const entry of sources) {
          const { record: owned, unresolved, unreachable } = ownership(entry.hash)
          if (unresolved) {
            blocks.add(row, unresolvedCode(unreachable))
            continue
          }
          const estimate = estimates.get(entry.hash)
          const torrent = found.get(entry.hash)
          const widen = widening(entry, owned, client, presence.ids.has(entry.hash))
          if (widen) {
            units.push({
              unit_id: `torrent:${entry.hash}:${entry.category}`,
              protocol: 'torrent',
              client: client.client,
              source_hash: entry.hash,
              category: entry.category,
              status: 'new',
              widens: true,
              ...existingFields(owned, client),
              whole_source: !widen.scope,
              scope_expanded: false,
              size_bytes: widen.bytes,
              approximate: false,
              scope_unknown: widen.bytes === null,
              labels: [row.label],
              selections: [{ key: row.key, release: row.release }],
              ...(row.links?.length ? { links: row.links } : {}),
              requiresAck: false,
              send: { requestedPaths: widen.scope || [], widen: { addPaths: widen.addPaths } },
            })
            continue
          }
          units.push({
            unit_id: `torrent:${entry.hash}:${entry.category}`,
            protocol: 'torrent',
            client: client.client,
            source_hash: entry.hash,
            category: entry.category,
            status: owned || presence.ids.has(entry.hash) ? 'existing' : 'new',
            ...existingFields(owned, client),
            whole_source: !entry.selectedFiles,
            scope_expanded: false,
            size_bytes: estimate?.existing ? 0 : (estimate?.bytes ?? null),
            approximate: estimate?.approximate ?? true,
            scope_unknown: estimate?.bytes === null && !estimate?.existing,
            labels: [row.label],
            selections: [{ key: row.key, release: row.release }],
            ...(row.links?.length ? { links: row.links } : {}),
            requiresAck: false,
            ...(torrent ? { sourceAlias: torrent.sourceId } : {}),
            send: {
              requestedPaths: entry.selectedFiles || [],
              ...(torrent ? { torrentFile: torrent.file } : {}),
            },
          })
        }
      }
      return units
    },
  }
}
