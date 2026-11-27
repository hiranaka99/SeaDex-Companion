import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { prefetchPlan, usenetPrefetchProgress } from '../server/usenet-prefetch.js'
import { resolveUsenetHash, usenetProviderPauses } from '../server/usenet.js'
import { usenetAvailability } from '../server/usenet-copies.js'
import { retryAfterMs } from '../server/provider-http.js'
import type { Release, ResultItem } from '../server/types.js'
import type { LookupPacing } from '../server/usenet-scheduler.js'
import { sweepResults, testUsenetRuntime, type TestUsenetRuntime } from './support/usenet-runtime.js'

const hexHash = (index: number) => index.toString(16).padStart(40, '0')

function config() {
  return {
    ...DEFAULT_CONFIG,
    animetosho_enabled: true,
    amenzb_enabled: false,
    sabnzbd_url: 'http://sab.test:8080/',
    sabnzbd_key: 'sab-key',
    download_mode: 'choose' as const,
  }
}

let hashCounter = 0
function result(key: string, releases: number): ResultItem {
  return {
    key,
    releases: Array.from(
      { length: releases },
      () =>
        ({
          kind: 'best',
          releaseGroup: 'Group',
          tracker: 'Nyaa',
          torrent_available: true,
          info_hashes: [hexHash(hashCounter++)],
          size: 100,
        }) as Release,
    ),
  } as unknown as ResultItem
}

interface Probe {
  starts: string[]
  fetches: number
}

const unexpected: typeof fetch = async input => {
  throw new Error(`unexpected provider request: ${String(input)}`)
}
/** How the runtime in use reaches the hash indexers. */
let send: typeof fetch = unexpected

function stubFetch(probe: Probe) {
  send = async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://feed.animetosho.net/json')) {
      probe.fetches++
      probe.starts.push(url.match(/hash=([0-9a-f]+)/)?.[1] ?? '?')
      return new Response('nope', { status: 404 })
    }
    throw new Error(`unexpected provider request: ${url}`)
  }
  return () => {
    send = unexpected
  }
}

/** A fresh runtime with this hash-indexer pacing that asks through `send`; sweeps run only when asked for. */
function isolation(
  t: TestContext,
  intervalMs: number,
  options: { pacing?: Partial<LookupPacing>; sweep?: boolean } = {},
): TestUsenetRuntime {
  const usenet = testUsenetRuntime(t, {
    fetch: (input, init) => send(input, init),
    pacing: { hashes: { minIntervalMs: intervalMs, ...options.pacing } },
    sweep: options.sweep,
  })
  t.after(() => {
    send = unexpected
  })
  bumpGeneration()
  return usenet
}

function controlledFetch() {
  const probe = {
    starts: [] as string[],
    pending: new Map<string, (response: Response) => void>(),
    active: 0,
    maximum: 0,
  }
  send = (input: RequestInfo | URL) => {
    const url = String(input)
    assert.ok(url.startsWith('https://feed.animetosho.net/json'), `unexpected provider request: ${url}`)
    const hash = new URL(url).searchParams.get('hash')!
    const { promise, resolve } = Promise.withResolvers<Response>()
    probe.starts.push(hash)
    probe.pending.set(hash, resolve)
    probe.active++
    probe.maximum = Math.max(probe.maximum, probe.active)
    return promise.finally(() => {
      probe.pending.delete(hash)
      probe.active--
    })
  }
  return {
    probe,
    complete(hash: string) {
      const resolve = probe.pending.get(hash)
      assert.ok(resolve, `request ${hash} has not started`)
      resolve(new Response('nope', { status: 404 }))
    },
    restore() {
      send = unexpected
    },
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('ineligible configurations never trigger a prefetch sweep', async t => {
  isolation(t, 0)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    // prefetch is not enabled yet in this process, and this config is torrent_only
    sweepResults({ ...config(), download_mode: 'torrent_only' }, [result('a', 1)], 'test')
    await assert.rejects(
      until(() => probe.fetches > 0, 200),
      /timed out/,
    )
    assert.equal(probe.fetches, 0)
  } finally {
    restore()
  }
})

test('provider requests are spaced by the configured minimum interval', async t => {
  // The pacer schedules real setTimeout dispatches with no fake-time seam;
  // this integration test deliberately exercises real-time pacing.
  isolation(t, 80)
  const marks: number[] = []
  send = async () => {
    marks.push(Date.now())
    return new Response('nope', { status: 404 })
  }
  await Promise.all([hexHash(1), hexHash(2), hexHash(3)].map(hash => resolveUsenetHash(config(), hash)))
  assert.equal(marks.length, 3)
  assert.ok(marks[1] - marks[0] >= 70, `second request started too early: ${marks[1] - marks[0]}ms`)
  assert.ok(marks[2] - marks[1] >= 70, `third request started too early: ${marks[2] - marks[1]}ms`)
})

test('interactive lookups overtake queued background lookups', async t => {
  isolation(t, 120)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    const backgroundFirst = resolveUsenetHash(config(), hexHash(1), false, true)
    await until(() => probe.fetches === 1)
    const backgroundSecond = resolveUsenetHash(config(), hexHash(2), false, true)
    const interactive = resolveUsenetHash(config(), hexHash(3), false, false)
    await Promise.all([backgroundFirst, backgroundSecond, interactive])
    assert.deepEqual(probe.starts, [hexHash(1), hexHash(3), hexHash(2)])
  } finally {
    restore()
  }
})

/** Complete every started request until all work settles. */
async function drain(
  work: Promise<unknown>[],
  probe: { pending: Map<string, unknown> },
  complete: (hash: string) => void,
): Promise<void> {
  let settled = false
  const all = Promise.all(work).finally(() => {
    settled = true
  })
  for (let round = 0; !settled && round < 100; round++) {
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
  }
  await all
}

test('background work leaves a slot for foreground lookups, which also take freed slots first', async t => {
  const usenet = isolation(t, 0)
  const { probe, complete, restore } = controlledFetch()
  const work = Array.from({ length: 4 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 1), false, true))
  try {
    await nextTurn()
    assert.deepEqual(probe.starts, [1, 2, 3].map(hexHash), 'background work stops one slot short of the limit')
    work.push(resolveUsenetHash(config(), hexHash(7)))
    await nextTurn()
    assert.equal(probe.starts[3], hexHash(7), 'an interactive lookup starts at once in the reserved slot')
    assert.equal(probe.active, 4)
    work.push(resolveUsenetHash(config(), hexHash(5), false, true))
    work.push(resolveUsenetHash(config(), hexHash(8)))
    await nextTurn()
    assert.equal(probe.starts.length, 4)
    complete(hexHash(1))
    await nextTurn()
    assert.equal(probe.starts[4], hexHash(8), 'a freed slot goes to queued foreground work first')
    complete(hexHash(7))
    complete(hexHash(8))
    await nextTurn()
    assert.equal(probe.starts[5], hexHash(4), 'background work resumes in queue order')
    await drain(work, probe, complete)
    assert.equal(probe.maximum, 4)
    assert.equal(probe.active, 0)
  } finally {
    for (const hash of [...probe.pending.keys()]) complete(hash)
    usenet.close()
    await Promise.all(work)
    restore()
  }
})

test('background work held back by the reserved slot waits without spinning timers', async t => {
  const usenet = isolation(t, 0)
  const { probe, complete, restore } = controlledFetch()
  const work = Array.from({ length: 4 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 1), false, true))
  const originalSetTimeout = globalThis.setTimeout
  let timers = 0
  try {
    await nextTurn()
    assert.equal(probe.starts.length, 3)
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers++
      return originalSetTimeout(...args)
    }) as typeof setTimeout
    await new Promise(resolve => originalSetTimeout(resolve, 50))
    globalThis.setTimeout = originalSetTimeout
    assert.equal(timers, 0, `queued background work scheduled ${timers} timers while blocked`)
    complete(hexHash(1))
    await nextTurn()
    assert.equal(probe.starts[3], hexHash(4), 'a released slot still admits the queued background lookup')
    await drain(work, probe, complete)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    for (const hash of [...probe.pending.keys()]) complete(hash)
    usenet.close()
    await Promise.all(work)
    restore()
  }
})

test('foreground callers promote a shared queued background lookup before global admission', async t => {
  const usenet = isolation(t, 0)
  const { probe, complete, restore } = controlledFetch()
  const work = Array.from({ length: 4 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 1), false, true))
  try {
    await nextTurn()
    work.push(resolveUsenetHash(config(), hexHash(5), false, true))
    work.push(resolveUsenetHash(config(), hexHash(6), false, true))
    work.push(resolveUsenetHash(config(), hexHash(6)))
    await nextTurn()
    assert.equal(probe.starts[3], hexHash(6))
    await drain(work, probe, complete)
    assert.equal(probe.starts.filter(hash => hash === hexHash(6)).length, 1)
    assert.equal(probe.maximum, 4)
  } finally {
    for (const hash of [...probe.pending.keys()]) complete(hash)
    usenet.close()
    await Promise.all(work)
    restore()
  }
})

test('a rate-limited provider pauses: interactive lookups fail fast and background lookups wait and retry', async t => {
  isolation(t, 0, { pacing: { pauseBaseMs: 300 } })
  let rateLimited = true
  const starts: string[] = []
  send = async (input: RequestInfo | URL) => {
    const hash = new URL(String(input)).searchParams.get('hash')!
    starts.push(hash)
    return rateLimited ? new Response('slow down', { status: 429 }) : new Response('nope', { status: 404 })
  }
  const background = resolveUsenetHash(config(), hexHash(1), false, true)
  await until(() => usenetProviderPauses().length === 1)
  const [pause] = usenetProviderPauses()
  assert.equal(pause.channel, 'animetosho')
  assert.equal(pause.label, 'AnimeTosho')
  assert.equal(pause.reason, 'rate_limited')
  const interactive = await resolveUsenetHash(config(), hexHash(2))
  assert.equal(interactive.state, 'lookup_failed')
  assert.equal(interactive.error_code, 'rate_limited')
  assert.match(interactive.error || '', /AnimeTosho is rate limiting lookups; retrying in about/)
  assert.deepEqual(starts, [hexHash(1)], 'no request starts while the provider is paused')
  rateLimited = false
  const retried = await background
  assert.equal(retried.state, 'no_match', 'the background lookup retried after the pause instead of failing')
  assert.deepEqual(starts, [hexHash(1), hexHash(1)])
  assert.deepEqual(usenetProviderPauses(), [])
})

test('a running sweep reports the provider it waits on by its label', async t => {
  const usenet = isolation(t, 0, { pacing: { pauseBaseMs: 300 }, sweep: true })
  let rateLimited = true
  send = async () => (rateLimited ? new Response('slow down', { status: 429 }) : new Response('nope', { status: 404 }))
  try {
    sweepResults(config(), [result('paused-sweep', 1)], 'test')
    await until(() => Boolean(usenetPrefetchProgress().paused))
    assert.deepEqual(usenetPrefetchProgress().paused, [
      { provider: { id: 'animetosho', label: 'AnimeTosho' }, resume_in_seconds: 1, rate_limited: true },
    ])
    rateLimited = false
    await until(() => !usenetPrefetchProgress().running)
  } finally {
    usenet.close()
  }
})

test('Retry-After extends a provider pause and is bounded', () => {
  const now = 1_800_000_000_000
  const header = (value: string) => new Response('', { status: 429, headers: { 'retry-after': value } })
  assert.equal(retryAfterMs(header('120'), now), 120_000)
  assert.equal(retryAfterMs(header(new Date(now + 90_000).toUTCString()), now), 90_000)
  assert.equal(retryAfterMs(header('999999'), now), 60 * 60_000)
  assert.equal(retryAfterMs(header('soon'), now), undefined)
  assert.equal(retryAfterMs(new Response('', { status: 429 }), now), undefined)
})

test('the sweep checks likely downloads first and skips excluded seasons and parts', () => {
  const release = (hash: number, extra: Partial<Release> = {}) =>
    ({
      kind: 'best',
      releaseGroup: 'Group',
      tracker: 'Nyaa',
      torrent_available: true,
      info_hashes: [hexHash(hash)],
      size: 1,
      ...extra,
    }) as Release
  const results = [
    { key: 'owned', status: 'best', library_key: 'Sonarr:item1', season: 1, releases: [release(1)] },
    {
      key: 'upgrade',
      status: 'upgrade',
      library_key: 'Sonarr:item2',
      season: 1,
      releases: [release(2, { kind: 'alt' }), release(3)],
    },
    { key: 'missing', status: 'missing', library_key: 'Sonarr:item3', season: 1, releases: [release(4)] },
    { key: 'excluded', status: 'missing', library_key: 'Sonarr:item4', season: 2, releases: [release(5)] },
    {
      key: 'parts',
      status: 'partial',
      library_key: 'Sonarr:item5',
      season: 1,
      releases: [release(6, { part: 'Part 1' }), release(7, { part: 'Part 2' })],
    },
  ] as unknown as ResultItem[]
  const plan = prefetchPlan(results, new Set(['Sonarr:item4:2:*', 'Sonarr:item5:1:Part 2']))
  assert.deepEqual(
    plan.map(entry => entry.key),
    ['missing', 'parts', 'upgrade', 'owned'],
  )
  assert.deepEqual(
    plan.find(entry => entry.key === 'upgrade')!.releases.map(entry => entry.info_hashes[0]),
    [hexHash(3), hexHash(2)],
    'best releases precede alternatives',
  )
  assert.deepEqual(
    plan.find(entry => entry.key === 'parts')!.releases.map(entry => entry.part),
    ['Part 1'],
  )
})

test('a sweep prunes cached observations for hashes no longer in the results', async t => {
  isolation(t, 0, { sweep: true })
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    await resolveUsenetHash(config(), hexHash(900))
    await resolveUsenetHash(config(), hexHash(901))
    assert.equal(probe.fetches, 2)
    const kept = {
      key: 'kept',
      releases: [
        {
          kind: 'best',
          releaseGroup: 'Group',
          tracker: 'Nyaa',
          torrent_available: true,
          info_hashes: [hexHash(900)],
          size: 1,
        },
      ],
    } as unknown as ResultItem
    sweepResults({ ...config(), download_mode: 'torrent_only' }, [kept], 'prune test')
    await resolveUsenetHash(config(), hexHash(900))
    assert.equal(probe.fetches, 2, 'the referenced hash stays cached')
    await resolveUsenetHash(config(), hexHash(901))
    assert.equal(probe.fetches, 3, 'the dropped hash is looked up again')
  } finally {
    restore()
  }
})

test('many concurrent lookups never wedge the shared slot limiter', async t => {
  // Regression: handing a released slot to a waiter used to also increment the
  // active count, so a batch larger than the cap leaked slots permanently and
  // every later lookup queued behind a full semaphore forever.
  isolation(t, 0)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 100))))
    assert.equal(probe.fetches, 12)
    await resolveUsenetHash(config(), hexHash(112))
    assert.equal(probe.fetches, 13)
  } finally {
    restore()
  }
})

test('the prefetch sweep checks every release of the saved results in the background', async t => {
  isolation(t, 10, { sweep: true })
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    sweepResults(config(), [result('a', 2), result('b', 2)], 'test')
    await until(() => probe.fetches === 4)
    assert.equal(probe.fetches, 4)
  } finally {
    restore()
  }
})

test('cleared results cancel a running sweep mid-flight', async t => {
  const usenet = isolation(t, 30, { sweep: true })
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    sweepResults(
      config(),
      Array.from({ length: 10 }, (_, index) => result(`show-${index}`, 1)),
      'test',
    )
    await until(() => probe.fetches >= 2)
    usenet.runtime.resultsChanged(config(), [], [], 'results cleared')
    const observed = probe.fetches
    // In-flight completion of the current release is tolerated; the sweep must not continue.
    await assert.rejects(
      until(() => probe.fetches > observed + 1, 300),
      /timed out/,
    )
  } finally {
    restore()
  }
})

test('an older sweep completion cannot finish or overwrite a newer sweep', async t => {
  const usenet = isolation(t, 0, { sweep: true })
  const { probe, complete, restore } = controlledFetch()
  const oldResults = [result('old-first', 1), result('old-later', 1)]
  const newerResults = [result('new-first', 1), result('new-later', 2)]
  const oldHash = oldResults[0].releases[0].info_hashes[0]
  const newHash = newerResults[0].releases[0].info_hashes[0]
  try {
    sweepResults(config(), oldResults, 'old')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    sweepResults(config(), newerResults, 'new')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 3 })
    complete(oldHash)
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 3 })
    assert.equal(probe.starts.includes(oldResults[1].releases[0].info_hashes[0]), false)
    complete(newHash)
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 1, total: 3 })
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
  } finally {
    usenet.close()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    restore()
  }
})

test('cleared results clear current progress immediately and stale work cannot resurrect it', async t => {
  const usenet = isolation(t, 0, { sweep: true })
  const { probe, complete, restore } = controlledFetch()
  const results = [result('first', 1), result('later', 1)]
  try {
    sweepResults(config(), results, 'test')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    usenet.runtime.resultsChanged(config(), [], [], 'results cleared')
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    complete(results[0].releases[0].info_hashes[0])
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    assert.equal(probe.starts.length, 1)
  } finally {
    usenet.close()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    restore()
  }
})

test('empty and ineligible sweeps supersede old work without retaining progress', async t => {
  const usenet = isolation(t, 0, { sweep: true })
  const { probe, complete, restore } = controlledFetch()
  try {
    for (const ineligible of [false, true]) {
      const results = [result(`first-${ineligible}`, 1), result(`later-${ineligible}`, 1)]
      sweepResults(config(), results, 'active')
      await nextTurn()
      sweepResults(ineligible ? { ...config(), download_mode: 'torrent_only' } : config(), [], 'replacement')
      assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
      complete(results[0].releases[0].info_hashes[0])
      await nextTurn()
      assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
      assert.equal(probe.starts.includes(results[1].releases[0].info_hashes[0]), false)
    }
  } finally {
    usenet.close()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    restore()
  }
})

test('an unrelated configuration generation change does not interrupt the sweep', async t => {
  const usenet = isolation(t, 0, { sweep: true })
  const { probe, complete, restore } = controlledFetch()
  const results = [result('first', 1), result('later', 1)]
  try {
    sweepResults(config(), results, 'test')
    await nextTurn()
    bumpGeneration()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    complete(results[0].releases[0].info_hashes[0])
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 1, total: 2 })
    assert.equal(probe.starts.length, 2)
  } finally {
    usenet.close()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    restore()
  }
})

test('public snapshots cannot count scheduled prefetch work as completed or duplicate its provider requests', async t => {
  const usenet = isolation(t, 0, { sweep: true })
  const { probe, complete, restore } = controlledFetch()
  const results = [result('snapshot-prefetch', 2)]
  try {
    sweepResults(config(), results, 'snapshot test')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    const rows = await usenetAvailability(
      config(),
      [
        { key: results[0].key, release: 0 },
        { key: results[0].key, release: 1 },
      ],
      results,
    )
    assert.ok(rows.every(row => row.aggregate === 'not_checked' && row.refreshing))
    await nextTurn()
    assert.equal(probe.starts.length, 2)
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
  } finally {
    usenet.close()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    restore()
  }
})
