import { getDownloadSnapshot, refreshDownloads, subscribeDownloads } from '../frontend/src/download-store.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cancelDownloads,
  cancelUsenetChecks,
  getAllDownloadProgress,
  getProwlarrSearchStatus,
  getStatus,
  getConfig,
  invalidateDownloadProgress,
  getUsenetAvailabilityRevision,
  saveConfig,
  subscribeUsenetAvailability,
  preflightDownload,
  sendDownload,
  usenetAvailability,
} from '../frontend/src/api.js'
import type { DownloadProtocol } from '../frontend/src/api.js'

test('progress probes share a request but cannot reuse a stale request after results change', async () => {
  const original = globalThis.fetch
  const replies: Array<(response: Response) => void> = []
  globalThis.fetch = async () =>
    new Promise<Response>(resolve => {
      replies.push(resolve)
    })
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
  } finally {
    globalThis.fetch = original
    invalidateDownloadProgress()
  }
})

test('download-store subscribers share polling and unsubscribe independently', async () => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window
  let tick!: () => void,
    clears = 0
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      tick = callback
      return 1
    },
    clearTimeout: () => {
      clears += 1
    },
  } as unknown as Window & typeof globalThis
  // Subscribers hear about changed answers only, so every read reports a different unreachable client.
  let reads = 0
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      downloads: {},
      unavailable_clients: [++reads % 2 ? 'qbittorrent' : 'sabnzbd'],
    })
  let firstCalls = 0,
    secondCalls = 0
  const unsubscribeFirst = subscribeDownloads(() => {
    firstCalls += 1
  })
  const unsubscribeSecond = subscribeDownloads(() => {
    secondCalls += 1
  })
  try {
    await refreshDownloads()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(firstCalls, 1)
    assert.equal(secondCalls, 1)
    unsubscribeFirst()
    assert.equal(clears, 0)
    tick()
    await refreshDownloads()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(firstCalls, 1)
    assert.equal(secondCalls, 2)
    unsubscribeSecond()
    assert.equal(clears, 1)
  } finally {
    unsubscribeFirst()
    unsubscribeSecond()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    invalidateDownloadProgress()
  }
})

test('an unchanged download answer keeps the snapshot and notifies nobody, and a hidden page does not poll', async () => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window,
    originalDocument = globalThis.document
  let tick!: () => void
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      tick = callback
      return 1
    },
    clearTimeout: () => {},
  } as unknown as Window & typeof globalThis
  let reads = 0,
    speed = 10
  globalThis.fetch = async () => {
    reads += 1
    return Response.json({ ok: true, downloads: { 't:record': { record_id: 't:record', speed } } })
  }
  let notified = 0
  const unsubscribe = subscribeDownloads(() => {
    notified += 1
  })
  try {
    await refreshDownloads()
    const first = getDownloadSnapshot()
    assert.equal(notified, 1)
    await refreshDownloads()
    assert.equal(notified, 1, 'A repeated answer renders nothing')
    assert.equal(getDownloadSnapshot(), first, 'The snapshot object is kept while nothing changed')
    speed = 20
    await refreshDownloads()
    assert.equal(notified, 2)
    assert.notEqual(getDownloadSnapshot(), first)

    await new Promise(resolve => setImmediate(resolve))
    const before = reads
    globalThis.document = { hidden: true } as unknown as Document
    tick()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, before, 'A hidden page keeps its timer but reads nothing')
    globalThis.document = { hidden: false } as unknown as Document
    tick()
    await refreshDownloads()
    assert.equal(reads, before + 1, 'Polling resumes once the page is shown')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    invalidateDownloadProgress()
  }
})

test('provider-backed reviews have no aggregate timeout and honor explicit cancellation', async () => {
  const originalFetch = globalThis.fetch,
    originalTimeout = AbortSignal.timeout
  const timeouts: number[] = []
  AbortSignal.timeout = ms => {
    timeouts.push(ms)
    return originalTimeout(ms)
  }
  globalThis.fetch = async (_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>()
    const signal = init?.signal as AbortSignal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    return promise
  }
  try {
    for (const request of [preflightDownload, usenetAvailability]) {
      const controller = new AbortController()
      const pending = request([], false, controller.signal)
      assert.deepEqual(timeouts, [], 'Provider pacing must not inherit an aggregate deadline')
      controller.abort()
      await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
    }
    globalThis.fetch = async () => Response.json({})
    await getStatus()
    assert.deepEqual(timeouts, [30_000], 'Normal APIs retain their timeout')
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
  }
})

/** Answers every request with one JSON body and status, and records what the single send posted. */
async function sendAnswered(body: unknown, status = 200, protocol: DownloadProtocol = 'usenet') {
  const originalFetch = globalThis.fetch
  const posted: unknown[] = []
  globalThis.fetch = async (_input, init) => {
    posted.push(JSON.parse(String(init?.body)))
    return Response.json(body, { status })
  }
  try {
    const outcome = await sendDownload('one-shot-plan', protocol, { whole_source: true, disk_space: true })
    return { outcome, posted }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const receipt = {
  ok: true,
  record_id: 'owned-1',
  native_id: 'SABnzbd_nzo_1',
  protocol: 'usenet',
  client: 'sabnzbd',
  source_hash: 'a'.repeat(40),
  category: 'anime',
}

test('a confirmed single send is reported as sent to the client that took it', async () => {
  const { outcome, posted } = await sendAnswered(receipt)
  assert.deepEqual(outcome, { kind: 'sent', client: 'sabnzbd' })
  assert.deepEqual(posted, [{ plan_id: 'one-shot-plan', acknowledge: { whole_source: true, disk_space: true } }])
})

test('a refused single send is reported as rejected with the server reason', async () => {
  const expired = {
    ok: false,
    error: 'This review has expired or was already used. Re-run the review before submitting.',
  }
  assert.deepEqual((await sendAnswered(expired, 410)).outcome, { kind: 'rejected', reason: expired.error })
  const failed = {
    ...receipt,
    ok: false,
    error: '1 source(s) failed: Show S1: disk full',
    failures: [{ protocol: 'usenet', label: 'Show S1', code: 'client', error: 'disk full' }],
  }
  assert.deepEqual((await sendAnswered(failed, 502)).outcome, { kind: 'rejected', reason: failed.error })
  assert.deepEqual((await sendAnswered({ ...receipt, ok: false })).outcome, {
    kind: 'rejected',
    reason: 'The download client rejected the submission',
  })
})

test('a single send the client never confirmed is reported as acceptance unknown, naming that client', async () => {
  const unconfirmed = { ...receipt, ok: false, error: 'SABnzbd did not confirm acceptance', acceptance_unknown: true }
  assert.deepEqual((await sendAnswered(unconfirmed, 502)).outcome, {
    kind: 'acceptance_unknown',
    client: 'sabnzbd',
    reason: 'SABnzbd did not confirm acceptance',
  })
  const unsettled = {
    ...receipt,
    ok: false,
    client: 'qbittorrent',
    protocol: 'torrent',
    error: '1 source(s) failed: Show S1: not settled',
    failures: [{ protocol: 'torrent', label: 'Show S1', code: 'acceptance_unknown', error: 'not settled' }],
  }
  assert.deepEqual((await sendAnswered(unsettled, 502)).outcome, {
    kind: 'acceptance_unknown',
    client: 'qbittorrent',
    reason: unsettled.error,
  })
  // A confirmed answer that still flags an ambiguous client reply carries no reason of its own.
  assert.deepEqual((await sendAnswered({ ...receipt, acceptance_unknown: true })).outcome, {
    kind: 'acceptance_unknown',
    client: 'sabnzbd',
  })
  // Without a named client, the client is the one serving the protocol that was sent.
  const anonymous = { ok: false, error: 'Not confirmed', acceptance_unknown: true }
  assert.deepEqual((await sendAnswered(anonymous, 502, 'torrent')).outcome, {
    kind: 'acceptance_unknown',
    client: 'qbittorrent',
    reason: 'Not confirmed',
  })
})

test('bulk cancellation sends the exact reviewed records even when all were checked', async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ ok: true, removed: [], failures: [] })
  }
  try {
    await cancelDownloads(['reviewed-a', 'reviewed-b'], false)
    assert.deepEqual(body, { record_ids: ['reviewed-a', 'reviewed-b'], remove_files: false })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('whole-library preflight sends every selected row in one plan', async () => {
  const originalFetch = globalThis.fetch
  const selections = Array.from({ length: 201 }, (_, release) => ({
    key: `show-${release}`,
    release: 0,
    identity: `identity-${release}`,
    protocol: 'torrent' as const,
  }))
  const bodies: unknown[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true })
  }
  try {
    await preflightDownload(selections)
    assert.deepEqual(bodies, [{ selections }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('availability reads preserve provider timestamps and only manual refresh requests force work', async () => {
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []
  const checkedAt = '2026-11-18T10:00:00.000Z'
  const identity = 'cached-release'
  const cached = {
    key: 'show',
    release: 0,
    identity,
    aggregate: 'available',
    checked_at: checkedAt,
    stale: true,
    refreshing: true,
    hashes: [{ hash: 'a'.repeat(40), state: 'available', checked_at: checkedAt, stale: true, refreshing: true }],
  }
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({
      ok: true,
      config_generation: 7,
      sabnzbd_configured: true,
      providers_enabled: { animetosho: true, amenzb: false },
      results: [
        cached,
        {
          key: 'missing',
          release: 0,
          identity: 'unknown-release',
          aggregate: 'not_checked',
          checked_at: '',
          stale: false,
          refreshing: true,
          hashes: [{ hash: 'b'.repeat(40), state: 'not_checked', refreshing: true }],
        },
      ],
    })
  }
  try {
    const selections = [
      { key: 'show', release: 0, identity },
      { key: 'missing', release: 0, identity: 'unknown-release' },
    ]
    const first = await usenetAvailability(selections)
    assert.equal(first.results[0].checked_at, checkedAt)
    assert.equal(first.results[0].stale, true)
    assert.equal(first.results[1].aggregate, 'not_checked')
    assert.equal(first.results[1].checked_at, '')
    await usenetAvailability(selections, true)
    const poll = await usenetAvailability(selections)
    assert.equal(poll.results[0].checked_at, checkedAt, 'Reading a snapshot never invents a new provider check')
    assert.deepEqual(requests, [{ selections }, { selections, refresh: true }, { selections }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('availability requests name the rows to search, verify and cancel, and nothing else about them', async () => {
  const originalFetch = globalThis.fetch
  const requests: { path: string; body: Record<string, unknown>; keepalive?: boolean }[] = []
  globalThis.fetch = async (input, init) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)), keepalive: init?.keepalive })
    return Response.json({ ok: true, config_generation: 1, results: [] })
  }
  try {
    const selections = [
      { key: 'one', release: 0, identity: 'identity-one' },
      { key: 'two', release: 1, identity: 'identity-two' },
    ]
    await usenetAvailability(selections, false, undefined, {
      search: [],
      verify: [selections[0]],
      cancel_verify: [selections[1]],
    })
    assert.deepEqual(requests[0].body, {
      selections,
      verify: [{ key: 'one', release: 0 }],
      cancel_verify: [{ key: 'two', release: 1 }],
    })
    assert.equal(requests[0].keepalive, undefined)

    cancelUsenetChecks([])
    assert.equal(requests.length, 1, 'Nothing to cancel sends nothing')
    cancelUsenetChecks([{ ...selections[1], protocol: 'usenet' }])
    assert.deepEqual(requests[1], {
      path: '/api/usenet/availability',
      body: { selections: [selections[1]], cancel_verify: [{ key: 'two', release: 1 }] },
      keepalive: true,
    })
    globalThis.fetch = async () => {
      throw new Error('Fixture connection lost')
    }
    cancelUsenetChecks([selections[0]])
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the Prowlarr search status is read from its own route', async () => {
  const originalFetch = globalThis.fetch
  const status = { eligible_sources: 12, pending_sources: 4, usenet_indexers: 2 }
  const paths: string[] = []
  globalThis.fetch = async input => {
    paths.push(String(input))
    return Response.json({ ok: true, status })
  }
  try {
    assert.deepEqual(await getProwlarrSearchStatus(), status)
    assert.deepEqual(paths, ['/api/prowlarr/search-status'])
    globalThis.fetch = async () => Response.json({ error: 'Not found' }, { status: 404 })
    await assert.rejects(getProwlarrSearchStatus(), 'A missing route is an error the settings page swallows')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('successful configuration saves invalidate availability even when a secret stays configured', async () => {
  const originalFetch = globalThis.fetch
  const before = getUsenetAvailabilityRevision()
  let notifications = 0
  const unsubscribe = subscribeUsenetAvailability(() => {
    notifications += 1
  })
  globalThis.fetch = async () => Response.json({ amenzb_key_configured: true })
  try {
    await saveConfig({ amenzb_key: 'replacement-fixture-key' })
    assert.equal(getUsenetAvailabilityRevision(), before + 1)
    assert.equal(notifications, 1)
    await saveConfig({ datetime_format: 'YYYY-MM-DD HH:mm:ss' })
    assert.equal(getUsenetAvailabilityRevision(), before + 1, 'Unrelated settings preserve compatible availability')
    globalThis.fetch = async () => Response.json({ error: 'Fixture save failed' }, { status: 503 })
    await assert.rejects(saveConfig({ amenzb_key: 'another-fixture-key' }))
    assert.equal(getUsenetAvailabilityRevision(), before + 1, 'Failed saves leave the active scope unchanged')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
  }
})

test('provider URL changes rebind availability while repeated config reads preserve its scope', async () => {
  const originalFetch = globalThis.fetch
  let url = 'https://fixture-provider.invalid'
  globalThis.fetch = async () =>
    Response.json({ animetosho_enabled: true, animetosho_url: url, amenzb_key_configured: true })
  try {
    await getConfig()
    const before = getUsenetAvailabilityRevision()
    await getConfig()
    assert.equal(getUsenetAvailabilityRevision(), before)
    url = 'https://replacement-provider.invalid'
    await saveConfig({ animetosho_url: url })
    assert.equal(getUsenetAvailabilityRevision(), before + 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
