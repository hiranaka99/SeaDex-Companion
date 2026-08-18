export type CardStatus = 'upgrade' | 'best' | 'missing' | 'partial'

export type TabId = 'anime' | 'config' | 'log'

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
}

export interface ResultItem {
  key: string
  group_id: number | null
  arr: string
  title: string
  season: number | null
  status: string
  have: string[]
  local_size: number
  best_group: string | null
  best_size: number
  releases: Release[]
  url: string | null
  urls?: { label: string; url: string }[]
  notes: string | null
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

export interface Status {
  running: boolean
  progress: number
  total: number
  message: string
  error: string | null
  last_run: string | null
  next_check: number | null
}