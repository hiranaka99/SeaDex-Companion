import type {
  DownloadCapabilities,
  DownloadClient,
  DownloadImport,
  DownloadPhase,
  DownloadProgress,
  DownloadProtocol,
} from '../../shared/download-contracts.js'

/** One owned acquisition as reported by its download client. */
export interface DownloadEntry {
  record_id: string
  protocol: DownloadProtocol
  client: DownloadProgress['client']
  phase: DownloadPhase
  capabilities: DownloadCapabilities
  progress: number
  downloaded: number
  total_size: number
  speed: number
  title: string
  season: string
  releaseGroup: string
  category: string
  size: number
  error?: string
  /** The client at a different URL no longer serves this record. */
  unbound?: boolean
  /** Client-native source hash (torrent info hash), used to look up the release's file list. */
  source_hash?: string
  /** Selected torrent files; absent means the whole source. */
  scope?: string[]
  /** Whether Sonarr or Radarr imported the finished download; absent for downloads that are not followed. */
  import?: DownloadImport
}

export function toDownloadEntry(p: DownloadProgress): DownloadEntry {
  const season = p.season === null ? p.part || 'Release' : p.part ? `S${p.season} · ${p.part}` : `S${p.season}`
  return {
    record_id: p.record_id,
    protocol: p.protocol,
    client: p.client,
    phase: p.phase,
    capabilities: p.capabilities,
    progress: p.progress,
    downloaded: p.downloaded,
    total_size: p.total_size,
    speed: p.speed,
    title: p.title,
    season,
    releaseGroup: p.release_group || p.title,
    category: p.category,
    size: p.size,
    error: p.error,
    unbound: p.state === 'unbound',
    source_hash: p.source_hash,
    ...(p.scope ? { scope: p.scope } : {}),
    ...(p.import ? { import: p.import } : {}),
  }
}

/** A finished download that still needs the person's attention or is waiting on Sonarr or Radarr. */
export const importUnsettled = (entry: Pick<DownloadEntry, 'import'>) =>
  entry.import?.state === 'pending' ||
  entry.import?.state === 'blocked' ||
  entry.import?.state === 'not_imported' ||
  entry.import?.state === 'mismatch'

/** The display name of a download client. */
export const clientName = (client: DownloadClient) => (client === 'sabnzbd' ? 'SABnzbd' : 'qBittorrent')

/** The client a protocol's downloads are sent to. */
export const protocolClient = (protocol: DownloadProtocol): DownloadClient =>
  protocol === 'usenet' ? 'sabnzbd' : 'qbittorrent'

/** The name of the client a protocol's downloads are sent to. */
export const protocolClientName = (protocol: DownloadProtocol) => clientName(protocolClient(protocol))

const PHASE_LABEL: Record<DownloadPhase, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  repairing: 'Repairing',
  unpacking: 'Unpacking',
  post_processing: 'Post-processing',
  seeding: 'Seeding',
  complete: 'Complete',
  missing: 'Not in client',
  unavailable: 'Unavailable',
  acceptance_unknown: 'Awaiting confirmation',
  error: 'Error',
}

/** The display name of a download phase. */
export const phaseLabel = (phase: DownloadPhase) => PHASE_LABEL[phase] || 'Downloading'
