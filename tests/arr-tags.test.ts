import assert from 'node:assert/strict'
import { test } from 'node:test'
import { removeArrTags, syncArrTags, titleTagState } from '../server/arr-tags.js'
import { applyConfigUpdate, DEFAULT_CONFIG } from '../server/config.js'
import type { Config, JsonObject, LocalItem, ResultItem } from '../server/types.js'

const hash = 'a'.repeat(40)
function season(status: ResultItem['status'], changes: Partial<ResultItem> = {}): ResultItem {
  return {
    key: `row-${Math.random()}`,
    group_id: 1,
    arr: 'Sonarr',
    title: 'Show',
    season: 1,
    status,
    match_status: 'matched',
    have: ['Old'],
    local_size: 0,
    best_group: 'Best',
    best_size: 0,
    url: null,
    notes: null,
    image: null,
    banner: null,
    anilist_id: 1,
    arr_url: null,
    releases:
      status === 'missing' || status === 'uncovered'
        ? []
        : [
            {
              kind: 'best',
              releaseGroup: 'Best',
              tracker: 'Nyaa',
              quality: '',
              tags: [],
              size: 0,
              info_hashes: [hash],
              torrent_available: true,
            },
          ],
    ...(status === 'best' ? { have: ['Best'] } : {}),
    ...changes,
  }
}

test('a title carries one status: review first, then upgradable, best, and not on SeaDex', () => {
  assert.equal(titleTagState([]), null)
  assert.equal(titleTagState([season('best'), season('best', { season: 2 })]), 'best')
  assert.equal(titleTagState([season('best'), season('upgrade', { season: 2 })]), 'upgrade')
  assert.equal(titleTagState([season('partial', { upgrade_available: true })]), 'upgrade')
  assert.equal(titleTagState([season('missing'), season('missing', { season: 2 })]), 'unlisted')
  assert.equal(
    titleTagState([season('upgrade'), season('missing', { match_status: 'unmatched', anilist_id: null })]),
    'review',
    'No other status is trustworthy before the match is confirmed',
  )
  assert.equal(
    titleTagState([season('best'), season('missing', { season: 2 })]),
    null,
    'A partly listed title has no single status',
  )
  assert.equal(
    titleTagState([season('uncovered')]),
    null,
    'Listed on SeaDex without releases is not the same as unlisted',
  )
  // A season excluded from upgrades neither makes the title upgradable nor keeps it from being best.
  assert.equal(titleTagState([season('best'), season('upgrade', { season: 2, excluded: true })]), 'best')
  assert.equal(titleTagState([season('upgrade', { excluded: true })]), null)
  assert.equal(titleTagState([season('upgrade', { excluded_parts: [''] })]), null)
})

interface Call {
  method: string
  route: string
  body?: JsonObject
}
function serve(tags: Record<string, JsonObject[]>, calls: Call[], titles: Record<string, JsonObject[]> = {}) {
  let nextTagId = 70
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method || 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as JsonObject) : undefined
    calls.push({ method, route: `${url.host}${url.pathname}`, ...(body ? { body } : {}) })
    if (url.pathname === '/api') return Response.json({ current: 'v3' })
    if (url.pathname.endsWith('/tag') && method === 'GET') return Response.json(tags[url.host] || [])
    if (url.pathname.endsWith('/tag') && method === 'POST')
      return Response.json({ id: nextTagId++, label: body!.label })
    if (url.pathname.endsWith('/editor') && method === 'PUT') return new Response('[]', { status: 202 })
    if (method === 'GET' && (url.pathname.endsWith('/series') || url.pathname.endsWith('/movie')))
      return Response.json(titles[url.host] || [])
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

async function withFetch<T>(handler: typeof fetch, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await action()
  } finally {
    globalThis.fetch = original
  }
}

const config = (changes: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  sonarr_url: 'http://sonarr',
  sonarr_key: 'key',
  radarr_url: 'http://radarr',
  radarr_key: 'key',
  arr_tags_enabled: true,
  ...changes,
})
const show = (id: number, tags: number[] = []): LocalItem => ({
  arr: 'Sonarr',
  id,
  title: `Show ${id}`,
  tags,
  seasons: {},
})
const forShow = (id: number, result: ResultItem): ResultItem => ({
  ...result,
  key: `Sonarr:${id}:${result.season}`,
  library_key: `Sonarr:item${id}`,
})
const writes = (calls: Call[]) =>
  calls.filter(call => call.method !== 'GET').map(call => [call.method, call.route, call.body])

test('nothing is read or written while status tags are off', async () => {
  const calls: Call[] = []
  await withFetch(serve({}, calls), () =>
    syncArrTags(config({ arr_tags_enabled: false }), {
      items: [show(1)],
      outOfScope: [],
      results: [forShow(1, season('best'))],
      sourceErrors: {},
    }),
  )
  assert.deepEqual(calls, [])
})

test('tags follow the scan: missing ones are added, outdated ones removed, and only where needed', async () => {
  const calls: Call[] = []
  const tags = {
    sonarr: [
      { id: 5, label: 'seadex-best' },
      { id: 6, label: 'seadex-unlisted' },
      { id: 9, label: 'mine' },
    ],
  }
  const items = [show(1), show(2, [5, 9]), show(3, [6]), show(4, [5]), show(5, [9])]
  const results = [
    forShow(1, season('best')),
    forShow(2, season('upgrade')), // was best, now upgradable
    forShow(3, season('missing')), // already tagged as unlisted
    forShow(4, season('best')), // already tagged as best
    forShow(5, season('missing', { match_status: 'unmatched', anilist_id: null })),
  ]
  await withFetch(serve(tags, calls), () =>
    syncArrTags(config(), {
      items,
      outOfScope: [
        { instance: 'sonarr', id: 8, tags: [5] },
        { instance: 'sonarr', id: 9, tags: [9] },
      ],
      results,
      sourceErrors: {},
    }),
  )
  assert.deepEqual(writes(calls), [
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [1], tags: [5], applyTags: 'add' }],
    // The title that is no longer best, and the one the library scope now leaves out.
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [2, 8], tags: [5], applyTags: 'remove' }],
    ['POST', 'sonarr/api/v3/tag', { label: 'seadex-upgradable' }],
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [2], tags: [70], applyTags: 'add' }],
    ['POST', 'sonarr/api/v3/tag', { label: 'seadex-review' }],
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [5], tags: [71], applyTags: 'add' }],
  ])
  assert.equal(
    calls.some(call => JSON.stringify(call.body || {}).includes('"tags":[9]')),
    false,
    'A tag the person made is never touched',
  )
  assert.equal(
    calls.some(call => call.route.startsWith('radarr')),
    false,
    'An instance with no scanned titles is left alone',
  )
})

test('a renamed or skipped tag is honoured, and movies use the movie editor', async () => {
  const calls: Call[] = []
  const movie: LocalItem = { arr: 'Radarr', id: 3, title: 'Movie', tags: [], seasons: {} }
  const result: ResultItem = {
    ...season('best', { arr: 'Radarr', season: 0 }),
    key: 'Radarr:3:0',
    library_key: 'Radarr:item3',
  }
  const settings = applyConfigUpdate(config(), {
    arr_tag_best: 'Top-Release',
    arr_tag_upgrade: '',
    arr_tag_unlisted: '',
    arr_tag_review: '',
  })
  assert.equal(settings.arr_tag_best, 'top-release')
  await withFetch(serve({}, calls), () =>
    syncArrTags(settings, {
      items: [movie, show(1)],
      outOfScope: [],
      results: [result, forShow(1, season('upgrade'))],
      sourceErrors: {},
    }),
  )
  assert.deepEqual(
    writes(calls),
    [
      ['POST', 'radarr/api/v3/tag', { label: 'top-release' }],
      ['PUT', 'radarr/api/v3/movie/editor', { movieIds: [3], tags: [70], applyTags: 'add' }],
    ],
    'The upgradable series gets no tag because that tag has no name',
  )
})

test('tag names are validated and must differ', () => {
  assert.throws(
    () => applyConfigUpdate(DEFAULT_CONFIG, { arr_tag_best: 'has space' }),
    /lowercase letters, digits, and hyphens/,
  )
  assert.throws(
    () => applyConfigUpdate(DEFAULT_CONFIG, { arr_tag_best: 'same', arr_tag_upgrade: 'same' }),
    /different name/,
  )
  assert.throws(
    () =>
      applyConfigUpdate(DEFAULT_CONFIG, {
        arr_tags_enabled: true,
        arr_tag_best: '',
        arr_tag_upgrade: '',
        arr_tag_unlisted: '',
        arr_tag_review: '',
      }),
    /at least one tag name/,
  )
  assert.equal(
    DEFAULT_CONFIG.arr_tags_enabled,
    false,
    'Nothing is written to Sonarr or Radarr unless the person turns it on',
  )
})

test('an instance that failed its scan or rejects a write does not stop the others', async () => {
  const calls: Call[] = []
  const base = serve({}, calls)
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.host === 'sonarr' && url.pathname.endsWith('/editor')) {
      calls.push({ method: 'PUT', route: 'sonarr/rejected' })
      return new Response('nope', { status: 500 })
    }
    return base(input, init)
  }) as typeof fetch
  const movie: LocalItem = { arr: 'Radarr', id: 3, title: 'Movie', tags: [], seasons: {} }
  const movieResult: ResultItem = {
    ...season('best', { arr: 'Radarr', season: 0 }),
    key: 'Radarr:3:0',
    library_key: 'Radarr:item3',
  }
  await withFetch(flaky, () =>
    syncArrTags(config(), {
      items: [show(1), movie],
      outOfScope: [],
      results: [forShow(1, season('best')), movieResult],
      sourceErrors: {},
    }),
  )
  assert.equal(
    calls.some(call => call.route === 'radarr/api/v3/movie/editor'),
    true,
    'Radarr is still tagged after Sonarr rejected its write',
  )
  calls.length = 0
  await withFetch(serve({}, calls), () =>
    syncArrTags(config(), {
      items: [show(1), movie],
      outOfScope: [],
      results: [forShow(1, season('best')), movieResult],
      sourceErrors: { Sonarr: 'HTTP 503' },
    }),
  )
  assert.equal(
    calls.some(call => call.route.startsWith('sonarr')),
    false,
    'Titles of a failed source keep their tags until it scans again',
  )
  const cancelled = (async () => {
    throw new DOMException('Scan cancelled', 'AbortError')
  }) as unknown as typeof fetch
  await assert.rejects(
    () =>
      withFetch(cancelled, () =>
        syncArrTags(config(), {
          items: [show(1)],
          outOfScope: [],
          results: [forShow(1, season('best'))],
          sourceErrors: {},
        }),
      ),
    /Scan cancelled/,
  )
})

test('removing the tags clears them from every title and nothing else', async () => {
  const calls: Call[] = []
  const tags = {
    sonarr: [
      { id: 5, label: 'seadex-best' },
      { id: 6, label: 'seadex-upgradable' },
      { id: 9, label: 'mine' },
    ],
    radarr: [{ id: 2, label: 'unrelated' }],
  }
  const titles = {
    sonarr: [
      { id: 1, tags: [5, 9] },
      { id: 2, tags: [6] },
      { id: 3, tags: [9] },
      { id: 4, tags: [5] },
    ],
    radarr: [{ id: 1, tags: [2] }],
  }
  const outcome = await withFetch(serve(tags, calls, titles), () => removeArrTags(config({ arr_tags_enabled: false })))
  assert.deepEqual(outcome, { removed: 3, errors: {} })
  assert.deepEqual(writes(calls), [
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [1, 4], tags: [5], applyTags: 'remove' }],
    ['PUT', 'sonarr/api/v3/series/editor', { seriesIds: [2], tags: [6], applyTags: 'remove' }],
  ])
  const failing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
  const failed = await withFetch(failing, () => removeArrTags(config()))
  assert.deepEqual(Object.keys(failed.errors).sort(), ['Radarr', 'Sonarr'])
})
