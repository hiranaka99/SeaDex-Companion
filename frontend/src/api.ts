import { AuthState, Config, ResultItem, Status } from './types'

export const AUTH_REQUIRED_EVENT = 'seadex:authentication-required'

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, opts)
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

export const getConfig = () => api<Config>('/api/config')

export const clearScannedData = () =>
  api<{ ok: boolean; cleared: { cacheEntries: number; results: number } }>('/api/scanned-data', { method: 'DELETE' })

export const saveConfig = (cfg: Partial<Config>) =>
  api<Config>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })

export const testConnection = (service: 'sonarr' | 'radarr' | 'qbittorrent' | 'discord', config: Record<string, any>) =>
  api<{ ok: boolean; message: string }>('/api/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, config }),
  })

export const getStatus = () => api<Status>('/api/status')

export const getResults = () =>
  api<{ results: ResultItem[]; last_run: string | null }>('/api/results')

export const getLogs = (lines = 500) =>
  api<{ lines: string[]; total: number }>(`/api/logs?lines=${lines}`)

export const startScan = () =>
  api<{ ok: boolean; error?: string }>('/api/scan', { method: 'POST' })

export const setHidden = (key: string, hidden: boolean) =>
  api<{ ok: boolean; hidden: string[] }>('/api/hidden', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, hidden }),
  })

export const download = (key: string, release: number) =>
  api<{ ok: boolean; error?: string }>('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, release }),
  })

export interface DownloadProgress {
  ok: boolean
  found: boolean
  progress: number
  downloaded: number
  total_size: number
  speed: number
  state: string
  error?: string
}

export const getDownloadProgress = (key: string, release: number) =>
  api<DownloadProgress>(
    `/api/download_progress?key=${encodeURIComponent(key)}&release=${release}`,
  )

export interface AllDownloadProgress {
  ok: boolean
  downloads: Record<string, DownloadProgress>
}

let allDownloadProgressRequest: Promise<AllDownloadProgress> | null = null

/** Coalesce the initial probe from every mounted card into one qBittorrent snapshot. */
export const getAllDownloadProgress = (): Promise<AllDownloadProgress> => {
  allDownloadProgressRequest ||= api<AllDownloadProgress>('/api/download_progress/all')
    .finally(() => { allDownloadProgressRequest = null })
  return allDownloadProgressRequest
}

export type DownloadAction = 'pause' | 'resume' | 'remove'

export const controlDownload = (key: string, release: number, action: DownloadAction, deleteFiles = false) =>
  api<{ ok: boolean; error?: string }>('/api/download_control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, release, action, delete_files: deleteFiles }),
  })

export const DOWNLOADS_CHANGED_EVENT = 'seadex:downloads-changed'

export interface BulkDownloadTarget {
  key: string
  release: number
}

export interface BulkDownloadFailure {
  hash: string
  label: string
  error: string
}

export interface BulkDownloadResult {
  ok: boolean
  count: number
  targets: BulkDownloadTarget[]
  failures?: BulkDownloadFailure[]
  error?: string
}

/** Live per-torrent state of the in-flight bulk download batch. */
export interface BulkDownloadStatus {
  ok: boolean
  finished: boolean
  pending: string[]
  added: string[]
  failures: BulkDownloadFailure[]
}

export const getBulkDownloadStatus = () =>
  api<BulkDownloadStatus>('/api/download_bulk/status')

export interface CancelableDownload {
  key: string
  release: number
  title: string
  season: number | null
  part: string
  release_group: string
  tracker: string
  size: number
  hashes: string[]
}

export const getCancelableBulkDownloads = () =>
  api<{ ok: boolean; downloads: CancelableDownload[]; error?: string }>('/api/download_bulk/cancelable')

export async function bulkDownloads(action: 'start' | 'cancel', selections: BulkDownloadTarget[] = [], deleteFiles = false): Promise<BulkDownloadResult> {
  const result = await api<BulkDownloadResult>('/api/download_bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, selections, delete_files: deleteFiles }),
  })
  window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT, { detail: { action, targets: result.targets } }))
  return result
}
