import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import type { OwnedDownloadRecord } from '../server/download-store.js'
import { RESULTS_FILE } from '../server/paths.js'
import { prowlarrFingerprint, prowlarrIndexers } from '../server/prowlarr.js'
import { saveLastResults } from '../server/results.js'
import type { Config, Release, ResultItem } from '../server/types.js'
import { cachedHashState, resolveUsenetHash } from '../server/usenet.js'
import type { SearchRecord } from '../server/usenet-search-store.js'
import { testUsenetRuntime } from './support/usenet-runtime.js'

const HASH = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const LEDGER_HASH = 'e'.repeat(40)
const ALIAS = `files:${'f'.repeat(40)}`
const PRIVATE = `files:${'a'.repeat(40)}`
const ANIMETOSHO = 'https://runtime-tosho.test'
const PROWLARR = 'http://runtime-prowlarr.test:9696'
const KEY = 'runtime-prowlarr-key'
const DAY = 24 * 60 * 60_000

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    animetosho_url: ANIMETOSHO,
    animetosho_enabled: true,
    amenzb_enabled: false,
    ...overrides,
  }
}

function toshoMatch(hash: string): Response {
  return Response.json({
    id: 7,
    info_hash: hash,
    nzb_url: '/nzb/7',
    title: 'Release 7',
    num_files: 1,
    files: [{ name: 'Show.mkv', size: 100 }],
    total_size: 100,
  })
}

test('a fresh runtime looks hashes up through its own fetch and writes its cache to its own path', async t => {
  const calls: URL[] = []
  const { runtime: usenet, paths } = testUsenetRuntime(t, {
    fetch: async input => {
      const url = new URL(String(input))
      calls.push(url)
      return toshoMatch(url.searchParams.get('hash') || HASH)
    },
  })
  const answer = await resolveUsenetHash(config(), HASH)
  assert.equal(answer.state, 'available')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].origin, ANIMETOSHO)
  assert.equal(usenet.shutdown(), true)
  assert.ok(fs.existsSync(paths.cache), 'the cache is written to the runtime path')
})

test('a fresh runtime measures freshness on its own clock', async t => {
  let now = 1_800_000_000_000
  let calls = 0
  testUsenetRuntime(t, {
    now: () => now,
    fetch: async input => {
      calls++
      return toshoMatch(new URL(String(input)).searchParams.get('hash') || HASH)
    },
  })
  await resolveUsenetHash(config(), HASH)
  await resolveUsenetHash(config(), HASH)
  assert.equal(calls, 1, 'a fresh observation is not asked again')
  now += 8 * DAY
  await resolveUsenetHash(config(), HASH)
  assert.equal(calls, 2, 'an observation older than a week is asked again')
})

/** A fetch whose AnimeTosho answers wait until released, and a count of the requests that reached it. */
function heldTosho() {
  const held: (() => void)[] = []
  const state = {
    calls: 0,
    hold: false,
    release: () => held.splice(0).forEach(resume => resume()),
    fetch: async (input: RequestInfo | URL) => {
      state.calls++
      const url = new URL(String(input))
      if (state.hold) await new Promise<void>(resolve => held.push(resolve))
      return toshoMatch(url.searchParams.get('hash') || HASH)
    },
  }
  return state
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) await nextTurn()
  assert.ok(condition(), 'the condition was never met')
}

test('changed hash indexer settings cancel running lookups and drop observations of the old settings', async t => {
  const tosho = heldTosho()
  const { runtime: usenet } = testUsenetRuntime(t, { fetch: tosho.fetch })
  const moved = config({ animetosho_url: 'https://runtime-tosho-mirror.test' })
  await resolveUsenetHash(config(), OTHER)
  tosho.hold = true
  const running = resolveUsenetHash(config(), HASH)
  await until(() => tosho.calls === 2)
  usenet.configChanged(config(), moved)
  const cancelled = await running
  tosho.release()
  assert.equal(cancelled.state, 'lookup_failed')
  assert.equal(cancelled.error, 'lookup cancelled')
  tosho.hold = false
  usenet.configChanged(moved, config())
  assert.equal(cachedHashState(config(), OTHER), 'not_checked', 'the observation of the old settings is gone')
})

test('an unrelated settings change cancels nothing and keeps every observation', async t => {
  const tosho = heldTosho()
  const { runtime: usenet } = testUsenetRuntime(t, { fetch: tosho.fetch })
  await resolveUsenetHash(config(), OTHER)
  tosho.hold = true
  const running = resolveUsenetHash(config(), HASH)
  await until(() => tosho.calls === 2)
  usenet.configChanged(
    config(),
    config({ notify_enabled: !DEFAULT_CONFIG.notify_enabled, webhook: 'https://hook.test' }),
  )
  tosho.release()
  assert.equal((await running).state, 'available')
  assert.equal(cachedHashState(config(), OTHER), 'available')
})

function searchRecord(sourceId: string, fingerprint = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })) {
  return {
    source_id: sourceId,
    fingerprint,
    searched_at: 1_800_000_000_000,
    last_attempt_at: 1_800_000_000_000,
    retry_at: 0,
    indexers: [],
    candidates: [],
  } satisfies SearchRecord
}

function prowlarrConfig(overrides: Partial<Config> = {}): Config {
  return config({ prowlarr_enabled: true, prowlarr_url: PROWLARR, prowlarr_key: KEY, ...overrides })
}

test('changed Prowlarr settings drop the indexer list and what other connections found', async t => {
  let listed = 0
  const { runtime: usenet } = testUsenetRuntime(t, {
    fetch: async input => {
      if (new URL(String(input)).pathname === '/api/v1/indexer') listed++
      return Response.json([])
    },
  })
  const settings = { baseUrl: PROWLARR, apiKey: KEY }
  const fingerprint = prowlarrFingerprint(settings)
  usenet.searchStore.put(searchRecord(HASH))
  await prowlarrIndexers(settings)
  usenet.configChanged(prowlarrConfig(), prowlarrConfig({ prowlarr_search_limit: 5, webhook: 'https://hook.test' }))
  await prowlarrIndexers(settings)
  assert.equal(listed, 1, 'a limit or unrelated change keeps the indexer list')
  usenet.configChanged(prowlarrConfig(), prowlarrConfig({ prowlarr_enabled: false }))
  await prowlarrIndexers(settings)
  assert.equal(listed, 2, 'turning Prowlarr off reads the indexer list again')
  assert.ok(usenet.searchStore.get(fingerprint, HASH), 'turning Prowlarr off alone keeps its results')
  usenet.configChanged(prowlarrConfig(), prowlarrConfig({ prowlarr_key: 'another-key' }))
  assert.equal(usenet.searchStore.get(fingerprint, HASH), undefined, 'another key drops the old results')
})

function release(hash: string, privateSource?: string): Release {
  return {
    kind: 'best',
    releaseGroup: 'Group',
    tracker: 'Nyaa',
    torrent_available: true,
    info_hashes: [hash],
    size: 100,
    ...(privateSource ? { private_sources: [{ id: privateSource, tracker: 'AB', files: [] }] } : {}),
  } as Release
}

const result = (releases: Release[]) => ({ key: 'runtime-show', status: 'missing', releases }) as unknown as ResultItem

function ledgerRecord(overrides: Partial<OwnedDownloadRecord>): OwnedDownloadRecord {
  return { source_hash: LEDGER_HASH, last_phase: 'downloading', ...overrides } as OwnedDownloadRecord
}

test('new results keep what they and active downloads name, and drop the rest', async t => {
  const { runtime: usenet } = testUsenetRuntime(t, {
    sweep: true,
    fetch: async input => toshoMatch(new URL(String(input)).searchParams.get('hash') || HASH),
  })
  const fingerprint = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })
  await resolveUsenetHash(config(), HASH)
  await resolveUsenetHash(config(), OTHER)
  const settled = `files:${'b'.repeat(40)}`
  for (const source of [HASH, OTHER, PRIVATE, LEDGER_HASH, ALIAS, settled]) usenet.searchStore.put(searchRecord(source))
  const ledger = [
    ledgerRecord({ source_alias: ALIAS }),
    ledgerRecord({ source_hash: OTHER, last_phase: 'complete' }),
    ledgerRecord({ source_hash: 'b'.repeat(40), source_alias: settled, removed_at: '2026-01-01T00:00:00Z' }),
  ]
  // Without SABnzbd no sweep runs; the stores are pruned all the same.
  usenet.resultsChanged(config(), [result([release(HASH, PRIVATE)])], ledger, 'test')
  assert.equal(cachedHashState(config(), HASH), 'available')
  assert.equal(cachedHashState(config(), OTHER), 'not_checked', 'a hash no result names is forgotten')
  const kept = [HASH, OTHER, PRIVATE, LEDGER_HASH, ALIAS, settled].filter(source =>
    usenet.searchStore.get(fingerprint, source),
  )
  assert.deepEqual(kept, [HASH, PRIVATE, LEDGER_HASH, ALIAS])
})

test('without a readable ledger no search record is dropped', async t => {
  const { runtime: usenet } = testUsenetRuntime(t, { sweep: true })
  const fingerprint = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })
  usenet.searchStore.put(searchRecord(OTHER))
  usenet.resultsChanged(config(), [result([release(HASH)])], undefined, 'test')
  assert.ok(usenet.searchStore.get(fingerprint, OTHER))
  usenet.resultsChanged(config(), [result([release(HASH)])], [], 'test')
  assert.equal(usenet.searchStore.get(fingerprint, OTHER), undefined)
})

test('a runtime without sweeps prunes nothing', async t => {
  const { runtime: usenet } = testUsenetRuntime(t)
  const fingerprint = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })
  usenet.searchStore.put(searchRecord(OTHER))
  usenet.resultsChanged(config(), [result([release(HASH)])], [], 'test')
  assert.ok(usenet.searchStore.get(fingerprint, OTHER))
})

test('a replaced runtime can no longer be used', t => {
  const { runtime: first } = testUsenetRuntime(t)
  testUsenetRuntime(t)
  assert.throws(() => first.shutdown(), /replaced/)
})

test('changed Usenet eligibility sweeps the saved results again, and an unrelated change does not', async t => {
  const swept: string[] = []
  const { runtime: usenet } = testUsenetRuntime(t, {
    sweep: true,
    fetch: async input => {
      const hash = new URL(String(input)).searchParams.get('hash') || HASH
      swept.push(hash)
      return toshoMatch(hash)
    },
  })
  const saved = fs.existsSync(RESULTS_FILE) ? fs.readFileSync(RESULTS_FILE) : undefined
  t.after(() => {
    if (saved) fs.writeFileSync(RESULTS_FILE, saved)
    else fs.rmSync(RESULTS_FILE, { force: true })
  })
  saveLastResults([result([release(HASH)])], '2026-11-27T00:00:00Z')
  const torrents = config({
    sabnzbd_url: 'http://sab.test:8080/',
    sabnzbd_key: 'sab-key',
    download_mode: 'torrent_only',
  })
  const either: Config = { ...torrents, download_mode: 'choose' }
  usenet.configChanged(either, { ...either, webhook: 'https://hook.test' })
  await nextTurn()
  assert.deepEqual(swept, [], 'an unrelated change starts no sweep')
  usenet.configChanged(torrents, either)
  await until(() => swept.length === 1)
  assert.deepEqual(swept, [HASH])
})

test('a replaced runtime writes nothing it had pending, as a process that exits', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runtime: first, paths } = testUsenetRuntime(t)
  first.searchStore.put(searchRecord(HASH))
  testUsenetRuntime(t)
  t.mock.timers.tick(5 * 60_000)
  assert.equal(fs.existsSync(paths.search), false, 'the pending write of the replaced runtime is dropped')
})
