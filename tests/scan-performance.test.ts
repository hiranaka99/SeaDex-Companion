import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAniListClient } from '../server/anilist-client.js'
import { anilistChain, anilistSeason } from '../server/anilist.js'
import { ANILIST_CACHE_TTL, loadAniListMedia } from '../server/anilist-metadata.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { buildScanHistoryEntry } from '../server/history.js'
import { scanRequests } from '../server/http.js'
import { createScanService, type ScanDependencies } from '../server/scan.js'
import { getState, setState } from '../server/scan-state.js'
import type { JsonObject, LocalItem, ReleaseCandidate } from '../server/types.js'

function media(id: number, sequels: number[] = []): JsonObject {
  return {
    id,
    type: 'ANIME',
    format: 'TV',
    episodes: 2,
    title: { english: `Anime ${id}` },
    relations: { edges: sequels.map(next => ({ relationType: 'SEQUEL', node: { id: next, type: 'ANIME' } })) },
  }
}

test('metadata batches deduplicate IDs, respect batch size, and preserve manual selection order', async () => {
  const cache: JsonObject = {},
    batches: number[][] = []
  const dependencies = {
    batch: async (query: string, variables: JsonObject) => {
      assert.match(query, /Page\(page:1,perPage:25\)/)
      assert.match(query, /media\(id_in:\$ids,type:ANIME\)/)
      batches.push(variables.ids)
      return [...variables.ids].reverse().map(id => media(id))
    },
    persist: () => {},
    now: () => 1_000_000,
  }
  const ids = Array.from({ length: 60 }, (_, index) => index + 1)
  const loaded = await loadAniListMedia([...ids, ...ids, 0, -1, NaN], cache, dependencies)
  assert.deepEqual(
    batches.map(batch => batch.length),
    [25, 25, 10],
  )
  assert.equal(loaded.size, 60)
  const season = await anilistSeason([3, 1, 2], cache, dependencies)
  assert.deepEqual(season?.ids, [3, 1, 2])
  assert.deepEqual(
    season?.parts.map(part => part.title),
    ['Anime 3', 'Anime 1', 'Anime 2'],
  )
  assert.equal(batches.length, 3, 'Manual matches reuse shared raw metadata')
  await anilistChain('Saved metadata', JSON.parse(JSON.stringify(cache)), dependencies, 2)
  assert.equal(batches.length, 3, 'Raw metadata survives cache reloads')
})

test('overlapping chains and manual matches share metadata while retaining traversal order', async () => {
  const cache: JsonObject = {},
    batches: number[][] = []
  const nodes = new Map([
    [1, media(1, [3, 2])],
    [2, media(2, [4])],
    [3, media(3, [4])],
    [4, media(4)],
  ])
  const dependencies = {
    batch: async (_query: string, variables: JsonObject) => {
      batches.push(variables.ids)
      return [...variables.ids].reverse().map(id => nodes.get(id)!)
    },
    persist: () => {},
    now: () => 1_000_000,
  }
  const chain = await anilistChain('First', cache, dependencies, 1)
  assert.deepEqual(
    chain.map(entry => entry.id),
    [1, 3, 2, 4],
    'API response ordering cannot reorder the chain',
  )
  assert.deepEqual(batches, [[1], [3, 2], [4]])
  assert.deepEqual(
    (await anilistChain('Second', cache, dependencies, 2)).map(entry => entry.id),
    [2, 4],
  )
  assert.deepEqual((await anilistSeason([4, 2], cache, dependencies))?.ids, [4, 2])
  assert.equal(batches.length, 3, 'Overlapping chains and overrides make no duplicate requests')
})

test('derived caches retain raw metadata age and refresh at the 24-hour boundary', async () => {
  const cache: JsonObject = {}
  let clock = 1_000_000,
    requests = 0
  const dependencies = {
    now: () => clock,
    persist: () => {},
    batch: async () => {
      requests++
      return [media(1)]
    },
  }
  await loadAniListMedia([1], cache, dependencies)
  clock += ANILIST_CACHE_TTL - 1
  await anilistSeason([1], cache, dependencies)
  await anilistChain('Anime', cache, dependencies, 1)
  assert.equal(requests, 1)
  assert.equal(cache['season:v1:1'].fetched_at, 1_000_000)
  assert.equal(cache['chain:v8:1'].fetched_at, 1_000_000)
  clock++
  await anilistChain('Anime', cache, dependencies, 1)
  await anilistSeason([1], cache, dependencies)
  assert.equal(requests, 2, 'Refreshing raw metadata once serves both derived caches')
  cache['media:v1:1'].fetched_at = clock + 1
  await loadAniListMedia([1], cache, dependencies)
  assert.equal(requests, 3, 'Future timestamps are invalid')
})

test('new seasons recheck fresh relations and discover newly linked sequels only once', async () => {
  const cache: JsonObject = {},
    batches: number[][] = []
  let linked = false
  const dependencies = {
    batch: async (_query: string, variables: JsonObject) => {
      batches.push(variables.ids)
      return variables.ids.map((id: number) => media(id, id === 1 && linked ? [2] : []))
    },
    persist: () => {},
    now: () => 1_000_000,
  }
  await anilistChain('Anime', cache, dependencies, 1, { requiredSeasons: [1] })
  linked = true
  const chain = await anilistChain('Anime', cache, dependencies, 1, { requiredSeasons: [1, 2] })
  assert.deepEqual(
    chain.map(entry => entry.id),
    [1, 2],
  )
  assert.deepEqual(batches, [[1], [1], [2]])
  await anilistChain('Anime', cache, dependencies, 1, { requiredSeasons: [1, 2] })
  assert.equal(batches.length, 3)
})

test('saved sequel chains refresh together and still discover additional sequels', async () => {
  const cache: JsonObject = { 'chain:v8:1': { chain: [1, 2, 3].map(id => ({ id, ids: [id] })), fetched_at: 0 } }
  const batches: number[][] = []
  const chain = await anilistChain(
    'Anime',
    cache,
    {
      now: () => ANILIST_CACHE_TTL + 1,
      persist: () => {},
      batch: async (_query, variables) => {
        batches.push(variables.ids)
        return variables.ids.map((id: number) => media(id, id < 4 ? [id + 1] : []))
      },
    },
    1,
  )
  assert.deepEqual(
    chain.map(entry => entry.id),
    [1, 2, 3, 4],
  )
  assert.deepEqual(batches, [[1, 2, 3], [4]])
})

test('missing IDs stay unresolved and failures never poison the shared cache', async () => {
  const cache: JsonObject = {}
  const dependencies = { batch: async () => [media(1)], persist: () => {}, now: () => 1_000_000 }
  assert.equal(await anilistSeason([1, 404], cache, dependencies), null)
  assert.equal(cache['media:v1:404'].media, null)
  assert.deepEqual((await anilistSeason([1], cache, dependencies))?.ids, [1])
  await assert.rejects(
    loadAniListMedia([2], cache, {
      ...dependencies,
      batch: async () => {
        throw new Error('Service unavailable')
      },
    }),
    /Service unavailable/,
  )
  assert.equal(cache['media:v1:2'], undefined)
  await assert.rejects(
    loadAniListMedia([2], cache, { ...dependencies, batch: async () => [media(999)] }),
    /invalid batch metadata/,
  )
  assert.equal(cache['media:v1:2'], undefined)
})

test('batch responses share pacing and rate-limit backoff with searches and individual requests', async () => {
  let clock = 10_000
  const starts: number[] = [],
    pauses: number[] = []
  let calls = 0
  const client = createAniListClient({
    now: () => clock,
    sleep: async delay => {
      pauses.push(delay)
      clock += delay
    },
    fetch: async () => {
      starts.push(clock)
      if (++calls === 2) return new Response('', { status: 429, headers: { 'Retry-After': '5' } })
      return Response.json({ data: { Media: media(1), Page: { media: [media(1)] } } })
    },
  })
  const result = await Promise.all([client.search('search', {}), client.batch('batch', {}), client.media('media', {})])
  assert.equal(result.length, 3)
  assert.deepEqual(starts, [10_000, 12_100, 18_100, 20_200])
  assert.deepEqual(pauses, [2100, 6000, 2100])
})

test('invalid or failed batch responses are errors instead of cached missing entries', async () => {
  for (const response of [
    Response.json({ data: {} }),
    new Response('', { status: 404 }),
    Response.json({ data: null, errors: [{ status: 404, message: 'Not Found.' }] }),
  ]) {
    let calls = 0
    const client = createAniListClient({
      now: () => 10_000,
      sleep: async () => {},
      fetch: async () => {
        calls++
        return response.clone()
      },
    })
    await assert.rejects(client.batch('query', {}), /batch request failed after 6 attempts/)
    assert.equal(calls, 6)
  }
})

test('cancelling metadata loading stops before cache commit or subsequent batches', async () => {
  const controller = new AbortController(),
    cache: JsonObject = {}
  let calls = 0
  const pending = scanRequests.run(controller.signal, () =>
    loadAniListMedia(
      Array.from({ length: 60 }, (_, index) => index + 1),
      cache,
      {
        batch: async (_query, variables) => {
          calls++
          controller.abort()
          return variables.ids.map((id: number) => media(id))
        },
        persist: () => assert.fail('Cancelled responses must not be committed'),
      },
    ),
  )
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.deepEqual(cache, {})
})

function scanFixture(overrides: ScanDependencies) {
  return createScanService({
    seadexBest: async () => new Map(),
    loadCache: () => ({}),
    loadUserRules: () => ({ mappings: {}, exclusions: [] }),
    saveLastResults: () => {},
    autoNotifyNew: async () => 0,
    unhideNewBestReleases: () => [],
    recordScanHistory: (previous, current, at, _file, trigger, metadata) =>
      buildScanHistoryEntry(previous, current, at, trigger, metadata),
    ...overrides,
  })
}

test('a 100-title scan refreshes metadata in four paced requests and reuses it on the next scan', async () => {
  const before = getState(),
    cache: JsonObject = {},
    batches: number[][] = []
  let clock = 1_000_000
  const items: LocalItem[] = Array.from({ length: 100 }, (_, index) => ({
    arr: 'Sonarr',
    id: index + 1,
    title: `Anime ${index + 1}`,
    seasons: { 1: { groups: [], size: 0 } },
  }))
  for (const item of items) cache[`lookup:v3:${item.title}`] = { id: item.id }
  const client = createAniListClient({
    now: () => clock,
    sleep: async delay => {
      clock += delay
    },
    fetch: async (_url, init) => {
      const { ids } = JSON.parse(String(init?.body)).variables
      batches.push(ids)
      return Response.json({ data: { Page: { media: ids.map((id: number) => media(id)) } } })
    },
  })
  const service = scanFixture({
    localItems: async () => items,
    loadCache: () => cache,
    anilistChain: (title, saved, dependencies, id, options) =>
      anilistChain(
        title,
        saved,
        { ...dependencies, batch: client.batch, persist: () => {}, now: () => clock },
        id,
        options,
      ),
  })
  try {
    setState({ results: [], error: null })
    await service.run(DEFAULT_CONFIG)
    assert.equal(getState().error, null)
    assert.equal(getState().results.length, 100)
    assert.ok(getState().results.every(result => result.match_status === 'matched'))
    assert.deepEqual(
      batches.map(batch => batch.length),
      [25, 25, 25, 25],
    )
    assert.equal(clock - 1_000_000, 6300, 'Four requests retain three full 2.1-second pacing intervals')
    await service.run(DEFAULT_CONFIG)
    assert.equal(batches.length, 4, 'The warm scan needs no additional AniList requests')
    clock += ANILIST_CACHE_TTL
    await service.run(DEFAULT_CONFIG)
    assert.equal(getState().error, null)
    assert.equal(batches.length, 8, 'Daily expiry still refreshes all metadata')
  } finally {
    setState(before)
  }
})

test('a running scan publishes each title once and keeps the results it already published', async () => {
  const before = getState()
  const items: LocalItem[] = Array.from({ length: 4 }, (_, index) => ({
    arr: 'Sonarr',
    id: index + 1,
    title: `Anime ${index + 1}`,
    seasons: { 1: { groups: [], size: 0 }, 2: { groups: [], size: 0 } },
  }))
  const snapshots: (typeof before.results)[] = []
  const service = scanFixture({
    localItems: async () => items,
    anilistChain: async () => {
      snapshots.push(getState().results)
      return []
    },
  })
  try {
    setState({ results: [], error: null })
    await service.run(DEFAULT_CONFIG)
    assert.equal(getState().error, null)
    assert.deepEqual(
      snapshots.map(snapshot => snapshot.length),
      [0, 2, 4, 6],
      'Every title publishes its seasons before the next title starts',
    )
    for (const [index, snapshot] of snapshots.entries())
      for (const [position, result] of snapshot.entries())
        assert.equal(
          snapshots.at(-1)![position],
          result,
          `Result ${position} published after title ${index} is not normalized again`,
        )
    assert.equal(getState().results.length, 8)
  } finally {
    setState(before)
  }
})

test('fully manual seasons skip automatic lookup and retain continuous episode ranges and show anchor', async () => {
  const before = getState(),
    cache: JsonObject = {}
  const files = Array.from({ length: 4 }, (_, index) => ({
    name: `Anime - ${String(index + 1).padStart(2, '0')}.mkv`,
    length: 100,
  }))
  const release: ReleaseCandidate = {
    releaseGroup: 'Best',
    tracker: 'Nyaa',
    quality: '1080p',
    tags: [],
    size: 400,
    file_count: 4,
    info_hashes: ['a'.repeat(40)],
    is_best: true,
    source_files: files,
  }
  let calls = 0
  const service = scanFixture({
    localItems: async () => [
      {
        arr: 'Sonarr',
        id: 1,
        title: 'Unknown title',
        seasons: {
          1: { groups: [], size: 0, episode_count: 2 },
          2: { groups: [], size: 0, episode_count: 2 },
        },
      },
    ],
    loadCache: () => cache,
    loadUserRules: () => ({
      mappings: { 'Sonarr:item1': 900 },
      season_mappings: { 'Sonarr:item1:1': [1], 'Sonarr:item1:2': [1] },
      exclusions: [],
    }),
    seadexBest: async () =>
      new Map([[1, { url: 'https://seadex.moe/1', notes: '-', seasons: { 0: { candidates: [release] } } }]]),
    anilistChain: async () => assert.fail('Full manual coverage must skip automatic title and sequel lookup'),
    anilistSeason: (ids, saved, dependencies) =>
      anilistSeason(ids, saved, {
        ...dependencies,
        batch: async () => {
          calls++
          return [{ ...media(1, [999]), episodes: 4 }]
        },
        persist: () => {},
      }),
  })
  try {
    setState({ results: [], error: null })
    await service.run(DEFAULT_CONFIG)
    const state = getState()
    assert.equal(state.error, null)
    assert.equal(calls, 1, 'Repeated manual IDs are requested only once; unrelated sequels are never traversed')
    assert.deepEqual(
      state.results.map(result => result.group_id),
      [900, 900],
    )
    assert.deepEqual(
      state.results.map(result => result.anilist_id),
      [1, 1],
    )
    assert.deepEqual(
      state.results.map(result => result.releases[0].selected_files),
      [files.slice(0, 2).map(file => file.name), files.slice(2).map(file => file.name)],
    )
  } finally {
    setState(before)
  }
})

test('unrelated fully manual matches are batched without inferring a continuous split', async () => {
  const before = getState(),
    cache: JsonObject = {},
    batches: number[][] = []
  const files = Array.from({ length: 4 }, (_, index) => ({
    name: `Anime - ${String(index + 1).padStart(2, '0')}.mkv`,
    length: 100,
  }))
  const candidate: ReleaseCandidate = {
    releaseGroup: 'Best',
    tracker: 'Nyaa',
    quality: '1080p',
    tags: [],
    size: 400,
    file_count: 4,
    info_hashes: ['a'.repeat(40)],
    is_best: true,
    source_files: files,
  }
  const service = scanFixture({
    localItems: async () => [
      {
        arr: 'Sonarr',
        id: 1,
        title: 'Manual title',
        seasons: {
          1: { groups: [], size: 0, episode_count: 2 },
          2: { groups: [], size: 0, episode_count: 2 },
        },
      },
    ],
    loadCache: () => cache,
    loadUserRules: () => ({
      mappings: {},
      season_mappings: { 'Sonarr:item1:1': [1], 'Sonarr:item1:2': [2] },
      exclusions: [],
    }),
    seadexBest: async () =>
      new Map(
        [1, 2].map(id => [
          id,
          { url: `https://seadex.moe/${id}`, notes: '-', seasons: { 0: { candidates: [candidate] } } },
        ]),
      ),
    anilistChain: async () => assert.fail('Full manual coverage must not use automatic lookup'),
    anilistSeason: (ids, saved, dependencies) =>
      anilistSeason(ids, saved, {
        ...dependencies,
        batch: async (_query, variables) => {
          batches.push(variables.ids)
          return variables.ids.map((id: number) => ({ ...media(id), episodes: id === 1 ? 4 : 2 }))
        },
        persist: () => {},
      }),
  })
  try {
    setState({ results: [], error: null })
    await service.run(DEFAULT_CONFIG)
    assert.equal(getState().error, null)
    assert.deepEqual(batches, [[1, 2]])
    assert.deepEqual(
      getState().results.map(result => result.anilist_id),
      [1, 2],
    )
    assert.equal(
      getState().results[0].best_size,
      400,
      'The first entry must not be sliced using an unrelated next season',
    )
  } finally {
    setState(before)
  }
})

test('a failed metadata batch preserves the previous scan results and failure outcome', async () => {
  const before = getState()
  let saved = false,
    outcome: string | undefined
  const service = scanFixture({
    localItems: async () => [{ arr: 'Sonarr', id: 1, title: 'Anime', seasons: { 1: { groups: [], size: 0 } } }],
    loadCache: () => ({ 'lookup:v3:Anime': { id: 1 } }),
    anilistChain: (title, cache, dependencies, id, options) =>
      anilistChain(
        title,
        cache,
        {
          ...dependencies,
          batch: async () => {
            throw new Error('Batch unavailable')
          },
          persist: () => {},
        },
        id,
        options,
      ),
    saveLastResults: () => {
      saved = true
    },
    recordScanHistory: (previous, current, at, _file, trigger, metadata) => {
      outcome = metadata?.outcome
      return buildScanHistoryEntry(previous, current, at, trigger, metadata)
    },
  })
  try {
    setState({ results: [{ key: 'existing', title: 'Existing' }], last_run: 'previous successful scan' })
    const previous = getState()
    await service.run(DEFAULT_CONFIG)
    assert.equal(saved, false)
    assert.equal(outcome, 'failed')
    assert.match(getState().error!, /Batch unavailable/)
    assert.equal(getState().last_run, previous.last_run)
    assert.deepEqual(getState().results, previous.results)
  } finally {
    setState(before)
  }
})

test('scan history records torrent replacements once and ignores private-tracker hash placeholders', async () => {
  const before = getState()
  // Private-tracker listings only appear when private trackers are included.
  const config = { ...DEFAULT_CONFIG, tracker_mode: 'private' as const }
  const history: ReturnType<typeof buildScanHistoryEntry>[] = []
  let hash = 'restricted',
    saved: JsonObject[] = []
  const service = scanFixture({
    localItems: async () => [{ arr: 'Sonarr', id: 1, title: 'Anime', seasons: { 1: { groups: [], size: 0 } } }],
    anilistChain: async () => [{ id: 1, ids: [1], season: 1, episodeCount: 2, parts: [{ id: 1, episodeCount: 2 }] }],
    seadexBest: async () =>
      new Map([
        [
          1,
          {
            url: 'https://seadex.moe/1',
            notes: '-',
            seasons: {
              0: {
                candidates: [
                  {
                    releaseGroup: 'Best',
                    tracker: 'AB',
                    quality: '1080p',
                    tags: [],
                    size: 400,
                    file_count: 2,
                    info_hashes: [hash],
                    is_best: true,
                  },
                ],
              },
            },
          },
        ],
      ]),
    saveLastResults: results => {
      saved = JSON.parse(JSON.stringify(results))
    },
    recordScanHistory: (previous, current, at, _file, trigger, metadata) => {
      const entry = buildScanHistoryEntry(previous, current, at, trigger, metadata)
      history.push(entry)
      return entry
    },
  })
  try {
    setState({ results: [], error: null })
    await service.run(config)
    assert.equal(getState().error, null)
    assert.equal(history[0].changes[0].type, 'new')
    await service.run(config)
    assert.deepEqual(history[1].changes, [], 'An unchanged private-tracker release must not report a new torrent')
    assert.deepEqual(saved, getState().results, 'Persistence and history must use the same results as scan state')

    hash = 'a'.repeat(40)
    await service.run(config)
    assert.match(history[2].changes[0].details!.join('; '), /Torrent changed/)
    hash = 'b'.repeat(40)
    await service.run(config)
    assert.match(history[3].changes[0].details!.join('; '), /Torrent changed/)
    await service.run(config)
    assert.deepEqual(history[4].changes, [])

    setState({ results: JSON.parse(JSON.stringify(saved)) })
    await service.run(config)
    assert.deepEqual(history[5].changes, [], 'Reloading the saved baseline must not repeat the replacement')
  } finally {
    setState(before)
  }
})
