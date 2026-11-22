import { refreshDownloads, subscribeDownloads } from '../frontend/src/download-store.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelDownloads, getAllDownloadProgress, getStatus, invalidateDownloadProgress, preflightDownload, SubmissionError, submitDownload, usenetAvailability } from '../frontend/src/api.js'

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
