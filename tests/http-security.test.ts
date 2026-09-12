import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

let child: ChildProcessWithoutNullStreams
let baseUrl = ''
let dataDir = ''

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
    const [chunk] = await once(child.stdout, 'data') as [Buffer]
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
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
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

test('legacy scrypt credentials migrate to Argon2ID after successful login', async () => {
  const password = 'legacy correct horse battery staple'
  const salt = Buffer.alloc(16, 7)
  writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({
    version: 1,
    username: 'legacy-admin',
    salt: salt.toString('base64'),
    password_hash: scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64'),
  }))

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
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'correct horse battery staple' }),
  })
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

  const update = await fetch(`${baseUrl}/api/auth/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
    body: JSON.stringify({ username: 'administrator', current_password: 'correct horse battery staple', new_password: 'new correct horse battery staple' }),
  })
  assert.equal(update.status, 200)
  const updatedCookie = cookie(update)
  assert.equal((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: setupCookie } })).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/config`, { headers: { Cookie: updatedCookie } })).status, 200)

  const basic = `Basic ${Buffer.from('administrator:new correct horse battery staple').toString('base64')}`
  const wrongBasic = `Basic ${Buffer.from('administrator:incorrect password').toString('base64')}`
  assert.equal((await fetch(`${baseUrl}/api/webhooks/sonarr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }) })).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/webhooks/sonarr`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: wrongBasic }, body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }) })).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/webhooks/sonarr`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ eventType: 'Download', series: { id: 42 } }) })).status, 204)
  assert.equal((await fetch(`${baseUrl}/api/webhooks/sonarr`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: basic }, body: JSON.stringify({ eventType: 'SeriesAdd', series: { id: 42 } }) })).status, 202)
  const queuedStatus = await (await fetch(`${baseUrl}/api/status`, { headers: { Cookie: updatedCookie } })).json()
  assert.deepEqual(queuedStatus.webhook_scan.sources, ['sonarr'])
  assert.equal(queuedStatus.webhook_scan.queued, true)

  const invalidSchedule = await fetch(`${baseUrl}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: updatedCookie },
    body: JSON.stringify({ scan_schedule: { enabled: true, mode: 'weekly', interval_minutes: 60, times: ['03:00'], weekdays: [], timezone: 'UTC', missed_run: 'run_once' } }),
  })
  assert.equal(invalidSchedule.status, 400)
  assert.match(String((await invalidSchedule.json()).error), /at least one day/)
  assert.equal((await fetch(`${baseUrl}/api/scan/cancel`, { method: 'POST', headers: { Cookie: updatedCookie } })).status, 409)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'administrator', password: 'definitely incorrect' }),
    })
    assert.equal(failed.status, 401)
  }
  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'definitely incorrect' }),
  })
  assert.equal(limited.status, 429)
})
