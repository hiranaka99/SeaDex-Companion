import type { AllDownloadProgress, BulkDownloadTarget, BulkDownloadResult, BulkDownloadStatus, CancelableDownload } from '../../shared/download-contracts.js'
export type { DownloadProgress, AllDownloadProgress, BulkDownloadTarget, BulkDownloadFailure, BulkDownloadResult, BulkDownloadStatus, CancelableDownload } from '../../shared/download-contracts.js'
import { waitForDownloadJob } from './bulk-job-store.js'
export { watchBulkDownloadStatus } from './bulk-job-store.js'
import type { AuthState, Config, ResultItem, ScanHistoryEntry, ScannedDataInfo, Status } from './types.js'

export const AUTH_REQUIRED_EVENT = 'seadex:authentication-required'

async function api<T = unknown>(path: string, opts: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  const r = await fetch(path, { ...opts, signal })
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    }
    let msg = `Request failed (${r.status})`
    try {
      const j = await r.json()
      if (j && j.error) msg = j.error
    } catch {
      /* body was not JSON */
    }
    throw new Error(msg)
  }
  return r.json()
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, current_password: currentPassword, new_password: newPassword }),
  })

export const getConfig = () => api<Config>('/api/config')

export const clearScannedData = () =>
  api<{ ok: boolean; cleared: { cacheEntries: number; results: number } }>('/api/scanned-data', { method: 'DELETE' })

export const getScannedDataInfo = () => api<{ ok: boolean } & ScannedDataInfo>('/api/scanned-data')

export const saveConfig = (cfg: import('../../shared/contracts.js').ConfigUpdate) =>
  api<Config>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })


export const testConnection = (service: 'sonarr' | 'radarr' | 'qbittorrent' | 'discord', config: import('../../shared/contracts.js').ConfigUpdate) =>
  api<{ ok: boolean; message: string }>('/api/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, config }),
  })

export const getStatus = () => api<Status>('/api/status')

export const checkForUpdates = () => api<{ current: string; latest: string | null; url: string | null }>('/api/update-check')

export const getResults = () =>
  api<{ results: ResultItem[]; last_run: string | null; hidden?: string[] }>('/api/results')

export const getScanHistory = () => api<{ scans: ScanHistoryEntry[] }>('/api/history')

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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_key: libraryKey, anilist_id: anilistId }),
  })

export const setExclusion = (libraryKey: string, season: number | null, part: string, excluded: boolean) =>
  api<{ ok: boolean; excluded: boolean }>('/api/exclusions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ library_key: libraryKey, season, part, excluded }),
  })

export const getLogs = (lines = 500) =>
  api<{ lines: string[]; total: number }>(`/api/logs?lines=${lines}`)

export const startScan = () =>
  api<{ ok: boolean; error?: string }>('/api/scan', { method: 'POST' })

export const cancelScan = () =>
  api<{ ok: boolean; error?: string }>('/api/scan/cancel', { method: 'POST' })

export const setHidden = (key: string, hidden: boolean) =>
  api<{ ok: boolean; hidden: string[] }>('/api/hidden', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, hidden }),
  })

export const download = (key: string, release: number, identity?: string) =>
  api<{ ok: boolean; error?: string }>('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, release, identity }),
  })

let allDownloadProgressRequest: Promise<AllDownloadProgress> | null = null

/** Coalesce concurrent reads of the authoritative qBittorrent snapshot. */
export const getAllDownloadProgress = (): Promise<AllDownloadProgress> => {
  if (!allDownloadProgressRequest) {
    const request = api<AllDownloadProgress>('/api/download_progress/all')
      .finally(() => { if (allDownloadProgressRequest === request) allDownloadProgressRequest = null })
    allDownloadProgressRequest = request
  }
  return allDownloadProgressRequest
}

export const DOWNLOAD_PROGRESS_INVALIDATED_EVENT = 'seadex:download-progress-invalidated'
export const invalidateDownloadProgress = () => {
  allDownloadProgressRequest = null
  if (typeof window !== 'undefined') window.dispatchEvent?.(new Event(DOWNLOAD_PROGRESS_INVALIDATED_EVENT))
}

export type DownloadAction = 'pause' | 'resume' | 'remove'

export const controlDownload = (key: string, release: number, action: DownloadAction, deleteFiles = false, identity?: string) =>
  api<{ ok: boolean; error?: string }>('/api/download_control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, release, action, delete_files: deleteFiles, identity }),
  })

export const DOWNLOADS_CHANGED_EVENT = 'seadex:downloads-changed'

export const getBulkDownloadPreflight = (selections: BulkDownloadTarget[], signal?: AbortSignal) =>
  api<import('../../shared/download-estimate.js').DownloadPreflight>('/api/download_bulk/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections }), signal,
  })

export const getBulkDownloadStatus = (id?: string) =>
  api<BulkDownloadStatus>(`/api/download-jobs/${id ? encodeURIComponent(id) : 'latest'}`)

export const getCancelableBulkDownloads = () =>
  api<{ ok: boolean; downloads: CancelableDownload[]; error?: string }>('/api/download_bulk/cancelable')

export async function bulkDownloads(action: 'start' | 'cancel', selections: BulkDownloadTarget[] = [], deleteFiles = false, onProgress?: (job: BulkDownloadStatus) => void): Promise<BulkDownloadResult> {
  let result: BulkDownloadResult
  if (action === 'start') {
    const accepted = await api<BulkDownloadStatus & { id: string }>('/api/download-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections }),
    })
    const job = await waitForDownloadJob(accepted, onProgress)
    result = { ok: job.added.length > 0, count: job.added.length, targets: job.targets, failures: job.failures, existing: job.existing }
  } else {
    result = await api<BulkDownloadResult>('/api/download_bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, selections, delete_files: deleteFiles }),
    })
  }
  window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT, { detail: { action, targets: result.targets } }))
  return result
}
