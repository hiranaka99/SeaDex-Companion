import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { sendJson } from '../server/http-response.js'

let child: ChildProcessWithoutNullStreams
let baseUrl = ''
let dataDir = ''
/** Large and repetitive enough to be worth compressing. */
const SCRIPT = "console.log('SeaDex Companion');\n".repeat(200)
const FONT = Buffer.alloc(4096, 'font-table-data ')

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port')
  server.close()
  await once(server, 'close')
  return address.port
}

async function waitForStartup(): Promise<void> {
  for (;;) {
    const [chunk] = (await once(child.stdout, 'data')) as [Buffer]
    if (chunk.toString('utf8').includes('Server listening on')) return
  }
}

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')
  assert.ok(value, 'response should set a session cookie')
  return value.split(';', 1)[0]
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'seadex-http-'))
  const staticDir = join(dataDir, 'static')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Test</title>')
  mkdirSync(join(staticDir, 'assets'))
  mkdirSync(join(staticDir, 'fonts'))
  writeFileSync(join(staticDir, 'assets', 'app-0a1b2c3d.js'), SCRIPT)
  writeFileSync(join(staticDir, 'fonts', 'text.ttf'), FONT)
  writeFileSync(
    join(dataDir, 'auth-artwork.json'),
    JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      covers: [1, 2, 3].map(id => `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/${id}.jpg`),
    }),
  )
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, DATA_DIR: dataDir, STATIC_DIR: staticDir, PORT: String(port) },
    stdio: 'pipe',
  })
  await waitForStartup()
})

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('health and application responses carry browser security headers', async () => {
  for (const path of ['/healthz', '/api/auth/status']) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  }
})

test('sign-in artwork is public and contains only cached cover URLs', async () => {
  const response = await fetch(`${baseUrl}/api/auth/artwork`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    covers: [1, 2, 3].map(id => `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/${id}.jpg`),
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('non-object JSON request bodies are rejected cleanly', async () => {
  for (const body of ['null', '[]', '"string"', '7']) {
    const response = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(response.status, 400)
    assert.match(String((await response.json()).error), /JSON object/)
  }
})

test('static HEAD responses include browser security headers and no response body', async () => {
  const response = await fetch(`${baseUrl}/`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/html/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await response.text(), '')
})

test('legacy scrypt credentials migrate to Argon2ID after successful login', async () => {
  const password = 'legacy correct horse battery staple'
  const salt = Buffer.alloc(16, 7)
  writeFileSync(
    join(dataDir, 'auth.json'),
    JSON.stringify({
      version: 1,
      username: 'legacy-admin',
      salt: salt.toString('base64'),
      password_hash: scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString(
        'base64',
      ),
    }),
  )

  const legacyLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'legacy-admin', password }),
  })
  assert.equal(legacyLogin.status, 200)

  const migrated = JSON.parse(readFileSync(join(dataDir, 'auth.json'), 'utf8')) as Record<string, unknown>
  assert.equal(migrated.version, 2)
  assert.equal(migrated.username, 'legacy-admin')
  assert.match(String(migrated.password_hash), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  assert.equal(migrated.salt, undefined)

  const migratedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'legacy-admin', password }),
  })
  assert.equal(migratedLogin.status, 200)
  rmSync(join(dataDir, 'auth.json'))
})

test('account setup, authenticated access, revocation, and login throttling work over HTTP', async () => {
  const setups = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(`${baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'administrator', password: 'correct horse battery staple' }),
      }),
    ),
  )
  assert.deepEqual(setups.map(response => response.status).sort(), [201, 409])
  const setup = setups.find(response => response.status === 201)!
  assert.equal(setup.status, 201)
  const stored = JSON.parse(readFileSync(join(dataDir, 'auth.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored.version, 2)
  assert.match(String(stored.password_hash), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  assert.equal(stored.salt, undefined)
  const setupCookie = cookie(setup)
  assert.match(setup.headers.get('set-cookie') || '', /HttpOnly/)
  assert.match(setup.headers.get('set-cookie') || '', /SameSite=Strict/)

  const unauthenticated = await fetch(`${baseUrl}/api/config`)
  assert.equal(unauthenticated.status, 401)

  const firstSession = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: setupCookie } })
  assert.equal(firstSession.status, 200)

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'correct horse battery staple' }),
  })
  assert.equal(login.status, 200)
  const secondCookie = cookie(login)

  const [update, racingLogin] = await Promise.all([
    fetch(`${baseUrl}/api/auth/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
      body: JSON.stringify({
        username: 'administrator',
        current_password: 'correct horse battery staple',
        new_password: 'new correct horse battery staple',
      }),
    }),
    fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'administrator', password: 'correct horse battery staple' }),
    }),
  ])
  assert.equal(update.status, 200)
  assert.ok([200, 401].includes(racingLogin.status))
  if (racingLogin.status === 200)
    assert.equal((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie(racingLogin) } })).status, 401)
  const updatedCookie = cookie(update)
  assert.equal((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: setupCookie } })).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: updatedCookie } })).status, 200)

  const basic = `Basic ${Buffer.from('administrator:new correct horse battery staple').toString('base64')}`
  const wrongBasic = `Basic ${Buffer.from('administrator:incorrect password').toString('base64')}`
  assert.equal(
    (
      await fetch(`${baseUrl}/api/webhooks/sonarr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }),
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await fetch(`${baseUrl}/api/webhooks/sonarr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: wrongBasic },
        body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }),
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await fetch(`${baseUrl}/api/webhooks/sonarr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basic },
        body: JSON.stringify({ eventType: 'Download', series: { id: 42 } }),
      })
    ).status,
    204,
  )
  assert.equal(
    (
      await fetch(`${baseUrl}/api/webhooks/sonarr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basic },
        body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }),
      })
    ).status,
    202,
  )
  const queuedStatus = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: updatedCookie } })).json()
  assert.deepEqual(queuedStatus.webhook_scan.sources, ['sonarr'])
  assert.equal(queuedStatus.webhook_scan.queued, true)
  assert.equal(queuedStatus.last_run, null)

  const invalidSchedule = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: updatedCookie },
    body: JSON.stringify({
      scan_schedule: {
        enabled: true,
        mode: 'weekly',
        interval_minutes: 60,
        times: ['03:00'],
        weekdays: [],
        timezone: 'UTC',
        missed_run: 'run_once',
      },
    }),
  })
  assert.equal(invalidSchedule.status, 400)
  assert.match(String((await invalidSchedule.json()).error), /at least one day/)
  assert.equal(
    (await fetch(`${baseUrl}/api/scan/cancel`, { method: 'POST', headers: { Cookie: updatedCookie } })).status,
    409,
  )

  writeFileSync(
    join(dataDir, 'last_results.json'),
    JSON.stringify({
      results: [1, 2].map(season => ({
        key: `Sonarr:10:${season}`,
        library_key: 'Sonarr:item10',
        arr: 'Sonarr',
        title: 'Anime',
        season,
        releases: [],
      })),
    }),
  )
  const changeKey = JSON.stringify(['Sonarr:item10', 1])
  const change = {
    id: 'observed-change',
    kind: 'alternative',
    description: 'New alternative: Group B',
    detected_at: '2026-11-04T12:00:00.000Z',
  }
  writeFileSync(
    join(dataDir, 'release_changes.json'),
    JSON.stringify({ [changeKey]: [change, { ...change, id: 'newer-change' }] }),
  )
  const readResults = async () =>
    (await (await fetch(`${baseUrl}/api/results`, { headers: { Cookie: updatedCookie } })).json()).results
  assert.equal((await readResults())[0].unseen_changes.length, 2)
  const reviewChanges = (ids: unknown, authenticated = true) =>
    fetch(`${baseUrl}/api/release-changes/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: updatedCookie } : {}) },
      body: JSON.stringify({ ids }),
    })
  assert.equal((await reviewChanges([change.id], false)).status, 401)
  assert.equal((await reviewChanges('all')).status, 400)
  assert.equal((await reviewChanges([null])).status, 400)
  const revisionBeforeReview = (
    await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: updatedCookie } })).json()
  ).results_revision
  assert.deepEqual(await (await reviewChanges([change.id])).json(), { ok: true, reviewed: 1 })
  assert.deepEqual(
    (await readResults())[0].unseen_changes.map((entry: { id: string }) => entry.id),
    ['newer-change'],
  )
  const revisionAfterReview = (
    await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: updatedCookie } })).json()
  ).results_revision
  assert.notEqual(
    revisionBeforeReview,
    revisionAfterReview,
    'Other sessions reload reviewed changes on their next status poll',
  )
  const restoreChanges = (changes: unknown, authenticated = true) =>
    fetch(`${baseUrl}/api/release-changes/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: updatedCookie } : {}) },
      body: JSON.stringify({ changes }),
    })
  assert.equal((await restoreChanges([{ key: changeKey, change }], false)).status, 401)
  assert.equal((await restoreChanges('all')).status, 400)
  assert.equal((await restoreChanges([{ key: changeKey, change: { ...change, kind: 'invented' } }])).status, 400)
  assert.equal((await restoreChanges([{ key: '', change }])).status, 400)
  assert.deepEqual(await (await restoreChanges([{ key: changeKey, change }])).json(), { ok: true, restored: 1 })
  assert.deepEqual(
    (await readResults())[0].unseen_changes.map((entry: { id: string }) => entry.id).sort(),
    ['newer-change', 'observed-change'],
    'Undo puts the reviewed change back as unseen',
  )
  const match = (body: unknown, authenticated = true) =>
    fetch(`${baseUrl}/api/mapping-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: updatedCookie } : {}) },
      body: JSON.stringify(body),
    })
  assert.equal((await match({ library_key: 'Sonarr:item10', season: 2, anilist_ids: [200] }, false)).status, 401)
  assert.equal((await match({ library_key: 'Sonarr:item10', anilist_id: 100 })).status, 200)
  assert.equal((await match({ library_key: 'Sonarr:item10', season: 2, anilist_ids: [201, 200] })).status, 200)
  let rules = JSON.parse(readFileSync(join(dataDir, 'user_rules.json'), 'utf8'))
  assert.deepEqual(rules.mappings, { 'Sonarr:item10': 100 }, 'Season corrections preserve show-level matches')
  assert.deepEqual(rules.season_mappings, { 'Sonarr:item10:2': [201, 200] })
  for (const ids of [[], [0], [-1], [1.5], ['200'], [200, 200], Array.from({ length: 21 }, (_, index) => index + 1)]) {
    assert.equal((await match({ library_key: 'Sonarr:item10', season: 2, anilist_ids: ids })).status, 400)
  }
  for (const season of [0, -1, 1.5, '2', null]) {
    assert.equal((await match({ library_key: 'Sonarr:item10', season, anilist_ids: [200] })).status, 400)
  }
  assert.equal((await match({ library_key: 'Sonarr:item10', season: 3, anilist_ids: [200] })).status, 404)
  assert.equal((await match({ library_key: 'Sonarr:item99', season: 2, anilist_ids: [200] })).status, 404)
  assert.equal((await match({ library_key: 'Sonarr:item10', season: 2, anilist_ids: null })).status, 200)
  rules = JSON.parse(readFileSync(join(dataDir, 'user_rules.json'), 'utf8'))
  assert.deepEqual(rules.season_mappings, {})
  assert.deepEqual(
    rules.mappings,
    { 'Sonarr:item10': 100 },
    'Restoring automatic matching only removes the selected season rule',
  )

  const failures = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'administrator', password: 'definitely incorrect' }),
      }),
    ),
  )
  assert.deepEqual(failures.map(response => response.status).sort(), [401, 401, 401, 401, 401, 429, 429, 429])
  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'definitely incorrect' }),
  })
  assert.equal(limited.status, 429)
})

test('malformed request targets return 400 without terminating the server', async () => {
  for (const path of ['//[invalid', 'http://[invalid']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(baseUrl, { path }, response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      request.once('error', reject)
      request.end()
    })
    assert.equal(status, 400)
    assert.equal((await fetch(baseUrl + '/healthz')).status, 200)
    assert.equal(child.exitCode, null)
  }
})

test('built files are compressed, and unchanged ones are not downloaded again', async () => {
  const script = await fetch(`${baseUrl}/assets/app-0a1b2c3d.js`, { headers: { 'Accept-Encoding': 'br, gzip' } })
  assert.equal(script.headers.get('content-encoding'), 'br')
  assert.match(script.headers.get('cache-control') || '', /immutable/)
  assert.equal(script.headers.get('vary'), 'Accept-Encoding')
  assert.ok(Number(script.headers.get('content-length')) < SCRIPT.length / 4, 'The compressed script is far smaller')
  assert.equal(await script.text(), SCRIPT)
  const gzipped = await fetch(`${baseUrl}/assets/app-0a1b2c3d.js`, { headers: { 'Accept-Encoding': 'gzip, br;q=0' } })
  assert.equal(gzipped.headers.get('content-encoding'), 'gzip')
  assert.equal(await gzipped.text(), SCRIPT)
  const plain = await fetch(`${baseUrl}/assets/app-0a1b2c3d.js`, { headers: { 'Accept-Encoding': 'identity' } })
  assert.equal(plain.headers.get('content-encoding'), null)
  assert.equal(plain.headers.get('content-length'), String(SCRIPT.length))
  assert.equal(await plain.text(), SCRIPT)

  const font = await fetch(`${baseUrl}/fonts/text.ttf`, { headers: { 'Accept-Encoding': 'br' } })
  assert.equal(font.headers.get('content-type'), 'font/ttf')
  assert.equal(font.headers.get('content-encoding'), 'br')
  assert.equal(font.headers.get('cache-control'), 'no-cache', 'Files that keep their name are checked on every load')
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), FONT)
  const tag = font.headers.get('etag')
  assert.ok(tag)
  const unchanged = await fetch(`${baseUrl}/fonts/text.ttf`, { headers: { 'If-None-Match': tag } })
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0)
  writeFileSync(join(dataDir, 'static', 'fonts', 'text.ttf'), Buffer.alloc(5000, 'new-font-table '))
  const replaced = await fetch(`${baseUrl}/fonts/text.ttf`, { headers: { 'If-None-Match': tag } })
  assert.equal(replaced.status, 200, 'A replaced file is downloaded even by a browser holding the old one')
  assert.equal((await replaced.arrayBuffer()).byteLength, 5000)

  const page = await fetch(`${baseUrl}/`, { headers: { 'Accept-Encoding': 'br' } })
  assert.equal(page.headers.get('content-encoding'), null, 'A tiny file is sent as it is')
  assert.equal(page.headers.get('cache-control'), 'no-cache')
  assert.equal((await fetch(`${baseUrl}/`, { headers: { 'If-None-Match': page.headers.get('etag')! } })).status, 304)
})

test('large JSON answers are compressed for browsers that accept it', async () => {
  const large = { results: Array.from({ length: 200 }, (_, index) => ({ key: `Sonarr:${index}:1`, title: 'Anime' })) }
  const server = createHttpServer((request, response) =>
    sendJson(response, 200, request.url === '/large' ? large : { ok: true }, { 'X-Extra': 'kept' }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    for (const encoding of ['br', 'gzip']) {
      const response = await fetch(`${origin}/large`, { headers: { 'Accept-Encoding': encoding } })
      assert.equal(response.headers.get('content-encoding'), encoding)
      assert.equal(response.headers.get('vary'), 'Accept-Encoding')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('x-extra'), 'kept')
      assert.deepEqual(await response.json(), large)
    }
    const plain = await fetch(`${origin}/large`, { headers: { 'Accept-Encoding': 'identity' } })
    assert.equal(plain.headers.get('content-encoding'), null)
    assert.equal(plain.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify(large))))
    assert.deepEqual(await plain.json(), large)
    const small = await fetch(`${origin}/small`, { headers: { 'Accept-Encoding': 'br, gzip' } })
    assert.equal(small.headers.get('content-encoding'), null, 'A short answer is sent as it is')
    assert.deepEqual(await small.json(), { ok: true })
  } finally {
    server.close()
    await once(server, 'close')
  }
})
