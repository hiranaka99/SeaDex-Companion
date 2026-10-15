import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const image = process.argv[2] || 'seadex-companion:test'
const name = `seadex-smoke-${randomUUID()}`
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim()
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let created = false
try {
  docker('run', '-d', '--name', name, '--health-interval=1s', '--health-start-period=0s', '-p', '127.0.0.1::8080', image)
  created = true
  const address = () => `http://127.0.0.1:${JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort}`
  let base = address()
  const ready = async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) return } catch { /* Container is starting. */ }
      await pause(200)
    }
    throw new Error('Container did not become ready')
  }
  await ready()
  assert.equal(docker('exec', name, 'node', '-p', "require('node:fs').readFileSync('/proc/1/status', 'utf8').match(/^Uid:\\s+(\\d+)/m)[1]"), '1000')
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const html = await page.text()
  for (const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1])) {
    const response = await fetch(base + asset)
    assert.equal(response.status, 200, asset)
    assert.match(response.headers.get('cache-control'), /immutable/)
  }
  assert.equal((await fetch(`${base}/api/config`)).status, 401)
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'container-tester', password: 'temporary-container-fixture-password' }) })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  const request = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const saved = await request('/api/config', { sonarr_key: 'temporary-container-fixture-secret', scan_schedule: { enabled: false } })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).sonarr_key_configured, true)
  const verifyStorage = `const fs = require('node:fs'); const data = fs.readFileSync('/app/data/config.json', 'utf8'); if (data.includes('temporary-container-fixture-secret') || !JSON.parse(data)._secrets) process.exit(1); if ((fs.statSync('/app/data/.seadex-key').mode & 0o777) !== 0o600) process.exit(2);`
  docker('exec', name, 'node', '-e', verifyStorage)
  const accepted = await request('/api/download-jobs', { selections: [] })
  assert.equal(accepted.status, 202)
  const job = await accepted.json()
  assert.equal(typeof job.id, 'string')
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await (await request(`/api/download-jobs/${job.id}`)).json()
    if (status.finished) break
    await pause(100)
  }
  assert.equal((await (await request(`/api/download-jobs/${job.id}`)).json()).finished, true)
  // Restart uses the same private container filesystem; no host data is mounted.
  docker('restart', '--time', '15', name)
  base = address()
  await ready()
  const restored = await request('/api/config')
  assert.equal(restored.status, 200, 'Sessions must survive a restart')
  const config = await restored.json()
  assert.equal(config.sonarr_key, '')
  assert.equal(config.sonarr_key_configured, true)
  assert.equal(config.scan_schedule.enabled, false)
  assert.equal((await (await request(`/api/download-jobs/${job.id}`)).json()).id, job.id)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (JSON.parse(docker('inspect', name))[0].State.Health.Status === 'healthy') break
    await pause(100)
  }
  assert.equal(JSON.parse(docker('inspect', name))[0].State.Health.Status, 'healthy')
  docker('stop', '--time', '15', name)
  assert.equal(JSON.parse(docker('inspect', name))[0].State.ExitCode, 0)
  console.log('PASS Docker: non-root startup, health check, static assets, Argon2 authentication, encrypted settings, job acceptance, restart persistence, and graceful shutdown')
} catch (error) {
  if (created) process.stderr.write(docker('logs', name) + '\n')
  throw error
} finally {
  if (created) docker('rm', '--force', name)
}
