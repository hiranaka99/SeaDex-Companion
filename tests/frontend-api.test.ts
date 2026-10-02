import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAllDownloadProgress, getBulkDownloadPreflight, invalidateDownloadProgress, watchDownloadProgress } from '../frontend/src/api.js'

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

test('multiple progress subscribers for the same release remain independent', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let tick!: () => void
  let clears = 0
  globalThis.window = { setInterval: (callback: () => void) => { tick = callback; return 1 }, clearInterval: () => { clears += 1 } } as unknown as Window & typeof globalThis
  globalThis.fetch = (async () => Response.json({ ok: true, downloads: {} })) as typeof fetch
  let firstCalls = 0, secondCalls = 0
  const unsubscribeFirst = watchDownloadProgress('shared-release', () => { firstCalls += 1 })
  const unsubscribeSecond = watchDownloadProgress('shared-release', () => { secondCalls += 1 })
  try {
    tick(); await getAllDownloadProgress(); await Promise.resolve()
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1)
    unsubscribeFirst()
    assert.equal(clears, 0)
    tick(); await getAllDownloadProgress(); await Promise.resolve()
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 2)
    unsubscribeSecond()
    assert.equal(clears, 1)
  } finally {
    unsubscribeFirst(); unsubscribeSecond()
    globalThis.fetch = originalFetch; globalThis.window = originalWindow; invalidateDownloadProgress()
  }
})

test('preflight requests retain their timeout when supplied with a cancellation signal', async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  // Use a short deadline to exercise the same request wrapper without waiting 30s.
  AbortSignal.timeout = () => originalTimeout(10)
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal
    const guard = setTimeout(() => reject(new Error('Request did not time out')), 250)
    signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason) }, { once: true })
  })) as typeof fetch
  try { await assert.rejects(getBulkDownloadPreflight([], new AbortController().signal), error => error instanceof DOMException && error.name === 'TimeoutError') }
  finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout }
})
