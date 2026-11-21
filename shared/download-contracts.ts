import type { UsenetProvider } from './usenet-contracts.js'

export type DownloadProtocol = 'torrent' | 'usenet'
export type DownloadMode = 'torrent_only' | 'usenet_only' | 'choose'
export type DownloadClient = 'qbittorrent' | 'sabnzbd'

/** Shared acquisition phase. Torrent and Usenet native states both map here. */
export type DownloadPhase =
  | 'acceptance_unknown'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'repairing'
  | 'unpacking'
  | 'post_processing'
  | 'seeding'
  | 'complete'
  | 'error'
  | 'missing'
  | 'unavailable'

export interface DownloadSelectionRef { key: string; release: number }

/** One review row's acquisition intent. The server resolves authority from the saved mode. */
export interface DownloadSelection extends DownloadSelectionRef {
  identity?: string
  protocol?: DownloadProtocol
}

export interface DownloadCapabilities {
  pause: boolean
  resume: boolean
  remove: boolean
  remove_files: boolean
}

/** One actual client submission: one torrent or one whole-source NZB. */
export interface PlannedUnit {
  unit_id: string
  protocol: DownloadProtocol
  client: DownloadClient
  source_hash: string
  category: string
  /** 'existing' means an appropriately associated app-owned acquisition already covers it. */
  status: 'new' | 'existing'
  existing_record_id?: string
  existing_native_id?: string
  /** The existing acquisition is bound to a different client endpoint and is not controllable here. */
  existing_unbound?: boolean
  /** The NZB carries the whole source, not only the requested files. */
  whole_source: boolean
  /** Actual source scope is larger than this unit's requested scope. */
  scope_expanded: boolean
  size_bytes: number | null
  approximate: boolean
  provider?: UsenetProvider
  nzb_name?: string
  /** Known source files beyond the requested scope (complete provider manifest only). */
  known_extra_files?: string[]
  extra_file_count?: number
  /** Actual source scope or size could not be fully determined. */
  scope_unknown?: boolean
  labels: string[]
  selections: DownloadSelectionRef[]
}

export interface PreflightBlocked {
  key: string
  release: number
  code: 'protocol_required' | 'mode_conflict' | 'no_torrent' | 'no_match' | 'processing' | 'incomplete'
    | 'lookup_failed' | 'usenet_unconfigured' | 'not_upgradable' | 'owned' | 'excluded' | 'invalid' | 'conflict'
  reason: string
}

export interface DiskSpaceCheck {
  client: DownloadClient
  path: string | null
  /** Human label for destinations the API cannot attribute to categories (folder names etc.). */
  label?: string
  categories: string[]
  required_bytes: number
  /** Count of units whose payload size is unknown or approximate. */
  unknown_units: number
  free_bytes: number | null
  sufficient: boolean | null
  reason?: string
}

/** Safe public review returned by preflight. Contains no NZB URLs or credentials. */
export interface DownloadPreflight {
  ok: true
  plan_id: string
  /** Seconds until the server-side plan expires and requires review again. */
  expires_in: number
  mode: DownloadMode
  selection_count: number
  units: PlannedUnit[]
  new_torrents: number
  new_nzbs: number
  existing_units: number
  blocked: PreflightBlocked[]
  requires_whole_ack: boolean
  requires_space_ack: boolean
  total_new_bytes: number
  unknown_bytes: number
  approximate_bytes: boolean
  disk_space: DiskSpaceCheck[]
}

export interface DownloadSubmission {
  plan_id: string
  acknowledge?: { whole_source?: boolean; disk_space?: boolean }
}

export interface DownloadReceipt {
  ok: boolean
  record_id: string
  native_id: string
  protocol: DownloadProtocol
  client: DownloadClient
  source_hash: string
  category: string
  /** True when SABnzbd accepted but its response was ambiguous; check the client before retrying. */
  acceptance_unknown?: boolean
  error?: string
}

export interface DownloadUnitEntry {
  unit_id: string
  protocol: DownloadProtocol
  record_id?: string
  native_id?: string
  source_hash: string
  label: string
  selections: DownloadSelectionRef[]
}

export interface DownloadUnitFailure {
  unit_id?: string
  protocol: DownloadProtocol
  record_id?: string
  source_hash?: string
  label: string
  code: string
  error: string
  selections: DownloadSelectionRef[]
}

export interface DownloadJob {
  id: string
  finished: boolean
  pending: DownloadUnitEntry[]
  added: DownloadUnitEntry[]
  existing: DownloadUnitEntry[]
  failures: DownloadUnitFailure[]
  targets: DownloadSelection[]
}

export interface SubmissionRow extends DownloadSelectionRef {
  status: 'added' | 'existing' | 'partial' | 'failed' | 'pending'
  protocols: DownloadProtocol[]
}

export interface BulkSubmissionResult {
  ok: boolean
  count: number
  rows: SubmissionRow[]
  failures: DownloadUnitFailure[]
  error?: string
}

export function jobResult(job: Omit<DownloadJob, 'id'>): BulkSubmissionResult {
  const rows = new Map<string, SubmissionRow>()
  const rowFor = (selection: DownloadSelectionRef) => {
    const id = `${selection.key}\u0000${selection.release}`
    let row = rows.get(id)
    if (!row) { row = { key: selection.key, release: selection.release, status: 'pending', protocols: [] }; rows.set(id, row) }
    return row
  }
  const protocolOf = (entry: DownloadUnitEntry | DownloadUnitFailure): DownloadProtocol => entry.protocol || 'torrent'
  const merge = (entry: { selections: DownloadSelectionRef[] }, status: SubmissionRow['status'], protocol: DownloadProtocol) => {
    const affected = entry.selections.length ? entry.selections : job.targets.filter(target => target.protocol === protocol)
    for (const selection of affected) {
      const row = rowFor(selection)
      if (!row.protocols.includes(protocol)) row.protocols.push(protocol)
      if (row.status === 'pending') row.status = status
      else if (row.status !== status) row.status = row.status === 'added' || status === 'added' ? 'partial' : row.status === 'failed' || status === 'failed' ? 'partial' : status
    }
  }
  for (const unit of job.pending) merge(unit, 'pending', protocolOf(unit))
  for (const unit of job.existing) merge(unit, 'existing', protocolOf(unit))
  for (const unit of job.added) merge(unit, 'added', protocolOf(unit))
  for (const failure of job.failures) merge(failure, 'failed', protocolOf(failure))
  const list = [...rows.values()]
  return {
    ok: list.some(row => row.status === 'added' || row.status === 'existing'),
    count: list.filter(row => row.status === 'added' || row.status === 'existing').length,
    rows: list,
    failures: job.failures,
  }
}

/** Live per-unit state of the in-flight bulk download batch. */
export interface DownloadJobStatus extends Omit<DownloadJob, 'id'> {
  id: string | null
  ok: boolean
}

export interface DownloadProgress {
  record_id: string
  protocol: DownloadProtocol
  client: DownloadClient
  source_hash: string
  native_id: string
  phase: DownloadPhase
  /** Client-native state string kept for detail text. */
  state: string
  category: string
  labels: string[]
  title: string
  season: number | null
  part: string
  release_group: string
  tracker: string
  size: number
  /** Current catalog association when resolvable; controls never resolve through it. */
  key?: string
  release?: number
  progress: number
  downloaded: number
  total_size: number
  speed: number
  error?: string
  capabilities: DownloadCapabilities
  updated_at: string
}

export interface AllDownloadProgress {
  ok: boolean
  downloads: Record<string, DownloadProgress>
  /** Client endpoints whose state could not be read; last-known progress is preserved. */
  unavailable_clients?: DownloadClient[]
}

export interface CancelableDownload {
  record_id: string
  protocol: DownloadProtocol
  client: DownloadClient
  native_id: string
  phase: DownloadPhase
  title: string
  season: number | null
  part: string
  release_group: string
  category: string
  /** Titles of every affected release/cour for shared jobs. */
  associations: string[]
  size: number
  capabilities: DownloadCapabilities
}

export interface CancelableDownloads {
  ok: boolean
  items: CancelableDownload[]
}

export interface DownloadCancelResult {
  ok: boolean
  removed: { record_id: string; client: DownloadClient }[]
  failures: { record_id: string; client: DownloadClient; label: string; error: string }[]
}
