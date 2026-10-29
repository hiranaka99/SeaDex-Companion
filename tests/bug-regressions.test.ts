import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  api, alMedia, anilistChain, autoNotifyNew, autocheckState, CACHE_FILE, CONFIG_FILE, DEFAULT_CONFIG,
  DATA_DIR, ENCRYPTED_SECRETS_FILE, getState, HISTORY_FILE, loadCache, loadConfig, loadLastResults,
  loadScanHistory, loadUserRules, LOG_FILE, normalizeQbStates, qbGetTorrents, readLogTail,
  resetRuntimeForTests, RESULTS_FILE, runScan, cancelScan, setState, USER_RULES_FILE, mergeComplementaryCandidates,
  loadLocalLibrary, seadexBest, scopeReleaseToPart,
} from '../server/app.js'
import { processAutocheck, processWebhookScans, queueWebhookScan, refreshAutocheckSchedule, resetWebhookScanState, startScheduler } from '../server/index.js'
import { join } from 'node:path'
import { assessSeason } from '../server/assessment.js'

async function preserveFiles(files: string[], action: () => void | Promise<void>) {
  const saved = files.map(file => existsSync(file) ? readFileSync(file) : null)
  try { await action() }
  finally { files.forEach((file, index) => { const data = saved[index]; if (data) writeFileSync(file, data); else rmSync(file, { force: true }) }) }
}

test('Radarr includes non-theatrical releases and reads legacy movie-file ownership', async () => {
  const original = globalThis.fetch
  const movies = [
    { id: 1, title: 'Digital movie', digitalRelease: '2000-01-01' },
    { id: 2, title: 'Physical movie', physicalRelease: '2000-01-01' },
    { id: 3, title: 'Owned movie', hasFile: true, sizeOnDisk: 123, movieFile: { id: 30, size: 123, releaseGroup: 'Best group' } },
    { id: 4, title: 'Upcoming movie', inCinemas: '2999-01-01', digitalRelease: '2999-02-01' },
    { id: 5, title: 'Unknown movie' },
    { id: 6, title: 'Statistics movie', statistics: { sizeOnDisk: 456, releaseGroups: ['Another group'] } },
  ]
  globalThis.fetch = (async () => Response.json(movies)) as typeof fetch
  try {
    const { items } = await loadLocalLibrary({ ...DEFAULT_CONFIG, radarr_url: 'http://radarr.test', radarr_key: 'fixture' })
    assert.deepEqual(items.map(item => item.id), [1, 2, 3, 6])
    assert.deepEqual(items.find(item => item.id === 3)?.seasons[0], { groups: ['Best group'], size: 123 })
    assert.deepEqual(items.find(item => item.id === 6)?.seasons[0], { groups: ['Another group'], size: 456 })
  } finally { globalThis.fetch = original }
})

test('empty Radarr statistics cannot hide an already-owned best movie file', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json([{ id: 1, title: 'Owned movie', hasFile: true,
    statistics: { sizeOnDisk: 0, releaseGroups: [] },
    movieFile: { id: 10, size: 123, releaseGroup: 'Best group' },
  }])) as typeof fetch
  try {
    const { items } = await loadLocalLibrary({ ...DEFAULT_CONFIG, radarr_url: 'http://radarr.test', radarr_key: 'fixture' })
    assert.deepEqual(items[0].seasons[0], { groups: ['Best group'], size: 123 })
    const result = assessSeason(items[0], 0, items[0].seasons[0],
      [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 1 }] }],
      new Map([[42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 0: { candidates: [{
        releaseGroup: 'Best group', tracker: 'Nyaa', quality: '1080p', tags: [], size: 123,
        file_count: 1, info_hashes: ['a'.repeat(40)], is_best: true,
      }] } } }]]), 'Radarr:item1', undefined, null)
    assert.equal(result.status, 'best')
    assert.equal(result.local_size, 123)
  } finally { globalThis.fetch = original }
})

test('multi-season catalog torrents select only the requested season files', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ totalPages: 1, items: [{ alID: 42, expand: { trs: [{
    releaseGroup: 'Best group', tracker: 'Nyaa', infoHash: 'a'.repeat(40), isBest: true,
    files: [{ name: 'Show S01E01.mkv', length: 100 }, { name: 'Show S02E01.mkv', length: 200 }],
  }] } }] })) as typeof fetch
  try {
    const catalog = await seadexBest()
    const candidate = catalog.get(42)!.seasons[1].candidates[0]
    assert.deepEqual(scopeReleaseToPart(candidate, 1, 0, 1, 0, 1).selected_files, ['Show S01E01.mkv'])
  } finally { globalThis.fetch = original }
})

test('an unmapped later season cannot inherit the first season recommendation', () => {
  const local = { groups: ['Old group'], size: 100, episode_numbers: [1] }
  const result = assessSeason({ arr: 'Sonarr', id: 1, title: 'Show', seasons: { 2: local } }, 2, local,
    [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 1 }], episodeCount: 1 }],
    new Map([[42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 1: { candidates: [{
      releaseGroup: 'Best group', tracker: 'Nyaa', quality: '1080p', size: 200, file_count: 1,
      info_hashes: ['a'.repeat(40)], is_best: true, tags: [],
    }] } } }]]), 'Sonarr:item1', undefined, null)
  assert.equal(result.match_status, 'unmatched')
  assert.equal(result.status, 'missing')
  assert.deepEqual(result.releases, [])
  assert.equal(result.group_id, 42)
  assert.equal(result.local_size, 100)
})

test('mapped seasons cannot borrow a recommendation from a multi-season catalog', () => {
  const local = { groups: [], size: 0, episode_numbers: [1] }
  const candidate = { releaseGroup: 'Best group', tracker: 'Nyaa', quality: '1080p', size: 100, file_count: 1,
    info_hashes: ['a'.repeat(40)], is_best: true, tags: [] }
  const chain = [1, 2, 3].map(season => ({ season, id: 40 + season, ids: [40 + season], parts: [{ id: 40 + season, episodeCount: 1 }] }))
  const source = { url: 'https://seadex.moe/43/', notes: '', seasons: {
    1: { candidates: [{ ...candidate, source_files: [{ name: 'Show S01E01.mkv', length: 100 }] }] },
    2: { candidates: [{ ...candidate, source_files: [{ name: 'Show S02E01.mkv', length: 100 }] }] },
  } }
  const item = { arr: 'Sonarr' as const, id: 1, title: 'Show', seasons: { 3: local } }
  const result = assessSeason(item, 3, local, chain, new Map([[43, source]]), 'Sonarr:item1', undefined, null)
  assert.equal(result.match_status, 'matched')
  assert.equal(result.status, 'uncovered')
  assert.deepEqual(result.releases, [])
  assert.deepEqual(result.unavailable_parts, [{ label: 'S03', reason: 'No releases available on SeaDex' }])
  assert.equal(result.url, source.url)

  // A lone bucket remains valid: release numbering can restart at S01 for a
  // sequel whose Sonarr season is S03, or use absolute episode numbering.
  for (const seasonKey of [0, 1]) {
    const seasons = { [seasonKey]: seasonKey === 0 ? { candidates: [candidate] } : source.seasons[1] }
    const single = assessSeason(item, 3, local, chain, new Map([[43, { ...source, seasons }]]), 'Sonarr:item1', undefined, null)
    assert.equal(single.status, 'upgrade')
    assert.equal(single.releases.length, 1)
  }
  const direct = assessSeason(item, 2, local, chain, new Map([[42, source]]), 'Sonarr:item1', undefined, null)
  assert.equal(direct.status, 'upgrade')
  assert.equal(direct.releases.length, 1)
})

test('part-sized catalog uploads still scope other seasons out of their torrent', () => {
  const otherSeason = [{ name: 'Show S01E01.mkv', length: 10 }, { name: 'Show S01E02.mkv', length: 10 }]
  for (const partIndex of [0, 1]) {
    const sourceFiles = [1, 2].map(episode => ({ name: `Show S02E${partIndex * 2 + episode}.mkv`, length: 100 }))
    const candidate = { releaseGroup: 'Best group', tracker: 'Nyaa', quality: '1080p', tags: [],
      size: 200, file_count: 2, is_best: true, info_hashes: ['a'.repeat(40)], source_files: sourceFiles,
      torrent_files: [{ hash: 'a'.repeat(40), files: [...otherSeason, ...sourceFiles] }] }
    const scoped = scopeReleaseToPart(candidate, 2, partIndex, 2, partIndex * 2, 2)
    assert.deepEqual(scoped.selected_files, sourceFiles.map(file => file.name))
    assert.equal(scoped.size, 200)
    assert.equal(scoped.file_count, 2)
    assert.deepEqual(scoped.torrent_files, candidate.torrent_files)
    const standalone = { ...candidate, torrent_files: [{ hash: 'a'.repeat(40), files: sourceFiles }] }
    assert.equal(scopeReleaseToPart(standalone, 2, partIndex, 2, partIndex * 2, 2).selected_files, undefined)
  }
})

test('incomplete cour coverage does not silently discard unrecognized episodes', () => {
  const candidate = { releaseGroup: 'Best group', tracker: 'Nyaa', quality: '1080p', tags: [],
    size: 400, file_count: 4, is_best: true, info_hashes: ['a'.repeat(40)], source_files: [
      { name: 'Show S01E01.mkv', length: 100 }, { name: 'Show S01E02.mkv', length: 100 },
      { name: 'Show S01E03.mkv', length: 100 }, { name: 'Unrecognized episode.mkv', length: 100 },
    ] }
  const uncertain = scopeReleaseToPart(candidate, 2, 1, 2, 2, 1)
  assert.equal(uncertain.selected_files, undefined)
  assert.equal(uncertain.size, 400)
  assert.equal(uncertain.file_count, 4)
  const complete = { ...candidate, source_files: candidate.source_files.map((file, index) =>
    index === 3 ? { ...file, name: 'Show S01E04.mkv' } : file) }
  const scoped = scopeReleaseToPart(complete, 2, 1, 2, 2, 1)
  assert.deepEqual(scoped.selected_files, ['Show S01E03.mkv', 'Show S01E04.mkv'])
  assert.equal(scoped.size, 200)
  assert.equal(scoped.file_count, 2)
})

test('log tails retain the first line and complete lines on a byte boundary', async () => {
  mkdirSync(join(DATA_DIR, 'logs'), { recursive: true })
  await preserveFiles([LOG_FILE], () => {
    writeFileSync(LOG_FILE, 'first\nsecond\nthird\n')
    assert.deepEqual(readLogTail(), ['first', 'second', 'third'])
    assert.deepEqual(readLogTail(13), ['second', 'third'])
    assert.deepEqual(readLogTail(12), ['third'])
    writeFileSync(LOG_FILE, 'rotated\n')
    assert.deepEqual(readLogTail(), ['rotated'])
    writeFileSync(LOG_FILE, '')
    assert.deepEqual(readLogTail(), [])
  })
})

test('persisted collections tolerate non-object JSON roots and invalid array entries', async () => {
  await preserveFiles([CONFIG_FILE, ENCRYPTED_SECRETS_FILE, CACHE_FILE, RESULTS_FILE, USER_RULES_FILE, HISTORY_FILE], () => {
    for (const root of ['null', '[]', '7']) {
      for (const file of [CONFIG_FILE, CACHE_FILE, RESULTS_FILE, USER_RULES_FILE, HISTORY_FILE]) writeFileSync(file, root)
      assert.deepEqual(loadConfig().hidden, [])
      assert.deepEqual(loadCache(), {})
      assert.equal(loadLastResults(), null)
      assert.deepEqual(loadUserRules(), { mappings: {}, exclusions: [] })
      assert.deepEqual(loadScanHistory(), [])
    }
    writeFileSync(CONFIG_FILE, JSON.stringify({ hidden: ['valid', null, 5] }))
    assert.deepEqual(loadConfig().hidden, ['valid'])
    writeFileSync(RESULTS_FILE, JSON.stringify({ results: [null, 7, [], { key: 'valid' }], last_run: 3 }))
    assert.deepEqual(loadLastResults()?.results.map(result => result.key), ['valid'])
    assert.deepEqual(loadLastResults()?.results[0].releases, [])
    assert.equal(loadLastResults()?.last_run, null)
  })
})

test('qBittorrent connection changes invalidate cached torrents and credentials', async () => {
  resetRuntimeForTests()
  const original = globalThis.fetch
  const logins: string[] = []
  let hash = 'a'.repeat(40)
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/auth/login')) {
      logins.push(String(init?.body))
      return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=fixture' } })
    }
    return Response.json([{ hash }])
  }) as typeof fetch
  try {
    const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://one.test', qbittorrent_user: 'user', qbittorrent_pass: 'first' }
    assert.equal((await qbGetTorrents(config))[0].hash, hash)
    hash = 'b'.repeat(40)
    assert.equal((await qbGetTorrents({ ...config, qbittorrent_url: 'http://two.test' }))[0].hash, hash)
    hash = 'c'.repeat(40)
    assert.equal((await qbGetTorrents({ ...config, qbittorrent_url: 'http://two.test', qbittorrent_pass: 'second' }))[0].hash, hash)
    assert.equal(logins.length, 3)
    assert.equal(new URLSearchParams(logins[2]).get('password'), 'second')
  } finally { globalThis.fetch = original; resetRuntimeForTests() }
})

test('invalid qBittorrent lists produce an actionable error without poisoning the cache', async () => {
  resetRuntimeForTests()
  const original = globalThis.fetch
  let list: unknown = { error: 'bad response' }
  globalThis.fetch = (async input => String(input).endsWith('/auth/login')
    ? new Response('Ok.', { headers: { 'Set-Cookie': 'SID=fixture' } }) : Response.json(list)) as typeof fetch
  try {
    const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qbit.test', qbittorrent_user: 'user', qbittorrent_pass: 'pass' }
    await assert.rejects(qbGetTorrents(config), /invalid torrent list/)
    list = [{ hash: 'a'.repeat(40) }]
    assert.equal((await qbGetTorrents(config)).length, 1)
  } finally { globalThis.fetch = original; resetRuntimeForTests() }
})

test('scan cancellation aborts scan requests while independent requests remain usable', async () => {
  resetRuntimeForTests()
  const original = globalThis.fetch
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let independentSignal: AbortSignal | undefined
  globalThis.fetch = (async (input, init) => {
    const signal = init?.signal as AbortSignal
    if (String(input).includes('independent')) { independentSignal = signal; return Response.json({ ok: true }) }
    started()
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch
  try {
    const scan = runScan(DEFAULT_CONFIG, { seadexBest: async () => { await api('http://scan.test'); return new Map() } })
    await ready
    assert.deepEqual(await api('http://independent.test'), { ok: true })
    assert.equal(cancelScan(), true)
    await scan
    assert.equal(independentSignal?.aborted, false)
    assert.equal(getState().cancelled, true)
    const controller = new AbortController(); controller.abort()
    // The caller's signal must survive the timeout wrapper too.
    await api('http://independent.test', undefined, { signal: controller.signal })
    assert.equal(independentSignal?.aborted, true)
  } finally { globalThis.fetch = original; resetRuntimeForTests() }
})

test('scan cancellation interrupts AniList rate-limit backoff immediately', async () => {
  resetRuntimeForTests()
  const original = globalThis.fetch
  let rateLimited!: () => void
  const ready = new Promise<void>(resolve => { rateLimited = resolve })
  globalThis.fetch = (async () => { rateLimited(); return new Response('', { status: 429, headers: { 'Retry-After': '60' } }) }) as typeof fetch
  try {
    const scan = runScan(DEFAULT_CONFIG, { seadexBest: async () => { await alMedia('query', {}); return new Map() } })
    await ready
    cancelScan()
    const start = Date.now()
    await scan
    assert.ok(Date.now() - start < 1000, 'Cancellation should interrupt the 61-second delay')
    assert.equal(getState().cancelled, true)
  } finally { globalThis.fetch = original; resetRuntimeForTests() }
})

test('incremental unmatched results retain other library titles throughout the scan', async () => {
  resetRuntimeForTests()
  setState({ results: [{ key: 'old', library_key: 'Sonarr:item1', title: 'Existing', arr: 'Sonarr' }] })
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const scan = runScan(DEFAULT_CONFIG, {
    seadexBest: async () => new Map(),
    localItems: async () => [2, 3].map(id => ({ arr: 'Sonarr', id, title: `New ${id}`, seasons: { 1: { groups: [], size: 0 } } })),
    anilistChain: async title => { if (title === 'New 3') { entered(); await blocked }; return [] },
    loadCache: () => ({}), saveLastResults: () => {}, autoNotifyNew: async () => 0,
  }, 'sonarr', { sonarrIds: [2, 3] })
  try { await ready; assert.deepEqual(getState().results.map(result => result.title), ['Existing', 'New 2']) }
  finally { release(); await scan; resetRuntimeForTests() }
})

test('notification failure preserves the completed scan instead of restoring stale results', async () => {
  resetRuntimeForTests()
  setState({ results: [{ key: 'old', title: 'Old', arr: 'Sonarr' }] })
  let saved: unknown
  await runScan(DEFAULT_CONFIG, {
    seadexBest: async () => new Map(), localItems: async () => [], loadCache: () => ({}),
    saveLastResults: results => { saved = results }, autoNotifyNew: async () => { throw new Error('Webhook offline') },
  })
  assert.deepEqual(saved, [])
  assert.deepEqual(getState().results, saved)
  assert.equal(getState().error, null)
  assert.ok(getState().last_run)
})

test('notifications delivered before interruption remain marked as delivered', async () => {
  setState({ results: [{ key: 'one', title: 'One', status: 'upgrade' }, { key: 'two', title: 'Two', status: 'upgrade' }] })
  let saved: string[] = []
  await assert.rejects(autoNotifyNew({ ...DEFAULT_CONFIG, webhook: 'https://fixture.test' }, {
    load: () => new Set(), save: values => { saved = [...values] },
    send: async (_webhook, results, onSent) => { onSent?.(results[0]); throw new Error('Interrupted') },
  }), /Interrupted/)
  assert.deepEqual(saved, ['one'])
})

test('queued scheduled scans survive restart and clear persistence when absorbed by a webhook scan', async () => {
  const file = join(DATA_DIR, 'scan_schedule_state.json')
  await preserveFiles([CONFIG_FILE, file], async () => {
    resetRuntimeForTests(); resetWebhookScanState()
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG))
    const now = Date.now() / 1000
    refreshAutocheckSchedule(DEFAULT_CONFIG, now)
    setState({ running: true })
    await processAutocheck(DEFAULT_CONFIG, autocheckState.next!, async () => assert.fail('Must wait for active scan'))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, true)
    resetRuntimeForTests()
    const timer = startScheduler(); clearInterval(timer)
    assert.equal(autocheckState.pending, true)
    queueWebhookScan('sonarr', 'SeriesAdd', 1, now)
    await processWebhookScans(DEFAULT_CONFIG, now + 11, async (_config, trigger, scope) => {
      assert.equal(trigger, 'scheduled'); assert.deepEqual(scope, {})
    })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, false)
    resetRuntimeForTests(); resetWebhookScanState()
  })
})

test('missing qBittorrent files remain an error even when another torrent is complete', () => {
  assert.equal(normalizeQbStates(['missingFiles']), 'error')
  assert.equal(normalizeQbStates(['uploading', 'missingFiles']), 'error')
})

test('release uploads without known episode coverage stay separate from complementary batches', () => {
  const candidate = (hash: string, names: string[]) => ({ releaseGroup: 'Group', tracker: 'Nyaa', quality: '1080p', tags: [], size: 100, file_count: 1, info_hashes: [hash.repeat(40)], is_best: true, source_files: names.map(name => ({ name, length: 100 })) })
  for (const uploads of [
    [candidate('a', ['Movie.mkv']), candidate('b', ['Movie remux.mkv'])],
    [candidate('a', ['Batch.mkv']), candidate('b', ['Show.S01E01.mkv']), candidate('c', ['Show.S01E02.mkv'])],
    [candidate('b', ['Show.S01E01.mkv']), candidate('a', ['Batch.mkv']), candidate('c', ['Show.S01E02.mkv'])],
  ]) {
    const merged = mergeComplementaryCandidates(uploads)
    assert.equal(merged.length, 2)
    assert.equal(merged.find(release => release.info_hashes.includes('a'.repeat(40)))?.info_hashes.length, 1)
    if (uploads.length === 3) assert.equal(merged.find(release => release.info_hashes.includes('b'.repeat(40)))?.info_hashes.length, 2)
  }
})

test('AniList chain ignores non-anime sequel relations and does not retry HTTP 404 responses', async () => {
  const queriedIds: number[] = []
  const chain = await anilistChain('Apocalypse Hotel', {}, {
    lookup: (async () => ({ id: 180675, cover: 'cover-180675', banner: 'banner-180675' })) as any,
    media: (async (_query: string, variables: { id?: number }) => {
      queriedIds.push(Number(variables.id))
      if (variables.id === 180675) {
        return {
          id: 180675, format: 'TV', season: 'SPRING', seasonYear: 2025, episodes: 12,
          title: { english: 'Apocalypse Hotel', romaji: 'Apocalypse Hotel' },
          relations: { edges: [
            { relationType: 'SEQUEL', node: { id: 207065, type: 'MANGA' } },
            { relationType: 'SEQUEL', node: { id: 999999, type: 'ANIME' } },
          ] },
        }
      }
      return {}
    }) as any,
    persist: (() => undefined) as any,
  })
  assert.deepEqual(queriedIds, [180675, 999999])
  assert.deepEqual(chain.map(entry => entry.ids), [[180675]])

  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    return new Response(JSON.stringify({ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } }), { status: 404 })
  }) as typeof fetch
  try {
    const data = await alMedia('query($id:Int){Media(id:$id,type:ANIME){id}}', { id: 207065 })
    assert.deepEqual(data, {})
    assert.equal(attempts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
