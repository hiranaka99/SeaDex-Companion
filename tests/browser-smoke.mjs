// Optional browser checks with no npm browser dependency. Set BROWSER_PATH to a
// Chromium executable on non-Windows hosts; Windows defaults to Microsoft Edge.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, relative } from 'node:path'

const browserPath = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) throw new Error('Set BROWSER_PATH to a Chromium browser executable to run these checks')
const profile = mkdtempSync(join(tmpdir(), 'seadex-browser-'))
const root = resolve('static')
const release = (group, hash) => ({ kind: 'best', releaseGroup: group, tracker: 'Nyaa', quality: '1080p', tags: [], size: 200, info_hashes: [hash.repeat(40)], downloadable: true, selected_files: hash === 'a' ? ['01.mkv'] : ['01.mkv', '02.mkv'], torrent_files: [{ hash: hash.repeat(40), files: [{ name: '01.mkv', length: 120 }, { name: '02.mkv', length: 80 }] }] })
const example = { key: 'Sonarr:1:1:Example', group_id: 1, library_key: 'Sonarr:item1', title: 'Example anime', arr: 'Sonarr', season: 1, status: 'upgrade', match_status: 'matched', have: ['Old group'], local_size: 100, best_size: 200, best_group: 'Example', anilist_id: 1, image: null, banner: null, url: null, notes: null, arr_url: null, releases: [release('Example', 'a'), release('Alternative', 'b')] }
let config = { sonarr_url: 'http://sonarr.local', sonarr_key: '', sonarr_key_configured: true, radarr_url: '', radarr_key: '', radarr_key_configured: false, sonarr_category: 'sonarr-anime', radarr_category: '', qbittorrent_url: 'http://qbit.local', qbittorrent_user: 'test', qbittorrent_pass: '', qbittorrent_pass_configured: true, webhook: '', webhook_configured: false, notify_enabled: false, hidden: [], scan_schedule: { enabled: false, mode: 'interval', interval_minutes: 60, times: ['03:00'], weekdays: [0], timezone: 'UTC', missed_run: 'skip' } }
let revision = 1
let resultRequests = 0
let statusFailure = false
let configFailure = false
let logFailure = false
let saveDelay = 0
let removeFailure = false
let progressMode = 'downloading'
const originalRelease = structuredClone(example.releases[0])
const progressFor = rel => ({ ok: true, found: true, state: progressMode, progress: progressMode === 'complete' ? 1 : 0.5, downloaded: progressMode === 'complete' ? 200 : 100, total_size: 200, speed: 10, identity: JSON.stringify([rel.part || '', rel.releaseGroup, rel.tracker, [...rel.info_hashes].sort(), [...rel.selected_files].sort()]) })
let preflightMode = 'low'
const saved = []
const transfers = []
const errors = []
let fixtureDownloads = [{ hash: 'c'.repeat(40), title: 'Legacy download', name: 'Old recommendation.mkv', season: 1, part: '', releaseGroup: 'Old group', progress: 0.5, downloaded: 100, total_size: 200, speed: 0, state: 'downloading', found: true, ok: true }]
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    let response = {}
    if (path === '/api/auth/status') response = { setup_required: false, authenticated: true, username: 'Tester' }
    else if (path === '/api/config') {
      if (configFailure) { res.statusCode = 503; response = { error: 'Fixture configuration unavailable' } }
      else { if (req.method === 'POST') { await new Promise(resolve => setTimeout(resolve, saveDelay)); saved.push(body); config = { ...config, ...body } }; response = config }
    }
    else if (path === '/api/status') {
      if (statusFailure) { res.statusCode = 503; response = { error: 'Fixture server unavailable' } }
      else response = { results_revision: String(revision), running: false, progress: 0, total: 0, message: 'Idle', error: null, cancelled: false, trigger: null, source_errors: {}, last_run: '2026-10-02 12:00:00', next_check: null, webhook_scan: { queued: false, due_at: null, sources: [] } }
    }
    else if (path === '/api/results') { resultRequests++; response = { results: [example, { ...example, key: 'Sonarr:item2:1:missing', library_key: 'Sonarr:item2', group_id: null, title: 'Unmatched anime', status: 'missing', match_status: 'unmatched', anilist_id: null, best_group: null, releases: [] }], last_run: '2026-10-02 12:00:00' } }
    else if (path === '/api/download_progress/all') response = { ok: true, downloads: progressMode === 'absent' ? {} : { [example.key + '\0' + 0]: progressFor(progressMode === 'downloading' ? originalRelease : example.releases[0]) } }
    else if (path === '/api/logs') { if (logFailure) { res.statusCode = 503; response = { error: 'Fixture log unavailable' } } else response = { lines: ['2026-10-02 12:00:00 [INFO] First log entry'] } }
    else if (path === '/api/download_bulk/preflight') {
      const selected = body.selections.length > 0
      const existing = preflightMode === 'existing' && selected
      const bytes = selected && !existing ? body.selections[0].release === 1 ? 200 : 120 : 0
      if (preflightMode === 'failure') { res.statusCode = 503; response = { error: 'Fixture storage unavailable' } }
      else response = { torrents: [], new_bytes: bytes, new_torrents: selected && !existing ? 1 : 0, existing_torrents: existing ? 1 : 0, unknown_torrents: 0, approximate_torrents: 0, selected_file_count: selected && !existing ? body.selections[0].release === 1 ? 2 : 1 : 0, whole_torrents: 0, disk_space: selected && !existing ? [{ path: '/downloads', categories: ['sonarr-anime'], required_bytes: bytes, unknown_torrents: 0, free_bytes: preflightMode === 'unavailable' ? null : preflightMode === 'low' ? 100 : 1000, sufficient: preflightMode === 'unavailable' ? null : preflightMode !== 'low', reason: preflightMode === 'unavailable' ? 'Client cannot report space for this path.' : undefined }] : [] }
    }
    else if (path === '/api/download_bulk/status') response = { ok: true, finished: true, pending: [], added: [], failures: [] }
    else if (path === '/api/update-check') response = { current: '1.3.0', latest: null, url: null }
    else if (path === '/api/scanned-data') response = { results: 2, cache_entries: 1, last_run: null, cache_valid: true, results_valid: true }
    else if (path === '/api/history') response = { scans: [{ id: 'scan-1', run_at: '2026-10-02 12:00:00', trigger: 'manual', counts: { upgrade: 1 }, changes: [{ key: example.key, title: example.title, arr: 'Sonarr', season: 1, type: 'upgrade', from: 'best', to: 'upgrade', best_group: 'Example' }] }] }
    else if (path === '/api/anilist/search') response = { results: [{ id: 1, title: 'Example anime', year: 2026, format: 'TV', episodes: 12, cover: null }] }
    else if (path === '/api/downloads') response = { downloads: fixtureDownloads }
    else if (path === '/api/downloads/control') {
      if (removeFailure && body.action === 'remove') { res.statusCode = 503; response = { error: 'Fixture removal unavailable' } }
      else { transfers.push(body); fixtureDownloads = body.action === 'remove' ? fixtureDownloads.filter(download => download.hash !== body.hash) : fixtureDownloads.map(download => ({ ...download, state: body.action === 'pause' ? 'paused' : 'downloading' })); response = { ok: true } }
    }
    else { res.statusCode = 404; response = { error: 'Unknown fixture route: ' + path } }
    res.end(JSON.stringify(response))
    return
  }
  const file = resolve(root, path === '/' ? 'index.html' : path.slice(1))
  if (relative(root, file).startsWith('..') || !existsSync(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] || 'application/octet-stream')
  res.end(readFileSync(file))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let ws
let sequence = 0
const pending = new Map()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 15_000)
  pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}
const wait = async expression => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(50) }
  throw new Error('UI did not reach expected state: ' + expression)
}
const click = async text => {
  const found = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.focus(); button.click(); return true })()`)
  assert.ok(found, 'Visible button: ' + text)
  await pause(100)
}
const fill = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const key = async key => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27 }); await pause(60) }
const capture = async name => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(process.env.SCREENSHOT_DIR, name + '.png'), Buffer.from(screenshot.data, 'base64'))
}

try {
  for (let attempt = 0; attempt < 100 && !existsSync(join(profile, 'DevToolsActivePort')); attempt++) await pause(100)
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await once(ws, 'open')
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result) }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  })
  console.log('Connected to browser target: ' + target.url)
  console.log('Browser: ' + (await send('Browser.getVersion')).product)
  await send('Runtime.enable')
  await send('Page.enable')
  const navigation = await send('Page.navigate', { url: base })
  if (navigation.errorText) throw new Error(navigation.errorText)
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(`document.querySelector('h1')?.textContent === 'Anime library' && document.body.textContent.includes('Unmatched anime')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('[title="SeaDex Companion v1.3"]')].some(element => element.textContent.trim() === 'v1.3')`), 'The app displays version v1.3')
  assert.ok(await evaluate(`document.body.textContent.includes('Match needs review')`))
  await click('Table')
  assert.equal(await evaluate(`document.querySelector('tbody').rows.length`), 2)
  await capture('library-table')
  console.log('PASS compact library and distinct match status')

  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]')[1]?.checked`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Not enough space')`)
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '200 B')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1').disabled`))
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue despite')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1').disabled`))
  preflightMode = 'existing'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('No new torrents to add')`)
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '0 B')
  preflightMode = 'unavailable'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Free space unavailable')`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1').disabled`))
  preflightMode = 'failure'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Check unavailable')`)
  preflightMode = 'enough'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1000 B free')`)
  console.log('PASS bulk scoped estimate, disk warning acknowledgement, existing torrents, and unavailable checks')
  const initialRequests = resultRequests
  await pause(10_500)
  assert.equal(resultRequests, initialRequests, 'Idle status polling should not reload unchanged results')
  revision++
  example.releases[0] = release('Example', 'd')
  await pause(10_500)
  assert.equal(resultRequests, initialRequests + 1)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].checked`), 'Review choice survives new results')
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Cancel').focus()`)
  await evaluate(`document.querySelector('input[type=search]').focus()`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`), 'Modal prevents background focus')
  await key('Escape')
  console.log('PASS stable bulk selections, reduced polling, and modal background isolation')

  await click('Configuration')
  await wait(`document.querySelector('input[name=sonarr_url]')`)
  await fill('input[name=sonarr_url]', 'http://draft.local')
  await wait(`document.body.textContent.includes('Unsaved changes')`)
  await click('Scan history')
  await click('Configuration')
  assert.equal(await evaluate(`document.querySelector('input[name=sonarr_url]').value`), 'http://draft.local')
  await click('Save configuration')
  await wait(`document.body.textContent.includes('All configuration changes saved')`)
  assert.equal(saved.at(-1).sonarr_url, 'http://draft.local')
  console.log('PASS settings draft survives navigation and saves')

  await fill('input[name=sonarr_url]', 'http://next.local')
  saveDelay = 500
  await click('Save configuration')
  assert.ok(await evaluate(`document.querySelector('input[name=sonarr_url]').matches(':disabled')`), 'Settings cannot be edited during a pending save')
  await wait(`document.body.textContent.includes('All configuration changes saved')`)
  saveDelay = 0
  console.log('PASS pending settings save protects newer edits')

  await click('Scan history')
  await click('Example anime')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Correct match')`)
  assert.ok(await evaluate(`!document.querySelector('dialog[open] button[aria-label="Pause torrent"]')`), 'A changed release must not inherit the previous torrent state')
  await click('Correct match')
  await wait(`document.querySelectorAll('dialog[open]').length === 2`)
  await key('Tab')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).contains(document.activeElement)`))
  await key('Escape')
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1)
  await key('Escape')
  await wait(`document.querySelectorAll('dialog[open]').length === 0`)
  console.log('PASS history opens current details and nested modal keyboard handling')

  progressMode = 'error'
  await click('Cards')
  await wait(`document.querySelector('[aria-label="Active downloads"]')?.textContent.includes('Download error')`)
  progressMode = 'complete'
  await wait(`!document.querySelector('[aria-label="Active downloads"]')`)
  progressMode = 'absent'
  await click('Scan history')
  await click('Example anime')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Correct match')`)
  await wait(`document.querySelectorAll('dialog[open] button[title^="Send this release"]').length === 2 && [...document.querySelectorAll('dialog[open] button[title^="Send this release"]')].every(button => !button.disabled)`)
  await key('Escape')
  await wait(`document.querySelectorAll('dialog[open]').length === 0`)
  console.log('PASS release identity changes, download errors, and removal of completed torrents')

  logFailure = true
  await click('Server log')
  await wait(`document.body.textContent.includes('Could not update logs')`)
  logFailure = false
  await click('Retry')
  await wait(`document.querySelector('pre')?.textContent.includes('First log entry')`)
  assert.ok(await evaluate(`!document.body.textContent.includes('Could not update logs')`))
  console.log('PASS visible log failure and recovery')

  await click('Downloads')
  await wait(`document.body.textContent.includes('Legacy download')`)
  await capture('downloads')
  await evaluate(`document.querySelector('button[aria-label="Pause Legacy download"]').click()`)
  await wait(`document.querySelector('button[aria-label="Resume Legacy download"]')`)
  await evaluate(`document.querySelector('button[aria-label="Remove Legacy download"]').click()`)
  removeFailure = true
  await click('Remove torrent')
  await wait(`document.querySelector('dialog[open] section > p[role=alert]')?.textContent.includes('Fixture removal unavailable')`)
  await click('Cancel')
  removeFailure = false
  await evaluate(`document.querySelector('button[aria-label="Remove Legacy download"]').click()`)
  assert.ok(await evaluate(`!document.querySelector('dialog[open] section > p[role=alert]')`), 'Reopened confirmation clears the previous error')
  await click('Remove torrent')
  await wait(`document.body.textContent.includes('No app-added torrents')`)
  assert.equal(transfers.at(-1).delete_files, false)
  console.log('PASS stable download controls and file-preserving removal')

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`location.hash = 'anime'`)
  await pause(300)
  assert.ok(await evaluate(`document.querySelector('nav[aria-label="Mobile navigation"]').getBoundingClientRect().width <= 390`))
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), 'Mobile page has no horizontal overflow')
  await capture('mobile-library')
  statusFailure = true
  await pause(10_500)
  await wait(`document.body.textContent.includes('Connection lost')`)
  statusFailure = false
  await click('Retry connection')
  await wait(`!document.body.textContent.includes('Connection lost')`)
  assert.deepEqual(errors, [], 'No unhandled browser exceptions')
  console.log('PASS mobile layout and visible connection failure/recovery')

  configFailure = true
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('h1')?.textContent === 'Anime library'`)
  await click('Config')
  await wait(`document.body.textContent.includes('Could not load configuration')`)
  configFailure = false
  await click('Retry')
  await wait(`document.querySelector('input[name=sonarr_url]')`)
  console.log('PASS configuration loading failure and retry')
} catch (error) {
  console.error(error)
  if (ws?.readyState === WebSocket.OPEN) console.error(await evaluate(`({ text: document.body?.innerText, url: location.href })`).catch(() => null))
  console.error('Browser exceptions:', errors)
  throw error
} finally {
  if (ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
  ws?.close()
  if (browser.exitCode === null) { browser.kill(); await once(browser, 'exit') }
  await new Promise(resolve => server.close(resolve))
  // The browser can briefly retain profile handles after its main process exits.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  catch {
    if (process.platform !== 'win32' || dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('seadex-browser-')) throw new Error('Unexpected browser profile cleanup target')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath '${profile.replaceAll("'", "''")}' -Recurse -Force -ErrorAction Stop`], { windowsHide: true })
  }
}
