import { baseGroupKey, resultGroupKey } from '../../shared/ids.js'
import { seasonTag } from '../../shared/ids.js'
import { isSeasonUpgradable, upgradeParts } from '../../shared/download-plan.js'
import { estimateDownloads } from '../../shared/download-estimate.js'
import { DEFAULT_TRACKER_MODE } from '../../shared/settings.js'
import type { CardStatus, Config, GroupedCard, Release, ResultItem } from './types.js'

const USENET_PROVIDER_NAMES = { animetosho: 'AnimeTosho', amenzb: 'AmeNZB' } as const

/** Short explanation for a background Usenet sweep that is waiting on a paused provider. */
export function usenetPauseText(
  paused:
    { provider: keyof typeof USENET_PROVIDER_NAMES; resume_in_seconds: number; rate_limited: boolean }[] | undefined,
): string | null {
  if (!paused?.length) return null
  const longest = Math.max(...paused.map(pause => pause.resume_in_seconds))
  const wait = longest < 90 ? `${longest}s` : `${Math.ceil(longest / 60)} min`
  const names = paused.map(pause => USENET_PROVIDER_NAMES[pause.provider]).join(' and ')
  const cause = paused.every(pause => pause.rate_limited) ? 'rate limiting' : 'not responding'
  return `${names} ${paused.length > 1 ? 'are' : 'is'} ${cause}. Resuming in about ${wait}.`
}

/** Badge text shown on each card banner. */
export const STATUS_LABEL: Record<CardStatus, string> = {
  upgrade: 'Upgrade available',
  best: 'Best owned',
  missing: 'Not on SeaDex',
  partial: 'Partially on SeaDex',
  review: 'Match needs review',
}

export { isSeasonUpgradable } from '../../shared/download-plan.js'

/** The AniList match behind this season is uncertain, so nothing said about its SeaDex coverage is confirmed. */
export function isUnconfirmedMatch(season: Pick<ResultItem, 'match_status' | 'anilist_id' | 'status'>): boolean {
  return season.match_status === 'unmatched' || (!season.anilist_id && season.status === 'missing')
}

export type SeasonStatus = 'upgrade' | 'best' | 'partial' | 'missing' | 'review'

/**
 * How one season reads on its chip. It follows the same rules as the card status and the Details
 * view: an unconfirmed match is never shown as a SeaDex result, and a season SeaDex lists without
 * any release candidates (`uncovered`) reads as not on SeaDex.
 */
export function seasonStatus(season: ResultItem): SeasonStatus {
  if (isUnconfirmedMatch(season)) return 'review'
  if (season.status === 'missing' || season.status === 'uncovered') return 'missing'
  return season.status
}

/**
 * Roughly what Bulk download would fetch for these results: the default release of every
 * upgradable season or cour, with shared torrents counted once. `unknown` counts torrents
 * whose size the saved results do not reveal.
 */
export function upgradeDownloadEstimate(results: ResultItem[]): { bytes: number; unknown: number } {
  const estimate = estimateDownloads(
    results.flatMap(result =>
      upgradeParts(result).flatMap(part =>
        part.options[0] ? [{ release: part.options[0].release, category: '' }] : [],
      ),
    ),
  )
  return { bytes: estimate.new_bytes, unknown: estimate.unknown_torrents }
}

/** Display names for Usenet indexers, in lookup order. */
export const PROVIDER_LABEL: Record<string, string> = {
  animetosho: 'AnimeTosho',
  amenzb: 'AmeNZB',
  prowlarr: 'Prowlarr',
}

/** Prowlarr is set up and Release preferences include private trackers, so private-tracker releases can be found. */
export function prowlarrReady(config: Config | null | undefined): boolean {
  return Boolean(
    config &&
    (config.tracker_mode || DEFAULT_TRACKER_MODE) === 'private' &&
    config.prowlarr_enabled &&
    config.prowlarr_url &&
    config.prowlarr_key_configured,
  )
}

/**
 * A private-tracker release Prowlarr can look for: SeaDex lists its files but no public torrent, and Prowlarr
 * has an indexer for its tracker.
 */
export const findsPrivateTorrent = (
  release: Pick<Release, 'torrent_available' | 'private_sources' | 'tracker'>,
  config: Config | null | undefined,
) =>
  !release.torrent_available &&
  Boolean(release.private_sources?.length) &&
  prowlarrReady(config) &&
  Boolean(
    config?.prowlarr_coverage?.trackers.some(
      tracker => tracker.trim().toLowerCase() === release.tracker.trim().toLowerCase(),
    ),
  )

/** Whether qBittorrent can be sent this release: a public magnet, or a private-tracker torrent found through Prowlarr. */
export const torrentSendable = (
  release: Pick<Release, 'torrent_available' | 'private_sources' | 'tracker'>,
  config: Config | null | undefined,
) => release.torrent_available || findsPrivateTorrent(release, config)

/** Deduplicated display names for a list of provider ids; empty when unknown. */
export function providerNames(providers: (string | undefined)[]): string[] {
  return [...new Set(providers)]
    .filter((provider): provider is string => Boolean(provider))
    .map(provider => PROVIDER_LABEL[provider] || provider)
}

export function hasCardUpgrade(group: GroupedCard): boolean {
  return group.seasons.some(isSeasonUpgradable)
}

/** Potential library growth if every upgradable season used its target release. */
export function cardSizeDelta(group: GroupedCard): number {
  return group.seasons.reduce(
    (total, season) => total + (isSeasonUpgradable(season) ? (season.best_size || 0) - (season.local_size || 0) : 0),
    0,
  )
}

export function formatBytes(n: number): string {
  if (!n) return ''
  const sign = n < 0 ? '-' : ''
  let v = Math.abs(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return sign + v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i]
}

export function sizeDelta(best: number, local: number): string {
  if (!best || !local) return ''
  const d = best - local
  if (!d) return ''
  return (d > 0 ? '+' : '') + formatBytes(d)
}

/**
 * Human-readable time remaining for a download. Returns an empty string when
 * there is no usable speed or nothing left to download.
 */
export function formatEta(remaining: number, speed: number): string {
  if (remaining <= 0 || speed <= 0) return ''
  const seconds = remaining / speed
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function seasonLabel(r: ResultItem): string {
  if (r.season) return `${seasonTag(r.season)}`
  // Season 0 is a Radarr movie.
  return 'Movie'
}

/** Name of the Sonarr or Radarr instance a result came from. */
export function sourceName(r: Pick<ResultItem, 'arr' | 'instance_name'>): string {
  return r.instance_name || r.arr
}

export { resultGroupKey }

/**
 * Group flat scan results into one card per anime. Grouping uses the base
 * (season 1) AniList id so all seasons of one anime land on a single card,
 * even when each season maps to its own AniList entry.
 */
export function groupResults(results: ResultItem[]): GroupedCard[] {
  const map = new Map<number | string, GroupedCard>()
  for (const r of results) {
    const gid = resultGroupKey(r)
    if (!map.has(gid)) {
      const base = baseGroupKey(r)
      map.set(gid, {
        key: String(gid),
        title: r.title,
        arr: r.arr,
        source: sourceName(r),
        image: r.image,
        banner: r.banner,
        url: r.url,
        notes: r.notes,
        anilist_id: base,
        arr_url: r.arr_url,
        seasons: [],
        status: 'upgrade',
      })
    }
    map.get(gid)!.seasons.push(r)
  }

  const cards = [...map.values()]
  for (const g of cards) {
    g.seasons.sort((a, b) => (a.season || 0) - (b.season || 0))
    // The card inherits its artwork from the first season result, but the
    // first season can have no AniList banner (or cover). Prefer the first
    // season that actually has one so the card still shows artwork.
    g.banner = g.seasons.find(s => s.banner)?.banner ?? g.banner
    g.image = g.seasons.find(s => s.image)?.image ?? g.image
    // A card is partial whenever SeaDex has usable releases for some seasons
    // but not all of them. This includes filler entries that exist on the site
    // without any release candidates: the backend reports those seasons as
    // missing/uncovered, while resolved seasons remain upgrade/best.
    const st = g.seasons.map(r => r.status || 'upgrade')
    const hasUnresolved = st.some(status => status === 'missing' || status === 'uncovered' || status === 'partial')
    const hasResolved = st.some(status => status === 'upgrade' || status === 'best')
    if (g.seasons.some(isUnconfirmedMatch)) g.status = 'review'
    else if (st.includes('partial') || (hasUnresolved && hasResolved)) g.status = 'partial'
    else if (hasUnresolved) g.status = 'missing'
    else if (st.includes('upgrade')) g.status = 'upgrade'
    else g.status = 'best'
  }
  return cards
}
