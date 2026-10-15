export type { AuthState, Release, ResultItem, ScanHistoryChange, ScanHistoryEntry, ScannedDataInfo, ScanSchedule, PublicConfig as Config, Status } from '../../shared/contracts.js'
import type { ResultItem } from '../../shared/contracts.js'
export type CardStatus = 'upgrade' | 'best' | 'missing' | 'partial' | 'review'

export type TabId = 'anime' | 'history' | 'config' | 'log'

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
