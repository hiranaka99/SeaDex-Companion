import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  applyConfigUpdate,
  DEFAULT_CONFIG,
  integrationConfig,
  loadConfig,
  publicConfig,
  sabnzbdCategories,
  saveConfig,
} from '../server/config.js'
import { CONFIG_FILE, ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE } from '../server/paths.js'
import { loadLocalLibrary } from '../server/library.js'
import {
  arrInstances,
  configuredArrInstances,
  downloadCategory,
  instanceCategory,
  instanceOf,
  libraryConnected,
  parseLibraryKey,
  sourceNameOf,
} from '../shared/arr-instances.js'
import { libraryItemKey } from '../server/user-rules.js'
import { arrScopeOptions, testIntegration } from '../server/integration-tests.js'
import { assessmentSignature, createScanService, librarySignature, resultSettingsChanged } from '../server/scan.js'
import { getState } from '../server/scan-state.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { cardKey } from '../shared/ids.js'
import { processWebhookScans, queueImportScan, queueWebhookScan, resetWebhookScanState } from '../server/scheduler.js'
import { groupResults } from '../frontend/src/utils.js'
import type { Config, JsonObject, ScanScope, ScanTrigger } from '../server/types.js'

/** Answers Sonarr and Radarr API requests from a table of `host/path?query` routes and records every request. */
function serveArr(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const route = `${url.host}${url.pathname}${url.search}`
    calls.push(`${init?.method || 'GET'} ${route}`)
    const found = route in routes ? route : `${url.host}${url.pathname}` in routes ? `${url.host}${url.pathname}` : null
    if (found === null) return new Response('not found', { status: 404 })
    return Response.json(routes[found])
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

const aired = '2020-01-05T09:00:00Z'
const episodes = (count: number, fileId = 0) =>
  Array.from({ length: count }, (_, index) => ({
    seasonNumber: 1,
    episodeNumber: index + 1,
    episodeFileId: fileId ? fileId + index : 0,
    airDate: aired,
  }))
const series = (id: number, title: string, extra: JsonObject = {}) => ({
  id,
  title,
  titleSlug: title.toLowerCase().replace(/ /g, '-'),
  seriesType: 'anime',
  tags: [],
  rootFolderPath: '/data/anime',
  path: `/data/anime/${title}`,
  seasons: [{ seasonNumber: 1, statistics: { sizeOnDisk: 0, releaseGroups: [] } }],
  ...extra,
})
const sonarrRoutes = (host: string, shows: JsonObject[], tags: JsonObject[] = []) => ({
  [`${host}/api`]: { current: 'v3' },
  [`${host}/api/v3/series`]: shows,
  [`${host}/api/v3/tag`]: tags,
  [`${host}/api/v3/rootfolder`]: [{ path: '/data/anime' }, { path: '/data/tv' }],
  ...Object.fromEntries(
    shows.flatMap(show => [
      [`${host}/api/v3/episode?seriesId=${show.id}`, episodes(2)],
      [`${host}/api/v3/episodefile?seriesId=${show.id}`, []],
    ]),
  ),
})
const sonarr = (changes: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  sonarr_url: 'http://sonarr',
  sonarr_key: 'key',
  ...changes,
})

test('a library scope keeps only anime series, wanted tags, and chosen root folders', async () => {
  const shows = [
    series(1, 'Anime Kept', { tags: [5] }),
    series(2, 'Western Show', { seriesType: 'standard', tags: [5] }),
    series(3, 'Anime Elsewhere', { tags: [5], rootFolderPath: '/data/tv', path: '/data/tv/Anime Elsewhere' }),
    series(4, 'Anime Untagged'),
    series(5, 'Anime Skipped', { tags: [5, 9] }),
  ]
  const calls: string[] = []
  const config = sonarr({
    sonarr_scope: {
      anime_only: true,
      include_tags: ['seadex'],
      exclude_tags: ['skip'],
      root_folders: ['/data/anime/'],
    },
  })
  const { items, outOfScope, sourceErrors } = await withFetch(
    serveArr(
      sonarrRoutes('sonarr', shows, [
        { id: 5, label: 'SeaDex' },
        { id: 9, label: 'skip' },
      ]),
      calls,
    ),
    () => loadLocalLibrary(config),
  )
  assert.deepEqual(sourceErrors, {})
  assert.deepEqual(
    items.map(item => item.title),
    ['Anime Kept'],
  )
  assert.deepEqual(items[0].tags, [5])
  assert.deepEqual(
    outOfScope,
    [2, 3, 4, 5].map(id => ({ instance: 'sonarr', id, tags: shows.find(show => show.id === id)!.tags })),
  )
  assert.deepEqual(
    calls.filter(call => call.includes('/episode')),
    ['GET sonarr/api/v3/episode?seriesId=1', 'GET sonarr/api/v3/episodefile?seriesId=1'],
    'Titles outside the scope cost no episode requests',
  )
})

test('each scope rule works on its own, and an empty scope reads no tags', async () => {
  const shows = [
    series(1, 'One', { tags: [5] }),
    series(2, 'Two', { seriesType: 'standard' }),
    series(3, 'Three', { path: 'D:\\Media\\TV\\Three', rootFolderPath: 'D:\\Media\\TV\\' }),
  ]
  const load = async (scope: Config['sonarr_scope'], calls: string[] = []) =>
    (
      await withFetch(serveArr(sonarrRoutes('sonarr', shows, [{ id: 5, label: 'keep' }]), calls), () =>
        loadLocalLibrary(sonarr({ sonarr_scope: scope })),
      )
    ).items.map(item => item.id)
  const none = { anime_only: false, include_tags: [], exclude_tags: [], root_folders: [] }
  const calls: string[] = []
  assert.deepEqual(await load(none, calls), [1, 2, 3])
  assert.equal(
    calls.some(call => call.endsWith('/tag')),
    false,
  )
  assert.deepEqual(await load({ ...none, anime_only: true }), [1, 3])
  assert.deepEqual(await load({ ...none, include_tags: ['keep'] }), [1])
  assert.deepEqual(await load({ ...none, exclude_tags: ['keep'] }), [2, 3])
  assert.deepEqual(
    await load({ ...none, root_folders: ['d:/media/tv'] }),
    [3],
    'Windows paths match whatever their slashes or case',
  )
  assert.deepEqual(
    await load({ ...none, include_tags: ['missing'] }),
    [],
    'A tag the instance does not have matches nothing',
  )
})

test('Radarr movies are scoped by tag and root folder; the anime rule does not apply to them', async () => {
  const movie = (id: number, extra: JsonObject = {}) => ({
    id,
    title: `Movie ${id}`,
    titleSlug: `movie-${id}`,
    inCinemas: aired,
    tags: [],
    rootFolderPath: '/movies/anime',
    path: `/movies/anime/Movie ${id}`,
    ...extra,
  })
  const routes = {
    'radarr/api/v3/movie': [
      movie(1, { tags: [3] }),
      movie(2),
      movie(3, { tags: [3], rootFolderPath: '/movies/other', path: '/movies/other/Movie 3' }),
    ],
    'radarr/api/v3/tag': [{ id: 3, label: 'anime' }],
  }
  const config = {
    ...DEFAULT_CONFIG,
    radarr_url: 'http://radarr',
    radarr_key: 'key',
    radarr_scope: { anime_only: true, include_tags: ['anime'], exclude_tags: [], root_folders: ['/movies/anime'] },
  }
  const { items, outOfScope } = await withFetch(serveArr(routes), () => loadLocalLibrary(config))
  assert.deepEqual(
    items.map(item => item.id),
    [1],
  )
  assert.deepEqual(
    outOfScope.map(item => item.id),
    [2, 3],
  )
})

test('a scope whose tags cannot be read fails that source instead of scanning everything', async () => {
  const routes = sonarrRoutes('sonarr', [series(1, 'One')]) as Record<string, unknown>
  delete routes['sonarr/api/v3/tag']
  const config = sonarr({
    sonarr_scope: { anime_only: false, include_tags: ['seadex'], exclude_tags: [], root_folders: [] },
  })
  await assert.rejects(() => withFetch(serveArr(routes), () => loadLocalLibrary(config)), /Sonarr: HTTP 404/)
})

const extra = (changes: JsonObject = {}) => ({
  id: 'uhd4k',
  kind: 'sonarr',
  name: 'Sonarr 4K',
  url: 'http://sonarr4k/',
  key: 'second-key',
  category: 'sonarr-4k',
  sabnzbd_category: 'nzb-4k',
  ...changes,
})

test('additional instances are validated, keep their key when it is left blank, and never expose it', () => {
  const saved = applyConfigUpdate(DEFAULT_CONFIG, { arr_instances: [extra()] })
  assert.deepEqual(saved.arr_instances, [
    {
      id: 'uhd4k',
      kind: 'sonarr',
      name: 'Sonarr 4K',
      url: 'http://sonarr4k',
      key: 'second-key',
      category: 'sonarr-4k',
      sabnzbd_category: 'nzb-4k',
      scope: { anime_only: false, include_tags: [], exclude_tags: [], root_folders: [] },
    },
  ])
  const edited = applyConfigUpdate(saved, {
    arr_instances: [extra({ key: '', name: 'UHD', scope: { anime_only: true, include_tags: 'A, b' } })],
  })
  assert.equal(edited.arr_instances[0].key, 'second-key', 'A blank key keeps the stored one')
  assert.deepEqual(edited.arr_instances[0].scope, {
    anime_only: true,
    include_tags: ['a', 'b'],
    exclude_tags: [],
    root_folders: [],
  })
  assert.deepEqual(
    publicConfig(edited).arr_instances.map(instance => [instance.key, instance.key_configured]),
    [['', true]],
  )
  assert.deepEqual(applyConfigUpdate(saved, { arr_instances: [] }).arr_instances, [])
  for (const [instances, message] of [
    [[extra({ id: 'sonarr' })], /identifier/],
    [[extra({ id: 'UP' })], /identifier/],
    [[extra(), extra()], /identifiers must be unique/],
    [[extra({ name: ' ' })], /name of 1 to 40/],
    [[extra({ name: 'radarr' })], /already used/],
    [[extra(), extra({ id: 'other1', name: 'sonarr 4k' })], /already used/],
    [[extra({ kind: 'lidarr' })], /either Sonarr or Radarr/],
    [[extra({ kind: 'radarr' })], /cannot change between/],
    [Array.from({ length: 11 }, (_, index) => extra({ id: `inst${index}`, name: `Instance ${index}` })), /At most 10/],
  ] as const)
    assert.throws(() => applyConfigUpdate(saved, { arr_instances: instances }), message)
})

test('instance keys are stored encrypted with the other credentials', () => {
  const files = [CONFIG_FILE, ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE]
  const saved = files.map(file => (existsSync(file) ? readFileSync(file) : null))
  try {
    for (const file of files) rmSync(file, { force: true })
    saveConfig(
      applyConfigUpdate(DEFAULT_CONFIG, {
        sonarr_url: 'http://sonarr',
        sonarr_key: 'first-key',
        arr_instances: [extra()],
      }),
    )
    assert.equal(readFileSync(CONFIG_FILE, 'utf8').includes('second-key'), false)
    const stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    assert.equal('key' in stored.arr_instances[0], false)
    const loaded = loadConfig()
    assert.equal(loaded.sonarr_key, 'first-key')
    assert.deepEqual(
      loaded.arr_instances.map(instance => [instance.id, instance.name, instance.key]),
      [['uhd4k', 'Sonarr 4K', 'second-key']],
    )
    saveConfig({ ...loaded, arr_instances: [] })
    assert.deepEqual(loadConfig().arr_instances, [])
  } finally {
    files.forEach((file, index) => {
      const data = saved[index]
      if (data) writeFileSync(file, data)
      else rmSync(file, { force: true })
    })
  }
})

test('every instance has its own identity, download categories, and webhook scope', () => {
  const config = applyConfigUpdate(sonarr({ sonarr_category: 'tv', sabnzbd_sonarr_category: 'nzb-tv' }), {
    arr_instances: [extra(), extra({ id: 'films2', kind: 'radarr', name: 'Radarr 4K', url: '', key: '' })],
  })
  assert.deepEqual(
    arrInstances(config).map(instance => [instance.id, instance.name, instance.primary]),
    [
      ['sonarr', 'Sonarr', true],
      ['radarr', 'Radarr', true],
      ['uhd4k', 'Sonarr 4K', false],
      ['films2', 'Radarr 4K', false],
    ],
  )
  assert.deepEqual(
    configuredArrInstances(config).map(instance => instance.id),
    ['sonarr', 'uhd4k'],
  )
  assert.equal(libraryItemKey({ arr: 'Sonarr', id: 10 }), 'Sonarr:item10')
  assert.equal(libraryItemKey({ arr: 'Sonarr', instance: 'uhd4k', id: 10 }), 'Sonarr@uhd4k:item10')
  assert.deepEqual(parseLibraryKey('Sonarr@uhd4k:item10'), { instanceId: 'uhd4k', arr: 'Sonarr', itemId: 10 })
  assert.deepEqual(parseLibraryKey('Radarr:item7'), { instanceId: 'radarr', arr: 'Radarr', itemId: 7 })
  assert.equal(parseLibraryKey('Sonarr:10'), null)
  assert.equal(downloadCategory(config, { arr: 'Sonarr' }, 'torrent'), 'tv')
  assert.equal(downloadCategory(config, { arr: 'Sonarr', instance: 'uhd4k' }, 'torrent'), 'sonarr-4k')
  assert.equal(downloadCategory(config, { arr: 'Sonarr', instance: 'uhd4k' }, 'usenet'), 'nzb-4k')
  assert.equal(
    downloadCategory(config, { arr: 'Sonarr', instance: 'gone' }, 'torrent'),
    '',
    'A removed instance has no category to send to',
  )
  assert.deepEqual(
    sabnzbdCategories(config),
    ['nzb-tv', 'radarr-anime', 'nzb-4k'],
    'An unconfigured instance adds no category to check',
  )
})

test('the browser sees the same instances, categories, and connection as the server', () => {
  const config = applyConfigUpdate(sonarr({ sonarr_category: 'tv', sabnzbd_sonarr_category: 'nzb-tv' }), {
    arr_instances: [
      extra(),
      extra({ id: 'films2', kind: 'radarr', name: 'Radarr 4K', url: 'http://radarr4k/', key: '' }),
    ],
  })
  const browser = publicConfig(config)
  assert.deepEqual(
    arrInstances(browser).map(instance => [instance.id, instance.configured]),
    arrInstances(config).map(instance => [instance.id, instance.configured]),
  )
  assert.deepEqual(
    configuredArrInstances(browser).map(instance => instance.id),
    ['sonarr', 'uhd4k'],
    'A saved key counts as configured although the browser never sees it',
  )
  const additional = instanceOf(browser, { arr: 'Sonarr', instance: 'uhd4k' })
  assert.equal(additional?.name, 'Sonarr 4K')
  assert.equal(additional && instanceCategory(additional, 'usenet'), 'nzb-4k')
  assert.equal(downloadCategory(browser, { arr: 'Sonarr', instance: 'uhd4k' }, 'torrent'), 'sonarr-4k')
  assert.equal(downloadCategory(browser, { arr: 'Sonarr' }, 'usenet'), 'nzb-tv')
  const blank = publicConfig(applyConfigUpdate(config, { radarr_category: '  ', sabnzbd_radarr_category: '' }))
  assert.equal(downloadCategory(blank, { arr: 'Radarr' }, 'torrent'), '', 'A blank category sends without one')
  assert.equal(downloadCategory(blank, { arr: 'Radarr' }, 'usenet'), '')
  assert.equal(sourceNameOf({ arr: 'Sonarr', instance: 'uhd4k', instance_name: 'Sonarr 4K' }), 'Sonarr 4K')
  assert.equal(sourceNameOf({ arr: 'Radarr' }), 'Radarr')
})

test('a library is connected through any instance, primary or additional', () => {
  assert.equal(libraryConnected(publicConfig(DEFAULT_CONFIG)), false)
  assert.equal(libraryConnected(publicConfig(sonarr())), true)
  assert.equal(libraryConnected(publicConfig(sonarr({ sonarr_key: '' }))), false, 'An address alone is not enough')
  const onlyAdditional = applyConfigUpdate(DEFAULT_CONFIG, { arr_instances: [extra()] })
  assert.equal(libraryConnected(onlyAdditional), true)
  assert.equal(libraryConnected(publicConfig(onlyAdditional)), true)
  assert.equal(libraryConnected(null), false)
})

test('the same anime in two instances stays two results, two cards, and two sources of errors', async () => {
  resetRuntimeForTests()
  const config = applyConfigUpdate(sonarr(), { arr_instances: [extra()] })
  const routes = {
    ...sonarrRoutes('sonarr', [series(10, 'Shared Anime')]),
    ...sonarrRoutes('sonarr4k', [series(10, 'Shared Anime')]),
  }
  const dependencies = {
    seadexBest: async () =>
      new Map([
        [
          42,
          {
            url: 'https://seadex.moe/42/',
            notes: '',
            seasons: {
              1: {
                candidates: [
                  {
                    releaseGroup: 'Best',
                    tracker: 'Nyaa',
                    quality: '1080p',
                    tags: [],
                    size: 100,
                    file_count: 2,
                    info_hashes: ['a'.repeat(40)],
                    is_best: true,
                  },
                ],
              },
            },
          },
        ],
      ]),
    anilistChain: async () => [{ season: 1, id: 42, ids: [42], episodeCount: 2, parts: [{ id: 42, episodeCount: 2 }] }],
    loadCache: () => ({}),
    saveLastResults: () => {},
    autoNotifyNew: async () => 0,
    recordScanHistory: () => ({}) as never,
    onScanFinished: () => {},
  }
  try {
    await withFetch(serveArr(routes), () => createScanService(dependencies).run(config))
    const results = getState().results
    assert.equal(getState().error, null)
    assert.deepEqual(
      results.map(result => [result.key, result.library_key, result.instance, result.instance_name, result.arr_url]),
      [
        ['Sonarr:42:1:Best', 'Sonarr:item10', undefined, undefined, 'http://sonarr/series/shared-anime'],
        ['Sonarr@uhd4k:42:1:Best', 'Sonarr@uhd4k:item10', 'uhd4k', 'Sonarr 4K', 'http://sonarr4k/series/shared-anime'],
      ],
    )
    assert.deepEqual(results.map(cardKey), ['42', 'uhd4k:42'])
    assert.deepEqual(
      groupResults(results).map(card => [card.key, card.source, card.anilist_id, card.seasons.length]),
      [
        ['42', 'Sonarr', 42, 1],
        ['uhd4k:42', 'Sonarr 4K', 42, 1],
      ],
    )

    // A failing instance keeps its earlier results; the other instance still refreshes.
    const broken = { ...routes } as Record<string, unknown>
    delete broken['sonarr4k/api/v3/series']
    await withFetch(serveArr(broken), () => createScanService(dependencies).run(config))
    assert.deepEqual(getState().source_errors, { 'Sonarr 4K': 'HTTP 404' })
    assert.deepEqual(
      getState()
        .results.map(result => result.library_key)
        .sort(),
      ['Sonarr:item10', 'Sonarr@uhd4k:item10'],
    )

    // Removing the instance drops its results with the next scan.
    await withFetch(serveArr(routes), () => createScanService(dependencies).run(sonarr()))
    assert.deepEqual(
      getState().results.map(result => result.library_key),
      ['Sonarr:item10'],
    )
  } finally {
    resetRuntimeForTests()
  }
})

test('an additional instance is tested and offers its tags and root folders from the unsaved draft', async () => {
  const draft = integrationConfig(DEFAULT_CONFIG, 'arr:uhd4k', {
    arr_instances: [extra()],
    sonarr_url: 'http://ignored',
  })
  assert.equal(draft.sonarr_url, '', 'Only the instance list of the draft applies')
  const routes = {
    ...sonarrRoutes(
      'sonarr4k',
      [],
      [
        { id: 2, label: 'Zeta' },
        { id: 1, label: 'alpha' },
      ],
    ),
    'sonarr4k/api/v3/system/status': { appName: 'Sonarr', version: '4.0.9' },
  }
  await withFetch(serveArr(routes), async () => {
    assert.equal(await testIntegration(draft, 'arr:uhd4k'), 'Connected to Sonarr 4.0.9')
    assert.deepEqual(await arrScopeOptions(draft, 'arr:uhd4k'), {
      tags: ['alpha', 'zeta'],
      root_folders: ['/data/anime', '/data/tv'],
    })
  })
  await assert.rejects(() => testIntegration(draft, 'arr:missing'), /Unknown Sonarr or Radarr instance/)
  await assert.rejects(
    () =>
      testIntegration(
        integrationConfig(DEFAULT_CONFIG, 'arr:uhd4k', { arr_instances: [extra({ key: '' })] }),
        'arr:uhd4k',
      ),
    /Sonarr 4K URL and API key are required/,
  )
})

test('webhook and import scans address the instance they came from', async () => {
  resetRuntimeForTests()
  resetWebhookScanState()
  try {
    assert.equal(
      queueWebhookScan('sonarr', 'Download', 10, 1_000).accepted,
      false,
      'An import of an unknown title is ignored',
    )
    assert.equal(queueWebhookScan('sonarr', 'Download', 10, 1_000, { known: true }).accepted, true)
    assert.equal(queueWebhookScan('sonarr', 'SeriesAdd', 11, 1_001, { instanceId: 'uhd4k' }).accepted, true)
    assert.equal(
      queueWebhookScan('radarr', 'Download', 20, 1_002, { instanceId: 'films2', known: true }).accepted,
      true,
    )
    assert.equal(queueWebhookScan('radarr', 'Grab', 21, 1_003, { known: true }).accepted, false)
    const calls: Array<{ trigger: ScanTrigger; scope: ScanScope }> = []
    await processWebhookScans(DEFAULT_CONFIG, 1_020, async (_config, trigger, scope) => {
      calls.push({ trigger, scope })
    })
    assert.deepEqual(calls, [
      { trigger: 'sonarr+radarr', scope: { sonarrIds: [10], radarrIds: [], instances: { uhd4k: [11], films2: [20] } } },
    ])

    // A finished download asks for a rescan of its title without a webhook; it never delays a scan that is already due.
    queueImportScan({ id: 'uhd4k' }, 12, 2_000)
    queueImportScan({ id: 'sonarr' }, 13, 2_005)
    calls.length = 0
    await processWebhookScans(DEFAULT_CONFIG, 2_009, async (_config, trigger, scope) => {
      calls.push({ trigger, scope })
    })
    assert.equal(calls.length, 0)
    await processWebhookScans(DEFAULT_CONFIG, 2_010, async (_config, trigger, scope) => {
      calls.push({ trigger, scope })
    })
    assert.deepEqual(calls, [
      { trigger: 'import', scope: { sonarrIds: [13], radarrIds: [], instances: { uhd4k: [12] } } },
    ])
  } finally {
    resetWebhookScanState()
    resetRuntimeForTests()
  }
})

test('saved results are stale once scope, instances, or release preferences change', () => {
  const config = sonarr()
  const saved = { count: 3, settings: { assessment: assessmentSignature(config), library: librarySignature(config) } }
  assert.equal(resultSettingsChanged(config, saved), false)
  assert.equal(resultSettingsChanged(config, { count: 0 }), false, 'Without results there is nothing to refresh')
  const publicOnly = { ...config, tracker_mode: 'public' as const }
  assert.equal(
    resultSettingsChanged(config, { count: 3 }),
    false,
    'Results from before these settings existed are current under the defaults, which list every tracker',
  )
  assert.equal(
    resultSettingsChanged(publicOnly, { count: 3 }),
    true,
    'Results from before tracker modes list private releases that public-tracker mode leaves out',
  )
  assert.equal(resultSettingsChanged({ ...config, verify_release_files: false }, { count: 3 }), true)
  assert.equal(resultSettingsChanged(publicOnly, saved), true, 'Switching tracker mode makes results stale')
  // Reachable-tracker results also record the trackers Prowlarr covered. Only a scan reads Prowlarr, so results
  // are never stale for what it covers now.
  const reachable = { ...config, tracker_mode: 'reachable' as const }
  const savedReachable = {
    count: 3,
    settings: { ...saved.settings, assessment: assessmentSignature(reachable, ['ab']) },
  }
  assert.equal(resultSettingsChanged(reachable, saved), true)
  assert.equal(resultSettingsChanged(reachable, { count: 3 }), true)
  assert.equal(resultSettingsChanged(reachable, savedReachable), false)
  assert.equal(resultSettingsChanged(config, savedReachable), true)
  assert.equal(
    resultSettingsChanged({ ...reachable, verify_release_files: false }, savedReachable),
    true,
    'Other settings still make reachable-tracker results stale',
  )
  assert.equal(
    resultSettingsChanged({ ...config, release_preferences: { ...config.release_preferences, strict: true } }, saved),
    true,
  )
  assert.equal(
    resultSettingsChanged({ ...config, sonarr_scope: { ...config.sonarr_scope, anime_only: true } }, saved),
    true,
  )
  assert.equal(resultSettingsChanged(applyConfigUpdate(config, { arr_instances: [extra()] }), saved), true)
  assert.equal(
    resultSettingsChanged({ ...config, sonarr_category: 'other', notify_enabled: false }, saved),
    false,
    'Unrelated settings leave the results current',
  )
})
