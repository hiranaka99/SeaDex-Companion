import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { enableUsenetPrefetch, prefetchUsenetAvailability, stopUsenetPrefetch, usenetPrefetchProgress } from '../server/usenet-prefetch.js'
import { resetUsenetLookups, resolveUsenetHash, setUsenetProviderMinIntervalMs, usenetAvailability } from '../server/usenet.js'
import type { Release, ResultItem } from '../server/types.js'

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
  return { key, releases: Array.from({ length: releases }, () => ({ kind: 'best', releaseGroup: 'Group', tracker: 'Nyaa', torrent_available: true, info_hashes: [hexHash(hashCounter++)], size: 100 } as Release)) } as unknown as ResultItem
}

interface Probe { starts: string[]; fetches: number }

function stubFetch(probe: Probe) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://feed.animetosho.net/json')) {
      probe.fetches++
      probe.starts.push(url.match(/hash=([0-9a-f]+)/)?.[1] ?? '?')
      return new Response('nope', { status: 404 })
    }
    throw new Error(`unexpected provider request: ${url}`)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function isolation(intervalMs: number): () => void {
  resetUsenetLookups()
  setUsenetProviderMinIntervalMs('animetosho', intervalMs)
  bumpGeneration()
  return () => resetUsenetLookups()
}

function controlledFetch() {
  const original = globalThis.fetch
  const probe = {
    starts: [] as string[],
    pending: new Map<string, (response: Response) => void>(),
    active: 0,
    maximum: 0,
  }
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    assert.ok(url.startsWith('https://feed.animetosho.net/json'), `unexpected provider request: ${url}`)
    const hash = new URL(url).searchParams.get('hash')!
    const { promise, resolve } = Promise.withResolvers<Response>()
    probe.starts.push(hash)
    probe.pending.set(hash, resolve)
    probe.active++
    probe.maximum = Math.max(probe.maximum, probe.active)
    return promise.finally(() => { probe.pending.delete(hash); probe.active-- })
  }) as typeof fetch
  return {
    probe,
    complete(hash: string) {
      const resolve = probe.pending.get(hash)
      assert.ok(resolve, `request ${hash} has not started`)
      resolve(new Response('nope', { status: 404 }))
    },
    restore() { globalThis.fetch = original },
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('ineligible configurations never trigger a prefetch sweep', async () => {
  isolation(0)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    // prefetch is not enabled yet in this process, and this config is torrent_only
    prefetchUsenetAvailability({ ...config(), download_mode: 'torrent_only' }, [result('a', 1)], 'test')
    await assert.rejects(until(() => probe.fetches > 0, 200), /timed out/)
    assert.equal(probe.fetches, 0)
  } finally { restore() }
})

test('provider requests are spaced by the configured minimum interval', async () => {
  // The pacer schedules real setTimeout dispatches with no fake-time seam;
  // this integration test deliberately exercises real-time pacing.
  isolation(80)
  const marks: number[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    void input
    marks.push(Date.now())
    return new Response('nope', { status: 404 })
  }) as typeof fetch
  try {
    await Promise.all([hexHash(1), hexHash(2), hexHash(3)].map(hash => resolveUsenetHash(config(), hash)))
    assert.equal(marks.length, 3)
    assert.ok(marks[1] - marks[0] >= 70, `second request started too early: ${marks[1] - marks[0]}ms`)
    assert.ok(marks[2] - marks[1] >= 70, `third request started too early: ${marks[2] - marks[1]}ms`)
  } finally { globalThis.fetch = original }
})

test('interactive lookups overtake queued background lookups', async () => {
  isolation(120)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    const backgroundFirst = resolveUsenetHash(config(), hexHash(1), false, true)
    await until(() => probe.fetches === 1)
    const backgroundSecond = resolveUsenetHash(config(), hexHash(2), false, true)
    const interactive = resolveUsenetHash(config(), hexHash(3), false, false)
    await Promise.all([backgroundFirst, backgroundSecond, interactive])
    assert.deepEqual(probe.starts, [hexHash(1), hexHash(3), hexHash(2)])
  } finally { restore() }
})

test('foreground work takes the next saturated global slot ahead of queued background work', async () => {
  isolation(0)
  const { probe, complete, restore } = controlledFetch()
  const active = Array.from({ length: 4 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 1), false, true))
  const work = [...active]
  try {
    await nextTurn()
    assert.deepEqual(probe.starts, [1, 2, 3, 4].map(hexHash))
    work.push(resolveUsenetHash(config(), hexHash(5), false, true))
    work.push(resolveUsenetHash(config(), hexHash(6), false, true))
    work.push(resolveUsenetHash(config(), hexHash(7)))
    await nextTurn()
    assert.equal(probe.starts.length, 4)
    complete(hexHash(1))
    await nextTurn()
    assert.equal(probe.starts[4], hexHash(7))
    assert.equal(probe.active, 4)
    complete(hexHash(7))
    await nextTurn()
    assert.equal(probe.starts[5], hexHash(5))
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await Promise.all(work)
    assert.equal(probe.maximum, 4)
    assert.equal(probe.active, 0)
  } finally {
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await Promise.all(work)
    restore()
  }
})

test('foreground callers promote a shared queued background lookup before global admission', async () => {
  isolation(0)
  const { probe, complete, restore } = controlledFetch()
  const work = Array.from({ length: 4 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 1), false, true))
  try {
    await nextTurn()
    work.push(resolveUsenetHash(config(), hexHash(5), false, true))
    work.push(resolveUsenetHash(config(), hexHash(6), false, true))
    work.push(resolveUsenetHash(config(), hexHash(6)))
    complete(hexHash(1))
    await nextTurn()
    assert.equal(probe.starts[4], hexHash(6))
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await Promise.all(work)
    assert.equal(probe.starts.filter(hash => hash === hexHash(6)).length, 1)
    assert.equal(probe.maximum, 4)
  } finally {
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await Promise.all(work)
    restore()
  }
})

test('many concurrent lookups never wedge the shared slot limiter', async () => {
  // Regression: handing a released slot to a waiter used to also increment the
  // active count, so a batch larger than the cap leaked slots permanently and
  // every later lookup queued behind a full semaphore forever.
  isolation(0)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => resolveUsenetHash(config(), hexHash(index + 100))))
    assert.equal(probe.fetches, 12)
    await resolveUsenetHash(config(), hexHash(112))
    assert.equal(probe.fetches, 13)
  } finally { restore() }
})

test('the prefetch sweep checks every release of the saved results in the background', async () => {
  isolation(10)
  enableUsenetPrefetch()
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    prefetchUsenetAvailability(config(), [result('a', 2), result('b', 2)], 'test')
    await until(() => probe.fetches === 4)
    assert.equal(probe.fetches, 4)
  } finally { restore() }
})

test('stopUsenetPrefetch cancels a running sweep mid-flight', async () => {
  isolation(30)
  const probe: Probe = { starts: [], fetches: 0 }
  const restore = stubFetch(probe)
  try {
    prefetchUsenetAvailability(config(), Array.from({ length: 10 }, (_, index) => result(`show-${index}`, 1)), 'test')
    await until(() => probe.fetches >= 2)
    stopUsenetPrefetch()
    const observed = probe.fetches
    // In-flight completion of the current release is tolerated; the sweep must not continue.
    await assert.rejects(until(() => probe.fetches > observed + 1, 300), /timed out/)
  } finally { restore() }
})

test('an older sweep completion cannot finish or overwrite a newer sweep', async () => {
  isolation(0)
  enableUsenetPrefetch()
  const { probe, complete, restore } = controlledFetch()
  const oldResults = [result('old-first', 1), result('old-later', 1)]
  const newerResults = [result('new-first', 1), result('new-later', 2)]
  const oldHash = oldResults[0].releases[0].info_hashes[0]
  const newHash = newerResults[0].releases[0].info_hashes[0]
  try {
    prefetchUsenetAvailability(config(), oldResults, 'old')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    prefetchUsenetAvailability(config(), newerResults, 'new')
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
    stopUsenetPrefetch()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await nextTurn()
    restore()
  }
})

test('stop clears current progress immediately and stale work cannot resurrect it', async () => {
  isolation(0)
  enableUsenetPrefetch()
  const { probe, complete, restore } = controlledFetch()
  const results = [result('first', 1), result('later', 1)]
  try {
    prefetchUsenetAvailability(config(), results, 'test')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    stopUsenetPrefetch()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    complete(results[0].releases[0].info_hashes[0])
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    assert.equal(probe.starts.length, 1)
  } finally {
    stopUsenetPrefetch()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await nextTurn()
    restore()
  }
})

test('empty and ineligible sweeps supersede old work without retaining progress', async () => {
  isolation(0)
  enableUsenetPrefetch()
  const { probe, complete, restore } = controlledFetch()
  try {
    for (const ineligible of [false, true]) {
      const results = [result(`first-${ineligible}`, 1), result(`later-${ineligible}`, 1)]
      prefetchUsenetAvailability(config(), results, 'active')
      await nextTurn()
      prefetchUsenetAvailability(ineligible ? { ...config(), download_mode: 'torrent_only' } : config(), [], 'replacement')
      assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
      complete(results[0].releases[0].info_hashes[0])
      await nextTurn()
      assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
      assert.equal(probe.starts.includes(results[1].releases[0].info_hashes[0]), false)
    }
  } finally {
    stopUsenetPrefetch()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await nextTurn()
    restore()
  }
})

test('a generation change hides stale sweep progress and completion cannot update it', async () => {
  isolation(0)
  enableUsenetPrefetch()
  const { probe, complete, restore } = controlledFetch()
  const results = [result('first', 1), result('later', 1)]
  try {
    prefetchUsenetAvailability(config(), results, 'test')
    await nextTurn()
    bumpGeneration()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    complete(results[0].releases[0].info_hashes[0])
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    assert.equal(probe.starts.length, 1)
  } finally {
    stopUsenetPrefetch()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await nextTurn()
    restore()
  }
})

test('public snapshots cannot count scheduled prefetch work as completed or duplicate its provider requests', async () => {
  isolation(0)
  enableUsenetPrefetch()
  const { probe, complete, restore } = controlledFetch()
  const results = [result('snapshot-prefetch', 2)]
  try {
    prefetchUsenetAvailability(config(), results, 'snapshot test')
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    const rows = await usenetAvailability(config(), [{ key: results[0].key, release: 0 }, { key: results[0].key, release: 1 }], false, results)
    assert.ok(rows.every(row => row.aggregate === 'not_checked' && row.refreshing))
    await nextTurn()
    assert.equal(probe.starts.length, 2)
    assert.deepEqual(usenetPrefetchProgress(), { running: true, checked: 0, total: 2 })
    for (const hash of [...probe.pending.keys()]) complete(hash)
    await nextTurn()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
  } finally {
    stopUsenetPrefetch()
    for (const hash of [...probe.pending.keys()]) complete(hash)
    resetUsenetLookups()
    await nextTurn()
    restore()
  }
})
