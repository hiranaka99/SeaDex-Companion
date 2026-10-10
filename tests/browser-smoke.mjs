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
const appVersion = `v${JSON.parse(readFileSync('frontend/package.json', 'utf8')).version.replace(/\.0$/, '')}`
const release = (group, hash) => ({ kind: 'best', releaseGroup: group, tracker: 'Nyaa', quality: '1080p', tags: [], size: 200, info_hashes: [hash.repeat(40)], downloadable: true, selected_files: hash === 'a' ? ['01.mkv'] : ['01.mkv', '02.mkv'], torrent_files: [{ hash: hash.repeat(40), files: [{ name: '01.mkv', length: 120 }, { name: '02.mkv', length: 80 }] }] })
const example = { key: 'Sonarr:1:1:Example', group_id: 1, library_key: 'Sonarr:item1', title: 'Example anime', arr: 'Sonarr', season: 1, status: 'upgrade', match_status: 'matched', have: ['Old group'], local_size: 100, best_size: 200, best_group: 'Example', anilist_id: 1, image: null, banner: null, url: null, notes: null, arr_url: null, releases: [release('Example', 'a'), release('Alternative', 'b')] }
let config = { sonarr_url: 'http://sonarr.local', sonarr_key: '', sonarr_key_configured: true, radarr_url: '', radarr_key: '', radarr_key_configured: false, sonarr_category: 'sonarr-anime', radarr_category: '', qbittorrent_url: 'http://qbit.local', qbittorrent_user: 'test', qbittorrent_pass: '', qbittorrent_pass_configured: true, webhook: '', webhook_configured: false, notify_enabled: false, hidden: [], scan_schedule: { enabled: false, mode: 'interval', interval_minutes: 60, times: ['03:00'], weekdays: [0], timezone: 'UTC', missed_run: 'skip' } }
let revision = 1
let resultRequests = 0
let statusFailure = false
let configFailure = false
let logFailure = false
let saveDelay = 0
let progressMode = 'downloading'
let authMode = 'authenticated'
let fixtureResults = null
let fixtureHistory = null
let fixtureLogs = ['2026-10-02 12:00:00 [INFO] First log entry']
let statusOverrides = {}
let cancelableDownloads = []
let holdBulk = false
let failBulk = false
let finishBulk = null
let bulkState = { ok: true, finished: true, pending: [], added: [], failures: [] }
const bulkRequests = []
const scanRequests = []
const originalRelease = structuredClone(example.releases[0])
const progressFor = rel => ({ ok: true, found: true, state: progressMode, progress: progressMode === 'complete' ? 1 : 0.5, downloaded: progressMode === 'complete' ? 200 : 100, total_size: 200, speed: 10, identity: JSON.stringify([rel.part || '', rel.releaseGroup, rel.tracker, [...rel.info_hashes].sort(), [...rel.selected_files].sort()]) })
let preflightMode = 'low'
const saved = []
const errors = []
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    let response = {}
    if (path === '/api/auth/status') response = { setup_required: authMode === 'setup', authenticated: authMode === 'authenticated', username: authMode === 'authenticated' ? 'Tester' : null }
    else if (path === '/api/config') {
      if (configFailure) { res.statusCode = 503; response = { error: 'Fixture configuration unavailable' } }
      else {
        if (req.method === 'POST') {
          await new Promise(resolve => setTimeout(resolve, saveDelay)); saved.push(body); config = { ...config, ...body }
          for (const name of ['sonarr_key', 'radarr_key', 'qbittorrent_pass', 'webhook']) {
            if (body[name]) config[name + '_configured'] = true
            if (body.clear_secrets?.includes(name)) config[name + '_configured'] = false
            config[name] = ''
          }
        }
        response = config
      }
    }
    else if (path === '/api/status') {
      if (statusFailure) { res.statusCode = 503; response = { error: 'Fixture server unavailable' } }
      else response = { results_revision: String(revision), running: false, progress: 0, total: 0, message: 'Idle', error: null, cancelled: false, trigger: null, source_errors: {}, last_run: '2026-10-02 12:00:00', next_check: null, webhook_scan: { queued: false, due_at: null, sources: [] }, ...statusOverrides }
    }
    else if (path === '/api/results') { resultRequests++; response = { results: fixtureResults || [example, { ...example, key: 'Sonarr:item2:1:missing', library_key: 'Sonarr:item2', group_id: null, title: 'Unmatched anime', status: 'missing', match_status: 'unmatched', anilist_id: null, best_group: null, releases: [] }], last_run: '2026-10-02 12:00:00' } }
    else if (path === '/api/download_progress/all') response = { ok: true, downloads: progressMode === 'absent' ? {} : { [example.key + '\0' + 0]: progressFor(progressMode === 'downloading' ? originalRelease : example.releases[0]) } }
    else if (path === '/api/logs') { if (logFailure) { res.statusCode = 503; response = { error: 'Fixture log unavailable' } } else response = { lines: fixtureLogs } }
    else if (path === '/api/download_bulk/preflight') {
      const selected = body.selections.length > 0
      const existing = preflightMode === 'existing' && selected
      const bytes = selected && !existing ? body.selections[0].release === 1 ? 200 : 120 : 0
      if (preflightMode === 'failure') { res.statusCode = 503; response = { error: 'Fixture storage unavailable' } }
      else response = { torrents: [], new_bytes: bytes, new_torrents: selected && !existing ? 1 : 0, existing_torrents: existing ? 1 : 0, unknown_torrents: 0, approximate_torrents: 0, selected_file_count: selected && !existing ? body.selections[0].release === 1 ? 2 : 1 : 0, whole_torrents: 0, disk_space: selected && !existing ? [{ path: '/downloads', categories: ['sonarr-anime'], required_bytes: bytes, unknown_torrents: 0, free_bytes: preflightMode === 'unavailable' ? null : preflightMode === 'low' ? 100 : 1000, sufficient: preflightMode === 'unavailable' ? null : preflightMode !== 'low', reason: preflightMode === 'unavailable' ? 'Client cannot report space for this path.' : undefined }] : [] }
    }
    else if (path === '/api/download_bulk/status') response = bulkState
    else if (path === '/api/download_bulk') {
      bulkRequests.push(body)
      const hashes = [...new Set(body.selections.flatMap(selection => (fixtureResults || [example]).find(item => item.key === selection.key)?.releases[selection.release]?.info_hashes || []))]
      bulkState = { ok: true, finished: false, pending: hashes, added: [], failures: [] }
      if (holdBulk) await new Promise(resolve => { finishBulk = resolve })
      const failures = failBulk ? [{ hash: hashes[0], label: 'Radarr movie', error: 'Fixture metadata timeout' }] : []
      const added = hashes.filter(hash => !failures.some(failure => failure.hash === hash))
      bulkState = { ok: true, finished: true, pending: [], added, failures }
      response = { ok: true, count: added.length, targets: body.selections, failures }
    }
    else if (path === '/api/config/test') response = { ok: true, message: 'Fixture connection successful' }
    else if (path === '/api/scan') { scanRequests.push(body); response = { ok: true } }
    else if (path === '/api/update-check') response = { current: '1.7.0', latest: null, url: null }
    else if (path === '/api/scanned-data') response = { results: 2, cache_entries: 1, last_run: null, cache_valid: true, results_valid: true }
    else if (path === '/api/history') response = { scans: fixtureHistory || [{ id: 'scan-1', run_at: '2026-10-02 12:00:00', trigger: 'manual', counts: { upgrade: 1 }, changes: [{ key: example.key, title: example.title, arr: 'Sonarr', season: 1, type: 'upgrade', from: 'best', to: 'upgrade', best_group: 'Example' }] }] }
    else if (path === '/api/download_bulk/cancelable') response = { ok: true, downloads: cancelableDownloads }
    else if (path === '/api/anilist/search') response = { results: [{ id: 1, title: 'Example anime', year: 2026, format: 'TV', episodes: 12, cover: null }] }
    else { res.statusCode = 404; response = { error: 'Unknown fixture route: ' + path } }
    res.end(JSON.stringify(response))
    return
  }
  const file = resolve(root, path === '/' ? 'index.html' : path.slice(1))
  if (relative(root, file).startsWith('..') || !existsSync(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream')
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
  const found = await evaluate(`(() => { if (${JSON.stringify(text)} === 'Bulk cancel') { const menu = document.querySelector('.library-more-actions'); if (menu?.getClientRects().length && !menu.open) menu.querySelector('summary').click() }; const button = [...document.querySelectorAll('button, summary')].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.focus(); button.click(); return true })()`)
  assert.ok(found, 'Visible button: ' + text)
  await pause(100)
}
const fill = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const select = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const key = async key => { const keyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : 27; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }); await pause(60) }
const capture = async name => {
  if (!process.env.SCREENSHOT_DIR) return
  await pause(250)
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
  if (!process.env.UI_REVIEW_ONLY) {
  await wait(`document.querySelector('h1')?.textContent === 'Anime library' && document.body.textContent.includes('Unmatched anime')`)
  assert.ok(await evaluate(`[...document.querySelectorAll(${JSON.stringify(`[title="SeaDex Companion ${appVersion}"]`)})].some(element => element.textContent.trim() === ${JSON.stringify(appVersion)})`), `The app displays version ${appVersion}`)
  assert.ok(await evaluate(`document.body.textContent.includes('Match needs review')`))
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Library results"] article').length`), 2)
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Library view"]') && !document.querySelector('[aria-label="Library results"] table')`), 'Library uses cards without a view switcher')
  await capture('library-cards')
  console.log('PASS card library and distinct match status')

  await evaluate(`(() => { const button = document.querySelector('button[aria-label="Details for Example anime"]'); button.focus(); button.click() })()`)
  await wait(`document.querySelector('.anime-details-body .release-row')`)
  assert.ok(await evaluate(`document.querySelector('.release-row').textContent.includes('1 selected file · 120 B')`), 'Details use selected-file bytes rather than the full 200 B release')
  assert.ok(await evaluate(`document.querySelector('.release-row').textContent.includes('Season release') && document.querySelector('.release-row').textContent.includes('200 B')`), 'Season release size remains separately labelled')
  await evaluate(`document.querySelector('.release-row details').querySelector('summary').click()`)
  assert.ok(await evaluate(`document.querySelector('.release-row ul').textContent.includes('01.mkv')`), 'Selected filenames can be inspected before download')
  await wait(`document.querySelector('.release-row [role=progressbar][aria-label][aria-valuenow]')`)
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  await wait(`document.activeElement.getAttribute('aria-label') === 'Details for Example anime'`)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Details for Example anime', 'Closing details restores focus')
  const savedFileMetadata = example.releases[0].torrent_files
  delete example.releases[0].torrent_files
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await evaluate(`document.querySelector('button[aria-label="Details for Example anime"]').click()`)
  await wait(`document.querySelector('.release-row')`)
  assert.ok(await evaluate(`document.querySelector('.release-row').textContent.includes('1 selected file · size unavailable')`), 'Missing file metadata never presents the full-release fallback as selected-file bytes')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  example.releases[0].torrent_files = savedFileMetadata
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  console.log('PASS details file scope, missing-metadata uncertainty, progress semantics, and focus restoration')

  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]')[1]?.checked`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Not enough space')`)
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '200 B')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1 torrent').disabled`))
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue despite')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1 torrent').disabled`))
  preflightMode = 'existing'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('No new torrents to add')`)
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '0 B')
  preflightMode = 'unavailable'
  await click('Refresh check')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Free space unavailable')`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1 torrent').disabled`))
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
  assert.ok(await evaluate(`!document.querySelector('dialog[open] button[aria-label^="Pause torrent"]')`), 'A changed release must not inherit the previous torrent state')
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
  await evaluate(`location.reload()`)
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

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`location.hash = 'anime'`)
  await pause(300)
  assert.ok(await evaluate(`document.querySelector('nav[aria-label="Mobile navigation"]').getBoundingClientRect().width <= 390`))
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`), 'Mobile page has no horizontal overflow')
  assert.ok(await evaluate(`[...document.querySelectorAll(${JSON.stringify(`header [title="SeaDex Companion ${appVersion}"]`)})].some(element => element.getClientRects().length && element.textContent.trim() === ${JSON.stringify(appVersion)})`), `The mobile header displays version ${appVersion}`)
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

  // Scope, recommendations, and immutable background batches use isolated APIs.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const priorConfig = structuredClone(config)
  const movie = { ...example, key: 'Radarr:movie:Movie', arr: 'Radarr', title: 'Radarr movie', season: null, group_id: 2, anilist_id: 2, notes: 'Compare the audio and source before choosing.', releases: example.releases.map(rel => ({ ...rel, dual_audio: true, tags: ['BD', 'HEVC'] })) }
  const hidden = { ...example, key: 'Sonarr:hidden:1', title: 'Hidden upgrade', group_id: 3, anilist_id: 3, releases: [release('Hidden group', 'e')] }
  fixtureResults = [example, movie, hidden]
  config.hidden = ['3']
  preflightMode = 'enough'
  revision++
  await evaluate(`location.hash='anime'; location.reload()`)
  await wait(`document.querySelector('select[aria-label="Source"]')`)
  await select('select[aria-label="Source"]', 'Radarr')
  await wait(`document.querySelectorAll('[aria-label="Library results"] article').length === 1`)
  await click('Bulk download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1 eligible')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Bulk action scope"]').value`), 'filtered')
  assert.ok(await evaluate(`!document.querySelector('dialog[open]').textContent.includes('Hidden upgrade') && !document.querySelector('dialog[open]').textContent.includes('Example anime')`), 'Current review follows the source filter')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim().startsWith('Download ')).disabled`), 'Unresolved release choices prevent submission')
  await select('[aria-label="Bulk action scope"]', 'all')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('3 eligible')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Hidden upgrade')).querySelector('input').checked === false`), 'Whole-library review keeps hidden titles unchecked')
  await select('[aria-label="Bulk action scope"]', 'filtered')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1 eligible')`)
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Dual Audio') && document.querySelector('dialog[open]').textContent.includes('HEVC') && document.querySelector('dialog[open]').textContent.includes('Compare the audio')`), 'Choices expose release tags and notes')
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]')[1]?.checked && [...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Download 1 torrent' && !button.disabled)`)
  await capture('priorities-scoped-review')
  holdBulk = true
  await click('Download 1 torrent')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Continue in background')`)
  assert.equal(bulkRequests.length, 1)
  assert.deepEqual(bulkRequests[0].selections.map(item => [item.key, item.release]), [[movie.key, 1]], 'Submitted selection follows the filtered scope and chosen release')
  assert.ok(bulkRequests[0].selections[0].identity, 'Submission retains release identity validation')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] input[type=checkbox], dialog[open] input[type=radio]')].every(input => input.disabled) && document.querySelector('[aria-label="Bulk action scope"]').disabled`), 'Submitted selections and scope are immutable')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Check all').disabled`))
  await capture('priorities-submitted-batch')
  await click('Continue in background')
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 0)
  await click('Configuration')
  await click('Review batch')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Radarr movie')`)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].checked`), 'Reopened background review retains the submitted choice')
  await key('Escape')
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 0, 'Escape backgrounds an in-flight batch')
  await click('Review batch')
  finishBulk()
  holdBulk = false
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Added to qBittorrent')`)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].checked && document.querySelectorAll('dialog[open] input[type=radio]')[1].disabled`), 'Completed batch keeps an immutable record')
  await capture('priorities-completed-batch')
  await click('Close')
  failBulk = true
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Download 1 torrent')?.disabled`)
  await click('Download 1 torrent')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Could not be added')`)
  await capture('priorities-failed-batch')
  await click('Close')
  await click('Error details')
  assert.ok(await evaluate(`document.querySelector('[aria-label="Bulk operation error details"]').textContent.includes('Radarr movie') && document.querySelector('[aria-label="Bulk operation error details"]').textContent.includes('Fixture metadata timeout')`), 'Per-item failure details remain available after closing review')
  failBulk = false
  cancelableDownloads = [example, movie].map((item, index) => ({ key: item.key, release: 0, title: item.title, season: item.season, part: '', release_group: 'Example', tracker: 'Nyaa', size: 200, hashes: [(index ? 'b' : 'd').repeat(40)] }))
  await click('Bulk cancel')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Radarr movie')`)
  assert.ok(await evaluate(`!document.querySelector('dialog[open]').textContent.includes('Example anime')`), 'Cancellation follows the current result scope')
  await select('[aria-label="Bulk action scope"]', 'all')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Example anime')`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Also delete')).querySelector('input').checked`), 'Changing scope preserves the file-preserving default')
  await key('Escape')
  console.log('PASS filtered/all-library bulk scope, hidden defaults, recommendation evidence, immutable background batches, and scoped cancellation')

  config = { ...priorConfig, sonarr_url: '', sonarr_key_configured: false, radarr_url: '', radarr_key_configured: false }
  fixtureResults = []
  statusOverrides = { last_run: null }
  await evaluate(`location.hash='config'; location.reload()`)
  await wait(`document.querySelector('[aria-label="Connection checklist"]')`)
  assert.ok(await evaluate(`document.querySelector('input[name=sonarr_url]') && !document.querySelector('input[name=radarr_url]')`), 'First setup starts with one library-source decision')
  await click('Radarr · movies')
  await fill('input[name=radarr_url]', 'http://fixture-radarr.local')
  await fill('input[name=radarr_key]', 'fixture-key')
  await click('Test connection')
  await wait(`document.querySelector('[aria-label="Connection checklist"]')?.textContent.includes('Connection tested')`)
  await click('Save configuration')
  await wait(`document.querySelector('[aria-label="Connection checklist"]')?.textContent.includes('Connection saved')`)
  assert.ok(await evaluate(`![...document.querySelector('[aria-label="Connection checklist"]').querySelectorAll('button')].find(button => button.textContent.trim() === 'Scan library').disabled`), 'Saved connection enables the first scan')
  await capture('priorities-setup-ready')
  await click('Scan library')
  assert.equal(scanRequests.length, 1)
  await click('Connection checklist')
  await click('Show all settings')
  assert.ok(await evaluate(`Boolean(document.querySelector('input[name=sonarr_url]') && document.querySelector('input[name=radarr_url]'))`), 'Expert configuration remains accessible')
  const saveCount = saved.length
  await fill('input[name=qbittorrent_url]', 'not-a-url')
  await evaluate(`document.querySelector('input[name=qbittorrent_url]').closest('details').open=false`)
  await click('Save configuration')
  assert.ok(await evaluate(`document.querySelector('input[name=qbittorrent_url]').closest('details').open`), 'Invalid fields open their collapsed settings section')
  assert.equal(saved.length, saveCount, 'Invalid hidden inputs cannot submit configuration')
  await fill('input[name=qbittorrent_url]', priorConfig.qbittorrent_url)
  config = priorConfig
  fixtureResults = null
  statusOverrides = {}
  cancelableDownloads = []
  bulkState = { ok: true, finished: true, pending: [], added: [], failures: [] }
  await evaluate(`location.hash='anime'; location.reload()`)
  await wait(`document.querySelector('h1')?.textContent === 'Anime library'`)
  console.log('PASS optional first-run setup, source choice, test/save/scan sequence, and expert settings access')
  }

  // Follow-up improvements: verify behavior as well as inner geometry.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  fixtureResults = Array.from({ length: 1000 }, (_, index) => ({ ...example, key: `Sonarr:${index}:1`, library_key: `Sonarr:item${index}`, group_id: index + 1, anilist_id: index + 1, title: `Collection title ${String(index).padStart(4, '0')}`, releases: [release('Example', 'd')] }))
  const historyTarget = fixtureResults[999]
  fixtureHistory = [{ id: 'scan-pages', run_at: '2026-10-02 12:00:00', trigger: 'manual', counts: { upgrade: 1 }, changes: [{ key: 'older-key', title: historyTarget.title, arr: historyTarget.arr, season: historyTarget.season, type: 'upgrade', from: 'best', to: 'upgrade' }] }]
  progressMode = 'absent'
  revision++
  await evaluate(`localStorage.setItem('seadex-library-view', 'table'); location.hash = 'anime'; location.reload()`)
  await wait(`document.querySelector('[aria-label="Library page"]')`)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Library results"] article').length`), 60, 'Large collections have bounded mounted cards')
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Library results"] table') && !document.querySelector('[aria-label="Library view"]')`), 'An old table preference still opens the card library')
  await click('Next')
  await wait(`document.querySelector('[aria-label="Library page"]').value === '1'`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Library results"]').textContent.includes('Collection title 0060')`))
  await click('Bulk download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Collection title 0999')`)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=checkbox]').length >= 1000`), 'Bulk review still includes the full collection')
  await key('Escape')
  await click('Scan history')
  await wait(`document.body?.textContent.includes('Collection title 0999')`)
  await click('Collection title 0999')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Collection title 0999')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Library page"]').value`), '16', 'History fallback lookup opens an off-page title')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Library page"]').value`), '16', 'History destination remains on its page after closing')
  await fill('input[type=search]', '0999')
  await wait(`document.querySelectorAll('[aria-label="Library results"] article').length === 1`)
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Library pages"]')`), 'Search spans all pages and resets pagination')
  await click('Clear filters')
  await wait(`document.querySelectorAll('[aria-label="Library results"] article').length === 60`)
  await click('Next')
  await wait(`document.querySelector('[aria-label="Library page"]').value === '1'`)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Library results"] article').length`), 60)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop=0`)
  await pause(200)
  const mobileFirstCard = await evaluate(`document.querySelector('[aria-label="Library results"] article').getBoundingClientRect().top`)
  assert.ok(mobileFirstCard < 460, 'Mobile chrome leaves useful room for the first card: ' + mobileFirstCard)
  assert.ok(await evaluate(`[...document.querySelectorAll('.library-actions > button, .library-toolbar button')].filter(button => button.getClientRects().length).every(button => button.getBoundingClientRect().height >= 44)`), 'Primary mobile actions and filters have 44px targets')
  await capture('priorities-mobile-library')
  console.log('PASS bounded library pages, full-library search/bulk scope, and off-page history fallback navigation')
  fixtureResults = null
  fixtureHistory = null
  fixtureLogs = Array.from({ length: 100 }, (_, index) => `2026-10-02 12:00:00 [INFO] Log entry ${index}`)
  revision++
  await evaluate(`location.hash = 'log'; location.reload()`)
  await wait(`document.querySelector('pre')?.textContent.includes('Log entry 99')`)
  await evaluate(`document.querySelector('.log-scrollbar').scrollTop = 0`)
  await wait(`document.querySelector('button[aria-pressed]') && [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Follow live output')?.getAttribute('aria-pressed') === 'false'`)
  fixtureLogs.push('2026-10-02 12:00:01 [INFO] New log entry')
  await wait(`document.querySelector('pre')?.textContent.includes('New log entry')`)
  assert.equal(await evaluate(`document.querySelector('.log-scrollbar').scrollTop`), 0, 'New output preserves the reader position')
  await click('Follow live output')
  await wait(`document.querySelector('.log-scrollbar').scrollTop > 0`)
  fixtureLogs.shift()
  fixtureLogs.push('2026-10-02 12:00:02 [INFO] Rolling log entry')
  await wait(`document.querySelector('pre')?.textContent.includes('Rolling log entry')`)
  assert.ok(await evaluate(`(() => { const box = document.querySelector('.log-scrollbar'); return box.scrollHeight - box.clientHeight - box.scrollTop < 2 })()`), 'Following works when the capped line count stays unchanged')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true })
  await pause(250)
  assert.ok(await evaluate(`(() => { const box=document.querySelector('.log-scrollbar').getBoundingClientRect(); const nav=document.querySelector('[aria-label="Mobile navigation"]').getBoundingClientRect(); return box.height > 60 && box.bottom < nav.top })()`), 'Landscape log has a usable scroll region above navigation')
  await capture('follow-up-landscape-log')
  await evaluate(`location.hash = 'config'`)
  await wait(`document.querySelector('input[name=sonarr_url]')`)
  await capture('follow-up-landscape-config')
  console.log('PASS paused/resumed log following, capped log rollover, and short-height log layout')

  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
  await evaluate(`location.hash = 'anime'`)
  await wait(`document.querySelector('h1')?.textContent === 'Anime library'`)
  cancelableDownloads = [{ key: example.key, release: 0, title: '取消対象の長いアニメ名'.repeat(3), season: 1, part: '', release_group: 'VeryLongUnbrokenReleaseGroupName'.repeat(5), tracker: 'Nyaa', size: 200, hashes: ['d'.repeat(40)] }]
  await click('Bulk cancel')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('VeryLongUnbroken')`)
  assert.ok(await evaluate(`(() => { const body=document.querySelector('dialog[open] .app-scrollbar'); return body.scrollWidth <= body.clientWidth + 1 })()`), 'Cancellation metadata wraps without inner horizontal scrolling')
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] label')].find(label=>label.textContent.includes('Also delete')).querySelector('input').checked`), 'Bulk cancellation continues to preserve files by default')
  await capture('follow-up-mobile-bulk-cancel')
  await key('Escape')
  await click('Filters & sort')
  await evaluate(`(() => { const source=document.querySelector('select[aria-label="Source"]'); source.value='Sonarr'; source.dispatchEvent(new Event('change',{bubbles:true})) })()`)
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Filters & sort')).click()`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Active library filters"]').textContent.includes('Sonarr')`), 'Collapsed filters retain visible source state')
  await click('Clear filters')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.documentElement.style.fontSize='32px'`)
  await pause(250)
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Enlarged text does not overflow the document')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.library-toolbar')).position`), 'relative', 'Tall library controls scroll away when enlarged chrome limits the reading area')
  assert.ok(await evaluate(`(() => { const actions=document.querySelector('.library-actions'); return actions.scrollWidth <= actions.clientWidth + 1 })()`), 'Enlarged primary actions do not create implicit overflowing grid columns')
  assert.ok(await evaluate(`(() => { const nav=document.querySelector('[aria-label="Mobile navigation"]'); const labels=[...nav.querySelectorAll('button')].map(button=>button.getBoundingClientRect()); return labels.every((label,index)=>!index || label.left >= labels[index-1].right-1) })()`), 'Enlarged navigation labels do not collide')
  assert.ok(await evaluate(`[...document.querySelectorAll('[aria-label="Mobile navigation"] button')].every(button=>button.scrollWidth<=button.clientWidth+1)`), 'Navigation hit areas contain the enlarged labels')
  await capture('follow-up-mobile-enlarged-text')
  await evaluate(`document.querySelector('article').scrollIntoView({block:'center'})`)
  await capture('follow-up-mobile-enlarged-card')
  assert.ok(await evaluate(`[...document.querySelectorAll('article')].every(card=>card.scrollWidth<=card.clientWidth+1)`), 'Enlarged card metadata and controls stay within their card')
  await evaluate(`(() => { const card=[...document.querySelectorAll('article')].find(card=>card.textContent.includes(${JSON.stringify(example.title)})); const button=[...card.querySelectorAll('button')].find(button=>button.textContent.trim()==='Details'); button.focus(); button.click() })()`)
  await wait(`document.querySelector('.release-identity')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('.release-identity')].every(row=>row.scrollWidth<=row.clientWidth+1)`), 'Release identities remain readable with enlarged text')
  await evaluate(`document.querySelector('.release-row').scrollIntoView({block:'center'})`)
  await capture('follow-up-mobile-enlarged-details')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  await evaluate(`location.hash='config'`)
  await wait(`document.querySelector('input[name=sonarr_url]')`)
  await capture('follow-up-mobile-enlarged-config')
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Configuration fits the enlarged-text viewport')
  await evaluate(`document.documentElement.style.fontSize=''`)
  statusOverrides = { error: 'Sonarr request failed: ' + 'A library path could not be reached. Check the integration URL and API key. '.repeat(10) }
  await evaluate(`location.hash='config'; location.reload()`)
  await wait(`document.querySelector('[aria-label="Application operations"] details')`)
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Application operations"] details').open`), 'Full diagnostics start collapsed')
  await evaluate(`document.querySelector('[aria-label="Application operations"] summary').click()`)
  await pause(100)
  assert.ok(await evaluate(`(() => { const panel=document.querySelector('.operation-center'); const details=panel.querySelector('.operation-diagnostics'); return getComputedStyle(panel).position === 'relative' && details.clientHeight <= innerHeight*.3+1 && details.textContent.includes('Sonarr request failed') })()`), 'Expanded diagnostics are bounded and leave the sticky layer')
  await capture('follow-up-expanded-diagnostics')
  await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop=10000`)
  assert.ok(await evaluate(`document.querySelector('.operation-center').getBoundingClientRect().bottom < 100`), 'Users can scroll past errors to integration settings')
  statusOverrides = {}
  fixtureLogs = ['2026-10-02 12:00:00 [INFO] First log entry']
  await evaluate(`location.hash='anime'; location.reload()`)
  await wait(`document.querySelector('h1')?.textContent === 'Anime library'`)
  console.log('PASS long cancellation metadata, file-preserving defaults, visible filter state, enlarged navigation, and bounded recovery diagnostics')

  // Long real-world release names expose internal flex clipping even when the
  // document itself has no horizontal overflow. All actions remain fixture-only.
  const longGroup = 'A release group with a long name and 日本語 characters'
  example.title = 'Example anime with a longer collection title'
  example.releases = [
    { ...release(longGroup, 'd'), part: 'Cour 1', dual_audio: true, tags: ['HEVC', 'BD'] },
    { ...release(longGroup + ' second cour', 'e'), part: 'Cour 2', dual_audio: true, tags: ['HEVC', 'BD'] },
    { ...release('Another public option', 'f'), part: 'Cour 2' },
  ]
  example.have = [longGroup]
  example.precise_part_ownership = true
  example.owned_by_part = { 'Cour 1': [longGroup], 'Cour 2': [] }
  example.have_by_part = { 'Cour 1': [longGroup], 'Cour 2': [] }
  progressMode = 'absent'
  await evaluate(`location.hash = 'anime'; location.reload()`)
  await wait(`document.body.textContent.includes(${JSON.stringify(example.title)})`)
  const uiEvidence = [{ width: 390, route: 'paginated-library', firstCardTop: mobileFirstCard }]
  for (const [width, height] of [[1440, 1000], [900, 900], [390, 844], [320, 700]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 901 })
    for (const route of ['anime', 'history', 'config', 'log']) {
      await evaluate(`location.hash = ${JSON.stringify(route)}`)
      await pause(350)
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= ${width}`), `${route} fits ${width}px viewport`)
      await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop = 0`)
      await capture(`review-${width}-${route}`)
      if (route === 'config') {
        const geometry = await evaluate(`(() => { const pane = document.querySelector('main > .app-scrollbar').getBoundingClientRect(); const save = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save configuration').getBoundingClientRect(); const nav = document.querySelector('nav[aria-label="Mobile navigation"]'); return { paneBottom: pane.bottom, saveTop: save.top, saveBottom: save.bottom, navTop: nav.getClientRects().length ? nav.getBoundingClientRect().top : null } })()`)
        assert.ok(geometry.saveTop >= geometry.paneBottom, 'Save controls never overlay the scrolling configuration')
        if (geometry.navTop !== null) assert.ok(geometry.saveBottom < geometry.navTop, 'Save controls clear mobile navigation')
        uiEvidence.push({ width, route, geometry })
        await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop = 100000`)
        await capture(`review-${width}-config-end`)
      }
    }
    await evaluate(`location.hash = 'anime'`)
    await pause(200)
    await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop = 0`)
    const badgeSelector = '.library-card-seasons .season-badge[title*="Cour 1"]'
    assert.ok(await evaluate(`(() => { const badge = document.querySelector(${JSON.stringify(badgeSelector)}); return badge && badge.tagName === 'SPAN' && !badge.querySelector('svg') && !badge.hasAttribute('tabindex') && badge.textContent.includes('Cour 1') && badge.textContent.includes('Cour 2') })()`), 'Season pills retain accessible cour statuses without icons or an interactive control')
    await evaluate(`document.querySelector(${JSON.stringify(badgeSelector)}).click()`)
    assert.ok(await evaluate(`!document.querySelector('.season-status-popover, .season-badge[popovertarget]') && !document.querySelector('[popover]:popover-open')`), 'Season pills do not open a popover')
    await capture(`review-${width}-season-pills`)
    await evaluate(`(() => { const card = [...document.querySelectorAll('article')].find(card => card.textContent.includes(${JSON.stringify(example.title)})); [...card.querySelectorAll('button')].find(button => button.textContent.trim() === 'Details').click() })()`)
    await wait(`document.querySelector('.release-identity')`)
    const releaseGeometry = await evaluate(`(() => { const identities = [...document.querySelectorAll('.release-identity')]; return identities.map(identity => ({ width: identity.clientWidth, scrollWidth: identity.scrollWidth, groupWidth: identity.querySelector('span').clientWidth, groupScrollWidth: identity.querySelector('span').scrollWidth, tagWidths: [...identity.querySelectorAll('div > span')].map(tag => tag.getBoundingClientRect().width) })) })()`)
    for (const row of releaseGeometry) {
      assert.ok(row.width > 0 && row.scrollWidth <= row.width + 1, 'Release identity is not clipped')
      assert.ok(row.groupScrollWidth <= row.groupWidth + 1, 'Release group remains fully readable')
      assert.ok(row.tagWidths.every(width => width > 24), 'Release tags retain readable width')
    }
    uiEvidence.push({ width, route: 'release-details', releaseGeometry })
    await capture(`review-${width}-details`)
    await evaluate(`document.querySelector('.release-row').scrollIntoView({ block: 'center' })`)
    assert.ok(await evaluate(`(() => { const button=document.querySelector('dialog[open] button[aria-label="Close details"]'); const box=button.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.height >= 44 })()`), 'Details retain a visible, reachable close control after scrolling')
    await capture(`review-${width}-details-releases`)
    await click('Correct match')
    await wait(`document.querySelectorAll('dialog[open]').length === 2`)
    assert.ok(await evaluate(`document.querySelector('dialog[open] label input[placeholder="Anime title"]').labels.length > 0`), 'Mapping search has a persistent label')
    await key('Tab')
    assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).contains(document.activeElement)`))
    await capture(`review-${width}-mapping`)
    await key('Escape')
    await key('Escape')
    await click('Bulk download')
    await wait(`document.querySelector('dialog[open] input[type=checkbox]')`)
    await wait(`!document.querySelector('dialog[open]')?.textContent.includes('Checking…')`)
    await capture(`review-${width}-bulk`)
    await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
    await wait(`document.querySelector('dialog[open] input[type=radio]')`)
    await capture(`review-${width}-bulk-expanded`)
    await key('Escape')
  }
  console.log('PASS responsive configuration clearance, long release identities, noninteractive season pills, and nested mapping at 320/390/900/1440px')
  if (process.env.SCREENSHOT_DIR) writeFileSync(join(process.env.SCREENSHOT_DIR, 'ui-evidence.json'), JSON.stringify(uiEvidence, null, 2))
  for (const mode of ['login', 'setup']) {
    authMode = mode
    await evaluate(`location.reload()`)
    await wait(`document.querySelector('input[name=password]')`)
    await capture(`review-320-${mode}`)
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await capture(`review-1440-${mode}`)
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
  }
  assert.deepEqual(errors, [], 'No unhandled browser exceptions in responsive review')
} catch (error) {
  console.error(error)
  if (ws?.readyState === WebSocket.OPEN) console.error(await evaluate(`({ text: document.body?.innerText, url: location.href })`).catch(() => null))
  console.error('Browser exceptions:', errors)
  throw error
} finally {
  finishBulk?.()
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
