import type { DownloadMode } from './download-contracts.js'
import type { UsenetProvider } from './usenet-contracts.js'

export interface AuthState {
  setup_required: boolean
  authenticated: boolean
  username: string | null
}

export type ArrKind = 'sonarr' | 'radarr'

/** Which titles of one Sonarr or Radarr instance a scan considers. Empty lists mean no restriction. */
export interface LibraryScope {
  /** Sonarr only: keep series whose type is Anime. */
  anime_only: boolean
  /** Keep only titles carrying at least one of these tag labels. */
  include_tags: string[]
  /** Skip titles carrying any of these tag labels. */
  exclude_tags: string[]
  /** Keep only titles stored under one of these root folders. */
  root_folders: string[]
}

/** An additional Sonarr or Radarr instance. The first of each kind keeps its dedicated settings. */
export interface ArrInstanceConfig {
  /** Immutable identifier; part of result and rule keys. */
  id: string
  kind: ArrKind
  /** Unique display name, also used for scan errors. */
  name: string
  url: string
  key: string
  /** qBittorrent category this instance imports from. */
  category: string
  /** SABnzbd category this instance imports from. */
  sabnzbd_category: string
  scope: LibraryScope
}

export interface PublicArrInstance extends ArrInstanceConfig {
  key_configured: boolean
}

/** How a download target is chosen among the releases SeaDex lists for one season or cour. */
export interface ReleasePreferences {
  /** Which release to target when several qualify. */
  size: 'largest' | 'smallest'
  /** Target a dual-audio release whenever SeaDex lists one. */
  dual_audio: boolean
  /** Releases above this size per episode are never targeted. 0 disables the limit. */
  max_episode_gb: number
  ignored_groups: string[]
  ignored_trackers: string[]
  /** Owning a listed alternative counts as having the best release, and alternatives may be targeted. */
  accept_alternatives: boolean
  /** Only the targeted release counts as best; any other owned release stays upgradable. */
  strict: boolean
}

export interface Release {
  kind: 'best' | 'alt'
  part?: string
  /** The SeaDex page that lists this release. */
  url?: string
  releaseGroup: string
  tracker: string
  /** The release's own page on its tracker. */
  tracker_url?: string
  quality: string
  tags: string[]
  dual_audio?: boolean
  size: number
  info_hashes: string[]
  /** Static availability of usable torrent hashes. Usenet availability is a separate lookup. */
  torrent_available: boolean
  selected_files?: string[]
  torrent_files?: import('./download-estimate.js').TorrentFiles[]
  /** The release the saved preferences pick as the download target for its season or cour. */
  target?: boolean
  /** Owning this release makes its season or cour count as best. Absent means the release kind decides. */
  satisfies?: boolean
  /** The library's files are this release's files, byte for byte. Absent when they are not, or nothing was compared. */
  files_match?: boolean
  /** Why the saved preferences never offer this release for download. */
  excluded_by?: string
}

export interface ResultItem {
  unseen_changes?: ReleaseChange[]
  key: string
  group_id: number | null
  arr: string
  /** Identifier of an additional Sonarr/Radarr instance; absent for the first instance of each kind. */
  instance?: string
  /** Display name of that additional instance. */
  instance_name?: string
  title: string
  season: number | null
  status: 'upgrade' | 'best' | 'missing' | 'partial' | 'uncovered'
  match_status?: 'matched' | 'unmatched'
  missing_episode_count?: number
  upgrade_available?: boolean
  have: string[]
  have_by_part?: Record<string, string[]>
  owned_by_part?: Record<string, string[]>
  /** Release groups whose listed files match the local files byte for byte, by part. */
  verified_by_part?: Record<string, string[]>
  /** Release groups named in the local files whose sizes differ from the listed release, by part. */
  mismatched_by_part?: Record<string, string[]>
  /** SeaDex lists releases for this season, but the saved preferences accept none of them. */
  preference_blocked?: boolean
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
  kind: 'best' | 'alternative' | 'updated' | 'removed' | 'regression'
  description: string
  part?: string
  release_replacement?: { previous: string; next: string; torrent_changed: boolean }
  note_change?: { previous: string | null; next: string | null }
}

export interface ReleaseChange extends ReleaseChangeDetail {
  id: string
  detected_at: string
}

export type ScanTrigger = 'manual' | 'scheduled' | 'sonarr' | 'radarr' | 'sonarr+radarr' | 'import'

export interface ScanHistoryChange {
  library_key?: string
  type: 'new' | 'upgrade' | 'resolved' | 'changed' | 'removed' | 'regression'
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
  trigger?: ScanTrigger
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
  sonarr_scope: LibraryScope
  radarr_scope: LibraryScope
  /** Sonarr and Radarr instances beyond the first of each kind. */
  arr_instances: ArrInstanceConfig[]
  release_preferences: ReleasePreferences
  /** Compare local file sizes with the listed release before counting it as owned. */
  verify_release_files: boolean
  /** Maintain SeaDex status tags on series and movies in Sonarr and Radarr. */
  arr_tags_enabled: boolean
  arr_tag_best: string
  arr_tag_upgrade: string
  arr_tag_unlisted: string
  arr_tag_review: string
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
  /** Also notify when a finished download is not imported by Sonarr or Radarr. */
  notify_import_problems: boolean
  unhide_on_new_best: boolean
  datetime_format: string
  scan_schedule: ScanSchedule
  hidden: string[]
}

export const SECRET_CONFIG_KEYS = [
  'sonarr_key',
  'radarr_key',
  'qbittorrent_pass',
  'sabnzbd_key',
  'amenzb_key',
  'webhook',
] as const
export type SecretConfigKey = (typeof SECRET_CONFIG_KEYS)[number]

/** Configuration as the browser sees it: secrets are blanked and reported only as configured or not. */
export type PublicConfig = Omit<Config, 'arr_instances'> & {
  arr_instances: PublicArrInstance[]
} & { [Key in SecretConfigKey as `${Key}_configured`]: boolean }
export type ConfigUpdate = Partial<Config> & { clear_secrets?: SecretConfigKey[] }

/** Tags and root folders one Sonarr or Radarr instance offers for a library scope. */
export interface ArrScopeOptions {
  tags: string[]
  root_folders: string[]
}

export interface Status {
  results_revision?: string
  /** Scope, preference, or verification settings changed since the saved results were computed. */
  settings_changed?: boolean
  running: boolean
  progress: number
  total: number
  message: string
  error: string | null
  cancelled: boolean
  trigger: ScanTrigger | null
  source_errors: Record<string, string>
  last_run: string | null
  next_check: number | null
  webhook_scan: { queued: boolean; due_at: number | null; sources: Array<'sonarr' | 'radarr'> }
  /** Background Usenet availability sweep; absent or not running when idle. */
  usenet_prefetch?: UsenetPrefetchProgress
}

export interface UsenetPrefetchProgress {
  running: boolean
  checked: number
  total: number
  /** Providers the sweep is waiting on after rate limiting or repeated failures. */
  paused?: { provider: UsenetProvider; resume_in_seconds: number; rate_limited: boolean }[]
}
