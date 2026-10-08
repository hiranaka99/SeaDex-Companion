import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { releaseIdentity } from '../shared/releases.js'

let child: ChildProcess
let mock: Server
let dir = ''
let base = ''
let session = ''
const hashes = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(40))
let torrents = hashes.map((hash, index) => ({ hash, name: `Torrent ${index}`, progress: index === 2 ? 1 : 0.5, size: 100, dlspeed: 10, state: index === 2 ? 'uploading' : 'downloading' }))
const actions: { path: string; body: URLSearchParams }[] = []
const loginPasswords: string[] = []
const release = { kind: 'best', releaseGroup: 'New group', tracker: 'Nyaa', info_hashes: ['e'.repeat(40)], downloadable: true, size: 500, selected_files: ['01.mkv'], torrent_files: [{ hash: 'e'.repeat(40), files: [{ name: '01.mkv', length: 300 }, { name: 'extra.mkv', length: 200 }] }] }
const mergedRelease = { kind: 'best', releaseGroup: 'Merged group', tracker: 'Nyaa', info_hashes: [hashes[3], 'f'.repeat(40)], downloadable: true, size: 500, torrent_files: [{ hash: hashes[3], files: [{ name: '02.mkv', length: 100 }] }, { hash: 'f'.repeat(40), files: [{ name: '03.mkv', length: 400 }] }] }
const legacyRelease = { kind: 'best', releaseGroup: 'Legacy group', tracker: 'Nyaa', info_hashes: ['1'.repeat(40)], downloadable: true, size: 123 }
let freeSpace: unknown = 1000
let preferences = { auto_tmm_enabled: false, save_path: '/downloads', temp_path_enabled: false, temp_path: '/incomplete' }
let pathSpace: number | null = null
let storageFailure = false
const selection = { key: 'new-result', release: 0, identity: releaseIdentity(release) }

const request = (path: string, body?: unknown) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

before(async () => {
  mock = createServer(async (req, res) => {
    if (req.url === '/api/v2/auth/login') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      loginPasswords.push(new URLSearchParams(Buffer.concat(chunks).toString()).get('password') || '')
      res.setHeader('Set-Cookie', 'SID=test; Path=/'); res.end('Ok.'); return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname === '/api/v2/torrents/info') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(url.searchParams.has('hashes') ? torrents.filter(torrent => url.searchParams.get('hashes')!.split('|').includes(torrent.hash)) : torrents)); return }
    if (url.pathname === '/api/v2/app/preferences') { if (storageFailure) { res.writeHead(503); res.end(); return }; res.end(JSON.stringify(preferences)); return }
    if (url.pathname === '/api/v2/sync/maindata') { res.end(JSON.stringify({ server_state: { free_space_on_disk: freeSpace } })); return }
    if (url.pathname === '/api/v2/torrents/categories') { res.end(JSON.stringify({ 'sonarr-anime': { savePath: '/category' } })); return }
    if (url.pathname === '/api/v2/app/getFreeSpaceAtPath') { if (pathSpace === null) { res.writeHead(404); res.end() } else res.end(String(pathSpace)); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = new URLSearchParams(Buffer.concat(chunks).toString())
    actions.push({ path: req.url || '', body })
    if (req.url === '/api/v2/torrents/delete') torrents = torrents.filter(torrent => !body.get('hashes')?.split('|').includes(torrent.hash))
    res.end('Ok.')
  })
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const mockAddress = mock.address()
  assert.ok(mockAddress && typeof mockAddress !== 'string')
  dir = mkdtempSync(join(tmpdir(), 'seadex-downloads-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ qbittorrent_url: `http://127.0.0.1:${mockAddress.port}`, qbittorrent_user: 'test', qbittorrent_pass: 'test', scan_schedule: { enabled: false } }))
  writeFileSync(join(dir, 'owned_torrents.json'), JSON.stringify(hashes.slice(0, 3)))
  writeFileSync(join(dir, 'download_records.json'), JSON.stringify({ [hashes[0]]: { key: 'removed-result', release: 2, title: 'Original anime', season: 1, part: '', releaseGroup: 'Old group', tracker: 'Nyaa', size: 100 } }))
  writeFileSync(join(dir, 'last_results.json'), JSON.stringify({ results: [{ key: 'new-result', arr: 'Sonarr', title: 'New anime', status: 'upgrade', releases: [release] }, { key: 'merged-result', arr: 'Sonarr', title: 'Merged anime', status: 'upgrade', releases: [mergedRelease] }, { key: 'legacy-result', arr: 'Radarr', title: 'Legacy movie', status: 'upgrade', releases: [legacyRelease] }], last_run: '2026-10-02 12:00:00' }))
  // A temporary listener reserves an available port without assuming a deployment port.
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  base = `http://127.0.0.1:${address.port}`
  reservation.close()
  await once(reservation, 'close')
  child = spawn(process.execPath, ['dist/server/index.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(address.port) }, stdio: 'pipe', windowsHide: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/healthz')).ok) break } catch { /* startup */ }
    if (child.exitCode !== null) throw new Error('Test server exited during startup')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const setup = await request('/api/auth/setup', { username: 'tester', password: 'test password for local fixtures' })
  assert.equal(setup.status, 201)
  session = setup.headers.get('set-cookie')!.split(';')[0]
})

after(async () => {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  if (mock) await new Promise<void>(resolve => mock.close(() => resolve()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('cancellation includes orphaned and legacy app-owned torrents', async () => {
  const cancelable = await (await request('/api/download_bulk/cancelable')).json()
  assert.equal(cancelable.downloads.length, 2)
  assert.deepEqual(cancelable.downloads.map((item: { key: string }) => item.key).sort(), hashes.slice(0, 2).map(hash => `torrent:${hash}`))
})

test('status restores the last scan timestamp after a server restart', async () => {
  const status = await (await request('/api/status')).json()
  assert.equal(status.last_run, '2026-10-02 12:00:00')
})

test('integration tests honor explicitly cleared credentials while blank fields preserve saved values', async () => {
  assert.equal((await request('/api/config/test', { service: 'qbittorrent', config: { qbittorrent_pass: '' } })).status, 200)
  const cleared = await request('/api/config/test', { service: 'qbittorrent', config: { qbittorrent_pass: '', clear_secrets: ['qbittorrent_pass'] } })
  assert.equal(cleared.status, 502)
  assert.match(String((await cleared.json()).error), /password.*required/)
})

test('qBittorrent passwords preserve intentional leading and trailing spaces when tested or saved', async () => {
  const password = ' padded password '
  assert.equal((await request('/api/config/test', { service: 'qbittorrent', config: { qbittorrent_pass: password } })).status, 200)
  assert.equal(loginPasswords.at(-1), password)
  try {
    assert.equal((await request('/api/config', { qbittorrent_pass: password })).status, 200)
    assert.equal((await request('/api/config/test', { service: 'qbittorrent', config: {} })).status, 200)
    assert.equal(loginPasswords.at(-1), password)
  } finally { await request('/api/config', { qbittorrent_pass: 'test' }) }
})

test('changed release identities are rejected before any qBittorrent action', async () => {
  const count = actions.length
  const identity = releaseIdentity({ ...release, selected_files: ['02.mkv'] })
  assert.equal((await request('/api/download', { key: 'new-result', release: 0, identity })).status, 409)
  assert.equal((await request('/api/download_control', { key: 'new-result', release: 0, identity, action: 'remove', delete_files: true })).status, 409)
  assert.equal((await request('/api/download_bulk', { action: 'start', selections: [{ key: 'new-result', release: 0, identity }] })).status, 409)
  assert.equal((await request('/api/download_bulk/preflight', { selections: [{ key: 'new-result', release: 0, identity }] })).status, 409)
  assert.equal(actions.length, count)
})

test('bulk preflight uses scoped bytes, aggregates shared paths, and excludes existing hashes', async () => {
  const count = actions.length
  freeSpace = 500
  const response = await request('/api/download_bulk/preflight', { selections: [selection, { key: 'merged-result', release: 0 }] })
  assert.equal(response.status, 200)
  const estimate = await response.json()
  assert.equal(estimate.new_bytes, 700)
  assert.equal(estimate.new_torrents, 2)
  assert.equal(estimate.existing_torrents, 1)
  assert.equal(estimate.disk_space.length, 1)
  assert.equal(estimate.disk_space[0].required_bytes, 700)
  assert.equal(estimate.disk_space[0].free_bytes, 500)
  assert.equal(estimate.disk_space[0].sufficient, false)
  assert.equal(actions.length, count, 'The estimate only reads qBittorrent')
  freeSpace = 1000
})

test('disk checks preserve zero space and report invalid values or unavailable paths honestly', async () => {
  freeSpace = 0
  let estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
  assert.equal(estimate.disk_space[0].free_bytes, 0)
  assert.equal(estimate.disk_space[0].sufficient, false)
  for (const invalid of [-1, null, '', 'invalid']) {
    freeSpace = invalid
    estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
    assert.equal(estimate.disk_space[0].free_bytes, null)
    assert.equal(estimate.disk_space[0].sufficient, null)
  }
  freeSpace = 1000
  preferences.auto_tmm_enabled = true
  estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
  assert.equal(estimate.disk_space[0].path, '/category')
  assert.equal(estimate.disk_space[0].free_bytes, null, 'Default path free space cannot validate another path')
  pathSpace = 500
  estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
  assert.equal(estimate.disk_space[0].free_bytes, 500)
  assert.equal(estimate.disk_space[0].sufficient, true)
  preferences.temp_path_enabled = true
  estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
  assert.deepEqual(estimate.disk_space.map((check: { path: string }) => check.path).sort(), ['/category', '/incomplete'])
  preferences.auto_tmm_enabled = false
  preferences.temp_path_enabled = false
  pathSpace = null
  storageFailure = true
  estimate = await (await request('/api/download_bulk/preflight', { selections: [selection] })).json()
  assert.equal(estimate.new_bytes, 300)
  assert.equal(estimate.disk_space[0].path, null)
  assert.equal(estimate.disk_space[0].sufficient, null)
  storageFailure = false
})

test('different categories sharing a path are combined and unverified sizes never imply enough space', async () => {
  const estimate = await (await request('/api/download_bulk/preflight', { selections: [selection, { key: 'legacy-result', release: 0 }] })).json()
  assert.equal(estimate.new_bytes, 423)
  assert.equal(estimate.approximate_torrents, 1)
  assert.equal(estimate.disk_space.length, 1)
  assert.deepEqual(estimate.disk_space[0].categories.sort(), ['radarr-anime', 'sonarr-anime'])
  assert.equal(estimate.disk_space[0].required_bytes, 423)
  assert.equal(estimate.disk_space[0].sufficient, null)
  const empty = await (await request('/api/download_bulk/preflight', { selections: [] })).json()
  assert.equal(empty.new_torrents, 0)
  assert.deepEqual(empty.disk_space, [])
})

test('bulk adding a partially existing release only adds the missing torrent without claiming the existing one', async () => {
  const count = actions.length
  const response = await request('/api/download_bulk', { action: 'start', selections: [{ key: 'merged-result', release: 0 }] })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.count, 1)
  assert.deepEqual(result.existing, [hashes[3]])
  const additions = actions.slice(count).filter(action => action.path === '/api/v2/torrents/add')
  assert.equal(additions.length, 1)
  assert.ok(additions[0].body.get('urls')!.includes('f'.repeat(40)))
})

test('progress deduplicates hashes, waits for missing batch torrents, and preserves errors or incomplete downloads', async () => {
  const file = join(dir, 'last_results.json')
  const original = readFileSync(file)
  const originalTorrents = structuredClone(torrents)
  const fixture = (info_hashes: string[]) => writeFileSync(file, JSON.stringify({ results: [{ key: 'progress-test', title: 'Progress', arr: 'Sonarr', releases: [{ ...release, info_hashes }] }], last_run: '2026-10-02 12:00:00' }))
  const progress = async () => (await request('/api/download_progress?key=progress-test&release=0')).json()
  let invalidationUser = 'test'
  const invalidate = async () => { invalidationUser = invalidationUser === 'test' ? 'invalidate' : 'test'; await request('/api/config', { qbittorrent_user: invalidationUser }) }
  try {
    fixture([hashes[2], hashes[2]])
    let result = await progress()
    assert.equal(result.total_size, 100)
    assert.equal(result.state, 'complete')
    fixture([hashes[2], 'f'.repeat(40)])
    result = await progress()
    assert.equal(result.missing_torrents, 1)
    assert.equal(result.state, 'waiting')
    const all = await (await request('/api/download_progress/all')).json()
    assert.equal(all.downloads['progress-test\0' + 0].state, 'waiting')
    fixture([hashes[2]])
    torrents = torrents.map(torrent => torrent.hash === hashes[2] ? { ...torrent, state: 'missingFiles' } : torrent)
    await invalidate()
    assert.equal((await progress()).state, 'error')
    torrents = torrents.map(torrent => torrent.hash === hashes[2] ? { ...torrent, state: 'downloading', progress: 0.99999, size: 1_000_000 } : torrent)
    await invalidate()
    result = await progress()
    assert.equal(result.state, 'downloading')
    assert.ok(result.progress < 1)
    const cancelable = await (await request('/api/download_bulk/cancelable')).json()
    assert.ok(cancelable.downloads.some((download: { hashes: string[] }) => download.hashes.includes(hashes[2])))
  } finally { writeFileSync(file, original); torrents = originalTorrents; await invalidate() }
})

test('bulk cancellation uses stable hashes and preserves files by default after results disappear', async () => {
  writeFileSync(join(dir, 'last_results.json'), JSON.stringify({ results: [], last_run: null }))
  const response = await request('/api/download_bulk', { action: 'cancel', selections: [{ key: `torrent:${hashes[0]}`, release: 0 }] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).count, 1)
  assert.equal(actions.at(-1)!.body.get('hashes'), hashes[0])
  assert.equal(actions.at(-1)!.body.get('deleteFiles'), 'false')
  assert.ok(torrents.some(torrent => torrent.hash === hashes[3]))
  assert.ok(torrents.some(torrent => torrent.hash === hashes[2]))
})
