import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import {
  PersistentUsenetCache,
  USENET_CACHE_LIMIT,
  providerFingerprint,
  usenetCacheJournalFile,
  usenetCacheKey,
  type UsenetCacheRecord,
} from '../server/usenet-cache.js'
import { fetchUsenetNzb, resolveUsenetHash, resolveUsenetRelease } from '../server/usenet.js'
import { usenetAvailability } from '../server/usenet-copies.js'
import type { Config, Release, ResultItem } from '../server/types.js'
import type { UsenetAvailabilityResult } from '../shared/usenet-contracts.js'
import { DATA_DIR } from '../server/paths.js'
import { resetOwnedRuntime } from '../server/download-store.js'
import { downloadClients } from '../server/download-clients.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { testUsenetRuntime, type TestUsenetRuntime } from './support/usenet-runtime.js'

const HASH = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const THIRD = 'e'.repeat(40)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const settings = { baseUrl: 'https://cache-provider.test', apiKey: 'private-key' }
const fingerprint = providerFingerprint('animetosho', settings)

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    animetosho_url: settings.baseUrl,
    animetosho_enabled: true,
    amenzb_enabled: false,
    ...overrides,
  }
}

function release(hashes = [HASH]): Release {
  return {
    kind: 'best',
    releaseGroup: 'Group',
    tracker: 'Nyaa',
    torrent_available: true,
    info_hashes: hashes,
    size: 100,
  } as Release
}

function match(hash = HASH, id = 123): Response {
  return Response.json({
    id,
    info_hash: hash,
    nzb_url: '/nzb/123',
    title: `Release ${id}`,
    num_files: 1,
    files: [{ name: 'Show.mkv', size: 100 }],
    total_size: 100,
  })
}

async function fixture(
  t: TestContext,
  run: (state: {
    advance(ms: number): void
    calls: URL[]
    respond(handler: (url: URL) => Response | Promise<Response>): void
    snapshot(hashes?: string[], refresh?: boolean, cfg?: Config): Promise<UsenetAvailabilityResult>
    usenet: TestUsenetRuntime
  }) => Promise<void>,
): Promise<void> {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const calls: URL[] = []
  let response = (url: URL): Response | Promise<Response> => match(url.searchParams.get('hash') || HASH)
  const usenet = testUsenetRuntime(t, {
    now: () => now,
    fetch: async input => {
      const url = new URL(String(input))
      calls.push(url)
      return response(url)
    },
  })
  await run({
    advance(ms) {
      now += ms
    },
    calls,
    respond(handler) {
      response = handler
    },
    async snapshot(hashes = [HASH], refresh = false, cfg = config()) {
      const results = [{ key: 'cache-show', releases: [release(hashes)] }] as unknown as ResultItem[]
      const [row] = await usenetAvailability(cfg, [{ key: 'cache-show', release: 0 }], results, { refresh })
      return row
    },
    usenet,
  })
}

test('fresh persisted provider facts survive a restart and generation changes without provider traffic', async t => {
  await fixture(t, async state => {
    const checked = await resolveUsenetHash(config(), HASH)
    assert.equal(state.usenet.runtime.shutdown(), true)
    state.usenet.restart()
    bumpGeneration()
    const restored = await state.snapshot()
    assert.equal(restored.aggregate, 'available')
    assert.equal(restored.checked_at, checked.checked_at)
    assert.equal(restored.stale, false)
    assert.equal(restored.refreshing, false)
    assert.equal(state.calls.length, 1)
    const authoritative = await resolveUsenetHash(config(), HASH)
    assert.deepEqual(authoritative.file_names, ['Show.mkv'])
    assert.equal(state.calls.length, 1)
  })
})

test('restored manifest paths remain exact so cached scope checks cannot hide extra files', async t => {
  await fixture(t, async state => {
    const ledgerFile = join(DATA_DIR, 'owned_downloads.json')
    const savedLedger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile) : undefined
    const selectedName = 'Show A .mkv'
    const extraName = 'Show <A>.mkv'
    try {
      fs.rmSync(ledgerFile, { force: true })
      resetOwnedRuntime()
      state.respond(() =>
        Response.json({
          id: 123,
          info_hash: HASH,
          nzb_url: '/nzb/123',
          num_files: 2,
          files: [
            { name: selectedName, size: 50 },
            { name: extraName, size: 50 },
          ],
          total_size: 100,
        }),
      )
      await resolveUsenetHash(config(), HASH)
      state.usenet.restart()
      state.respond(() => assert.fail('Fresh restored provider facts do not need another lookup'))
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        assert.equal(new URL(String(input)).hostname, 'cache-sab.test')
        return Response.json({ queue: { slots: [], diskspace1: '1', diskspace2: '1' } })
      })
      const selected = { ...release(), selected_files: [selectedName] }
      const results = [
        {
          key: 'cache-show',
          arr: 'Sonarr',
          title: 'Cached scope',
          season: 1,
          status: 'upgrade',
          have: [],
          releases: [selected],
        },
      ] as unknown as ResultItem[]
      const cacheConfig = config({
        download_mode: 'usenet_only',
        sabnzbd_url: 'http://cache-sab.test',
        sabnzbd_key: 'test-key',
      })
      const built = await buildDownloadPlan(cacheConfig, [{ key: 'cache-show', release: 0, protocol: 'usenet' }], {
        results,
        clients: downloadClients(cacheConfig),
      })
      assert.equal(built.review.requires_whole_ack, true)
      assert.deepEqual(built.review.units[0].known_extra_files, [extraName])
      assert.equal(built.review.units[0].extra_file_count, 1)
    } finally {
      if (savedLedger) fs.writeFileSync(ledgerFile, savedLedger)
      else fs.rmSync(ledgerFile, { force: true })
      resetOwnedRuntime()
    }
  })
})

test('a provider observation visible before abrupt process exit restores without a shutdown flush', async t => {
  await fixture(t, async state => {
    const usenetModule = new URL('../server/usenet.js', import.meta.url).href
    const runtimeModule = new URL('../server/usenet-runtime.js', import.meta.url).href
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { resolveUsenetHash } from ${JSON.stringify(usenetModule)};
      import { createUsenetRuntime } from ${JSON.stringify(runtimeModule)};
      createUsenetRuntime({
        now: () => 1800000000000,
        paths: { cache: ${JSON.stringify(state.usenet.paths.cache)} },
        fetch: async () => new Response(JSON.stringify({ id: 123, info_hash: ${JSON.stringify(HASH)}, nzb_url: '/nzb/123', num_files: 1, files: [{ name: 'Show.mkv', size: 100 }] })),
      });
      const observation = await resolveUsenetHash(${JSON.stringify(config())}, ${JSON.stringify(HASH)});
      if (observation.state !== 'available') process.exit(2);
      process.exit(0);
    `,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(child.status, 0, child.stderr)
    state.usenet.restart()
    const restored = await state.snapshot()
    assert.equal(restored.aggregate, 'available')
    assert.equal(restored.refreshing, false)
    assert.equal(state.calls.length, 0)
  })
})

test('stale and mixed snapshots return last-known rows before delayed, deduplicated refreshes finish', async t => {
  await fixture(t, async state => {
    const checked = await resolveUsenetHash(config(), HASH)
    state.advance(8 * DAY)
    const pending = new Map<string, { promise: Promise<Response>; resolve(response: Response): void }>()
    state.respond(url => {
      const hash = url.searchParams.get('hash')!
      const response = Promise.withResolvers<Response>()
      pending.set(hash, response)
      return response.promise
    })
    const row = await state.snapshot([HASH, OTHER])
    assert.deepEqual(
      row.hashes.map(hash => hash.state),
      ['available', 'not_checked'],
    )
    assert.equal(row.aggregate, 'incomplete')
    assert.equal(row.checked_at, checked.checked_at)
    assert.equal(row.stale, true)
    assert.equal(row.refreshing, true)
    await nextTurn()
    assert.equal(state.calls.length, 3)
    for (let index = 0; index < 5; index++) assert.equal((await state.snapshot([HASH, OTHER])).refreshing, true)
    assert.equal(state.calls.length, 3)
    pending.get(HASH)!.resolve(match(HASH, 456))
    pending.get(OTHER)!.resolve(match(OTHER, 789))
    await nextTurn()
    const updated = await state.snapshot([HASH, OTHER])
    assert.equal(updated.aggregate, 'available')
    assert.equal(updated.refreshing, false)
    assert.equal(updated.stale, false)
    assert.equal(updated.hashes[0].entry_id, '456')
    assert.notEqual(updated.checked_at, checked.checked_at)
  })
})

test('failed refreshes retain stable observations and stop polling work until backoff or an explicit retry', async t => {
  await fixture(t, async state => {
    const checked = await resolveUsenetHash(config(), HASH)
    state.advance(8 * DAY)
    state.respond(() => new Response('unavailable', { status: 503 }))
    assert.equal((await state.snapshot()).aggregate, 'available')
    await nextTurn()
    const failed = await state.snapshot()
    assert.equal(failed.aggregate, 'available')
    assert.equal(failed.checked_at, checked.checked_at)
    assert.equal(failed.refreshing, false)
    assert.equal(failed.stale, true)
    assert.match(failed.refresh_error || '', /503|failed|server/i)
    for (let index = 0; index < 3; index++) await state.snapshot()
    assert.equal(state.calls.length, 2)
    assert.equal((await resolveUsenetHash(config(), HASH)).state, 'lookup_failed')
    await assert.rejects(fetchUsenetNzb(config(), 'animetosho', '123', HASH), /no longer available/)
    assert.equal(state.calls.length, 2)
    state.respond(() => match(HASH, 456))
    const retry = await state.snapshot([HASH], true)
    assert.equal(retry.aggregate, 'available')
    assert.equal(retry.refreshing, true)
    await nextTurn()
    const succeeded = await state.snapshot()
    assert.equal(succeeded.hashes[0].entry_id, '456')
    assert.equal(succeeded.refresh_error, undefined)
    assert.equal(succeeded.stale, false)
    assert.equal(state.calls.length, 3)
  })
})

test('processing, absence, failures, and new hashes use distinct retry intervals without invented absence', async t => {
  await fixture(t, async state => {
    let processing = true
    state.respond(url =>
      url.searchParams.get('hash') === HASH
        ? processing
          ? Response.json({ id: 123, info_hash: HASH, nzb_url: null })
          : match()
        : url.searchParams.get('hash') === OTHER
          ? new Response('gone', { status: 404 })
          : new Response('bad', { status: 503 }),
    )
    const initial = await state.snapshot([HASH, OTHER, THIRD])
    assert.deepEqual(
      initial.hashes.map(hash => hash.state),
      ['not_checked', 'not_checked', 'not_checked'],
    )
    assert.equal(initial.checked_at, '')
    await nextTurn()
    const observed = await state.snapshot([HASH, OTHER, THIRD])
    assert.deepEqual(
      observed.hashes.map(hash => hash.state),
      ['processing', 'no_match', 'lookup_failed'],
    )
    assert.equal(observed.refreshing, false)
    state.advance(60_001)
    await state.snapshot([THIRD])
    await nextTurn()
    assert.equal(state.calls.filter(url => url.searchParams.get('hash') === THIRD).length, 2)
    processing = false
    state.advance(10 * 60_000)
    const stale = await state.snapshot([HASH, OTHER])
    assert.deepEqual(
      stale.hashes.map(hash => hash.state),
      ['processing', 'no_match'],
    )
    await nextTurn()
    assert.equal((await state.snapshot([HASH])).aggregate, 'available')
    assert.equal(state.calls.filter(url => url.searchParams.get('hash') === OTHER).length, 1)
    state.advance(HOUR)
    state.respond(url => match(url.searchParams.get('hash')!))
    assert.equal((await state.snapshot([OTHER])).aggregate, 'no_match')
    await nextTurn()
    assert.equal((await state.snapshot([OTHER])).aggregate, 'available')
  })
})

test('fallback snapshots preserve provider observation ages and deduplicate the whole refresh chain', async t => {
  await fixture(t, async state => {
    const cfg = config({
      amenzb_enabled: true,
      amenzb_url: 'https://second-provider.test',
      amenzb_key: 'second-secret',
    })
    const fallback = Promise.withResolvers<Response>()
    state.respond(url =>
      url.host === 'cache-provider.test' ? new Response('gone', { status: 404 }) : fallback.promise,
    )
    const pending = await state.snapshot([HASH], false, cfg)
    assert.equal(pending.aggregate, 'not_checked')
    await nextTurn()
    assert.equal(state.calls.length, 2)
    assert.equal((await state.snapshot([HASH], false, cfg)).aggregate, 'not_checked')
    assert.equal(state.calls.length, 2)
    state.advance(5000)
    fallback.resolve(
      new Response(
        '<rss xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel><item><newznab:attr name="guid" value="entry-123"/><title>Show</title><enclosure url="https://second-provider.test/api?t=get&amp;id=entry-123&amp;apikey=second-secret" length="100" type="application/x-nzb"/><newznab:attr name="infohash" value="' +
          HASH +
          '"/></item></channel></rss>',
        { headers: { 'content-type': 'application/xml' } },
      ),
    )
    await nextTurn()
    const known = await state.snapshot([HASH], false, cfg)
    assert.equal(known.aggregate, 'available')
    assert.equal(known.hashes[0].provider, 'amenzb')
    assert.equal(known.checked_at, new Date(1_800_000_000_000).toISOString())
    assert.equal(known.refreshing, false)
    assert.equal(state.usenet.runtime.shutdown(), true)
    assert.equal(fs.readFileSync(state.usenet.paths.cache, 'utf8').includes('second-secret'), false)
  })
})

test('provider URL and key changes remove only incompatible records while unrelated config saves retain matches', async t => {
  await fixture(t, async state => {
    const cfg = config({ amenzb_enabled: true, amenzb_url: 'https://second-provider.test', amenzb_key: 'old-key' })
    state.respond(url =>
      url.host !== 'second-provider.test'
        ? url.searchParams.get('hash') === OTHER
          ? new Response('gone', { status: 404 })
          : match()
        : new Response(
            `<rss xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel><item><newznab:attr name="guid" value="entry-123"/><newznab:attr name="infohash" value="${OTHER}"/></item></channel></rss>`,
            { headers: { 'content-type': 'application/xml' } },
          ),
    )
    await resolveUsenetHash(cfg, HASH)
    await resolveUsenetHash(cfg, OTHER)
    assert.equal(state.calls.length, 3)
    bumpGeneration()
    state.usenet.runtime.configChanged(cfg, { ...cfg, hidden: ['unrelated'] })
    assert.equal((await state.snapshot([HASH, OTHER], false, cfg)).aggregate, 'available')
    assert.equal(state.calls.length, 3)
    const newKey = { ...cfg, amenzb_key: 'new-key' }
    state.usenet.runtime.configChanged(cfg, newKey)
    assert.equal((await state.snapshot([HASH], false, newKey)).aggregate, 'available')
    assert.equal((await state.snapshot([OTHER], false, newKey)).aggregate, 'not_checked')
    await nextTurn()
    assert.equal(state.calls.length, 4)
    assert.equal(state.calls[3].searchParams.get('apikey'), 'new-key')
    assert.equal((await state.snapshot([OTHER], false, newKey)).aggregate, 'available')
    const changed = { ...newKey, animetosho_url: 'https://changed-provider.test' }
    state.usenet.runtime.configChanged(newKey, changed)
    assert.equal((await state.snapshot([HASH], false, changed)).aggregate, 'not_checked')
    await nextTurn()
    assert.equal(state.calls.length, 5)
    assert.equal(state.calls[4].host, 'changed-provider.test')
  })
})

test('authoritative stale checks wait for refreshed facts rather than accepting retained matches', async t => {
  await fixture(t, async state => {
    await resolveUsenetHash(config(), HASH)
    state.advance(8 * DAY)
    const pending = Promise.withResolvers<Response>()
    state.respond(() => pending.promise)
    let finished = false
    const work = resolveUsenetRelease(config(), release()).then(result => {
      finished = true
      return result
    })
    await nextTurn()
    assert.equal(finished, false)
    assert.equal((await state.snapshot()).aggregate, 'available')
    pending.resolve(new Response('gone', { status: 404 }))
    assert.equal((await work).aggregate, 'no_match')
    assert.equal((await state.snapshot()).aggregate, 'no_match')
  })
})

test('an explicit retry cancels an old background refresh without letting its late absence overwrite the new match', async t => {
  await fixture(t, async state => {
    await resolveUsenetHash(config(), HASH)
    state.advance(8 * DAY)
    const old = Promise.withResolvers<Response>()
    state.respond(() => old.promise)
    await state.snapshot()
    await nextTurn()
    state.respond(() => match(HASH, 456))
    await state.snapshot([HASH], true)
    await nextTurn()
    assert.equal((await state.snapshot()).hashes[0].entry_id, '456')
    old.resolve(new Response('gone', { status: 404 }))
    await nextTurn()
    assert.equal((await state.snapshot()).hashes[0].entry_id, '456')
    assert.equal(state.calls.length, 3)
  })
})

test('corrupted persistence is ignored and later validated observations replace it', async t => {
  await fixture(t, async state => {
    fs.writeFileSync(state.usenet.paths.cache, '{broken')
    state.usenet.restart()
    assert.equal((await state.snapshot()).aggregate, 'not_checked')
    await nextTurn()
    assert.equal((await state.snapshot()).aggregate, 'available')
    assert.equal(state.usenet.runtime.shutdown(), true)
    assert.equal(JSON.parse(fs.readFileSync(state.usenet.paths.cache, 'utf8')).version, 1)
  })
})

test('observations checkpoint before exposure, failure metadata batches, and persistence strips secrets without losing full manifests or prior snapshots', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'usenet-cache-'))
  const file = join(directory, 'cache.json')
  const cache = new PersistentUsenetCache(file)
  const write = fs.writeFileSync
  const record: UsenetCacheRecord = {
    provider: 'animetosho',
    fingerprint,
    hash: HASH,
    checkedAt: 100,
    lastAttemptAt: 100,
    retryAt: 0,
    lookup: {
      kind: 'match',
      match: {
        provider: 'animetosho',
        entry_id: '123',
        source_hash: HASH,
        title: 'Title private-key https://host.test/path?apikey=private-key',
        files_complete: true,
        file_count: 205,
        files: Array.from({ length: 205 }, (_, index) => ({ name: `Show ${index}.mkv`, size: 100 })),
      },
    },
  }
  const journal = usenetCacheJournalFile(file)
  try {
    cache.set(record, settings)
    assert.equal(fs.existsSync(file), false, 'an observation does not rewrite the snapshot')
    const journaled = fs.readFileSync(journal, 'utf8')
    assert.equal(journaled.split('\n').filter(Boolean).length, 1, 'the observation is journaled before exposure')
    assert.equal(journaled.includes('private-key'), false)
    assert.equal(journaled.includes('https://'), false)
    const key = usenetCacheKey('animetosho', fingerprint, HASH)
    cache.reset(true)
    assert.equal(cache.get(key)?.lookup?.kind, 'match', 'a journaled observation restores without a snapshot')
    assert.equal(cache.flush(), true)
    assert.equal(fs.existsSync(journal), false, 'compaction truncates the journal')
    const saved = fs.readFileSync(file, 'utf8')
    assert.equal(saved.includes('private-key'), false)
    assert.equal(saved.includes('https://'), false)
    assert.equal(saved.includes('nzb_url'), false)
    assert.equal(saved.includes('segments'), false)
    cache.reset(true)
    const restored = cache.get(key)!
    assert.equal(restored.lookup?.kind, 'match')
    if (restored.lookup?.kind === 'match') assert.equal(restored.lookup.match.files?.length, 205)
    const beforeRead = fs.statSync(file).mtimeMs
    for (let index = 0; index < 10; index++) cache.get(key)
    assert.equal(fs.statSync(file).mtimeMs, beforeRead)
    cache.set(
      {
        ...record,
        lastAttemptAt: 150,
        retryAt: 250,
        failure: { kind: 'failed', code: 'server', message: 'private-key' },
      },
      settings,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), saved)
    assert.equal(fs.existsSync(journal), false, 'failure metadata is batched rather than journaled')
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(path) === `${file}.tmp`) throw new Error('cache write refused')
      return Reflect.apply(write, fs, [path, ...args])
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    cache.set({ ...record, checkedAt: 200, lastAttemptAt: 200 }, settings)
    assert.equal(cache.flush(), false)
    assert.equal(fs.readFileSync(file, 'utf8'), saved)
    fs.writeFileSync = write
    syncBuiltinESMExports()
    assert.equal(cache.flush(), true)
    cache.reset(true)
    assert.equal(cache.get(key)!.checkedAt, 200)
  } finally {
    fs.writeFileSync = write
    syncBuiltinESMExports()
    cache.reset()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('capacity remains a bounded safety limit without age eviction', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'usenet-cache-bound-'))
  const file = join(directory, 'cache.json')
  const cache = new PersistentUsenetCache(file)
  try {
    const records = Array.from({ length: USENET_CACHE_LIMIT + 1 }, (_, index) => ({
      provider: 'animetosho',
      fingerprint,
      hash: index.toString(16).padStart(40, '0'),
      checkedAt: index + 1,
      lastAttemptAt: index + 1,
      retryAt: 0,
      lookup: { kind: 'no_match' },
    }))
    fs.writeFileSync(file, JSON.stringify({ version: 1, records }))
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, '0'.repeat(40))), undefined)
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, '1'.padStart(40, '0')))?.lookup?.kind, 'no_match')
    cache.set(
      {
        provider: 'animetosho',
        fingerprint,
        hash: HASH,
        checkedAt: 50_000,
        lastAttemptAt: 50_000,
        retryAt: 0,
        lookup: { kind: 'no_match' },
      },
      settings,
    )
    assert.equal(cache.flush(), true)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, USENET_CACHE_LIMIT)
    cache.reset(true)
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, HASH))?.lookup?.kind, 'no_match')
  } finally {
    cache.reset()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('pruning by referenced hashes and a torn journal tail keep only valid, current observations', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'usenet-cache-prune-'))
  const file = join(directory, 'cache.json')
  const cache = new PersistentUsenetCache(file)
  const record = (hash: string, at: number): UsenetCacheRecord => ({
    provider: 'animetosho',
    fingerprint,
    hash,
    checkedAt: at,
    lastAttemptAt: at,
    retryAt: 0,
    lookup: { kind: 'no_match' },
    negativeStreak: 2,
  })
  try {
    cache.set(record(HASH, 100), settings)
    cache.set(record(OTHER, 100), settings)
    fs.appendFileSync(usenetCacheJournalFile(file), '{"provider":"animetosho","finger')
    cache.reset(true)
    assert.equal(cache.size, 2, 'a torn final journal line is skipped')
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, HASH))?.negativeStreak, 2)
    assert.equal(cache.retainHashes(new Set([HASH])), 1)
    assert.equal(cache.flush(), true)
    cache.reset(true)
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, OTHER)), undefined)
    assert.equal(cache.get(usenetCacheKey('animetosho', fingerprint, HASH))?.lookup?.kind, 'no_match')
  } finally {
    cache.reset()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('repeated absences lengthen the refresh interval and a match resets it', async t => {
  await fixture(t, async state => {
    state.respond(() => new Response('gone', { status: 404 }))
    const lookupsAfter = async (ms: number) => {
      state.advance(ms)
      await state.snapshot()
      await nextTurn()
      return state.calls.length
    }
    await resolveUsenetHash(config(), HASH)
    assert.equal(await lookupsAfter(HOUR + 1), 2, 'the first absence is rechecked after an hour')
    assert.equal(await lookupsAfter(HOUR + 1), 2, 'the second absence waits longer than an hour')
    assert.equal(await lookupsAfter(5 * HOUR), 3, 'the second absence is rechecked after six hours')
    assert.equal(await lookupsAfter(6 * HOUR + 1), 3, 'the third absence waits a day')
    assert.equal(await lookupsAfter(18 * HOUR), 4)
    assert.equal(await lookupsAfter(DAY + 1), 4, 'the fourth absence waits a week')
    state.respond(() => match())
    assert.equal(await lookupsAfter(6 * DAY), 5)
    assert.equal((await state.snapshot()).aggregate, 'available')
    state.respond(() => new Response('gone', { status: 404 }))
    assert.equal(await lookupsAfter(7 * DAY + 1), 6)
    assert.equal(await lookupsAfter(HOUR + 1), 7, 'a match resets the absence back-off')
  })
})

test('AnimeTosho entries without an NZB are processing only while recent', async t => {
  await fixture(t, async state => {
    const now = Date.now()
    const entry = (extra: Record<string, unknown>) =>
      Response.json({ id: 123, info_hash: HASH, nzb_url: null, ...extra })
    const lookup = async (response: Response) => {
      state.usenet.fresh()
      state.respond(() => response)
      return (await resolveUsenetHash(config(), HASH)).state
    }
    assert.equal(
      await lookup(entry({ status: 'unknown', timestamp: Math.floor(now / 1000) - 400 * 24 * 3600 })),
      'no_match',
      'an old unmirrored entry is absent',
    )
    assert.equal(
      await lookup(entry({ status: 'unknown', timestamp: Math.floor(now / 1000) - 3600 })),
      'processing',
      'a recent entry is still processing',
    )
    assert.equal(
      await lookup(entry({ status: 'processing', timestamp: Math.floor(now / 1000) - 400 * 24 * 3600 })),
      'processing',
      'an explicit processing status wins',
    )
    assert.equal(await lookup(entry({})), 'processing', 'an entry without a timestamp stays conservative')
  })
})

test('multi-hash snapshots report the oldest observation instead of the snapshot-read time', async t => {
  await fixture(t, async state => {
    const first = await resolveUsenetHash(config(), HASH)
    state.advance(5 * 60_000)
    const second = await resolveUsenetHash(config(), OTHER)
    assert.notEqual(first.checked_at, second.checked_at)
    state.advance(5 * 60_000)
    const row = await state.snapshot([HASH, OTHER])
    assert.equal(row.aggregate, 'available')
    assert.equal(row.checked_at, first.checked_at)
    assert.equal(row.refreshing, false)
    assert.equal(state.calls.length, 2)
  })
})

test('deleted observations remain last-known absence for one hour and then can become available', async t => {
  await fixture(t, async state => {
    state.respond(() => Response.json({ id: 123, deleted: true, info_hash: HASH }))
    const deleted = await resolveUsenetHash(config(), HASH)
    assert.equal(deleted.state, 'no_match')
    state.advance(59 * 60_000)
    assert.equal((await state.snapshot()).refreshing, false)
    assert.equal(state.calls.length, 1)
    state.advance(60_001)
    state.respond(() => match())
    const stale = await state.snapshot()
    assert.equal(stale.aggregate, 'no_match')
    assert.equal(stale.checked_at, deleted.checked_at)
    assert.equal(stale.stale, true)
    assert.equal(stale.refreshing, true)
    await nextTurn()
    assert.equal((await state.snapshot()).aggregate, 'available')
    assert.equal(state.calls.length, 2)
  })
})
