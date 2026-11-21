import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jobResult } from '../shared/download-contracts.js'
import { waitForDownloadJob } from '../frontend/src/bulk-job-store.js'
import { controlDownload, getDownloadSnapshot, refreshDownloads, subscribeDownloads } from '../frontend/src/download-store.js'
import { invalidateDownloadProgress, type DownloadJobStatus, type DownloadProgress } from '../frontend/src/api.js'

const unit = { unit_id: 'torrent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:anime', protocol: 'torrent' as const, source_hash: 'a'.repeat(40), label: 'Show', selections: [{ key: 'show-1', release: 0 }] }

test('one job observer retries connectivity failures and follows the accepted ID', async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch
  const timers: (() => void)[] = []
  globalThis.window = { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length }, clearTimeout: () => {} } as unknown as Window & typeof globalThis
  const accepted: DownloadJobStatus = { id: 'accepted-job', existing: [], targets: [{ key: 'show-1', release: 0 }], ok: true, finished: false, pending: [unit], added: [], failures: [] }
  const finished = { ...accepted, finished: true, pending: [], added: [unit] }
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

test('record-keyed snapshot reloads after control commands even without subscribers', async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => {}, dispatchEvent: () => true } as unknown as Window & typeof globalThis
  const recordId = 't:' + 'a'.repeat(40)
  const row: DownloadProgress = {
    record_id: recordId, protocol: 'torrent', client: 'qbittorrent', source_hash: 'a'.repeat(40), native_id: 'a'.repeat(40),
    phase: 'downloading', state: 'downloading', category: 'anime', labels: [], title: 'Show', season: 1, part: '', release_group: 'Group', tracker: 'Nyaa',
    size: 100, key: 'show-1', release: 0, progress: 0.5, downloaded: 50, total_size: 100, speed: 10,
    capabilities: { pause: true, resume: true, remove: true, remove_files: true }, updated_at: new Date().toISOString(),
  }
  let acceptControl!: (value: Response) => void
  let removed = false
  globalThis.fetch = (async input => {
    if (String(input) === '/api/download_control') return new Promise<Response>(resolve => { acceptControl = resolve })
    return Response.json({ ok: true, downloads: removed ? {} : { [recordId]: row } })
  }) as typeof fetch
  try {
    invalidateDownloadProgress()
    const unsubscribe = subscribeDownloads(() => {})
    const command = controlDownload(recordId, 'remove', false)
    unsubscribe()
    removed = true
    acceptControl(Response.json({ ok: true }))
    await command
    assert.equal(getDownloadSnapshot()[recordId], undefined, 'A removed record leaves the snapshot after reload')
    const again = subscribeDownloads(() => {})
    await new Promise(resolve => setImmediate(resolve))
    removed = false
    await refreshDownloads()
    assert.equal(getDownloadSnapshot()[recordId]?.phase, 'downloading')
    again()
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; invalidateDownloadProgress() }
})

test('jobResult reports in-flight units as pending rows and settles them once added', () => {
  const unitB = { unit_id: 'usenet:bbbbbbbbbbbb:anime', protocol: 'usenet' as const, source_hash: 'b'.repeat(40), label: 'Show 2', selections: [{ key: 'show-2', release: 1 }] }
  const inflight = { ok: true, finished: false, targets: [{ key: 'show-1', release: 0 }, { key: 'show-2', release: 1 }], pending: [unit, unitB], existing: [], added: [], failures: [] }
  const running = jobResult(inflight)
  const row = running.rows.find(item => item.key === 'show-1' && item.release === 0)
  assert.ok(row, 'A still-pending unit keeps a visible row')
  assert.equal(row!.status, 'pending')
  assert.deepEqual(row!.protocols, ['torrent'])
  assert.equal(running.rows.find(item => item.key === 'show-2')?.status, 'pending')
  assert.equal(running.count, 0)
  const settled = jobResult({ ...inflight, finished: true, pending: [], added: [unit], existing: [unitB] })
  assert.equal(settled.rows.find(item => item.key === 'show-1')?.status, 'added')
  assert.equal(settled.rows.find(item => item.key === 'show-2')?.status, 'existing')
  assert.equal(settled.count, 2)
})
