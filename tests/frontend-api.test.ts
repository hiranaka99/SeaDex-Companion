import { refreshDownloads, subscribeDownloads } from '../frontend/src/download-store.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelDownloads, getAllDownloadProgress, getStatus, getConfig, invalidateDownloadProgress, getUsenetAvailabilityRevision, saveConfig, subscribeUsenetAvailability, preflightDownload, SubmissionError, submitDownload, usenetAvailability } from '../frontend/src/api.js'

test('progress probes share a request but cannot reuse a stale request after results change', async () => {
  const original = globalThis.fetch
  const replies: Array<(response: Response) => void> = []
  globalThis.fetch = (async () => new Promise<Response>(resolve => { replies.push(resolve) })) as typeof fetch
  try {
    invalidateDownloadProgress()
    const first = getAllDownloadProgress()
    assert.equal(getAllDownloadProgress(), first)
    invalidateDownloadProgress()
    const fresh = getAllDownloadProgress()
    assert.notEqual(first, fresh)
    replies[0](Response.json({ ok: true, downloads: {} }))
    await first
    assert.equal(getAllDownloadProgress(), fresh, 'Completing an old request cannot discard the new request')
    replies[1](Response.json({ ok: true, downloads: {} }))
    await fresh
  } finally { globalThis.fetch = original; invalidateDownloadProgress() }
})

test('download-store subscribers share polling and unsubscribe independently', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  let tick!: () => void, clears = 0
  globalThis.window = { setTimeout: (callback: () => void) => { tick = callback; return 1 }, clearTimeout: () => { clears += 1 } } as unknown as Window & typeof globalThis
  globalThis.fetch = (async () => Response.json({ ok: true, downloads: {} })) as typeof fetch
  let firstCalls = 0, secondCalls = 0
  const unsubscribeFirst = subscribeDownloads(() => { firstCalls += 1 })
  const unsubscribeSecond = subscribeDownloads(() => { secondCalls += 1 })
  try {
    await refreshDownloads(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1)
    unsubscribeFirst(); assert.equal(clears, 0)
    tick(); await refreshDownloads(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 2)
    unsubscribeSecond(); assert.equal(clears, 1)
  } finally {
    unsubscribeFirst(); unsubscribeSecond()
    globalThis.fetch = originalFetch; globalThis.window = originalWindow; invalidateDownloadProgress()
  }
})

test('provider-backed reviews have no aggregate timeout and honor explicit cancellation', async () => {
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout
  const timeouts: number[] = []
  AbortSignal.timeout = ms => { timeouts.push(ms); return originalTimeout(ms) }
  globalThis.fetch = (async (_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>()
    const signal = init?.signal as AbortSignal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    return promise
  }) as typeof fetch
  try {
    for (const request of [preflightDownload, usenetAvailability]) {
      const controller = new AbortController()
      const pending = request([], false, controller.signal)
      assert.deepEqual(timeouts, [], 'Provider pacing must not inherit an aggregate deadline')
      controller.abort()
      await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
    }
    globalThis.fetch = (async () => Response.json({})) as typeof fetch
    await getStatus()
    assert.deepEqual(timeouts, [30_000], 'Normal APIs retain their timeout')
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout }
})

test('submission failures preserve structured acceptance uncertainty and the HTTP status', async () => {
  const originalFetch = globalThis.fetch
  const body = { error: 'SABnzbd did not confirm acceptance', client: 'sabnzbd', acceptance_unknown: true, record_id: 'owned-unknown' }
  globalThis.fetch = (async () => Response.json(body, { status: 502 })) as typeof fetch
  try {
    await assert.rejects(submitDownload('one-shot-plan'), error => {
      assert.ok(error instanceof SubmissionError)
      assert.equal(error.status, 502)
      assert.deepEqual(error.detail, body)
      assert.equal(error.message, body.error)
      return true
    })
  } finally { globalThis.fetch = originalFetch }
})

test('bulk cancellation sends the exact reviewed records even when all were checked', async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = (async (_input, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, removed: [], failures: [] }) }) as typeof fetch
  try {
    await cancelDownloads(['reviewed-a', 'reviewed-b'], false)
    assert.deepEqual(body, { record_ids: ['reviewed-a', 'reviewed-b'], remove_files: false })
  } finally { globalThis.fetch = originalFetch }
})

test('whole-library preflight sends every selected row in one plan', async () => {
  const originalFetch = globalThis.fetch
  const selections = Array.from({ length: 201 }, (_, release) => ({ key: `show-${release}`, release: 0, identity: `identity-${release}`, protocol: 'torrent' as const }))
  const bodies: unknown[] = []
  globalThis.fetch = (async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }) }) as typeof fetch
  try {
    await preflightDownload(selections)
    assert.deepEqual(bodies, [{ selections }])
  } finally { globalThis.fetch = originalFetch }
})

test('availability reads preserve provider timestamps and only manual refresh requests force work', async () => {
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []
  const checkedAt = '2026-11-18T10:00:00.000Z'
  const identity = 'cached-release'
  const cached = { key: 'show', release: 0, identity, aggregate: 'available', checked_at: checkedAt, stale: true, refreshing: true, hashes: [{ hash: 'a'.repeat(40), state: 'available', checked_at: checkedAt, stale: true, refreshing: true }] }
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true, config_generation: 7, sabnzbd_configured: true, providers_enabled: { animetosho: true, amenzb: false }, results: [cached, { key: 'missing', release: 0, identity: 'unknown-release', aggregate: 'not_checked', checked_at: '', stale: false, refreshing: true, hashes: [{ hash: 'b'.repeat(40), state: 'not_checked', refreshing: true }] }] })
  }) as typeof fetch
  try {
    const selections = [{ key: 'show', release: 0, identity }, { key: 'missing', release: 0, identity: 'unknown-release' }]
    const first = await usenetAvailability(selections)
    assert.equal(first.results[0].checked_at, checkedAt)
    assert.equal(first.results[0].stale, true)
    assert.equal(first.results[1].aggregate, 'not_checked')
    assert.equal(first.results[1].checked_at, '')
    await usenetAvailability(selections, true)
    const poll = await usenetAvailability(selections)
    assert.equal(poll.results[0].checked_at, checkedAt, 'Reading a snapshot never invents a new provider check')
    assert.deepEqual(requests, [{ selections }, { selections, refresh: true }, { selections }])
  } finally { globalThis.fetch = originalFetch }
})

test('successful configuration saves invalidate availability even when a secret stays configured', async () => {
  const originalFetch = globalThis.fetch
  const before = getUsenetAvailabilityRevision()
  let notifications = 0
  const unsubscribe = subscribeUsenetAvailability(() => { notifications += 1 })
  globalThis.fetch = (async () => Response.json({ amenzb_key_configured: true })) as typeof fetch
  try {
    await saveConfig({ amenzb_key: 'replacement-fixture-key' })
    assert.equal(getUsenetAvailabilityRevision(), before + 1)
    assert.equal(notifications, 1)
    await saveConfig({ datetime_format: 'YYYY-MM-DD HH:mm:ss' })
    assert.equal(getUsenetAvailabilityRevision(), before + 1, 'Unrelated settings preserve compatible availability')
    globalThis.fetch = (async () => Response.json({ error: 'Fixture save failed' }, { status: 503 })) as typeof fetch
    await assert.rejects(saveConfig({ amenzb_key: 'another-fixture-key' }))
    assert.equal(getUsenetAvailabilityRevision(), before + 1, 'Failed saves leave the active scope unchanged')
  } finally { unsubscribe(); globalThis.fetch = originalFetch }
})

test('provider URL changes rebind availability while repeated config reads preserve its scope', async () => {
  const originalFetch = globalThis.fetch
  let url = 'https://fixture-provider.invalid'
  globalThis.fetch = (async () => Response.json({ animetosho_enabled: true, animetosho_url: url, amenzb_key_configured: true })) as typeof fetch
  try {
    await getConfig()
    const before = getUsenetAvailabilityRevision()
    await getConfig()
    assert.equal(getUsenetAvailabilityRevision(), before)
    url = 'https://replacement-provider.invalid'
    await saveConfig({ animetosho_url: url })
    assert.equal(getUsenetAvailabilityRevision(), before + 1)
  } finally { globalThis.fetch = originalFetch }
})
