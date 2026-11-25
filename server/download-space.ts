import { configuredArrInstances } from './arr-instances.js'
import { sabSettings } from './client-identity.js'
import { qbGetDownloadStorage } from './qbittorrent.js'
import { sabDiskSpace } from './sabnzbd.js'
import { errorMessage } from '../shared/errors.js'
import type { DownloadClient } from '../shared/download-contracts.js'
import type { Config } from './types.js'

/** Free space where a download client stores new downloads, read on the client's own host. */
export interface DownloadSpaceLocation {
  client: DownloadClient
  /** The folder, or a description when the client does not name one. */
  label: string
  free_bytes: number | null
  reason?: string
}

/**
 * Free space for every destination the library can download to: qBittorrent's save path for each
 * configured category, and SABnzbd's completed folder. Nothing is read for a client the download
 * mode does not use. Failures are reported per destination rather than thrown.
 */
export async function downloadSpace(config: Config): Promise<DownloadSpaceLocation[]> {
  const locations: DownloadSpaceLocation[] = []
  if (config.download_mode !== 'usenet_only' && config.qbittorrent_url) {
    const categories = [...new Set(configuredArrInstances(config).map(instance => instance.category))]
    try {
      const seen = new Set<string>()
      for (const location of await qbGetDownloadStorage(config, categories)) {
        const label = location.path || `qBittorrent category ${location.category || '(none)'}`
        if (seen.has(label)) continue
        seen.add(label)
        locations.push({
          client: 'qbittorrent',
          label,
          free_bytes: location.free_bytes,
          ...(location.reason ? { reason: location.reason } : {}),
        })
      }
    } catch (error) {
      locations.push({
        client: 'qbittorrent',
        label: 'qBittorrent',
        free_bytes: null,
        reason: `Could not read qBittorrent storage: ${errorMessage(error).slice(0, 120)}`,
      })
    }
  }
  const sab = sabSettings(config)
  if (config.download_mode !== 'torrent_only' && sab) {
    try {
      const space = await sabDiskSpace(sab)
      locations.push({ client: 'sabnzbd', label: 'SABnzbd completed folder', free_bytes: space.complete_free_bytes })
    } catch (error) {
      locations.push({
        client: 'sabnzbd',
        label: 'SABnzbd completed folder',
        free_bytes: null,
        reason: `Could not read SABnzbd storage: ${errorMessage(error).slice(0, 120)}`,
      })
    }
  }
  return locations
}
