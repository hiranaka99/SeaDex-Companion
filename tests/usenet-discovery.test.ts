import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import {
  aggregateHashStates,
  resetUsenetLookups,
  raceWithWallClockGuard,
  resolveUsenetHash,
  resolveUsenetRelease,
  usenetScheduler,
  UsenetSelectionError,
  usenetAvailability,
} from '../server/usenet.js'
import { LookupScheduler, ProviderPausedError, type LookupJob } from '../server/usenet-scheduler.js'
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
  return {
    kind: 'best',
    releaseGroup: 'Group',
    tracker: 'Nyaa',
    torrent_available: true,
    info_hashes: [HASH],
    size: 100,
    ...overrides,
  } as Release
}

interface Fixture {
  animetosho?: () => Response | Promise<Response>
  amenzb?: () => Response | Promise<Response>
}

function router(fixture: Fixture): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = []
  const original = globalThis.fetch
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://feed.animetosho.net/json'))
      return (fixture.animetosho ?? (() => new Response('not found', { status: 404 })))()
    if (url.startsWith('https://amenzb.example/api'))
      return (fixture.amenzb ?? (() => new Response('not found', { status: 404 })))()
    throw new Error(`unexpected provider request: ${url}`)
  }) as typeof fetch
  globalThis.fetch = fetchImpl
  return { calls, fetchImpl: original === undefined ? fetchImpl : fetchImpl }
}

function restore(original: typeof fetch) {
  globalThis.fetch = original
}

const animetoshoMatch = () =>
  Response.json({
    id: 1234,
    info_hash: HASH.toUpperCase(),
    nzb_url: 'https://feed.animetosho.net/nzb/1234',
    title: 'Show S01E01',
    torrent_name: 'Show 1080p',
    status: 'complete',
    deleted: false,
    num_files: 2,
    total_size: 500_000_000,
    files: [
      { name: 'Show - 01.mkv', size: 400_000_000, processed: true },
      { name: 'Show - 02.mkv', size: 100_000_000, processed: true },
    ],
  })

function isolation() {
  const original = globalThis.fetch
  resetUsenetLookups()
  usenetScheduler.options.minIntervalMs = 0
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
  } finally {
    restore(original)
  }
})

test('successful lookups are cached until explicitly reset', async () => {
  const { original } = isolation()
  let hits = 0
  const routed = router({
    animetosho: () => {
      hits++
      return animetoshoMatch()
    },
  })
  try {
    await resolveUsenetHash(config(), HASH)
    await resolveUsenetHash(config(), HASH)
    assert.equal(hits, 1, 'positive results must be served from the cache')
    resetUsenetLookups()
    await resolveUsenetHash(config(), HASH)
    assert.equal(hits, 2, 'an explicit test reset forces a fresh lookup')
    assert.equal(routed.calls.length, 2)
  } finally {
    restore(original)
  }
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
  } finally {
    restore(original)
  }
})

test('definitive no_match requires every enabled provider to complete cleanly', async () => {
  const { original } = isolation()
  router({ animetosho: () => new Response('nope', { status: 404 }), amenzb: () => amenzbEmpty() })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'no_match')
  } finally {
    restore(original)
  }
})

function amenzbEmpty(): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel><title>AmeNZB</title></channel></rss>`,
    { headers: { 'content-type': 'application/xml' } },
  )
}

test('AnimeTosho processing surfaces as processing, never as failure', async () => {
  const { original } = isolation()
  router({
    animetosho: () =>
      Response.json({
        id: 55,
        info_hash: HASH,
        nzb_url: null,
        title: 'Show S01E02',
        status: 'processing',
        deleted: false,
        num_files: 1,
        total_size: 10,
      }),
  })
  try {
    const state = await resolveUsenetHash({ ...config(), amenzb_enabled: false }, HASH)
    assert.equal(state.state, 'processing')
  } finally {
    restore(original)
  }
})

test('release aggregation waits for every source hash: one miss makes the release incomplete', async () => {
  const { original } = isolation()
  const routed = router({
    animetosho: () =>
      String(routed.calls.at(-1)).includes(`hash=${HASH}`) ? animetoshoMatch() : new Response('nope', { status: 404 }),
  })
  try {
    const resolved = await resolveUsenetRelease(
      { ...config(), amenzb_enabled: false },
      release({ info_hashes: [HASH, OTHER] }),
    )
    assert.equal(resolved.aggregate, 'incomplete')
    const byHash = new Map(resolved.hashes.map(hash => [hash.hash, hash.state]))
    assert.equal(byHash.get(HASH), 'available')
    assert.equal(byHash.get(OTHER), 'no_match')
  } finally {
    restore(original)
  }
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
  } finally {
    restore(original)
  }
})

test('availability resolves the release identity and reports the checked hash set per selection', async () => {
  const { original } = isolation()
  router({ animetosho: animetoshoMatch })
  try {
    await resolveUsenetHash(config(), HASH)
    const results = [{ key: 'show-1', releases: [release()] }] as unknown as ResultItem[]
    const availability = await usenetAvailability(config(), [{ key: 'show-1', release: 0 }], results)
    assert.equal(availability.length, 1)
    assert.equal(availability[0].aggregate, 'available')
    assert.equal(availability[0].hashes.length, 1)
    assert.equal(availability[0].hashes[0].hash, HASH)
    assert.equal(availability[0].identity, releaseIdentity(results[0].releases[0]))
    assert.ok(availability[0].checked_at)
  } finally {
    restore(original)
  }
})

test('availability rejects replacement identities before any selected release is queried', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: animetoshoMatch })
  try {
    const previous = release()
    const replacement = release({ info_hashes: [OTHER] })
    const results = [{ key: 'show-1', releases: [previous, replacement] }] as unknown as ResultItem[]
    await assert.rejects(
      usenetAvailability(
        config(),
        [
          { key: 'show-1', release: 0, identity: releaseIdentity(previous) },
          { key: 'show-1', release: 1, identity: releaseIdentity(previous) },
        ],
        results,
      ),
      (error: unknown) => error instanceof UsenetSelectionError && error.status === 409,
    )
    assert.equal(routed.calls.length, 0)
    const scoped = release({ selected_files: ['Show - 01.mkv'] })
    await assert.rejects(
      usenetAvailability(config(), [{ key: 'show-1', release: 0, identity: releaseIdentity(scoped) }], results),
      /selected release changed/,
    )
    assert.equal(routed.calls.length, 0)
  } finally {
    restore(original)
  }
})

test('availability rejects missing and invalid release selections without provider work', async () => {
  const { original } = isolation()
  const routed = router({ animetosho: animetoshoMatch })
  try {
    const results = [{ key: 'show-1', releases: [release()] }] as unknown as ResultItem[]
    for (const selection of [
      { key: 'missing', release: 0 },
      { key: 'show-1', release: -1 },
      { key: 'show-1', release: 1 },
      { key: 'show-1', release: 0.5 },
    ]) {
      await assert.rejects(
        usenetAvailability(config(), [selection], results),
        (error: unknown) => error instanceof UsenetSelectionError && error.status === 400,
      )
    }
    assert.equal(routed.calls.length, 0)
  } finally {
    restore(original)
  }
})

test('server resolvers retain complete manifests while public availability bounds display names', async () => {
  const { original } = isolation()
  const files = Array.from({ length: 205 }, (_, index) => ({ name: `Show - ${index + 1}.mkv`, size: 100 }))
  const routed = router({
    animetosho: () =>
      Response.json({ id: 1234, info_hash: HASH, nzb_url: '/nzb/1234', num_files: files.length, files }),
  })
  try {
    const internal = await resolveUsenetHash(config(), HASH)
    assert.equal(internal.files_known, true)
    assert.equal(internal.file_count, files.length)
    assert.deepEqual(
      internal.file_names,
      files.map(file => file.name),
    )
    const selected = release({ selected_files: [files[204].name] })
    const resolved = await resolveUsenetRelease(config(), selected)
    assert.deepEqual(
      resolved.hashes[0].file_names,
      files.map(file => file.name),
    )
    const results = [{ key: 'show-1', releases: [selected] }] as unknown as ResultItem[]
    const [publicResult] = await usenetAvailability(
      config(),
      [{ key: 'show-1', release: 0, identity: releaseIdentity(selected) }],
      results,
    )
    assert.equal(publicResult.identity, releaseIdentity(selected))
    assert.equal(publicResult.hashes[0].file_count, files.length)
    assert.equal(publicResult.hashes[0].file_names?.length, 200)
    assert.equal(publicResult.hashes[0].files_known, false)
    const afterPublicProjection = await resolveUsenetHash(config(), HASH)
    assert.equal(afterPublicProjection.files_known, true)
    assert.deepEqual(
      afterPublicProjection.file_names,
      files.map(file => file.name),
    )
    assert.equal(routed.calls.length, 1)
  } finally {
    restore(original)
  }
})

test('discovery preserves reported file counts without trusting malformed manifests', async () => {
  const { original } = isolation()
  router({
    animetosho: () =>
      Response.json({
        id: 1234,
        info_hash: HASH,
        nzb_url: '/nzb/1234',
        num_files: 2,
        files: [
          { name: 'Show.mkv', size: 100 },
          { name: '', size: 10 },
        ],
      }),
  })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'available')
    assert.equal(state.file_count, 2)
    assert.equal(state.files_known, false)
    assert.equal(state.file_names, undefined)
  } finally {
    restore(original)
  }
})

test('unsupported releases report unsupported_hash without provider traffic', async () => {
  const { original } = isolation()
  const routed = router({})
  try {
    const state = await resolveUsenetHash(config(), 'not-a-info-hash')
    assert.equal(state.state, 'unsupported_hash')
    assert.equal(routed.calls.length, 0)
  } finally {
    restore(original)
  }
})

test('a refresh bypasses a wedged in-flight lookup instead of inheriting its hang', async () => {
  const { original } = isolation()
  let hang = true
  const started = Promise.withResolvers<void>()
  const stalled = Promise.withResolvers<Response>()
  router({
    animetosho: () => {
      if (!hang) return animetoshoMatch()
      started.resolve()
      return stalled.promise
    },
  })
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
  } finally {
    restore(original)
  }
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
  router({
    animetosho: () => {
      requests++
      return stalled.promise
    },
  })
  const pending = Array.from({ length: 8 }, (_, index) =>
    resolveUsenetHash(settings, index === 0 ? HASH : index.toString(16).padStart(40, '0'), false, true),
  )
  try {
    await nextTurn()
    assert.equal(requests, 3, 'background work leaves one slot reserved for interactive lookups')
    resetUsenetLookups()
    const cancelled = await Promise.all(pending)
    assert.ok(cancelled.every(state => state.state === 'lookup_failed'))
    assert.equal(requests, 3, 'queued cancelled lookups must not issue provider requests')
    router({ animetosho: animetoshoMatch })
    assert.equal((await resolveUsenetHash(settings, HASH)).state, 'available')
    stalled.resolve(new Response('nope', { status: 404 }))
    await nextTurn()
    assert.equal((await resolveUsenetHash(settings, HASH)).state, 'available')
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => resolveUsenetHash(settings, (index + 20).toString(16).padStart(40, '0'))),
    )
  } finally {
    resetUsenetLookups()
    await Promise.all(pending)
    restore(original)
  }
})

const lookupJob = (channel: string, background = false): LookupJob => ({
  channel,
  background,
  controller: new AbortController(),
})
const RATE_LIMITED = { kind: 'failed', code: 'rate_limited' } as const

test('rate limiting widens a channel interval up to 15 seconds and every 20 answers narrow it down to the minimum', t => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const scheduler = new LookupScheduler()
  const answers = (count: number) => {
    for (let index = 0; index < count; index++) scheduler.recordOutcome('animetosho', { kind: 'no_match' })
  }
  assert.equal(scheduler.interval('animetosho'), 2_000, 'a channel starts at its minimum')
  scheduler.recordOutcome('animetosho', RATE_LIMITED)
  scheduler.recordOutcome('animetosho', RATE_LIMITED)
  assert.equal(scheduler.interval('animetosho'), 3_000, 'requests that fail together widen the interval once')
  const widened: number[] = []
  for (let round = 0; round < 6; round++) {
    now = scheduler.pausedUntil('animetosho')
    scheduler.recordOutcome('animetosho', RATE_LIMITED)
    widened.push(scheduler.interval('animetosho'))
  }
  assert.deepEqual(widened, [4_500, 6_750, 10_125, 15_000, 15_000, 15_000])
  assert.equal(scheduler.interval('amenzb'), 2_000, 'other channels keep their own interval')

  answers(19)
  assert.equal(scheduler.interval('animetosho'), 15_000)
  answers(1)
  assert.equal(scheduler.interval('animetosho'), 13_500)
  answers(19)
  scheduler.recordOutcome('animetosho', { kind: 'failed', code: 'invalid_response' })
  answers(19)
  assert.equal(scheduler.interval('animetosho'), 13_500, 'a failure restarts the count of answers')
  answers(1)
  assert.equal(scheduler.interval('animetosho'), 12_150)
  answers(20 * 30)
  assert.equal(scheduler.interval('animetosho'), 2_000, 'the interval never drops below the minimum')

  now = scheduler.pausedUntil('animetosho')
  scheduler.recordOutcome('animetosho', RATE_LIMITED)
  assert.equal(scheduler.interval('animetosho'), 3_000)
  scheduler.reset()
  assert.equal(scheduler.interval('animetosho'), 2_000, 'a reset forgets the widening')
})

test('a new minimum applies at once to a channel unless rate limiting widened it further', () => {
  const scheduler = new LookupScheduler({ minIntervalMs: 2_000 })
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven' })
  assert.equal(scheduler.interval('prowlarr:7'), 2_000)
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven', minIntervalMs: 500 })
  assert.equal(scheduler.interval('prowlarr:7'), 500)
  scheduler.recordOutcome('prowlarr:7', RATE_LIMITED)
  assert.equal(scheduler.interval('prowlarr:7'), 750)
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven', minIntervalMs: 100 })
  assert.equal(scheduler.interval('prowlarr:7'), 750, 'a widened channel keeps its interval')
  scheduler.describe('prowlarr:7', { label: 'Indexer 7', minIntervalMs: 1_000 })
  assert.equal(scheduler.interval('prowlarr:7'), 1_000)
  scheduler.reset()
  assert.equal(scheduler.interval('prowlarr:7'), 1_000, 'a reset keeps the description')
  scheduler.options.minIntervalMs = 0
  assert.equal(scheduler.interval('prowlarr:8'), 0, 'a channel without its own minimum follows the scheduler')
})

test('a channel created on first use is paced by its own interval and leaves other channels alone', async () => {
  const scheduler = new LookupScheduler({ concurrency: 3, foregroundReserved: 1, minIntervalMs: 80 })
  const started: Record<string, number> = {}
  const acquire = (name: string, channel: string) =>
    scheduler.acquire(lookupJob(channel)).then(() => {
      started[name] = Date.now()
    })
  const first = acquire('first', 'prowlarr:7')
  const second = acquire('second', 'prowlarr:7')
  const other = acquire('other', 'prowlarr:8')
  await Promise.all([first, other])
  assert.equal(started.second, undefined, 'the second request on a channel waits for its interval')
  assert.ok(started.other - started.first < 70, 'another channel does not wait for it')
  await second
  assert.ok(started.second - started.first >= 70, `started too early: ${started.second - started.first}ms`)
  for (let slot = 0; slot < 3; slot++) scheduler.release()

  scheduler.recordOutcome('prowlarr:7', RATE_LIMITED)
  assert.equal(scheduler.interval('prowlarr:7'), 120)
  assert.equal(scheduler.interval('prowlarr:8'), 80)
  assert.equal(scheduler.isPaused('prowlarr:8'), false)
  const [pause, ...others] = scheduler.pauses()
  assert.deepEqual(others, [])
  assert.deepEqual(
    pause,
    { channel: 'prowlarr:7', label: 'prowlarr:7', until: scheduler.pausedUntil('prowlarr:7'), reason: 'rate_limited' },
    'a channel nobody described is labelled by its name',
  )
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven' })
  assert.equal(scheduler.pauses()[0].label, 'Indexer Seven')
  assert.equal(scheduler.interval('prowlarr:7'), 120, 'describing a channel keeps its pacing and health')
})

test('a paused channel fails queued foreground work fast and makes background work wait out the pause', async () => {
  const scheduler = new LookupScheduler({ concurrency: 2, foregroundReserved: 1, minIntervalMs: 0, pauseBaseMs: 250 })
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven' })
  await scheduler.acquire(lookupJob('prowlarr:7'))
  await scheduler.acquire(lookupJob('prowlarr:7'))
  const foreground = scheduler.acquire(lookupJob('prowlarr:7'))
  let backgroundStartedAt = 0
  const background = scheduler.acquire(lookupJob('prowlarr:7', true)).then(() => {
    backgroundStartedAt = Date.now()
  })
  const elsewhere = scheduler.acquire(lookupJob('prowlarr:8'))

  scheduler.recordOutcome('prowlarr:7', RATE_LIMITED)
  const until = scheduler.pausedUntil('prowlarr:7')
  scheduler.release()
  scheduler.release()
  await assert.rejects(
    foreground,
    (error: unknown) => error instanceof ProviderPausedError && error.channel === 'prowlarr:7' && error.until === until,
  )
  await assert.rejects(scheduler.acquire(lookupJob('prowlarr:7')), ProviderPausedError)
  assert.match(
    scheduler.pausedFailure('prowlarr:7', until).message,
    /^Indexer Seven is rate limiting lookups; retrying in about/,
  )
  await elsewhere
  scheduler.release()
  assert.equal(backgroundStartedAt, 0, 'background work does not start while its channel is paused')
  await background
  assert.ok(backgroundStartedAt >= until, 'background work starts once the pause is over')
  assert.deepEqual(scheduler.pauses(), [])
  scheduler.release()
})

test('scheduler instances share no capacity: lookups that never finish on one leave every slot of the other free', async () => {
  const hashes = new LookupScheduler({ concurrency: 4, foregroundReserved: 1, minIntervalMs: 0 })
  const searches = new LookupScheduler({ concurrency: 3, foregroundReserved: 1, minIntervalMs: 0 })
  // Three background searches and a foreground one that are never released.
  const jobs = [true, true, true, false].map(background => lookupJob('prowlarr:7', background))
  const started = jobs.map(() => false)
  const stuck = jobs.map((job, index) =>
    searches.acquire(job).then(
      () => {
        started[index] = true
      },
      () => {},
    ),
  )
  await nextTurn()
  assert.deepEqual(started, [true, true, false, true], 'background work leaves the reserved slot to foreground work')
  searches.recordOutcome('animetosho', RATE_LIMITED)

  await Promise.all(Array.from({ length: 4 }, () => hashes.acquire(lookupJob('animetosho'))))
  assert.equal(hashes.isPaused('animetosho'), false, 'instances do not share channel health either')
  assert.equal(started[2], false, 'the full scheduler keeps its own work queued')
  jobs[2].controller.abort()
  await Promise.all(stuck)
})
