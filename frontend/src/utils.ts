import { baseGroupKey, resultGroupKey } from '../../shared/ids.js'
import { seasonTag } from '../../shared/ids.js'
import { isSeasonUpgradable } from '../../shared/download-plan.js'
import type { CardStatus, GroupedCard, ResultItem } from './types.js'

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

/** Glyph and tone for each status, shared by library cards and scan history so a status never relies on color alone. */
export const STATUS_GLYPH: Record<CardStatus, { icon: 'arrow-up' | 'check' | 'minus' | 'alert'; color: string }> = {
  upgrade: { icon: 'arrow-up', color: 'text-accent-bright' },
  best: { icon: 'check', color: 'text-good' },
  missing: { icon: 'minus', color: 'text-muted' },
  partial: { icon: 'alert', color: 'text-warn' },
  review: { icon: 'alert', color: 'text-warn' },
}

export { isSeasonUpgradable } from '../../shared/download-plan.js'

/** Display names for Usenet indexers, in lookup order. */
export const PROVIDER_LABEL: Record<string, string> = { animetosho: 'AnimeTosho', amenzb: 'AmeNZB' }

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
    if (
      g.seasons.some(
        season => season.match_status === 'unmatched' || (!season.anilist_id && season.status === 'missing'),
      )
    )
      g.status = 'review'
    else if (st.includes('partial') || (hasUnresolved && hasResolved)) g.status = 'partial'
    else if (hasUnresolved) g.status = 'missing'
    else if (st.includes('upgrade')) g.status = 'upgrade'
    else g.status = 'best'
  }
  return cards
}
