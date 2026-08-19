import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, test } from 'node:test'
import {
  anilistChain, arrApiUrl, arrBaseUrl, arrItemUrl, commonBestRelease, decryptSecretValues, DEFAULT_CONFIG, encryptSecretValues,
  getState, orderedPartReleases, pickAniListSearchResult, pickBest, publicConfig,
  resetRuntimeForTests, runScan, testIntegration,
} from '../server/app.js'
import type { JsonObject, ReleaseCandidate } from '../server/types.js'

function node(id: number, title: string, year: number | null, season: string | null, episodes: number | null, options: JsonObject = {}): JsonObject {
  const edges: JsonObject[] = []
  if (options.sequel) edges.push({ relationType: 'SEQUEL', node: { id: options.sequel } })
  if (options.prequel) edges.push({ relationType: 'PREQUEL', node: { id: options.prequel } })
  if (options.sideStory) edges.push({ relationType: 'SIDE_STORY', node: { id: options.sideStory } })
  return {
    id, format: options.format || 'TV', season, seasonYear: year, episodes,
    title: { english: title, romaji: title }, coverImage: { large: `cover-${id}` },
    bannerImage: `banner-${id}`, relations: { edges },
  }
}

function release(group: string, count: number, best = false, hashCharacter = 'a'): ReleaseCandidate {
  return {
    releaseGroup: group, tracker: 'Nyaa', quality: '1080p Blu-ray', tags: [],
    size: count * 100, file_count: count, info_hashes: [hashCharacter.repeat(40)], is_best: best,
  }
}

function seadexEntry(alid: number, candidate: ReleaseCandidate, bucket = 0): JsonObject {
  return { url: `https://releases.moe/${alid}/`, notes: '-', seasons: { [bucket]: { candidates: [candidate] } } }
}

async function makeChain(nodes: Map<number, JsonObject>) {
  const baseId = nodes.keys().next().value as number
  return anilistChain('Test Series', {}, {
    lookup: (async () => ({ id: baseId, cover: `cover-${baseId}`, banner: `banner-${baseId}` })) as any,
    media: (async (_query: string, variables: JsonObject) => nodes.get(variables.id) || {}) as any,
    persist: (() => undefined) as any,
  })
}

beforeEach(() => resetRuntimeForTests())

describe('configuration secret security', () => {
  test('encrypts and authenticates configuration secrets', () => {
    const key = randomBytes(32)
    const secrets = {
      sonarr_key: 'sonarr-secret',
      radarr_key: 'radarr-secret',
      qbittorrent_pass: 'qb-secret',
      webhook: 'https://discord.example/secret',
    }
    const encrypted = encryptSecretValues(secrets, key)

    assert.equal(encrypted.algorithm, 'aes-256-gcm')
    assert.equal(JSON.stringify(encrypted).includes('sonarr-secret'), false)
    assert.deepEqual(decryptSecretValues(encrypted, key), secrets)

    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }
    assert.throws(() => decryptSecretValues(tampered, key), /Could not decrypt secrets/)
  })

  test('redacts secrets from the public configuration response', () => {
    const response = publicConfig({
      ...DEFAULT_CONFIG,
      sonarr_key: 'sonarr-secret',
      qbittorrent_pass: 'qb-secret',
    })

    assert.equal(response.sonarr_key, '')
    assert.equal(response.sonarr_key_configured, true)
    assert.equal(response.radarr_key_configured, false)
    assert.equal(response.qbittorrent_pass, '')
    assert.equal(response.qbittorrent_pass_configured, true)
  })
})

describe('Sonarr and Radarr URL normalization', () => {
  test('adds the API path to plain base URLs', () => {
    assert.equal(arrApiUrl('https://sonarr.example.com/'), 'https://sonarr.example.com/api/v3')
    assert.equal(arrApiUrl('https://host.example/radarr'), 'https://host.example/radarr/api/v3')
  })

  test('accepts and removes legacy API paths without duplicating them', () => {
    assert.equal(arrBaseUrl('https://sonarr.example.com/api/v3/'), 'https://sonarr.example.com')
    assert.equal(arrApiUrl('https://sonarr.example.com/api/v3'), 'https://sonarr.example.com/api/v3')
    assert.equal(
      arrItemUrl({ sonarr_url: 'https://host.example/sonarr/api/v3' }, { arr: 'Sonarr', slug: 'example' }),
      'https://host.example/sonarr/series/example',
    )
  })

  test('tests Sonarr using the normalized API endpoint', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), 'https://sonarr.example.com/api/v3/system/status')
      assert.equal(new Headers(init?.headers).get('X-Api-Key'), 'test-key')
      return new Response(JSON.stringify({ appName: 'Sonarr', version: '4.0.0' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      assert.equal(await testIntegration({ ...DEFAULT_CONFIG, sonarr_url: 'https://sonarr.example.com', sonarr_key: 'test-key' }, 'sonarr'), 'Connected to Sonarr 4.0.0')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('AniList season chains', () => {
  test('keeps SPY x FAMILY cour two in season one', async () => {
    const nodes = new Map([
      [140960, node(140960, 'SPY x FAMILY', 2022, 'SPRING', 12, { sequel: 142838 })],
      [142838, node(142838, 'SPY x FAMILY Cour 2', 2022, 'FALL', 13, { sequel: 158927, prequel: 140960 })],
      [158927, node(158927, 'SPY x FAMILY Season 2', 2023, 'FALL', 12, { sequel: 177937, prequel: 142838 })],
      [177937, node(177937, 'SPY x FAMILY Season 3', 2025, 'FALL', 13, { prequel: 158927 })],
    ])
    const chain = await makeChain(nodes)
    assert.deepEqual(chain.map((entry) => entry.ids), [[140960, 142838], [158927], [177937]])
    assert.deepEqual(chain.map((entry) => entry.season), [1, 2, 3])
    assert.equal(chain[0].episodeCount, 25)
  })

  test('does not merge normally numbered seasons', async () => {
    const nodes = new Map([
      [1, node(1, 'Example', 2020, 'SPRING', 12, { sequel: 2 })],
      [2, node(2, 'Example Season 2', 2021, 'SPRING', 12, { sequel: 3, prequel: 1 })],
      [3, node(3, 'Example Season 3', 2022, 'SPRING', 12, { prequel: 2 })],
    ])
    assert.deepEqual((await makeChain(nodes)).map((entry) => entry.ids), [[1], [2], [3]])
  })

  test('prefers canonical titles over side stories or sequels', () => {
    const frieren = [
      { id: 170068, format: 'ONA', seasonYear: 2023, title: { romaji: 'Sousou no Frieren: ●● no Mahou' } },
      { id: 154587, format: 'TV', seasonYear: 2023, title: { english: 'Frieren: Beyond Journey’s End' } },
    ]
    const fate = [
      { id: 21379, format: 'TV', seasonYear: 2016, title: { english: 'Fate/kaleid liner Prisma☆Illya 3rei!!' } },
      { id: 14829, format: 'ONA', seasonYear: 2013, title: { english: 'Fate/kaleid liner Prisma☆Illya' } },
    ]
    assert.equal(pickAniListSearchResult(frieren, "Frieren: Beyond Journey's End")?.id, 154587)
    assert.equal(pickAniListSearchResult(fate, 'Fate/kaleid liner PRISMA ILLYA')?.id, 14829)
  })

  test('does not confuse Frieren TV seasons with side-story ONAs', async () => {
    const nodes = new Map([
      [154587, node(154587, 'Frieren: Beyond Journey’s End', 2023, 'FALL', 28, { sequel: 182255, sideStory: 170068 })],
      [182255, node(182255, 'Frieren: Beyond Journey’s End Season 2', 2026, 'WINTER', 10, { prequel: 154587, sideStory: 206425 })],
      [170068, node(170068, 'Frieren: ●● no Mahou', 2023, 'FALL', 12, { format: 'ONA' })],
      [206425, node(206425, 'Frieren: ●● no Mahou Part 3', 2026, 'WINTER', null, { format: 'ONA' })],
    ])
    assert.deepEqual((await makeChain(nodes)).map((entry) => entry.ids), [[154587], [182255]])
  })

  test('keeps undated future seasons after earlier sequels', async () => {
    const nodes = new Map([
      [21202, node(21202, 'KONOSUBA S1', 2016, 'WINTER', 10, { sequel: 21699 })],
      [21699, node(21699, 'KONOSUBA S2', 2017, 'WINTER', 10, { sequel: 102976, prequel: 21202 })],
      [102976, node(102976, 'KONOSUBA Legend of Crimson', 2019, 'FALL', 1, { format: 'MOVIE', sequel: 136804, prequel: 21699 })],
      [136804, node(136804, 'KONOSUBA S3', 2024, 'SPRING', 11, { sequel: 187924, prequel: 102976 })],
      [187924, node(187924, 'KONOSUBA S4', null, null, null, { prequel: 136804 })],
    ])
    assert.deepEqual((await makeChain(nodes)).map((entry) => entry.ids), [[21202], [21699], [136804], [187924]])
  })

  test('starts Fate/kaleid at the original series', async () => {
    const nodes = new Map([
      [14829, node(14829, 'Fate/kaleid liner Prisma☆Illya', 2013, 'SUMMER', 10, { sequel: 20467 })],
      [20467, node(20467, 'Fate/kaleid liner Prisma☆Illya 2wei!', 2014, 'SUMMER', 10, { sequel: 20845, prequel: 14829 })],
      [20845, node(20845, 'Fate/kaleid liner Prisma☆Illya 2wei Herz!', 2015, 'SUMMER', 10, { sequel: 21379, prequel: 20467 })],
      [21379, node(21379, 'Fate/kaleid liner Prisma☆Illya 3rei!!', 2016, 'SUMMER', 12, { prequel: 20845, sideStory: 87488 })],
      [87488, node(87488, 'Short Anime', 2016, null, 6, { format: 'SPECIAL' })],
    ])
    assert.deepEqual((await makeChain(nodes)).map((entry) => entry.ids), [[14829], [20467], [20845], [21379]])
  })
})

describe('release selection and combined cours', () => {
  test('publishes completed anime while the scan is still running', async () => {
    let releaseSecondItem!: () => void
    let secondItemStarted!: () => void
    const secondItemIsRunning = new Promise<void>((resolve) => { secondItemStarted = resolve })
    const secondItemCanFinish = new Promise<void>((resolve) => { releaseSecondItem = resolve })
    let calls = 0
    const scan = runScan({ sonarr_url: 'http://sonarr/api/v3' }, {
      seadexBest: (async () => new Map()) as any,
      localItems: (async () => [
        { arr: 'Sonarr', id: 1, title: 'First', seasons: { 1: { groups: ['A'], size: 100 } } },
        { arr: 'Sonarr', id: 2, title: 'Second', seasons: { 1: { groups: ['B'], size: 200 } } },
      ]) as any,
      anilistChain: (async () => {
        calls += 1
        if (calls === 2) { secondItemStarted(); await secondItemCanFinish }
        return []
      }) as any,
      loadCache: () => ({}), saveLastResults: () => undefined,
      autoNotifyNew: async () => 0,
    })

    await secondItemIsRunning
    const partial = getState()
    assert.equal(partial.running, true)
    assert.equal(partial.progress, 1)
    assert.deepEqual(partial.results.map((item) => item.title), ['First'])

    releaseSecondItem()
    await scan
    assert.deepEqual(getState().results.map((item) => item.title), ['First', 'Second'])
  })

  test('treats a filler SeaDex page with no releases as uncovered', async () => {
    const best = new Map([[300, {
      url: 'https://releases.moe/300/',
      notes: '-',
      seasons: {},
    }]])
    const chain = [{
      season: 1,
      id: 300,
      ids: [300],
      parts: [{ id: 300, episodeCount: 12 }],
      cover: 'cover-300',
      banner: 'banner-300',
    }]
    await scanWith(best, chain, [{
      arr: 'Sonarr', id: 30, title: 'Filler Page', slug: 'filler-page',
      seasons: { 1: { groups: ['Local'], size: 1000 } },
    }])

    const result = getState().results[0]
    assert.equal(result.status, 'uncovered')
    assert.equal(result.url, 'https://releases.moe/300/')
    assert.deepEqual(result.releases, [])
  })

  test('gives the best flag priority over episode count', () => {
    const ttga = release('TTGA', 14, true, 'a'); const yurasuka = release('YURASUKA', 13, false, 'b')
    const [best, alternatives] = pickBest([ttga, yurasuka], 13)
    assert.equal(best?.releaseGroup, 'TTGA')
    assert.deepEqual(orderedPartReleases(best!, alternatives).map(([kind, item]) => [kind, item.releaseGroup]), [['best', 'TTGA'], ['alt', 'YURASUKA']])
  })

  test('deduplicates release groups', () => {
    const best = release('Flugel', 12, true, 'a')
    const alternateTracker = release('Flugel', 12, false, 'private'); alternateTracker.tracker = 'AB'
    const other = release('Okay-Subs', 12, false, 'c')
    const ordered = orderedPartReleases(best, [alternateTracker, other])
    assert.deepEqual(ordered.map(([, item]) => item.releaseGroup), ['Flugel', 'Okay-Subs'])
    assert.equal(ordered[0][1].tracker, 'Nyaa')
  })

  test('prefers a downloadable tracker for the same group', () => {
    const privateBest = release('Bunny-Apocalypse', 12, true, 'private'); privateBest.tracker = 'AB'
    const publicCopy = release('Bunny-Apocalypse', 12, false, 'b')
    const preferred = orderedPartReleases(privateBest, [publicCopy])
    assert.equal(preferred.length, 1); assert.equal(preferred[0][0], 'best'); assert.equal(preferred[0][1].tracker, 'Nyaa')
  })

  test('requires exact hashes for a common best release', () => {
    const shared = 'a'.repeat(40)
    const first = release('Group', 2, true); first.info_hashes = [shared, 'b'.repeat(40)]
    const second = release('Group', 2, true); second.info_hashes = [shared, 'c'.repeat(40)]
    assert.equal(commonBestRelease([{ best: first, alts: [] }, { best: second, alts: [] }], new Set(['group'])), null)
  })

  test('an owned common torrent satisfies both cours', async () => {
    const chain = [
      { season: 1, id: 1, ids: [1], parts: [{ id: 1, episodeCount: 12 }], cover: 'cover-1', banner: 'banner-1' },
      { season: 2, id: 21, ids: [21, 22], parts: [{ id: 21, episodeCount: 13 }, { id: 22, episodeCount: 12 }], cover: 'cover-2', banner: 'banner-2' },
    ]
    const mtbb1 = release('MTBB', 25, true, 'a'); const mtbb2 = release('MTBB', 25, true, 'a')
    const diddy1 = release('Diddy', 24, true, 'b'); const diddy2 = release('Diddy', 24, true, 'b')
    const private1 = release('MTBB', 13, true, 'private'); private1.tracker = 'AB'
    const private2 = release('Diddy', 12, true, 'private'); private2.tracker = 'AB'
    const entry = (id: number, candidates: ReleaseCandidate[]) => ({ url: `https://releases.moe/${id}/`, notes: '-', seasons: { 2: { candidates } } })
    const best = new Map([[21, entry(21, [mtbb1, private1, diddy1])], [22, entry(22, [mtbb2, diddy2, private2])]])
    await scanWith(best, chain, [{ arr: 'Sonarr', id: 10, title: 'Combined Season', slug: 'combined-season', seasons: { 2: { groups: ['MTBB'], size: 2500 } } }])
    const result = getState().results[0]
    assert.equal(result.status, 'best'); assert.equal(result.best_group, 'MTBB'); assert.equal(result.best_size, 2500)
    assert.deepEqual(result.releases.map((item: JsonObject) => item.releaseGroup), ['MTBB', 'Diddy', 'MTBB', 'Diddy'])
    assert.deepEqual(result.releases.map((item: JsonObject) => item.part), ['Cour 1', 'Cour 1', 'Cour 2', 'Cour 2'])
  })

  test('checks both cours and maps the actual second season', async () => {
    const chain = [
      { season: 1, id: 140960, ids: [140960, 142838], parts: [{ id: 140960, episodeCount: 12 }, { id: 142838, episodeCount: 13 }], cover: 'cover-1', banner: 'banner-1' },
      { season: 2, id: 158927, ids: [158927], parts: [{ id: 158927, episodeCount: 12 }], cover: 'cover-2', banner: 'banner-2' },
    ]
    const best = new Map([
      [140960, seadexEntry(140960, release('ABdex', 12, true, 'a'))],
      [142838, seadexEntry(142838, release('NAN0', 13, true, 'b'))],
      [158927, seadexEntry(158927, release('NAN0', 12, true, 'c'))],
    ])
    await scanWith(best, chain, [{ arr: 'Sonarr', id: 10, title: 'SPY x FAMILY', slug: 'spy-x-family', seasons: { 1: { groups: ['ABdex'], size: 2500 }, 2: { groups: ['scoot'], size: 1200 } } }])
    const [seasonOne, seasonTwo] = getState().results
    assert.deepEqual(seasonOne.anilist_ids, [140960, 142838]); assert.equal(seasonOne.status, 'upgrade')
    assert.equal(seasonOne.best_group, 'ABdex + NAN0'); assert.deepEqual(seasonOne.releases.map((item: JsonObject) => item.part), ['Cour 1', 'Cour 2'])
    assert.equal(seasonTwo.anilist_id, 158927); assert.equal(seasonTwo.url, 'https://releases.moe/158927/')
  })

  test('owning any best-flagged release is best quality', async () => {
    const ntrx = release('NTRX', 13, true, 'a'); ntrx.size = 15300
    const okay = release('Okay-Subs', 13, true, 'b'); okay.size = 14600
    const best = new Map([[100, { url: 'https://releases.moe/100/', notes: '-', seasons: { 1: { candidates: [ntrx, okay] } } }]])
    const chain = [{ season: 1, id: 100, ids: [100], parts: [{ id: 100, episodeCount: 13 }], cover: 'cover-100', banner: 'banner-100' }]
    await scanWith(best, chain, [{ arr: 'Sonarr', id: 10, title: 'Call of the Night', slug: 'call-of-the-night', seasons: { 1: { groups: ['Okay-Subs'], size: 14600 } } }])
    const result = getState().results[0]
    assert.equal(result.status, 'best')
    assert.deepEqual(result.releases.map((item: JsonObject) => [item.kind, item.releaseGroup]), [['best', 'NTRX'], ['best', 'Okay-Subs']])
  })
})

async function scanWith(best: Map<number, JsonObject>, chain: JsonObject[], items: JsonObject[]): Promise<void> {
  await runScan({ sonarr_url: 'http://sonarr/api/v3' }, {
    seadexBest: (async () => best) as any,
    localItems: (async () => items) as any,
    anilistChain: (async () => chain) as any,
    loadCache: () => ({}), saveLastResults: () => undefined,
    autoNotifyNew: async () => 0,
  })
}
