import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { aggregateHashStates, invalidateUsenetLookups, raceWithWallClockGuard, resolveUsenetHash, resolveUsenetRelease, setUsenetProviderMinIntervalMs, UsenetSelectionError, usenetAvailability } from '../server/usenet.js'
import { releaseIdentity } from '../shared/releases.js'
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

interface Fixture { animetosho?: () => Response | Promise<Response>; amenzb?: () => Response | Promise<Response> }

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
  setUsenetProviderMinIntervalMs('animetosho', 0)
  setUsenetProviderMinIntervalMs('amenzb', 0)
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
    assert.equal(availability[0].identity, releaseIdentity(results[0].releases[0]))
    assert.ok(availability[0].checked_at)
  } finally { restore(original) }
})

test('availability rejects replacement identities before any selected release is queried', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: animetoshoMatch })
  try {
    const previous = release()
    const replacement = release({ info_hashes: [OTHER] })
    const results = [{ key: 'show-1', releases: [previous, replacement] }] as unknown as ResultItem[]
    await assert.rejects(usenetAvailability(config(), [
      { key: 'show-1', release: 0, identity: releaseIdentity(previous) },
      { key: 'show-1', release: 1, identity: releaseIdentity(previous) },
    ], false, results), (error: unknown) => error instanceof UsenetSelectionError && error.status === 409)
    assert.equal(routed.calls.length, 0)
    const scoped = release({ selected_files: ['Show - 01.mkv'] })
    await assert.rejects(usenetAvailability(config(), [{ key: 'show-1', release: 0, identity: releaseIdentity(scoped) }], false, results), /selected release changed/)
    assert.equal(routed.calls.length, 0)
  } finally { restore(original) }
})

test('availability rejects missing and invalid release selections without provider work', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: animetoshoMatch })
  try {
    const results = [{ key: 'show-1', releases: [release()] }] as unknown as ResultItem[]
    for (const selection of [
      { key: 'missing', release: 0 }, { key: 'show-1', release: -1 },
      { key: 'show-1', release: 1 }, { key: 'show-1', release: 0.5 },
    ]) {
      await assert.rejects(usenetAvailability(config(), [selection], false, results),
        (error: unknown) => error instanceof UsenetSelectionError && error.status === 400)
    }
    assert.equal(routed.calls.length, 0)
  } finally { restore(original) }
})

test('server resolvers retain complete manifests while public availability bounds display names', async () => {
  const { original } = isolation()
  const files = Array.from({ length: 205 }, (_, index) => ({ name: `Show - ${index + 1}.mkv`, size: 100 }))
  const routed = router({ animetosho: () => Response.json({ id: 1234, info_hash: HASH, nzb_url: '/nzb/1234', num_files: files.length, files }) })
  try {
    const internal = await resolveUsenetHash(config(), HASH)
    assert.equal(internal.files_known, true)
    assert.equal(internal.file_count, files.length)
    assert.deepEqual(internal.file_names, files.map(file => file.name))
    const selected = release({ selected_files: [files[204].name] })
    const resolved = await resolveUsenetRelease(config(), selected)
    assert.deepEqual(resolved.hashes[0].file_names, files.map(file => file.name))
    const results = [{ key: 'show-1', releases: [selected] }] as unknown as ResultItem[]
    const [publicResult] = await usenetAvailability(config(), [{ key: 'show-1', release: 0, identity: releaseIdentity(selected) }], false, results)
    assert.equal(publicResult.identity, releaseIdentity(selected))
    assert.equal(publicResult.hashes[0].file_count, files.length)
    assert.equal(publicResult.hashes[0].file_names?.length, 200)
    assert.equal(publicResult.hashes[0].files_known, false)
    const afterPublicProjection = await resolveUsenetHash(config(), HASH)
    assert.equal(afterPublicProjection.files_known, true)
    assert.deepEqual(afterPublicProjection.file_names, files.map(file => file.name))
    assert.equal(routed.calls.length, 1)
  } finally { restore(original) }
})

test('discovery preserves reported file counts without trusting malformed manifests', async () => {
  const { original } = isolation()
  router({ animetosho: () => Response.json({ id: 1234, info_hash: HASH, nzb_url: '/nzb/1234', num_files: 2, files: [{ name: 'Show.mkv', size: 100 }, { name: '', size: 10 }] }) })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'available')
    assert.equal(state.file_count, 2)
    assert.equal(state.files_known, false)
    assert.equal(state.file_names, undefined)
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

test('a refresh bypasses a wedged in-flight lookup instead of inheriting its hang', async () => {
  const { original } = isolation()
  let hang = true
  const started = Promise.withResolvers<void>()
  const stalled = Promise.withResolvers<Response>()
  router({ animetosho: () => {
    if (!hang) return animetoshoMatch()
    started.resolve()
    return stalled.promise
  } })
  try {
    const wedged = resolveUsenetHash({ ...config(), amenzb_enabled: false }, HASH)
    await started.promise
    hang = false
    const state = await resolveUsenetHash({ ...config(), amenzb_enabled: false }, HASH, true)
    assert.equal(state.state, 'available')
    assert.equal(state.provider, 'animetosho')
    assert.equal((await wedged).state, 'lookup_failed')
    stalled.resolve(new Response('nope', { status: 404 }))
    await nextTurn()
    assert.equal((await resolveUsenetHash({ ...config(), amenzb_enabled: false }, HASH)).state, 'available')
  } finally { restore(original) }
})

test('the wall-clock guard rejects a provider call that never settles', async () => {
  const started = Date.now()
  await assert.rejects(raceWithWallClockGuard(new Promise<never>(() => {}), 20), /wall-clock guard/)
  assert.ok(Date.now() - started < 5_000, 'the guard must not keep the process waiting')
})

test('invalidation cancels active and queued work without leaking global permits or overwriting a fresh cache', async () => {
  const { original } = isolation()
  const settings = { ...config(), amenzb_enabled: false }
  const stalled = Promise.withResolvers<Response>()
  let requests = 0
  router({ animetosho: () => { requests++; return stalled.promise } })
  const pending = Array.from({ length: 8 }, (_, index) => resolveUsenetHash(settings, index === 0 ? HASH : index.toString(16).padStart(40, '0'), false, true))
  try {
    await nextTurn()
    assert.equal(requests, 4)
    invalidateUsenetLookups()
    const cancelled = await Promise.all(pending)
    assert.ok(cancelled.every(state => state.state === 'lookup_failed'))
    assert.equal(requests, 4, 'queued cancelled lookups must not issue provider requests')
    router({ animetosho: animetoshoMatch })
    assert.equal((await resolveUsenetHash(settings, HASH)).state, 'available')
    stalled.resolve(new Response('nope', { status: 404 }))
    await nextTurn()
    assert.equal((await resolveUsenetHash(settings, HASH)).state, 'available')
    await Promise.all(Array.from({ length: 8 }, (_, index) => resolveUsenetHash(settings, (index + 20).toString(16).padStart(40, '0'))))
  } finally {
    invalidateUsenetLookups()
    await Promise.all(pending)
    restore(original)
  }
})
