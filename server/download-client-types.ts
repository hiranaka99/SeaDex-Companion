import { HttpError } from './http-error.js'
import type { OwnedDownloadRecord } from './download-store.js'
import type { SourceFile } from './source-files.js'
import type { Release, ResultItem } from './types.js'
import type { PrivateSearchContext } from './private-sources.js'
import type { CopyIntent } from './usenet-copies.js'
import type {
  DiskSpaceCheck,
  DownloadCapabilities,
  DownloadClient,
  DownloadPhase,
  DownloadProtocol,
  DownloadSelectionRef,
  PlannedUnit,
  PreflightBlocked,
} from '../shared/download-contracts.js'

export const CLIENT_FOR_PROTOCOL: Record<DownloadProtocol, DownloadClient> = {
  torrent: 'qbittorrent',
  usenet: 'sabnzbd',
}

/** Free space where a download client stores new downloads, read on the client's own host. */
export interface DownloadSpaceLocation {
  client: DownloadClient
  /** The folder, or a description when the client does not name one. */
  label: string
  free_bytes: number | null
  reason?: string
}

/** A control was refused because of who owns the download or the state it is in. */
export class OwnershipError extends HttpError {
  constructor(message: string, status = 409) {
    super(status, message, { ok: false })
  }
}

/**
 * One client submission as planned by a review, with what only the server needs to carry it out. `send` holds what
 * only the unit's own client reads; review and submission never look inside it.
 */
export interface SubmissionUnit<Send = unknown> extends PlannedUnit {
  /** Sending this unit needs the user's whole-source acknowledgement. */
  requiresAck: boolean
  /**
   * Identity of the release behind the unit, when it differs from `source_hash`: a private-tracker torrent and
   * its Usenet copy are the same source, so one review must not send both.
   */
  sourceAlias?: string
  /** Rows of other split seasons a whole-release send also downloads; its record links them for progress. */
  links?: DownloadSelectionRef[]
  send: Send
}

export interface TorrentSend {
  /** Files the selections asked for; empty means the whole source. A widening send names the scope it grows to. */
  requestedPaths: string[]
  /** Widens a torrent the app already added: the files to switch on, or every file when empty. */
  widen?: { addPaths: string[] }
  /** The checked .torrent file of a private-tracker release; qBittorrent receives it instead of a magnet. */
  torrentFile?: Uint8Array
}

export interface UsenetSend {
  /** Provider entry the NZB is fetched from. */
  entryId?: string
  /**
   * The listed files of a source whose NZB was found through Prowlarr. They grade the NZB again in the one case
   * it has to be fetched again for the submission: its stored bytes are gone.
   */
  sourceFiles?: SourceFile[]
}

export type TorrentUnit = SubmissionUnit<TorrentSend> & { protocol: 'torrent' }
export type UsenetUnit = SubmissionUnit<UsenetSend> & { protocol: 'usenet' }

/** Who plans: what a Usenet copy may cost is the resolver's budget for that intent (see `CopyIntent`). */
export type PlanIntent = Extract<CopyIntent, 'single_review' | 'bulk_review' | 'acceptance'>

/** A selected release a review validated for one client, ready to be turned into that client's units. */
export interface UnitRow extends DownloadSelectionRef {
  source: Release
  /** The library result the release belongs to. */
  result: ResultItem
  category: string
  label: string
  /** Prowlarr search terms for this release: titles, release group, tracker and categories. */
  search: PrivateSearchContext
  /** An unproven NZB the user chose for this private-tracker release. */
  nzb?: string
  /** A whole-release send: the same release on the title's other split seasons, which it downloads too. */
  links?: DownloadSelectionRef[]
}

/** Rows a review rules out. A row keeps the first reason found for it. */
export interface RowBlocks {
  /** `detail` is appended to the code's standard copy; `{ reason }` replaces that copy outright. */
  add(row: DownloadSelectionRef, code: PreflightBlocked['code'], detail?: string | { reason: string }): void
  has(row: DownloadSelectionRef): boolean
}

/** Who already owns a source, as far as the ledger and a fresh client read can tell. */
export interface SourceOwnership {
  record?: OwnedDownloadRecord
  /** An earlier send was never confirmed, or the client could not be asked. */
  unresolved?: true
  unreachable?: true
}

/** What a review knows once the ledger and the clients were read, handed to each client to plan its units. */
export interface UnitPlanning {
  presence: ClientPresence
  ownership: (sourceId: string) => SourceOwnership
}

/** One client's planning of a review's rows, started before the ledger and the clients are read. */
export interface UnitPlan<U extends SubmissionUnit = SubmissionUnit> {
  /** The source IDs a row is acquired by. */
  sources(row: UnitRow): string[]
  /** Units for the rows still sendable, in the order they are shown; blocks the rows that cannot be sent. */
  units(planning: UnitPlanning): Promise<U[]>
}

/** What a review asks of a client's planning, beyond the rows themselves. */
export interface UnitReview {
  blocks: RowBlocks
  intent: PlanIntent
  refresh?: boolean
}

/** Fields that tie a unit to the acquisition already covering it. */
export function existingFields(
  owned: OwnedDownloadRecord | undefined,
  client: Pick<DownloadClientAdapter, 'protocol' | 'endpointId'>,
): Pick<PlannedUnit, 'existing_record_id' | 'existing_native_id' | 'existing_unbound'> {
  if (!owned) return {}
  return {
    existing_record_id: owned.id,
    existing_native_id: owned.native_id,
    existing_unbound: owned.protocol !== client.protocol || owned.endpoint !== client.endpointId,
  }
}

export const unresolvedCode = (unreachable: boolean | undefined): PreflightBlocked['code'] =>
  unreachable ? 'client_unreachable' : 'acceptance_unknown'

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
 * Review hands each client only its own rows, and submission only its own units.
 */
export interface DownloadClientAdapter<U extends SubmissionUnit = SubmissionUnit> {
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
  /** Turns the selected releases this client sends into its units: deduplicated, sized and scoped. */
  planUnits(rows: UnitRow[], review: UnitReview): Promise<UnitPlan<U>>
  /** What the ledger keeps about a unit beyond what every unit carries. */
  recordFields(unit: U): { scope?: string[]; entry_id?: string }
  /** Sends one unit and resolves with its primary native ID. */
  submit(unit: U, ownership: SubmissionOwnership): Promise<string>
  /** User-facing text when a failed submission may still have been accepted; null when it certainly was not. */
  ambiguity(error: unknown): string | null
  control(nativeId: string, action: 'pause' | 'resume'): Promise<void>
  remove(nativeId: string, removeFiles: boolean, job: LiveJob | undefined): Promise<void>
  diskChecks(units: U[]): Promise<DiskSpaceCheck[]>
  /** Free space for the configured destinations of this client; empty when unconfigured, failures reported as entries. */
  freeSpace(categories: string[]): Promise<DownloadSpaceLocation[]>
  /** Categories the client does not know, or null when its list could not be read. */
  unknownCategories?(categories: string[]): Promise<string[] | null>
  /** Confirms submissions whose acceptance was never acknowledged; true when a record changed. */
  adoptUnconfirmed?(records: OwnedDownloadRecord[]): Promise<boolean>
  /** A record without a confirmed job stopped being tracked. */
  forgotten?(recordId: string): void
}

export type DownloadClients = Record<DownloadProtocol, DownloadClientAdapter>

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
