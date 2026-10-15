import { normalizeTorrentPath as normalizePath, planTorrents } from './download-plan.js'
export interface TorrentFiles {
  hash: string
  files: { name: string; length: number }[]
}

export interface EstimatableRelease {
  info_hashes: string[]
  size?: number
  selected_files?: string[]
  torrent_files?: TorrentFiles[]
}

export interface EstimatedTorrent {
  hash: string
  category: string
  bytes: number | null
  approximate: boolean
  selected_file_count: number | null
  existing: boolean
}

export interface DownloadEstimate {
  torrents: EstimatedTorrent[]
  new_bytes: number
  new_torrents: number
  existing_torrents: number
  unknown_torrents: number
  approximate_torrents: number
  selected_file_count: number
  whole_torrents: number
}

export interface DiskSpaceCheck {
  path: string | null
  categories: string[]
  required_bytes: number
  unknown_torrents: number
  free_bytes: number | null
  sufficient: boolean | null
  reason?: string
}

export interface DownloadPreflight extends DownloadEstimate {
  disk_space: DiskSpaceCheck[]
}

const validBytes = (size: unknown): size is number => typeof size === 'number' && Number.isSafeInteger(size) && size >= 0

/** Mirrors bulk add: a hash is added once, file scopes are united, and any whole-torrent request wins. */
export function estimateDownloads(selections: { release: EstimatableRelease; category: string }[], existingHashes: string[] = []): DownloadEstimate {
  const existing = new Set(existingHashes.map(hash => hash.toLowerCase()))
  const torrents: EstimatedTorrent[] = planTorrents(selections).map(entry => {
    const { hash, category } = entry
    const whole = !entry.selectedFiles
    const wanted = new Set((entry.selectedFiles || []).map(normalizePath))
    const files = new Map<string, number>()
    let invalidMetadata = false
    for (const release of entry.releases) for (const metadata of release.torrent_files || []) {
      if (metadata.hash.toLowerCase() !== hash) continue
      if (!metadata.files.length || metadata.files.some(file => !file.name || !validBytes(file.length))) invalidMetadata = true
      for (const file of metadata.files) if (file.name && validBytes(file.length)) files.set(normalizePath(file.name), Math.max(files.get(normalizePath(file.name)) || 0, file.length))
    }
    let bytes: number | null = null
    let approximate = false
    const requested = whole ? [...files.keys()] : [...wanted]
    if (!invalidMetadata && files.size && requested.length && requested.every(name => files.has(name))) {
      bytes = requested.reduce((sum, name) => sum + files.get(name)!, 0)
    } else {
      // Old saved results have only a release total. Never divide a multi-hash
      // total or sum overlapping scopes: neither reveals each torrent's size.
      const singleHash = entry.releases.every(release => new Set(release.info_hashes.map(hash => hash.toLowerCase())).size === 1)
      const scopes = new Set(entry.releases.map(release => JSON.stringify((release.selected_files || []).map(normalizePath).sort())))
      const sizes = entry.releases.filter(release => !whole || !release.selected_files?.length).map(release => release.size)
      if (singleHash && (whole || scopes.size === 1) && sizes.length && sizes.every(size => validBytes(size) && size > 0)) {
        bytes = Math.max(...sizes as number[])
        approximate = true
      }
    }
    return { hash, category, bytes, approximate, selected_file_count: whole ? null : wanted.size, existing: existing.has(hash) }
  })
  const fresh = torrents.filter(torrent => !torrent.existing)
  return {
    torrents, new_bytes: fresh.reduce((sum, torrent) => sum + (torrent.bytes || 0), 0),
    new_torrents: fresh.length, existing_torrents: torrents.length - fresh.length,
    unknown_torrents: fresh.filter(torrent => torrent.bytes === null).length,
    approximate_torrents: fresh.filter(torrent => torrent.approximate).length,
    selected_file_count: fresh.reduce((sum, torrent) => sum + (torrent.selected_file_count || 0), 0),
    whole_torrents: fresh.filter(torrent => torrent.selected_file_count === null).length,
  }
}
