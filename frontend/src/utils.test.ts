import type { GroupedCard, ResultItem } from './types.js'
import { groupResults, STATUS_LABEL, hasCardUpgrade, cardSizeDelta } from './utils.js'

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
expect(cardStatus('upgrade', 'missing'), 'partial', 'upgrade + missing seasons are partially covered')
expect(cardStatus('upgrade', 'uncovered'), 'partial', 'upgrade + uncovered seasons are partially covered')
expect(cardStatus('partial'), 'partial', 'a partially resolved split season remains partial')
expect(STATUS_LABEL.partial, 'Partially on SeaDex', 'partial cards have an explicit label')

const unmatchedCards = groupResults([
  { ...result(1, 'missing'), key: 'Sonarr:item10:1:missing', group_id: null, anilist_id: null, title: 'Shared title', arr: 'Sonarr' },
  { ...result(0, 'missing'), key: 'Radarr:item20:0:missing', group_id: null, anilist_id: null, title: 'Shared title', arr: 'Radarr' },
])
expect(unmatchedCards.length, 2, 'unmatched Sonarr and Radarr entries do not merge by title')

// The first season (e.g. a Radarr movie, season 0) sorts first and can lack
// an AniList banner while later seasons have one. The card must fall back to
// the first season that actually carries artwork instead of rendering without
// a banner.
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

const unmatchedCard = groupResults([{ ...result(1, 'missing'), anilist_id: null, group_id: null, match_status: 'unmatched' }])[0]
expect(unmatchedCard.status, 'review', 'unmatched anime need matching review rather than being reported absent from SeaDex')
expect(STATUS_LABEL.review, 'Match needs review', 'matching review has a distinct label')

const partlyCoveredUpgrade = groupResults([
  { ...result(1, 'upgrade'), local_size: 100, best_size: 150 }, result(2, 'missing'),
])[0]
expect(partlyCoveredUpgrade.status, 'partial', 'coverage remains partial when another season is unlisted')
expect(hasCardUpgrade(partlyCoveredUpgrade), true, 'partial coverage does not hide an upgradable season')
const partlyResolvedUpgrade = groupResults([
  { ...result(1, 'partial'), upgrade_available: true, local_size: 100, best_size: 175 },
  { ...result(2, 'best'), local_size: 200, best_size: 200 },
])[0]
expect(hasCardUpgrade(partlyResolvedUpgrade), true, 'partly resolved seasons expose upgrade availability')
expect(cardSizeDelta(partlyResolvedUpgrade), 75, 'library totals include the same partial-season upgrade as cards')
expect(hasCardUpgrade(groupResults([result(1, 'partial')])[0]), false, 'partial coverage alone does not imply an upgrade')
expect(hasCardUpgrade(groupResults([result(1, 'best'), result(2, 'missing')])[0]), false, 'owned best and unlisted seasons are not upgrade candidates')
