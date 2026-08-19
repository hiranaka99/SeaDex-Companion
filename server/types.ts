export type JsonObject = Record<string, any>

export interface Config extends JsonObject {
  sonarr_url: string
  sonarr_key: string
  radarr_url: string
  radarr_key: string
  sonarr_category: string
  radarr_category: string
  qbittorrent_url: string
  qbittorrent_user: string
  qbittorrent_pass: string
  webhook: string
  notify_enabled: boolean
  autocheck_minutes: number
  hidden: string[]
}

export interface ScanState {
  running: boolean
  progress: number
  total: number
  message: string
  results: JsonObject[]
  error: string | null
  last_run: string | null
}

export interface ReleaseCandidate extends JsonObject {
  releaseGroup: string
  tracker: string
  quality: string
  tags: string[]
  dual_audio?: boolean
  size: number
  file_count: number
  info_hashes: string[]
  is_best: boolean
}

export interface ChainPart extends JsonObject {
  id: number
  episodeCount: number | null
}

export interface ChainEntry extends JsonObject {
  season: number
  id: number
  ids: number[]
  parts: ChainPart[]
  cover?: string | null
  banner?: string | null
}
