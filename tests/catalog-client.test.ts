import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCatalogClient } from '../server/catalog-client.js'
import { seadexBest } from '../server/catalog.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { buildScanHistoryEntry } from '../server/history.js'
import type { ScanHistoryEntry } from '../shared/contracts.js'
import { fetchWithTimeout, scanRequests, sleep } from '../server/http.js'
import { createScanService } from '../server/scan.js'
import { cancelScan, getState, setState } from '../server/scan-state.js'

const pageData = (totalPages = 1, id = 42) => ({ totalPages, items: [{ alID: id }] })

function fixture(responses: Array<() => Response | Promise<Response>>, random = 0) {
  let calls = 0
  const pauses: number[] = []
  const loadPage = createCatalogClient({
    fetch: async (_url, _init, timeout) => {
      assert.equal(timeout, 60_000)
      return responses[Math.min(calls++, responses.length - 1)]()
    },
    sleep: async milliseconds => {
      pauses.push(milliseconds)
    },
    now: () => Date.parse('2026-11-18T12:00:00Z'),
    random: () => random,
  })
  return { loadPage, pauses, calls: () => calls }
}

test('catalog timeouts and network failures recover with bounded exponential backoff and jitter', async () => {
  const client = fixture(
    [
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
      () => {
        throw new TypeError('fetch failed')
      },
      () => Response.json(pageData()),
    ],
    0.5,
  )
  assert.deepEqual(await client.loadPage(1), pageData())
  assert.equal(client.calls(), 3)
  assert.deepEqual(client.pauses, [1125, 2125])
})

test('catalog retries only transient HTTP statuses and releases failed response bodies', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let cancelled = false
    const client = fixture([
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true
            },
          }),
          { status },
        ),
      () => {
        assert.equal(cancelled, true)
        return Response.json(pageData())
      },
    ])
    await client.loadPage(1)
    assert.equal(client.calls(), 2, `HTTP ${status}`)
  }
  for (const status of [301, 400, 401, 403, 404, 501]) {
    const client = fixture([() => new Response('', { status })])
    await assert.rejects(client.loadPage(5), new RegExp(`SeaDex catalog page 5, attempt 1/3: HTTP ${status}`))
    assert.equal(client.calls(), 1)
    assert.deepEqual(client.pauses, [])
  }
})

test('catalog honors Retry-After seconds and dates with bounded waits', async () => {
  for (const header of ['5', 'Wed, 18 Nov 2026 12:00:05 GMT']) {
    const client = fixture([
      () => new Response('', { status: 503, headers: { 'Retry-After': header } }),
      () => Response.json(pageData()),
    ])
    await client.loadPage(1)
    assert.deepEqual(client.pauses, [5000])
  }
  for (const header of ['invalid', '-1', 'Wed, 18 Nov 2026 11:59:00 GMT']) {
    const client = fixture([
      () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
      () => Response.json(pageData()),
    ])
    await client.loadPage(1)
    assert.deepEqual(client.pauses, [1000])
  }
  const client = fixture([() => new Response('', { status: 429, headers: { 'Retry-After': '120' } })])
  await assert.rejects(
    client.loadPage(1),
    /page 1, attempt 1\/3: HTTP 429; Retry-After exceeds the 60s retry wait limit/,
  )
  assert.equal(client.calls(), 1, 'Do not retry sooner than the server permits')
  assert.deepEqual(client.pauses, [])
})

test('catalog exhausts exactly three attempts and reports page and timeout details', async () => {
  const failure = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const client = fixture([
    () => {
      throw failure
    },
  ])
  await assert.rejects(client.loadPage(5), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /SeaDex catalog page 5, attempt 3\/3: request timed out after 60s/)
    assert.equal(error.cause, failure)
    return true
  })
  assert.equal(client.calls(), 3)
  assert.deepEqual(client.pauses, [1000, 2000], 'No extra sleep after the final failure')
})

test('catalog retries a connection failure during body reading but fails malformed JSON immediately', async () => {
  const client = fixture([
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'))
          },
        }),
      ),
    () => Response.json(pageData()),
  ])
  assert.deepEqual(await client.loadPage(1), pageData())
  assert.equal(client.calls(), 2)
  const abortedBody = fixture([
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('The operation was aborted', 'AbortError'))
          },
        }),
      ),
    () => Response.json(pageData()),
  ])
  assert.deepEqual(await abortedBody.loadPage(1), pageData())
  assert.equal(abortedBody.calls(), 2, 'A body timeout is not user cancellation')
  const invalid = fixture([() => new Response('invalid JSON')])
  await assert.rejects(invalid.loadPage(2), /SeaDex catalog page 2, attempt 1\/3/)
  assert.equal(invalid.calls(), 1)
})

test('catalog pagination retries the failed page without reloading earlier pages', async () => {
  const pages: number[] = []
  const loadPage = createCatalogClient({
    fetch: async url => {
      const page = Number(new URL(url).searchParams.get('page'))
      pages.push(page)
      if (pages.length === 2) return new Response('', { status: 502 })
      return Response.json(pageData(2, page))
    },
    sleep: async () => {},
    random: () => 0,
  })
  const best = await seadexBest({ loadPage })
  assert.deepEqual(pages, [1, 2, 2])
  assert.deepEqual([...best.keys()], [1, 2])
})

test('catalog cancellation interrupts an in-flight request without retrying', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  let started!: () => void,
    calls = 0
  const ready = new Promise<void>(resolve => {
    started = resolve
  })
  globalThis.fetch = async (_url, init) => {
    calls++
    const signal = init!.signal!
    started()
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  try {
    const loadPage = createCatalogClient({
      fetch: fetchWithTimeout,
      sleep: async () => assert.fail('Cancellation must not retry'),
    })
    const pending = scanRequests.run(controller.signal, () => loadPage(1))
    await ready
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(calls, 1)
    await assert.rejects(
      scanRequests.run(controller.signal, () => loadPage(1)),
      { name: 'AbortError' },
    )
    assert.equal(calls, 1, 'An already-cancelled scan never starts a request')
  } finally {
    globalThis.fetch = original
  }
})

test('scan cancellation interrupts catalog backoff and preserves previous results', async () => {
  const before = getState()
  let waiting!: () => void,
    calls = 0,
    saved = false
  const ready = new Promise<void>(resolve => {
    waiting = resolve
  })
  let history: ScanHistoryEntry | undefined
  const loadPage = createCatalogClient({
    fetch: async () => {
      calls++
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } })
    },
    sleep: async milliseconds => {
      waiting()
      await sleep(milliseconds)
    },
  })
  const service = createScanService({
    seadexBest: () => seadexBest({ loadPage }),
    localItems: async () => assert.fail('Cancelled catalog must not start library loading'),
    saveLastResults: () => {
      saved = true
    },
    recordScanHistory: (previous, current, runAt, _file, trigger, metadata) =>
      (history = buildScanHistoryEntry(previous, current, runAt, trigger, metadata)),
  })
  try {
    setState({ results: [{ key: 'existing', title: 'Existing results' }], last_run: 'previous successful scan' })
    const previous = getState()
    const pending = service.run(DEFAULT_CONFIG)
    await ready
    assert.equal(cancelScan(), true)
    await pending
    assert.equal(calls, 1)
    assert.equal(saved, false)
    assert.deepEqual(getState().results, previous.results)
    assert.equal(getState().last_run, previous.last_run)
    assert.equal(getState().cancelled, true)
    assert.equal(history?.outcome, 'cancelled')
  } finally {
    setState(before)
  }
})

test('exhausted catalog retries preserve previous scan results and record useful failure details', async () => {
  const before = getState()
  const client = fixture([
    () => {
      throw new TypeError('fetch failed')
    },
  ])
  let saved = false,
    history: ScanHistoryEntry | undefined
  const service = createScanService({
    seadexBest: () => seadexBest({ loadPage: client.loadPage }),
    localItems: async () => assert.fail('Failed catalog must not start library loading'),
    saveLastResults: () => {
      saved = true
    },
    recordScanHistory: (previous, current, runAt, _file, trigger, metadata) =>
      (history = buildScanHistoryEntry(previous, current, runAt, trigger, metadata)),
  })
  try {
    setState({ results: [{ key: 'existing', title: 'Existing results' }], last_run: 'previous successful scan' })
    const previous = getState()
    await service.run(DEFAULT_CONFIG, 'scheduled')
    assert.equal(client.calls(), 3)
    assert.equal(saved, false)
    assert.deepEqual(getState().results, previous.results)
    assert.equal(getState().last_run, previous.last_run)
    assert.equal(getState().running, false)
    assert.equal(getState().cancelled, false)
    assert.match(getState().error!, /SeaDex catalog page 1, attempt 3\/3: fetch failed/)
    assert.equal(history?.outcome, 'failed')
    assert.equal(history?.error, getState().error)
    assert.deepEqual(history?.changes, [])
  } finally {
    setState(before)
  }
})

test('catalog releases link to their tracker page, resolving AnimeBytes paths against its site', async () => {
  const torrent = (tracker: string, url: string, infoHash: string) => ({
    tracker,
    url,
    infoHash,
    releaseGroup: tracker,
    isBest: true,
    files: [{ name: `[${tracker}] Show - 01.mkv`, length: 1 }],
  })
  const best = await seadexBest({
    loadPage: async () => ({
      totalPages: 1,
      items: [
        {
          alID: 7,
          expand: {
            trs: [
              torrent('AB', '/torrents.php?id=3140&torrentid=951508', '<redacted>'),
              torrent('Nyaa', 'https://nyaa.si/view/1188887', 'a'.repeat(40)),
              torrent('Other', 'javascript:alert(1)', 'b'.repeat(40)),
            ],
          },
        },
      ],
    }),
  })
  const links = Object.fromEntries(
    best.get(7)!.seasons[0].candidates.map(candidate => [candidate.tracker, candidate.tracker_url]),
  )
  assert.deepEqual(links, {
    AB: 'https://animebytes.tv/torrents.php?id=3140&torrentid=951508',
    Nyaa: 'https://nyaa.si/view/1188887',
    Other: undefined,
  })
})
