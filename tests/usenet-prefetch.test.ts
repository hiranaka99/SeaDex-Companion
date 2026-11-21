import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../server/config.js'
import { bumpGeneration } from '../server/config-generation.js'
import { enableUsenetPrefetch, prefetchUsenetAvailability, stopUsenetPrefetch } from '../server/usenet-prefetch.js'
import { invalidateUsenetLookups, resolveUsenetHash, setUsenetProviderMinIntervalMs } from '../server/usenet.js'
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
  invalidateUsenetLookups()
  setUsenetProviderMinIntervalMs('animetosho', intervalMs)
  bumpGeneration()
  return () => invalidateUsenetLookups()
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
