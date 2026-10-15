export interface DownloadProgress {
  identity?: string
  missing_torrents?: number
  ok: boolean
  found: boolean
  progress: number
  downloaded: number
  total_size: number
  speed: number
  state: string
  error?: string
}

export interface AllDownloadProgress {
  ok: boolean
  downloads: Record<string, DownloadProgress>
}

export interface BulkDownloadTarget {
  key: string
  release: number
  identity?: string
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
  existing?: string[]
  error?: string
}

/** Live per-torrent state of the in-flight bulk download batch. */
export interface BulkDownloadStatus extends Omit<import('./download-jobs.js').DownloadJob, 'id'> {
  id: string | null
  ok: boolean
}

export interface CancelableDownload {
  result_keys: string[]
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
