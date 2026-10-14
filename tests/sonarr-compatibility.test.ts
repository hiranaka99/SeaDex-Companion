import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type RequestListener } from 'node:http'
import { test } from 'node:test'
import { DEFAULT_CONFIG, localItems, testIntegration } from '../server/app.js'

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

for (const version of [4, 5]) {
  test(`scans Sonarr ${version} with its advertised API and URL base`, async () => {
    const apiVersion = version === 5 ? 'v5' : 'v3'
    const fixture = await serve((request, response) => {
      if (request.headers['x-api-key'] !== 'fixture-key') { response.writeHead(401).end(); return }
      const url = new URL(request.url!, 'http://fixture')
      if (version === 5 && url.pathname === '/sonarr/api') {
        response.writeHead(301, { Location: 'api/' }).end()
        return
      }
      if (url.pathname === '/sonarr/api' || url.pathname === '/sonarr/api/') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ current: apiVersion, deprecated: version === 5 ? ['v3'] : [] }))
        return
      }
      const prefix = `/sonarr/api/${apiVersion}`
      // A local reverse proxy canonicalizes this route with a permanent redirect.
      if (url.pathname === `${prefix}/series`) {
        response.writeHead(301, { Location: 'series/' }).end()
        return
      }
      if (url.pathname === `${prefix}/episode`) {
        response.writeHead(307, { Location: `episode/${url.search}` }).end()
        return
      }
      let data: unknown
      if (url.pathname === `${prefix}/system/status`) data = { appName: 'Sonarr', version: `${version}.0.0` }
      else if (url.pathname === `${prefix}/series/`) data = [{
        id: 10, title: 'Example', titleSlug: 'example', seasonType: 'official',
        seasons: [{ seasonNumber: 1, statistics: { sizeOnDisk: 300 } }],
      }]
      else if (url.pathname === `${prefix}/episode/` && url.searchParams.get('seriesId') === '10') data = [
        { seasonNumber: 1, episodeNumber: 1, episodeFileId: 20, airDate: '2024-01-01' },
        { seasonNumber: 1, episodeNumber: 2, episodeFileId: 0, airDate: '2024-01-08' },
      ]
      else if (url.pathname === `${prefix}/episodefile` && url.searchParams.get('seriesId') === '10') data = [{ id: 20, releaseGroup: 'IK', size: 300 }]
      else { response.writeHead(404).end(); return }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(data))
    })
    try {
      const config = { ...DEFAULT_CONFIG, sonarr_url: `${fixture.url}/sonarr/api/${apiVersion}/`, sonarr_key: 'fixture-key' }
      assert.equal(await testIntegration(config, 'sonarr'), `Connected to Sonarr ${version}.0.0`)
      const items = await localItems(config)
      assert.deepEqual(items, [{ arr: 'Sonarr', id: 10, title: 'Example', slug: 'example', seasons: {
        1: { groups: [], size: 300, episode_numbers: [1, 2], episode_count: 2, missing_episode_count: 1,
          groups_by_episode: { IK: [1] }, sizes_by_episode: { 1: 300 } },
      } }])
    } finally { await fixture.close() }
  })
}

test('Sonarr redirects cannot send credentials to another origin', async () => {
  let leakedRequests = 0
  const sink = await serve((_request, response) => { leakedRequests++; response.end('{}') })
  const fixture = await serve((_request, response) => { response.writeHead(301, { Location: `${sink.url}/api` }).end() })
  try {
    const config = { ...DEFAULT_CONFIG, sonarr_url: fixture.url, sonarr_key: 'secret' }
    await assert.rejects(() => testIntegration(config, 'sonarr'), /HTTP 301/)
    await assert.rejects(() => localItems(config), /HTTP 301/)
    assert.equal(leakedRequests, 0)
  } finally { await fixture.close(); await sink.close() }
})

test('Sonarr redirect loops fail rather than hanging the scan', async () => {
  let requests = 0
  const fixture = await serve((_request, response) => { requests++; response.writeHead(301, { Location: '/api' }).end() })
  try {
    await assert.rejects(() => localItems({ ...DEFAULT_CONFIG, sonarr_url: fixture.url, sonarr_key: 'key' }), /HTTP 301/)
    assert.ok(requests <= 6)
  } finally { await fixture.close() }
})

test('unsupported Sonarr API versions produce an actionable error', async () => {
  const fixture = await serve((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"current":"v99"}') })
  try {
    await assert.rejects(() => testIntegration({ ...DEFAULT_CONFIG, sonarr_url: fixture.url, sonarr_key: 'key' }, 'sonarr'), /Unsupported Sonarr API version: v99/)
  } finally { await fixture.close() }
})
