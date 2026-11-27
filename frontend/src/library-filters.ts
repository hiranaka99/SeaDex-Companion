export type LibraryStatusFilter = '' | 'review' | 'upgrade' | 'partial' | 'missing' | 'best'
export type LibrarySort = 'recommended' | 'title' | 'size' | 'changed'

export interface LibraryFilters {
  search: string
  source: string
  status: LibraryStatusFilter
  sort: LibrarySort
  /** Only titles with episodes missing from the library. */
  episodes: boolean
  /** Only titles with release changes nobody has reviewed yet. */
  unseen: boolean
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: '',
  source: '',
  status: '',
  sort: 'recommended',
  episodes: false,
  unseen: false,
}

const STATUSES: LibraryStatusFilter[] = ['', 'review', 'upgrade', 'partial', 'missing', 'best']
const SORTS: LibrarySort[] = ['recommended', 'title', 'size', 'changed']
const TAB = 'anime'

/** Filters saved in `#anime?…`; anything unrecognised falls back to the default. */
export function parseLibraryFilters(hash: string): LibraryFilters {
  const [tab, query = ''] = hash.replace(/^#/, '').split('?')
  if (tab !== TAB || !query) return DEFAULT_LIBRARY_FILTERS
  const params = new URLSearchParams(query)
  const status = params.get('status') || ''
  const sort = params.get('sort') || ''
  return {
    search: params.get('q') || '',
    source: params.get('source') || '',
    status: STATUSES.includes(status as LibraryStatusFilter) ? (status as LibraryStatusFilter) : '',
    sort: SORTS.includes(sort as LibrarySort) ? (sort as LibrarySort) : 'recommended',
    episodes: params.get('episodes') === '1',
    unseen: params.get('unseen') === '1',
  }
}

export function libraryFiltersHash(filters: LibraryFilters): string {
  const params = new URLSearchParams()
  if (filters.search.trim()) params.set('q', filters.search.trim())
  if (filters.status) params.set('status', filters.status)
  if (filters.source) params.set('source', filters.source)
  if (filters.sort !== 'recommended') params.set('sort', filters.sort)
  if (filters.episodes) params.set('episodes', '1')
  if (filters.unseen) params.set('unseen', '1')
  const query = params.toString()
  return `#${TAB}${query ? `?${query}` : ''}`
}
