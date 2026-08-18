import { Config, ResultItem, Status } from './types'

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, opts)
  if (!r.ok) {
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

export const getConfig = () => api<Config>('/api/config')

export const saveConfig = (cfg: Partial<Config>) =>
  api<Config>('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
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
