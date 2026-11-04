import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anilistChain, anilistLookup, anilistSeason, pickAniListSearchResult } from '../server/anilist.js'
import { createAniListClient } from '../server/anilist-client.js'
import { assessSeason, resolveSeasonChainEntry } from '../server/assessment.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { buildScanHistoryEntry } from '../server/history.js'
import { runScan } from '../server/scan.js'
import { getState, setState } from '../server/scan-state.js'
import { bulkDownloadTargets } from '../server/downloads.js'
import { planTorrents } from '../shared/download-plan.js'
import { groupResults } from '../frontend/src/utils.js'
import type { ChainEntry, LocalItem, LocalSeason, ReleaseCandidate, SeaDexEntry } from '../server/types.js'

function chain(...counts: number[]): ChainEntry[] {
  return counts.map((count, index) => ({ season: index + 1, id: 100 + index, ids: [100 + index], episodeCount: count, parts: [{ id: 100 + index, episodeCount: count }] }))
}

function local(count: number): LocalSeason {
  return { groups: ['Old'], size: 1, episode_count: count, episode_numbers: Array.from({ length: count }, (_, index) => index + 1) }
}

function show(seasons: Record<number, LocalSeason>): LocalItem {
  return { arr: 'Sonarr', id: 1, title: 'Continuous anime', seasons }
}

function release(episodes: number[], season?: number): ReleaseCandidate {
  const files = episodes.map(episode => ({ name: season ? `Anime.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv` : `Anime - ${String(episode).padStart(3, '0')}.mkv`, length: 10 }))
  return { releaseGroup: 'Best', tracker: 'Nyaa', quality: '1080p', tags: [], size: files.length * 10, file_count: files.length, info_hashes: ['a'.repeat(40)], is_best: true, source_files: files, torrent_files: [{ hash: 'a'.repeat(40), files }] }
}

function catalog(candidate: ReleaseCandidate, bucket = 0): Map<number, SeaDexEntry> {
  return new Map([[100, { url: 'https://seadex.moe/100', notes: '-', seasons: { [bucket]: { candidates: [candidate] } } }]])
}

const numbers = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => offset + index + 1)

test('continuous seasons exhaust the original entry before mapping all four sequel cours', () => {
  const counts = [20, 21, 22, 28, 18, 22, 20, 16, 22, 16, 7, 17, 36, 51, 26, 24]
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 366)
  const item = show(Object.fromEntries([...counts, 52].map((count, index) => [index + 1, local(count)])))
  const entries = chain(366, 13, 13, 13, 13)
  let offset = 0
  for (let season = 1; season <= 16; season++) {
    const resolved = resolveSeasonChainEntry(item, season, entries)
    assert.equal(resolved.entry?.id, 100)
    assert.equal(resolved.seasonEpisodeOffset, offset)
    offset += counts[season - 1]
  }
  assert.deepEqual(resolveSeasonChainEntry(item, 17, entries).entry?.ids, [101, 102, 103, 104])
})

test('a single Sonarr season can contain multiple AniList entries', () => {
  assert.deepEqual(resolveSeasonChainEntry(show({ 1: local(26) }), 1, chain(13, 13)).entry?.ids, [100, 101])
})

test('automatic cour merging requires a complete episode budget', () => {
  const entry = resolveSeasonChainEntry(show({ 1: local(26), 2: local(12) }), 1, chain(13, 12, 12)).entry
  assert.notDeepEqual(entry?.ids, [100, 101], 'Do not expand an incomplete 25-episode merge to cover 26 TVDB episodes')
})

test('missing season metadata cannot shift continuous anime to a sequel', () => {
  const resolved = resolveSeasonChainEntry(show({ 1: local(20), 3: local(22) }), 3, chain(63, 13, 13))
  assert.equal(resolved.entry, undefined)
})

test('unconsumed episodes cannot be discarded to fit a later sequel season', () => {
  const resolved = resolveSeasonChainEntry(show({ 1: local(20), 2: local(21), 3: local(26) }), 3, chain(63, 13, 13))
  assert.equal(resolved.entry, undefined)
})

test('an incomplete season budget cannot establish a continuous-entry mapping', () => {
  const resolved = resolveSeasonChainEntry(show({ 1: local(6), 2: local(6) }), 2, chain(13, 12))
  assert.equal(resolved.entry, undefined)
})

test('unknown episode counts after continuous alignment require review', () => {
  const resolved = resolveSeasonChainEntry(show({ 1: local(20), 2: local(21), 3: { groups: [], size: 0 } }), 3, chain(63, 13, 13))
  assert.equal(resolved.entry, undefined)
})

test('continuous mappings accept a verified season-specific torrent without requiring preceding episodes', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const candidate = release(numbers(21), 2)
  const result = assessSeason(item, 2, item.seasons[2], chain(63), catalog(candidate, 2), 'Sonarr:item1', undefined, null)
  assert.equal(result.status, 'upgrade')
  assert.deepEqual(result.releases[0].selected_files, candidate.source_files?.map(file => file.name))
})

test('file counts do not prove absolute episode coverage when there are gaps', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const candidate = release([...numbers(20), ...numbers(21, 41)])
  const result = assessSeason(item, 2, item.seasons[2], chain(63), catalog(candidate), 'Sonarr:item1', undefined, null)
  assert.equal(result.match_status, 'matched')
  assert.equal(result.status, 'uncovered')
  assert.deepEqual(result.releases, [])
})

test('partial absolute batches use episode numbers rather than positions within the file list', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const result = assessSeason(item, 2, item.seasons[2], chain(63), catalog(release(numbers(71, 9))), 'Sonarr:item1', undefined, null)
  assert.equal(result.releases[0].selected_files?.[0], 'Anime - 021.mkv')
  assert.equal(result.releases[0].selected_files?.at(-1), 'Anime - 041.mkv')
  assert.equal(result.best_size, 210)
})

test('known Sonarr totals can align continuous seasons when explicit episode lists are unavailable', () => {
  const item = show({ 1: { groups: [], size: 0, episode_count: 20 }, 2: { groups: [], size: 0, episode_count: 21 }, 3: { groups: [], size: 0, episode_count: 22 } })
  const result = assessSeason(item, 2, item.seasons[2], chain(63), catalog(release(numbers(63))), 'Sonarr:item1', undefined, null)
  assert.equal(result.releases[0].selected_files?.[0], 'Anime - 021.mkv')
  assert.equal(result.releases[0].selected_files?.length, 21)
})

test('continuous mappings do not offer unverified whole torrents based on file count alone', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const candidate = { ...release(numbers(63)), source_files: undefined, torrent_files: undefined }
  const result = assessSeason(item, 2, item.seasons[2], chain(63), catalog(candidate), 'Sonarr:item1', undefined, null)
  assert.equal(result.status, 'uncovered')
  assert.deepEqual(result.releases, [])
})

test('confirming the same continuous AniList entry manually preserves its season episode offset', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const entries = chain(63)
  const result = assessSeason(item, 2, item.seasons[2], entries, catalog(release(numbers(63))), 'Sonarr:item1', undefined, null, { entry: entries[0], groupId: 100, ids: [100] })
  assert.equal(result.season_mapping_override, true)
  assert.equal(result.releases[0].selected_files?.[0], 'Anime - 021.mkv')
  assert.equal(result.releases[0].selected_files?.at(-1), 'Anime - 041.mkv')
})

test('a manual match to a different anime does not inherit a continuous season offset', () => {
  const item = show({ 1: local(20), 2: local(21), 3: local(22) })
  const manual = { ...chain(21)[0], id: 900, ids: [900], parts: [{ id: 900, episodeCount: 21 }] }
  const sources = catalog(release(numbers(63)))
  sources.set(900, { url: 'https://seadex.moe/900', notes: '-', seasons: { 0: { candidates: [release(numbers(21))] } } })
  const result = assessSeason(item, 2, item.seasons[2], chain(63), sources, 'Sonarr:item1', undefined, null, { entry: manual, groupId: 100, ids: [900] })
  assert.equal(result.anilist_id, 900)
  assert.equal(result.status, 'upgrade')
  assert.equal(result.best_size, 210)
})

test('a full continuous-series scan resolves all seasons and publishes the correct deduplicated download scope', async () => {
  for (const groupCours of [false, true]) {
    const counts = [20, 21, 22, 28, 18, 22, 20, 16, 22, 16, 7, 17, 36, 51, 26, 24]
    const item = show(Object.fromEntries([...counts, 52].map((count, index) => [index + 1, local(count)])))
    let clock = 10_000
    const client = createAniListClient({ now: () => clock, sleep: async delay => { clock += delay }, fetch: async (_url, init) => {
      const id = JSON.parse(String(init?.body)).variables.id as number
      const title = id === 100 ? 'Original series' : groupCours ? `Sequel Part ${id - 100}` : `Sequel ${id}`
      return Response.json({ data: { Media: { id, format: 'TV', title: { english: title }, episodes: id === 100 ? 366 : 13,
        relations: { edges: id < 104 ? [{ relationType: 'SEQUEL', node: { id: id + 1, type: 'ANIME' } }] : [] },
      } } })
    } })
    const sources = new Map<number, SeaDexEntry>()
    for (const id of [100, 101, 102, 103, 104]) {
      const hash = id.toString(16).padStart(40, '0')
      const candidate = release(numbers(id === 100 ? 366 : 13))
      candidate.info_hashes = [hash]
      candidate.torrent_files = [{ hash, files: candidate.source_files! }]
      sources.set(id, { url: `https://seadex.moe/${id}`, notes: '-', seasons: { 0: { candidates: [candidate] } } })
    }
    setState({ running: false, results: [], error: null })
    await runScan(DEFAULT_CONFIG, {
      localItems: async () => [item], seadexBest: async () => sources, loadCache: () => ({}),
      loadUserRules: () => ({ mappings: {}, season_mappings: { 'Sonarr:item1:2': [100] }, exclusions: [] }),
      anilistChain: (title, cache, _dependencies, id, options) => anilistChain(title, cache, { lookup: async () => ({ id: 100 }), media: client.media, persist: () => {} }, id, options),
      anilistSeason: (ids, cache) => anilistSeason(ids, cache, { media: client.media, persist: () => {} }),
      saveLastResults: () => {}, autoNotifyNew: async () => 0, unhideNewBestReleases: () => [],
      recordScanHistory: (previous, current, at) => buildScanHistoryEntry(previous, current, at),
    })
    const results = getState().results
    assert.equal(getState().error, null)
    assert.equal(results.length, 17)
    assert.equal(groupResults(results).length, 1)
    assert.ok(results.every(result => result.match_status === 'matched' && result.status === 'upgrade'))
    assert.deepEqual(results[16].anilist_ids, [101, 102, 103, 104])
    assert.equal(results[1].releases[0].selected_files?.[0], 'Anime - 021.mkv')
    assert.equal(results[15].releases[0].selected_files?.at(-1), 'Anime - 366.mkv')
    const targets = bulkDownloadTargets(results)
    const plan = planTorrents(targets.map(target => ({ release: results.find(result => result.key === target.key)!.releases[target.release], category: 'anime' })))
    assert.equal(plan.length, 5, 'Sixteen original seasons share one torrent; four sequel cours keep their own torrents')
    assert.equal(plan.find(torrent => torrent.hash === (100).toString(16).padStart(40, '0'))?.selectedFiles?.length, 366)
  }
})

test('new year-aware lookups replace cached matches made by the older title resolver', async () => {
  const cache = { 'lookup:v2:Dororo (2019)': { id: 5760 } }
  const match = await anilistLookup('Dororo (2019)', cache, async () => [{ id: 101347, format: 'TV', seasonYear: 2019, title: { english: 'Dororo' } }], () => {})
  assert.equal(match?.id, 101347)
})

test('literal title matches outrank approximate long-vowel romanization matches', () => {
  const match = pickAniListSearchResult([
    { id: 1, format: 'TV', seasonYear: 2010, title: { english: 'Toko' } },
    { id: 2, format: 'TV', seasonYear: 2020, title: { english: 'Touko' } },
  ], 'Touko')
  assert.equal(match?.id, 2)
})
