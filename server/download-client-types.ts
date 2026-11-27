import { HttpError } from './http-error.js'
import type { OwnedDownloadRecord } from './download-store.js'
import type { SourceFile } from './source-files.js'
import type {
  DiskSpaceCheck,
  DownloadCapabilities,
  DownloadClient,
  DownloadPhase,
  DownloadProtocol,
  PlannedUnit,
} from '../shared/download-contracts.js'

/** A control was refused because of who owns the download or the state it is in. */
export class OwnershipError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message, { ok: false })
  }
}

/** One client submission as planned by a review, with what only the server needs to carry it out. */
export interface SubmissionUnit extends PlannedUnit {
  /** Files the selections asked for; empty means the whole source. */
  requestedPaths: string[]
  /** Sending this unit needs the user's whole-source acknowledgement. */
  requiresAck: boolean
  /** Provider entry the NZB is fetched from. */
  entryId?: string
  /**
   * The listed files of a source whose NZB was found through Prowlarr. They grade the NZB again in the one case
   * it has to be fetched again for the submission: its stored bytes are gone.
   */
  sourceFiles?: SourceFile[]
  /** The checked .torrent file of a private-tracker release; qBittorrent receives it instead of a magnet. */
  torrentFile?: Uint8Array
  /**
   * Identity of the release behind the unit, when it differs from `source_hash`: a private-tracker torrent and
   * its Usenet copy are the same source, so one review must not send both.
   */
  sourceAlias?: string
}

/** What a fresh client read says about one owned download. */
export interface LiveJob {
  phase: DownloadPhase
  /** Client-native state string. */
  state: string
  progress: number
  downloaded: number
  total_size: number
  speed: number
  capabilities: DownloadCapabilities
  /** Still in the client's working queue, where pause and resume apply. */
  active: boolean
  /** Client-side job name, when the client reports a better one than the saved label. */
  name?: string
  error?: string
}

export interface ClientSnapshot {
  /** Jobs the client holds, by native ID. */
  jobs: Map<string, LiveJob>
  /** False when the read failed or was partial: a missing job then proves nothing. */
  complete: boolean
}

export interface ClientPresence {
  /** Native IDs the client currently holds. */
  ids: Set<string>
  complete: boolean
}

/** Called by a client while it submits, at the moments ownership has to be made durable. */
export interface SubmissionOwnership {
  /** The client accepted the submission under these native IDs. */
  accepted(nativeIds: string[]): void
  /** The client accepted and then verifiably dropped it again. */
  forgotten(): void
}

/**
 * One download client behind the protocol-neutral review, submission, progress and control
 * flows. Everything qBittorrent- or SABnzbd-specific lives in an implementation of this.
 */
export interface DownloadClientAdapter {
  readonly protocol: DownloadProtocol
  readonly client: DownloadClient
  /** Product name used in messages. */
  readonly label: string
  /** What this client calls one download. */
  readonly jobNoun: string
  /** Credential-free identity of the configured endpoint; empty when unconfigured. */
  readonly endpointId: string
  /** The native ID is the source hash, so a job the client holds is identified without a submission receipt. */
  readonly nativeIdIsSourceHash: boolean
  /** Shown when pause or resume is asked for a job outside the working queue. */
  readonly notControllable: string
  /** Fresh state of owned records bound to this endpoint. Throws when the client cannot be read at all. */
  read(records: OwnedDownloadRecord[]): Promise<ClientSnapshot>
  /** What the client holds, for duplicate protection while reviewing. Never throws. */
  presence(records: OwnedDownloadRecord[]): Promise<ClientPresence>
  /** Sends one unit and resolves with its primary native ID. */
  submit(unit: SubmissionUnit, ownership: SubmissionOwnership): Promise<string>
  /** User-facing text when a failed submission may still have been accepted; null when it certainly was not. */
  ambiguity(error: unknown): string | null
  control(nativeId: string, action: 'pause' | 'resume'): Promise<void>
  remove(nativeId: string, removeFiles: boolean, job: LiveJob | undefined): Promise<void>
  diskChecks(units: SubmissionUnit[]): Promise<DiskSpaceCheck[]>
  /** Categories the client does not know, or null when its list could not be read. */
  unknownCategories?(categories: string[]): Promise<string[] | null>
  /** Confirms submissions whose acceptance was never acknowledged; true when a record changed. */
  adoptUnconfirmed?(records: OwnedDownloadRecord[]): Promise<boolean>
  /** A record without a confirmed job stopped being tracked. */
  forgotten?(recordId: string): void
}

/**
 * Estimated sizes (Usenet provider totals, torrent estimates) cannot be confirmed exactly.
 * They count as fitting when free space covers twice the estimate plus a fixed margin,
 * which absorbs PAR2 repair data and unpacking archives next to their parts.
 */
const ESTIMATE_HEADROOM_FACTOR = 2
const ESTIMATE_HEADROOM_BYTES = 5 * 1024 ** 3

/** Whether `free` bytes fit `required`, given how many units are sized only approximately or not at all. */
export function spaceVerdict(
  free: number | null,
  required: number,
  approximateUnits: number,
  unsizedUnits: number,
): boolean | null {
  if (free === null) return null
  if (required > free) return false
  if (unsizedUnits) return null
  if (approximateUnits) return free >= required * ESTIMATE_HEADROOM_FACTOR + ESTIMATE_HEADROOM_BYTES ? true : null
  return true
}

/** Required bytes and sizing certainty of a set of units sharing one destination. */
export function unitSizing(units: SubmissionUnit[]): { required: number; uncertain: number; unsized: number } {
  return {
    required: units.reduce((sum, unit) => sum + (unit.size_bytes || 0), 0),
    uncertain: units.filter(unit => unit.size_bytes === null || unit.approximate).length,
    unsized: units.filter(unit => unit.size_bytes === null).length,
  }
}
