// The Newznab search step that AmeNZB and Prowlarr's indexers share: one request, its status, a capped
// read, the XML, an error document and the feed items, with one failure vocabulary. Every test passes its
// own fake fetch, so nothing here touches a network. Hosts and keys are fake.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchNewznab } from '../server/usenet-provider-types.js'
import type { NewznabSearchRequest } from '../server/usenet-provider-types.js'

const KEY = 'search-step-key-5d1e'
const DIRECT: NewznabSearchRequest = {
  indexer: 'AmeNZB',
  baseUrl: 'https://amenzb.example',
  path: `/api?t=search&apikey=${KEY}&q=show`,
  timeoutMs: 15_000,
  maxBytes: 64 * 1024,
}
const VIA_PROWLARR: NewznabSearchRequest = {
  indexer: 'Geek',
  viaProwlarr: true,
  baseUrl: 'http://prowlarr.test:9696',
  path: '/2/api?t=search&q=show',
  headers: { 'X-Api-Key': KEY },
  timeoutMs: 45_000,
  maxBytes: 64 * 1024,
}

interface Call {
  url: string
  headers: Headers
  redirect?: RequestRedirect
}

function recorder(respond: (call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect }
    calls.push(call)
    return await respond(call, init)
  }
  return { calls, fetchImpl }
}

const answering = (body: string, init: ResponseInit = {}) =>
  recorder(
    () =>
      new Response(body, {
        ...init,
        headers: { 'content-type': 'application/xml', ...Object.fromEntries(new Headers(init.headers)) },
      }),
  ).fetchImpl

const rss = (items = '<title>Feed</title>') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel>${items}</channel></rss>`

const errorXml = (code: number, description = 'Request limit reached') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="${description}" />`

async function failureOf(request: NewznabSearchRequest, fetchImpl: typeof fetch) {
  const search = await searchNewznab(request, fetchImpl)
  assert.ok(search.kind === 'failed', `expected a failure, got ${JSON.stringify(search)}`)
  return search.failure
}

test('A search answers with the feed items, sent to the configured origin with no redirect', async () => {
  const { calls, fetchImpl } = recorder(
    () => new Response(rss('<title>Feed</title><item><title>One</title></item><item><title>Two</title></item>')),
  )
  const search = await searchNewznab(VIA_PROWLARR, fetchImpl)
  assert.ok(search.kind === 'items')
  assert.deepEqual(search.items, [{ title: 'One' }, { title: 'Two' }])

  assert.equal(calls[0].url, 'http://prowlarr.test:9696/2/api?t=search&q=show')
  assert.equal(calls[0].headers.get('x-api-key'), KEY)
  assert.match(calls[0].headers.get('accept') ?? '', /application\/rss\+xml/)
  assert.equal(calls[0].redirect, 'error')
})

test('Rate limiting is read once: HTTP 429 with its Retry-After, and Newznab codes 500 and 501 whatever the status', async () => {
  const limited = await failureOf(DIRECT, answering('', { status: 429, headers: { 'retry-after': '120' } }))
  assert.deepEqual(limited, {
    code: 'rate_limited',
    message: 'AmeNZB rate limited the request',
    retryAfterMs: 120_000,
    scope: 'indexer',
  })
  // Prowlarr answers 429 itself while the indexer is at its query limit there or disabled after failures.
  const held = await failureOf(
    VIA_PROWLARR,
    answering(errorXml(429), { status: 429, headers: { 'retry-after': '1800' } }),
  )
  assert.deepEqual([held.code, held.retryAfterMs, held.scope], ['rate_limited', 1_800_000, 'indexer'])
  assert.match(held.message, /Prowlarr is not searching Geek for now/)

  for (const request of [DIRECT, VIA_PROWLARR]) {
    for (const [status, code] of [
      [200, 500],
      [200, 501],
      [503, 501],
    ]) {
      const failure = await failureOf(request, answering(errorXml(code), { status }))
      assert.deepEqual([failure.code, failure.scope], ['rate_limited', 'indexer'], `${request.indexer} ${code}`)
      assert.ok(failure.message.startsWith(`${request.indexer} `), failure.message)
      assert.ok(failure.message.includes(`(code ${code})`), failure.message)
    }
    // An error document inside a feed is no empty answer either.
    const inFeed = await failureOf(request, answering(rss('<error code="500" description="limit" />')))
    assert.equal(inFeed.code, 'rate_limited')
  }
})

test('A timeout, a cancellation and a network failure are failures of the indexer, never an empty answer', async () => {
  const rejecting = (error: unknown) => recorder(() => Promise.reject(error)).fetchImpl
  for (const request of [DIRECT, VIA_PROWLARR]) {
    const timeout = await failureOf(request, rejecting(new DOMException('The operation timed out', 'TimeoutError')))
    assert.deepEqual(timeout, {
      code: 'timeout',
      message: `The search of ${request.indexer} timed out`,
      scope: 'indexer',
    })

    const controller = new AbortController()
    controller.abort()
    const cancelled = await failureOf(
      { ...request, signal: controller.signal },
      recorder((_call, init) => Promise.reject(init?.signal?.reason)).fetchImpl,
    )
    assert.deepEqual([cancelled.code, cancelled.scope], ['network', 'indexer'])
    assert.match(cancelled.message, /cancelled/)

    const network = await failureOf(request, rejecting(new TypeError('fetch failed')))
    assert.deepEqual([network.code, network.scope], ['network', 'indexer'])
  }
  const unreachable = await failureOf(VIA_PROWLARR, rejecting(new TypeError('fetch failed')))
  assert.match(unreachable.message, /Could not reach Prowlarr for the search of Geek/)
})

test('An unusable base URL is a configuration problem of whoever holds it, and nothing is asked', async () => {
  for (const baseUrl of ['', 'file:///etc/passwd', 'not a url']) {
    const { calls, fetchImpl } = recorder(() => new Response(rss()))
    const direct = await failureOf({ ...DIRECT, baseUrl }, fetchImpl)
    assert.deepEqual([direct.code, direct.scope], ['invalid_config', 'indexer'])
    const prowlarr = await failureOf({ ...VIA_PROWLARR, baseUrl }, fetchImpl)
    assert.deepEqual([prowlarr.code, prowlarr.scope], ['invalid_config', 'prowlarr'])
    assert.equal(calls.length, 0)
  }
})

test("A refused key is the indexer's own on a direct search, and Prowlarr's when Prowlarr refuses the request", async () => {
  for (const status of [401, 403]) {
    const direct = await failureOf(DIRECT, answering('', { status }))
    assert.deepEqual([direct.code, direct.scope], ['unauthorized', 'indexer'])
    assert.match(direct.message, /check the API key and pinned API IP/)

    const prowlarr = await failureOf(VIA_PROWLARR, answering('{"error":"Unauthorized"}', { status }))
    assert.deepEqual([prowlarr.code, prowlarr.scope], ['unauthorized', 'prowlarr'])
    assert.match(prowlarr.message, /Prowlarr API key/)
  }
  // Newznab code 100: the indexer refused its own key, also when Prowlarr passed the answer on.
  const direct = await failureOf(DIRECT, answering(errorXml(100)))
  assert.deepEqual([direct.code, direct.scope], ['unauthorized', 'indexer'])
  assert.match(direct.message, /Invalid API key or IP mismatch/)
  const indexer = await failureOf(VIA_PROWLARR, answering(errorXml(100)))
  assert.deepEqual([indexer.code, indexer.scope], ['unauthorized', 'indexer'])
  assert.match(indexer.message, /Geek refused its API key \(code 100\)\. Check the indexer in Prowlarr\./)
})

test('Server errors keep their Retry-After, and other refusals are invalid responses of the indexer', async () => {
  for (const request of [DIRECT, VIA_PROWLARR]) {
    const server = await failureOf(
      request,
      answering('{"message":"boom"}', { status: 503, headers: { 'retry-after': '30' } }),
    )
    assert.deepEqual([server.code, server.scope, server.retryAfterMs], ['server', 'indexer', 30_000])
    assert.match(server.message, /HTTP 503/)

    const missing = await failureOf(request, answering('{"message":"NotFound"}', { status: 404 }))
    assert.deepEqual([missing.code, missing.scope], ['invalid_response', 'indexer'])

    for (const [code, expected] of [
      [201, 'invalid_response'],
      [300, 'server'],
      [900, 'server'],
    ] as const) {
      const failure = await failureOf(request, answering(errorXml(code), { status: code === 201 ? 400 : 200 }))
      assert.deepEqual([failure.code, failure.scope], [expected, 'indexer'], `code ${code}`)
    }
  }
  const off = await failureOf(VIA_PROWLARR, answering(errorXml(410, 'Indexer is disabled'), { status: 410 }))
  assert.deepEqual([off.code, off.scope, off.message], ['invalid_config', 'indexer', 'Geek is turned off in Prowlarr'])
  const gone = await failureOf(DIRECT, answering('', { status: 410 }))
  assert.equal(gone.code, 'invalid_response')
})

test('An answer that is not Newznab RSS is an invalid response, and an empty channel is an empty answer', async () => {
  for (const request of [DIRECT, VIA_PROWLARR]) {
    for (const [label, fetchImpl] of [
      ['html', answering('<html><body>Sign in</body></html>')],
      ['json', answering('[]')],
      ['empty', answering('')],
      ['no channel', answering('<rss version="2.0"><title>No channel</title></rss>')],
      ['a DTD', answering('<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel/></rss>')],
      ['declared too large', answering('<rss/>', { headers: { 'content-length': String(request.maxBytes + 1) } })],
      ['streamed too large', answering(rss(`<title>${'x'.repeat(request.maxBytes)}</title>`))],
    ] as const) {
      const failure = await failureOf(request, fetchImpl)
      assert.deepEqual([failure.code, failure.scope], ['invalid_response', 'indexer'], `${request.indexer}: ${label}`)
    }
    for (const body of [rss(), rss(''), '<rss version="2.0"><channel></channel></rss>']) {
      assert.deepEqual(await searchNewznab(request, answering(body)), { kind: 'items', items: [] })
    }
  }
  const oversized = await failureOf(DIRECT, answering(rss(`<title>${'x'.repeat(DIRECT.maxBytes)}</title>`)))
  assert.match(oversized.message, /byte limit/)
})

test("An indexer's error description never reaches the failure message", async () => {
  const description = `Invalid API key for https://geek.test/api?t=search&amp;apikey=${KEY}&amp;q=x`
  for (const request of [DIRECT, VIA_PROWLARR]) {
    for (const [code, status] of [
      [100, 200],
      [500, 200],
      [501, 200],
      [900, 500],
      [429, 429],
      [410, 410],
    ]) {
      const failure = await failureOf(request, answering(errorXml(code, description), { status }))
      for (const leak of [KEY, 'geek.test', 'Invalid API key for', '<'])
        assert.ok(!failure.message.includes(leak), `${request.indexer} ${code}: ${failure.message}`)
    }
  }
})
