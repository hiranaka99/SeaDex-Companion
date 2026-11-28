import type { Config, JsonObject } from './types.js'
import type { DiskSpaceCheck, DownloadCapabilities, DownloadPhase } from '../shared/download-contracts.js'
import {
  qbAddTorrent,
  qbControlTorrents,
  qbEnableTorrentFiles,
  qbGetDownloadStorage,
  qbGetTorrents,
  qbReadTorrents,
  QbittorrentAmbiguousError,
} from './qbittorrent.js'
import { qbEndpointId } from './client-identity.js'
import { log } from './logging.js'
import { errorMessage } from '../shared/errors.js'
import {
  spaceVerdict,
  unitSizing,
  type DownloadClientAdapter,
  type DownloadSpaceLocation,
  type LiveJob,
  type TorrentUnit,
} from './download-client-types.js'
import { planTorrentUnits } from './torrent-units.js'

const QUEUED_STATES: Record<string, true> = { queuedDL: true, queuedUP: true, metaDL: true }
const DOWNLOADING_STATES: Record<string, true> = {
  downloading: true,
  stalledDL: true,
  allocating: true,
  forcedDL: true,
}
const PAUSED_DOWNLOAD_STATES: Record<string, true> = { pausedDL: true, stoppedDL: true }
const VERIFYING_STATES: Record<string, true> = { checkingDL: true, checkingUP: true, checking: true }
const ERROR_STATES: Record<string, true> = { error: true, missingFiles: true }

function qbCapabilities(state: string, progress: number): DownloadCapabilities {
  const paused = Object.hasOwn(PAUSED_DOWNLOAD_STATES, state)
  const complete = progress >= 1
  return {
    pause:
      !paused && !complete && (Object.hasOwn(DOWNLOADING_STATES, state) || state === 'queuedDL' || state === 'metaDL'),
    resume: paused,
    remove: true,
    remove_files: true,
  }
}

export function qbPhase(state: string, progress: number): DownloadPhase {
  if (Object.hasOwn(ERROR_STATES, state)) return 'error'
  if (Object.hasOwn(PAUSED_DOWNLOAD_STATES, state)) return 'paused'
  if (Object.hasOwn(VERIFYING_STATES, state)) return 'verifying'
  if (progress >= 1) return state === 'uploading' || state === 'stalledUP' ? 'seeding' : 'complete'
  if (Object.hasOwn(QUEUED_STATES, state)) return 'queued'
  return 'downloading'
}

const torrentHash = (torrent: JsonObject): string => String(torrent.hash || '').toLowerCase()

function liveTorrent(torrent: JsonObject): LiveJob {
  const state = String(torrent.state || 'unknown')
  const progress = Number(torrent.progress || 0)
  const size = Number(torrent.size || torrent.total_size || 0)
  return {
    phase: qbPhase(state, progress),
    state,
    progress: Math.floor(progress * 10_000) / 10_000,
    downloaded: Math.trunc(size * progress),
    total_size: size,
    speed: Number(torrent.dlspeed || 0),
    capabilities: qbCapabilities(state, progress),
    // qBittorrent pauses and resumes a torrent in any state it holds it in.
    active: true,
  }
}

/** Free space per qBittorrent save path; categories sharing a path share one check. */
async function torrentDiskChecks(config: Config, units: TorrentUnit[]): Promise<DiskSpaceCheck[]> {
  const categories = [...new Set(units.map(unit => unit.category))]
  const grouped = new Map<string, { check: DiskSpaceCheck; unsized: number }>()
  for (const location of await qbGetDownloadStorage(config, categories)) {
    const key = location.path || `unknown:${location.category}`
    const entry = grouped.get(key) || {
      check: {
        client: 'qbittorrent' as const,
        path: location.path,
        categories: [],
        required_bytes: 0,
        unknown_units: 0,
        free_bytes: location.free_bytes,
        sufficient: null,
        ...(location.reason ? { reason: location.reason } : {}),
      },
      unsized: 0,
    }
    if (!entry.check.categories.includes(location.category)) {
      const sizing = unitSizing(units.filter(unit => unit.category === location.category))
      entry.check.categories.push(location.category)
      entry.check.required_bytes += sizing.required
      entry.check.unknown_units += sizing.uncertain
      entry.unsized += sizing.unsized
    }
    grouped.set(key, entry)
  }
  return [...grouped.values()].map(({ check, unsized }) => ({
    ...check,
    sufficient: spaceVerdict(check.free_bytes, check.required_bytes, check.unknown_units - unsized, unsized),
  }))
}

/** Free space per configured qBittorrent destination, deduplicated across categories sharing one path. */
async function torrentFreeSpace(
  config: Config,
  endpointId: string,
  categories: string[],
): Promise<DownloadSpaceLocation[]> {
  if (!endpointId) return []
  try {
    const locations: DownloadSpaceLocation[] = []
    const seen = new Set<string>()
    for (const location of await qbGetDownloadStorage(config, categories)) {
      const label = location.path || `qBittorrent category ${location.category || '(none)'}`
      if (seen.has(label)) continue
      seen.add(label)
      locations.push({
        client: 'qbittorrent',
        label,
        free_bytes: location.free_bytes,
        ...(location.reason ? { reason: location.reason } : {}),
      })
    }
    return locations
  } catch (error) {
    return [
      {
        client: 'qbittorrent',
        label: 'qBittorrent',
        free_bytes: null,
        reason: `Could not read qBittorrent storage: ${errorMessage(error).slice(0, 120)}`,
      },
    ]
  }
}

export function qbittorrentAdapter(config: Config): DownloadClientAdapter<TorrentUnit> {
  const endpointId = qbEndpointId(config)
  const identity = { protocol: 'torrent', client: 'qbittorrent', endpointId } as const
  return {
    protocol: 'torrent',
    client: 'qbittorrent',
    label: 'qBittorrent',
    jobNoun: 'torrent',
    endpointId,
    nativeIdIsSourceHash: true,
    notControllable: 'This torrent is no longer in qBittorrent.',
    async read(records) {
      const torrents = await qbReadTorrents(
        config,
        records.map(record => record.native_id || record.source_hash),
      )
      return { jobs: new Map(torrents.map(torrent => [torrentHash(torrent), liveTorrent(torrent)])), complete: true }
    },
    async presence() {
      try {
        return { ids: new Set((await qbGetTorrents(config, undefined, true)).map(torrentHash)), complete: true }
      } catch (error) {
        log('WARNING', `qBittorrent existing-torrent check failed during preflight: ${errorMessage(error)}`)
        return { ids: new Set(), complete: false }
      }
    },
    planUnits: (rows, review) => planTorrentUnits(config, identity, rows, review.blocks),
    recordFields: unit => (unit.whole_source ? {} : { scope: unit.send.requestedPaths }),
    async submit(unit, ownership) {
      // A torrent the app already added for other files gets the rest switched on, never added twice.
      if (unit.send.widen) {
        await qbEnableTorrentFiles(config, unit.source_hash, unit.send.widen.addPaths)
        ownership.accepted([unit.source_hash])
        return unit.source_hash
      }
      await qbAddTorrent(
        config,
        // A private tracker's torrent is added from the .torrent file found through Prowlarr.
        unit.send.torrentFile
          ? { hash: unit.source_hash, file: unit.send.torrentFile }
          : `magnet:?xt=urn:btih:${unit.source_hash}`,
        unit.category,
        unit.send.requestedPaths,
        undefined,
        {
          record: () => ownership.accepted([unit.source_hash]),
          forget: () => ownership.forgotten(),
        },
      )
      return unit.source_hash
    },
    ambiguity: error =>
      error instanceof QbittorrentAmbiguousError
        ? `Submission status unknown. Check qBittorrent before retrying. ${errorMessage(error)}`
        : null,
    control: (nativeId, action) => qbControlTorrents(config, [nativeId], action),
    remove: (nativeId, removeFiles) => qbControlTorrents(config, [nativeId], 'remove', removeFiles),
    diskChecks: units => torrentDiskChecks(config, units),
    freeSpace: categories => torrentFreeSpace(config, endpointId, categories),
  }
}
