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
