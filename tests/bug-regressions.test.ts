import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  api, alMedia, autoNotifyNew, autocheckState, CACHE_FILE, CONFIG_FILE, DEFAULT_CONFIG,
  DATA_DIR, ENCRYPTED_SECRETS_FILE, getState, HISTORY_FILE, loadCache, loadConfig, loadLastResults,
  loadScanHistory, loadUserRules, LOG_FILE, normalizeQbStates, qbGetTorrents, readLogTail,
  resetRuntimeForTests, RESULTS_FILE, runScan, cancelScan, setState, USER_RULES_FILE, mergeComplementaryCandidates,
} from '../server/app.js'
import { processAutocheck, processWebhookScans, queueWebhookScan, refreshAutocheckSchedule, resetWebhookScanState, startScheduler } from '../server/index.js'
import { join } from 'node:path'

async function preserveFiles(files: string[], action: () => void | Promise<void>) {
  const saved = files.map(file => existsSync(file) ? readFileSync(file) : null)
  try { await action() }
  finally { files.forEach((file, index) => { const data = saved[index]; if (data) writeFileSync(file, data); else rmSync(file, { force: true }) }) }
}

test('log tails retain the first line and complete lines on a byte boundary', async () => {
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
    assert.deepEqual(loadLastResults()?.results, [{ key: 'valid' }])
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
