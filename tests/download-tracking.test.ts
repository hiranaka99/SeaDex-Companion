import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { NewDownloadRecord } from '../server/download-store.js'

// These imports exercise the DATA_DIR module-loading boundary. Static imports would freeze
// the store and progress dependencies' file paths before this test sets its temp directory.
const dataDir = process.env.DATA_DIR || mkdtempSync(join(tmpdir(), 'seadex-ledger-'))
process.env.DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })
const {
  addDownloadRecord, allDownloadRecords, downloadRecords, downloadRows, findAcquisitionRecord, findDownloadRecord,
  findSabnzbdRecord, findTorrentRecord, markDownloadRemoved, migrateOwnedDownloads,
  resetOwnedRuntime, setDownloadNative, setDownloadPhase, setDownloadRows,
} = await import('../server/download-store.js')
const { DEFAULT_CONFIG } = await import('../server/config.js')
const { cancelRecords, collectDownloadProgress, controlRecord, listCancelable } = await import('../server/download-progress.js')
const { qbEndpointId, sabEndpoint } = await import('../server/client-identity.js')
const { resetQbRuntime } = await import('../server/qbittorrent.js')

const ownedFile = join(dataDir, 'owned_torrents.json')
const detailsFile = join(dataDir, 'download_records.json')
const ledgerFile = join(dataDir, 'owned_downloads.json')
const endpoint = 'http://localhost:8080'
const h1 = 'a'.repeat(40), h2 = 'b'.repeat(40), h3 = 'c'.repeat(40), h4 = 'd'.repeat(40), h5 = 'e'.repeat(40), h6 = 'f'.repeat(40)

// Each section starts from a pristine ledger so ordering within the shared process never matters.
const cleanLedger = () => {
  for (const file of [ownedFile, detailsFile, ledgerFile, `${ledgerFile}.tmp`]) rmSync(file, { recursive: true, force: true })
  resetOwnedRuntime()
}
after(cleanLedger)

test('migration derives cards and associations from the legacy array-form ledger and is idempotent', () => {
  cleanLedger()
  writeFileSync(ownedFile, JSON.stringify([h1, h2]), 'utf8')
  writeFileSync(detailsFile, JSON.stringify({
    [h1]: {
      title: 'Title One', season: 1, part: 'Cour 1', releaseGroup: 'Group A', tracker: 'Nyaa', size: 123,
      key: 'Sonarr:1:1:Title One', release: 2,
      associations: [{ key: 'Sonarr:1:2:Title One', season: 2 }, { key: 'legacy-row', season: null }],
    },
  }), 'utf8')
  migrateOwnedDownloads(endpoint)
  const records = downloadRecords()
  assert.deepEqual(records.map(record => record.id).sort(), [`t:${h1}`, `t:${h2}`].sort())
  const first = findTorrentRecord(h1)!
  assert.equal(first.protocol, 'torrent')
  assert.equal(first.client, 'qbittorrent')
  assert.equal(first.endpoint, endpoint)
  assert.equal(first.native_id, h1)
  assert.equal(first.state, 'accepted')
  assert.equal(first.removed_at, undefined)
  assert.equal(first.card?.title, 'Title One')
  assert.equal(first.card?.season, 1)
  assert.equal(first.card?.part, 'Cour 1')
  assert.equal(first.card?.release_group, 'Group A')
  assert.equal(first.card?.tracker, 'Nyaa')
  assert.equal(first.card?.size, 123)
  assert.deepEqual(downloadRows(`t:${h1}`), [
    { key: 'Sonarr:1:1:Title One', release: 2 },
    { key: 'Sonarr:1:2:Title One', release: 0 },
    { key: 'legacy-row', release: 0 },
  ], 'The card row and every association survive migration')
  const second = findTorrentRecord(h2)!
  assert.equal(second.card, undefined, 'A bare hash without details has no card')
  assert.deepEqual(downloadRows(`t:${h2}`), [{ key: `torrent:${h2}`, release: 0 }], 'Detail-less hashes get a fallback association')
  assert.ok(!!first.added_at && !!first.updated_at)

  migrateOwnedDownloads(endpoint)
  assert.equal(downloadRecords().length, 2)
  resetOwnedRuntime()
  migrateOwnedDownloads(endpoint)
  assert.equal(downloadRecords().length, 2, 'Re-running migration after a reload never duplicates records')
  assert.deepEqual(JSON.parse(readFileSync(ledgerFile, 'utf8')).records.length, 2)
  assert.ok(downloadRecords().some(record => record.id === `t:${h1}` && record.endpoint === endpoint))
})

test('migration reads the versioned dict-form ledger with inline cards', () => {
  cleanLedger()
  writeFileSync(ownedFile, JSON.stringify({
    version: 1,
    torrents: {
      [h3]: {
        title: 'Dict Title', season: null, part: '', releaseGroup: 'Group B', tracker: 'Private', size: 50,
        key: 'dict-row', release: 1, associations: [{ key: 'dict-row-2', season: 2 }],
      },
    },
  }), 'utf8')
  migrateOwnedDownloads(endpoint)
  const records = downloadRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].id, `t:${h3}`)
  assert.equal(records[0].card?.title, 'Dict Title')
  assert.equal(records[0].card?.release_group, 'Group B')
  assert.deepEqual(downloadRows(`t:${h3}`), [{ key: 'dict-row', release: 1 }, { key: 'dict-row-2', release: 0 }])
  assert.equal(findTorrentRecord(h3)!.endpoint, endpoint)
})

test('torrent records are keyed by hash, idempotent, and re-adding clears the removal tombstone', () => {
  cleanLedger()
  const input: NewDownloadRecord = { protocol: 'torrent', client: 'qbittorrent', endpoint, native_id: h1, state: 'accepted', source_hash: h1, category: 'anime', labels: ['upgrade'], rows: [{ key: 'row-a', release: 0 }] }
  const added = addDownloadRecord(input)
  assert.equal(added.id, `t:${h1}`)
  assert.equal(added.native_id, h1)
  assert.deepEqual(added.labels, ['upgrade'])
  assert.deepEqual(downloadRows(`t:${h1}`), [{ key: 'row-a', release: 0 }])
  const again = addDownloadRecord({ ...input, category: 'anime-hd' })
  assert.equal(allDownloadRecords().filter(record => record.id === `t:${h1}`).length, 1, 'Re-adding the same hash must not duplicate the record')
  assert.equal(findTorrentRecord(h1)!.added_at, added.added_at, 'The original acceptance time survives re-adds')
  assert.equal(again.category, 'anime-hd')
  assert.equal(findTorrentRecord(h1)!.category, 'anime-hd')

  const removed = markDownloadRemoved(`t:${h1}`)!
  assert.ok(removed.removed_at)
  assert.equal(findTorrentRecord(h1), null)
  assert.equal(downloadRecords().some(record => record.id === `t:${h1}`), false)
  const readded = addDownloadRecord(input)
  assert.equal(readded.removed_at, undefined, 'Re-adding a removed torrent resets the tombstone')
  assert.equal(findTorrentRecord(h1)?.id, `t:${h1}`)
  assert.equal(findTorrentRecord(h1)!.category, 'anime', 'The fresh add replaces the record fields')
})

test('acquisition lookups are protocol-filtered and skip removed records', () => {
  cleanLedger()
  addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint, native_id: h4, state: 'accepted', source_hash: h4, category: 'anime', labels: [] })
  const usenet = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint, native_id: 'nzo-1', state: 'accepted', source_hash: h4, category: 'anime', provider: 'animetosho', entry_id: '900', nzb_name: 'show.nzb', labels: [] })
  assert.match(usenet.id, new RegExp(`^u:${h4.slice(0, 12)}:`), 'Usenet records carry a hash prefix and a unique suffix')
  assert.notEqual(findAcquisitionRecord(h4)!.id, usenet.id, 'Without a protocol the earliest acquisition answers')
  assert.equal(findAcquisitionRecord(h4, 'torrent')!.protocol, 'torrent')
  assert.equal(findAcquisitionRecord(h4, 'usenet')!.id, usenet.id)
  assert.equal(findSabnzbdRecord('nzo-1')!.id, usenet.id)
  assert.equal(usenet.provider, 'animetosho')
  assert.equal(usenet.entry_id, '900')
  assert.equal(usenet.nzb_name, 'show.nzb')
  markDownloadRemoved(`t:${h4}`)
  assert.equal(findTorrentRecord(h4), null)
  assert.equal(findAcquisitionRecord(h4)!.id, usenet.id, 'After the torrent is removed the usenet acquisition still guards the hash')
  assert.equal(findAcquisitionRecord(h4, 'torrent'), null)
  assert.equal(findAcquisitionRecord('9'.repeat(40)), null)
})

test('setDownloadNative confirms acceptance and clones one record per extra native job', () => {
  cleanLedger()
  const rows = [{ key: 'season-one', release: 0 }, { key: 'season-two', release: 2 }]
  const pending = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint, native_id: '', state: 'acceptance_unknown', source_hash: h5, category: 'anime', provider: 'amenzb', labels: ['retry'], rows })
  assert.equal(pending.state, 'acceptance_unknown')
  assert.equal(pending.native_id, '')
  assert.equal(findSabnzbdRecord('nzo-missing'), null)
  const updated = setDownloadNative(pending.id, ['nzo-a', 'nzo-b'])!
  assert.equal(updated.state, 'accepted', 'Native ids flip acceptance')
  assert.equal(updated.native_id, 'nzo-a', 'The first native id owns the base record')
  const clones = downloadRecords().filter(record => record.source_hash === h5)
  assert.equal(clones.length, 2)
  const clone = clones.find(record => record.id !== pending.id)!
  assert.equal(clone.native_id, 'nzo-b')
  assert.equal(clone.state, 'accepted')
  assert.equal(clone.category, 'anime')
  assert.deepEqual(clone.labels, ['retry'])
  assert.deepEqual(downloadRows(pending.id), rows)
  assert.deepEqual(downloadRows(clone.id), rows, 'Every native job retains the submission associations')
  assert.match(clone.id, new RegExp(`^u:${h5.slice(0, 12)}:`))
  setDownloadNative(pending.id, ['nzo-a', 'nzo-b'])
  assert.equal(downloadRecords().filter(record => record.source_hash === h5).length, 2, 'Already-recorded native ids never duplicate')
  assert.equal(setDownloadNative(pending.id, []), null)
  setDownloadPhase(pending.id, 'downloading')
  assert.equal(findSabnzbdRecord('nzo-a')!.last_phase, 'downloading')
  setDownloadPhase(pending.id, 'downloading')
  assert.equal(findSabnzbdRecord('nzo-a')!.last_phase, 'downloading', 'Repeated identical phase writes are skipped')
})

test('removal keeps an audit record outside the active ledger and row projections stay scoped', () => {
  cleanLedger()
  const record = addDownloadRecord({
    protocol: 'torrent', client: 'qbittorrent', endpoint, native_id: h6, state: 'accepted', source_hash: h6, category: 'anime',
    scope: ['Cour 1/01.mkv'], labels: [], rows: [{ key: 'row-a', release: 1 }, { key: 'row-b', release: 0 }, { key: 'row-a', release: 1 }],
  })
  assert.deepEqual(record.scope, ['Cour 1/01.mkv'])
  assert.deepEqual(downloadRows(record.id), [{ key: 'row-a', release: 1 }, { key: 'row-b', release: 0 }], 'Rows are deduplicated on write')
  setDownloadRows(record.id, [{ key: 'row-a', release: 1 }, { key: 'row-c', release: 2 }])
  assert.deepEqual(downloadRows(record.id), [{ key: 'row-a', release: 1 }, { key: 'row-c', release: 2 }])
  setDownloadRows(`t:${'9'.repeat(40)}`, [{ key: 'orphan', release: 0 }])
  assert.deepEqual(downloadRows(`t:${'9'.repeat(40)}`), [], 'Rows never attach to records that do not exist')
  markDownloadRemoved(record.id)
  assert.equal(downloadRecords().some(candidate => candidate.id === record.id), false)
  const kept = allDownloadRecords().find(candidate => candidate.id === record.id)
  assert.ok(kept?.removed_at, 'Removed acquisitions remain in the audit ledger')
  assert.equal(kept!.card, undefined)
})

test('failed ledger writes leave records, associations, and native bindings unchanged until retry', () => {
  cleanLedger()
  const rows = [{ key: 'original-row', release: 1 }]
  const record = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint, state: 'acceptance_unknown', source_hash: h1, category: 'anime', rows })
  const torrentInput: NewDownloadRecord = { protocol: 'torrent', client: 'qbittorrent', endpoint, state: 'accepted', source_hash: h2, category: 'anime', rows }
  const accepted = addDownloadRecord(torrentInput)
  const beforeRecords = allDownloadRecords()
  const beforeFile = readFileSync(ledgerFile, 'utf8')
  mkdirSync(`${ledgerFile}.tmp`)
  try {
    assert.throws(() => addDownloadRecord({ ...torrentInput, source_hash: h3 }))
    assert.throws(() => addDownloadRecord({ ...torrentInput, category: 'changed', rows: [{ key: 'changed-row', release: 0 }] }))
    assert.throws(() => setDownloadRows(record.id, [{ key: 'changed-row', release: 0 }]))
    assert.throws(() => setDownloadPhase(record.id, 'downloading'))
    assert.throws(() => markDownloadRemoved(accepted.id))
    assert.throws(() => setDownloadNative(record.id, ['nzo-a', 'nzo-b']))
    assert.deepEqual(allDownloadRecords(), beforeRecords)
    assert.deepEqual(downloadRows(record.id), rows)
    assert.deepEqual(downloadRows(accepted.id), rows)
    assert.equal(findAcquisitionRecord(h1)?.state, 'acceptance_unknown')
    assert.equal(findAcquisitionRecord(h2)?.state, 'accepted')
    assert.equal(findAcquisitionRecord(h3), null)
    assert.equal(findSabnzbdRecord('nzo-a'), null)
    assert.equal(findSabnzbdRecord('nzo-b'), null)
    assert.equal(readFileSync(ledgerFile, 'utf8'), beforeFile)
  } finally { rmSync(`${ledgerFile}.tmp`, { recursive: true, force: true }) }
  setDownloadNative(record.id, ['nzo-a', 'nzo-b'])
  assert.equal(downloadRecords().filter(candidate => candidate.source_hash === h1).length, 2)
  resetOwnedRuntime()
  assert.equal(findSabnzbdRecord('nzo-a')?.state, 'accepted')
  assert.equal(findSabnzbdRecord('nzo-b')?.state, 'accepted')
  assert.deepEqual(downloadRows(findSabnzbdRecord('nzo-b')!.id), rows)
  setDownloadPhase(record.id, 'downloading')
  setDownloadRows(record.id, [{ key: 'changed-row', release: 0 }])
  markDownloadRemoved(accepted.id)
  addDownloadRecord({ ...torrentInput, source_hash: h3 })
  assert.equal(findDownloadRecord(record.id)?.last_phase, 'downloading')
  assert.equal(findAcquisitionRecord(h2), null)
  assert.equal(findAcquisitionRecord(h3)?.state, 'accepted')
})

test('migration retries after a failed durable write without half-applied ownership', () => {
  cleanLedger()
  writeFileSync(ownedFile, JSON.stringify([h1]), 'utf8')
  mkdirSync(`${ledgerFile}.tmp`)
  try {
    assert.throws(() => migrateOwnedDownloads(endpoint))
  } finally { rmSync(`${ledgerFile}.tmp`, { recursive: true, force: true }) }
  migrateOwnedDownloads(endpoint)
  assert.equal(findTorrentRecord(h1)?.endpoint, endpoint)
  assert.equal(JSON.parse(readFileSync(ledgerFile, 'utf8')).records.length, 1)
})

const progressConfig = () => ({ ...DEFAULT_CONFIG, qbittorrent_url: 'http://qb-ledger.test', qbittorrent_user: 'user', qbittorrent_pass: 'password', sabnzbd_url: 'http://sab-ledger.test', sabnzbd_key: 'sab-key' })

interface ProgressRouter {
  torrents?: Record<string, unknown>[]
  queue?: Record<string, unknown>[]
  history?: Record<string, unknown>[]
  qbReadError?: boolean
  malformedTorrents?: boolean
  sabQueueError?: boolean
  sabHistoryError?: boolean
  malformedQueue?: boolean
  malformedHistory?: boolean
  controls: { url: string; body: string }[]
}

function installProgressRouter(state: ProgressRouter): () => void {
  const original = globalThis.fetch
  resetQbRuntime()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'qb-ledger.test') {
      if (url.pathname === '/api/v2/auth/login') return new Response('Ok.')
      if (url.pathname === '/api/v2/torrents/info') {
        if (state.qbReadError) throw new TypeError('qBittorrent offline')
        if (state.malformedTorrents) return Response.json([{ hash: 'invalid-native-id' }])
        return Response.json(state.torrents || [])
      }
      state.controls.push({ url: url.href, body: String(init?.body || '') })
      return new Response('Ok.')
    }
    if (url.hostname === 'sab-ledger.test') {
      const mode = url.searchParams.get('mode')
      if (url.searchParams.get('name')) {
        state.controls.push({ url: url.href, body: String(init?.body || '') })
        return Response.json({ status: true })
      }
      if (mode === 'queue') {
        if (state.sabQueueError) throw new TypeError('SABnzbd queue offline')
        return Response.json({ queue: state.malformedQueue ? {} : { slots: state.queue || [] } })
      }
      if (mode === 'history') {
        if (state.sabHistoryError) throw new TypeError('SABnzbd history offline')
        return Response.json({ history: state.malformedHistory ? {} : { slots: state.history || [] } })
      }
    }
    throw new Error(`Unexpected test request: ${url.href}`)
  }) as typeof fetch
  return () => { globalThis.fetch = original; resetQbRuntime(); cleanLedger() }
}

test('progress publishes every saved association and scope for an acquisition after recommendation changes', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { torrents: [{ hash: h1, state: 'downloading', progress: 0.5, size: 1000 }], controls: [] }
  const restore = installProgressRouter(state)
  try {
    const rows = Array.from({ length: 70 }, (_, release) => ({ key: `saved-row-${release}`, release }))
    const scope = ['Cour 1/01.mkv', 'Cour 1/02.mkv']
    const original = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime', rows, scope, card: { title: 'Original acquisition', season: 1, part: 'Cour 1', release_group: 'Original group', tracker: 'Nyaa', size: 1000 } })
    scope.push('not-owned.mkv')
    rows[0].key = 'mutated-caller-row'
    const replacement = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h2, category: 'anime', rows: [{ key: 'saved-row-0', release: 0 }], scope: ['Cour 2/01.mkv'] })
    resetOwnedRuntime()
    const progress = await collectDownloadProgress(config)
    const view = progress.downloads[original.id]
    assert.equal(view.record_id, original.id)
    assert.equal(view.source_hash, h1)
    assert.equal(view.native_id, h1)
    assert.equal(view.title, 'Original acquisition')
    assert.equal(view.associations.length, 70, 'Internal associations are not a bounded display list')
    assert.deepEqual(view.associations[0], { key: 'saved-row-0', release: 0 })
    assert.deepEqual(view.scope, ['Cour 1/01.mkv', 'Cour 1/02.mkv'])
    assert.equal('key' in view, false)
    assert.equal('release' in view, false)
    assert.equal(progress.downloads[replacement.id].source_hash, h2)
    await controlRecord(config, original.id, 'pause', false)
    assert.equal(new URLSearchParams(state.controls.at(-1)!.body).get('hashes'), h1, 'Controls stay bound to the original acquisition')
  } finally { restore() }
})

test('fresh confirmed absence exposes ledger-only single and bulk removal without deleting files', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { torrents: [{ hash: h1, state: 'downloading', progress: 0.5, size: 1000 }], controls: [] }
  const restore = installProgressRouter(state)
  const preservedFile = join(dataDir, 'preserved-download.mkv')
  writeFileSync(preservedFile, 'keep me', 'utf8')
  try {
    const torrent = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime' })
    const usenet = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: sabEndpoint(config).endpointId, native_id: 'missing-nzo', state: 'accepted', source_hash: h2, category: 'anime' })
    assert.equal((await collectDownloadProgress(config)).downloads[torrent.id].phase, 'downloading')
    state.torrents = []
    const missing = await collectDownloadProgress(config)
    for (const id of [torrent.id, usenet.id]) {
      assert.equal(missing.downloads[id].phase, 'missing')
      assert.deepEqual(missing.downloads[id].capabilities, { pause: false, resume: false, remove: true, remove_files: false })
    }
    assert.deepEqual((await listCancelable(config)).items.map(item => item.record_id).sort(), [torrent.id, usenet.id].sort())
    await controlRecord(config, torrent.id, 'remove', true)
    const result = await cancelRecords(config, [usenet.id], true)
    assert.deepEqual(result.removed, [{ record_id: usenet.id, client: 'sabnzbd' }])
    assert.deepEqual(state.controls, [], 'Confirmed absence never sends a client deletion request')
    assert.equal(readFileSync(preservedFile, 'utf8'), 'keep me')
    assert.equal(findAcquisitionRecord(h1), null)
    assert.equal(findAcquisitionRecord(h2), null)
    assert.ok(findDownloadRecord(torrent.id)?.removed_at)
    const reacquired = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime' })
    assert.equal(reacquired.removed_at, undefined)
    assert.equal(findAcquisitionRecord(h1)?.id, reacquired.id)
  } finally { rmSync(preservedFile, { force: true }); restore() }
})

test('a torrent no read ever confirmed is dropped from tracking after a grace period, not shown as missing', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { torrents: [{ hash: h1, state: 'downloading', progress: 0.5, size: 1000 }], controls: [] }
  const restore = installProgressRouter(state)
  const realNow = Date.now
  try {
    const seen = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime' })
    const legacy = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h2, category: 'anime' })
    const fresh = await collectDownloadProgress(config)
    assert.equal(fresh.downloads[legacy.id].phase, 'missing', 'A just-accepted torrent gets time to appear in the client')
    Date.now = () => realNow() + 11 * 60_000
    state.torrents = [{ hash: h1, state: 'downloading', progress: 0.6, size: 1000 }]
    const later = await collectDownloadProgress(config)
    assert.equal(later.downloads[legacy.id], undefined, 'A never-seen torrent past the grace period is not reported')
    assert.ok(findDownloadRecord(legacy.id)?.removed_at, 'Only the tracking entry is retired')
    assert.equal(later.downloads[seen.id].phase, 'downloading')
    state.torrents = []
    assert.equal((await collectDownloadProgress(config)).downloads[seen.id].phase, 'missing', 'A torrent that was seen and then removed still warns')
    assert.deepEqual(state.controls, [], 'The client is never touched')
  } finally { Date.now = realNow; restore() }
})

test('failed, incomplete, unbound, and unknown-acceptance reads never permit ledger cleanup', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { qbReadError: true, sabHistoryError: true, controls: [] }
  const restore = installProgressRouter(state)
  try {
    const torrent = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime' })
    const usenet = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: sabEndpoint(config).endpointId, native_id: 'maybe-nzo', state: 'accepted', source_hash: h2, category: 'anime' })
    const unknownTorrent = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'acceptance_unknown', source_hash: h3, category: 'anime' })
    const unknownUsenet = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: sabEndpoint(config).endpointId, native_id: 'unconfirmed-nzo', state: 'acceptance_unknown', source_hash: h4, category: 'anime' })
    const unbound = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: '', state: 'accepted', source_hash: h5, category: 'anime' })
    setDownloadPhase(torrent.id, 'missing')
    const unavailable = await collectDownloadProgress(config)
    assert.equal(unavailable.downloads[torrent.id].phase, 'missing', 'A last-known phase is not fresh evidence of absence')
    for (const record of [torrent, usenet, unbound]) {
      assert.equal(unavailable.downloads[record.id].capabilities.remove, false)
      await assert.rejects(controlRecord(config, record.id, 'remove', true))
    }
    for (const record of [unknownTorrent, unknownUsenet]) {
      assert.deepEqual(unavailable.downloads[record.id].capabilities, { pause: false, resume: false, remove: true, remove_files: false }, 'An unconfirmed send can only be untracked')
      await assert.rejects(controlRecord(config, record.id, 'pause', false))
    }
    state.qbReadError = false
    state.sabHistoryError = false
    state.malformedTorrents = true
    assert.equal((await collectDownloadProgress(config)).downloads[torrent.id].capabilities.remove, false)
    await assert.rejects(controlRecord(config, torrent.id, 'remove', false))
    state.malformedTorrents = false
    for (const section of ['malformedQueue', 'malformedHistory'] as const) {
      state[section] = true
      const malformed = await collectDownloadProgress(config)
      assert.equal(malformed.downloads[usenet.id].capabilities.remove, false)
      await assert.rejects(controlRecord(config, usenet.id, 'remove', false))
      state[section] = false
    }
    const complete = await collectDownloadProgress(config)
    assert.equal(complete.downloads[unknownTorrent.id].phase, 'acceptance_unknown')
    assert.equal(complete.downloads[unknownUsenet.id].phase, 'acceptance_unknown')
    assert.equal(complete.downloads[unknownTorrent.id].capabilities.remove_files, false)
    assert.equal(complete.downloads[unknownUsenet.id].capabilities.remove_files, false)
    const cancelled = await cancelRecords(config, [unknownTorrent.id, unknownUsenet.id, unbound.id], true)
    assert.equal(cancelled.removed.length, 0, 'Bulk cancellation never silently untracks unconfirmed sends')
    assert.equal(cancelled.failures.length, 3)
    assert.deepEqual(state.controls, [])
    assert.equal(findAcquisitionRecord(h3)?.state, 'acceptance_unknown')
    assert.equal(findAcquisitionRecord(h4)?.state, 'acceptance_unknown')
    assert.equal(downloadRecords().length, 5)
    await controlRecord(config, unknownUsenet.id, 'remove', true)
    assert.deepEqual(state.controls, [], 'Untracking an unconfirmed send never touches the client, even when file deletion was requested')
    assert.equal(downloadRecords().length, 4)
    assert.equal(downloadRecords().some(record => record.id === unknownUsenet.id), false)
  } finally { restore() }
})

test('SABnzbd unknown-size percentages and mixed-case statuses match their capabilities', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { queue: [{ nzo_id: 'half-nzo', status: 'pAuSeD', percentage: '50' }], history: [{ nzo_id: 'failed-nzo', status: 'fAiLeD', fail_message: 'Repair failed', loaded: false }], controls: [] }
  const restore = installProgressRouter(state)
  try {
    const queued = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: sabEndpoint(config).endpointId, native_id: 'half-nzo', state: 'accepted', source_hash: h1, category: 'anime' })
    const failed = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint: sabEndpoint(config).endpointId, native_id: 'failed-nzo', state: 'accepted', source_hash: h2, category: 'anime' })
    const progress = await collectDownloadProgress(config)
    assert.equal(progress.downloads[queued.id].total_size, 0)
    assert.equal(progress.downloads[queued.id].progress, 0.5)
    assert.equal(progress.downloads[queued.id].phase, 'paused')
    assert.deepEqual(progress.downloads[queued.id].capabilities, { pause: false, resume: true, remove: true, remove_files: true })
    assert.equal(progress.downloads[failed.id].phase, 'error')
    assert.equal(progress.downloads[failed.id].error, 'Repair failed')
    assert.equal(progress.downloads[failed.id].capabilities.remove_files, true)
    state.queue![0].status = 'dOwNlOaDiNg'
    const downloading = await collectDownloadProgress(config)
    assert.equal(downloading.downloads[queued.id].capabilities.pause, true)
    assert.equal(downloading.downloads[queued.id].capabilities.resume, false)
  } finally { restore() }
})

test('unfinished forced, queued, and metadata torrent states expose pause', async () => {
  cleanLedger()
  const config = progressConfig()
  const state: ProgressRouter = { controls: [] }
  const restore = installProgressRouter(state)
  try {
    const record = addDownloadRecord({ protocol: 'torrent', client: 'qbittorrent', endpoint: qbEndpointId(config), state: 'accepted', source_hash: h1, category: 'anime' })
    for (const [nativeState, phase] of [['forcedDL', 'downloading'], ['queuedDL', 'queued'], ['metaDL', 'queued']] as const) {
      state.torrents = [{ hash: h1, state: nativeState, progress: 0.2 }]
      const view = (await collectDownloadProgress(config)).downloads[record.id]
      assert.equal(view.phase, phase)
      assert.deepEqual(view.capabilities, { pause: true, resume: false, remove: true, remove_files: true })
    }
    state.torrents = [{ hash: h1, state: 'forcedDL', progress: 1 }]
    assert.equal((await collectDownloadProgress(config)).downloads[record.id].capabilities.pause, false)
  } finally { restore() }
})
