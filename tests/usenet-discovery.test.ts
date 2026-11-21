import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { aggregateHashStates, invalidateUsenetLookups, resolveUsenetHash, resolveUsenetRelease, usenetAvailability } from '../server/usenet.js'
import type { Release, ResultItem } from '../server/types.js'

const HASH = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

function config() {
  return {
    ...DEFAULT_CONFIG,
    animetosho_enabled: true,
    amenzb_enabled: true,
    amenzb_url: 'https://amenzb.example',
    amenzb_key: 'amenzb-key',
    sabnzbd_url: 'http://sab.test:8080/',
    sabnzbd_key: 'sab-key',
    download_mode: 'choose' as const,
  }
}

function release(overrides: Partial<Release> = {}): Release {
  return { kind: 'best', releaseGroup: 'Group', tracker: 'Nyaa', torrent_available: true, info_hashes: [HASH], size: 100, ...overrides } as Release
}

interface Fixture { animetosho?: () => Response; amenzb?: () => Response }

function router(fixture: Fixture): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = []
  const original = globalThis.fetch
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://feed.animetosho.net/json')) return (fixture.animetosho ?? (() => new Response('not found', { status: 404 })))()
    if (url.startsWith('https://amenzb.example/api')) return (fixture.amenzb ?? (() => new Response('not found', { status: 404 })))()
    throw new Error(`unexpected provider request: ${url}`)
  }) as typeof fetch
  globalThis.fetch = fetchImpl
  return { calls, fetchImpl: original === undefined ? fetchImpl : fetchImpl }
}

function restore(original: typeof fetch) { globalThis.fetch = original }

const animetoshoMatch = () => Response.json({
  id: 1234, info_hash: HASH.toUpperCase(), nzb_url: 'https://feed.animetosho.net/nzb/1234',
  title: 'Show S01E01', torrent_name: 'Show 1080p', status: 'complete', deleted: false,
  num_files: 2, total_size: 500_000_000,
  files: [{ name: 'Show - 01.mkv', size: 400_000_000, processed: true }, { name: 'Show - 02.mkv', size: 100_000_000, processed: true }],
})

function isolation() {
  const original = globalThis.fetch
  invalidateUsenetLookups()
  const generation = bumpGeneration()
  return { original, generation }
}

test('a hash matched by AnimeTosho resolves as available with the provider manifest', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: animetoshoMatch })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'available')
    assert.equal(state.provider, 'animetosho')
    assert.equal(state.entry_id, '1234')
    assert.equal(state.total_bytes, 500_000_000)
    assert.equal(state.files_known, true)
    assert.equal(state.file_count, 2)
    assert.deepEqual(state.file_names, ['Show - 01.mkv', 'Show - 02.mkv'])
    assert.equal(routed.calls.length, 1)
    assert.equal(routed.calls[0], `https://feed.animetosho.net/json?show=torrent&hash=${HASH}`)
  } finally { restore(original) }
})

test('successful lookups are cached until invalidated', async () => {
  const { original } = isolation()
  let hits = 0
  const routed = router({ animetosho: () => { hits++; return animetoshoMatch() } })
  try {
    await resolveUsenetHash(config(), HASH)
    await resolveUsenetHash(config(), HASH)
    assert.equal(hits, 1, 'positive results must be served from the cache')
    invalidateUsenetLookups()
    await resolveUsenetHash(config(), HASH)
    assert.equal(hits, 2, 'invalidation forces a fresh lookup')
    assert.equal(routed.calls.length, 2)
  } finally { restore(original) }
})

test('any provider failure keeps the hash lookup_failed instead of claiming no match', async () => {
  const { original } = isolation()
  router({
    animetosho: () => new Response('gone', { status: 404 }), // definitive no_match from animetosho
    amenzb: () => new Response('boom', { status: 503 }),
  })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'lookup_failed')
    assert.equal(state.error_code, 'server')
    assert.deepEqual(state.providers_failed, ['amenzb'])
  } finally { restore(original) }
})

test('definitive no_match requires every enabled provider to complete cleanly', async () => {
  const { original } = isolation()
  router({ animetosho: () => new Response('nope', { status: 404 }), amenzb: () => amenzbEmpty() })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'no_match')
  } finally { restore(original) }
})

function amenzbEmpty(): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel><title>AmeNZB</title></channel></rss>`, { headers: { 'content-type': 'application/xml' } })
}

test('AnimeTosho processing surfaces as processing, never as failure', async () => {
  const { original } = isolation()
  router({ animetosho: () => Response.json({ id: 55, info_hash: HASH, nzb_url: null, title: 'Show S01E02', status: 'processing', deleted: false, num_files: 1, total_size: 10 }) })
  try {
    const state = await resolveUsenetHash({ ...config(), amenzb_enabled: false }, HASH)
    assert.equal(state.state, 'processing')
  } finally { restore(original) }
})

test('release aggregation waits for every source hash: one miss makes the release incomplete', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: () => (String(routed.calls.at(-1)).includes(`hash=${HASH}`) ? animetoshoMatch() : new Response('nope', { status: 404 })) })
  try {
    const resolved = await resolveUsenetRelease({ ...config(), amenzb_enabled: false }, release({ info_hashes: [HASH, OTHER] }))
    assert.equal(resolved.aggregate, 'incomplete')
    const byHash = new Map(resolved.hashes.map(hash => [hash.hash, hash.state]))
    assert.equal(byHash.get(HASH), 'available')
    assert.equal(byHash.get(OTHER), 'no_match')
  } finally { restore(original) }
})

test('aggregate precedence: not_configured outranks failures, failures outrank processing', () => {
  assert.equal(aggregateHashStates([]), 'unsupported_hash')
  assert.equal(aggregateHashStates(['available', 'not_configured']), 'not_configured')
  assert.equal(aggregateHashStates(['available', 'lookup_failed', 'processing', 'no_match']), 'lookup_failed')
  assert.equal(aggregateHashStates(['available', 'incomplete']), 'incomplete')
  assert.equal(aggregateHashStates(['available', 'processing']), 'incomplete')
  assert.equal(aggregateHashStates(['available', 'no_match']), 'incomplete')
  assert.equal(aggregateHashStates(['processing', 'no_match']), 'processing')
  assert.equal(aggregateHashStates(['available', 'available']), 'available')
})

test('disabling providers keeps them from being contacted and marks not_configured when none remain', async () => {
  const { original } = isolation()
  const routed = router({})
  try {
    const state = await resolveUsenetHash({ ...config(), animetosho_enabled: false, amenzb_enabled: false }, HASH)
    assert.equal(state.state, 'not_configured')
    assert.equal(routed.calls.length, 0)
  } finally { restore(original) }
})

test('availability resolves the release identity and reports the checked hash set per selection', async () => {
  const { original } = isolation()
  router({ animetosho: animetoshoMatch })
  try {
    const results = [{ key: 'show-1', releases: [release()] }] as unknown as ResultItem[]
    const availability = await usenetAvailability(config(), [{ key: 'show-1', release: 0 }], false, results)
    assert.equal(availability.length, 1)
    assert.equal(availability[0].aggregate, 'available')
    assert.equal(availability[0].hashes.length, 1)
    assert.equal(availability[0].hashes[0].hash, HASH)
    assert.ok(availability[0].checked_at)
  } finally { restore(original) }
})

test('unsupported releases report unsupported_hash without provider traffic', async () => {
  const { original } = isolation()
  const routed = router({})
  try {
    const state = await resolveUsenetHash(config(), 'not-a-info-hash')
    assert.equal(state.state, 'unsupported_hash')
    assert.equal(routed.calls.length, 0)
  } finally { restore(original) }
})
