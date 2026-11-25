import type { ResultItem } from '../../shared/contracts.js'

/** A complete scan result for tests that only care about a few fields. */
export function resultItem(fields: Partial<ResultItem>): ResultItem {
  return {
    key: '',
    group_id: null,
    arr: '',
    title: '',
    season: null,
    status: 'missing',
    have: [],
    local_size: 0,
    best_group: null,
    best_size: 0,
    releases: [],
    url: null,
    notes: null,
    image: null,
    banner: null,
    anilist_id: null,
    arr_url: null,
    ...fields,
  }
}
