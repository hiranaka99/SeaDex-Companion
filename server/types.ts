export type JsonObject = Record<string, any>

export interface ScanSchedule extends JsonObject {
  enabled: boolean
  mode: 'interval' | 'daily' | 'weekly'
  interval_minutes: number
  times: string[]
  weekdays: number[]
  timezone: string
  missed_run: 'run_once' | 'skip'
}

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
  scan_schedule: ScanSchedule
  hidden: string[]
}

export type ScanTrigger = 'manual' | 'scheduled' | 'sonarr' | 'radarr' | 'sonarr+radarr'

export interface ScanScope {
  sonarrIds?: number[]
  radarrIds?: number[]
}

export interface ScanState {
  running: boolean
  progress: number
  total: number
  message: string
  results: JsonObject[]
  error: string | null
  last_run: string | null
  cancelled: boolean
  trigger: ScanTrigger | null
  source_errors: Record<string, string>
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
  source_files?: { name: string; length: number }[]
  selected_files?: string[]
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
