import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { aggregateHashStates, resolveUsenetHash, resolveUsenetRelease, UsenetSelectionError } from '../server/usenet.js'
import { usenetAvailability } from '../server/usenet-copies.js'
import { LookupGuardTimeout } from '../server/lookup-flights.js'
import { LookupScheduler, ProviderPausedError } from '../server/usenet-scheduler.js'
import { releaseIdentity } from '../shared/releases.js'
import type { Release, ResultItem } from '../server/types.js'
import { holdJob, runJob } from './support/lookup-jobs.js'
import { testUsenetRuntime, type TestUsenetRuntime } from './support/usenet-runtime.js'

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

/** How the runtime in use reaches the hash indexers; set by `router`. */
let routed: typeof fetch = async input => {
  throw new Error(`unexpected provider request: ${String(input)}`)
}

function router(fixture: Fixture): { calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://feed.animetosho.net/json'))
      return (fixture.animetosho ?? (() => new Response('not found', { status: 404 })))()
    if (url.startsWith('https://amenzb.example/api'))
      return (fixture.amenzb ?? (() => new Response('not found', { status: 404 })))()
    throw new Error(`unexpected provider request: ${url}`)
  }) as typeof fetch
  routed = fetchImpl
  return { calls }
}

let usenet: TestUsenetRuntime | undefined

/** A fresh runtime on empty data paths that asks the hash indexers through `router`. */
function freshRuntime(): TestUsenetRuntime {
  usenet?.close()
  usenet = testUsenetRuntime(undefined, { fetch: (input, init) => routed(input, init) })
  return usenet
}

function restore() {
  usenet?.close()
  usenet = undefined
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
  const runtime = freshRuntime()
  const generation = bumpGeneration()
  return { runtime, generation }
}

test('a hash matched by AnimeTosho resolves as available with the provider manifest', async () => {
  isolation()
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
    restore()
  }
})

test('successful lookups are cached for the life of the runtime', async () => {
  isolation()
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
    freshRuntime()
    await resolveUsenetHash(config(), HASH)
    assert.equal(hits, 2, 'a fresh runtime on empty data asks again')
    assert.equal(routed.calls.length, 2)
  } finally {
    restore()
  }
})

test('any provider failure keeps the hash lookup_failed instead of claiming no match', async () => {
  isolation()
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
    restore()
  }
})

test('definitive no_match requires every enabled provider to complete cleanly', async () => {
  isolation()
  router({ animetosho: () => new Response('nope', { status: 404 }), amenzb: () => amenzbEmpty() })
  try {
    const state = await resolveUsenetHash(config(), HASH)
    assert.equal(state.state, 'no_match')
  } finally {
    restore()
  }
})

function amenzbEmpty(): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel><title>AmeNZB</title></channel></rss>`,
    { headers: { 'content-type': 'application/xml' } },
  )
}

test('AnimeTosho processing surfaces as processing, never as failure', async () => {
  isolation()
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
    restore()
  }
})

test('release aggregation waits for every source hash: one miss makes the release incomplete', async () => {
  isolation()
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
    restore()
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
  isolation()
  const routed = router({})
  try {
    const state = await resolveUsenetHash({ ...config(), animetosho_enabled: false, amenzb_enabled: false }, HASH)
    assert.equal(state.state, 'not_configured')
    assert.equal(routed.calls.length, 0)
  } finally {
    restore()
  }
})

test('availability resolves the release identity and reports the checked hash set per selection', async () => {
  isolation()
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
    restore()
  }
})

test('availability rejects replacement identities before any selected release is queried', async () => {
  isolation()
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
    restore()
  }
})

test('availability rejects missing and invalid release selections without provider work', async () => {
  isolation()
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
    restore()
  }
})

test('server resolvers retain complete manifests while public availability bounds display names', async () => {
  isolation()
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
    restore()
  }
})

test('discovery preserves reported file counts without trusting malformed manifests', async () => {
  isolation()
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
    restore()
  }
})

test('unsupported releases report unsupported_hash without provider traffic', async () => {
  isolation()
  const routed = router({})
  try {
    const state = await resolveUsenetHash(config(), 'not-a-info-hash')
    assert.equal(state.state, 'unsupported_hash')
    assert.equal(routed.calls.length, 0)
  } finally {
    restore()
  }
})

test('a refresh bypasses a wedged in-flight lookup instead of inheriting its hang', async () => {
  isolation()
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
    restore()
  }
})

test('the wall-clock guard fails a job whose work never settles and frees its slot', async () => {
  const scheduler = new LookupScheduler({ concurrency: 1, foregroundReserved: 0, minIntervalMs: 0 })
  const started = Date.now()
  const stuck = holdJob(scheduler, 'animetosho', { guardMs: 20 })
  await assert.rejects(stuck.handle.result, (error: unknown) => error instanceof LookupGuardTimeout)
  assert.ok(Date.now() - started < 5_000, 'the guard must not keep the process waiting')
  assert.equal(await runJob(scheduler, 'animetosho', 'next'), 'next', 'the only slot is free again')
})

test('a job that fails, times out or is cancelled always frees its slot', async () => {
  const scheduler = new LookupScheduler({ concurrency: 1, foregroundReserved: 0, minIntervalMs: 0 })
  const recorded: string[] = []
  const job = (work: () => Promise<string>, signal = new AbortController().signal, guardMs = 60_000) =>
    scheduler.schedule({
      channel: 'animetosho',
      signal,
      guardMs,
      work,
      outcome: settled => {
        recorded.push(settled.ok ? settled.value : 'error')
        // Not a transient code: three failures in a row would pause the channel.
        return settled.ok ? { kind: 'no_match' } : { kind: 'failed', code: 'invalid_response' }
      },
    }).result

  await assert.rejects(
    job(async () => {
      throw new Error('provider exploded')
    }),
    /provider exploded/,
  )
  await assert.rejects(
    job(() => {
      throw new Error('thrown before any promise')
    }),
    /thrown before any promise/,
  )
  await assert.rejects(
    job(() => new Promise<never>(() => {}), undefined, 20),
    (error: unknown) => error instanceof LookupGuardTimeout,
  )
  assert.deepEqual(recorded, ['error', 'error', 'error'], 'a failed job tells its channel')

  const running = new AbortController()
  const cancelledWhileRunning = job(() => new Promise<never>(() => {}), running.signal)
  const queued = new AbortController()
  let queuedRan = false
  const cancelledWhileQueued = job(async () => {
    queuedRan = true
    return 'queued'
  }, queued.signal)
  await nextTurn()
  queued.abort()
  await assert.rejects(cancelledWhileQueued, { name: 'AbortError' })
  running.abort()
  await assert.rejects(cancelledWhileRunning, { name: 'AbortError' })
  assert.equal(queuedRan, false, 'work cancelled in the queue never runs')
  assert.deepEqual(recorded, ['error', 'error', 'error'], 'a cancelled job tells its channel nothing')

  const abortedBeforehand = new AbortController()
  abortedBeforehand.abort()
  await assert.rejects(
    job(async () => 'never', abortedBeforehand.signal),
    { name: 'AbortError' },
  )

  assert.equal(await job(async () => 'answered'), 'answered', 'after all that the only slot is still free')
  assert.deepEqual(recorded, ['error', 'error', 'error', 'answered'])
})

test('a queued background job promoted through its handle takes the slot reserved for foreground work', async () => {
  const scheduler = new LookupScheduler({ concurrency: 2, foregroundReserved: 1, minIntervalMs: 0 })
  const first = holdJob(scheduler, 'animetosho', { background: true })
  await first.started
  const second = holdJob(scheduler, 'animetosho', { background: true })
  const third = holdJob(scheduler, 'amenzb', { background: true })
  await nextTurn()
  assert.equal(second.startedAt(), 0, 'background work leaves the reserved slot alone')
  second.handle.promote()
  await second.started
  assert.equal(third.startedAt(), 0, 'promoting one job promotes no other')
  // Promoting a job that already runs changes nothing.
  second.handle.promote()
  await second.finish()
  assert.equal(third.startedAt(), 0, 'the freed slot stays reserved while background work holds the other')
  await first.finish()
  await third.started
  await third.finish()
})

test('invalidation cancels active and queued work without leaking global permits or overwriting a fresh cache', async () => {
  const { runtime } = isolation()
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
    runtime.runtime.configChanged(settings, { ...settings, amenzb_key: 'another-key' })
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
    restore()
    await Promise.all(pending)
  }
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
  assert.equal(
    new LookupScheduler({ minIntervalMs: 0 }).interval('prowlarr:8'),
    0,
    'a channel without its own minimum follows the scheduler',
  )
})

test('a channel created on first use is paced by its own interval and leaves other channels alone', async () => {
  const scheduler = new LookupScheduler({ concurrency: 3, foregroundReserved: 1, minIntervalMs: 80 })
  const first = holdJob(scheduler, 'prowlarr:7')
  const second = holdJob(scheduler, 'prowlarr:7')
  const other = holdJob(scheduler, 'prowlarr:8')
  await Promise.all([first.started, other.started])
  assert.equal(second.startedAt(), 0, 'the second request on a channel waits for its interval')
  assert.ok(other.startedAt() - first.startedAt() < 70, 'another channel does not wait for it')
  await second.started
  const spacing = second.startedAt() - first.startedAt()
  assert.ok(spacing >= 70, `started too early: ${spacing}ms`)
  await Promise.all([first, second, other].map(job => job.finish()))

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
  const limited = holdJob(scheduler, 'prowlarr:7')
  const answering = holdJob(scheduler, 'prowlarr:7')
  await Promise.all([limited.started, answering.started])
  const foreground = holdJob(scheduler, 'prowlarr:7')
  const background = holdJob(scheduler, 'prowlarr:7', { background: true })
  const elsewhere = holdJob(scheduler, 'prowlarr:8')

  await limited.finish(RATE_LIMITED)
  const until = scheduler.pausedUntil('prowlarr:7')
  assert.ok(until > Date.now(), 'the outcome of the finished job paused its channel')
  await assert.rejects(
    foreground.handle.result,
    (error: unknown) => error instanceof ProviderPausedError && error.channel === 'prowlarr:7' && error.until === until,
  )
  await answering.finish()
  await assert.rejects(runJob(scheduler, 'prowlarr:7', 'paused'), ProviderPausedError)
  assert.match(
    scheduler.pausedFailure('prowlarr:7', until).message,
    /^Indexer Seven is rate limiting lookups; retrying in about/,
  )
  await elsewhere.started
  await elsewhere.finish()
  assert.equal(background.startedAt(), 0, 'background work does not start while its channel is paused')
  await background.started
  assert.ok(background.startedAt() >= until, 'background work starts once the pause is over')
  assert.deepEqual(scheduler.pauses(), [])
  await background.finish()
})

test('scheduler instances share no capacity: lookups that never finish on one leave every slot of the other free', async () => {
  const hashes = new LookupScheduler({ concurrency: 4, foregroundReserved: 1, minIntervalMs: 0 })
  const searches = new LookupScheduler({ concurrency: 3, foregroundReserved: 1, minIntervalMs: 0 })
  // Three background searches and a foreground one that never finish.
  const stuck = [true, true, true, false].map(background => holdJob(searches, 'prowlarr:7', { background }))
  await nextTurn()
  assert.deepEqual(
    stuck.map(job => job.startedAt() > 0),
    [true, true, false, true],
    'background work leaves the reserved slot to foreground work',
  )
  searches.recordOutcome('animetosho', RATE_LIMITED)

  const lookups = Array.from({ length: 4 }, () => holdJob(hashes, 'animetosho'))
  await Promise.all(lookups.map(job => job.started))
  assert.equal(hashes.isPaused('animetosho'), false, 'instances do not share channel health either')
  assert.equal(stuck[2].startedAt(), 0, 'the full scheduler keeps its own work queued')
  stuck[2].controller.abort()
  await assert.rejects(stuck[2].handle.result, { name: 'AbortError' })
  await Promise.all([...stuck.filter(job => job.startedAt()), ...lookups].map(job => job.finish()))
})
