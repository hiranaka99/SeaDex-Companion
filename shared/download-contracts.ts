import { rowKey } from './ids.js'
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

export interface DownloadSelectionRef {
  key: string
  release: number
}

/**
 * Where a finished download stands with the Sonarr or Radarr instance that should import it.
 * `waiting`: still downloading. `pending`: finished, import not seen yet. `blocked`: the app
 * reports a problem. `not_imported`: the app dropped it and the library did not change.
 */
export type ImportState = 'waiting' | 'pending' | 'blocked' | 'imported' | 'not_imported'

export interface DownloadImport {
  state: ImportState
  /** Display name of the Sonarr or Radarr instance expected to import the download. */
  app: string
  /** The app's own explanation of a blocked or missing import. */
  message?: string
  completed_at?: string
}

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
  code:
    | 'protocol_required'
    | 'mode_conflict'
    | 'no_torrent'
    | 'no_match'
    | 'processing'
    | 'incomplete'
    | 'lookup_failed'
    | 'usenet_unconfigured'
    | 'not_upgradable'
    | 'owned'
    | 'excluded'
    | 'invalid'
    | 'conflict'
    | 'acceptance_unknown'
    | 'client_unreachable'
    | 'category_missing'
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
  failures?: DownloadUnitFailure[]
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
  interface Outcome extends DownloadSelectionRef {
    protocols: DownloadProtocol[]
    pending: boolean
    added: boolean
    existing: boolean
    failed: boolean
  }
  const outcomes = new Map<string, Outcome>()
  const merge = (
    entry: DownloadUnitEntry | DownloadUnitFailure,
    status: 'pending' | 'added' | 'existing' | 'failed',
  ) => {
    for (const selection of entry.selections) {
      const id = rowKey(selection)
      let outcome = outcomes.get(id)
      if (!outcome) {
        outcome = {
          key: selection.key,
          release: selection.release,
          protocols: [],
          pending: false,
          added: false,
          existing: false,
          failed: false,
        }
        outcomes.set(id, outcome)
      }
      if (!outcome.protocols.includes(entry.protocol)) outcome.protocols.push(entry.protocol)
      outcome[status] = true
    }
  }
  for (const unit of job.pending) merge(unit, 'pending')
  for (const unit of job.existing) merge(unit, 'existing')
  for (const unit of job.added) merge(unit, 'added')
  for (const failure of job.failures) merge(failure, 'failed')
  const rows: SubmissionRow[] = []
  let count = 0
  for (const outcome of outcomes.values()) {
    let status: SubmissionRow['status']
    if (outcome.pending) status = 'pending'
    else if (outcome.failed) status = outcome.added || outcome.existing ? 'partial' : 'failed'
    else if (outcome.added) status = 'added'
    else status = 'existing'
    if (status === 'added' || status === 'existing') count++
    rows.push({ key: outcome.key, release: outcome.release, protocols: outcome.protocols, status })
  }
  return { ok: count > 0, count, rows, failures: job.failures }
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
  /** All saved release associations; consumers validate source hashes and scope before attaching to current recommendations. */
  associations: DownloadSelectionRef[]
  /** Effective torrent file scope. Undefined means the whole source. */
  scope?: string[]
  progress: number
  downloaded: number
  total_size: number
  speed: number
  error?: string
  /** Import follow-through for downloads sent after it was introduced; absent for older records. */
  import?: DownloadImport
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
