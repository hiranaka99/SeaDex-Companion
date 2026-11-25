export type {
  AuthState,
  Release,
  ResultItem,
  ScanHistoryChange,
  ScanHistoryEntry,
  ScannedDataInfo,
  ScanSchedule,
  Status,
} from '../../shared/contracts.js'
import type { ProwlarrCoverage, PublicConfig, ResultItem } from '../../shared/contracts.js'

/** Settings as the browser holds them; the library adds what Prowlarr's indexers cover once Prowlarr answers. */
export type Config = PublicConfig & { prowlarr_coverage?: ProwlarrCoverage }
export type CardStatus = 'upgrade' | 'best' | 'missing' | 'partial' | 'review'

export type TabId = 'anime' | 'history' | 'config' | 'log'

/** A request from another page to open the library with one status filter applied. */
export interface LibraryFilterRequest {
  /** Library status filter, e.g. "upgrade" or "best"; empty for none. */
  status: '' | CardStatus
}

export interface GroupedCard {
  /** Identity of the card: stable across scans and distinct per library instance. Hidden cards are saved by it. */
  key: string
  title: string
  arr: string
  /** Name of the Sonarr or Radarr instance the title belongs to. */
  source: string
  image: string | null
  banner: string | null
  url: string | null
  notes: string | null
  anilist_id: number | string | null
  arr_url: string | null
  seasons: ResultItem[]
  status: CardStatus
}
