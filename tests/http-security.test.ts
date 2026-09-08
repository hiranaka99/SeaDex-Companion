import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
  for (const path of ['/healthz', '/']) {
    const response = await fetch(`${baseUrl}${path}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  }
})

test('account setup, authenticated access, revocation, and login throttling work over HTTP', async () => {
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'correct horse battery staple' }),
  })
  assert.equal(setup.status, 201)
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
