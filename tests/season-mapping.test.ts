import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, test } from 'node:test'
import {
  anilistChain, arrApiUrl, arrBaseUrl, arrItemUrl, bulkDownloadTargets, commonBestRelease, decryptSecretValues, DEFAULT_CONFIG, effectiveSeasonParts,
  encryptSecretValues, getState, localItems, localPartOwnership, normalizeQbStates, orderedPartReleases, pickAniListSearchResult, pickBest, publicConfig,
  qbAddTorrent, qbBulkAddTorrents, qbControlTorrents, releaseDict, scopeReleaseToPart,
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

  test('keeps TVDB episode numbers even when an episode has no file', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      let data: JsonObject[] = []
      if (url.endsWith('/series')) data = [{
        id: 10, title: 'Example', titleSlug: 'example',
        seasons: [{ seasonNumber: 1, statistics: { releaseGroups: ['IK'], sizeOnDisk: 100 } }],
      }]
      else if (url.includes('/episode?')) data = [
        { seasonNumber: 1, episodeNumber: 2, episodeFileId: 0 },
        { seasonNumber: 1, episodeNumber: 1, episodeFileId: 20 },
        { seasonNumber: 0, episodeNumber: 1, episodeFileId: 0 },
      ]
      else if (url.includes('/episodefile?')) data = [{ id: 20, releaseGroup: 'IK', size: 100 }]
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const items = await localItems({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr', sonarr_key: 'key' })
      assert.deepEqual(items[0].seasons[1].episode_numbers, [1, 2])
      assert.equal(items[0].seasons[1].episode_count, 2)
      assert.deepEqual(items[0].seasons[1].groups_by_episode, { IK: [1] })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('qBittorrent torrent controls', () => {
  test('selects only downloadable best releases from upgradable seasons', () => {
    const targets = bulkDownloadTargets([
      {
        key: 'upgrade-season', status: 'upgrade', arr: 'Sonarr', releases: [
          { kind: 'best', downloadable: true, info_hashes: ['a'.repeat(40)], selected_files: ['Cour 1/episode.mkv'] },
          { kind: 'alt', downloadable: true, info_hashes: ['b'.repeat(40)] },
          { kind: 'best', downloadable: false, info_hashes: ['c'.repeat(40)] },
        ],
      },
      { key: 'owned-season', status: 'best', arr: 'Sonarr', releases: [{ kind: 'best', downloadable: true, info_hashes: ['d'.repeat(40)] }] },
      { key: 'missing-season', status: 'missing', arr: 'Sonarr', releases: [] },
    ])
    assert.deepEqual(targets, [{
      key: 'upgrade-season', release: 0, arr: 'Sonarr', part: '', hashes: ['a'.repeat(40)],
      selectedFiles: ['Cour 1/episode.mkv'],
    }])
  })

  test('recognizes paused states from qBittorrent 4 and 5', () => {
    assert.equal(normalizeQbStates(['pausedDL']), 'paused')
    assert.equal(normalizeQbStates(['stoppedDL', 'stoppedUP']), 'paused')
  })

  test('pauses torrents and removes them with the selected file behavior', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      return new Response('', { status: 200 })
    }) as typeof fetch
    const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb.example', qbittorrent_user: 'admin', qbittorrent_pass: 'secret' }
    try {
      await qbControlTorrents(config, ['a'.repeat(40)], 'pause')
      await qbControlTorrents(config, ['a'.repeat(40)], 'remove', true)
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(requests[1].url, 'http://qb.example/api/v2/torrents/stop')
    assert.equal(new URLSearchParams(requests[1].body).get('hashes'), 'a'.repeat(40))
    assert.equal(requests[2].url, 'http://qb.example/api/v2/torrents/delete')
    assert.equal(new URLSearchParams(requests[2].body).get('deleteFiles'), 'true')
  })

  test('falls back to the legacy pause endpoint', async () => {
    const originalFetch = globalThis.fetch
    const paths: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      paths.push(url)
      if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.endsWith('/api/v2/torrents/stop')) return new Response('Not Found', { status: 404 })
      return new Response('', { status: 200 })
    }) as typeof fetch
    try {
      await qbControlTorrents(
        { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb.example', qbittorrent_user: 'admin', qbittorrent_pass: 'secret' },
        ['b'.repeat(40)],
        'pause',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(paths.at(-1), 'http://qb.example/api/v2/torrents/pause')
  })

  test('downloads only selected cour files after magnet metadata arrives', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/files?')) return new Response(JSON.stringify([
        { index: 4, name: 'Root/Show.S01E01.mkv' },
        { index: 9, name: 'Root/Show.S01E02.mkv' },
      ]), { status: 200 })
      return new Response('', { status: 200 })
    }) as typeof fetch

    try {
      await qbAddTorrent(
        { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb.example', qbittorrent_user: 'admin', qbittorrent_pass: 'secret' },
        `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        'sonarr-anime',
        ['Show.S01E02.mkv'],
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const add = requests.find((request) => request.url.endsWith('/api/v2/torrents/add'))!
    assert.equal(new URLSearchParams(add.body).get('paused'), 'true')
    assert.equal(new URLSearchParams(add.body).get('stopped'), 'true')
    const metadataRequest = requests.findIndex((request) => request.url.includes('/api/v2/torrents/files?'))
    const initialStart = requests.findIndex((request) => request.url.endsWith('/api/v2/torrents/start'))
    assert.ok(initialStart > 0 && initialStart < metadataRequest, 'torrent must be started before requesting magnet metadata')
    const priorities = requests.filter((request) => request.url.endsWith('/api/v2/torrents/filePrio'))
    assert.deepEqual(priorities.map((request) => Object.fromEntries(new URLSearchParams(request.body))), [
      { hash: 'a'.repeat(40), id: '4|9', priority: '0' },
      { hash: 'a'.repeat(40), id: '9', priority: '1' },
    ])
    assert.equal(requests.at(-1)?.url, 'http://qb.example/api/v2/torrents/start')
  })

  test('removes the torrent and reports a metadata failure when metadata never arrives', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/files?')) return new Response('[]', { status: 200 })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb.example', qbittorrent_user: 'admin', qbittorrent_pass: 'secret' }
    try {
      await assert.rejects(
        () => qbAddTorrent(config, `magnet:?xt=urn:btih:${'a'.repeat(40)}`, 'sonarr-anime', ['Show.S01E01.mkv'], 400),
        /metadata fetching failed/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const removal = requests.find((request) => request.url.endsWith('/api/v2/torrents/delete'))
    assert.ok(removal, 'the torrent must be removed after the metadata timeout')
    assert.equal(new URLSearchParams(removal!.body).get('deleteFiles'), 'false')
  })

  test('keeps adding the remaining torrents when one fails to fetch metadata', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/files?')) {
        const hash = new URL(url).searchParams.get('hash')
        // The first torrent never exchanges magnet metadata; the second one does.
        if (hash === 'a'.repeat(40)) return new Response('[]', { status: 200 })
        return new Response(JSON.stringify([{ index: 0, name: 'Root/Show.S01E01.mkv' }]), { status: 200 })
      }
      return new Response('', { status: 200 })
    }) as typeof fetch
    const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb.example', qbittorrent_user: 'admin', qbittorrent_pass: 'secret' }
    try {
      const outcome = await qbBulkAddTorrents(config, [
        { hash: 'a'.repeat(40), label: 'Broken Torrent', selectedFiles: ['Show.S01E01.mkv'], timeoutMs: 400 },
        { hash: 'b'.repeat(40), label: 'Working Torrent', selectedFiles: ['Show.S01E01.mkv'], timeoutMs: 4_000 },
      ])

      assert.deepEqual(outcome.added, ['b'.repeat(40)])
      assert.equal(outcome.failures.length, 1)
      assert.equal(outcome.failures[0].hash, 'a'.repeat(40))
      assert.equal(outcome.failures[0].label, 'Broken Torrent')
      assert.match(outcome.failures[0].error, /metadata fetching failed/i)
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.ok(requests.some((request) => request.url.endsWith('/api/v2/torrents/add') && new URLSearchParams(request.body).get('urls')?.includes('b'.repeat(40))),
      'the second torrent must still be added after the first one failed')
    const removal = requests.find((request) => request.url.endsWith('/api/v2/torrents/delete'))
    assert.ok(removal && new URLSearchParams(removal.body).get('hashes') === 'a'.repeat(40))
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
  test('uses TVDB totals for a single-part season instead of AniList totals', async () => {
    const best = new Map([[400, seadexEntry(400, release('IK', 12, true, 'a'))]])
    const chain = [{
      season: 1, id: 400, ids: [400], parts: [{ id: 400, episodeCount: 13 }],
      cover: 'cover-400', banner: 'banner-400',
    }]
    const episodeNumbers = Array.from({ length: 12 }, (_, index) => index + 1)
    await scanWith(best, chain, [{
      arr: 'Sonarr', id: 40, title: 'High School D×D Hero', slug: 'high-school-dxd-hero',
      seasons: { 1: { groups: ['IK'], size: 1200, episode_numbers: episodeNumbers, groups_by_episode: { IK: episodeNumbers } } },
    }])

    const result = getState().results[0]
    assert.equal(result.status, 'best')
    assert.deepEqual(result.owned_by_part, { '': ['IK'] })
  })

  test('keeps AniList cour boundaries but gives the final cour the remaining TVDB episodes', () => {
    const tvdbEpisodes = Array.from({ length: 24 }, (_, index) => 24 - index)
    const parts = effectiveSeasonParts(
      { episode_numbers: [...tvdbEpisodes, 12] },
      [{ id: 1, episodeCount: 12 }, { id: 2, episodeCount: 13 }],
    )

    assert.deepEqual(parts.map((part) => part.episodeCount), [12, 12])
    assert.deepEqual(parts[0].episodeNumbers, Array.from({ length: 12 }, (_, index) => index + 1))
    assert.deepEqual(parts[1].episodeNumbers, Array.from({ length: 12 }, (_, index) => index + 13))
  })

  test('maps owned release groups to their actual cours', () => {
    const ownership = localPartOwnership({
      groups: ['ABdex', 'LostYears', 'NAN0'],
      groups_by_episode: {
        ABdex: Array.from({ length: 12 }, (_, index) => index + 1),
        LostYears: Array.from({ length: 13 }, (_, index) => index + 13),
        NAN0: [13, 14, 15],
      },
      sizes_by_episode: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [index + 1, 10])),
    }, [{ episodeCount: 12 }, { episodeCount: 13 }])

    assert.equal(ownership.precise, true)
    assert.deepEqual(ownership.have, { 'Cour 1': ['ABdex'], 'Cour 2': ['LostYears', 'NAN0'] })
    assert.deepEqual(ownership.owned, { 'Cour 1': ['ABdex'], 'Cour 2': ['LostYears'] })
    assert.deepEqual(ownership.sizes, { 'Cour 1': 120, 'Cour 2': 130 })
  })

  test('estimates cour sizes from the season total when episode-file sizes are unavailable', () => {
    const ownership = localPartOwnership({ groups: ['Group'], size: 2500 }, [{ episodeCount: 12 }, { episodeCount: 13 }])
    assert.deepEqual(ownership.sizes, { 'Cour 1': 1200, 'Cour 2': 1300 })
  })

  test('drops extras and specials from normal season downloads', () => {
    const sourceFiles = [
      { name: 'Show.S01E01.mkv', length: 10 },
      { name: 'Show.S01E02.mkv', length: 10 },
      { name: 'Show.S00E01.Special.mkv', length: 20 },
      { name: 'Show.NCOP.mkv', length: 3 },
      { name: 'Scans/Booklet.png', length: 2 },
    ]
    const candidate = { ...release('Group', 5, true), size: 45, source_files: sourceFiles }
    const season = scopeReleaseToPart(candidate, 2, 0, 1)

    assert.equal(season.size, 20)
    assert.equal(season.file_count, 2)
    assert.deepEqual(season.selected_files, ['Show.S01E01.mkv', 'Show.S01E02.mkv'])
  })

  test('does not filter a normal season when all expected episodes cannot be identified', () => {
    const candidate = {
      ...release('Group', 2, true),
      source_files: [{ name: 'Show.S01E01.mkv', length: 10 }, { name: 'Unrecognized episode.mkv', length: 10 }],
    }
    assert.equal(scopeReleaseToPart(candidate, 2, 0, 1), candidate)
  })

  test('scopes whole-season torrents to the current cour size', () => {
    const sourceFiles = [
      ...Array.from({ length: 24 }, (_, index) => ({ name: `Show.S02E${String(index + 1).padStart(2, '0')}.mkv`, length: 10 })),
      { name: 'Show.S00E07.Special.mkv', length: 100 },
      { name: 'Show.S02P01.NCOP.mkv', length: 3 },
      { name: 'Show.S02P02.NCOP.mkv', length: 5 },
    ]
    const candidate = { ...release('Group', 24, true), size: 348, source_files: sourceFiles }
    const courTwo = scopeReleaseToPart(candidate, 12, 1, 2)
    assert.equal(courTwo.size, 125)
    assert.equal(courTwo.file_count, 12)
    assert.deepEqual(courTwo.info_hashes, candidate.info_hashes)
    assert.deepEqual(courTwo.selected_files, sourceFiles.slice(12, 24).map((file) => file.name))
    assert.deepEqual(releaseDict('best', courTwo).selected_files, courTwo.selected_files)
  })

  test('scopes torrents that use absolute episode numbers without SxxExx names', () => {
    const sourceFiles = [
      ...Array.from({ length: 24 }, (_, index) => ({ name: `[Group] Show 2nd Season ${index + 25} [1080p].mkv`, length: 10 })),
      { name: '[Group] Show 2nd Season NCOP 01.mkv', length: 3 },
      { name: '[Group] Show 2nd Season NCOP 02.mkv', length: 5 },
    ]
    const candidate = { ...release('Group', 24, true), size: 248, source_files: sourceFiles }
    assert.equal(scopeReleaseToPart(candidate, 12, 1, 2).size, 125)
  })

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
    const courOne = seadexEntry(140960, release('ABdex', 12, true, 'a')); courOne.notes = 'Cour one note'
    const courTwo = seadexEntry(142838, release('NAN0', 13, true, 'b')); courTwo.notes = 'Cour two note'
    const best = new Map([
      [140960, courOne],
      [142838, courTwo],
      [158927, seadexEntry(158927, release('NAN0', 12, true, 'c'))],
    ])
    await scanWith(best, chain, [{ arr: 'Sonarr', id: 10, title: 'SPY x FAMILY', slug: 'spy-x-family', seasons: { 1: { groups: ['ABdex'], size: 2500 }, 2: { groups: ['scoot'], size: 1200 } } }])
    const [seasonOne, seasonTwo] = getState().results
    assert.deepEqual(seasonOne.anilist_ids, [140960, 142838]); assert.equal(seasonOne.status, 'upgrade')
    assert.equal(seasonOne.best_group, 'ABdex + NAN0'); assert.deepEqual(seasonOne.releases.map((item: JsonObject) => item.part), ['Cour 1', 'Cour 2'])
    assert.deepEqual(seasonOne.notes_by_part, { 'Cour 1': 'Cour one note', 'Cour 2': 'Cour two note' })
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
