import * as api from './api.js'

const listeners = new Set<() => void>()
let snapshot: Record<string, api.DownloadProgress> = {}
let optimistic: Record<string, api.DownloadProgress> = {}
let timer: number | undefined
let polling = false
let generation = 0
let pending: Promise<void> | undefined
const emit = () => { for (const listener of listeners) listener() }

export const getDownloadSnapshot = () => snapshot

export function refreshDownloads(): Promise<void> {
  if (pending) return pending
  const current = generation
  const request = api.getAllDownloadProgress().then(({ downloads }) => {
    if (current !== generation) return
    snapshot = { ...downloads, ...optimistic }; emit()
  }).finally(() => { if (pending === request) pending = undefined })
  pending = request
  return request
}

function schedule(): void {
  timer = undefined
  void refreshDownloads().catch(() => {}).finally(() => {
    if (listeners.size) timer = window.setTimeout(schedule, 3000)
    else polling = false
  })
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener)
  if (!polling) { polling = true; schedule() }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer !== undefined) { window.clearTimeout(timer); timer = undefined; polling = false }
  }
}

function change(id: string, progress: api.DownloadProgress | null): void {
  optimistic = { ...optimistic }
  if (progress) optimistic[id] = progress; else delete optimistic[id]
  snapshot = { ...snapshot }
  if (progress) snapshot[id] = progress; else delete snapshot[id]
  emit()
}

async function reload(): Promise<void> {
  generation += 1; pending = undefined; api.invalidateDownloadProgress()
  await refreshDownloads().catch(() => {})
}

export async function sendDownload(key: string, release: number, identity: string): Promise<void> {
  const id = `${key}\0${release}`
  change(id, { ok: true, found: true, identity, state: 'sending', progress: 0, downloaded: 0, total_size: 0, speed: 0 })
  try {
    const result = await api.download(key, release, identity)
    if (!result.ok) throw new Error(result.error || 'Download failed')
  } finally { change(id, null); await reload() }
}

export async function controlDownload(key: string, release: number, action: api.DownloadAction, deleteFiles: boolean, identity?: string): Promise<void> {
  await api.controlDownload(key, release, action, deleteFiles, identity)
  const id = `${key}\0${release}`
  if (action === 'remove') change(id, null)
  await reload()
}

// Batch submissions and completions refresh the same retained store as card commands.
if (typeof window !== 'undefined') window.addEventListener(api.DOWNLOADS_CHANGED_EVENT, () => { void reload() })
if (typeof window !== 'undefined') window.addEventListener(api.DOWNLOAD_PROGRESS_INVALIDATED_EVENT, () => {
  generation += 1; pending = undefined
  if (listeners.size) void refreshDownloads().catch(() => {})
})
