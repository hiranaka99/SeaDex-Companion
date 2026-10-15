import { useRef, useState, useSyncExternalStore } from 'react'
import { getDownloadSnapshot, subscribeDownloads, sendDownload, controlDownload } from './download-store'
import { releaseIdentity } from '../../shared/releases'
import { releaseOwned } from '../../shared/download-plan'
import type { GroupedCard } from './types'
import type { DownloadAction } from './api'
import type { DownloadEntry } from './components/DownloadsPanel'
import type { DetailsDownloadState } from './components/ReleaseDetails'
import { seasonLabel } from './utils'

export const IDLE_DOWNLOAD: DetailsDownloadState = { phase: 'idle', progress: 0, downloaded: 0, total_size: 0, speed: 0 }

/** Cards select retained server state. Commands keep running when a page unmounts. */
export function useCardDownloads(group: GroupedCard, notify: (message: string, tone: 'success' | 'error') => void) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)
  const dlBySeason: Record<string, Record<number, DetailsDownloadState>> = {}
  const activeDownloads: DownloadEntry[] = []
  for (const season of group.seasons) for (const [index, release] of season.releases.entries()) {
    const identity = releaseIdentity(release)
    const id = `${season.key}\0${index}`
    const progress = snapshot[id]
    if (!progress?.found || (progress.identity && progress.identity !== identity) || releaseOwned(season, release)) continue
    const phase: DetailsDownloadState['phase'] = progress.state === 'complete' ? 'complete' : progress.state === 'paused' ? 'paused' : progress.state === 'error' ? 'error' : progress.state === 'sending' ? 'sending' : 'downloading'
    const state = { phase, progress: progress.progress, downloaded: progress.downloaded, total_size: progress.total_size, speed: progress.speed }
    ;(dlBySeason[season.key] ||= {})[index] = state
    if (phase !== 'complete') activeDownloads.push({ id, season: seasonLabel(season), releaseGroup: release.releaseGroup, seasonKey: season.key, release: index, identity, ...state, phase })
  }
  const handleDownload = async (key: string, index: number) => {
    const release = group.seasons.find(season => season.key === key)?.releases[index]
    if (!release) return
    try { await sendDownload(key, index, releaseIdentity(release)) }
    catch (error) { notify(`Download failed: ${error instanceof Error ? error.message : String(error)}`, 'error') }
  }
  const handleDownloadAction = async (entry: DownloadEntry, action: DownloadAction, deleteFiles = false): Promise<boolean> => {
    if (controlling.current) return false
    controlling.current = true; setBusyDownload(entry.id)
    try {
      await controlDownload(entry.seasonKey, entry.release, action, deleteFiles, entry.identity)
      if (action === 'remove') notify(deleteFiles ? 'Torrent and files removed from qBittorrent' : 'Torrent removed; downloaded files were kept', 'success')
      return true
    } catch (error) { notify(`Could not ${action} torrent: ${error instanceof Error ? error.message : String(error)}`, 'error'); return false }
    finally { controlling.current = false; setBusyDownload(null) }
  }
  return { dlBySeason, activeDownloads, busyDownload, handleDownload, handleDownloadAction }
}
