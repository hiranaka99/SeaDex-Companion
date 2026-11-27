import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareScans, type ScanComparison } from '../server/scan-comparison.js'
import { createScanService } from '../server/scan.js'
import { getState, setState } from '../server/scan-state.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { resultItem } from './support/results.js'
import type { Release, ResultItem } from '../shared/contracts.js'

const release = (group: string, changes: Partial<Release> = {}): Release => ({
  kind: 'best',
  releaseGroup: group,
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 100,
  info_hashes: [group.charAt(0).toLowerCase().repeat(40)],
  torrent_available: true,
  ...changes,
})
const season = (changes: Partial<ResultItem> = {}): ResultItem =>
  resultItem({
    key: 'Sonarr:42:1:Best',
    library_key: 'Sonarr:item10',
    group_id: 42,
    anilist_id: 42,
    arr: 'Sonarr',
    title: 'Show',
    season: 1,
    status: 'best',
    have: ['Best'],
    local_size: 1000,
    best_group: 'Best',
    releases: [release('Best')],
    ...changes,
  })

test('a season is matched to the previous season with the same library item and season number', () => {
  const previous = [season(), season({ season: 2, key: 'Sonarr:42:2:Best' })]
  const current = [season({ season: 2, key: 'Sonarr:42:2:Best', title: 'Renamed' }), season({ title: 'Renamed' })]
  const comparison = compareScans(previous, current)
  assert.deepEqual(
    comparison.seasons.map(entry => [entry.current.season, entry.previous?.season]),
    [
      [2, 2],
      [1, 1],
    ],
  )
  assert.equal(comparison.seasons[1].previous, previous[0])
  assert.deepEqual(comparison.removed, [])
})

test('a title re-added to Sonarr under a new item ID is matched by its source, title and season', () => {
  const previous = [season()]
  const readded = season({ library_key: 'Sonarr:item99', key: 'Sonarr:42:1:Best:new' })
  const comparison = compareScans(previous, [readded])
  assert.equal(comparison.seasons[0].previous, previous[0])
  assert.deepEqual(comparison.removed, [], 'The old item is the same title, not a removed one')
})

test('the same title in two library instances is matched within its own instance only', () => {
  const main = season({ library_key: 'Sonarr:item10' })
  const uhd = season({ library_key: 'Sonarr@uhd:item10', instance: 'uhd', instance_name: 'Sonarr 4K' })
  const comparison = compareScans([main, uhd], [uhd, main])
  assert.deepEqual(
    comparison.seasons.map(entry => entry.previous),
    [uhd, main],
  )
  // A title added to one instance is new there, although the other instance holds the same title.
  const added = compareScans([main], [main, uhd])
  assert.equal(added.seasons[1].previous, null)
})

test('a title whose previous item is still in the library is never matched to it by title', () => {
  const kept = season()
  const sameName = season({ library_key: 'Sonarr:item11', key: 'Sonarr:43:1:Best', group_id: 43, anilist_id: 43 })
  const comparison = compareScans([kept], [kept, sameName])
  assert.deepEqual(
    comparison.seasons.map(entry => entry.previous),
    [kept, null],
    'A second series with the same title is new, not the other series moved',
  )
  const twice = compareScans(
    [kept],
    [season({ library_key: 'Sonarr:item11' }), season({ library_key: 'Sonarr:item12' })],
  )
  assert.deepEqual(
    twice.seasons.map(entry => entry.previous),
    [kept, null],
    'One previous season is matched by title once',
  )
})

test('results without a library item are matched by source, AniList group and season', () => {
  const legacy = season({ library_key: undefined })
  const comparison = compareScans([legacy], [season({ library_key: undefined, title: 'Renamed' })])
  assert.equal(comparison.seasons[0].previous, legacy)
  const other = compareScans([legacy], [season({ library_key: undefined, group_id: 7, title: 'Other' })])
  assert.equal(other.seasons[0].previous, null)
  assert.deepEqual(other.removed, [legacy])
  // Results saved before items had keys find their season once the item has one.
  assert.equal(compareScans([legacy], [season()]).seasons[0].previous, legacy)
})

/** The library replaced the best release's files while SeaDex still recommends it. */
const replaced = () => season({ status: 'upgrade', have: ['Weekly'], local_size: 700 })

test('a season that lost its best release through a library change carries its regression', () => {
  const comparison = compareScans([season()], [replaced()])
  assert.deepEqual(comparison.seasons[0].regression, {
    kind: 'regression',
    description: 'Your files changed: Best → Weekly',
  })
  assert.deepEqual(comparison.seasons[0].releaseChanges, [], 'SeaDex changed nothing')
  assert.equal(comparison.baseline, false)
  assert.equal(comparison.firstScan, false)
})

test('a season compares its releases with the previous season', () => {
  const alternative = release('Alt', { kind: 'alt' })
  const comparison = compareScans([season()], [season({ releases: [release('Best'), alternative] })])
  assert.deepEqual(
    comparison.seasons[0].releaseChanges.map(change => change.kind),
    ['alternative'],
  )
  assert.equal(comparison.seasons[0].regression, null)
  const added = compareScans([], [season()])
  assert.deepEqual(added.seasons[0], {
    current: added.seasons[0].current,
    previous: null,
    releaseChanges: [],
    regression: null,
  })
  assert.equal(added.firstScan, true, 'Without previous results the scan is the first one')
  assert.equal(added.baseline, true, 'A first scan is a baseline scan')
})

test('a baseline scan keeps its release changes but reports no regressions', () => {
  const comparison = compareScans([season()], [replaced()], { settingsChanged: true })
  assert.equal(comparison.baseline, true)
  assert.equal(comparison.seasons[0].previous?.status, 'best')
  assert.equal(comparison.seasons[0].regression, null)
  const changed = compareScans([season()], [season({ best_group: 'Newer', releases: [release('Newer')] })], {
    settingsChanged: true,
  })
  assert.notDeepEqual(changed.seasons[0].releaseChanges, [])
})

test('a season is found again by the result readers hold, which may be a copy', () => {
  const comparison = compareScans([season()], [replaced()])
  assert.equal(comparison.seasonOf({ ...replaced(), excluded: true })?.regression?.kind, 'regression')
  assert.equal(comparison.seasonOf(season({ library_key: 'Sonarr:item77', title: 'Other' })), undefined)
})

test('a large library is compared in one pass', () => {
  const results = Array.from({ length: 3000 }, (_, index) =>
    resultItem({
      key: `Sonarr:${index}:1:Group`,
      library_key: `Sonarr:item${index}`,
      arr: 'Sonarr',
      title: `Anime ${index}`,
      season: 1,
    }),
  )
  const started = performance.now()
  const comparison = compareScans(results, results)
  assert.equal(comparison.seasons.filter(entry => entry.previous === entry.current).length, results.length)
  assert.equal(comparison.seasonOf(resultItem({ arr: 'Radarr', title: 'Unknown', season: 0 })), undefined)
  // Rebuilding the index for each result took seconds at this size.
  assert.ok(performance.now() - started < 1000, 'Matching a large library must not be quadratic')
})

test('a scan hands one comparison to release changes, history and notifications', async () => {
  resetRuntimeForTests()
  const previous = season({ arr: 'Sonarr' })
  setState({ results: [previous] })
  const received: ScanComparison[] = []
  let notified: ResultItem[] = []
  try {
    await createScanService({
      seadexBest: async () => new Map(),
      localItems: async () => [],
      loadCache: () => ({}),
      loadUserRules: () => ({ mappings: {}, exclusions: [] }),
      onScanFinished: () => {},
      syncArrTags: async () => ({ updated: 0, errors: {} }) as never,
      settleImports: () => 0,
      recordReleaseChanges: comparison => {
        received.push(comparison)
      },
      saveLastResults: () => {},
      recordScanHistory: comparison => {
        received.push(comparison)
        return {} as never
      },
      autoNotifyNew: async (_config, results, comparison) => {
        notified = results
        received.push(comparison)
        return 0
      },
    }).run(DEFAULT_CONFIG)
    assert.equal(received.length, 3)
    assert.ok(received.every(comparison => comparison === received[0]))
    assert.deepEqual(notified, getState().results, 'Notifications read the scan results they are given')
    assert.equal(received[0].removed[0]?.title, previous.title, 'The title no longer in Sonarr was removed')
  } finally {
    resetRuntimeForTests()
  }
})

test('seasons that share an identity are each matched to one previous season, in order', () => {
  const first = season({ key: 'first', best_group: 'One' })
  const second = season({ key: 'second', best_group: 'Two' })
  const comparison = compareScans([first, second], [first, second])
  assert.deepEqual(
    comparison.seasons.map(entry => entry.previous),
    [first, second],
    'The previous results compared with themselves change nothing',
  )
  assert.deepEqual(comparison.removed, [])
  assert.deepEqual(compareScans([first, second], [first]).removed, [second])
})
