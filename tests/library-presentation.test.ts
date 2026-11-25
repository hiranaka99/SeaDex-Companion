import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupResults, seasonStatus, upgradeDownloadEstimate } from '../frontend/src/utils.js'
import { releaseQuality } from '../frontend/src/release-status.js'
import { displayTimeAgo } from '../frontend/src/datetime.js'
import { DEFAULT_LIBRARY_FILTERS, libraryFiltersHash, parseLibraryFilters } from '../frontend/src/library-filters.js'
import type { Release, ResultItem } from '../shared/contracts.js'

const release = (overrides: Partial<Release> = {}): Release => ({
  kind: 'best',
  releaseGroup: 'Group A',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 1000,
  info_hashes: ['a'.repeat(40)],
  torrent_available: true,
  ...overrides,
})
const season = (overrides: Partial<ResultItem> = {}): ResultItem => ({
  key: 'Sonarr:1:1:Example',
  group_id: 1,
  arr: 'Sonarr',
  title: 'Example',
  season: 1,
  status: 'upgrade',
  match_status: 'matched',
  have: ['Old group'],
  local_size: 400,
  best_group: 'Group A',
  best_size: 1000,
  releases: [release()],
  url: null,
  notes: null,
  image: null,
  banner: null,
  anilist_id: 1,
  arr_url: null,
  ...overrides,
})

test('a season chip, its card, and Details agree on what an uncovered season is', () => {
  const uncovered = season({ status: 'uncovered', releases: [], best_group: null })
  assert.equal(seasonStatus(uncovered), 'missing')
  assert.equal(groupResults([uncovered])[0].status, 'missing')
  assert.equal(releaseQuality(uncovered).label, 'Not on SeaDex')
})

test('an unconfirmed match never reads as a SeaDex result on its chip or card', () => {
  const unmatched = season({ status: 'missing', match_status: 'unmatched', anilist_id: null, releases: [] })
  assert.equal(seasonStatus(unmatched), 'review')
  assert.equal(groupResults([unmatched])[0].status, 'review')
  assert.equal(seasonStatus(season({ status: 'missing', anilist_id: null })), 'review')
  assert.equal(seasonStatus(season({ status: 'best' })), 'best')
  assert.equal(seasonStatus(season({ status: 'partial' })), 'partial')
})

test('the download estimate counts each torrent once and reports unknown sizes', () => {
  const shared = release({ info_hashes: ['b'.repeat(40)], size: 5000 })
  const estimate = upgradeDownloadEstimate([
    season({ key: 'one', releases: [shared] }),
    season({ key: 'two', releases: [shared] }),
    season({ key: 'three', releases: [release({ info_hashes: ['c'.repeat(40)], size: 0 })] }),
    season({ key: 'owned', status: 'best', have: ['Group A'], releases: [release({ info_hashes: ['d'.repeat(40)] })] }),
  ])
  assert.deepEqual(estimate, { bytes: 5000, unknown: 1 })
})

test('library filters survive the URL round trip and ignore anything unrecognised', () => {
  const filters = {
    ...DEFAULT_LIBRARY_FILTERS,
    search: 'Vodes & co',
    status: 'partial' as const,
    source: 'Sonarr 4K',
    sort: 'size' as const,
    episodes: true,
    unseen: true,
    hidden: true,
  }
  assert.deepEqual(parseLibraryFilters(libraryFiltersHash(filters)), filters)
  assert.equal(libraryFiltersHash(DEFAULT_LIBRARY_FILTERS), '#anime')
  assert.deepEqual(parseLibraryFilters('#anime?status=nonsense&sort=random'), DEFAULT_LIBRARY_FILTERS)
  assert.deepEqual(parseLibraryFilters('#history?status=best'), DEFAULT_LIBRARY_FILTERS)
})

test('the last scan reads as relative time and falls back to the date after a week', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  assert.equal(displayTimeAgo('2026-11-25T11:59:40Z', now), 'just now')
  assert.equal(displayTimeAgo('2026-11-25T11:15:00Z', now), '45 min ago')
  assert.equal(displayTimeAgo('2026-11-25T03:00:00Z', now), '9 h ago')
  assert.equal(displayTimeAgo('2026-11-23T12:00:00Z', now), '2 days ago')
  assert.doesNotMatch(displayTimeAgo('2026-10-01T12:00:00Z', now), /ago/)
})
