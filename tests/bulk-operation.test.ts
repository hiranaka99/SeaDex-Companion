import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import type { DownloadJobStatus } from '../frontend/src/api.js'
import { followDownloadJob, waitForDownloadJob } from '../frontend/src/bulk-job-store.js'
import {
  bulkCancelFinished,
  bulkCancelStarting,
  bulkDownloadStarting,
  bulkOperationFailed,
  dismissBulkOperation,
  getBulkOperation,
  subscribeBulkOperation,
} from '../frontend/src/bulk-operation.js'

function unit(name: string) {
  return {
    unit_id: `torrent:${name}`,
    protocol: 'torrent' as const,
    source_hash: name.padEnd(40, '0'),
    label: name,
    selections: [{ key: name, release: 0 }],
  }
}

function job(id: string | null, changes: Partial<DownloadJobStatus> = {}): DownloadJobStatus {
  return {
    id,
    ok: true,
    finished: false,
    pending: [],
    added: [],
    existing: [],
    failures: [],
    targets: [],
    ...changes,
  }
}

/** A browser whose timers run only when the test says so, answering job reads from `answer`. */
function fakeBrowser(answer: (path: string) => DownloadJobStatus) {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch
  const timers: (() => void)[] = []
  const stored = new Map<string, string>()
  globalThis.window = {
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => {},
  } as unknown as Window & typeof globalThis
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  })
  globalThis.fetch = async input => Response.json(answer(String(input)))
  return {
    stored,
    async tick() {
      const pending = timers.splice(0)
      for (const timer of pending) timer()
      await settle()
      await settle()
    },
    restore() {
      globalThis.window = originalWindow
      globalThis.fetch = originalFetch
      delete (globalThis as { localStorage?: unknown }).localStorage
    },
  }
}

const failure = (name: string) => ({ ...unit(name), code: 'client_error', error: `${name} timed out` })

test('a live batch shows its progress and then its outcome, failures included', async () => {
  let current = job(null, { finished: true })
  const browser = fakeBrowser(() => current)
  const unsubscribe = subscribeBulkOperation(() => {})
  try {
    await settle()
    bulkDownloadStarting()
    assert.equal(getBulkOperation().operation?.message, 'Starting downloads…')
    assert.equal(getBulkOperation().operation?.phase, 'running')
    assert.equal(getBulkOperation().reviewAvailable, true, 'The batch started here can be reviewed')

    current = job('live-job', { pending: [unit('a'), unit('b'), unit('c')] })
    const finished = followDownloadJob('live-job')
    await settle()
    await settle()
    assert.deepEqual(
      { ...getBulkOperation().operation, failures: undefined },
      {
        action: 'start',
        phase: 'running',
        settled: 0,
        total: 3,
        added: 0,
        failed: 0,
        failures: undefined,
        jobId: 'live-job',
        message: '0 sent · 3 pending',
      },
    )

    current = job('live-job', {
      finished: true,
      added: [unit('a')],
      existing: [unit('b')],
      failures: [failure('c')],
    })
    await browser.tick()
    await finished
    const operation = getBulkOperation().operation
    assert.equal(operation?.phase, 'warning')
    assert.equal(operation?.message, '1 sent · 1 already queued · 1 failed')
    assert.equal(`${operation?.settled}/${operation?.total}`, '3/3')
    assert.deepEqual(operation?.failures, [{ label: 'c', error: 'c timed out' }])
  } finally {
    unsubscribe()
    browser.restore()
  }
})

test('a reload restores the latest job with the banner a live batch would show', async () => {
  const restored = job('reloaded-job', {
    finished: true,
    added: [unit('a')],
    existing: [unit('b')],
    failures: [failure('c')],
  })
  const paths: string[] = []
  const browser = fakeBrowser(path => {
    paths.push(path)
    return restored
  })
  const unsubscribe = subscribeBulkOperation(() => {})
  try {
    await settle()
    await settle()
    assert.deepEqual(paths, ['/api/download-jobs/latest'])
    const operation = getBulkOperation().operation
    assert.equal(operation?.jobId, 'reloaded-job')
    assert.equal(operation?.phase, 'warning')
    assert.equal(operation?.message, '1 sent · 1 already queued · 1 failed')
    assert.equal(`${operation?.settled}/${operation?.total}`, '3/3')
  } finally {
    unsubscribe()
    browser.restore()
  }
})

test('a dismissed job stays dismissed after a reload, while a newer job appears', async () => {
  let current = job('dismissed-job', { finished: true, added: [unit('a')] })
  const browser = fakeBrowser(() => current)
  let unsubscribe = subscribeBulkOperation(() => {})
  try {
    await settle()
    await settle()
    assert.equal(getBulkOperation().operation?.jobId, 'dismissed-job')
    dismissBulkOperation()
    assert.equal(getBulkOperation().operation, null)
    assert.equal(browser.stored.get('seadex-dismissed-download-job'), 'dismissed-job')

    unsubscribe()
    // After a reload the dismissal is read back from storage, so the restored job stays hidden.
    current = job('dismissed-job', { finished: true, added: [unit('a')], existing: [unit('b')] })
    unsubscribe = subscribeBulkOperation(() => {})
    await settle()
    await settle()
    assert.equal(getBulkOperation().operation, null)

    await waitForDownloadJob(job('newer-job', { finished: true, existing: [unit('b')] }))
    assert.equal(getBulkOperation().operation?.jobId, 'newer-job')
    assert.equal(getBulkOperation().operation?.message, '0 sent · 1 already queued')
    assert.equal(getBulkOperation().operation?.phase, 'success')
  } finally {
    unsubscribe()
    browser.restore()
  }
})

test('a bulk cancellation reports its outcome, and a failed request reports the error', () => {
  const browser = fakeBrowser(() => job(null, { finished: true }))
  const unsubscribe = subscribeBulkOperation(() => {})
  try {
    bulkCancelStarting(3)
    assert.equal(getBulkOperation().operation?.message, 'Removing selected incomplete downloads…')
    assert.equal(getBulkOperation().reviewAvailable, false, 'A cancellation has no download review to reopen')
    bulkCancelFinished(
      {
        ok: true,
        removed: [
          { record_id: 'r1', client: 'qbittorrent' },
          { record_id: 'r2', client: 'sabnzbd' },
        ],
        failures: [{ record_id: 'r3', client: 'qbittorrent', label: 'Show', error: 'Not found' }],
      },
      3,
      true,
    )
    assert.deepEqual(getBulkOperation().operation, {
      action: 'cancel',
      phase: 'warning',
      settled: 3,
      total: 3,
      added: 0,
      failed: 1,
      failures: [{ label: 'Show', error: 'Not found' }],
      message: 'Removed 2 downloads; files deleted',
    })

    bulkOperationFailed('cancel', 2, 'Network down')
    assert.deepEqual(getBulkOperation().operation, {
      action: 'cancel',
      phase: 'error',
      settled: 0,
      total: 2,
      added: 0,
      failed: 2,
      message: 'Network down',
    })
  } finally {
    unsubscribe()
    browser.restore()
  }
})
