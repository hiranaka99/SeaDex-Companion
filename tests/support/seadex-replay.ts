import { assessSeason, DEFAULT_ASSESSMENT } from '../../server/assessment.js'
import { seadexBest } from '../../server/catalog.js'
import { seadexSlot, VIDEO_FILE } from '../../server/matching.js'
import type { ResultItem, TrackerMode } from '../../shared/contracts.js'
import type { JsonObject, LocalFile, LocalItem, LocalSeason } from '../../server/types.js'
import { listingViolations } from './listing-invariants.js'

export interface ReplayOptions {
  /** The Sonarr season the entries map to. */
  season: number
  /** The season's parts in order: each SeaDex entry by AniList ID, with its AniList episode count. */
  parts: { alid: number; episodes: number }[]
  /**
   * Episodes the Sonarr season has under the series' episode order. Defaults to the parts' AniList counts,
   * which is what a series whose episode order agrees with AniList has.
   */
  seasonEpisodes?: number
  /** The series' episode order as Sonarr v5 names it (`official`, `dvd`…); absent is Sonarr v3, which reports none. */
  episodeOrder?: string
  /** Release groups the library holds for every episode of the season, known by name. */
  own?: string[]
  /**
   * Release groups whose listed files the library holds byte for byte: the group's first listed release of the
   * season, its video files on the season's episodes in file-name order, one file per episode.
   */
  ownFiles?: string[]
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
  const anilistTotal = options.parts.reduce((sum, part) => sum + part.episodes, 0)
  const total = options.seasonEpisodes ?? anilistTotal
  const ownFiles = options.ownFiles || []
  const own = [...new Set([...(options.own || []), ...ownFiles])]
  const files: LocalFile[] = ownFiles.flatMap(group => {
    const listed = options.parts
      .flatMap(part => {
        const entry = best.get(part.alid)
        return (entry && seadexSlot(entry, options.season)?.candidates) || []
      })
      .find(candidate => candidate.releaseGroup.trim().toLowerCase() === group.trim().toLowerCase())
    const videos = (listed?.source_files || [])
      .filter(file => VIDEO_FILE.test(file.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    return videos.slice(0, total).map((file, index) => ({ size: file.length, episodes: [index + 1], group }))
  })
  const local: LocalSeason = {
    groups: own,
    size: own.length ? 1 : 0,
    episode_count: total,
    episode_numbers: Array.from({ length: total }, (_, index) => index + 1),
    ...(files.length ? { files } : {}),
  }
  const item: LocalItem = {
    arr: 'Sonarr',
    id: 1,
    title: options.title || 'Replay',
    ...(options.episodeOrder ? { episode_order: options.episodeOrder } : {}),
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
        episodeCount: anilistTotal,
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
