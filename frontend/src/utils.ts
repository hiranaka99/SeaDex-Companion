import { CardStatus, GroupedCard, ResultItem } from './types'

/** Badge text shown on each card banner. */
export const STATUS_LABEL: Record<CardStatus, string> = {
  upgrade: 'Upgradable',
  best: 'Best quality',
  missing: 'Not on SeaDex',
  partial: 'Partially on SeaDex',
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

export function seasonLabel(r: ResultItem): string {
  if (r.season) return `S${String(r.season).padStart(2, '0')}`
  // Season 0 is a Radarr movie.
  return 'Movie'
}

/**
 * Group flat scan results into one card per anime. Grouping uses the base
 * (season 1) AniList id so all seasons of one anime land on a single card,
 * even when each season maps to its own AniList entry.
 */
export function groupResults(results: ResultItem[]): GroupedCard[] {
  const map = new Map<number | string, GroupedCard>()
  for (const r of results) {
    const gid = r.group_id ?? r.anilist_id ?? r.title
    if (!map.has(gid)) {
      map.set(gid, {
        title: r.title,
        arr: r.arr,
        image: r.image,
        banner: r.banner,
        url: r.url,
        notes: r.notes,
        anilist_id: gid,
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
    g.banner = g.seasons.find((s) => s.banner)?.banner ?? g.banner
    g.image = g.seasons.find((s) => s.image)?.image ?? g.image
    // A card is partial whenever SeaDex has usable releases for some seasons
    // but not all of them. This includes filler entries that exist on the site
    // without any release candidates: the backend reports those seasons as
    // missing/uncovered, while resolved seasons remain upgrade/best.
    const st = g.seasons.map((r) => r.status || 'upgrade')
    const hasUnresolved = st.some((status) => status === 'missing' || status === 'uncovered')
    const hasResolved = st.some((status) => status === 'upgrade' || status === 'best')
    if (hasUnresolved && hasResolved) g.status = 'partial'
    else if (hasUnresolved) g.status = 'missing'
    else if (st.includes('upgrade')) g.status = 'upgrade'
    else g.status = 'best'
  }
  return cards
}
