export type JsonObject = Record<string, any>

export type { Config, ScanSchedule, ResultItem, Release, PublicConfig, ConfigUpdate } from '../shared/contracts.js'
import type { ResultItem } from '../shared/contracts.js'
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
  results: ResultItem[]
  error: string | null
  last_run: string | null
  cancelled: boolean
  trigger: ScanTrigger | null
  source_errors: Record<string, string>
}

export interface ReleaseCandidate {
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
  torrent_files?: import('../shared/download-estimate.js').TorrentFiles[]
  selected_files?: string[]
}

export interface ChainPart {
  id: number
  episodeCount: number | null
  episodeNumbers?: number[]
  title?: string
  cover?: string
  banner?: string
}

export interface ChainEntry {
  season: number
  id: number
  ids: number[]
  parts: ChainPart[]
  episodeCount?: number | null
  cover?: string | null
  banner?: string | null
}

export interface LocalSeason {
  groups: string[]
  size: number
  episode_numbers?: number[]
  episode_count?: number | null
  missing_episode_count?: number
  groups_by_episode?: Record<string, number[]>
  sizes_by_episode?: Record<string, number>
}
export interface LocalItem {
  arr: 'Sonarr' | 'Radarr'
  id: number
  title: string
  slug?: string
  seasons: Record<number, LocalSeason>
}
export interface SeaDexSlot { candidates: ReleaseCandidate[] }
export interface SeaDexEntry { url: string; notes: string; seasons: Record<number, SeaDexSlot> }
export interface ResolvedPart { label: string | null; source: SeaDexEntry; best: ReleaseCandidate; alts: ReleaseCandidate[] }
