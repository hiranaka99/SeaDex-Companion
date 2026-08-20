export type CardStatus = 'upgrade' | 'best' | 'missing' | 'partial'

export type TabId = 'anime' | 'config' | 'log'

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
  downloadable: boolean
  selected_files?: string[]
}

export interface ResultItem {
  key: string
  group_id: number | null
  arr: string
  title: string
  season: number | null
  status: string
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
  notes: string | null
  notes_by_part?: Record<string, string>
  image: string | null
  banner: string | null
  anilist_id: number | null
  anilist_ids?: number[]
  arr_url: string | null
}

export interface GroupedCard {
  title: string
  arr: string
  image: string | null
  banner: string | null
  url: string | null
  notes: string | null
  anilist_id: number | string | null
  arr_url: string | null
  seasons: ResultItem[]
  status: CardStatus
}

export interface Config {
  sonarr_url: string
  sonarr_key: string
  sonarr_key_configured: boolean
  radarr_url: string
  radarr_key: string
  radarr_key_configured: boolean
  sonarr_category: string
  radarr_category: string
  qbittorrent_url: string
  qbittorrent_user: string
  qbittorrent_pass: string
  qbittorrent_pass_configured: boolean
  webhook: string
  webhook_configured: boolean
  notify_enabled: boolean
  autocheck_minutes: number
  hidden: string[]
}

export interface Status {
  running: boolean
  progress: number
  total: number
  message: string
  error: string | null
  last_run: string | null
  next_check: number | null
}
