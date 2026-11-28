import type { EpisodeMisfit } from './contracts.js'
import {
  releaseForbidden,
  releaseOwned,
  type RecommendationRelease,
  type RecommendationSeason,
} from './download-plan.js'

/** TVDB's episode orders as Sonarr v5 names them in a series' `seasonType`. */
const ORDER_NAMES: Record<string, string> = {
  official: 'aired order',
  dvd: 'DVD order',
  absolute: 'absolute order',
  alternate: 'alternate order',
  altdvd: 'alternate DVD order',
  regional: 'regional order',
}

/** How the card names an episode order: "DVD order", or Sonarr's own name for an order this app does not know. */
export function episodeOrderName(order: string): string {
  const key = order.trim().toLowerCase()
  return ORDER_NAMES[key] || `${order.trim()} order`
}

export const EPISODE_MISFIT_TITLE = "Doesn't fit your episode order"

/**
 * Why a release's episode numbering cannot fit the series, with both counts. It names the series' episode order
 * only when Sonarr reported one, so a Sonarr v3 series is never said to use an order nobody knows.
 */
export function episodeMisfitDetail(group: string, season: number | null, misfit: EpisodeMisfit): string {
  const numbering = `${group || 'This release'} numbers Season ${season ?? 1} as ${misfit.release_episodes} episodes`
  const series = misfit.episode_order
    ? `your series uses ${episodeOrderName(misfit.episode_order)}, which has ${misfit.series_episodes}`
    : `your series has ${misfit.series_episodes}`
  return `${numbering}, but ${series}. Sonarr would import its files onto the wrong episodes.`
}

/** The whole reason, as an episode-order exclusion carries it and the download preflight rejects it with. */
export const episodeMisfitReason = (group: string, season: number | null, misfit: EpisodeMisfit): string =>
  `${EPISODE_MISFIT_TITLE}: ${episodeMisfitDetail(group, season, misfit)}`

export const WRONG_EPISODES_NOTE =
  'Your files follow a different episode order than your series, so Sonarr probably has them on the wrong episodes. Nothing here changes your files.'

/**
 * The information-only note a card adds when the library holds a release excluded for its episode numbering:
 * the user's files are probably on the wrong episodes. Null for every other release.
 */
export function wrongEpisodesNote(
  season: Pick<
    RecommendationSeason,
    'precise_part_ownership' | 'owned_by_part' | 'verified_by_part' | 'mismatched_by_part' | 'have'
  > & {
    releases?: RecommendationRelease[]
  },
  release: RecommendationRelease,
): string | null {
  return releaseForbidden(release) && releaseOwned(season, release) ? WRONG_EPISODES_NOTE : null
}
