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
  // Season 0 is Sonarr's specials season (or a Radarr movie).
  return r.arr === 'Radarr' ? 'Movie' : 'Special'
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
    // Card status reflects the strongest useful state for the whole card.
    // A missing season must not make an otherwise resolved anime appear to be
    // absent from SeaDex: that was especially confusing because the resolved
    // season still displayed its URL, groups, and sizes below the banner.
    const st = g.seasons.map((r) => r.status || 'upgrade')
    if (st.includes('upgrade')) g.status = 'upgrade'
    else if (st.includes('missing') || st.includes('uncovered')) {
      g.status = st.some((status) => status === 'best') ? 'partial' : 'missing'
    }
    else g.status = 'best'
  }
  return cards
}