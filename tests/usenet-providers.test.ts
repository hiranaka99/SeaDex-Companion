import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchAnimeToshoNzb, lookupAnimeTosho, testAnimeTosho } from '../server/animetosho.js'
import { fetchAmeNZBNzb, lookupAmeNZB, testAmeNZB } from '../server/amenzb.js'
import { LOOKUP_MAX_BYTES, NZB_MAX_BYTES, validateNzbBytes } from '../server/usenet-provider-types.js'
import type { ProviderSettings, UsenetMatch } from '../server/usenet-provider-types.js'

const HASH = 'd4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d'
const ANIMETOSHO: ProviderSettings = { baseUrl: 'https://feed.animetosho.net' }
const API_KEY = 'unit-test-key-4f9c'
const AMENZB: ProviderSettings = { baseUrl: 'https://amenzb.example', apiKey: API_KEY }
const ANIMETOSHO_MATCH: UsenetMatch = { provider: 'animetosho', entry_id: '42', source_hash: HASH, files_complete: false }
const AMENZB_MATCH: UsenetMatch = { provider: 'amenzb', entry_id: 'abc123def', source_hash: HASH, files_complete: false }

const NZB_DOCTYPE = '<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">'
const NZB_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' + NZB_DOCTYPE + '\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n'
  + '  <file subject="Show S01E01 [1080p]" poster="a@example.com" date="1767225600">\n'
  + '    <groups><group>alt.binaries</group></groups>\n'
  + '    <segments><segment bytes="500" number="1">aaa111@example.com</segment>\n'
  + '      <segment bytes="500" number="2">bbb222@example.com</segment></segments>\n'
  + '  </file>\n</nzb>\n'
const NZB_BYTES = new TextEncoder().encode(NZB_XML)

interface Call { url: string; headers: Record<string, string>; body: unknown }

/** Deterministic transport seam: every request is recorded, nothing touches a network. */
function recorder(respond: (call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    }
    calls.push(call)
    return await respond(call, init)
  }
  return { calls, fetchImpl }
}

function streamBytes(total: number, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkSize)
  let remaining = total
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) { controller.close(); return }
      const size = Math.min(chunkSize, remaining)
      remaining -= size
      controller.enqueue(chunk.slice(0, size))
    },
  })
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const gzip = new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array>
  const inflating = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
  return new Uint8Array(await new Response(inflating.pipeThrough(gzip)).arrayBuffer())
}

/** Byte bodies go through a stream so the provider's reader path is the one under test. */
function bytesResponse(bytes: Uint8Array, init?: ResponseInit): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }), init)
}

function newznab(items: string, extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://newznab.in/xmlns/newznab/"><channel>\n<title>AmeNZB</title>\n${extra}${items}</channel>\n</rss>\n`
}

function itemXml(title: string, guid: string, hash?: string): string {
  const attributes = [`<newznab:attr name="guid" value="${guid}"/>`, `<newznab:attr name="size" value="987654"/>`]
  if (hash) attributes.push(`<newznab:attr name="info_hash" value="${hash}"/>`)
  const href = `https://amenzb.example/getnzb/${guid}.nzb/${API_KEY}`
  return `<item><title>${title}</title><link>${href}</link>`
    + `<enclosure url="${href}" length="987654" type="application/x-nzb"/>${attributes.join('')}</item>`
}

const xmlResponse = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/xml' } })

// --- AnimeTosho -----------------------------------------------------------------

test('AnimeTosho matches a hash with case-insensitive agreement and a full file manifest', async () => {
  const entry = {
    id: 1234,
    info_hash: HASH.toUpperCase(),
    nzb_url: 'https://feed.animetosho.net/nzb/1234',
    title: 'Show S01E01',
    torrent_name: 'Show [S01] 01 [1080p]',
    is_batch: false,
    num_files: 2,
    total_size: 123456789,
    status: 'complete',
    deleted: false,
    files: [
      { filename: 'Show 01.mkv', name: 'Show 01.mkv', size: 100, processed: true },
      { name: 'Show 01.nfo', size: 20, processed: false },
    ],
  }
  const { calls, fetchImpl } = recorder(() => Response.json(entry))
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH.toUpperCase(), fetchImpl)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://feed.animetosho.net/json?show=torrent&hash=${HASH}`)
  assert.equal(calls[0].headers.accept, 'application/json')
  assert.ok(lookup.kind === 'match')
  assert.deepEqual(lookup.match, {
    provider: 'animetosho',
    entry_id: '1234',
    source_hash: HASH,
    title: 'Show S01E01',
    nzb_name: 'Show [S01] 01 [1080p]',
    total_bytes: 123456789,
    file_count: 2,
    files: [{ name: 'Show 01.mkv', size: 100 }, { name: 'Show 01.nfo', size: 20 }],
    files_complete: true,
  })
})

test('AnimeTosho cannot redirect a lookup onto a different source hash', async () => {
  const intruder = 'a'.repeat(40)
  const { fetchImpl } = recorder(() => Response.json({
    id: 7, info_hash: intruder.toUpperCase(), nzb_url: 'https://feed.animetosho.net/nzb/7', status: 'complete',
  }))
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, fetchImpl)
  assert.deepEqual(lookup, { kind: 'failed', code: 'invalid_response', message: 'AnimeTosho reported a different source hash' })
  assert.ok(!JSON.stringify(lookup).includes(intruder), 'the mismatched hash must not be echoed')
})

test('AnimeTosho malformed, array and HTML bodies fail as invalid responses', async () => {
  const truncated = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('{"id":', { headers: { 'content-type': 'application/json' } })).fetchImpl)
  assert.ok(truncated.kind === 'failed' && truncated.code === 'invalid_response')
  const array = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json([{ id: 1 }])).fetchImpl)
  assert.ok(array.kind === 'failed' && array.code === 'invalid_response')
  const html = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('<!DOCTYPE html><html><body>Server Error</body></html>', { headers: { 'content-type': 'text/html' } })).fetchImpl)
  assert.ok(html.kind === 'failed' && html.code === 'invalid_response')
  if (html.kind === 'failed') assert.ok(!html.message.includes('<'), 'provider markup stays out of messages')
})

test('AnimeTosho 404, rate limit, 5xx and transport failures stay distinct', async () => {
  assert.deepEqual(await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('', { status: 404 })).fetchImpl), { kind: 'no_match' })

  const rateLimited = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('slow down', { status: 429 })).fetchImpl)
  assert.ok(rateLimited.kind === 'failed' && rateLimited.code === 'rate_limited')

  const server = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('unavailable', { status: 503 })).fetchImpl)
  assert.ok(server.kind === 'failed' && server.code === 'server')

  const clientError = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response('bad request', { status: 400 })).fetchImpl)
  assert.ok(clientError.kind === 'failed' && clientError.code === 'invalid_response')

  const network = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(async () => { throw new TypeError('fetch failed') }).fetchImpl)
  assert.ok(network.kind === 'failed' && network.code === 'network')
})

test('An AnimeTosho entry without an NZB URL is still processing', async () => {
  const entry = { id: 55, info_hash: HASH, nzb_url: null, title: 'Show S01E02', status: 'processing', deleted: false, num_files: 1, total_size: 10 }
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json(entry)).fetchImpl)
  assert.deepEqual(lookup, { kind: 'processing', provider: 'animetosho', entry_id: '55', source_hash: HASH, title: 'Show S01E02' })
})

test('An AnimeTosho NZB is usable before unrelated processing completes', async () => {
  const entry = {
    id: 9, info_hash: HASH, nzb_url: 'https://feed.animetosho.net/nzb/9', status: 'processing', deleted: false,
    torrent_name: 'Show 01', total_size: 5000, num_files: 3, files: [{ name: 'Show 01.mkv', size: 1 }],
  }
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json(entry)).fetchImpl)
  assert.ok(lookup.kind === 'match')
  assert.equal(lookup.match.entry_id, '9')
  assert.equal(lookup.match.nzb_name, 'Show 01')
  assert.equal(lookup.match.total_bytes, 5000)
  assert.equal(lookup.match.files_complete, false)
  assert.equal(lookup.match.files, undefined, 'an incomplete manifest is never reported as complete')
})

test('AnimeTosho never labels a filtered or truncated file manifest complete', async () => {
  const valid = { name: 'Show 01.mkv', size: 100 }
  const malformed = [null, {}, { name: ' ', size: 1 }, { name: 'bad.mkv', size: -1 }, { name: 'bad.mkv', size: null }, { name: 'bad.mkv', size: 1.5 }]
  for (const invalid of malformed) {
    const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json({
      id: 9, info_hash: HASH, nzb_url: '/nzb/9', num_files: 2, files: [valid, invalid],
    })).fetchImpl)
    assert.ok(lookup.kind === 'match')
    assert.equal(lookup.match.files_complete, false)
    assert.equal(lookup.match.files, undefined)
    assert.equal(lookup.match.file_count, 2)
  }
  const truncated = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json({
    id: 9, info_hash: HASH, nzb_url: '/nzb/9', num_files: 3, files: [valid],
  })).fetchImpl)
  assert.ok(truncated.kind === 'match')
  assert.equal(truncated.match.files_complete, false)
  assert.equal(truncated.match.files, undefined)
  assert.equal(truncated.match.file_count, 3)
})

test('AnimeTosho deleted and skipped entries are not downloadable', async () => {
  const deleted = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json({ id: 12, info_hash: HASH, deleted: true, nzb_url: 'https://feed.animetosho.net/nzb/12' })).fetchImpl)
  assert.deepEqual(deleted, { kind: 'deleted', provider: 'animetosho', entry_id: '12' })

  const skipped = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json({ id: 13, info_hash: HASH, status: 'skipped', nzb_url: 'https://feed.animetosho.net/nzb/13', deleted: false })).fetchImpl)
  assert.deepEqual(skipped, { kind: 'no_match' })
})

test('AnimeTosho rejects a non-numeric entry id that no NZB URL could be derived for', async () => {
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => Response.json({ id: 'abc/../def', info_hash: HASH, nzb_url: 'https://feed.animetosho.net/nzb/abc', status: 'complete' })).fetchImpl)
  assert.ok(lookup.kind === 'failed' && lookup.code === 'invalid_response')
})

test('The AnimeTosho capability probe requires an XML document, not an HTML page', async () => {
  const caps = '<?xml version="1.0" encoding="UTF-8"?><caps version="1.0"><server site="feed.animetosho.net" version="1.0"><limits maxmem="512 MB"/></server></caps>'
  const ok = recorder(() => xmlResponse(caps))
  await testAnimeTosho(ANIMETOSHO, ok.fetchImpl)
  assert.equal(ok.calls[0].url, 'https://feed.animetosho.net/api?t=caps')

  const doctype = recorder(() => new Response('<!DOCTYPE html><html><body>Feed temporarily down</body></html>', { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(testAnimeTosho(ANIMETOSHO, doctype.fetchImpl), /DTD or entity/)

  const bare = recorder(() => new Response('<html><body>Feed temporarily down</body></html>', { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(testAnimeTosho(ANIMETOSHO, bare.fetchImpl), /unexpected document root/)

  await assert.rejects(testAnimeTosho(ANIMETOSHO, recorder(() => new Response('nope', { status: 503 })).fetchImpl), /HTTP 503/)
})

test('AnimeTosho NZB retrieval derives its URL on the configured origin', async () => {
  const { calls, fetchImpl } = recorder(() => bytesResponse(NZB_BYTES, { headers: { 'content-type': 'application/x-nzb' } }))
  const bytes = await fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, fetchImpl)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://feed.animetosho.net/nzb/42')
  assert.deepEqual(bytes, NZB_BYTES)
})

test('AnimeTosho NZB retrieval refuses entry ids that are not plain ids', async () => {
  for (const entry_id of ['42/../evil', 'https://storage.example/nzb/1', '', '4n;rm']) {
    const { calls, fetchImpl } = recorder(() => bytesResponse(NZB_BYTES))
    await assert.rejects(fetchAnimeToshoNzb(ANIMETOSHO, { ...ANIMETOSHO_MATCH, entry_id }, fetchImpl), /not usable/)
    assert.equal(calls.length, 0, 'no request may leave for an unusable reference')
  }
})

test('A file-compressed AnimeTosho NZB is inflated exactly once', async () => {
  const compressed = await gzipBytes(NZB_BYTES)
  assert.equal(compressed[0], 0x1f)
  assert.equal(compressed[1], 0x8b)
  const { fetchImpl } = recorder(() => bytesResponse(compressed, { headers: { 'content-encoding': 'gzip', 'content-type': 'application/x-nzb' } }))
  assert.deepEqual(await fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, fetchImpl), NZB_BYTES)
})

test('AnimeTosho NZB retrieval rejects HTML and non-NZB XML before submission', async () => {
  await assert.rejects(
    fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, recorder(() => new Response('<!DOCTYPE html><html><body>gone</body></html>')).fetchImpl),
    /DTD or entity|empty/,
  )
  await assert.rejects(
    fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, recorder(() => new Response('<error code="404" description="not found"/>')).fetchImpl),
    /wrong root element/,
  )
  await assert.rejects(
    fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, recorder(() => new Response(NZB_XML.replace(/<segment[\s>][\s\S]*?<\/segment>/g, ''))).fetchImpl),
    /no segments/,
  )
  await assert.rejects(
    fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, recorder(() => new Response('<nzb><file><segments><segment bytes="1" number="1">abc')).fetchImpl),
    /not valid XML/,
  )
  await assert.rejects(
    fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, recorder(() => new Response('', { status: 404 })).fetchImpl),
    /HTTP 404/,
  )
})

// --- AmeNZB ---------------------------------------------------------------------

test('AmeNZB matches a single hash-search result', async () => {
  const body = newznab(itemXml('Show S01E01 1080p', 'abc123def', HASH.toUpperCase()))
  const { calls, fetchImpl } = recorder(() => xmlResponse(body))
  const lookup = await lookupAmeNZB(AMENZB, HASH.toUpperCase(), fetchImpl)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://amenzb.example/api?t=search&apikey=${API_KEY}&info_hash=${HASH}`)
  assert.equal(calls[0].headers.accept, 'application/xml')
  assert.ok(lookup.kind === 'match')
  assert.deepEqual(lookup.match, {
    provider: 'amenzb',
    entry_id: 'abc123def',
    source_hash: HASH,
    title: 'Show S01E01 1080p',
    nzb_name: 'Show S01E01 1080p.nzb',
    total_bytes: 987654,
    files_complete: false,
  })
  assert.equal(lookup.match.files, undefined)
})

test('An empty AmeNZB result set is a genuine no match', async () => {
  const lookup = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab(''))).fetchImpl)
  assert.deepEqual(lookup, { kind: 'no_match' })
})

test('An AmeNZB error document with HTTP 200 is never treated as no match', async () => {
  const leaking = newznab('', `<error code="100" description="Invalid API key or IP mismatch for https://amenzb.example/api?t=search&amp;apikey=${API_KEY}&amp;info_hash=${HASH}"/>`)
  const unauthorized = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(leaking)).fetchImpl)
  assert.ok(unauthorized.kind === 'failed' && unauthorized.code === 'unauthorized')
  if (unauthorized.kind === 'failed') {
    assert.match(unauthorized.message, /Invalid API key or IP mismatch/)
    assert.ok(!unauthorized.message.includes(API_KEY), 'the provider must not get the key into a message')
    assert.ok(!unauthorized.message.includes('<'))
  }

  const rateLimited = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab('', '<error code="500" description="IP rate limited"/>'))).fetchImpl)
  assert.ok(rateLimited.kind === 'failed' && rateLimited.code === 'rate_limited')

  const params = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab('', '<error code="202" description="Unsupported parameter"/>'))).fetchImpl)
  assert.ok(params.kind === 'failed' && params.code === 'invalid_response')

  const refused = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab('', '<error code="300" description="nope"/>'))).fetchImpl)
  assert.ok(refused.kind === 'failed' && refused.code === 'server')

  const unknown = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab('', '<error code="999" description="odd"/>'))).fetchImpl)
  assert.ok(unknown.kind === 'failed' && unknown.code === 'server')
})

test('AmeNZB resolves multiple results only through a unique hash agreement', async () => {
  const ambiguous = newznab(itemXml('Show S01E01 1080p', 'abc123def') + itemXml('Show S01E01 720p', 'xyz789'))
  const unclear = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(ambiguous)).fetchImpl)
  assert.ok(unclear.kind === 'failed' && unclear.code === 'invalid_response')
  if (unclear.kind === 'failed') assert.match(unclear.message, /ambiguous provider response/)

  const resolved = newznab(itemXml('Show S01E01 720p', 'xyz789') + itemXml('Show S01E01 1080p', 'abc123def', HASH.toUpperCase()))
  const winner = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(resolved)).fetchImpl)
  assert.ok(winner.kind === 'match' && winner.match.entry_id === 'abc123def')

  const conflicting = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab(itemXml('Show S01E01', 'abc123def', 'b'.repeat(40))))).fetchImpl)
  assert.ok(conflicting.kind === 'failed' && conflicting.code === 'invalid_response')
  if (conflicting.kind === 'failed') assert.match(conflicting.message, /did not match the requested hash/)
})

test('AmeNZB derives an entry id from the getnzb URL when no guid attribute exists', async () => {
  const withExtension = itemXml('Show S01E01', 'abc123def').replace('<newznab:attr name="guid" value="abc123def"/>', '')
  const fromUrl = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(newznab(withExtension))).fetchImpl)
  assert.ok(fromUrl.kind === 'match' && fromUrl.match.entry_id === 'abc123def')

  const unusable = newznab('<item><title>Show S01E01</title><link>https://amenzb.example/</link><enclosure url="https://amenzb.example/" length="1" type="application/x-nzb"/></item>')
  const rejected = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse(unusable)).fetchImpl)
  assert.ok(rejected.kind === 'failed' && rejected.code === 'invalid_response')
})

test('AmeNZB non-RSS, HTML and oversized responses fail instead of reporting absence', async () => {
  const notRss = await lookupAmeNZB(AMENZB, HASH, recorder(() => xmlResponse('not xml at all')).fetchImpl)
  assert.ok(notRss.kind === 'failed' && notRss.code === 'invalid_response')

  const html = await lookupAmeNZB(AMENZB, HASH, recorder(() => new Response('<html><body>Blocked</body></html>')).fetchImpl)
  assert.ok(html.kind === 'failed' && html.code === 'invalid_response')

  const oversized = await lookupAmeNZB(AMENZB, HASH, recorder(() => new Response(streamBytes(LOOKUP_MAX_BYTES + 1))).fetchImpl)
  assert.ok(oversized.kind === 'failed' && oversized.code === 'invalid_response')
  if (oversized.kind === 'failed') assert.match(oversized.message, /byte limit/)

  const unauthorizedStatus = await lookupAmeNZB(AMENZB, HASH, recorder(() => new Response('', { status: 403 })).fetchImpl)
  assert.ok(unauthorizedStatus.kind === 'failed' && unauthorizedStatus.code === 'unauthorized')
})

test('AmeNZB requires a configured key and reports it as invalid configuration', async () => {
  const { calls, fetchImpl } = recorder(() => xmlResponse(newznab('')))
  const lookup = await lookupAmeNZB({ baseUrl: 'https://amenzb.example' }, HASH, fetchImpl)
  assert.deepEqual(lookup, { kind: 'failed', code: 'invalid_config', message: 'AmeNZB API key is not configured' })
  assert.equal(calls.length, 0)
})

test('The AmeNZB probe validates the key and IP through a hash search, not capabilities', async () => {
  const { calls, fetchImpl } = recorder(() => xmlResponse(newznab('')))
  await testAmeNZB(AMENZB, fetchImpl)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://amenzb.example/api?t=search&apikey=${API_KEY}&info_hash=${'0'.repeat(40)}`)

  const rejected = recorder(() => xmlResponse(newznab('', `<error code="100" description="bad key ${API_KEY}"/>`)))
  await assert.rejects(testAmeNZB(AMENZB, rejected.fetchImpl), (error: Error) => {
    assert.match(error.message, /Invalid API key or IP mismatch/)
    assert.ok(!error.message.includes(API_KEY))
    return true
  })
})

test('AmeNZB NZB retrieval uses t=get on the configured origin and rejects error documents', async () => {
  const { calls, fetchImpl } = recorder(() => bytesResponse(NZB_BYTES, { headers: { 'content-type': 'application/x-nzb' } }))
  assert.deepEqual(await fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, fetchImpl), NZB_BYTES)
  assert.equal(calls[0].url, `https://amenzb.example/api?t=get&apikey=${API_KEY}&id=abc123def`)

  const errorPage = recorder(() => new Response(newznab('', `<error code="100" description="Invalid API key ${API_KEY}"/>`)))
  await assert.rejects(fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, errorPage.fetchImpl), (error: Error) => {
    assert.match(error.message, /Invalid API key or IP mismatch/)
    assert.ok(!error.message.includes(API_KEY))
    return true
  })

  await assert.rejects(
    fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, recorder(() => new Response('<!DOCTYPE html><html><body>nope</body></html>')).fetchImpl),
    /DTD or entity|not valid XML|empty/,
  )
  await assert.rejects(fetchAmeNZBNzb(AMENZB, { ...AMENZB_MATCH, entry_id: 'abc/../' }, recorder(() => bytesResponse(NZB_BYTES)).fetchImpl), /not usable/)
  await assert.rejects(fetchAmeNZBNzb({ baseUrl: 'https://amenzb.example' }, AMENZB_MATCH, recorder(() => bytesResponse(NZB_BYTES)).fetchImpl), /API key is not configured/)
})

test('A file-compressed AmeNZB NZB is inflated exactly once', async () => {
  const compressed = await gzipBytes(NZB_BYTES)
  const { fetchImpl } = recorder(() => bytesResponse(compressed, { headers: { 'content-encoding': 'gzip' } }))
  assert.deepEqual(await fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, fetchImpl), NZB_BYTES)
})

// --- shared limits, cancellation and NZB validation ------------------------------

test('Response byte caps are enforced while streaming, for lookups and NZBs alike', async () => {
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, recorder(() => new Response(streamBytes(LOOKUP_MAX_BYTES + 1))).fetchImpl)
  assert.ok(lookup.kind === 'failed' && lookup.code === 'invalid_response')
  if (lookup.kind === 'failed') assert.match(lookup.message, /byte limit/)

  await assert.rejects(
    fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, recorder(() => new Response(streamBytes(NZB_MAX_BYTES + 1))).fetchImpl),
    /byte limit/,
  )
  await assert.rejects(
    fetchAmeNZBNzb(AMENZB, AMENZB_MATCH, recorder(() => new Response(streamBytes(NZB_MAX_BYTES + 1))).fetchImpl),
    /byte limit/,
  )
})

test('A caller abort cancels lookups and NZB fetches without inventing a result', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('cancelled by shutdown', 'AbortError'))
  const settings: ProviderSettings = { baseUrl: 'https://feed.animetosho.net', signal: controller.signal }
  const cancelling = recorder(async (_call, init) => {
    const signal = init?.signal
    if (signal?.aborted) throw signal.reason
    throw new TypeError('fetch failed')
  })

  const lookup = await lookupAnimeTosho(settings, HASH, cancelling.fetchImpl)
  assert.deepEqual(lookup, { kind: 'failed', code: 'network', message: 'lookup cancelled' })
  await assert.rejects(fetchAnimeToshoNzb(settings, ANIMETOSHO_MATCH, cancelling.fetchImpl), /NZB fetch cancelled/)
})

test('A read timeout is reported as a timeout, never as an absent source', async () => {
  const timingOut = recorder(async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  })
  const lookup = await lookupAnimeTosho(ANIMETOSHO, HASH, timingOut.fetchImpl)
  assert.deepEqual(lookup, { kind: 'failed', code: 'timeout', message: 'lookup timed out' })
  await assert.rejects(fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, timingOut.fetchImpl), /NZB fetch timed out/)
  assert.ok((await lookupAmeNZB(AMENZB, HASH, timingOut.fetchImpl)).kind === 'failed')
})

test('Credential-bearing requests never leave the configured provider origin', async () => {
  const endpoints = [
    ['https://amenzb.example', '/api'],
    ['https://amenzb.example/', '/api'],
    ['https://amenzb.example/index.php', '/index.php/api'],
    ['https://amenzb.example/tracker', '/tracker/api'],
  ] as const
  for (const [baseUrl, pathname] of endpoints) {
    const { calls, fetchImpl } = recorder(() => xmlResponse(newznab('')))
    await lookupAmeNZB({ baseUrl, apiKey: API_KEY }, HASH, fetchImpl)
    assert.equal(calls.length, 1)
    const requested = new URL(calls[0].url)
    assert.equal(requested.origin, 'https://amenzb.example')
    assert.equal(requested.pathname, pathname)
  }

  for (const baseUrl of ['', 'file:///etc/passwd', 'not a url']) {
    const { calls, fetchImpl } = recorder(() => xmlResponse(newznab('')))
    const lookup = await lookupAmeNZB({ baseUrl, apiKey: API_KEY }, HASH, fetchImpl)
    assert.ok(lookup.kind === 'failed' && lookup.code === 'invalid_config')
    assert.equal(calls.length, 0)
  }
})

test('A declared length over the cap is rejected before the body is read', async () => {
  const { calls, fetchImpl } = recorder(() => bytesResponse(NZB_BYTES, { headers: { 'content-length': String(NZB_MAX_BYTES + 1) } }))
  await assert.rejects(fetchAnimeToshoNzb(ANIMETOSHO, ANIMETOSHO_MATCH, fetchImpl), /byte limit/)
  assert.equal(calls.length, 1)
})

test('validateNzbBytes accepts nested standard NZBs and a public DTD without fetching it', () => {
  const encode = (xml: string) => new TextEncoder().encode(xml)
  assert.doesNotThrow(() => validateNzbBytes(NZB_BYTES))
  assert.doesNotThrow(() => validateNzbBytes(encode(NZB_XML.replace(NZB_DOCTYPE, ''))))
  assert.doesNotThrow(() => validateNzbBytes(encode(NZB_XML.replace(NZB_DOCTYPE, NZB_DOCTYPE.replaceAll('"', "'")))))
})

test('validateNzbBytes rejects entities, internal subsets and nonstandard DTDs', () => {
  for (const declaration of [
    '<!DOCTYPE nzb [<!ENTITY x "y">]>',
    NZB_DOCTYPE.replace('>', ' [<!ENTITY x SYSTEM "file:///secret">]>'),
    NZB_DOCTYPE.replace('>', ' []>'),
    '<!DOCTYPE nzb SYSTEM "https://attacker.example/nzb.dtd">',
    '<!ENTITY x SYSTEM "https://attacker.example/entity">',
    NZB_DOCTYPE + NZB_DOCTYPE,
  ]) {
    assert.throws(() => validateNzbBytes(new TextEncoder().encode(NZB_XML.replace(NZB_DOCTYPE, declaration))), /DTD or entity/)
  }
})

test('validateNzbBytes rejects wrong roots, malformed XML and empty or flat manifests', () => {
  const encode = (xml: string) => new TextEncoder().encode(xml)
  assert.throws(() => validateNzbBytes(encode('<html><body>nzb</body></html>')), /wrong root element/)
  assert.throws(() => validateNzbBytes(encode('<nzb/><html/>')), /wrong root element|not valid XML/)
  assert.throws(() => validateNzbBytes(encode('<nzb><file></nzb>')), /not valid XML/)
  assert.throws(() => validateNzbBytes(encode('<nzb><file><segments><segment bytes="1" number="1">a')), /not valid XML/)
  assert.throws(() => validateNzbBytes(encode('<nzb><file><segment bytes="1" number="1">a</segment></file></nzb>')), /no segments/)
  assert.throws(() => validateNzbBytes(encode('<nzb><file><segments/></file></nzb>')), /no segments/)
  assert.throws(() => validateNzbBytes(encode(NZB_XML.replaceAll(/<segment[\s>][\s\S]*?<\/segment>/g, ''))), /no segments/)
  assert.throws(() => validateNzbBytes(encode(NZB_XML.replace('aaa111@example.com', ''))), /invalid segment/)
  assert.throws(() => validateNzbBytes(encode(NZB_XML.replace('number="1"', 'number="0"'))), /invalid segment/)
  assert.throws(() => validateNzbBytes(encode(NZB_XML.replace(NZB_DOCTYPE, '').replace('<groups>', NZB_DOCTYPE + '<groups>'))), /not valid XML/)
  assert.throws(() => validateNzbBytes(new Uint8Array(0)), /empty/)
  assert.throws(() => validateNzbBytes(encode('PK\u0003\u0004binary')), /not valid XML/)
})
