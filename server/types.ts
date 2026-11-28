// oxlint-disable-next-line typescript/no-explicit-any -- Parsed JSON from external services is read loosely across the server; narrowing it to unknown is a separate migration.
export type JsonObject = Record<string, any>

export type {
  Config,
  ScanSchedule,
  ScanTrigger,
  ResultItem,
  Release,
  PublicConfig,
  ConfigUpdate,
  LibraryScope,
  ArrInstanceConfig,
  ReleasePreferences,
  PrivateSource,
} from '../shared/contracts.js'
import type { ResultItem, ScanTrigger } from '../shared/contracts.js'

/** Limits a scan to specific library items. Absent means the whole library. */
export interface ScanScope {
  sonarrIds?: number[]
  radarrIds?: number[]
  /** Item IDs of additional instances, keyed by instance identifier. */
  instances?: Record<string, number[]>
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
  /** The release's own page on its tracker, when SeaDex lists one. */
  tracker_url?: string
  quality: string
  tags: string[]
  dual_audio?: boolean
  size: number
  file_count: number
  info_hashes: string[]
  is_best: boolean
  source_files?: { name: string; length: number }[]
  torrent_files?: import('../shared/download-estimate.js').TorrentFiles[]
  /** Torrents SeaDex lists without a public info hash, identified by their files. */
  private_sources?: import('../shared/contracts.js').PrivateSource[]
  selected_files?: string[]
  /** Why this candidate is never targeted. */
  excluded_by?: string
  excluded_kind?: import('../shared/contracts.js').ExclusionKind
  episode_misfit?: import('../shared/contracts.js').EpisodeMisfit
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

/** One library file with its exact size, as reported by Sonarr or Radarr. */
export interface LocalFile {
  size: number
  /** Episode numbers the file holds; empty for a movie. */
  episodes: number[]
  group: string
}
export interface LocalSeason {
  groups: string[]
  size: number
  episode_numbers?: number[]
  episode_count?: number | null
  missing_episode_count?: number
  groups_by_episode?: Record<string, number[]>
  sizes_by_episode?: Record<string, number>
  files?: LocalFile[]
}
export interface LocalItem {
  arr: 'Sonarr' | 'Radarr'
  /** Identifier and name of an additional instance; absent for the first instance of each kind. */
  instance?: string
  instance_name?: string
  id: number
  title: string
  slug?: string
  /** Tag IDs the title carries in Sonarr or Radarr. */
  tags?: number[]
  /** Sonarr's alternate (scene) titles; `season` is null when a title applies to every season. */
  alternate_titles?: { title: string; season: number | null }[]
  /** Sonarr v5 only: the series' episode order (`official` for aired order, `dvd`…); absent when unknown. */
  episode_order?: string
  seasons: Record<number, LocalSeason>
}
export interface SeaDexSlot {
  candidates: ReleaseCandidate[]
}
export interface SeaDexEntry {
  url: string
  notes: string
  seasons: Record<number, SeaDexSlot>
}
export interface ResolvedPart {
  label: string | null
  source: SeaDexEntry
  best: ReleaseCandidate
  alts: ReleaseCandidate[]
  /** The saved preferences accept none of the listed releases; `best` is SeaDex's own pick. */
  blocked?: boolean
  /** Sonarr episode numbers this part covers, when they are known. */
  episodeNumbers?: number[]
}
