import { assessSeason, DEFAULT_ASSESSMENT } from '../../server/assessment.js'
import { seadexBest } from '../../server/catalog.js'
import type { ResultItem, TrackerMode } from '../../shared/contracts.js'
import type { JsonObject, LocalItem, LocalSeason } from '../../server/types.js'
import { listingViolations } from './listing-invariants.js'

export interface ReplayOptions {
  /** The Sonarr season the entries map to. */
  season: number
  /** The season's parts in order: each SeaDex entry by AniList ID, with its episode count. */
  parts: { alid: number; episodes: number }[]
  /** Release groups the library holds for every episode of the season. */
  own?: string[]
  trackers?: TrackerMode
  title?: string
}

/**
 * Runs SeaDex catalog entries, as its API returns them (`items` with `expand.trs`), through the scan's catalog
 * reading and season assessment, for a one-title Sonarr library whose season holds every episode.
 * Returns the season's result and the listing rules it breaks.
 */
export async function replayCatalog(
  items: JsonObject[],
  options: ReplayOptions,
): Promise<{ result: ResultItem; violations: string[] }> {
  const best = await seadexBest({ loadPage: async () => ({ items, totalPages: 1 }) })
  const total = options.parts.reduce((sum, part) => sum + part.episodes, 0)
  const own = options.own || []
  const local: LocalSeason = {
    groups: own,
    size: own.length ? 1 : 0,
    episode_count: total,
    episode_numbers: Array.from({ length: total }, (_, index) => index + 1),
  }
  const item: LocalItem = {
    arr: 'Sonarr',
    id: 1,
    title: options.title || 'Replay',
    seasons: { [options.season]: local },
  }
  const ids = options.parts.map(part => part.alid)
  const result = assessSeason({
    item,
    season: options.season,
    local,
    chain: [
      {
        season: options.season,
        id: ids[0],
        ids,
        episodeCount: total,
        parts: options.parts.map(part => ({ id: part.alid, episodeCount: part.episodes })),
      },
    ],
    best,
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: { ...DEFAULT_ASSESSMENT, ...(options.trackers ? { trackers: options.trackers } : {}) },
  })
  return { result, violations: listingViolations(result) }
}
