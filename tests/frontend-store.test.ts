import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForDownloadJob } from '../frontend/src/bulk-job-store.js'
import { getDownloadSnapshot, refreshDownloads, sendDownload, subscribeDownloads } from '../frontend/src/download-store.js'
import { invalidateDownloadProgress, type BulkDownloadStatus } from '../frontend/src/api.js'

test('one job observer retries connectivity failures and follows the accepted ID', async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch
  const timers: (() => void)[] = []
  globalThis.window = { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length }, clearTimeout: () => {} } as unknown as Window & typeof globalThis
  const accepted: BulkDownloadStatus = { id: 'accepted-job', existing: [], targets: [], ok: true, finished: false, pending: ['a'.repeat(40)], added: [], failures: [] }
  const finished = { ...accepted, finished: true, pending: [], added: accepted.pending }
  const paths: string[] = []
  let attempts = 0
  globalThis.fetch = (async input => {
    paths.push(String(input))
    if (++attempts === 1) throw new Error('Temporary connection failure')
    return Response.json(finished)
  }) as typeof fetch
  try {
    const updates: boolean[] = []
    const result = waitForDownloadJob(accepted, job => updates.push(job.finished))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(updates, [false], 'A lost status request must not mark the job failed')
    assert.equal(timers.length, 1)
    timers.shift()!()
    assert.deepEqual((await result).added, accepted.pending)
    assert.deepEqual(paths, ['/api/download-jobs/accepted-job', '/api/download-jobs/accepted-job'])
    assert.deepEqual(updates, [false, true])
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch }
})

test('download commands and their retained state survive card unsubscription', async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => {}, dispatchEvent: () => true } as unknown as Window & typeof globalThis
  let accept!: (value: Response) => void
  let added = false
  const id = 'retained-result\0' + 0
  globalThis.fetch = (async input => {
    if (String(input) === '/api/download') return new Promise<Response>(resolve => { accept = resolve })
    return Response.json({ ok: true, downloads: added ? { [id]: { ok: true, found: true, identity: 'identity', state: 'downloading', progress: 0.5, downloaded: 50, total_size: 100, speed: 10 } } : {} })
  }) as typeof fetch
  try {
    invalidateDownloadProgress()
    const unsubscribe = subscribeDownloads(() => {})
    const command = sendDownload('retained-result', 0, 'identity')
    assert.equal(getDownloadSnapshot()[id].state, 'sending')
    unsubscribe()
    added = true; accept(Response.json({ ok: true })); await command
    assert.equal(getDownloadSnapshot()[id].state, 'downloading')
    assert.equal(getDownloadSnapshot()[id].progress, 0.5)
    const again = subscribeDownloads(() => {})
    await refreshDownloads()
    assert.equal(getDownloadSnapshot()[id].identity, 'identity')
    again()
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; invalidateDownloadProgress() }
})
