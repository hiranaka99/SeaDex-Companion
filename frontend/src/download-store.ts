import * as api from './api.js'
import type { DownloadProgress } from '../../shared/download-contracts.js'
import { normalizeTorrentPath, planTorrents } from '../../shared/download-plan.js'
import type { ResultItem } from './types.js'

/** Attach records only where their source and effective file scope still cover the recommendation. */
export function currentDownloadAssociations(progress: DownloadProgress, seasons: ResultItem[]): DownloadProgress['associations'] {
  const seen = new Set<string>()
  const scope = progress.scope && new Set(progress.scope.map(normalizeTorrentPath))
  return progress.associations.filter(ref => {
    const id = `${ref.key}\u0000${ref.release}`
    if (seen.has(id)) return false
    seen.add(id)
    const release = seasons.find(season => season.key === ref.key)?.releases[ref.release]
    if (!release) return false
    if (progress.protocol === 'usenet') return release.info_hashes.some(hash => hash.toLowerCase() === progress.source_hash.toLowerCase())
    const source = planTorrents([{ release, category: progress.category }]).find(source => source.hash === progress.source_hash.toLowerCase())
    if (!source) return false
    return !scope || Boolean(source.selectedFiles?.length && source.selectedFiles.every(name => scope.has(normalizeTorrentPath(name))))
  })
}

const listeners = new Set<() => void>()
let snapshot: Record<string, DownloadProgress> = {}
let unavailableClients: api.AllDownloadProgress['unavailable_clients']
let timer: number | undefined
let polling = false
let generation = 0
let pending: Promise<void> | undefined
const emit = () => { for (const listener of listeners) listener() }

/** Progress rows keyed by download record_id. */
export const getDownloadSnapshot = () => snapshot
export const getUnavailableClients = () => unavailableClients

export function refreshDownloads(): Promise<void> {
  if (pending) return pending
  const current = generation
  const request = api.getAllDownloadProgress().then(all => {
    if (current !== generation) return
    snapshot = all.downloads
    unavailableClients = all.unavailable_clients
    emit()
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

/** Force a fresh read of the server snapshot after a command completes. */
export async function reloadDownloads(): Promise<void> {
  generation += 1; pending = undefined; api.invalidateDownloadProgress()
  await refreshDownloads().catch(() => {})
}

export async function controlDownload(recordId: string, action: api.DownloadAction, deleteFiles = false): Promise<void> {
  const result = await api.controlDownload(recordId, action, deleteFiles)
  if (!result.ok) throw new Error(result.error || `Could not ${action} the download`)
  await reloadDownloads()
}

// Batch submissions and completions refresh the same retained store as card commands.
if (typeof window !== 'undefined') window.addEventListener(api.DOWNLOADS_CHANGED_EVENT, () => { void reloadDownloads() })
if (typeof window !== 'undefined') window.addEventListener(api.DOWNLOAD_PROGRESS_INVALIDATED_EVENT, () => {
  generation += 1; pending = undefined
  if (listeners.size) void refreshDownloads().catch(() => {})
})
