import type { DownloadMode } from './download-contracts.js'

export interface AuthState {
  setup_required: boolean
  authenticated: boolean
  username: string | null
}

export interface Release {
  kind: 'best' | 'alt'
  part?: string
  url?: string
  releaseGroup: string
  tracker: string
  quality: string
  tags: string[]
  dual_audio?: boolean
  size: number
  info_hashes: string[]
  /** Static availability of usable torrent hashes. Usenet availability is a separate lookup. */
  torrent_available: boolean
  selected_files?: string[]
  torrent_files?: import('./download-estimate.js').TorrentFiles[]
}

export interface ResultItem {
  unseen_changes?: ReleaseChange[]
  key: string
  group_id: number | null
  arr: string
  title: string
  season: number | null
  status: 'upgrade' | 'best' | 'missing' | 'partial' | 'uncovered'
  match_status?: 'matched' | 'unmatched'
  missing_episode_count?: number
  upgrade_available?: boolean
  have: string[]
  have_by_part?: Record<string, string[]>
  owned_by_part?: Record<string, string[]>
  local_size_by_part?: Record<string, number>
  precise_part_ownership?: boolean
  local_size: number
  best_group: string | null
  best_size: number
  releases: Release[]
  url: string | null
  urls?: { label: string; url: string }[]
  unavailable_parts?: { label: string; reason: string }[]
  notes: string | null
  notes_by_part?: Record<string, string>
  image: string | null
  banner: string | null
  anilist_id: number | null
  anilist_ids?: number[]
  arr_url: string | null
  library_key?: string
  mapping_override?: boolean
  season_mapping_override?: boolean
  excluded?: boolean
  excluded_parts?: string[]
}

export interface ReleaseChangeDetail {
  kind: 'best' | 'alternative' | 'updated' | 'removed'
  description: string
  part?: string
  release_replacement?: { previous: string; next: string; torrent_changed: boolean }
  note_change?: { previous: string | null; next: string | null }
}

export interface ReleaseChange extends ReleaseChangeDetail {
  id: string
  detected_at: string
}

export interface ScanHistoryChange {
  library_key?: string
  type: 'new' | 'upgrade' | 'resolved' | 'changed' | 'removed'
  key: string
  title: string
  arr: string
  season: number
  best_group: string | null
  from: string | null
  to: string | null
  details?: string[]
  release_changes?: ReleaseChangeDetail[]
}

export interface ScanHistoryEntry {
  id: string
  run_at: string
  trigger?: 'manual' | 'scheduled' | 'sonarr' | 'radarr' | 'sonarr+radarr'
  duration_seconds?: number
  outcome?: 'success' | 'partial' | 'cancelled' | 'failed'
  scanned_titles?: number
  source_errors?: Record<string, string>
  error?: string
  counts: Record<string, number>
  changes: ScanHistoryChange[]
}

export interface ScannedDataInfo {
  cache_entries: number
  results: number
  last_run: string | null
  cache_valid: boolean
  results_valid: boolean
}

export interface ScanSchedule {
  enabled: boolean
  mode: 'interval' | 'daily' | 'weekly'
  interval_minutes: number
  times: string[]
  weekdays: number[]
  timezone: string
  missed_run: 'run_once' | 'skip'
}

export interface Config {
  sonarr_url: string
  sonarr_key: string
  radarr_url: string
  radarr_key: string
  sonarr_category: string
  radarr_category: string
  qbittorrent_url: string
  qbittorrent_user: string
  qbittorrent_pass: string
  download_mode: DownloadMode
  sabnzbd_url: string
  sabnzbd_key: string
  sabnzbd_sonarr_category: string
  sabnzbd_radarr_category: string
  animetosho_enabled: boolean
  animetosho_url: string
  amenzb_enabled: boolean
  amenzb_url: string
  amenzb_key: string
  webhook: string
  notify_enabled: boolean
  unhide_on_new_best: boolean
  datetime_format: string
  scan_schedule: ScanSchedule
  hidden: string[]
}

export interface PublicConfig extends Config {
  sonarr_key_configured: boolean
  radarr_key_configured: boolean
  qbittorrent_pass_configured: boolean
  sabnzbd_key_configured: boolean
  amenzb_key_configured: boolean
  webhook_configured: boolean
}

export type SecretConfigKey = 'sonarr_key' | 'radarr_key' | 'qbittorrent_pass' | 'sabnzbd_key' | 'amenzb_key' | 'webhook'
export type ConfigUpdate = Partial<Config> & { clear_secrets?: SecretConfigKey[] }

export interface Status {
  results_revision?: string
  running: boolean
  progress: number
  total: number
  message: string
  error: string | null
  cancelled: boolean
  trigger: 'manual' | 'scheduled' | 'sonarr' | 'radarr' | 'sonarr+radarr' | null
  source_errors: Record<string, string>
  last_run: string | null
  next_check: number | null
  webhook_scan: { queued: boolean; due_at: number | null; sources: Array<'sonarr' | 'radarr'> }
  /** Background Usenet availability sweep; absent or not running when idle. */
  usenet_prefetch?: {
    running: boolean
    checked: number
    total: number
    /** Providers the sweep is waiting on after rate limiting or repeated failures. */
    paused?: { provider: 'animetosho' | 'amenzb'; resume_in_seconds: number; rate_limited: boolean }[]
  }
}
