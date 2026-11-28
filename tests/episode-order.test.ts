import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { replayCatalog } from './support/seadex-replay.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { downloadClients } from '../server/download-clients.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { prefetchPlan } from '../server/usenet-prefetch.js'
import { usenetAvailability } from '../server/usenet-copies.js'
import { episodeRangeLabel, releaseIdentity } from '../shared/releases.js'
import type { DownloadProtocol } from '../shared/download-contracts.js'
import { assessSeason } from './support/assessment.js'
import { DEFAULT_ASSESSMENT } from '../server/assessment.js'
import { normalizeResults } from '../server/result-model.js'
import { DEFAULT_RELEASE_PREFERENCES } from '../shared/settings.js'
import type { Release, ResultItem } from '../shared/contracts.js'
import type { ChainEntry, Config, LocalItem, LocalSeason, ReleaseCandidate, SeaDexEntry } from '../server/types.js'

let created = 0
const nextHash = () => '0123456789abcdef'[created++ % 16].repeat(40)

/** A release whose files are the given episode numbers, labelled `SxxEyy` when a season is given. */
function release(group: string, episodes: number[], season?: number, extra: Partial<ReleaseCandidate> = {}) {
  const files = episodes.map(episode => ({
    name: season
      ? `${group}.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`
      : `[${group}] Anime - ${String(episode).padStart(2, '0')}.mkv`,
    length: 1000 + episode,
  }))
  const hash = nextHash()
  return {
    releaseGroup: group,
    tracker: 'Nyaa',
    quality: '1080p',
    tags: [],
    size: files.reduce((sum, file) => sum + file.length, 0),
    file_count: files.length,
    info_hashes: [hash],
    is_best: true,
    source_files: files,
    torrent_files: [{ hash, files }],
    ...extra,
  } satisfies ReleaseCandidate
}

const numbers = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => offset + index + 1)

function local(count: number): LocalSeason {
  return { groups: [], size: 0, episode_count: count, episode_numbers: numbers(count) }
}

const listing = (candidates: ReleaseCandidate[]): SeaDexEntry => ({
  url: 'https://seadex.moe/x/',
  notes: '-',
  seasons: { 0: { candidates } },
})

/** One season of a one-title Sonarr library, assessed against one AniList entry per part. */
function assess(options: {
  seasons: Record<number, LocalSeason>
  season: number
  chain: ChainEntry[]
  best: Map<number, SeaDexEntry>
  preferences?: typeof DEFAULT_RELEASE_PREFERENCES
}): ResultItem {
  const item: LocalItem = { arr: 'Sonarr', id: 1, title: 'Anime', seasons: options.seasons }
  return assessSeason({
    item,
    season: options.season,
    local: options.seasons[options.season],
    chain: options.chain,
    best: options.best,
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: { ...DEFAULT_ASSESSMENT, ...(options.preferences ? { preferences: options.preferences } : {}) },
  })
}

const entry = (id: number, ...partCounts: number[]): ChainEntry => ({
  season: 1,
  id,
  ids: partCounts.map((_, index) => id + index),
  episodeCount: partCounts.reduce((sum, count) => sum + count, 0),
  parts: partCounts.map((count, index) => ({ id: id + index, episodeCount: count })),
})

const row = (result: ResultItem, group: string, part?: string): Release => {
  const found = result.releases.find(
    candidate => candidate.releaseGroup === group && (part === undefined || candidate.part === part),
  )
  assert.ok(found, `${group} is listed${part ? ` in ${part}` : ''}`)
  return found
}

test('a batch of one AniList entry across three Sonarr seasons fits every season it spans', () => {
  const seasons = { 1: local(20), 2: local(21), 3: local(22) }
  const batch = release('Batch', numbers(63))
  let offset = 0
  for (const [season, count] of [
    [1, 20],
    [2, 21],
    [3, 22],
  ]) {
    const result = assess({ seasons, season, chain: [entry(100, 63)], best: new Map([[100, listing([batch])]]) })
    const listed = row(result, 'Batch')
    assert.equal(listed.excluded_by, undefined, `Season ${season}`)
    assert.equal(listed.target, true)
    assert.equal(episodeRangeLabel(listed.selected_files || []), `Eps ${offset + 1}–${offset + count}`)
    offset += count
  }
})

test('a whole-season batch listed under the first of two parts fits, and each part keeps its own episodes', () => {
  const batch = release('Batch', numbers(24), 1)
  const result = assess({
    seasons: { 1: local(24) },
    season: 1,
    chain: [entry(100, 12, 12)],
    best: new Map([
      [100, listing([batch])],
      [101, listing([release('Second', numbers(12, 12), 1)])],
    ]),
  })
  const first = row(result, 'Batch', 'Cour 1')
  assert.equal(first.excluded_by, undefined)
  assert.equal(first.target, true)
  assert.equal(episodeRangeLabel(first.selected_files || []), 'Eps 1–12')
  assert.equal(row(result, 'Second', 'Cour 2').excluded_by, undefined)
})

test('a release one episode longer than the season fits and selects the season’s episodes', () => {
  const result = assess({
    seasons: { 1: local(12) },
    season: 1,
    chain: [entry(100, 12)],
    best: new Map([[100, listing([release('Long', numbers(13), 1)])]]),
  })
  const listed = row(result, 'Long')
  assert.equal(listed.excluded_by, undefined)
  assert.equal(listed.target, true)
  assert.equal(episodeRangeLabel(listed.selected_files || []), 'Eps 1–12')
})

test('an incomplete batch is not taken for another episode order', () => {
  const result = assess({
    seasons: { 1: local(13) },
    season: 1,
    chain: [entry(100, 13)],
    best: new Map([[100, listing([release('Partial', numbers(10), 1)])]]),
  })
  const listed = row(result, 'Partial')
  assert.equal(listed.excluded_by, undefined)
  assert.equal(listed.target, true)
})

test('a longer batch numbered without seasons keeps today’s scoping', () => {
  const result = assess({
    seasons: { 1: local(13) },
    season: 1,
    chain: [entry(100, 13)],
    best: new Map([[100, listing([release('Series', numbers(26))])]]),
  })
  const listed = row(result, 'Series')
  assert.equal(listed.excluded_by, undefined)
  assert.equal(listed.target, true)
  assert.equal(episodeRangeLabel(listed.selected_files || []), 'Eps 1–13')
})

test('specials, extras and NC files are not counted as episodes of the season', () => {
  const bonus = release('Bonus', numbers(13), 1)
  bonus.source_files = [
    ...bonus.source_files,
    ...numbers(6).map(episode => ({ name: `Bonus.S00E0${episode}.mkv`, length: 5 })),
    ...numbers(8).map(episode => ({ name: `Extras/Bonus.S01E${30 + episode}.mkv`, length: 5 })),
    { name: 'Bonus.NCOP.S01E40.mkv', length: 5 },
  ]
  const result = assess({
    seasons: { 1: local(13) },
    season: 1,
    chain: [entry(100, 13)],
    best: new Map([[100, listing([bonus])]]),
  })
  assert.equal(row(result, 'Bonus').excluded_by, undefined)
})

test('a fitting alternative becomes the target when SeaDex’s best does not fit', () => {
  const result = assess({
    seasons: { 1: local(13) },
    season: 1,
    chain: [entry(100, 13)],
    best: new Map([
      [100, listing([release('Segments', numbers(26), 1), release('Combined', numbers(13), 1, { is_best: false })])],
    ]),
    preferences: { ...DEFAULT_RELEASE_PREFERENCES, accept_alternatives: true },
  })
  assert.equal(row(result, 'Segments').excluded_kind, 'episode_order')
  assert.equal(row(result, 'Segments').target, undefined)
  assert.equal(row(result, 'Combined').target, true)
  assert.equal(result.best_group, 'Combined')
})

test('a release the preferences exclude keeps its preference reason and is not taken for an episode-order misfit', () => {
  const result = assess({
    seasons: { 1: local(13) },
    season: 1,
    chain: [entry(100, 13)],
    best: new Map([[100, listing([release('Ignored', numbers(13), 1), release('Other', numbers(13), 1)])]]),
    preferences: { ...DEFAULT_RELEASE_PREFERENCES, ignored_groups: ['Ignored'] },
  })
  const ignored = row(result, 'Ignored')
  assert.equal(ignored.excluded_by, 'Ignored release group')
  assert.equal(ignored.excluded_kind, 'preferences')
  assert.equal(ignored.episode_misfit, undefined)
  assert.equal(row(result, 'Other').target, true)
})

test('a movie is never judged by episode order', () => {
  const files = numbers(30).map(part => ({ name: `Movie.S01E${String(part).padStart(2, '0')}.mkv`, length: 10 }))
  const movie = release('Film', [], undefined, { source_files: files, file_count: 30 })
  const item: LocalItem = { arr: 'Radarr', id: 1, title: 'Movie', seasons: { 0: { groups: [], size: 0 } } }
  const result = assessSeason({
    item,
    season: 0,
    local: item.seasons[0],
    chain: [{ season: 0, id: 100, ids: [100], episodeCount: 1, parts: [{ id: 100, episodeCount: 1 }] }],
    best: new Map([[100, listing([movie])]]),
    libraryKey: 'Radarr:item1',
    arrUrl: null,
  })
  assert.equal(row(result, 'Film').excluded_by, undefined)
})

test('saved results keep an exclusion’s kind and counts, and older results without a kind still load', () => {
  const saved = (fields: Record<string, unknown>) => [
    {
      key: 'show',
      arr: 'Sonarr',
      title: 'Show',
      season: 2,
      status: 'upgrade',
      releases: [{ kind: 'best', releaseGroup: 'NAN0', tracker: 'Nyaa', info_hashes: ['a'.repeat(40)], ...fields }],
    },
  ]
  const [current] = normalizeResults(
    saved({
      excluded_by: 'Does not fit',
      excluded_kind: 'episode_order',
      episode_misfit: { release_episodes: 30, series_episodes: 13, episode_order: 'dvd' },
    }),
  )
  assert.equal(current.releases[0].excluded_kind, 'episode_order')
  assert.deepEqual(current.releases[0].episode_misfit, {
    release_episodes: 30,
    series_episodes: 13,
    episode_order: 'dvd',
  })
  const [older] = normalizeResults(saved({ excluded_by: 'Ignored tracker' }))
  assert.equal(older.releases[0].excluded_by, 'Ignored tracker')
  assert.equal(older.releases[0].excluded_kind, undefined)
  const [unknown] = normalizeResults(saved({ excluded_by: 'Something', excluded_kind: 'future-kind' }))
  assert.equal(unknown.releases[0].excluded_kind, undefined)
})

test('the download preflight rejects a release excluded for its episode order, alone or in a batch, by torrent or Usenet', async () => {
  const items = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/seadex/panty-stocking-s2.json', import.meta.url), 'utf8'),
  ).items
  const { result } = await replayCatalog(items, {
    season: 2,
    parts: [{ alid: 151799, episodes: 13 }],
    seasonEpisodes: 13,
    episodeOrder: 'dvd',
    own: ['GetItTwisted'],
  })
  const index = result.releases.findIndex(release => release.releaseGroup === 'NAN0')
  const reason =
    "Doesn't fit your episode order: NAN0 numbers Season 2 as 30 episodes, but your series uses DVD order, which has 13. Sonarr would import its files onto the wrong episodes."
  assert.equal(result.releases[index].excluded_by, reason)
  const config: Config = { ...DEFAULT_CONFIG, qbittorrent_url: '', download_mode: 'choose' }
  const pick = (key: string, protocol: DownloadProtocol = 'torrent') => ({
    key,
    release: index,
    identity: releaseIdentity(result.releases[index]),
    protocol,
  })
  const plan = async (selections: ReturnType<typeof pick>[]) => {
    const planned = await buildDownloadPlan(config, selections, {
      results: [
        { ...result, key: 'row' },
        { ...result, key: 'other' },
      ],
      clients: downloadClients(config),
    })
    assert.ok('review' in planned)
    return planned.review.blocked.map(row => [row.key, row.code, row.reason])
  }
  assert.deepEqual(await plan([pick('row')]), [['row', 'invalid', reason]])
  assert.deepEqual(await plan([pick('row', 'usenet')]), [['row', 'invalid', reason]])
  assert.deepEqual(await plan([pick('row'), pick('other')]), [
    ['row', 'invalid', reason],
    ['other', 'invalid', reason],
  ])
})

test('no Usenet lookup or search is started for a release excluded for its episode order', async () => {
  const items = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/seadex/panty-stocking-s2.json', import.meta.url), 'utf8'),
  ).items
  const { result } = await replayCatalog(items, {
    season: 2,
    parts: [{ alid: 151799, episodes: 13 }],
    seasonEpisodes: 13,
  })
  const index = result.releases.findIndex(release => release.releaseGroup === 'NAN0')
  const swept = prefetchPlan([result], new Set()).flatMap(entry => entry.releases.map(release => release.releaseGroup))
  assert.deepEqual(swept, ['GetItTwisted'])
  const config: Config = { ...DEFAULT_CONFIG, download_mode: 'choose', animetosho_enabled: true }
  const row = { key: result.key, release: index }
  const answered = await usenetAvailability(
    config,
    [{ ...row, identity: releaseIdentity(result.releases[index]) }],
    [result],
    {
      search: [row],
      verify: [row],
    },
  )
  assert.deepEqual(answered, [])
})
