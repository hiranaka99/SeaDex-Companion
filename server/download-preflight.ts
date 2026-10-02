import { estimateDownloads, type DiskSpaceCheck, type DownloadPreflight, type EstimatableRelease } from '../shared/download-estimate.js'
import { qbGetDownloadStorage, qbGetTorrents } from './app.js'
import type { Config } from './types.js'

export async function downloadPreflight(config: Config, selections: { release: EstimatableRelease; category: string }[]): Promise<DownloadPreflight> {
  if (!selections.length) return { ...estimateDownloads([]), disk_space: [] }
  const existing = await qbGetTorrents(config)
  const estimate = estimateDownloads(selections, existing.map(torrent => String(torrent.hash || '')))
  const fresh = estimate.torrents.filter(torrent => !torrent.existing)
  const locations = await qbGetDownloadStorage(config, [...new Set(fresh.map(torrent => torrent.category))])
  const checks = new Map<string, DiskSpaceCheck>()
  for (const location of locations) {
    const key = location.path || `unknown:${location.category}`
    const check = checks.get(key) || { path: location.path, categories: [], required_bytes: 0, unknown_torrents: 0, free_bytes: location.free_bytes, sufficient: null, reason: location.reason }
    if (!check.categories.includes(location.category)) {
      check.categories.push(location.category)
      const torrents = fresh.filter(torrent => torrent.category === location.category)
      check.required_bytes += torrents.reduce((sum, torrent) => sum + (torrent.bytes || 0), 0)
      check.unknown_torrents += torrents.filter(torrent => torrent.bytes === null || torrent.approximate).length
    }
    checks.set(key, check)
  }
  for (const check of checks.values()) {
    check.sufficient = check.free_bytes === null ? null : check.required_bytes > check.free_bytes ? false : check.unknown_torrents ? null : true
  }
  return { ...estimate, disk_space: [...checks.values()] }
}
