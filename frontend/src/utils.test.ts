import { GroupedCard, ResultItem } from './types'
import { groupResults, STATUS_LABEL } from './utils'

function result(season: number, status: string): ResultItem {
  return {
    key: `Sonarr:1:${season}:${status}`,
    group_id: 1,
    arr: 'Sonarr',
    title: 'Example series',
    season,
    status,
    have: [],
    local_size: 0,
    best_group: status === 'best' ? 'Example' : null,
    best_size: 0,
    releases: [],
    url: status === 'best' ? 'https://releases.moe/1/' : null,
    notes: null,
    image: null,
    banner: null,
    anilist_id: season,
    arr_url: null,
  }
}

function cardStatus(...statuses: string[]): GroupedCard['status'] {
  return groupResults(statuses.map((status, index) => result(index + 1, status)))[0].status
}

function expect(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

// Regression coverage for cards containing both resolved and unresolved seasons.
expect(cardStatus('best', 'missing'), 'partial', 'resolved + missing seasons stay visible as SeaDex data')
expect(cardStatus('best', 'uncovered'), 'partial', 'resolved + uncovered seasons stay visible as SeaDex data')
expect(cardStatus('missing', 'missing'), 'missing', 'fully missing cards remain missing')
expect(cardStatus('upgrade', 'missing'), 'upgrade', 'upgrades retain priority over missing seasons')
expect(STATUS_LABEL.partial, 'Partially on SeaDex', 'partial cards have an explicit label')

// A specials season (season 0) sorts first and can lack an AniList banner while
// the numbered seasons have one. The card must fall back to the first season
// that actually carries artwork instead of rendering without a banner.
function resultWithArt(season: number, banner: string | null, image: string | null): ResultItem {
  return { ...result(season, 'best'), banner, image }
}
const artCard = groupResults([
  resultWithArt(0, null, 'cover-0'),
  resultWithArt(1, 'banner-1', 'cover-1'),
  resultWithArt(2, 'banner-2', 'cover-2'),
])[0]
expect(artCard.banner, 'banner-1', 'card banner falls back to the first season that has one')
expect(artCard.image, 'cover-0', 'card image keeps the first season cover when it exists')
const artlessCard = groupResults([
  resultWithArt(0, null, null),
  resultWithArt(1, 'banner-1', 'cover-1'),
])[0]
expect(artlessCard.image, 'cover-1', 'card image also falls back when the first season has none')
const noArtCard = groupResults([resultWithArt(0, null, null), resultWithArt(1, null, null)])[0]
expect(noArtCard.banner, null, 'cards without any banner stay bannerless')
expect(noArtCard.image, null, 'cards without any cover stay coverless')
