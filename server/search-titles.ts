// Search terms for Prowlarr, built the way Sonarr builds its anime searches: one text query per scene
// title, each cleaned with Sonarr's GetCleanSceneTitle rules. Sonarr sends the title alone; SeaDex Companion
// looks for one release group's upload, so the group leads each Usenet query.

import type { ResultItem } from './types.js'
import { loadCache } from './results.js'
import { isRecord } from '../shared/guards.js'

/** At most this many titles are searched; every query is sent to every selected indexer. */
const TITLE_LIMIT = 4

/**
 * Sonarr's GetCleanSceneTitle, with spaces where Sonarr writes `+`: a leading "The" is dropped, `&` becomes
 * "and", apostrophes, periods and similar marks are deleted (so "Hero's" stays one word), every other
 * non-word character separates words, and accents are removed.
 */
export function cleanSearchTitle(title: string): string {
  return title
    .replace(/^the\s/i, '')
    .replace(/&/g, 'and')
    .replace(/['.`´‘’]/g, '')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Romaji and English titles AniList gave the season's entries, from the scan's metadata cache. */
function aniListTitles(result: Pick<ResultItem, 'anilist_id' | 'anilist_ids'>): string[] {
  const ids = result.anilist_ids?.length ? result.anilist_ids : result.anilist_id ? [result.anilist_id] : []
  if (!ids.length) return []
  let cache: Record<string, unknown>
  try {
    cache = loadCache()
  } catch {
    return []
  }
  return ids.flatMap(id => {
    const entry = cache[`media:v1:${id}`]
    const media = isRecord(entry) && isRecord(entry.media) ? entry.media : undefined
    const titles = media && isRecord(media.title) ? media.title : {}
    return [titles.romaji, titles.english].filter(
      (title): title is string => typeof title === 'string' && Boolean(title),
    )
  })
}

/**
 * The titles a release is searched under, cleaned and without duplicates: the library title, Sonarr's scene
 * titles for the season, then AniList's romaji and English titles.
 */
export function searchTitles(
  result: Pick<ResultItem, 'title' | 'search_titles' | 'anilist_id' | 'anilist_ids'> | undefined,
): string[] {
  if (!result) return []
  const seen = new Set<string>()
  const titles: string[] = []
  for (const title of [result.title, ...(result.search_titles || []), ...aniListTitles(result)]) {
    const clean = cleanSearchTitle(title || '')
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    titles.push(clean)
    if (titles.length >= TITLE_LIMIT) break
  }
  return titles
}

/** Newznab categories Sonarr and Radarr search for anime: Anime and TV for series, Movies for films. */
export function searchCategories(arr: string | undefined): number[] {
  return arr === 'Radarr' ? [2000] : [5070, 5000]
}
