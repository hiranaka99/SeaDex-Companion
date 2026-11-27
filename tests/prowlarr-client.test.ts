// The Prowlarr client: per-indexer Newznab search, indexer details, download failures and storable download
// references. Every test passes its own fake fetch, so nothing here touches a network or shared state.
//
// The Newznab RSS, the error documents and the indexer JSON below are constructed from Prowlarr's source
// (`NewznabResults.ToXml`, `NewznabController`, `IndexerResource`), not captured from a live instance.
// Hosts and keys are fake.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  ProwlarrError,
  downloadPathFromRef,
  downloadRef,
  privateSearchSettings,
  prowlarrDownload,
  prowlarrGrabNzb,
  prowlarrIndexers,
  resetProwlarrRuntime,
  searchIndexer,
} from '../server/prowlarr.js'
import type { ProwlarrSettings } from '../server/prowlarr.js'
import type { Config } from '../server/types.js'
import { NZB_MAX_BYTES } from '../server/usenet-provider-types.js'

const PROWLARR = 'http://prowlarr-client.test:9696'
const KEY = 'prowlarr-key-0f3a'
const SETTINGS: ProwlarrSettings = { baseUrl: PROWLARR, apiKey: KEY }
const GEEK = { id: 2, name: 'Geek' }
/** The indexer's own key, as it appears in the indexer's links and error descriptions. */
const INDEXER_KEY = 'indexer-secret-77'
const INDEXER_NZB = `https://geek.test/api?t=get&id=abc123&apikey=${INDEXER_KEY}`
const MIB = 1024 * 1024

interface Call {
  url: URL
  headers: Headers
  redirect?: RequestRedirect
}

/** Deterministic transport seam: every request is recorded and answered by the test. */
function recorder(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = { url: new URL(String(input)), headers: new Headers(init?.headers), redirect: init?.redirect }
    calls.push(call)
    return await respond(call)
  }
  return { calls, fetchImpl }
}

async function failureOf(work: Promise<unknown>): Promise<ProwlarrError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof ProwlarrError, `expected a ProwlarrError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Prowlarr's download link for a result (`DownloadMappingService.ConvertToProxyLink`): the indexer's address,
 * encrypted, in `link` and the title in `file`. Prowlarr names its own host as it was reached.
 */
const proxyLink = (indexerId: number, link: string, file: string, host = 'http://localhost:9696') =>
  `${host}/${indexerId}/download?${new URLSearchParams({ apikey: KEY, link, file })}`

interface ItemFixture {
  title: string
  guid: string
  link: string
  comments?: string
  pubDate?: string
  size?: number
  categories?: number[]
  files?: number
  grabs?: number
  /** Leave out the `newznab:attr` elements, as a feed without extended attributes would. */
  plain?: boolean
}

function itemXml(item: ItemFixture): string {
  const attr = (name: string, value: number) => `<newznab:attr name="${name}" value="${value}" />`
  const categories = item.categories ?? []
  return [
    '<item>',
    `<title>${escapeXml(item.title)}</title>`,
    '<description />',
    `<guid>${escapeXml(item.guid)}</guid>`,
    '<prowlarrindexer id="2" type="private">Geek</prowlarrindexer>',
    item.comments ? `<comments>${escapeXml(item.comments)}</comments>` : '',
    `<pubDate>${item.pubDate ?? 'Tue, 24 Nov 2026 18:03:11 +0100'}</pubDate>`,
    item.size === undefined ? '<size />' : `<size>${item.size}</size>`,
    `<link>${escapeXml(item.link)}</link>`,
    ...categories.map(category => `<category>${category}</category>`),
    `<enclosure url="${escapeXml(item.link)}"${item.size === undefined ? '' : ` length="${item.size}"`} type="application/x-nzb" />`,
    ...(item.plain ? [] : categories.map(category => attr('category', category))),
    item.plain || item.size === undefined ? '' : attr('size', item.size),
    item.plain || item.files === undefined ? '' : attr('files', item.files),
    item.plain || item.grabs === undefined ? '' : attr('grabs', item.grabs),
    '</item>',
  ].join('')
}

const rss = (items = '') =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">' +
  `<channel><atom:link rel="self" type="application/rss+xml" /><title>Prowlarr</title>${items}</channel></rss>`

/** `NewznabController.CreateErrorXML`, and what an indexer answers a refused request with. */
const errorXml = (code: number, description: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="${escapeXml(description)}" />`

const xmlResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { 'content-type': 'application/rss+xml', ...Object.fromEntries(new Headers(init.headers)) },
  })

const timeoutError = () => new DOMException('The operation timed out', 'TimeoutError')

// --- Per-indexer search -------------------------------------------------------------

test('A search asks one indexer through its Newznab endpoint, with the key in a header and no category', async () => {
  const { calls, fetchImpl } = recorder(() => xmlResponse(rss()))
  assert.deepEqual(await searchIndexer(SETTINGS, GEEK, { q: 'Vault Show' }, fetchImpl), [])

  const [call] = calls
  assert.equal(call.url.origin + call.url.pathname, `${PROWLARR}/2/api`)
  assert.deepEqual(Object.fromEntries(call.url.searchParams), {
    t: 'search',
    q: 'Vault Show',
    limit: '100',
    extended: '1',
  })
  assert.equal(call.headers.get('x-api-key'), KEY)
  assert.ok(!call.url.href.includes(KEY), 'the key is never in the address')
  assert.equal(call.redirect, 'error')

  // A size window is sent in whole bytes, and only the bounds that were given.
  await searchIndexer(SETTINGS, GEEK, { q: 'Vault Show', minSize: 1000.7, maxSize: 2000.2 }, fetchImpl)
  await searchIndexer(SETTINGS, GEEK, { q: 'Vault Show', maxSize: 5000 }, fetchImpl)
  assert.equal(calls[1].url.searchParams.get('minsize'), '1000')
  assert.equal(calls[1].url.searchParams.get('maxsize'), '2001')
  assert.equal(calls[2].url.searchParams.has('minsize'), false)
  assert.equal(calls[2].url.searchParams.get('maxsize'), '5000')
  for (const { url } of calls) {
    assert.equal(url.searchParams.has('cat'), false)
    assert.equal(url.searchParams.has('apikey'), false)
  }
})

test('A search keeps the URL base Prowlarr is served under', async () => {
  const { calls, fetchImpl } = recorder(() => xmlResponse(rss()))
  await searchIndexer({ baseUrl: `${PROWLARR}/prowlarr`, apiKey: KEY }, GEEK, { q: 'Show' }, fetchImpl)
  assert.equal(calls[0].url.origin + calls[0].url.pathname, `${PROWLARR}/prowlarr/2/api`)
  assert.equal(calls[0].url.searchParams.get('t'), 'search')
})

test('Search results carry files, grabs, the post date and categories, and a download link on the configured origin', async () => {
  const link = proxyLink(2, 'ZW5jcnlwdGVk+bGluaw/x==', '[Vault] Show (BD 1080p)')
  const body = rss(
    itemXml({
      title: '[Vault] Show (BD 1080p) & Extras',
      guid: 'https://geek.test/details/abc123',
      comments: 'https://geek.test/details/abc123#comments',
      link,
      size: 3_000_000_000,
      categories: [5070, 5000],
      files: 14,
      grabs: 3,
    }),
  )
  const [result, ...rest] = await searchIndexer(
    SETTINGS,
    GEEK,
    { q: 'Vault Show' },
    recorder(() => xmlResponse(body)).fetchImpl,
  )
  assert.deepEqual(rest, [])
  assert.deepEqual(result, {
    guid: 'https://geek.test/details/abc123',
    indexer_id: 2,
    indexer: 'Geek',
    title: '[Vault] Show (BD 1080p) & Extras',
    size: 3_000_000_000,
    protocol: 'usenet',
    // Prowlarr named itself localhost; only the path is kept, for the configured origin.
    download_path: link.slice('http://localhost:9696'.length),
    links: ['https://geek.test/details/abc123', 'https://geek.test/details/abc123#comments', link],
    info_url: 'https://geek.test/details/abc123#comments',
    files: 14,
    grabs: 3,
    posted_at: Date.UTC(2026, 10, 24, 17, 3, 11),
    categories: [5070, 5000],
  })
})

test('A result page link is never a download link and never carries a key', async () => {
  const body = rss(
    [
      // The GUID is the indexer's own download address, and the page link carries the indexer's key.
      itemXml({
        title: 'Keyed',
        guid: INDEXER_NZB,
        comments: `https://geek.test/details/keyed?apikey=${INDEXER_KEY}`,
        link: proxyLink(2, 'keyed', 'Keyed'),
        size: 10,
      }),
      // Nothing but Prowlarr's own download link.
      itemXml({ title: 'Proxy only', guid: proxyLink(2, 'proxy', 'Proxy'), link: proxyLink(2, 'proxy', 'Proxy') }),
      // A feed without extended attributes: the size and categories come from the plain elements.
      itemXml({
        title: 'Plain',
        guid: 'https://geek.test/details/plain',
        link: proxyLink(2, 'plain', 'Plain'),
        pubDate: 'not a date',
        size: 4096,
        categories: [5070],
        plain: true,
      }),
      // No download link at all: nothing could be fetched, so the result is dropped.
      itemXml({ title: 'Linkless', guid: 'https://geek.test/details/linkless', link: '' }),
      // No GUID: the result is still identified, without the key that its download link carries.
      itemXml({ title: 'Nameless', guid: '', link: proxyLink(2, 'nameless', 'Nameless') }),
      // A key-free indexer download address is still a download link, not a result page.
      itemXml({
        title: 'Keyless',
        guid: 'https://geek.test/getnzb/keyless.nzb',
        link: proxyLink(2, 'keyless', 'Keyless'),
      }),
    ].join(''),
  )
  const results = await searchIndexer(SETTINGS, GEEK, { q: 'x' }, recorder(() => xmlResponse(body)).fetchImpl)
  assert.deepEqual(
    results.map(result => result.title),
    ['Keyed', 'Proxy only', 'Plain', 'Nameless', 'Keyless'],
  )
  const [keyed, proxyOnly, plain, nameless, keyless] = results
  assert.equal('info_url' in keyed, false)
  assert.equal('info_url' in proxyOnly, false)
  assert.equal('info_url' in keyless, false)
  assert.equal(proxyOnly.size, null)
  assert.equal(plain.info_url, 'https://geek.test/details/plain')
  assert.equal(plain.size, 4096)
  assert.deepEqual(plain.categories, [5070])
  assert.equal('files' in plain || 'grabs' in plain || 'posted_at' in plain, false)
  assert.match(nameless.guid, /^[0-9a-f]{40}$/)
  for (const result of results) {
    assert.ok(!result.info_url?.includes(KEY) && !result.info_url?.includes(INDEXER_KEY))
    assert.ok(!/download|getnzb|\/api/.test(result.info_url ?? ''))
    assert.match(result.download_path, /^\/2\/download\?/)
  }

  // Under a URL base, a link outside it is not a download link of this Prowlarr.
  const based = await searchIndexer(
    { baseUrl: `${PROWLARR}/prowlarr`, apiKey: KEY },
    GEEK,
    { q: 'x' },
    recorder(() =>
      xmlResponse(
        rss(
          itemXml({ title: 'Outside', guid: 'a', link: proxyLink(2, 'outside', 'Outside') }) +
            itemXml({ title: 'Inside', guid: 'b', link: proxyLink(2, 'in', 'In', 'http://localhost:9696/prowlarr') }),
        ),
      ),
    ).fetchImpl,
  )
  assert.deepEqual(
    based.map(result => [result.title, result.download_path]),
    [['Inside', `/2/download?apikey=${KEY}&link=in&file=In`]],
  )
})

test('An indexer without a usable ID is never asked', async () => {
  const { calls, fetchImpl } = recorder(() => xmlResponse(rss()))
  for (const id of [0, -1, 1.5, Number.NaN]) {
    const error = await failureOf(searchIndexer(SETTINGS, { id, name: 'Geek' }, { q: 'x' }, fetchImpl))
    assert.deepEqual([error.code, error.scope], ['invalid_config', 'indexer'])
  }
  assert.equal(calls.length, 0)
})

test("A failed search throws the search step's failure as a ProwlarrError, scope and retry time kept", async () => {
  // The step classifies every answer (tests/newznab-search.test.ts); the client only passes it on.
  const limited = await failureOf(
    searchIndexer(
      SETTINGS,
      GEEK,
      { q: 'x' },
      recorder(() =>
        xmlResponse(errorXml(429, 'Query limit reached'), { status: 429, headers: { 'retry-after': '1800' } }),
      ).fetchImpl,
    ),
  )
  assert.deepEqual([limited.code, limited.scope, limited.retryAfterMs], ['rate_limited', 'indexer', 1_800_000])
  assert.match(limited.message, /Geek/)

  const refused = await failureOf(
    searchIndexer(SETTINGS, GEEK, { q: 'x' }, recorder(() => Response.json({}, { status: 401 })).fetchImpl),
  )
  assert.deepEqual([refused.code, refused.scope], ['unauthorized', 'prowlarr'])

  const timeout = await failureOf(
    searchIndexer(SETTINGS, GEEK, { q: 'x' }, recorder(() => Promise.reject(timeoutError())).fetchImpl),
  )
  assert.deepEqual([timeout.code, timeout.scope], ['timeout', 'indexer'])
})

// --- Downloads ----------------------------------------------------------------------

const RELEASE = { download_path: `/2/download?apikey=${KEY}&link=encrypted&file=Show` }
const NZB =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">\n' +
  '<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="p@test" date="1700000000" subject="Show">' +
  '<groups><group>alt.binaries.test</group></groups>' +
  '<segments><segment bytes="700000" number="1">part@test</segment></segments></file></nzb>'

/** Prowlarr redirects a Usenet download to the indexer's own link; the indexer answers as the test says. */
function redirectedDownload(indexer: () => Response | Promise<Response>) {
  return recorder(call =>
    call.url.origin === PROWLARR ? new Response(null, { status: 301, headers: { location: INDEXER_NZB } }) : indexer(),
  )
}

test('A download the indexer rate limits after the redirect fails for that indexer, with its retry time', async () => {
  const { calls, fetchImpl } = redirectedDownload(
    () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
  )
  const error = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, fetchImpl))
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.retryAfterMs, 120_000)
  assert.equal(error.scope, 'indexer')

  // Prowlarr gets its key; the indexer never does.
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.get('x-api-key'), KEY)
  assert.equal(calls[1].url.href, INDEXER_NZB)
  assert.equal(calls[1].headers.get('x-api-key'), null)
  assert.ok(!calls[1].url.href.includes(KEY))
  assert.deepEqual([...calls[1].headers.keys()], [])
})

test('Indexer statuses after the redirect say whether the indexer or only the file is the problem', async () => {
  const cases: [status: number, code: string][] = [
    [500, 'server'],
    [503, 'server'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'invalid_response'],
    [410, 'invalid_response'],
  ]
  for (const [status, code] of cases) {
    const { fetchImpl } = redirectedDownload(() => new Response('refused', { status }))
    const error = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, fetchImpl))
    assert.equal(error.code, code, `HTTP ${status}`)
    assert.equal(error.scope, 'indexer', `HTTP ${status}`)
    assert.ok(!error.message.includes(INDEXER_KEY) && !error.message.includes('geek.test'))
  }
  const gone = await failureOf(
    prowlarrDownload(SETTINGS, RELEASE, MIB, redirectedDownload(() => new Response('gone', { status: 404 })).fetchImpl),
  )
  assert.equal(gone.message, 'The indexer refused the download (HTTP 404)')
})

test('A Newznab error document sent instead of the file is a failure of the indexer, also with HTTP 200', async () => {
  const description = `Download limit reached for ${INDEXER_NZB}`
  const cases: [code: number, expected: string][] = [
    [500, 'rate_limited'],
    [501, 'rate_limited'],
    [100, 'unauthorized'],
    [300, 'server'],
  ]
  for (const [code, expected] of cases) {
    // After a redirect the indexer sends the document; without one Prowlarr passes the indexer's answer on.
    const proxied = recorder(() => xmlResponse(errorXml(code, description)))
    for (const { fetchImpl } of [redirectedDownload(() => xmlResponse(errorXml(code, description))), proxied]) {
      const error = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, fetchImpl))
      assert.equal(error.code, expected, `code ${code}`)
      assert.equal(error.scope, 'indexer', `code ${code}`)
      assert.ok(!error.message.includes(INDEXER_KEY) && !error.message.includes('geek.test'), error.message)
    }
  }
})

test("Prowlarr's own refusal of a download keeps its retry time and names the indexer or Prowlarr", async () => {
  const limited = recorder(() =>
    xmlResponse(errorXml(429, 'User configurable Indexer Grab Limit of 10 reached.'), {
      status: 429,
      headers: { 'retry-after': '3600' },
    }),
  )
  const grabLimit = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, limited.fetchImpl))
  assert.equal(grabLimit.code, 'rate_limited')
  assert.equal(grabLimit.retryAfterMs, 3_600_000)
  assert.equal(grabLimit.scope, 'indexer')
  assert.equal(limited.calls.length, 1)

  for (const status of [401, 403]) {
    const refused = await failureOf(
      prowlarrDownload(SETTINGS, RELEASE, MIB, recorder(() => new Response('no', { status })).fetchImpl),
    )
    assert.deepEqual([refused.code, refused.scope], ['unauthorized', 'prowlarr'])
  }
})

test("Timeouts and network failures are the indexer's after the redirect and Prowlarr's before it", async () => {
  const slowIndexer = await failureOf(
    prowlarrDownload(SETTINGS, RELEASE, MIB, redirectedDownload(() => Promise.reject(timeoutError())).fetchImpl),
  )
  assert.deepEqual([slowIndexer.code, slowIndexer.scope], ['timeout', 'indexer'])
  assert.match(slowIndexer.message, /Indexer/)

  const deadIndexer = await failureOf(
    prowlarrDownload(
      SETTINGS,
      RELEASE,
      MIB,
      redirectedDownload(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl,
    ),
  )
  assert.deepEqual([deadIndexer.code, deadIndexer.scope], ['network', 'indexer'])
  assert.match(deadIndexer.message, /the indexer/)

  const slowProwlarr = await failureOf(
    prowlarrDownload(SETTINGS, RELEASE, MIB, recorder(() => Promise.reject(timeoutError())).fetchImpl),
  )
  assert.deepEqual([slowProwlarr.code, slowProwlarr.scope], ['timeout', 'prowlarr'])
  assert.match(slowProwlarr.message, /Prowlarr/)

  const deadProwlarr = await failureOf(
    prowlarrDownload(SETTINGS, RELEASE, MIB, recorder(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl),
  )
  assert.deepEqual([deadProwlarr.code, deadProwlarr.scope], ['network', 'prowlarr'])
})

test('A file is returned as it was sent, whether Prowlarr proxied it or redirected to the indexer', async () => {
  // An NZB is XML too, with or without its DTD, and is never mistaken for an error document.
  for (const text of [NZB, NZB.replace(/<!DOCTYPE[^>]*>\n/, '')]) {
    const nzb = new TextEncoder().encode(text)
    assert.deepEqual(
      await prowlarrDownload(SETTINGS, RELEASE, MIB, redirectedDownload(() => new Response(nzb)).fetchImpl),
      nzb,
    )
  }
  // A .torrent file of a private tracker, which Prowlarr fetches itself.
  const torrent = new TextEncoder().encode('d4:infod6:lengthi42e4:name9:Movie.mkv12:piece lengthi1e6:pieces0:ee')
  assert.deepEqual(
    await prowlarrDownload(SETTINGS, RELEASE, MIB, recorder(() => new Response(torrent)).fetchImpl),
    torrent,
  )

  // Redirects still end at http(s) addresses, after at most three hops.
  const magnet = recorder(() => new Response(null, { status: 301, headers: { location: 'magnet:?xt=urn:btih:abc' } }))
  const notFile = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, magnet.fetchImpl))
  assert.equal(notFile.code, 'invalid_response')
  assert.equal(magnet.calls.length, 1)
  const loop = recorder(() => new Response(null, { status: 302, headers: { location: INDEXER_NZB } }))
  const tooMany = await failureOf(prowlarrDownload(SETTINGS, RELEASE, MIB, loop.fetchImpl))
  assert.deepEqual([tooMany.code, tooMany.scope], ['invalid_response', 'indexer'])
  assert.match(tooMany.message, /too many times/)
  assert.equal(loop.calls.length, 4)
})

test("A grab yields the NZB step's result, and anything but an NZB fails as the indexer's", async () => {
  const nzb = new TextEncoder().encode(NZB)
  for (const { fetchImpl } of [redirectedDownload(() => new Response(nzb)), recorder(() => new Response(nzb))])
    assert.deepEqual(await prowlarrGrabNzb(SETTINGS, RELEASE, fetchImpl), nzb)
  // The finder receives the NZB decompressed; the step itself is tested with the hash indexers.
  const compressed = recorder(() => new Response(gzipSync(nzb)))
  assert.deepEqual(await prowlarrGrabNzb(SETTINGS, RELEASE, compressed.fetchImpl), nzb)

  const limited = await failureOf(
    prowlarrGrabNzb(SETTINGS, RELEASE, redirectedDownload(() => xmlResponse(errorXml(501, 'limit'))).fetchImpl),
  )
  assert.deepEqual([limited.code, limited.scope], ['rate_limited', 'indexer'])
  const page = await failureOf(
    prowlarrGrabNzb(SETTINGS, RELEASE, recorder(() => new Response('<html><body>login</body></html>')).fetchImpl),
  )
  assert.deepEqual(
    [page.code, page.scope, page.message],
    ['invalid_response', 'indexer', 'The indexer did not send a valid NZB'],
  )
  // Over the cap as sent or only once decompressed, the file is the indexer's, also when Prowlarr passed it on.
  const oversize = () => new Response(nzb, { headers: { 'content-length': String(NZB_MAX_BYTES + 1) } })
  const bomb = () => new Response(gzipSync(new Uint8Array(NZB_MAX_BYTES + 1)))
  for (const { fetchImpl } of [redirectedDownload(oversize), recorder(oversize), recorder(bomb)]) {
    const large = await failureOf(prowlarrGrabNzb(SETTINGS, RELEASE, fetchImpl))
    assert.deepEqual(
      [large.code, large.scope, large.message],
      ['invalid_response', 'indexer', 'The indexer sent an NZB over the size limit'],
    )
  }
})

// --- Download references ------------------------------------------------------------

test('A download reference holds the link and file without the key, and rebuilds the link with the configured key', () => {
  const link = 'ZW5jcnlwdGVk+bGluaw/x=='
  const file = '[Vault] Show & Tell (BD 1080p)'
  const path = proxyLink(7, link, file).slice('http://localhost:9696'.length)
  const ref = downloadRef({ download_path: path, indexer_id: 7 })
  assert.deepEqual(ref, { indexer_id: 7, link, file })
  assert.ok(!JSON.stringify(ref).includes(KEY))

  assert.equal(downloadPathFromRef(SETTINGS, ref), path)
  // The key is the configured one, not one remembered from the link.
  const rotated = downloadPathFromRef({ baseUrl: PROWLARR, apiKey: 'rotated-key' }, ref)
  assert.equal(new URLSearchParams(rotated.split('?')[1]).get('apikey'), 'rotated-key')
  assert.ok(!rotated.includes(KEY))
  assert.deepEqual(downloadRef({ download_path: rotated, indexer_id: 7 }), ref)

  // Prowlarr's own encoding (`WebUtility.UrlEncode`) leaves a few characters bare; the values are the same.
  const bare = `/7/download?apikey=${KEY}&link=ZW5jcnlwdGVk%2BbGluaw%2Fx%3D%3D&file=%5BVault%5D+Show+%26+Tell+(BD+1080p)`
  assert.deepEqual(downloadRef({ download_path: bare, indexer_id: 7 }), ref)

  // A link without a file name keeps an empty one.
  assert.deepEqual(downloadRef({ download_path: '/7/download?link=abc', indexer_id: 7 }), {
    indexer_id: 7,
    link: 'abc',
    file: '',
  })
})

test('A download link of another form has no reference', () => {
  for (const download_path of [
    '/api/v1/indexer/7/download?link=abc&file=x',
    '/7/download',
    `/7/download?apikey=${KEY}&file=x`,
    '/7/download?link=&file=x',
    '/7/api?t=get&id=abc',
    '/other',
    '?xt=urn:btih:abc',
    '//elsewhere.test/7/download?link=abc&file=x',
  ]) {
    assert.equal(downloadRef({ download_path, indexer_id: 7 }), null, download_path)
  }
  // The link must be the result's own indexer's.
  assert.equal(downloadRef({ download_path: '/8/download?link=abc&file=x', indexer_id: 7 }), null)
  assert.throws(() => downloadPathFromRef(SETTINGS, { indexer_id: Number.NaN, link: 'abc', file: 'x' }), ProwlarrError)
})

// --- Indexer details ----------------------------------------------------------------

/** One entry of `GET /api/v1/indexer`, cut down to what the client reads. */
function indexerResource(id: number, overrides: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) {
  return {
    id,
    name: `Indexer ${id}`,
    definitionName: 'Newznab',
    implementation: 'Newznab',
    implementationName: 'Newznab',
    enable: true,
    protocol: 'usenet',
    privacy: 'private',
    capabilities: {
      supportsRawSearch: true,
      searchParams: ['q'],
      tvSearchParams: ['q', 'season', 'ep', 'tvdbId', 'imdbId'],
      movieSearchParams: ['q', 'imdbId', 'tmdbId'],
    },
    fields: [
      { order: 0, name: 'baseUrl', label: 'URL', value: 'https://geek.test', type: 'textbox' },
      { order: 1, name: 'apiKey', label: 'API Key', value: '********', type: 'textbox' },
      ...Object.entries(limits).map(([name, value], order) => ({
        order: order + 2,
        name: `baseSettings.${name}`,
        value,
      })),
    ],
    ...overrides,
  }
}

test('The indexer list carries search parameters, the disabled time and the limits per day', async () => {
  const body = [
    indexerResource(
      1,
      { status: { indexerId: 1, disabledTill: '2026-11-26T12:30:00Z', mostRecentFailure: '2026-11-26T12:00:00Z' } },
      { queryLimit: 100, grabLimit: 10, limitsUnit: 0 },
    ),
    indexerResource(2, {}, { queryLimit: 5, grabLimit: 2, limitsUnit: 1 }),
    indexerResource(3, { status: { disabledTill: 'soon' } }, { queryLimit: '4', grabLimit: 0, limitsUnit: 'Hour' }),
    indexerResource(4, { status: null }, { queryLimit: -1, grabLimit: null, limitsUnit: 'day' }),
    indexerResource(5, {}, { queryLimit: 50, limitsUnit: 7 }),
    indexerResource(6, { protocol: 'torrent', capabilities: undefined, fields: undefined }),
  ]
  const { fetchImpl } = recorder(() => Response.json(body))
  resetProwlarrRuntime()
  try {
    const [daily, hourly, mixed, unlimited, unknownUnit, bare] = await prowlarrIndexers(SETTINGS, fetchImpl, true)

    assert.deepEqual(daily.tvSearchParams, ['q', 'season', 'ep', 'tvdbid', 'imdbid'])
    assert.deepEqual(daily.movieSearchParams, ['q', 'imdbid', 'tmdbid'])
    assert.equal(daily.disabledTill, Date.UTC(2026, 10, 26, 12, 30))
    assert.equal(daily.queryLimitPerDay, 100)
    assert.equal(daily.grabLimitPerDay, 10)

    // An hourly limit is 24 times as much in a day.
    assert.equal(hourly.queryLimitPerDay, 120)
    assert.equal(hourly.grabLimitPerDay, 48)
    assert.equal('disabledTill' in hourly, false)

    assert.equal(mixed.queryLimitPerDay, 96)
    assert.equal('grabLimitPerDay' in mixed, false, 'zero is no limit')
    assert.equal('disabledTill' in mixed, false, 'an unreadable date is no date')

    assert.equal('queryLimitPerDay' in unlimited || 'grabLimitPerDay' in unlimited, false)
    assert.equal(unknownUnit.queryLimitPerDay, 50, 'an unknown unit counts as per day')
    assert.equal('grabLimitPerDay' in unknownUnit, false)

    assert.deepEqual([bare.tvSearchParams, bare.movieSearchParams], [[], []])
    assert.equal('queryLimitPerDay' in bare || 'grabLimitPerDay' in bare || 'disabledTill' in bare, false)
  } finally {
    resetProwlarrRuntime()
  }
})

// --- Tracker modes ------------------------------------------------------------------

test('Private-tracker searches use Prowlarr in every tracker mode but the public one', () => {
  const config = (tracker_mode: string, overrides: Record<string, unknown> = {}) =>
    ({
      prowlarr_enabled: true,
      prowlarr_url: PROWLARR,
      prowlarr_key: KEY,
      tracker_mode,
      ...overrides,
    }) as unknown as Config
  assert.deepEqual(privateSearchSettings(config('reachable')), { baseUrl: PROWLARR, apiKey: KEY })
  assert.deepEqual(privateSearchSettings(config('private')), { baseUrl: PROWLARR, apiKey: KEY })
  assert.equal(privateSearchSettings(config('public')), null)
  assert.equal(privateSearchSettings(config('reachable', { prowlarr_enabled: false })), null)
})
