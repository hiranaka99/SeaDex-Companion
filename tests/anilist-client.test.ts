import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAniListClient } from '../server/anilist-client.js'
import { anilistChain, anilistSeason } from '../server/anilist.js'
import { scanRequests } from '../server/http.js'

function fixture(responses: Response[]) {
  let clock = 10_000
  let calls = 0
  const pauses: number[] = []
  const client = createAniListClient({
    now: () => clock,
    sleep: async delay => { pauses.push(delay); clock += delay },
    fetch: async () => { const response = responses[Math.min(calls++, responses.length - 1)]; return response.clone() },
  })
  return { client, pauses, calls: () => calls }
}

test('HTTP and GraphQL not-found responses are empty results without retries', async () => {
  const http = fixture([new Response('', { status: 404 })])
  assert.deepEqual(await http.client.media('query', {}), {})
  assert.equal(http.calls(), 1)
  const graphql = fixture([Response.json({ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } })])
  assert.deepEqual(await graphql.client.search('query', {}), [])
  assert.equal(graphql.calls(), 1)
})

test('missing manual AniList IDs resolve to review rather than failing title and season resolution', async () => {
  const { client } = fixture([new Response('', { status: 404 })])
  assert.deepEqual(await anilistChain('Missing', {}, { media: client.media, persist: () => {} }, 404), [])
  assert.equal(await anilistSeason([404], {}, { media: client.media, persist: () => {} }), null)
})

test('other HTTP failures and mixed GraphQL errors are not hidden as missing anime', async () => {
  const http = fixture([new Response('Unavailable', { status: 503 })])
  await assert.rejects(http.client.media('query', {}), /HTTP 503/)
  assert.equal(http.calls(), 6)
  const graphql = fixture([Response.json({ errors: [{ status: 404, message: 'Not Found.' }, { message: 'Service unavailable' }] })])
  await assert.rejects(graphql.client.media('query', {}), /Service unavailable/)
  assert.equal(graphql.calls(), 6)
})

test('burst throttling without Retry-After retries quickly and escalates repeated backoff', async () => {
  const { client, pauses, calls } = fixture([new Response('', { status: 429 }), new Response('', { status: 429 }), Response.json({ data: { Media: { id: 1 } } })])
  assert.equal((await client.media('query', {})).id, 1)
  assert.deepEqual(pauses, [3000, 6000])
  assert.equal(calls(), 3)
})

test('rate limits with Retry-After respect the server delay', async () => {
  const { client, pauses } = fixture([new Response('', { status: 429, headers: { 'Retry-After': '5' } }), Response.json({ data: { Media: { id: 1 } } })])
  await client.media('query', {})
  assert.deepEqual(pauses, [6000])
})

test('concurrent searches and scans wait after the preceding response completes', async () => {
  let clock = 10_000
  const starts: number[] = [], completions: number[] = []
  const client = createAniListClient({
    now: () => clock, sleep: async delay => { clock += delay },
    fetch: async () => {
      starts.push(clock)
      clock += 7500
      completions.push(clock)
      return Response.json({ data: { Media: { id: 1 }, Page: { media: [{ id: 1 }] } } })
    },
  })
  await Promise.all([client.media('query', {}), client.search('query', {}), client.media('query', {})])
  assert.equal(starts.length, 3)
  assert.equal(starts[1] - completions[0], 2100)
  assert.equal(starts[2] - completions[1], 2100)
})

test('queued scan cancellation is immediate and cannot let later requests overtake an active request', async () => {
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  let calls = 0, clock = 10_000
  const client = createAniListClient({
    now: () => clock, sleep: async delay => { clock += delay },
    fetch: async () => { calls++; if (calls === 1) { started(); await blocked }; return Response.json({ data: { Media: { id: calls } } }) },
  })
  const first = client.media('query', {})
  await ready
  const controller = new AbortController()
  const queued = scanRequests.run(controller.signal, () => client.media('query', {}))
  controller.abort()
  await assert.rejects(queued, { name: 'AbortError' })
  const third = client.media('query', {})
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, third])
  assert.equal(calls, 2, 'The cancelled queued request never reaches AniList')
})
