// Plan-acceptance flow regressions: modes, dedup, conflicts, intent-before-mutation,
// ambiguous SABnzbd handling, progress phases, and ownership-only cancellation.
// Runs inside the shared temp DATA_DIR (tests/run-tests.mjs) or standalone with DATA_DIR set.
import assert from 'node:assert/strict'
// static imports continue below
import { test } from 'node:test'
import { DEFAULT_CONFIG, downloadCategory } from '../server/config.js'
import { bumpGeneration, currentGeneration } from '../server/config-generation.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { consumePlan, putPlan } from '../server/download-plans.js'
import { acceptDownloadPlan, PlanRejected, receiptFromJob } from '../server/download-submit.js'
import { downloadJobs } from '../server/download-jobs.js'
import { addDownloadRecord, allDownloadRecords, downloadRecords, findDownloadRecord, findTorrentRecord, resetOwnedRuntime } from '../server/download-store.js'
import { collectDownloadProgress, cancelRecords, controlRecord, OwnershipError, historyPhase, qbPhase, queuePhase } from '../server/download-progress.js'
import { invalidateUsenetLookups } from '../server/usenet.js'
import { resetQbRuntime } from '../server/qbittorrent.js'
import type { Config, ResultItem } from '../server/types.js'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDownloadRequest } from '../server/download-routes.js'

const HASH = 'a'.repeat(40)
const QB = 'http://qb.test:8080'
const SAB = 'http://sab.test:8080'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    qbittorrent_url: QB, qbittorrent_user: 'u', qbittorrent_pass: 'p',
    animetosho_enabled: true,
    amenzb_enabled: false,
    sabnzbd_url: `${SAB}/`, sabnzbd_key: 'sab-key',
    download_mode: 'choose',
    ...overrides,
  } as Config
}

function releaseFixture(overrides: Record<string, unknown> = {}) {
  return { kind: 'best', releaseGroup: 'Group', tracker: 'Nyaa', torrent_available: true, info_hashes: [HASH], size: 1_000_000, part: 'Cour 1', torrent_files: [{ hash: HASH, files: [{ name: 'Show - 01.mkv', length: 1_000_000 }] }], ...overrides }
}

function resultFixture(releases: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    key: 'show-1', arr: 'Sonarr', title: 'Show', season: 1, status: 'upgrade', upgrade_available: true,
    excluded: false, precise_part_ownership: false, have: [], owned_by_part: {},
    releases, ...overrides,
  }
}

interface RouterState {
  calls: string[]
  qbTorrents?: { hash?: string; state?: string; progress?: number; size?: number; dlspeed?: number }[]
  qbAddStatus?: number
  qbAddBody?: string
  sabQueue?: Record<string, unknown>[]
  sabHistory?: Record<string, unknown>[]
  sabAddResult?: () => Response | Promise<Response>
  animetosho?: () => Response
  qbFiles?: Record<string, unknown>[]
  qbDeleteStatus?: number
  qbFreeBytes?: string
  sabDisk?: { diskspace1?: string; diskspace2?: string }
}

function installRouter(state: RouterState): () => void {
  const original = globalThis.fetch
  resetQbRuntime()
  resetOwnedRuntime()
  invalidateUsenetLookups()
  purgeTestDataDir()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.calls.push(`${init?.method || 'GET'} ${url}`)
    const body = typeof init?.body === 'string' || init?.body instanceof URLSearchParams ? String(init.body) : ''
    if (url.includes('animetosho.net/json')) return (state.animetosho ?? (() => new Response('gone', { status: 404 })))()
    if (url.includes('animetosho.net/nzb/')) return new Response('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="test@example.test" date="1700000000" subject="Show - 01.mkv"><groups><group>alt.binaries.anime</group></groups><segments><segment bytes="1000" number="1">show-part-1@example.test</segment></segments></file></nzb>', { headers: { 'content-type': 'application/x-nzb' } })
    if (url.startsWith(QB)) {
      if (url.includes('/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.includes('/torrents/info?hashes=')) {
        if (!state.qbAddBody && body) state.qbAddBody = body
        const wanted = decodeURIComponent(url.split('hashes=')[1] || '')
        const matches = (state.qbTorrents || []).filter((torrent: { hash?: string }) => String(torrent.hash || '') === wanted)
        return Response.json(matches)
      }
      if (url.includes('/torrents/add')) {
        state.qbAddBody = body
        if (state.qbAddStatus === 200 || state.qbAddStatus === undefined) {
          const hash = new URLSearchParams(body).get('urls')?.match(/btih:([a-f0-9]{40})/)?.[1]
          if (hash) state.qbTorrents = [...(state.qbTorrents || []), { hash, state: 'downloading' }]
        }
        return new Response(state.qbAddStatus === 200 || state.qbAddStatus === undefined ? 'Ok.' : 'exists', { status: state.qbAddStatus ?? 200 })
      }
      if (url.includes('/torrents/info')) return Response.json(state.qbTorrents || [])
      if (url.includes('/app/preferences')) return Response.json({ auto_tmm_enabled: true, save_path: '/downloads', use_category_paths_in_manual_mode: false, temp_path_enabled: false })
      if (url.includes('/sync/maindata')) return Response.json({ server_state: { free_space_on_disk: 500_000_000_000 } })
      if (url.includes('/torrents/categories')) return Response.json({ 'sonarr-anime': { savePath: '/downloads/anime' }, anime: { savePath: '/downloads/anime' } })
      if (url.includes('getFreeSpaceAtPath')) return new Response(state.qbFreeBytes ?? '500000000000')
      if (url.includes('/torrents/files')) return Response.json(state.qbFiles || [{ name: 'Show - 01.mkv', index: 0, size: 1_000_000 }])
      if (url.includes('/torrents/delete')) {
        if (!state.qbDeleteStatus || state.qbDeleteStatus === 200) {
          const hash = new URLSearchParams(body).get('hashes')
          state.qbTorrents = (state.qbTorrents || []).filter(torrent => torrent.hash !== hash)
        }
        return new Response('Ok.', { status: state.qbDeleteStatus ?? 200 })
      }
      if (/\/torrents\/(stop|start|pause|resume|filePrio)/.test(url)) return new Response('Ok.', { status: 200 })
    }
    if (url.startsWith(SAB)) {
      const query = new URL(url).searchParams
      const mode = query.get('mode')
      const name = query.get('name')
      if (init?.method === 'POST') return (state.sabAddResult ?? (() => Response.json({ status: true, nzo_ids: ['nzo1'] })))()
      if (mode === 'queue') {
        if (name === 'pause' || name === 'resume' || name === 'delete') return Response.json({ status: true })
        const ids = (new URL(url).searchParams.get('nzo_ids') || '').split(',').filter(Boolean)
        const slots = (state.sabQueue || []).filter((job: Record<string, unknown>) => !ids.length || ids.includes(String(job.nzo_id)))
        return Response.json({ queue: { paused_all: false, ...(state.sabDisk || { diskspace1: '931.5', diskspace2: '931.5' }), slots } })
      }
      if (mode === 'history') {
        if (name === 'delete') return Response.json({ status: true })
        const ids = (new URL(url).searchParams.get('nzo_ids') || '').split(',').filter(Boolean)
        const slots = (state.sabHistory || []).filter((job: Record<string, unknown>) => !ids.length || ids.includes(String(job.nzo_id)))
        return Response.json({ history: { slots } })
      }
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
  return () => { globalThis.fetch = original; resetQbRuntime(); resetOwnedRuntime(); purgeTestDataDir() }
}

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../server/paths.js'

function purgeTestDataDir(): void {
  for (const file of ['owned_downloads.json', 'download_jobs.json']) {
    const path = join(DATA_DIR, file)
    if (existsSync(path)) rmSync(path)
  }
  downloadJobs.restore()
}

const animetoshoMatch = (hash = HASH) => Response.json({
  id: 1234, info_hash: hash.toUpperCase(), nzb_url: `https://feed.animetosho.net/nzb/1234`,
  title: 'Show S01E01', torrent_name: 'Show 1080p', status: 'complete', deleted: false,
  num_files: 2, total_size: 500_000_000,
  files: [{ name: 'Show - 01.mkv', size: 400_000_000, processed: true }, { name: 'Show - 02.nfo', size: 100, processed: true }],
})

test('torrent_only mode refuses usenet selections and choose mode requires an explicit protocol', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const refused = await buildDownloadPlan(baseConfig({ download_mode: 'torrent_only' }), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in refused)
    assert.deepEqual(refused.review.blocked.map(row => row.code), ['mode_conflict'])
    assert.equal(refused.review.units.length, 0)

    const missing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0 }], { results })
    assert.ok('review' in missing)
    assert.deepEqual(missing.review.blocked.map(row => row.code), ['protocol_required'])
  } finally { cleanup() }
})

test('usenet rows are blocked while SABnzbd is missing and identities are enforced', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const noSab = await buildDownloadPlan(baseConfig({ sabnzbd_key: '' }), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in noSab)
    assert.deepEqual(noSab.review.blocked.map(row => row.code), ['usenet_unconfigured'])

    const stale = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet', identity: 'stale-identity' }], { results })
    assert.ok('error' in stale)
    assert.equal(stale.error[0], 409)
  } finally { cleanup() }
})

test('two cours sharing one hash produce one deduplicated torrent unit carrying both selections', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [
      resultFixture([releaseFixture({ part: 'Cour 1' })]),
      resultFixture([releaseFixture({ part: 'Cour 2' })], { key: 'show-2' }),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }, { key: 'show-2', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    assert.equal(built.review.units.length, 1)
    assert.equal(built.review.units[0].selections.length, 2)
    assert.equal(built.review.new_torrents, 1)
    assert.equal(built.review.new_nzbs, 0)
  } finally { cleanup() }
})

test('a hash already present in qBittorrent is an existing unit, never a new submission', async () => {
  const cleanup = installRouter({ calls: [], qbTorrents: [{ hash: HASH, state: 'uploading', progress: 0.5, size: 1000 }] })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    assert.equal(built.review.units[0].status, 'existing')
    assert.equal(built.review.new_torrents, 0)
    assert.equal(built.review.existing_units, 1)
  } finally { cleanup() }
})

test('the same source requested through both protocols is blocked as a conflict', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [
      resultFixture([releaseFixture({ part: 'Cour 1' })]),
      resultFixture([releaseFixture({ part: 'Cour 2' })], { key: 'show-2' }),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [
      { key: 'show-1', release: 0, protocol: 'torrent' },
      { key: 'show-2', release: 0, protocol: 'usenet' },
    ], { results })
    assert.ok('review' in built)
    assert.equal(built.review.units.length, 0)
    assert.deepEqual([...new Set(built.review.blocked.map(row => row.code))], ['conflict'])
  } finally { cleanup() }
})

test('usenet whole-source scope is surfaced with known extra files and forces the acknowledgement', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    const unit = built.review.units[0]
    assert.equal(unit.protocol, 'usenet')
    assert.equal(unit.whole_source, true)
    assert.equal(unit.scope_expanded, true)
    assert.deepEqual(unit.known_extra_files, ['Show - 02.nfo'])
    assert.equal(built.review.requires_whole_ack, true)
    assert.equal(built.review.new_nzbs, 1)
    assert.ok(built.review.disk_space.every(check => check.client === 'sabnzbd' && check.sufficient === null && check.unknown_units === 1))
  } finally { cleanup() }
})

test('plans are single-use and stale generations or missing acknowledgements are refused at acceptance', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const config = baseConfig()
    const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    const planId = built.review.plan_id
    assert.ok(built.review.requires_whole_ack)

    await assert.rejects(acceptDownloadPlan(config, consumePlan(planId)!, undefined, results), (error: PlanRejected) => error.status === 409 && /whole Usenet sources/.test(error.message))
    assert.equal(consumePlan(planId), null, 'a consumed plan can never be replayed')

    const fresh = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in fresh)
    bumpGeneration()
    await assert.rejects(
      acceptDownloadPlan(config, consumePlan(fresh.review.plan_id)!, { whole_source: true }, results),
      (error: PlanRejected) => error.status === 409 && /Settings changed/.test(error.message),
    )
  } finally { cleanup() }
})

test('torrent acceptance writes the intent before the client call and finalizes it as accepted', async () => {
  let intentVisibleDuringAdd = false
  let intentStateDuringAdd = ''
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const originalAdd = globalThis.fetch
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const plan = consumePlan(built.review.plan_id)!
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/torrents/add') && init?.method === 'POST') {
        const record = findTorrentRecord(HASH)
        intentVisibleDuringAdd = Boolean(record)
        intentStateDuringAdd = record?.state || ''
      }
      return originalAdd(input, init)
    }) as typeof fetch
    const { job, completion } = await acceptDownloadPlan(baseConfig(), plan, undefined, results)
    const result = await completion
    assert.equal(intentVisibleDuringAdd, true, 'the intent record must exist while the client call runs')
    assert.equal(intentStateDuringAdd, 'acceptance_unknown')
    assert.equal(result.count, 1)
    const record = findTorrentRecord(HASH)!
    assert.equal(record.state, 'accepted')
    assert.equal(record.native_id, HASH)
    assert.equal(record.endpoint, QB.toLowerCase())
    assert.deepEqual(downloadRecords().map(entry => entry.id), [record.id])
    const finalJob = downloadJobs.get(job.id)!
    assert.equal(finalJob.added.length, 1)
    const receipt = receiptFromJob(finalJob)
    assert.ok(!('error' in receipt) && receipt.ok && receipt.native_id === HASH)
  } finally { globalThis.fetch = originalAdd; cleanup() }
})

test('a clean client rejection tombstones the intent and reports the row as failed', async () => {
  const cleanup = installRouter({ calls: [], qbAddStatus: 409 })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.review.plan_id)!, undefined, results)
    const result = await completion
    assert.equal(result.count, 0)
    assert.equal(result.rows[0].status, 'failed')
    assert.equal(findTorrentRecord(HASH), null, 'rejected intent must leave the active ledger')
    assert.equal(allDownloadRecords()[0]?.removed_at !== undefined, true, 'the tombstone audit must survive')
  } finally { cleanup() }
})

test('an ambiguous SABnzbd outcome keeps the record, never retries the add, and says so', async () => {
  let addCalls = 0
  const state: RouterState = {
    calls: [], animetosho: animetoshoMatch,
    sabAddResult: () => { addCalls++; return Promise.reject(new TypeError('network')) },
  }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.review.plan_id)!, { whole_source: true, disk_space: true }, results)
    const result = await completion
    assert.equal(addCalls, 1, 'an ambiguous submission must never be retried automatically')
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].code, 'acceptance_unknown')
    assert.match(result.failures[0].error, /Check SABnzbd before retrying/)
    const record = downloadRecords().find(entry => entry.protocol === 'usenet')!
    assert.equal(record.state, 'acceptance_unknown')
  } finally { cleanup() }
})

test('progress maps both clients to labeled phases and refuses endpoint-mismatched records', async () => {
  const cleanup = installRouter({
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'stalledDL', progress: 0.5, size: 1000, dlspeed: 10 }],
    sabQueue: [{ nzo_id: 'nzoQ', name: 'Show', status: 'Downloading', cat: 'anime', mb: '500.0', mb_done: '125.0', speed: '1.0 MiB/s', percentage: 25, labels: [] }],
    sabHistory: [{ nzo_id: 'nzoH', name: 'Show', status: 'Extracting', cat: 'anime', size: '500.0', byte_size: 500_000_000, downloaded: 500_000_000, storage: '/downloads/anime/show', loaded: false }],
  })
  try {
    const config = baseConfig()
    const qbRecord = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: QB.toLowerCase(), native_id: HASH, state: 'accepted', source_hash: HASH, category: 'anime', labels: [], rows: [{ key: 'show-1', release: 0 }], card: { title: 'Show', season: 1, part: 'Cour 1', release_group: 'Group', tracker: 'Nyaa', size: 1000 } })
    const queueRecord = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: 'http://sab.test:8080', native_id: 'nzoQ', state: 'accepted', source_hash: 'c'.repeat(40), category: 'anime', labels: [], rows: [] })
    const historyRecord = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: 'http://sab.test:8080', native_id: 'nzoH', state: 'accepted', source_hash: 'd'.repeat(40), category: 'anime', labels: [], rows: [] })
    const foreignRecord = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: 'http://other-sab.test:8080', native_id: 'nzoX', state: 'accepted', source_hash: 'e'.repeat(40), category: 'anime', labels: [], rows: [] })
    const unknownRecord = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: 'http://sab.test:8080', native_id: '', state: 'acceptance_unknown', source_hash: 'f'.repeat(40), category: 'anime', labels: [], rows: [] })

    const progress = await collectDownloadProgress(config)
    assert.equal(progress.downloads[qbRecord.id].phase, 'downloading')
    assert.deepEqual(progress.downloads[qbRecord.id].associations, [{ key: 'show-1', release: 0 }])
    assert.equal(progress.downloads[queueRecord.id].phase, 'downloading')
    assert.equal(progress.downloads[queueRecord.id].capabilities.pause, true)
    assert.equal(progress.downloads[historyRecord.id].phase, 'unpacking')
    assert.equal(progress.downloads[historyRecord.id].capabilities.remove_files, false)
    assert.equal(progress.downloads[foreignRecord.id].phase, 'unavailable')
    assert.equal(progress.downloads[foreignRecord.id].state, 'unbound')
    assert.equal(progress.downloads[foreignRecord.id].capabilities.remove, false)
    assert.equal(progress.downloads[unknownRecord.id].phase, 'acceptance_unknown')

    await assert.rejects(controlRecord(config, foreignRecord.id, 'pause', false), OwnershipError)
    const cancel = await cancelRecords(config, [foreignRecord.id], false)
    assert.equal(cancel.removed.length, 0)
    assert.equal(cancel.failures.length, 1)
  } finally { cleanup() }
})

test('unreachable clients keep the persisted last phase instead of inventing missing', async () => {
  const cleanup = installRouter({ calls: [], qbTorrents: [{ hash: HASH, state: 'downloading', progress: 0.4, size: 1000, dlspeed: 5 }] })
  try {
    const config = baseConfig()
    const record = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: QB.toLowerCase(), native_id: HASH, state: 'accepted', source_hash: HASH, category: 'anime', labels: [], rows: [] })
    const first = await collectDownloadProgress(config)
    assert.equal(first.downloads[record.id].phase, 'downloading')
    assert.equal(findDownloadRecord(record.id)!.last_phase, 'downloading')

    globalThis.fetch = (async () => { throw new TypeError('offline') }) as typeof fetch
    resetQbRuntime()
    const second = await collectDownloadProgress(config)
    assert.equal(second.downloads[record.id].phase, 'downloading')
    assert.ok(second.unavailable_clients?.includes('qbittorrent'))
  } finally { cleanup() }
})

test('cancellation only ever touches app-owned records and audits removal', async () => {
  const state: RouterState = {
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'downloading', progress: 0.5, size: 1000, dlspeed: 5 }],
  }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const record = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: QB.toLowerCase(), native_id: HASH, state: 'accepted', source_hash: HASH, category: 'anime', labels: [], rows: [{ key: 'show-1', release: 0 }] })
    const cancel = await cancelRecords(config, undefined, false)
    assert.deepEqual(cancel.removed, [{ record_id: record.id, client: 'qbittorrent' }])
    assert.ok(state.calls.some(call => call.includes('/torrents/delete')))
    assert.equal(downloadRecords().length, 0)
    assert.equal(allDownloadRecords()[0].removed_at !== undefined, true)
  } finally { cleanup() }
})

test('phase maps cover the client-specific vocabularies', () => {
  assert.equal(qbPhase('missingFiles', 0.5), 'error')
  assert.equal(qbPhase('uploading', 1), 'seeding')
  assert.equal(qbPhase('pausedUP', 1), 'complete')
  assert.equal(qbPhase('queuedDL', 0), 'queued')
  assert.equal(qbPhase('checkingUP', 1), 'verifying')
  assert.equal(queuePhase('Propagating'), 'queued')
  assert.equal(queuePhase('Paused'), 'paused')
  assert.equal(historyPhase('QuickCheck'), 'verifying')
  assert.equal(historyPhase('Running'), 'post_processing')
  assert.equal(historyPhase('Failed'), 'error')
})

test('a rejected plan row still lets the other rows submit', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [resultFixture([releaseFixture()]), resultFixture([releaseFixture({ info_hashes: ['b'.repeat(40)] })], { key: 'show-2', status: 'complete', upgrade_available: false })] as unknown as ResultItem[]
    const plan = putPlan({ config_generation: currentGeneration(), selections: [
      { key: 'show-1', release: 0, protocol: 'torrent' },
      { key: 'show-2', release: 0, protocol: 'torrent' },
    ], requires_whole_ack: false, requires_space_ack: false })
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(plan.id)!, undefined, results)
    const result = await completion
    assert.deepEqual(result.rows.map(row => row.status), ['added', 'failed'])
    assert.deepEqual(result.failures.map(failure => failure.code), ['not_upgradable'])
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
  } finally { cleanup() }
})

test('a rejected download-job route releases operation ownership for the next request', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = putPlan({ config_generation: currentGeneration() - 1, selections: [{ key: 'show-1', release: 0, protocol: 'torrent' }], requires_whole_ack: false, requires_space_ack: false })
      const request = Readable.from([Buffer.from(JSON.stringify({ plan_id: plan.id }))]) as unknown as IncomingMessage
      request.method = 'POST'
      let status = 0
      let body: { error?: string } = {}
      const response = { writeHead: (code: number) => { status = code }, end: (value: string) => { body = JSON.parse(value) } } as unknown as ServerResponse
      await handleDownloadRequest(request, response, new URL('http://companion.test/api/download-jobs'))
      assert.equal(status, 409)
      assert.match(body.error || '', /Settings changed/)
    }
  } finally { cleanup() }
})

test('an intent write failure finalizes every pending unit without submitting to a client', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const write = fs.writeFileSync
  try {
    const results = [resultFixture([releaseFixture()]), resultFixture([releaseFixture({ info_hashes: ['b'.repeat(40)] })], { key: 'show-2' })] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }, { key: 'show-2', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(path).endsWith('owned_downloads.json.tmp')) throw new Error('ledger disk full')
      return Reflect.apply(write, fs, [path, ...args])
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.review.plan_id)!, { disk_space: true }, results)
    await assert.rejects(completion, /ledger disk full/)
    const finished = downloadJobs.get(job.id)!
    assert.equal(finished.finished, true)
    assert.deepEqual(finished.pending, [])
    assert.equal(finished.failures.length, 2)
    assert.ok(finished.failures.every(failure => /ledger disk full/.test(failure.error)))
    assert.deepEqual(finished.failures.map(failure => failure.selections), [[{ key: 'show-1', release: 0 }], [{ key: 'show-2', release: 0 }]])
    assert.equal(downloadJobs.active(), false)
    assert.equal(state.calls.some(call => call.includes('/torrents/add')), false)
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); cleanup() }
})

test('torrent and Usenet categories are separated for Sonarr and Radarr', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const config = baseConfig({ sonarr_category: 'torrent-tv', radarr_category: 'torrent-movies', sabnzbd_sonarr_category: 'nzb-tv', sabnzbd_radarr_category: 'nzb-movies' })
    assert.equal(downloadCategory(config, 'Sonarr', 'torrent'), 'torrent-tv')
    assert.equal(downloadCategory(config, 'Sonarr', 'usenet'), 'nzb-tv')
    assert.equal(downloadCategory(config, 'Radarr', 'torrent'), 'torrent-movies')
    assert.equal(downloadCategory(config, 'Radarr', 'usenet'), 'nzb-movies')
    for (const [arr, protocol, category] of [['Sonarr', 'usenet', 'nzb-tv'], ['Radarr', 'usenet', 'nzb-movies'], ['Sonarr', 'torrent', 'torrent-tv'], ['Radarr', 'torrent', 'torrent-movies']] as const) {
      const results = [resultFixture([releaseFixture()], { arr })] as unknown as ResultItem[]
      const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in built)
      assert.equal(built.review.units[0].category, category)
    }
  } finally { cleanup() }
})

test('live disk and whole-source acknowledgements are checked before any intent or client mutation', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    assert.equal(built.plan.requires_space_ack, false)
    state.qbFreeBytes = '0'
    await assert.rejects(acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results), /disk space/)
    assert.equal(downloadJobs.active(), false)
    assert.deepEqual(downloadRecords(), [])

    state.animetosho = () => Response.json({ id: 1234, info_hash: HASH, nzb_url: 'https://feed.animetosho.net/nzb/1234', status: 'complete', num_files: 1, total_size: 1000, files: [{ name: 'Show - 01.mkv', size: 1000, processed: true }] })
    const scopedResults = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const scoped = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results: scopedResults })
    assert.ok('review' in scoped)
    assert.equal(scoped.plan.requires_whole_ack, false)
    state.animetosho = animetoshoMatch
    invalidateUsenetLookups()
    await assert.rejects(acceptDownloadPlan(baseConfig(), consumePlan(scoped.plan.id)!, { disk_space: true }, scopedResults), /whole Usenet sources/)
    assert.deepEqual(downloadRecords(), [])
    assert.equal(state.calls.some(call => /POST .*torrents\/add|POST .*sab\.test/.test(call)), false)
  } finally { cleanup() }
})

test('accepted SABnzbd responses without IDs retain duplicate protection in the next review', async () => {
  const state: RouterState = { calls: [], animetosho: animetoshoMatch, sabAddResult: () => Response.json({ status: true }) }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, { disk_space: true }, results)
    await completion
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.acceptance_unknown, true)
    assert.equal(downloadRecords()[0].state, 'acceptance_unknown')
    const review = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in review)
    assert.deepEqual(review.review.blocked.map(row => row.code), ['acceptance_unknown'])
    assert.deepEqual(review.review.units, [])
    assert.equal(state.calls.filter(call => /POST .*sab\.test/.test(call)).length, 1)
  } finally { cleanup() }
})

test('a torrent whose cleanup fails remains owned with its requested scope', async () => {
  const state: RouterState = { calls: [], qbFiles: [{ name: 'Different.mkv', index: 0 }], qbDeleteStatus: 500 }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.equal(result.ok, false)
    assert.match(result.failures[0].error, /cleanup/)
    const record = findTorrentRecord(HASH)!
    assert.equal(record.state, 'accepted')
    assert.equal(record.removed_at, undefined)
    assert.deepEqual(record.scope, ['Show - 01.mkv'])
    assert.equal(state.qbTorrents?.[0].hash, HASH)
  } finally { cleanup() }
})

test('single-release receipts include every failed source even after another source succeeds', () => {
  const selections = [{ key: 'show-1', release: 0 }]
  const success = { unit_id: `usenet:${HASH}`, protocol: 'usenet' as const, source_hash: HASH, label: 'Added', selections, record_id: 'u:added', native_id: 'nzo-added' }
  const failures = [
    { unit_id: 'usenet:missing', protocol: 'usenet' as const, label: 'Unknown source', code: 'acceptance_unknown', error: 'Check SABnzbd before retrying.', selections },
    { unit_id: 'usenet:rejected', protocol: 'usenet' as const, label: 'Rejected source', code: 'client', error: 'Rejected by SABnzbd', selections },
  ]
  const receipt = receiptFromJob({ id: 'partial', finished: true, added: [success], existing: [], pending: [], failures, targets: selections })
  assert.ok('ok' in receipt)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.acceptance_unknown, true)
  assert.deepEqual(receipt.failures, failures)
  assert.match(receipt.error || '', /1 source\(s\) ready, but 2 source\(s\) failed/)
  assert.match(receipt.error || '', /Unknown source/)
  assert.match(receipt.error || '', /Rejected source/)
})

test('fresh client presence distinguishes accepted, missing, unknown, and unbound acquisitions without deleting records', async () => {
  for (const protocol of ['torrent', 'usenet'] as const) {
    const state: RouterState = { calls: [], animetosho: animetoshoMatch, qbTorrents: [{ hash: HASH }], sabQueue: [{ nzo_id: 'existing', status: 'Queued' }] }
    const cleanup = installRouter(state)
    try {
      const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
      const record = addDownloadRecord({ protocol, client: protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd', endpoint: protocol === 'torrent' ? QB : SAB, native_id: protocol === 'torrent' ? HASH : 'existing', state: 'accepted', source_hash: HASH, category: 'sonarr-anime' })
      const existing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in existing)
      assert.equal(existing.review.units[0].status, 'existing')
      assert.equal(existing.review.units[0].existing_record_id, record.id)
      state.qbTorrents = []
      state.sabQueue = []
      const missing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in missing)
      assert.equal(missing.review.units[0].status, 'new')
      assert.equal(findDownloadRecord(record.id)?.removed_at, undefined, 'Read-only review must retain original ownership')
      const unbound = await buildDownloadPlan(baseConfig(protocol === 'torrent' ? { qbittorrent_url: 'http://other-qb.test' } : { sabnzbd_url: 'http://other-sab.test' }), [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in unbound)
      assert.equal(unbound.review.units[0].status, 'existing')
      assert.equal(unbound.review.units[0].existing_unbound, true)
    } finally { cleanup() }
  }
})

test('approximate payloads cannot prove disk sufficiency and each SABnzbd folder retains its unknown report', async () => {
  const state: RouterState = { calls: [], animetosho: animetoshoMatch, sabDisk: { diskspace1: '931.5' } }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const sab = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in sab)
    assert.equal(sab.review.disk_space.length, 2)
    assert.deepEqual(sab.review.disk_space.map(check => check.sufficient), [null, null])
    assert.deepEqual(sab.review.disk_space.map(check => check.free_bytes), [931_500_000_000, null])
    const approximateResults = [resultFixture([releaseFixture({ torrent_files: [] })])] as unknown as ResultItem[]
    const qb = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results: approximateResults })
    assert.ok('review' in qb)
    assert.ok(qb.review.disk_space.every(check => check.unknown_units === 1 && check.sufficient === null))
    state.qbFreeBytes = '0'
    const insufficient = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results: approximateResults })
    assert.ok('review' in insufficient)
    assert.ok(insufficient.review.disk_space.every(check => check.sufficient === false))
  } finally { cleanup() }
})

test('a whole-library review keeps more than 200 selections in one deduplicated authoritative plan', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = Array.from({ length: 201 }, (_, index) => resultFixture([releaseFixture()], { key: `show-${index}` })) as unknown as ResultItem[]
    const selections = results.map(result => ({ key: result.key, release: 0, protocol: 'torrent' as const }))
    const built = await buildDownloadPlan(baseConfig(), selections, { results })
    assert.ok('review' in built)
    assert.equal(built.review.selection_count, 201)
    assert.equal(built.review.units.length, 1)
    assert.equal(built.review.units[0].selections.length, 201)
    assert.equal(built.plan.selections.length, 201)
    assert.deepEqual(consumePlan(built.plan.id)?.selections.map(selection => selection.key), selections.map(selection => selection.key))
  } finally { cleanup() }
})

test('a multi-source single submission returns a partial failure receipt instead of success', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const router = globalThis.fetch
  const secondHash = 'b'.repeat(40)
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add') && String(init?.body).includes(secondHash)) return new Response('Rejected', { status: 409 })
      return router(input, init)
    }) as typeof fetch
    const results = [resultFixture([releaseFixture({ info_hashes: [HASH, secondHash], torrent_files: [
      { hash: HASH, files: [{ name: 'Show - 01.mkv', length: 1_000_000 }] },
      { hash: secondHash, files: [{ name: 'Show - 02.mkv', length: 1_000_000 }] },
    ] })])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.equal(result.rows[0].status, 'partial')
    assert.equal(result.ok, false)
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.failures?.length, 1)
    assert.equal(receipt.failures?.[0].source_hash, secondHash)
    assert.match(receipt.error || '', /source\(s\) ready, but/)
  } finally { globalThis.fetch = router; cleanup() }
})

test('unrelated submitted rows keep separate outcomes when only one source fails', async () => {
  const cleanup = installRouter({ calls: [] })
  const router = globalThis.fetch
  const secondHash = 'b'.repeat(40)
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add') && String(init?.body).includes(secondHash)) return new Response('Rejected', { status: 409 })
      return router(input, init)
    }) as typeof fetch
    const results = [resultFixture([releaseFixture()]), resultFixture([releaseFixture({ info_hashes: [secondHash], torrent_files: [{ hash: secondHash, files: [{ name: 'Other.mkv', length: 1000 }] }] })], { key: 'show-2' })] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }, { key: 'show-2', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.deepEqual(result.rows.map(row => [row.key, row.status]), [['show-1', 'added'], ['show-2', 'failed']])
    const finished = downloadJobs.get(job.id)!
    assert.deepEqual(finished.added[0].selections, [{ key: 'show-1', release: 0 }])
    assert.deepEqual(finished.failures[0].selections, [{ key: 'show-2', release: 0 }])
    assert.deepEqual(finished.targets.map(target => target.protocol), ['torrent', 'torrent'])
  } finally { globalThis.fetch = router; cleanup() }
})

test('accepted SABnzbd jobs retain ownership when binding or outcome persistence fails', async () => {
  for (const failedFile of ['owned_downloads.json.tmp', 'download_jobs.json.tmp']) {
    let failNextWrite = false
    const state: RouterState = { calls: [], animetosho: animetoshoMatch, sabAddResult: () => { failNextWrite = true; return Response.json({ status: true, nzo_ids: ['accepted-nzo'] }) } }
    const cleanup = installRouter(state)
    const write = fs.writeFileSync
    try {
      const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
      const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
      assert.ok('review' in built)
      fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (failNextWrite && String(path).endsWith(failedFile)) { failNextWrite = false; throw new Error('accepted job persistence failed') }
        return Reflect.apply(write, fs, [path, ...args])
      }) as typeof fs.writeFileSync
      syncBuiltinESMExports()
      const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, { disk_space: true }, results)
      await assert.rejects(completion, /accepted job persistence failed/)
      const finished = downloadJobs.get(job.id)!
      assert.equal(finished.finished, true)
      assert.deepEqual(finished.added, [])
      assert.equal(finished.failures.length, 1)
      assert.match(finished.failures[0].error, /accepted job persistence failed/)
      resetOwnedRuntime()
      assert.equal(downloadRecords().length, 1)
      assert.equal(downloadRecords()[0].removed_at, undefined)
      assert.equal(state.calls.filter(call => /POST .*sab\.test/.test(call)).length, 1)
    } finally { fs.writeFileSync = write; syncBuiltinESMExports(); cleanup() }
  }
})

test('an ambiguous torrent add retains its intent and blocks reacquisition even when a fresh list is empty', async () => {
  const cleanup = installRouter({ calls: [] })
  const router = globalThis.fetch
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add')) throw new TypeError('connection lost after dispatch')
      return router(input, init)
    }) as typeof fetch
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    await completion
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.acceptance_unknown, true)
    assert.equal(receipt.client, 'qbittorrent')
    assert.match(receipt.error || '', /Check qBittorrent/)
    assert.equal(findTorrentRecord(HASH)?.state, 'acceptance_unknown')
    const review = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], { results })
    assert.ok('review' in review)
    assert.deepEqual(review.review.blocked.map(row => row.code), ['acceptance_unknown'])
    assert.deepEqual(review.review.units, [])
  } finally { globalThis.fetch = router; cleanup() }
})

test('a present accepted SABnzbd source remains existing without provider rediscovery', async () => {
  const state: RouterState = { calls: [], sabQueue: [{ nzo_id: 'present', status: 'Queued' }] }
  const cleanup = installRouter(state)
  try {
    addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: SAB, native_id: 'present', state: 'accepted', source_hash: HASH, category: 'sonarr-anime' })
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.review.units[0].status, 'existing')
    assert.equal(state.calls.some(call => call.includes('animetosho.net')), false)
  } finally { cleanup() }
})

test('an incomplete presence read blocks an accepted source instead of proving it missing', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  const router = globalThis.fetch
  try {
    addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: SAB, native_id: 'present', state: 'accepted', source_hash: HASH, category: 'sonarr-anime' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.origin === SAB && url.searchParams.get('mode') === 'history' && url.searchParams.get('archive') === '1') return Response.json({ history: {} })
      return router(input, init)
    }) as typeof fetch
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    assert.deepEqual(built.review.blocked.map(row => row.code), ['acceptance_unknown'])
    assert.deepEqual(built.review.units, [])
    assert.equal(downloadRecords().length, 1)
  } finally { globalThis.fetch = router; cleanup() }
})
