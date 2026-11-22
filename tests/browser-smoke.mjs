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
const release = (group, hash) => ({ kind: 'best', releaseGroup: group, tracker: 'Nyaa', quality: '1080p', tags: [], size: 200, info_hashes: [hash.repeat(40)], torrent_available: true, selected_files: hash === 'a' ? ['01.mkv'] : ['01.mkv', '02.mkv'], torrent_files: [{ hash: hash.repeat(40), files: [{ name: '01.mkv', length: 120 }, { name: '02.mkv', length: 80 }] }] })
const canonicalIdentity = release => JSON.stringify([release.part || '', release.releaseGroup || '', release.tracker || '', [...(release.info_hashes || [])].map(hash => hash.toLowerCase()).sort(), [...(release.selected_files || [])].sort()])
const example = { key: 'Sonarr:1:1:Example', group_id: 1, library_key: 'Sonarr:item1', title: 'Example anime', arr: 'Sonarr', season: 1, status: 'upgrade', match_status: 'matched', have: ['Old group'], local_size: 100, best_size: 200, best_group: 'Example', anilist_id: 1, image: null, banner: null, url: null, notes: null, arr_url: null, releases: [release('Example', 'a'), release('Alternative', 'b')] }
let anilistSearchResults = [{ id: 1, title: 'Example anime', year: 2026, format: 'TV', episodes: 12, cover: null }]
const mappingRequests = []
let mappingFailure = false
let config = { sonarr_url: 'http://sonarr.local', sonarr_key: '', sonarr_key_configured: true, radarr_url: '', radarr_key: '', radarr_key_configured: false, sonarr_category: 'sonarr-anime', radarr_category: '', qbittorrent_url: 'http://qbit.local', qbittorrent_user: 'test', qbittorrent_pass: '', qbittorrent_pass_configured: true, download_mode: 'torrent_only', sabnzbd_url: '', sabnzbd_key: '', sabnzbd_sonarr_category: 'sonarr-anime', sabnzbd_radarr_category: 'radarr-anime', sabnzbd_key_configured: false, animetosho_enabled: true, animetosho_url: 'https://feed.animetosho.net', amenzb_enabled: false, amenzb_url: 'https://amenzb.moe', amenzb_key: '', amenzb_key_configured: false, webhook: '', webhook_configured: false, notify_enabled: false, unhide_on_new_best: false, hidden: [], scan_schedule: { enabled: false, mode: 'interval', interval_minutes: 60, times: ['03:00'], weekdays: [0], timezone: 'UTC', missed_run: 'skip' } }
let revision = 1
let resultRequests = 0
let statusRequests = 0
let statusFailure = false
let configFailure = false
let logFailure = false
let saveDelay = 0
let progressMode = 'downloading'
let authMode = 'authenticated'
let fixtureResults = null
let failChangeReview = false
const changeReviewRequests = []
let fixtureHistory = null
const replacementChange = { kind: 'best', description: 'Best release changed: Old group → New group',
  release_replacement: { previous: 'Old group (AB)', next: 'New group (Nyaa)', torrent_changed: true } }
const noteChange = { kind: 'updated', description: 'SeaDex recommendation notes updated', part: 'Cour 2',
  note_change: { previous: 'Use the weekly releases.\nThe specials are separate.', next: 'Use the season batch.\nThe specials are separate.' } }
const readableHistory = () => [{ id: 'scan-readable', run_at: '2026-11-18 10:35:34', trigger: 'manual', duration_seconds: 12,
  counts: { best: 158, upgrade: 28, missing: 34, partial: 1 }, changes: [
    { key: example.key, title: example.title, arr: 'Sonarr', season: 1, type: 'resolved', from: 'upgrade', to: 'best', details: [] },
    { key: 'love-ru', title: 'To LOVE-Ru', arr: 'Sonarr', season: 2, type: 'changed', from: 'upgrade', to: 'upgrade', release_changes: [replacementChange, noteChange] },
    { key: 'banished', title: "Banished From the Hero's Party, I Decided To Live a Quiet Life in the Countryside", arr: 'Sonarr', season: 2, type: 'changed', from: 'upgrade', to: 'upgrade', details: ['NAN0 (AB) · Torrent changed', '-ZR- (AB) · Torrent changed'] },
    { key: 'quality', title: 'The Dangers in My Heart', arr: 'Sonarr', season: 2, type: 'changed', from: 'best', to: 'best', details: ['MTBB (Nyaa) · Quality: 1080p → 2160p; Torrent changed'] },
    { key: 'added', title: 'A newly added anime', arr: 'Radarr', season: 0, type: 'new', from: null, to: 'missing', details: [] },
    { key: 'removed', title: 'An anime removed from the library', arr: 'Sonarr', season: 1, type: 'removed', from: 'upgrade', to: null, details: [] },
  ] }]
let fixtureLogs = ['2026-10-02 12:00:00 [INFO] First log entry']
let statusOverrides = {}
let cancelableDownloads = []
let holdBulk = false
let failBulk = false
let bulkOutcome = 'added'
let finishBulk = null
let bulkState = { id: null, ok: true, existing: [], targets: [], finished: true, pending: [], added: [], failures: [] }
const bulkRequests = []
const scanRequests = []
const controlRequests = []
const capabilities = { pause: true, resume: true, remove: true, remove_files: true }
const itemFor = selection => (fixtureResults || [example]).find(item => item.key === selection.key)
// Client progress retains every original association; the browser resolves current recommendations.
const progressRelease = () => example.releases[1]
const progressRecord = () => `record-${progressRelease().info_hashes[0]}`
const progressFor = () => {
  const phase = progressMode === 'error' ? 'error' : progressMode === 'complete' ? 'complete' : progressMode === 'paused' ? 'paused' : 'downloading'
  const release = progressRelease()
  const stateText = { error: 'Error', complete: 'All done', paused: 'Paused', downloading: 'Downloading' }[phase]
  return {
    record_id: progressRecord(), protocol: 'torrent', client: 'qbittorrent', source_hash: release.info_hashes[0], native_id: release.info_hashes[0],
    phase, state: stateText, category: 'sonarr-anime', labels: [release.releaseGroup], title: example.title, season: example.season, part: release.part || '',
    release_group: release.releaseGroup, tracker: release.tracker, size: release.size, associations: [{ key: example.key, release: 1 }],
    progress: phase === 'complete' ? 1 : 0.5, downloaded: phase === 'complete' ? 200 : 100, total_size: 200, speed: phase === 'error' ? 0 : 10,
    ...(phase === 'error' ? { error: 'Fixture client error: the torrent is incomplete.' } : {}),
    capabilities, updated_at: '2026-11-20T10:00:00.000Z',
  }
}
const cancelableFor = (item, index) => ({
  record_id: `record-cancel-${index}`, protocol: 'torrent', client: 'qbittorrent', native_id: (index ? 'b' : 'd').repeat(40),
  phase: index ? 'downloading' : 'queued', title: item.title, season: item.season ?? null, part: item.part || '',
  release_group: item.release_group || item.releases?.[0]?.releaseGroup || 'Example', category: 'sonarr-anime',
  associations: item.associations || [item.title], size: 200, capabilities,
})
let preflightMode = 'low'
let singleSendMode = 'ok'
let availabilityMode = 'available'
let availabilityDelay = 0
const availabilityRequests = []
const singleRequests = []
const cancelRequests = []
const preflightRequests = []
let progressOverrides = null
let holdNextAvailability = false
let releaseAvailability = null
const expiredPlanMessage = 'This review has expired or was already used. Re-run the review before submitting.'
const preflightPlans = new Map()
let planCount = 0
const plannedUnit = (selection, index) => {
  const item = itemFor(selection)
  const release = item?.releases?.[selection.release]
  const protocol = config.download_mode === 'usenet_only' ? 'usenet' : config.download_mode === 'torrent_only' ? 'torrent' : selection.protocol || 'torrent'
  const existing = preflightMode === 'existing'
  return {
    unit_id: `${protocol}:${release.info_hashes[0]}:${protocol === 'usenet' ? config.sabnzbd_sonarr_category : 'sonarr-anime'}`, protocol, client: protocol === 'usenet' ? 'sabnzbd' : 'qbittorrent',
    source_hash: release.info_hashes[0], category: protocol === 'usenet' ? config.sabnzbd_sonarr_category : 'sonarr-anime',
    status: existing ? 'existing' : 'new',
    ...(existing ? { existing_record_id: `record-existing-${index}`, existing_native_id: release.info_hashes[0] } : {}),
    whole_source: protocol === 'usenet', scope_expanded: protocol === 'usenet' && Boolean(release.selected_files?.length),
    size_bytes: existing ? null : protocol === 'usenet' ? 200 : selection.release === 1 ? 200 : 120,
    approximate: protocol === 'usenet',
    ...(protocol === 'usenet' ? { provider: 'animetosho', nzb_name: `${item.title}.nzb`, known_extra_files: ['03.mkv', '04.mkv', '05.mkv', '06.mkv'], extra_file_count: 4 } : {}),
    labels: [release.releaseGroup || item.title], selections: [{ key: selection.key, release: selection.release }],
  }
}
const preflightFor = body => {
  const planId = `plan-${++planCount}`
  const bySource = new Map()
  for (const [index, selection] of body.selections.entries()) {
    const unit = plannedUnit(selection, index)
    const existing = bySource.get(unit.unit_id)
    if (existing) {
      if (!existing.selections.some(ref => ref.key === selection.key && ref.release === selection.release)) existing.selections.push({ key: selection.key, release: selection.release })
      existing.labels = [...new Set([...existing.labels, ...unit.labels])]
    } else bySource.set(unit.unit_id, unit)
  }
  const units = [...bySource.values()]
  const newUnits = units.filter(unit => unit.status === 'new')
  const totalNewBytes = newUnits.reduce((total, unit) => total + (unit.size_bytes || 0), 0)
  const freeBytes = preflightMode === 'unavailable' ? null : preflightMode === 'low' ? 100 : 1000
  const diskSpace = newUnits.length ? [...new Set(newUnits.map(unit => unit.client))].map(client => ({
    client, path: client === 'sabnzbd' ? '/sab/downloads' : '/downloads', categories: [client === 'sabnzbd' ? config.sabnzbd_sonarr_category : 'sonarr-anime'],
    required_bytes: newUnits.filter(unit => unit.client === client).reduce((total, unit) => total + (unit.size_bytes || 0), 0), unknown_units: newUnits.filter(unit => unit.client === client && unit.approximate).length, free_bytes: freeBytes,
    sufficient: freeBytes === null ? null : freeBytes < newUnits.filter(unit => unit.client === client).reduce((total, unit) => total + (unit.size_bytes || 0), 0) ? false : newUnits.some(unit => unit.client === client && unit.approximate) ? null : true,
    reason: freeBytes === null ? 'Client cannot report space for this path.' : undefined,
  })) : []
  const preflight = {
    ok: true, plan_id: planId, expires_in: 300, mode: config.download_mode, selection_count: body.selections.length, units,
    new_torrents: newUnits.filter(unit => unit.protocol === 'torrent').length, new_nzbs: newUnits.filter(unit => unit.protocol === 'usenet').length,
    existing_units: units.length - newUnits.length, blocked: [], requires_whole_ack: newUnits.some(unit => unit.scope_expanded),
    requires_space_ack: diskSpace.some(check => check.sufficient !== true),
    total_new_bytes: totalNewBytes, unknown_bytes: 0, approximate_bytes: newUnits.some(unit => unit.approximate), disk_space: diskSpace,
  }
  preflightPlans.set(planId, { selections: body.selections.map(selection => ({ ...selection })), preflight })
  return preflight
}
const jobUnit = unit => ({
  unit_id: unit.unit_id, protocol: unit.protocol, record_id: `record-${unit.source_hash}`,
  native_id: unit.protocol === 'usenet' ? `SABnzbd_nzo_${unit.source_hash.slice(0, 8)}` : unit.source_hash,
  source_hash: unit.source_hash, label: unit.selections.map(ref => itemFor(ref).title).join(' / '), selections: unit.selections,
})
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
          for (const name of ['sonarr_key', 'radarr_key', 'qbittorrent_pass', 'sabnzbd_key', 'amenzb_key', 'webhook']) {
            if (body[name]) config[name + '_configured'] = true
            if (body.clear_secrets?.includes(name)) config[name + '_configured'] = false
            config[name] = ''
          }
        }
        response = config
      }
    }
    else if (path === '/api/status') {
      statusRequests++
      if (statusFailure) { res.statusCode = 503; response = { error: 'Fixture server unavailable' } }
      else response = { results_revision: String(revision), running: false, progress: 0, total: 0, message: 'Idle', error: null, cancelled: false, trigger: null, source_errors: {}, last_run: '2026-10-02 12:00:00', next_check: null, webhook_scan: { queued: false, due_at: null, sources: [] }, ...statusOverrides }
    }
    else if (path === '/api/results') { resultRequests++; response = { hidden: config.hidden, results: fixtureResults || [example, { ...example, key: 'Sonarr:item2:1:missing', library_key: 'Sonarr:item2', group_id: null, title: 'Unmatched anime', status: 'missing', match_status: 'unmatched', anilist_id: null, best_group: null, releases: [] }], last_run: '2026-10-02 12:00:00' } }
    else if (path === '/api/release-changes/review') {
      changeReviewRequests.push(body.ids)
      if (failChangeReview) { res.statusCode = 503; response = { error: 'Fixture review unavailable' } }
      else {
        const reviewed = new Set(body.ids)
        fixtureResults = fixtureResults.map(result => ({ ...result, unseen_changes: (result.unseen_changes || []).filter(change => !reviewed.has(change.id)) }))
        revision++
        response = { ok: true, reviewed: reviewed.size }
      }
    }
    else if (path === '/api/downloads') response = { ok: true, downloads: progressOverrides || (progressMode === 'absent' ? {} : { [progressRecord()]: progressFor() }) }
    else if (path === '/api/logs') { if (logFailure) { res.statusCode = 503; response = { error: 'Fixture log unavailable' } } else response = { lines: fixtureLogs } }
    else if (path === '/api/download_bulk/preflight') {
      preflightRequests.push(body)
      const stale = body.selections.some(selection => !itemFor(selection)?.releases?.[selection.release] || selection.identity !== canonicalIdentity(itemFor(selection).releases[selection.release]))
      if (stale) { res.statusCode = 409; response = { ok: false, error: 'A selected release changed. Re-open the review.' } }
      else if (preflightMode === 'failure') { res.statusCode = 503; response = { error: 'Fixture storage unavailable' } }
      else response = preflightFor(body)
    }
    else if (path === '/api/usenet/availability') {
      availabilityRequests.push(body)
      const stale = body.selections.some(selection => !itemFor(selection)?.releases?.[selection.release] || selection.identity !== canonicalIdentity(itemFor(selection).releases[selection.release]))
      if (stale) { res.statusCode = 409; response = { ok: false, error: 'A selected release changed. Re-open the review.' } }
      else response = {
        ok: true, config_generation: 1,
        providers_enabled: { animetosho: config.animetosho_enabled, amenzb: config.amenzb_enabled },
        sabnzbd_configured: Boolean(config.sabnzbd_url && config.sabnzbd_key_configured),
        results: body.selections.map((selection, index) => {
          const item = itemFor(selection)
          const release = item.releases[selection.release]
          const hash = release.info_hashes[0]
          const state = availabilityMode === 'mixed' ? release.usenet_state || 'no_match' : availabilityMode
          const match = state === 'available'
            ? { state: 'available', provider: 'animetosho', entry_id: String(100 + index), title: `${item.title} complete season`, total_bytes: 1_400_000_000, files_known: true, file_count: 12, file_names: Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(2, '0')}.mkv`) }
            : state === 'lookup_failed' ? { state, error_code: 'timeout', error: 'Fixture provider timed out', providers_failed: ['animetosho'] } : { state }
          return { key: selection.key, release: selection.release, identity: canonicalIdentity(release), hashes: [{ hash, ...match }], aggregate: match.state, checked_at: '2026-11-20T10:00:00.000Z' }
        }),
      }
      if (holdNextAvailability) {
        holdNextAvailability = false
        const deferred = Promise.withResolvers()
        releaseAvailability = deferred.resolve
        await deferred.promise
      }
      if (availabilityDelay) await pause(availabilityDelay)
    }
    else if (path === '/api/download') {
      singleRequests.push(body)
      const plan = preflightPlans.get(body.plan_id)
      preflightPlans.delete(body.plan_id)
      if (!plan || singleSendMode === 'expired') { res.statusCode = 410; response = { ok: false, error: expiredPlanMessage } }
      else if (plan.preflight.requires_whole_ack && !body.acknowledge?.whole_source || plan.preflight.requires_space_ack && !body.acknowledge?.disk_space) { res.statusCode = 409; response = { ok: false, error: 'Confirm the whole-source and disk-space acknowledgements before sending.' } }
      else if (plan.selections.some(selection => selection.identity !== canonicalIdentity(itemFor(selection)?.releases?.[selection.release] || {}))) { res.statusCode = 409; response = { ok: false, error: 'A selected release changed. Re-open the review.' } }
      else if (singleSendMode === 'transient') { res.statusCode = 502; response = { ok: false, error: 'Fixture client temporarily unavailable' } }
      else {
        const selection = plan.selections[0]
        const sourceHash = itemFor(selection).releases[selection.release].info_hashes[0]
        const usenet = selection.protocol === 'usenet'
        response = {
          ok: singleSendMode !== 'unknown', record_id: `record-${sourceHash}`, native_id: usenet ? `SABnzbd_nzo_${sourceHash.slice(0, 8)}` : sourceHash, source_hash: sourceHash,
          protocol: usenet ? 'usenet' : 'torrent', client: usenet ? 'sabnzbd' : 'qbittorrent',
          category: usenet ? config.sabnzbd_sonarr_category : 'sonarr-anime',
          ...(singleSendMode === 'unknown' ? { acceptance_unknown: true, error: `${usenet ? 'SABnzbd' : 'qBittorrent'} was asked to start this download but did not confirm it.` } : {}),
        }
        if (response.acceptance_unknown) res.statusCode = 502
      }
    }
    else if (path === '/api/download-jobs' && req.method === 'POST') {
      const plan = preflightPlans.get(body.plan_id)
      preflightPlans.delete(body.plan_id)
      if (!plan) { res.statusCode = 410; response = { ok: false, error: expiredPlanMessage } }
      else if (plan.preflight.requires_whole_ack && !body.acknowledge?.whole_source || plan.preflight.requires_space_ack && !body.acknowledge?.disk_space) { res.statusCode = 409; response = { ok: false, error: 'Confirm the whole-source and disk-space acknowledgements before sending.' } }
      else if (plan.selections.some(selection => selection.identity !== canonicalIdentity(itemFor(selection)?.releases?.[selection.release] || {}))) { res.statusCode = 409; response = { ok: false, error: 'A selected release changed. Re-open the review.' } }
      else {
        const targets = plan.selections.map(selection => ({ ...selection }))
        bulkRequests.push({ ...body, action: 'start', selections: targets })
        const id = `fixture-job-${bulkRequests.length}`
        bulkState = { id, ok: true, finished: false, pending: plan.preflight.units.map(jobUnit), added: [], existing: [], failures: [], targets }
        const finish = async () => {
          if (holdBulk) await new Promise(resolve => { finishBulk = resolve })
          const units = plan.preflight.units.map(jobUnit)
          const failures = failBulk ? units.slice(0, 1).map(unit => ({ ...unit, code: 'client_error', error: 'Fixture metadata timeout' })) : []
          const sent = failures.length ? units.slice(1) : units
          bulkState = {
            ...bulkState, finished: true, pending: [], failures,
            ok: !failures.length || sent.length > 0,
            added: bulkOutcome === 'existing' ? [] : sent,
            existing: bulkOutcome === 'existing' ? sent : [],
          }
        }
        res.statusCode = 202
        response = { ok: true, job_id: id }
        void finish()
      }
    }
    else if (path === '/api/download-jobs' || path === '/api/download-jobs/latest' || path.startsWith('/api/download-jobs/')) response = bulkState
    else if (path === '/api/downloads/cancelable') response = { ok: true, items: cancelableDownloads }
    else if (path === '/api/downloads/cancel') {
      cancelRequests.push(body)
      assert.ok(Array.isArray(body.record_ids), 'UI cancellation must name the reviewed record IDs')
      const chosen = cancelableDownloads.filter(item => body.record_ids.includes(item.record_id))
      cancelableDownloads = cancelableDownloads.filter(item => !body.record_ids.includes(item.record_id))
      response = { ok: true, removed: chosen.map(item => ({ record_id: item.record_id, client: item.client })), failures: [] }
    }
    else if (path === '/api/download_control') {
      controlRequests.push(body)
      if (body.action === 'pause') progressMode = 'paused'
      if (body.action === 'resume') progressMode = 'downloading'
      if (body.action === 'remove') {
        if (progressOverrides) delete progressOverrides[body.record_id]
        else progressMode = 'absent'
      }
      response = { ok: true }
    }
    else if (path === '/api/config/test') response = { ok: true, message: 'Fixture connection successful' }
    else if (path === '/api/scan') { scanRequests.push(body); response = { ok: true } }
    else if (path === '/api/update-check') response = { current: '1.7.0', latest: null, url: null }
    else if (path === '/api/scanned-data') response = { results: 2, cache_entries: 1, last_run: null, cache_valid: true, results_valid: true }
    else if (path === '/api/history') response = { scans: fixtureHistory || [{ id: 'scan-1', run_at: '2026-10-02 12:00:00', trigger: 'manual', counts: { upgrade: 1 }, changes: [{ key: example.key, title: example.title, arr: 'Sonarr', season: 1, type: 'upgrade', from: 'best', to: 'upgrade', best_group: 'Example' }] }] }
    else if (path === '/api/anilist/search') response = { results: anilistSearchResults }
    else if (path === '/api/mapping-overrides') { mappingRequests.push(body); if (mappingFailure) { res.statusCode = 500; response = { error: 'Fixture match save failed. Try again.' } } else response = { ok: true, ...body } }
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
  // Reloads can briefly expose a document without a body before parsing finishes.
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(`document.readyState !== 'loading' && Boolean(${expression})`)) return; await pause(50) }
  throw new Error('UI did not reach expected state: ' + expression)
}
const click = async text => {
  const found = await evaluate(`(() => { if (${JSON.stringify(text)} === 'Bulk cancel') { const menu = document.querySelector('.library-more-actions'); if (menu?.getClientRects().length && !menu.open) menu.querySelector('summary').click() }; if (['Correct match', 'Change manual match'].includes(${JSON.stringify(text)})) { const management = document.querySelector('dialog[open] .details-management'); if (management && !management.open) management.querySelector('summary').click() }; const button = [...document.querySelectorAll('button, summary')].find(button => button.getClientRects().length && button.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.focus(); button.click(); return true })()`)
  assert.ok(found, 'Visible button: ' + text)
  await pause(100)
}
const fill = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const select = (selector, value) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
const key = async key => { const keyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : 27; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }); await pause(60) }
const capture = async name => {
  if (!process.env.SCREENSHOT_DIR || (process.env.SCREENSHOT_FILTER && !name.startsWith(process.env.SCREENSHOT_FILTER))) return
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

  // Observe real browser animation calls while exercising title continuity.
  // Leave enough vertical room that a late download row cannot change the
  // scrollbar width during this test of card reordering.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false })
  await wait(`document.querySelector('[aria-label="Active downloads"]')`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await evaluate(`(() => { window.libraryMotionCalls = []; const original = Element.prototype.animate; Element.prototype.animate = function(frames, options) { if (this.matches('article[data-library-key]')) window.libraryMotionCalls.push({ key: this.dataset.libraryKey, frames, options }); return original.call(this, frames, options) }; window.restoreLibraryMotion = () => { Element.prototype.animate = original } })()`)
  await select('[aria-label="Sort library"]', 'title')
  await wait(`document.querySelector('.library-grid article h2')?.textContent === 'Example anime'`)
  assert.ok(await evaluate(`window.libraryMotionCalls.some(call => call.frames[0].transform && call.options.duration <= 300)`), 'Sorting animates existing titles from their old positions')
  await select('[aria-label="Sort library"]', 'recommended')
  await select('[aria-label="Sort library"]', 'title')
  await pause(320)
  assert.ok(await evaluate(`[...document.querySelectorAll('.library-grid article')].every(card => !card.getAnimations().length && getComputedStyle(card).transform === 'none')`), 'Interrupted reorders settle without lingering transforms')
  await fill('input[type=search]', 'Example anime')
  await wait(`document.querySelectorAll('.library-grid article').length === 1`)
  await pause(320)
  await evaluate(`(() => { window.libraryGeometryReads = 0; const original = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function() { if (this.matches('.library-grid, article[data-library-key]')) window.libraryGeometryReads++; return original.call(this) }; window.restoreLibraryGeometry = () => { Element.prototype.getBoundingClientRect = original } })()`)
  await fill('input[type=search]', 'Example anim')
  await wait(`document.querySelector('.library-toolbar [role=status]').textContent.includes('Search: Example anim')`)
  await pause(100)
  assert.equal(await evaluate(`window.libraryGeometryReads`), 0, 'Typing with the same visible titles does not remeasure cards')
  await evaluate(`window.restoreLibraryGeometry()`)
  await fill('input[type=search]', '')
  await wait(`document.querySelectorAll('.library-grid article').length === 2`)
  await pause(320)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await pause(100)
  await evaluate(`window.libraryMotionCalls = []`)
  await select('[aria-label="Sort library"]', 'recommended')
  await wait(`window.libraryMotionCalls.some(call => call.frames[0].transform)`)
  await capture('library-motion-mobile')
  await evaluate(`(() => { window.motionPreferenceApplied = new Promise(resolve => { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => requestAnimationFrame(() => resolve(true)), { once: true }) }); return true })()`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(`window.motionPreferenceApplied`)
  assert.ok(await evaluate(`[...document.querySelectorAll('.library-grid article')].every(card => !card.getAnimations().length)`), 'Changing the motion preference cancels movement immediately')
  await evaluate(`window.libraryMotionCalls = []`)
  await select('[aria-label="Sort library"]', 'title')
  await wait(`document.querySelector('.library-grid article h2')?.textContent === 'Example anime'`)
  assert.equal(await evaluate(`window.libraryMotionCalls.length`), 0, 'Reduced motion sorts immediately without spatial animations')
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await select('[aria-label="Sort library"]', 'recommended')
  await capture('library-motion-desktop')
  await evaluate(`window.restoreLibraryMotion()`)
  console.log('PASS library reorder continuity, rapid interruption, mobile motion, and live reduced-motion preference')

  const changeFixture = (id, kind, detected_at) => ({ id, kind, detected_at, description: kind === 'best' ? 'Best release changed: Old group → Example' : kind === 'alternative' ? 'New alternative: Alternative · 1080p' : 'A release group with a long name (AB) · Quality: 1080p → 2160p; Torrent changed' })
  fixtureResults = [
    { ...example, unseen_changes: [{ ...replacementChange, id: 'best-change', detected_at: '2026-11-04T11:00:00.000Z' }] },
    { ...example, key: 'Sonarr:1:2:Example', season: 2, unseen_changes: [changeFixture('alt-change', 'alternative', '2026-11-04T12:00:00.000Z')] },
    { ...example, key: 'recent', library_key: 'Sonarr:item2', anilist_id: 2, group_id: 2, title: 'Recent anime', status: 'best', unseen_changes: [
      changeFixture('quality-change', 'updated', '2026-11-04T13:00:00.000Z'),
      { ...noteChange, id: 'note-change', detected_at: '2026-11-04T12:30:00.000Z' },
    ] },
    { ...example, key: 'quiet', library_key: 'Sonarr:item3', anilist_id: 3, group_id: 3, title: 'Quiet anime' },
  ]
  progressMode = 'absent'; revision++
  await evaluate('location.reload()')
  await wait(`document.querySelector('[aria-label="Unseen changes (2 titles)"]') && document.querySelectorAll('.library-grid article').length === 3`)
  await evaluate(`document.querySelector('[aria-label="Unseen changes (2 titles)"]').click()`)
  await wait(`document.querySelectorAll('.library-grid article').length === 2`)
  assert.equal(await evaluate(`document.querySelector('.library-grid article h2').textContent`), 'Recent anime', 'Unseen titles show their latest change first')
  assert.ok(await evaluate(`(() => { const summary = document.querySelector('[aria-label="Unseen changes for Recent anime"]'); return summary.textContent.includes('Quality: 1080p → 2160p') && summary.textContent.includes('Torrent updated') && !summary.textContent.includes('Release updated') })()`), 'Library cards show the actual changes instead of a generic category')
  assert.ok(await evaluate(`document.querySelector('[aria-label="Unseen changes for Example anime"]').textContent.includes('Old group (AB) → New group (Nyaa)')`), 'Library card shows both release groups')
  assert.ok(await evaluate(`(() => { const comparison = document.querySelector('[aria-label="Unseen changes for Recent anime"] details'); if (!comparison || comparison.open) return false; comparison.querySelector('summary').click(); return comparison.open && comparison.innerText.includes('Use the weekly releases') && comparison.innerText.includes('Use the season batch') })()`), 'Library card expands both note versions')
  await capture('unseen-desktop')
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 901 })
    await evaluate(`document.querySelector('[aria-label="Unseen changes for Recent anime"]').scrollIntoView({ block: 'center' })`)
    assert.ok(await evaluate(`(() => { const summary = document.querySelector('[aria-label="Unseen changes for Recent anime"]'); return summary.scrollWidth <= summary.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth })()`), 'Library change summaries fit narrow cards')
    await capture(`library-changes-${width}`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await click('Details')
  await wait(`document.querySelector('dialog [aria-label="What changed"]')`)
  assert.ok(await evaluate(`document.querySelector('dialog [aria-label="What changed"]').textContent.includes('1080p → 2160p')`))
  await evaluate(`document.querySelector('dialog [aria-label="What changed"]').open = true`)
  assert.ok(await evaluate(`(() => { const notes = document.querySelector('dialog .details-changes details'); notes.querySelector('summary').click(); return notes.open && notes.innerText.includes('Previous note') && notes.innerText.includes('New note') })()`), 'Library details also compare both notes')
  assert.ok(await evaluate(`(() => { const changes = document.querySelector('dialog [aria-label="What changed"]'); return changes.textContent.indexOf('Torrent updated') < changes.textContent.indexOf('A release group with a long name (AB)') })()`), 'Library details put the actual edit before the release identity')
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 901 })
    await evaluate(`document.querySelector('dialog [aria-label="What changed"]').scrollIntoView({ block: 'start' })`)
    assert.ok(await evaluate(`(() => { const changes = document.querySelector('dialog [aria-label="What changed"]'); return changes.scrollWidth <= changes.clientWidth + 1 })()`), 'Library change details fit narrow screens')
    await capture(`library-details-changes-${width}`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await capture('unseen-details-desktop')
  await evaluate(`document.querySelector('[aria-label="Close details"]').click()`)
  await wait(`!document.querySelector('dialog[open]')`)
  failChangeReview = true
  await evaluate(`document.querySelector('[aria-label="Mark changes for Recent anime reviewed"]').click()`)
  await wait(`document.body.textContent.includes('Could not mark changes reviewed') && !document.querySelector('[aria-label="Mark changes for Recent anime reviewed"]').disabled`)
  assert.equal(await evaluate(`document.querySelectorAll('.library-grid article').length`), 2, 'Failed review leaves unseen changes in place')
  failChangeReview = false
  await evaluate(`document.querySelector('[aria-label="Mark changes for Recent anime reviewed"]').click()`)
  await wait(`document.querySelectorAll('.library-grid article').length === 1`)
  assert.deepEqual(changeReviewRequests.at(-1), ['quality-change', 'note-change'])
  await evaluate(`document.querySelectorAll('[aria-label="Dismiss notification"]').forEach(button => button.click())`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await capture('unseen-mobile')
  assert.ok(await evaluate(`document.querySelector('[aria-label="Unseen changes (1 title)"]').getBoundingClientRect().height >= 44`))
  await click('Details')
  await wait(`document.querySelector('dialog [aria-label="What changed"]')`)
  await evaluate(`document.querySelector('dialog [aria-label="What changed"]').open = true`)
  assert.ok(await evaluate(`document.querySelector('dialog [aria-label="What changed"]').textContent.includes('S02')`))
  assert.ok(await evaluate(`document.querySelector('dialog [aria-label="What changed"]').textContent.includes('New alternative')`))
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= 390`))
  await capture('unseen-details-mobile')
  await evaluate(`document.querySelector('[aria-label="Close details"]').click()`)
  await wait(`!document.querySelector('dialog[open]')`)
  await evaluate('location.reload()')
  await wait(`document.querySelector('[aria-label="Unseen changes (1 title)"]')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Unseen changes for Recent anime"]')`), null, 'Reviewed state survives a page reload')
  fixtureResults = Array.from({ length: 65 }, (_, index) => ({ ...example, key: `unseen-${index}`, library_key: `Sonarr:item${100 + index}`, anilist_id: 100 + index, group_id: 100 + index, title: `Changed anime ${index}`, unseen_changes: [changeFixture(`event-${index}`, 'alternative', '2026-11-04T12:00:00.000Z')] }))
  revision++
  await evaluate('location.reload()')
  await wait(`document.querySelector('[aria-label="Unseen changes (65 titles)"]') && document.querySelectorAll('.library-grid article').length === 60`)
  await evaluate(`document.querySelector('[aria-label="Unseen changes (65 titles)"]').click()`)
  await click('Mark all reviewed')
  await wait(`document.body.textContent.includes('No unseen changes')`)
  assert.equal(new Set(changeReviewRequests.at(-1)).size, 65, 'Mark all reviewed includes matching titles on every page')
  fixtureResults = null; progressMode = 'downloading'; revision++
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate('location.reload()')
  await wait(`document.body.textContent.includes('Unmatched anime') && document.querySelectorAll('.library-grid article').length === 2`)
  await pause(320)
  console.log('PASS unseen title counts, latest-change sorting, season details, failed-review recovery, persistent review, mobile controls, and cross-page review')

  statusOverrides = { cancelled: true }
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('[aria-label="Dismiss scan cancellation"]')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.library-toolbar')).position`), 'relative', 'Cancellation notice shares the operations sticky layer')
  await capture('scan-cancelled-desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate(`document.querySelector('.operation-center [aria-label="Dismiss scan cancellation"]').getBoundingClientRect().height >= 44`), 'Cancellation dismiss button has a mobile touch target')
  await capture('scan-cancelled-mobile')
  await evaluate(`document.querySelector('.operation-center [aria-label="Dismiss scan cancellation"]').focus()`)
  await key('Enter')
  await wait(`!document.querySelector('[aria-label="Application operations"]')`)
  const pollsAtDismissal = statusRequests
  await pause(10500)
  assert.ok(statusRequests > pollsAtDismissal, 'Server status was polled after dismissal')
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Application operations"]')`), 'Cancellation stays dismissed across status polls')
  statusOverrides = { running: true, cancelled: false, message: 'Scanning library' }
  await click('Scan library')
  await wait(`document.querySelector('[aria-label="Application operations"]')?.textContent.includes('Scanning library')`)
  assert.ok(await evaluate(`!document.querySelector('[aria-label="Dismiss scan cancellation"]') && !document.querySelector('[aria-label="Dismiss scan completion"]')`), 'An active scan cannot be dismissed')
  statusOverrides = { cancelled: true }
  await wait(`document.querySelector('[aria-label="Dismiss scan cancellation"]')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Application operations"]').textContent.includes('Previous complete results were preserved')`), 'A new cancellation notice reappears with the preserved-results explanation')
  statusOverrides = {}
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('[aria-label="Library results"] article')`)
  console.log('PASS keyboard dismissal of scan cancellation, persistence across polling, and new-scan reset')

  await evaluate(`(() => { const button = document.querySelector('button[aria-label="Details for Example anime"]'); button.focus(); button.click() })()`)
  await wait(`document.querySelector('.anime-details-body .release-row')`)
  assert.ok(await evaluate(`document.querySelector('.release-row').textContent.includes('1 selected file · 120 B')`), 'Details use selected-file bytes rather than the full 200 B release')
  assert.ok(await evaluate(`document.querySelector('.release-row').textContent.includes('Season release') && document.querySelector('.release-row').textContent.includes('200 B')`), 'Season release size remains separately labelled')
  await evaluate(`document.querySelector('.release-row details').querySelector('summary').click()`)
  assert.ok(await evaluate(`document.querySelector('.release-row ul').textContent.includes('01.mkv')`), 'Selected filenames can be inspected before download')
  await wait(`document.querySelector('.release-row [role=progressbar][aria-label][aria-valuenow]')`)
  // Client commands act on the record the server reported for this release.
  assert.equal(await evaluate(`[...document.querySelectorAll('dialog[open] button[aria-label^="Pause download"]')].length`), 1, 'Only the release with a live transfer offers client controls')
  await evaluate(`document.querySelector('dialog[open] button[aria-label^="Pause download"]').click()`)
  await wait(`document.querySelector('[aria-label="Active downloads"]')?.textContent.includes('qBittorrent · Paused')`)
  assert.deepEqual(controlRequests.at(-1), { record_id: progressRecord(), action: 'pause', delete_files: false })
  await evaluate(`document.querySelector('dialog[open] button[aria-label^="Resume download"]').click()`)
  await wait(`document.querySelector('[aria-label="Active downloads"]')?.textContent.includes('qBittorrent · Downloading')`)
  assert.equal(controlRequests.at(-1).action, 'resume')
  assert.ok(await evaluate(`document.querySelector('.release-row [role=progressbar]').getAttribute('aria-valuetext') === 'Downloading · 50.0%'`), 'Progress rows name the client state and percentage')
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

  const progressBeforeDetailsReview = progressMode
  progressMode = 'absent'
  fixtureResults = [
    { ...example, status: 'best', have: ['Example'], releases: [release('Example', 'a')] },
    { ...example, key: 'Sonarr:1:2:Example', season: 2, notes: 'Fixture recommendation: inspect the source and subtitle choices before downloading.', releases: [release('Example', 'b')] },
    { ...example, key: 'Radarr:2:0:movie', library_key: 'Radarr:item2', group_id: 2, anilist_id: 2, arr: 'Radarr', season: 0, title: 'Fixture movie', releases: [release('Example', 'b')] },
  ]
  revision++
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await evaluate(`document.querySelector('button[aria-label="Details for Example anime"]').click()`)
  await wait(`document.querySelector('.details-index')`)
  assert.ok(await evaluate(`document.querySelector('.details-season-disclosure') && !document.querySelector('.details-season-disclosure').open && document.querySelector('.details-season-disclosure > summary').textContent.includes('Your release: Example')`), 'Owned releases remain visible while season details start collapsed')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.documentElement.style.fontSize='32px'`)
  await pause(150)
  assert.ok(await evaluate(`(() => { const body = document.querySelector('.anime-details-body'); return body.scrollWidth <= body.clientWidth + 1 && body.clientHeight >= innerHeight * .35 })()`), 'Enlarged text keeps a usable reading area without horizontal overflow')
  await evaluate(`document.querySelector('.details-index button').click()`)
  await wait(`document.activeElement.getAttribute('aria-label') === 'Season 2'`)
  assert.ok(await evaluate(`document.querySelector('.anime-details-header').getBoundingClientRect().top >= 0`), 'Season navigation keeps the title and close control in view')
  assert.ok(await evaluate(`(() => { const season = document.activeElement; return Boolean(season.querySelector('.release-notes').compareDocumentPosition(season.querySelector('.release-row')) & Node.DOCUMENT_POSITION_FOLLOWING) && season.querySelector('button[aria-label="Ignore Season 2 in bulk downloads and notifications"]').textContent.includes('Ignore for bulk') })()`), 'Upgrade navigation lands at recommendation evidence and a clear bulk action')
  await key('Escape')
  await evaluate(`document.querySelector('button[aria-label="Details for Fixture movie"]').click()`)
  await wait(`document.querySelector('dialog[open] section[aria-label="Movie"]')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Movie release') && !document.querySelector('dialog[open]').textContent.includes('Season 0')`), 'Movie details use movie terminology')
  await key('Escape')
  fixtureResults = null
  progressMode = progressBeforeDetailsReview
  revision++
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  console.log('PASS enlarged-text details, owned summaries, upgrade navigation, recommendation order, bulk scope, and movie terminology')

  const beforeOverviewProgress = progressMode
  progressMode = 'absent'
  const overviewSeason = (number, cours = 0) => ({ ...example, key: `Sonarr:overview:${number}`, group_id: 1, season: number, status: 'best', have: [number === 1 ? 'FLE' : 'sam'], precise_part_ownership: true,
    have_by_part: Object.fromEntries((cours ? Array.from({length: cours}, (_, i) => `Cour ${i + 1}`) : ['']).map(part => [part, [number === 1 ? 'FLE' : 'sam']])),
    owned_by_part: Object.fromEntries((cours ? Array.from({length: cours}, (_, i) => `Cour ${i + 1}`) : ['']).map(part => [part, [number === 1 ? 'FLE' : 'sam']])),
    releases: (cours ? Array.from({length: cours}, (_, i) => ({...release('sam', 'a'), part: `Cour ${i + 1}`})) : [release(number === 1 ? 'FLE' : 'sam', 'a')]),
  })
  fixtureResults = [overviewSeason(1), overviewSeason(2), overviewSeason(3, 2), overviewSeason(4, 3)]
  revision++
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 900 })
    await evaluate(`location.reload()`)
    await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
    await click('Details')
    await wait(`document.querySelector('.details-verdict[data-quality="best"]')`)
    assert.equal(await evaluate(`document.querySelector('.details-verdict h3').textContent`), 'You have the best releases')
    assert.ok(await evaluate(`[...document.querySelectorAll('.details-season-disclosure')].every(details => !details.open)`), 'Seasons start compact')
    assert.ok(await evaluate(`[...document.querySelectorAll('.details-season-disclosure > summary')].every(summary => summary.getClientRects().length && summary.textContent.includes('Your release') && summary.querySelector('strong')?.textContent)`), 'Every owned group stays visible in the collapsed overview')
    assert.ok(await evaluate(`(() => { const summary = document.querySelectorAll('.details-season-disclosure > summary')[3]; return summary.textContent.includes('Cour 1: sam') && summary.textContent.includes('Cour 2: sam') && summary.textContent.includes('Cour 3: sam') })()`), 'Split summaries retain each cour release')
    assert.ok(await evaluate(`document.querySelector('.anime-details-body').scrollWidth <= document.querySelector('.anime-details-body').clientWidth + 1`), 'Release overview fits the viewport')
    await capture(`details-overview-${width}`)
    await evaluate(`document.querySelectorAll('.details-season-disclosure > summary')[2].focus()`)
    await key('Enter')
    await wait(`document.querySelectorAll('.details-season-disclosure')[2].open`)
    await evaluate(`document.querySelector('.details-cour > summary').focus()`)
    await key('Enter')
    await wait(`document.querySelector('.details-cour').open`)
    assert.ok(await evaluate(`document.querySelectorAll('.details-season-disclosure')[2].open && !document.querySelectorAll('.details-cour')[1].open`), 'Cours expand independently without closing their season')
    assert.ok(await evaluate(`document.querySelector('.details-cour .release-row').getClientRects().length > 0`), 'Cour expansion exposes the real release and download controls')
    await capture(`details-cour-${width}`)
    await key('Escape')
    await wait(`!document.querySelector('dialog[open]')`)
  }
  fixtureResults[2] = { ...fixtureResults[2], status: 'partial', upgrade_available: true, have_by_part: {'Cour 1':['sam'], 'Cour 2':['sam']}, owned_by_part: {'Cour 1':['sam'], 'Cour 2':[]}, unavailable_parts: [{label:'Cour 3',reason:'Not listed on SeaDex'}] }
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await click('Details')
  await wait(`document.querySelector('.details-verdict[data-quality="upgrade"]')`)
  assert.ok(await evaluate(`document.querySelectorAll('.details-season-disclosure > summary')[2].textContent.includes('Partially on SeaDex')`), 'Partial coverage stays explicit')
  await evaluate(`document.querySelectorAll('.details-season-disclosure > summary')[2].click()`)
  assert.equal(await evaluate(`document.querySelectorAll('.details-cour > summary .details-quality')[1].getAttribute('data-quality')`), 'upgrade', 'A group found in incomplete cour files is not presented as fully owned')
  assert.equal(await evaluate(`document.querySelectorAll('.details-cour > summary .details-quality')[2].textContent`), 'Not on SeaDex', 'Unavailable cours remain in the overview')
  await key('Escape')
  fixtureResults = null
  progressMode = beforeOverviewProgress
  revision++
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  console.log('PASS release overview, per-cour ownership, independent keyboard disclosures, partial coverage, and responsive details at 320/390/1440px')

  // Usenet availability, whole-source warnings, and the per-release protocol choice.
  config = { ...config, download_mode: 'choose', sabnzbd_url: 'http://sab.local', sabnzbd_key_configured: true }
  progressMode = 'absent'
  preflightMode = 'enough'
  availabilityRequests.length = 0
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await evaluate(`document.querySelector('button[aria-label="Details for Example anime"]').click()`)
  await wait(`document.querySelector('.details-season-disclosure > summary')`)
  assert.ok(await evaluate(`!document.body.textContent.includes('Usenet source found')`), 'Usenet sources stay unchecked until a season is expanded')
  await evaluate(`document.querySelector('.details-season-disclosure > summary').click()`)
  await wait(`document.body.textContent.includes('Usenet source found')`)
  assert.ok(await evaluate(`document.querySelectorAll('.release-row').length === 2 && [...document.querySelectorAll('.release-row')].every(row => row.textContent.includes('Usenet source found') && row.textContent.includes('12 file source'))`), 'Every release reports its Usenet source with the provider file count')
  await pause(400)
  assert.equal(availabilityRequests.length, 1, 'Opening one season checks Usenet once')
  assert.equal(availabilityRequests[0].refresh, undefined, 'The first lookup uses the cached provider results')
  await evaluate(`document.querySelector('button[aria-label^="Re-check Usenet sources"]').click()`)
  await wait(`Boolean(document.querySelector('button[aria-label^="Re-check Usenet sources"]:not([disabled])'))`)
  assert.equal(availabilityRequests.length, 2, 'Re-check starts a second lookup')
  assert.equal(availabilityRequests.at(-1).refresh, true, 'Re-check bypasses the provider cache')
  await wait(`document.querySelector('[role="radiogroup"][aria-label^="Download method ·"]')`)
  assert.equal(await evaluate(`document.querySelectorAll('[role="radiogroup"][aria-label^="Download method ·"]').length`), 2, 'Every release offers a protocol choice in choose mode')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="radiogroup"][aria-label^="Download method ·"]')[0].querySelectorAll('[role="radio"]')].map(radio => [radio.textContent.trim(), radio.getAttribute('aria-checked')])`), [['Torrent', 'true'], ['Usenet', 'false']], 'Releases default to the torrent path')
  await evaluate(`document.querySelectorAll('[role="radiogroup"][aria-label^="Download method ·"]')[0].querySelectorAll('[role="radio"]')[1].click()`)
  await wait(`document.querySelector('.release-download-button')?.textContent.includes('Download on Usenet')`)
  assert.ok(await evaluate(`(() => { const row = document.querySelectorAll('.release-row')[0]; return row.textContent.includes('Whole Usenet source') && row.textContent.includes('Usenet sources cannot be split') && row.textContent.includes('category: sonarr-anime') && !row.querySelector('details > summary') })()`), 'Usenet warns that the whole unsplittable source lands in the configured category and drops file scoping')
  await evaluate(`document.querySelectorAll('.release-row')[0].querySelector('.release-download-button').click()`)
  await wait(`document.querySelector('#single-plan-title') && [...document.querySelectorAll('dialog[open]')].at(-1)?.textContent.includes('To send')`)
  assert.ok(await evaluate(`(() => { const dialog = [...document.querySelectorAll('dialog[open]')].find(row => row.textContent.includes('Send to download client')); return dialog.textContent.includes('Whole Usenet source') && dialog.textContent.includes('includes 4 extra files') && dialog.textContent.includes('SABnzbd · sonarr-anime') })()`), 'The single review names the whole Usenet source, its extra files, and the target category')
  assert.ok(await evaluate(`Boolean([...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Send now')?.disabled)`), 'A whole Usenet source cannot be sent before acknowledgement')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Download whole Usenet sources')).querySelector('input').click()`)
  assert.ok(await evaluate(`Boolean([...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Send now')?.disabled)`), 'Approximate Usenet space still needs acknowledgement after accepting the whole source')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Send now')?.disabled`), 'Both acknowledgements unlock the Usenet send')
  await evaluate(`(() => { const dialog = [...document.querySelectorAll('dialog[open]')].find(row => row.textContent.includes('Send to download client')); [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel').click(); return true })()`)
  await wait(`!document.body.textContent.includes('Send to download client')`)
  await capture('usenet-release-choice')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  fixtureResults = [{ ...example, releases: [{ ...release('Original release', 'a'), torrent_available: false }] }]
  holdNextAvailability = true
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await click('Details')
  await wait(`document.querySelector('.details-season-disclosure > summary')`)
  await evaluate(`document.querySelector('.details-season-disclosure > summary').click()`)
  await wait(`document.querySelector('.release-row')?.textContent.includes('Checking Usenet sources')`)
  for (let attempt = 0; attempt < 100 && !releaseAvailability; attempt++) await pause(20)
  assert.ok(releaseAvailability, 'The stale lookup is held before replacing the release')
  availabilityMode = 'no_match'
  fixtureResults = [{ ...example, releases: [{ ...release('Replacement release', 'c'), torrent_available: false }] }]
  revision++
  await pause(10_500)
  await wait(`document.querySelector('.release-row')?.textContent.includes('Replacement release') && document.querySelector('.release-row')?.textContent.includes('Not found on Usenet indexers')`)
  releaseAvailability()
  releaseAvailability = null
  await pause(300)
  assert.ok(await evaluate(`!document.querySelector('.release-row').textContent.includes('Usenet source found') && document.querySelector('.release-download-button').disabled`), 'An old response cannot attach availability to a replacement at the same release index')
  assert.equal(availabilityRequests.at(-1).selections[0].identity, canonicalIdentity(fixtureResults[0].releases[0]), 'Expanded details request the replacement identity')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  fixtureResults = null
  availabilityMode = 'available'
  config = { ...config, download_mode: 'torrent_only', sabnzbd_url: '', sabnzbd_key_configured: false }
  progressMode = beforeOverviewProgress
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  console.log('PASS Usenet availability rows, whole-source warnings, cached versus refreshed lookups, and per-release protocol choice')

  // Bulk Usenet availability: only confirmed sources may be offered or selected.
  const beforeBulkUsenet = { config, fixtureResults, progressMode, preflightMode }
  const bulkAnime = (title, hash, state, torrentAvailable = true) => ({ ...example, key: `Sonarr:bulk:${title}`, group_id: title, library_key: `Sonarr:bulk:${title}`, title,
    releases: [{ ...release(title, hash), torrent_available: torrentAvailable, usenet_state: state }] })
  const bulkChoice = { ...bulkAnime('Choice anime', '6', 'available'), releases: [
    { ...release('Available first release', '6'), usenet_state: 'available' },
    { ...release('Unavailable alternative', '7'), usenet_state: 'no_match' },
  ] }
  fixtureResults = [bulkAnime('Available anime', '1', 'available'), bulkAnime('Torrent-only anime', '2', 'no_match'),
    bulkAnime('Processing anime', '3', 'processing'), bulkAnime('Incomplete anime', '4', 'incomplete'),
    bulkAnime('Failed lookup anime', '5', 'lookup_failed'), bulkChoice,
    bulkAnime('Private available anime', '8', 'available', false), bulkAnime('Private unavailable anime', '9', 'no_match', false)]
  config = { ...config, download_mode: 'choose', sabnzbd_url: 'http://sab.local', sabnzbd_key_configured: true }
  progressMode = 'absent'
  preflightMode = 'enough'
  availabilityMode = 'mixed'
  availabilityDelay = 1000
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('h1')?.textContent === 'Anime library' && document.body.textContent.includes('Available anime')`)
  await click('Bulk download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Checking Usenet availability')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'All Usenet where available').disabled`), 'The preset waits for confirmed availability')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]').length === 2`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`!document.querySelector('dialog[open]')?.textContent.includes('Checking Usenet availability')`)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].checked`), 'Availability results preserve a release selected while the lookup was pending')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] [role=radiogroup]')].filter(group => [...group.querySelectorAll('[role=radio]')].some(button => button.textContent.trim() === 'Usenet')).map(group => group.getAttribute('aria-label')).sort()`),
    ['Download method for Available anime', 'Download method for Private available anime'], 'Only confirmed Usenet releases expose the Usenet method')
  await click('All Usenet where available')
  await wait(`[...document.querySelectorAll('dialog[open] dt')].find(label => label.textContent === 'New NZBs')?.nextElementSibling?.textContent === '2'`)
  assert.deepEqual([...preflightPlans.values()].at(-1).selections.map(selection => [itemFor(selection).title, selection.protocol]).sort(), [
    ['Available anime', 'usenet'], ['Choice anime', 'torrent'], ['Failed lookup anime', 'torrent'], ['Incomplete anime', 'torrent'],
    ['Private available anime', 'usenet'], ['Processing anime', 'torrent'], ['Torrent-only anime', 'torrent'],
  ].sort(), 'The batch keeps missing, partial, processing, and failed sources on torrents and excludes unavailable private releases')
  await capture('bulk-usenet-mixed-desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth`), 'Mixed Usenet availability fits the mobile review')
  await capture('bulk-usenet-mixed-mobile')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[0].click()`)
  await wait(`document.querySelector('[role=radiogroup][aria-label="Download method for Choice anime"]')?.textContent.includes('Usenet')`)
  await click('All Usenet where available')
  await wait(`[...document.querySelectorAll('dialog[open] dt')].find(label => label.textContent === 'New NZBs')?.nextElementSibling?.textContent === '3'`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`[...document.querySelectorAll('dialog[open] dt')].find(label => label.textContent === 'New NZBs')?.nextElementSibling?.textContent === '2'`)
  assert.ok(await evaluate(`!document.querySelector('[role=radiogroup][aria-label="Download method for Choice anime"]')?.textContent.includes('Usenet')`), 'Changing to an unavailable alternative removes Usenet and restores the torrent method')
  availabilityMode = 'no_match'
  availabilityDelay = 0
  await click('Refresh review')
  await wait(`!document.querySelector('dialog[open]')?.textContent.includes('Checking Usenet availability') && ![...document.querySelectorAll('dialog[open] [role=radio]')].some(button => button.textContent.trim() === 'Usenet')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'All Usenet where available').disabled`), 'No matches disable the preset and remove every Usenet method')
  await key('Escape')
  fixtureResults = [bulkAnime('Private retry anime', '8', 'lookup_failed', false)]
  availabilityMode = 'mixed'
  await evaluate(`location.reload()`)
  await wait(`document.body.textContent.includes('Private retry anime')`)
  await click('Bulk download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Fixture provider timed out')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Refresh review' && !button.disabled)`), 'A private-only provider failure has a retry outside the eligible section')
  fixtureResults[0].releases[0].usenet_state = 'no_match'
  await click('Refresh review')
  await wait(`!document.querySelector('dialog[open]')?.textContent.includes('Checking Usenet availability') && !document.querySelector('dialog[open]')?.textContent.includes('Fixture provider timed out')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Refresh review' && !button.disabled)`), 'A private-only no-match review still has a retry')
  fixtureResults[0].releases[0].usenet_state = 'available'
  await click('Refresh review')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1 eligible')`)
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === '1 eligible').click()`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('New NZBs')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open] input[type=checkbox]')?.checked`), 'Private-only retries preserve the selected intent')
  await key('Escape')
  ;({ config, fixtureResults, progressMode, preflightMode } = beforeBulkUsenet)
  availabilityMode = 'available'
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  console.log('PASS bulk Usenet mixed availability, pending choices, private sources, release changes, refresh, and mobile layout')
  // End bulk Usenet availability.

  preflightMode = 'low'
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]')[1]?.checked`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Low space')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]')?.textContent.includes('only 100 B free')`), 'The low-space line names the client and its free bytes')
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '200 B')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`))
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`))
  await key('Escape')
  const torrentConfigBeforeWhole = config
  config = { ...config, download_mode: 'usenet_only', sabnzbd_url: 'http://sab.local', sabnzbd_key_configured: true }
  preflightMode = 'enough'
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Download whole Usenet sources')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Usenet sources cannot be split per episode') && document.querySelector('dialog[open]').textContent.includes('SABnzbd')`), 'Whole Usenet sources name their scope and client')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Download whole Usenet sources')).querySelector('input').click()`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`), 'Approximate space still requires acknowledgement')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`), 'Both acknowledgements unlock submission')
  await key('Escape')
  config = torrentConfigBeforeWhole
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  preflightMode = 'existing'
  await click('Refresh review')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Nothing new to send')`)
  assert.equal(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent`), '0 B')
  preflightMode = 'unavailable'
  await click('Refresh review')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('free space unknown')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`), 'Unconfirmed free space needs its own acknowledgement')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 1 download').disabled`))
  preflightMode = 'failure'
  await click('Refresh review')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Check unavailable')`)
  preflightMode = 'enough'
  await click('Refresh review')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1000 B free')`)
  console.log('PASS bulk scoped estimate, disk and whole-source acknowledgements, existing units, and unavailable checks')
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
  await click('Automation & webhooks')
  const unhideSwitch = '[role=switch][aria-labelledby=unhide-on-new-best-label]'
  assert.equal(await evaluate(`document.querySelector('${unhideSwitch}').getAttribute('aria-checked')`), 'false')
  await evaluate(`document.querySelector('${unhideSwitch}').focus()`)
  await key('Enter')
  assert.equal(await evaluate(`document.querySelector('${unhideSwitch}').getAttribute('aria-checked')`), 'true')
  await capture('unhide-setting-desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`document.querySelector('${unhideSwitch}').scrollIntoView({ block: 'center' })`)
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Unhide setting fits mobile width')
  await capture('unhide-setting-mobile')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await fill('input[name=sonarr_url]', 'http://draft.local')
  await wait(`document.body.textContent.includes('Unsaved changes')`)
  config.hidden = ['1']; revision++
  await pause(10_500)
  await wait(`!document.querySelector('.library-grid [aria-label="Details for Example anime"]')`)
  assert.equal(await evaluate(`document.querySelector('input[name=sonarr_url]').value`), 'http://draft.local', 'Visibility updates preserve unsaved configuration')
  config.hidden = []; revision++
  await pause(10_500)
  await wait(`document.querySelector('.library-grid [aria-label="Details for Example anime"]')`)
  assert.equal(await evaluate(`document.querySelector('${unhideSwitch}').getAttribute('aria-checked')`), 'true', 'Automatic unhiding preserves the settings draft')
  console.log('PASS unhide setting keyboard control, mobile layout, live visibility refresh, and draft preservation')
  await click('Scan history')
  await click('Configuration')
  assert.equal(await evaluate(`document.querySelector('input[name=sonarr_url]').value`), 'http://draft.local')
  await click('Save configuration')
  await wait(`document.body.textContent.includes('All configuration changes saved')`)
  assert.equal(saved.at(-1).sonarr_url, 'http://draft.local')
  assert.equal(saved.at(-1).unhide_on_new_best, true)
  console.log('PASS settings draft survives navigation and saves')

  await fill('input[name=sonarr_url]', 'http://next.local')
  saveDelay = 500
  await click('Save configuration')
  assert.ok(await evaluate(`document.querySelector('input[name=sonarr_url]').matches(':disabled')`), 'Settings cannot be edited during a pending save')
  await wait(`document.body.textContent.includes('All configuration changes saved')`)
  saveDelay = 0
  console.log('PASS pending settings save protects newer edits')

  // Download delivery: method choice, SABnzbd client, and Usenet source cards.
  await wait(`document.querySelector('input[name=download_mode]')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('input[name=download_mode]')].map(input => [input.closest('label').textContent.trim(), input.checked])`),
    [['Torrents only (qBittorrent)', true], ['Usenet only (SABnzbd)', false], ['Choose per release', false]], 'Download method offers three modes with torrents only selected')
  assert.ok(await evaluate(`document.querySelector('[role="radiogroup"][aria-label="Download method"]').getClientRects().length > 0`), 'The download method choice is reachable without extra expansion')
  assert.ok(await evaluate(`(() => { const card = [...document.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent === 'SABnzbd'); return Boolean(card && card.querySelector('input[name=sabnzbd_url]') && card.querySelector('input[name=sabnzbd_key]') && card.querySelector('input[name=sabnzbd_sonarr_category]') && card.querySelector('input[name=sabnzbd_radarr_category]')) })()`), 'The SABnzbd card collects its URL, key, and per-app categories')
  await evaluate(`(() => { [...document.querySelectorAll('details > summary')].find(summary => summary.textContent.includes('Usenet sources')).click(); return true })()`)
  await wait(`document.body.textContent.includes('Search AnimeTosho for NZBs') && document.body.textContent.includes('Search AmeNZB for NZBs')`)
  assert.ok(await evaluate(`Boolean(document.querySelector('input[name=animetosho_url]') && document.querySelector('input[name=amenzb_url]') && document.querySelector('input[name=amenzb_key]'))`), 'Both Usenet sources are configurable')
  assert.ok(await evaluate(`!document.body.textContent.includes('Usenet-only mode needs a working SABnzbd connection.')`), 'Torrents-only mode shows no Usenet warning')
  await evaluate(`document.querySelectorAll('input[name=download_mode]')[1].click()`)
  await wait(`document.body.textContent.includes('Usenet-only mode needs a working SABnzbd connection.')`)
  assert.ok(await evaluate(`document.querySelector('[role="radiogroup"][aria-label="Download method"]').closest('section').textContent.includes('Usenet-only mode needs a working SABnzbd connection.')`), 'The warning sits with the download method choice')
  await capture('settings-usenet-warning')
  await evaluate(`document.querySelectorAll('input[name=download_mode]')[0].click()`)
  await wait(`document.querySelector('input[name=download_mode]').checked && !document.body.textContent.includes('Usenet-only mode needs a working SABnzbd connection.')`)
  assert.ok(await evaluate(`!document.body.textContent.includes('Unsaved changes')`), 'Restoring the saved download method leaves no unsaved draft')
  console.log('PASS download method radios, SABnzbd and Usenet source cards, and the Usenet-only warning')

  fixtureHistory = readableHistory()
  await click('Scan history')
  await wait(`document.body.textContent.includes('Still upgradable')`)
  assert.ok(await evaluate(`!document.body.textContent.includes('Upgradable → Upgradable')`), 'History omits unchanged status transitions')
  assert.ok(await evaluate(`(() => { const row = [...document.querySelectorAll('article > div > ul > li')].find(row => row.textContent.includes('To LOVE-Ru')); return row && row.textContent.includes('Torrent replaced') && row.textContent.includes('Old group (AB) → New group (Nyaa)') && row.textContent.includes('Season 2') })()`), 'Compact history shows the action, season and both release groups')
  await evaluate(`[...document.querySelectorAll('article details summary')].find(summary => summary.textContent.includes('SeaDex note updated')).focus()`)
  await key('Enter')
  assert.ok(await evaluate(`(() => { const notes = document.activeElement.closest('details'); return notes.open && notes.innerText.includes('Use the weekly releases') && notes.innerText.includes('Use the season batch') })()`), 'History reveals both note versions with the keyboard')
  await evaluate(`document.querySelectorAll('[aria-label="Dismiss notification"]').forEach(button => button.click())`)
  await capture('history-clear-desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Readable history fits mobile')
  await evaluate(`[...document.querySelectorAll('article > div > ul > li')].find(row => row.textContent.includes('To LOVE-Ru')).scrollIntoView({ block: 'start' })`)
  await capture('history-clear-mobile')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  console.log('PASS action-first history details and unchanged-status context on desktop and mobile')
  fixtureHistory = null
  await click('Example anime')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Correct match')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] button[aria-label^="Pause download"]')].map(button => button.getAttribute('aria-label'))`), ['Pause download · S1 · Alternative'], 'Only the release the client reports keeps download controls')
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
  await wait(`document.querySelector('[aria-label="Active downloads"]')?.textContent.includes('qBittorrent · Error')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Active downloads"]').textContent.includes('Fixture client error')`), 'Rows surface the client error text')
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Active downloads"] [role="alert"]').length`), 1, 'An errored row announces itself')
  progressMode = 'complete'
  await wait(`!document.querySelector('[aria-label="Active downloads"]')`)
  progressMode = 'absent'
  await click('Scan history')
  await click('Example anime')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Correct match')`)
  await wait(`document.querySelectorAll('dialog[open] button[title^="Send this release"]').length === 2 && [...document.querySelectorAll('dialog[open] button[title^="Send this release"]')].every(button => !button.disabled)`)
  await key('Escape')
  // The details modal unmounts ~220ms after it hides; a click before that is dropped.
  await wait(`document.querySelectorAll('dialog[open]').length === 0 && !document.querySelector('dialog')`)
  console.log('PASS release identity changes, download errors, and removal of completed torrents')

  const beforeSharedProgress = { fixtureResults, progressMode }
  const sharedRelease = { ...release('Shared current acquisition', 'b'), selected_files: ['01.mkv'] }
  const sharedSecondSeason = { ...example, key: 'Sonarr:1:2:Shared', season: 2, releases: [{ ...sharedRelease, selected_files: ['02.mkv'] }] }
  fixtureResults = [{ ...example, releases: [sharedRelease, release('Replacement acquisition', 'd')] }, sharedSecondSeason]
  const sharedRecord = { ...progressFor(), record_id: 'record-shared', associations: [{ key: example.key, release: 0 }, { key: sharedSecondSeason.key, release: 0 }, { key: example.key, release: 0 }], scope: ['01.mkv', '02.mkv'], release_group: 'Shared current acquisition' }
  const obsoleteRecord = { ...progressFor(), record_id: 'record-obsolete-original', source_hash: 'c'.repeat(40), native_id: 'c'.repeat(40), associations: [{ key: example.key, release: 1 }], release_group: 'Original obsolete acquisition' }
  progressOverrides = { [sharedRecord.record_id]: sharedRecord, [obsoleteRecord.record_id]: obsoleteRecord }
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('[aria-label="Active downloads"]')?.textContent.includes('Original obsolete acquisition')`)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Active downloads"] button[aria-label^="Pause download"]').length`), 2, 'Shared associations do not duplicate record controls on the card')
  await click('Details')
  await wait(`document.querySelectorAll('.details-season-disclosure[open]').length === 2`)
  assert.equal(await evaluate(`document.querySelectorAll('.release-row [role="progressbar"]').length`), 2, 'A shared record supplies progress to every covered current season')
  assert.ok(await evaluate(`[...document.querySelectorAll('.release-row')].find(row => row.textContent.includes('Replacement acquisition')).querySelector('.release-download-button')?.disabled === false`), 'An obsolete acquisition does not block its replacement')
  await key('Escape')
  await wait(`!document.querySelector('dialog[open]')`)
  await evaluate(`[...document.querySelectorAll('[aria-label="Active downloads"] button')].find(button => button.getAttribute('aria-label')?.includes('Remove download') && button.getAttribute('aria-label')?.includes('Original obsolete acquisition')).click()`)
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Remove download from qBittorrent')`)
  await click('Remove from qBittorrent')
  await wait(`!document.querySelector('dialog[open]')`)
  assert.equal(controlRequests.at(-1).record_id, obsoleteRecord.record_id, 'Obsolete downloads retain control of the original record')
  assert.equal(controlRequests.at(-1).delete_files, false, 'Original-record cleanup keeps its files by default')
  progressOverrides = null
  ;({ fixtureResults, progressMode } = beforeSharedProgress)
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Example anime"]')`)
  // Single release: review first, then send. Failures keep the review usable.
  const sendFirstRelease = () => evaluate(`(() => { const button = document.querySelector('dialog[open] button[title^="Send this release"]'); button.focus(); button.click(); return true })()`)
  const reviewOpen = () => evaluate(`[...document.querySelectorAll('dialog[open]')].some(dialog => dialog.textContent.includes('Send to download client'))`)
  const sendNowDisabled = () => evaluate(`(() => { const button = [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Send now'); return !button || button.disabled })()`)
  const dismissToasts = () => evaluate(`document.querySelectorAll('[aria-label="Dismiss notification"]').forEach(button => button.click())`)
  singleSendMode = 'ok'
  await evaluate(`document.querySelector('button[aria-label="Details for Example anime"]').click()`)
  await wait(`(() => { const details = document.querySelector('dialog[open] .details-season-disclosure'); if (details && !details.open) details.querySelector('summary').click(); return Boolean(details?.open && details.querySelectorAll('button[title^="Send this release"]').length === 2) })()`)
  await sendFirstRelease()
  await wait(`document.querySelector('#single-plan-title') && [...document.querySelectorAll('dialog[open]')].at(-1)?.textContent.includes('To send')`)
  assert.ok(await evaluate(`(() => { const dialog = [...document.querySelectorAll('dialog[open]')].at(-1); return dialog.textContent.includes('S01 · Example') && dialog.textContent.includes('To send') && dialog.textContent.includes('qBittorrent · sonarr-anime') })()`), 'The review names the release, the unit, its client, and its category')
  assert.equal(await sendNowDisabled(), false, 'A reviewed release can be sent immediately')
  singleSendMode = 'expired'
  await click('Send now')
  await wait(`document.body.textContent.includes('This review has expired or was already used. Re-run the review before submitting.')`)
  assert.ok(await reviewOpen(), 'An expired review stays open for another attempt')
  assert.equal(await sendNowDisabled(), true, 'A consumed plan no longer offers Send now')
  const expiredId = singleRequests.at(-1).plan_id
  assert.equal(preflightPlans.has(expiredId), false, 'The fixture consumes each plan exactly once')
  const afterExpiredSend = singleRequests.length
  await pause(300)
  assert.equal(singleRequests.length, afterExpiredSend, 'A failed send is never replayed automatically')
  singleSendMode = 'transient'
  preflightMode = 'low'
  await click('Refresh review')
  await wait(`[...document.querySelectorAll('dialog[open] label')].some(label => label.textContent.includes('Continue without confirmed free space'))`)
  assert.notEqual([...preflightPlans.keys()].at(-1), expiredId, 'Recovery obtains a fresh preflight plan')
  assert.equal(await sendNowDisabled(), true)
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  await click('Send now')
  await wait(`document.body.textContent.includes('Fixture client temporarily unavailable')`)
  assert.equal(await sendNowDisabled(), true, 'An ordinary failure also consumes its review')
  await click('Refresh review')
  await wait(`[...document.querySelectorAll('dialog[open] label')].some(label => label.textContent.includes('Continue without confirmed free space'))`)
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').checked`), 'Fresh preflight resets the prior acknowledgement')
  await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Continue without confirmed free space')).querySelector('input').click()`)
  singleSendMode = 'unknown'
  await click('Send now')
  await wait(`document.body.textContent.includes('Check qBittorrent before retrying')`)
  assert.ok(await evaluate(`document.body.textContent.includes('qBittorrent was asked to start this download but did not confirm it. Check qBittorrent before retrying.')`), 'Structured uncertainty names the actual client')
  await pause(300)
  assert.equal(await reviewOpen(), false, 'An ambiguous send is not repeated while its state is unknown')
  await dismissToasts()
  singleSendMode = 'ok'
  preflightMode = 'enough'
  await sendFirstRelease()
  await wait(`document.querySelector('#single-plan-title') && [...document.querySelectorAll('dialog[open]')].at(-1)?.textContent.includes('To send')`)
  await click('Send now')
  await wait(`document.body.textContent.includes('Sent S01 · Example to qBittorrent')`)
  assert.equal(await reviewOpen(), false, 'A confirmed send closes the review')
  await dismissToasts()
  await key('Escape')
  await wait(`document.querySelectorAll('dialog[open]').length === 0`)
  console.log('PASS single-release review, expired and transient plan recovery, client-specific acceptance uncertainty, and confirmed send')

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
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim().startsWith('Start ')).disabled`), 'Unresolved release choices prevent submission')
  await select('[aria-label="Bulk action scope"]', 'all')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('3 eligible')`)
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Hidden upgrade')).querySelector('input').checked === false`), 'Whole-library review keeps hidden titles unchecked')
  await select('[aria-label="Bulk action scope"]', 'filtered')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('1 eligible')`)
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Dual Audio') && document.querySelector('dialog[open]').textContent.includes('HEVC') && document.querySelector('dialog[open]').textContent.includes('Compare the audio')`), 'Choices expose release tags and notes')
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`document.querySelectorAll('dialog[open] input[type=radio]')[1]?.checked && [...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Start 1 download' && !button.disabled)`)
  await capture('priorities-scoped-review')
  holdBulk = true
  await click('Start 1 download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Continue in background')`)
  assert.match(await evaluate(`document.querySelector('dialog[open]').textContent`), /Sending… 0\/1/, 'An in-flight batch reports the units still waiting on the client')
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
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Sent to qBittorrent')`)
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].checked && document.querySelectorAll('dialog[open] input[type=radio]')[1].disabled`), 'Completed batch keeps an immutable record')
  await capture('priorities-completed-batch')
  await click('Close')
  bulkOutcome = 'existing'
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Start 1 download' && !button.disabled)`)
  await click('Start 1 download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Already queued in the client')`)
  await click('Close')
  bulkOutcome = 'added'
  failBulk = true
  await click('Bulk download')
  await evaluate(`document.querySelector('dialog[open] button[aria-expanded]').click()`)
  await wait(`document.querySelector('dialog[open] input[type=radio]')`)
  await evaluate(`document.querySelectorAll('dialog[open] input[type=radio]')[1].click()`)
  await wait(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Start 1 download' && !button.disabled)`)
  await click('Start 1 download')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Could not be added — review the operation error details')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Application operations"]').textContent.includes('1/1') && !document.querySelector('[aria-label="Application operations"]').textContent.includes('2/1')`), 'A failed unit is counted once in the completed batch')
  await capture('priorities-failed-batch')
  await click('Close')
  await click('Error details')
  assert.ok(await evaluate(`document.querySelector('[aria-label="Bulk operation error details"]').textContent.includes('Radarr movie') && document.querySelector('[aria-label="Bulk operation error details"]').textContent.includes('Fixture metadata timeout')`), 'Per-item failure details remain available after closing review')
  failBulk = false
  cancelableDownloads = [example, movie].map(cancelableFor)
  await click('Bulk cancel')
  await wait(`document.querySelector('dialog[open]')?.textContent.includes('Radarr movie')`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]')?.textContent.includes('Cancel downloads')`), 'The cancellation dialog is titled by its action')
  assert.ok(await evaluate(`(() => { const dialog = document.querySelector('dialog[open]'); return dialog.textContent.includes('Example anime') && dialog.textContent.includes('qBittorrent') && dialog.textContent.includes('Queued') })()`), 'Cancellation lists what the clients report, each with its client and state')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Remove 2 downloads')`), 'The action counts the selected downloads')
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes('Also delete')).querySelector('input').checked`), 'Bulk cancellation keeps files by default')
  const reviewedCancelIds = cancelableDownloads.map(item => item.record_id)
  const arrivedAfterReview = { ...cancelableFor(hidden, 2), record_id: 'record-arrived-after-review' }
  cancelableDownloads.push(arrivedAfterReview)
  await click('Remove 2 downloads')
  await wait(`document.body.textContent.includes('Cancelled 2 downloads; files were kept')`)
  await wait(`document.querySelectorAll('dialog[open]').length === 0 && !document.querySelector('dialog')`)
  assert.deepEqual(cancelRequests.at(-1).record_ids, reviewedCancelIds, 'All checked submits the exact reviewed list, never an undefined-as-all command')
  assert.deepEqual(cancelableDownloads.map(item => item.record_id), [arrivedAfterReview.record_id], 'A record arriving after review is not removed')
  await dismissToasts()
  console.log('PASS filtered/all-library bulk scope, hidden defaults, recommendation evidence, immutable background batches, and client-scoped cancellation')

  const beforeLargeScope = { config, fixtureResults, preflightMode, progressMode }
  config = { ...config, download_mode: 'usenet_only', sabnzbd_url: 'http://sab.local', sabnzbd_key_configured: true, hidden: [] }
  fixtureResults = Array.from({ length: 201 }, (_, index) => {
    const hash = (index + 1).toString(16).padStart(40, '0')
    const rel = { ...release(`Whole-library release ${index}`, 'a'), info_hashes: [hash], torrent_files: [{ hash, files: [{ name: '01.mkv', length: 120 }, { name: '02.mkv', length: 80 }] }] }
    return { ...example, key: `Sonarr:large:${index}`, group_id: index + 100, library_key: `Sonarr:large:${index}`, title: `Whole-library anime ${index}`, releases: [rel] }
  })
  fixtureResults.push({ ...fixtureResults[0], key: 'Sonarr:large:shared', group_id: 999, title: 'Whole-library shared source' })
  progressMode = 'absent'
  preflightMode = 'enough'
  availabilityMode = 'available'
  await evaluate(`location.hash='anime'; location.reload()`)
  await wait(`document.querySelector('button[aria-label="Details for Whole-library anime 0"]')`)
  await click('Bulk download')
  await select('[aria-label="Bulk action scope"]', 'all')
  await wait(`[...document.querySelectorAll('dialog[open] dt')].find(label => label.textContent === 'Selected releases')?.nextElementSibling?.textContent === '202' && [...document.querySelectorAll('dialog[open] dt')].find(label => label.textContent === 'New NZBs')?.nextElementSibling?.textContent === '201'`)
  assert.equal(preflightRequests.at(-1).selections.length, 202, 'Whole-library review keeps 201+ rows in one preflight')
  assert.ok(await evaluate(`document.querySelector('[data-testid="bulk-download-size"]').textContent.startsWith('≈')`), 'Deduplicated whole-library estimates remain visibly approximate')
  const acknowledgeLarge = copy => evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent.includes(${JSON.stringify(copy)})).querySelector('input').click()`)
  await acknowledgeLarge('Download whole Usenet sources')
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 201 downloads').disabled`), 'Approximate space has an explicit acknowledgement separate from source scope')
  await acknowledgeLarge('Continue without confirmed free space')
  assert.ok(await evaluate(`![...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === 'Start 201 downloads').disabled`))
  await key('Escape')
  ;({ config, fixtureResults, preflightMode, progressMode } = beforeLargeScope)

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
  const scansBeforeSetup = scanRequests.length
  await click('Scan library')
  assert.equal(scanRequests.length, scansBeforeSetup + 1)
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
  bulkState = { id: null, ok: true, finished: true, pending: [], added: [], existing: [], failures: [], targets: [] }
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
  for (const query of ['  oLD group  ', 'eXample', 's01']) {
    await fill('input[type=search]', query)
    await wait(`document.querySelector('[aria-label="Library page"]')?.value === '0'`)
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Library results"] article').length`), 60, 'Search retains ownership, release-group, and season terms: ' + query)
    assert.ok(await evaluate(`document.querySelector('[aria-label="Library pages"]').textContent.includes((1000).toLocaleString())`), 'Metadata search spans the whole collection')
  }
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
  cancelableDownloads = [cancelableFor({ title: '取消対象の長いアニメ名'.repeat(3), season: 1, release_group: 'VeryLongUnbrokenReleaseGroupName'.repeat(5) }, 0)]
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
  assert.ok(await evaluate(`(() => { const details=document.querySelector('.sidebar-status .operation-diagnostics'); return details.clientHeight <= innerHeight*.3+1 && details.textContent.includes('Sonarr request failed') })()`), 'Expanded diagnostics are bounded inside the sidebar')
  await capture('follow-up-expanded-diagnostics')
  assert.ok(await evaluate(`(() => { const box=document.querySelector('.sidebar-status').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight })()`), 'The sidebar keeps scan status visible without scrolling')
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
  fixtureHistory = readableHistory()
  for (const [width, height] of [[1440, 1000], [900, 900], [390, 844], [320, 700]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 901 })
    for (const route of ['anime', 'history', 'config', 'log']) {
      await evaluate(`location.hash = ${JSON.stringify(route)}`)
      await pause(350)
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= ${width}`), `${route} fits ${width}px viewport`)
      await evaluate(`document.querySelector('main > .app-scrollbar').scrollTop = 0`)
      await capture(`review-${width}-${route}`)
      if (route === 'history') {
        await wait(`document.body.textContent.includes('Torrent updated')`)
        await evaluate(`[...document.querySelectorAll('article > div > ul > li')].find(row => row.textContent.includes('To LOVE-Ru')).scrollIntoView({ block: 'start' })`)
        assert.ok(await evaluate(`(() => { const rows = [...document.querySelectorAll('article > div > ul > li')]; return rows.length === 6 && rows.every(row => row.scrollWidth <= row.clientWidth + 1) && !rows.some(row => row.textContent.includes('Upgradable → Upgradable')) })()`), 'History details and long names remain readable without clipping')
        await capture(`review-${width}-history-changes`)
      }
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
    await evaluate(`document.querySelectorAll('.details-season-disclosure, .details-cour').forEach(details => { details.open = true })`)
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
  anilistSearchResults = [200, 201].map(id => ({ id, title: `Example anime Season 2${id === 201 ? ' Part 2' : ''}`, year: 2026, format: 'ONA', episodes: 6, cover: null }))
  config.hidden = []
  progressMode = 'absent'
  for (const width of [320, 1440]) {
    fixtureResults = [{ ...example, status: 'best' }, { ...example, key: 'Sonarr:1:2:missing', season: 2, anilist_id: null, status: 'missing', match_status: 'unmatched', best_group: null, releases: [] }]
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 900 })
    await evaluate(`location.hash = 'anime'; location.reload()`)
    await wait(`document.querySelector('article')?.textContent.includes('Example anime')`)
    await click('Details')
    await wait(`document.querySelector('button[aria-label="Correct Season 2 match"]')`)
    await evaluate(`document.querySelector('button[aria-label="Correct Season 2 match"]').click()`)
    await wait(`document.querySelector('#mapping-title')?.textContent === 'Correct Season 2 match' && document.querySelector('button[aria-pressed="false"]')`)
    assert.ok(await evaluate(`document.querySelector('input[placeholder="Anime title"]').value.endsWith(' Season 2')`), 'Search starts with the affected season')
    assert.ok(await evaluate(`document.querySelectorAll('dialog[open]').length === 2`))
    assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).textContent.includes('Season 2 of Example anime')`))
    for (const id of [200, 201]) await evaluate(`(() => { const dialog = [...document.querySelectorAll('dialog[open]')].at(-1); [...dialog.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.includes('AniList #${id}')).click() })()`)
    await evaluate(`document.querySelector('button[aria-label="Move AniList 201 earlier"]').click()`)
    assert.ok(await evaluate(`[...document.querySelectorAll('[aria-label="Selected AniList entries"] li')][0].textContent.includes('Part 2')`))
    await evaluate(`document.querySelector('button[aria-label="Move AniList 200 earlier"]').click()`)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Season mapping fits the viewport')
    assert.ok(await evaluate(`(() => { const dialog = [...document.querySelectorAll('dialog[open]')].at(-1); return dialog.scrollWidth <= dialog.clientWidth + 1 })()`), 'Season mapping dialog has no horizontal overflow')
    await capture(`season-mapping-${width}`)
    const beforeSave = scanRequests.length
    if (width === 320) {
      mappingFailure = true
      await click('Save and rescan')
      await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Fixture match save failed')`)
      assert.equal(scanRequests.length, beforeSave, 'A failed save cannot start a scan')
      assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Selected AniList entries"] li').length`), 2, 'A failed save preserves selections')
      mappingFailure = false
    }
    await click('Save and rescan')
    await wait(`document.querySelectorAll('dialog[open]').length === 1`)
    assert.deepEqual(mappingRequests.at(-1), { library_key: 'Sonarr:item1', season: 2, anilist_ids: [200, 201] })
    assert.ok(scanRequests.length > beforeSave, 'Saving a season mapping starts a scan')
    await key('Escape')

    fixtureResults[1] = { ...fixtureResults[1], anilist_id: 200, anilist_ids: [200, 201], match_status: 'matched', season_mapping_override: true }
    await evaluate(`location.reload()`)
    await wait(`document.querySelector('article')?.textContent.includes('Example anime')`)
    await click('Details')
    await wait(`document.querySelector('button[aria-label="Change Season 2 match"]')`)
    assert.ok(await evaluate(`document.querySelector('a[aria-label="Open Season 2 in AniList"]').href.endsWith('/200')`))
    await evaluate(`document.querySelector('button[aria-label="Change Season 2 match"]').click()`)
    await wait(`document.querySelector('[aria-label="Selected AniList entries"] li')`)
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Selected AniList entries"] li').length`), 2)
    await click('Use automatic match')
    await wait(`document.querySelectorAll('dialog[open]').length === 1`)
    assert.deepEqual(mappingRequests.at(-1), { library_key: 'Sonarr:item1', season: 2, anilist_ids: null })
    await key('Escape')
  }
  console.log('PASS season-specific selection, cour ordering, save/rescan, reset, and responsive dialogs at 320/1440px')
  bulkState = {
    ...bulkState, id: 'recovered-existing-job', ok: true, finished: true, pending: [], added: [], failures: [],
    existing: [{ unit_id: 'recovered-unit', protocol: 'torrent', record_id: 'record-recovered', native_id: 'a'.repeat(40), source_hash: 'a'.repeat(40), label: 'Example anime', selections: [{ key: example.key, release: 1 }] }],
    targets: [{ key: example.key, release: 1 }],
  }
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('[aria-label="Application operations"]')?.textContent.includes('1 already queued')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Application operations"]').textContent.includes('1/1')`), 'Recovered batches count existing units as settled')
  console.log('PASS failed and recovered-existing batch progress counts')
  assert.ok(await evaluate(`(() => { const button = document.querySelector('[aria-label="Dismiss bulk operation"]'); if (!button) return false; button.click(); return true })()`), 'Finished bulk banner offers dismissal')
  await wait(`!document.querySelector('[aria-label="Dismiss bulk operation"]')`)
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('h1')`)
  await pause(1200)
  assert.ok(!(await evaluate(`Boolean(document.querySelector('[aria-label="Dismiss bulk operation"]'))`)), 'Dismissed bulk banners must not return after reload')
  bulkState = { ...bulkState, id: 'newer-bulk-job' }
  await evaluate(`location.reload()`)
  await wait(`document.querySelector('[aria-label="Application operations"]')?.textContent.includes('1 already queued')`)
  console.log('PASS dismissed bulk download banners stay dismissed across reloads while newer jobs still restore')
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
