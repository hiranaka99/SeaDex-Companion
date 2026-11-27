import type {
  AllDownloadProgress,
  CancelableDownload,
  DownloadCancelResult,
  DownloadClient,
  DownloadJobStatus,
  DownloadPreflight,
  DownloadProtocol,
  DownloadReceipt,
  DownloadSelection,
  DownloadSubmission,
  DownloadUnitFailure,
} from '../../shared/download-contracts.js'

export { jobResult } from '../../shared/download-contracts.js'

export type {
  AllDownloadProgress,
  CancelableDownload,
  DownloadCancelResult,
  DownloadCapabilities,
  DownloadJob,
  DownloadJobStatus,
  DownloadMode,
  DownloadPhase,
  DownloadPreflight,
  DownloadProgress,
  DownloadProtocol,
  DownloadReceipt,
  DownloadSubmission,
  DownloadUnitEntry,
  DownloadUnitFailure,
  DiskSpaceCheck,
  PlannedUnit,
  PreflightBlocked,
  SubmissionRow,
} from '../../shared/download-contracts.js'
import type {
  ArrScopeOptions,
  ConfigUpdate,
  ProwlarrCoverage,
  ProwlarrSearchStatus,
  ReleaseChange,
} from '../../shared/contracts.js'
import type { AuthState, Config, ResultItem, ScanHistoryEntry, ScannedDataInfo, Status } from './types.js'
import type { UpdateInfo, UpdateStatus } from '../../shared/update-contracts.js'

export const DOWNLOAD_ACTIONS = ['pause', 'resume', 'remove'] as const
export type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number]

export type DownloadAcknowledge = NonNullable<DownloadSubmission['acknowledge']>

import { followDownloadJob, waitForDownloadJob, watchDownloadJob } from './bulk-job-store.js'
import { availabilityFingerprint } from './download-routes.js'
import { protocolClient } from './download-entry.js'
export { waitForDownloadJob, watchDownloadJob }

export const AUTH_REQUIRED_EVENT = 'seadex:authentication-required'

async function api<T = unknown>(path: string, opts: RequestInit = {}, timeoutMs: number | null = 30_000): Promise<T> {
  const timeout = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)
  const signal = timeout ? (opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout) : opts.signal
  const r = await fetch(path, { ...opts, signal })
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    }
    let msg = `Request failed (${r.status})`
    let detail: Record<string, unknown> | null = null
    try {
      const j = await r.json()
      if (j && typeof j === 'object') detail = j
      if (typeof j?.error === 'string') msg = j.error
      else if (typeof j?.error?.message === 'string') {
        msg = j.error.message
        detail = j
      } else if (typeof j?.message === 'string') msg = j.message
    } catch {
      /* body was not JSON */
    }
    throw new SubmissionError(msg, detail, r.status)
  }
  return r.json()
}

/** HTTP failure whose JSON body may carry structured fields (e.g. acceptance_unknown). */
class SubmissionError extends Error {
  readonly status: number
  readonly detail: Record<string, unknown> | null
  constructor(message: string, detail: Record<string, unknown> | null, status = 500) {
    super(message)
    this.name = 'SubmissionError'
    this.detail = detail
    this.status = status
  }
}

export const getAuthStatus = () => api<AuthState>('/api/auth/status')

export const setupAuth = (username: string, password: string) =>
  api<AuthState>('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

export const login = (username: string, password: string) =>
  api<AuthState>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

export const logout = () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })

export const updateAccount = (username: string, currentPassword: string, newPassword: string) =>
  api<AuthState>('/api/auth/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, current_password: currentPassword, new_password: newPassword }),
  })

/** Which of these trackers Prowlarr has a private indexer for, and whether it has Usenet indexers. */
export const getProwlarrCoverage = (trackers: string[]) =>
  api<{ ok: boolean; coverage: ProwlarrCoverage }>(
    `/api/prowlarr/coverage?trackers=${encodeURIComponent(trackers.join(','))}`,
  ).then(response => response.coverage)

/** What a background search of the current library would cost, and what the latest one found. */
export const getProwlarrSearchStatus = () =>
  api<{ ok: boolean; status: ProwlarrSearchStatus }>('/api/prowlarr/search-status').then(response => response.status)

export const getConfig = () =>
  api<Config>('/api/config').then(config => {
    rememberAvailabilityConfig(config)
    return config
  })

export const clearScannedData = () =>
  api<{ ok: boolean; cleared: { cacheEntries: number; results: number } }>('/api/scanned-data', { method: 'DELETE' })

export const getScannedDataInfo = () => api<{ ok: boolean } & ScannedDataInfo>('/api/scanned-data')

export const saveConfig = (cfg: ConfigUpdate) =>
  api<Config>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).then(config => {
    const credentialsChanged = Boolean(
      cfg.amenzb_key?.trim() ||
      cfg.sabnzbd_key?.trim() ||
      cfg.prowlarr_key?.trim() ||
      cfg.clear_secrets?.some(key => key === 'amenzb_key' || key === 'sabnzbd_key' || key === 'prowlarr_key'),
    )
    rememberAvailabilityConfig(config, credentialsChanged)
    return config
  })

/** `arr:<id>` addresses an additional Sonarr or Radarr instance. */
export type IntegrationService =
  'sonarr' | 'radarr' | 'qbittorrent' | 'discord' | 'sabnzbd' | 'animetosho' | 'amenzb' | 'prowlarr' | `arr:${string}`

/** Tags and root folders an instance offers for its library scope, read with the unsaved draft. */
export const getArrOptions = (service: IntegrationService, config: ConfigUpdate) =>
  api<{ ok: boolean } & ArrScopeOptions>('/api/arr/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, config }),
  })

export const removeArrTags = () =>
  api<{ ok: boolean; removed: number }>('/api/arr-tags/remove', { method: 'POST' }, 120_000)

export const testConnection = (service: IntegrationService, config: ConfigUpdate) =>
  api<{ ok: boolean; message: string }>('/api/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, config }),
  })

export const getStatus = () => api<Status>('/api/status')

export const checkForUpdates = () => api<UpdateInfo>('/api/update-check')

export const getUpdateStatus = () => api<UpdateStatus>('/api/update/status', {}, 5_000)

/** Downloads and verifies the update before answering; the server restarts afterwards. */
export const installUpdate = () =>
  api<{ ok: boolean; version: string; restarting: boolean }>('/api/update/install', { method: 'POST' }, 6 * 60_000)

export const getResults = () => api<{ results: ResultItem[]; last_run: string | null }>('/api/results')

export const getScanHistory = () => api<{ scans: ScanHistoryEntry[] }>('/api/history')

export const reviewReleaseChanges = (ids: string[]) =>
  api<{ ok: boolean; reviewed: number }>('/api/release-changes/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })

/** Undoes a review; `key` is the release identity of the result each change belongs to. */
export const restoreReleaseChanges = (changes: { key: string; change: ReleaseChange }[]) =>
  api<{ ok: boolean; restored: number }>('/api/release-changes/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  })

export interface DownloadSpaceLocation {
  client: 'qbittorrent' | 'sabnzbd'
  label: string
  free_bytes: number | null
  reason?: string
}

/** Free space where the configured download clients store new downloads. */
export const getDownloadSpace = () => api<{ ok: boolean; locations: DownloadSpaceLocation[] }>('/api/download-space')

export interface AniListSearchResult {
  id: number
  title: string
  romaji: string | null
  year: number | null
  format: string | null
  episodes: number | null
  cover: string | null
}

export const searchAniList = (query: string) =>
  api<{ results: AniListSearchResult[] }>(`/api/anilist/search?q=${encodeURIComponent(query)}`)

export const setMappingOverride = (libraryKey: string, anilistId: number | null) =>
  api<{ ok: boolean; anilist_id: number | null }>('/api/mapping-overrides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_key: libraryKey, anilist_id: anilistId }),
  })

export const setSeasonMappingOverride = (libraryKey: string, season: number, anilistIds: number[] | null) =>
  api<{ ok: boolean; season: number; anilist_ids: number[] | null }>('/api/mapping-overrides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_key: libraryKey, season, anilist_ids: anilistIds }),
  })

export const setExclusion = (libraryKey: string, season: number | null, part: string, excluded: boolean) =>
  api<{ ok: boolean; excluded: boolean }>('/api/exclusions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_key: libraryKey, season, part, excluded }),
  })

export const getLogs = (lines = 500) => api<{ lines: string[]; total: number }>(`/api/logs?lines=${lines}`)

export const startScan = () => api<{ ok: boolean; error?: string }>('/api/scan', { method: 'POST' })

export const cancelScan = () => api<{ ok: boolean; error?: string }>('/api/scan/cancel', { method: 'POST' })

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** One review row: a result key and release index, with the identity the browser saw and, in `choose` mode, the protocol. */
export type SelectionInput = DownloadSelection

export type {
  UsenetAvailabilityResponse,
  UsenetAvailabilityResult,
  UsenetHashAvailability,
  UsenetUnitState,
} from '../../shared/usenet-contracts.js'
import type { UsenetAvailabilityRequest, UsenetAvailabilityResponse } from '../../shared/usenet-contracts.js'

let allDownloadProgressRequest: Promise<AllDownloadProgress> | null = null

/** Coalesce concurrent reads of the authoritative client snapshot. */
export const getAllDownloadProgress = (): Promise<AllDownloadProgress> => {
  if (!allDownloadProgressRequest) {
    const request = api<AllDownloadProgress>('/api/downloads').finally(() => {
      if (allDownloadProgressRequest === request) allDownloadProgressRequest = null
    })
    allDownloadProgressRequest = request
  }
  return allDownloadProgressRequest
}

export const DOWNLOAD_PROGRESS_INVALIDATED_EVENT = 'seadex:download-progress-invalidated'
export const invalidateDownloadProgress = () => {
  allDownloadProgressRequest = null
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(DOWNLOAD_PROGRESS_INVALIDATED_EVENT))
}

export const controlDownload = (record_id: string, action: DownloadAction, deleteFiles = false) =>
  api<{ ok: boolean; error?: string }>('/api/download_control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id, action, delete_files: deleteFiles }),
  })

export const preflightDownload = (selections: SelectionInput[], refresh = false, signal?: AbortSignal) =>
  api<DownloadPreflight>(
    '/api/download_bulk/preflight',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections, refresh: refresh || undefined }),
      signal,
    },
    null,
  )

/** Work an availability request starts or stops for some of its rows. An empty list is left out of the request. */
export type UsenetAvailabilityWork = Pick<UsenetAvailabilityRequest, 'search' | 'verify' | 'cancel_verify'>

const rowRefs = (rows: { key: string; release: number }[] | undefined) =>
  rows?.length ? rows.map(({ key, release }) => ({ key, release })) : undefined

export const usenetAvailability = (
  selections: SelectionInput[],
  refresh = false,
  signal?: AbortSignal,
  /**
   * `search`: rows to search Prowlarr for now, checking up to three NZBs each. `verify`: rows selected for
   * download, whose best candidate is checked. Every checked NZB counts toward an indexer's download limit.
   * `cancel_verify`: rows whose queued check is no longer wanted.
   */
  work: UsenetAvailabilityWork = {},
  init: Pick<RequestInit, 'keepalive'> = {},
) =>
  api<UsenetAvailabilityResponse>(
    '/api/usenet/availability',
    {
      ...init,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selections,
        refresh: refresh || undefined,
        search: rowRefs(work.search),
        verify: rowRefs(work.verify),
        cancel_verify: rowRefs(work.cancel_verify),
      }),
      signal,
    },
    null,
  )

/**
 * Tells the server that nobody waits for these checks any more. Nothing depends on the answer: a check that
 * already fetches its NZB finishes, and one still queued is dropped.
 */
export const cancelUsenetChecks = (rows: SelectionInput[]): void => {
  if (!rows.length) return
  const selections = rows.map(({ key, release, identity }) => ({ key, release, identity }))
  // `keepalive` lets the request outlive a page that is being closed.
  void usenetAvailability(selections, false, undefined, { cancel_verify: selections }, { keepalive: true }).catch(
    () => {},
  )
}

let usenetAvailabilityRevision = 0
const usenetAvailabilitySubscribers = new Set<() => void>()
export const getUsenetAvailabilityRevision = () => usenetAvailabilityRevision
export const subscribeUsenetAvailability = (listener: () => void) => {
  usenetAvailabilitySubscribers.add(listener)
  return () => {
    usenetAvailabilitySubscribers.delete(listener)
  }
}
export const invalidateUsenetAvailability = () => {
  usenetAvailabilityRevision += 1
  for (const listener of usenetAvailabilitySubscribers) listener()
}

let usenetConfigScope: string | null = null
function rememberAvailabilityConfig(config: Config, credentialsChanged = false) {
  const scope = availabilityFingerprint(config)
  const changed = usenetConfigScope !== null && usenetConfigScope !== scope
  usenetConfigScope = scope
  if (changed || credentialsChanged) invalidateUsenetAvailability()
}

/**
 * How a single send ended: the client took the release, refused it with a reason, or was asked but never confirmed
 * (`acceptance_unknown`), in which case that client must be checked before the release is sent again.
 */
export type SendOutcome =
  | { kind: 'sent'; client: DownloadClient }
  | { kind: 'rejected'; reason: string }
  | { kind: 'acceptance_unknown'; client: DownloadClient; reason?: string }

/** Whether a receipt, or the body of a refused send, says the client was asked but did not confirm. */
const acceptanceUnknown = (body: Partial<DownloadReceipt> | Record<string, unknown>) =>
  body.acceptance_unknown === true ||
  (Array.isArray(body.failures) &&
    body.failures.some(failure => (failure as Partial<DownloadUnitFailure> | null)?.code === 'acceptance_unknown'))

/** One-shot send of a reviewed single-release plan. Awaits the full client mutation. */
export async function sendDownload(
  plan_id: string,
  protocol: DownloadProtocol,
  acknowledge?: DownloadAcknowledge,
): Promise<SendOutcome> {
  let receipt: DownloadReceipt
  try {
    receipt = await api<DownloadReceipt>(
      '/api/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id, acknowledge }),
      },
      120_000,
    )
  } catch (error) {
    if (!(error instanceof SubmissionError)) throw error
    if (!error.detail || !acceptanceUnknown(error.detail)) return { kind: 'rejected', reason: error.message }
    const named = error.detail.client
    const client = named === 'sabnzbd' || named === 'qbittorrent' ? named : protocolClient(protocol)
    return { kind: 'acceptance_unknown', client, reason: error.message }
  }
  if (acceptanceUnknown(receipt)) return { kind: 'acceptance_unknown', client: receipt.client }
  if (!receipt.ok) return { kind: 'rejected', reason: receipt.error || 'The download client rejected the submission' }
  return { kind: 'sent', client: receipt.client }
}

/** Background submission of a reviewed plan. */
export const startDownloadJob = (plan_id: string, acknowledge?: DownloadAcknowledge) =>
  api<{ ok: true; job_id: string }>(
    '/api/download-jobs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id, acknowledge }),
    },
    60_000,
  )

export const getDownloadJobStatus = (id?: string) =>
  api<DownloadJobStatus>(`/api/download-jobs/${id ? encodeURIComponent(id) : 'latest'}`)

export const getCancelableDownloads = () =>
  api<{ ok: boolean; items: CancelableDownload[]; error?: string }>('/api/downloads/cancelable')

export const cancelDownloads = (record_ids: string[], removeFiles: boolean) =>
  api<DownloadCancelResult>(
    '/api/downloads/cancel',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_ids, remove_files: removeFiles }),
    },
    120_000,
  )

/** Resume/await observation of a running bulk job by id. */
export const followJob = followDownloadJob
