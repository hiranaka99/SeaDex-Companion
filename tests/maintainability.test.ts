import { buildScanHistoryEntry } from '../server/history.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planTorrents, upgradeParts } from '../shared/download-plan.js'
import { estimateDownloads } from '../shared/download-estimate.js'
import { normalizeResults } from '../server/result-model.js'
import { bulkDownloadTargets } from '../server/downloads.js'
import { createDownloadJobStore } from '../server/download-jobs.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { qbAddTorrent, qbControlTorrents, qbGetTorrents, resetQbRuntime } from '../server/qbittorrent.js'
import { cancelScan, getState } from '../server/scan-state.js'
import { createScanService } from '../server/scan.js'

const a = 'a'.repeat(40), b = 'b'.repeat(40)
const release = { kind: 'best' as const, releaseGroup: 'Best', tracker: 'Nyaa', downloadable: true, info_hashes: [a], size: 100 }

test('review and server eligibility agree for owned, excluded, and unavailable cours', () => {
  const season = { key: 'series', arr: 'Sonarr', status: 'partial', upgrade_available: true, precise_part_ownership: true, owned_by_part: { 'Cour 1': ['BEST'] }, releases: [
    { ...release, part: 'Cour 1' }, { ...release, part: 'Cour 2', info_hashes: [b] },
  ] }
  assert.deepEqual(upgradeParts(season).map(part => part.part), ['Cour 2'])
  assert.deepEqual(bulkDownloadTargets([season]).map(target => target.part), ['Cour 2'])
  assert.deepEqual(upgradeParts({ ...season, excluded_parts: ['Cour 2'] }), [])
  assert.deepEqual(bulkDownloadTargets([{ ...season, excluded: true }]), [])
  const unavailable = upgradeParts({ ...season, releases: [{ ...release, info_hashes: [], downloadable: false, part: 'Cour 2' }] })
  assert.equal(unavailable[0].downloadable, false)
})

test('planning and estimation use the same per-hash union and whole-torrent override', () => {
  const catalogs = [{ hash: a, files: [{ name: '01.mkv', length: 100 }] }, { hash: b, files: [{ name: '02.mkv', length: 200 }] }]
  const selections = [{ release: { ...release, info_hashes: [a, b], selected_files: ['01.mkv', '02.mkv'], torrent_files: catalogs }, category: 'anime' }]
  assert.deepEqual(planTorrents(selections).map(torrent => [torrent.hash, torrent.selectedFiles]), [[a, ['01.mkv']], [b, ['02.mkv']]])
  assert.equal(estimateDownloads(selections).new_bytes, 300)
  const incomplete = [{ ...selections[0], release: { ...selections[0].release, torrent_files: catalogs.slice(0, 1) } }]
  assert.deepEqual(planTorrents(incomplete).map(torrent => torrent.hash), [a, b], 'Incomplete metadata cannot silently drop a hash')
  assert.deepEqual(planTorrents([{ ...selections[0], release: { ...selections[0].release, selected_files: ['01.mkv'] } }]).map(torrent => torrent.hash), [a], 'An empty per-hash scope must never become a whole-torrent download')
  assert.equal(planTorrents([...selections, { release: { ...release, torrent_files: catalogs }, category: 'anime' }])[0].selectedFiles, undefined)
})

test('result loading normalizes malformed and legacy releases once without losing selected-file identity', () => {
  const results = normalizeResults([null, [], 7, { key: 'old', title: 'Legacy', have: null, releases: [
    { ...release, tracker: 'Private', info_hashes: [] },
    { ...release, selected_files: ['01.mkv'], torrent_files: [{ hash: a, files: [{ name: '01.mkv', length: 100 }] }] },
  ] }])
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].have, [])
  assert.equal(results[0].releases.length, 1)
  assert.deepEqual(results[0].releases[0].selected_files, ['01.mkv'])
  assert.deepEqual(normalizeResults(results), results, 'Normalization must be idempotent')
})

test('job identity, restart recovery, and failed persistence preserve authoritative state', () => {
  let saved: unknown = [], failWrite = false
  const storage = { read: () => saved, write: (jobs: unknown) => { if (failWrite) throw new Error('disk full'); saved = structuredClone(jobs) } }
  const store = createDownloadJobStore(storage)
  failWrite = true
  assert.throws(() => store.begin([], [a]), /disk full/)
  assert.equal(store.active(), false)
  failWrite = false
  const first = store.begin([{ key: 'old-result', release: 0 }], [a, b])
  assert.throws(() => store.begin([], []), /already running/)
  store.settle(first.id, a, 'First', null)
  failWrite = true
  assert.throws(() => store.settle(first.id, b, 'Second', null), /disk full/)
  assert.deepEqual(store.get(first.id)?.pending, [b])
  failWrite = false
  const restarted = createDownloadJobStore(storage)
  restarted.restore()
  assert.equal(restarted.get(first.id)?.finished, true)
  assert.deepEqual(restarted.get(first.id)?.added, [a])
  assert.match(restarted.get(first.id)!.failures[0].error, /restarted/)
  const second = restarted.begin([], [])
  assert.notEqual(second.id, first.id)
  assert.deepEqual(restarted.get(first.id)?.targets, [{ key: 'old-result', release: 0 }])
  const snapshot = restarted.get(first.id)!
  snapshot.added.length = 0
  assert.deepEqual(restarted.get(first.id)?.added, [a])
})

test('metadata loading does not block status reads or controls for another torrent', async () => {
  resetQbRuntime()
  const original = globalThis.fetch
  let unblock!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const controls: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } })
    if (url.pathname.endsWith('/torrents/files')) { entered(); await gate; return Response.json([{ index: 0, name: '01.mkv' }]) }
    if (url.pathname.endsWith('/torrents/info')) return Response.json(url.searchParams.has('hashes') ? [] : [{ hash: b }])
    if (url.pathname.endsWith('/torrents/stop')) controls.push(new URLSearchParams(String(init?.body)).get('hashes')!)
    return new Response('Ok.')
  }) as typeof fetch
  const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://metadata.test', qbittorrent_user: 'user', qbittorrent_pass: 'password' }
  const add = qbAddTorrent(config, `magnet:?xt=urn:btih:${a}`, 'anime', ['01.mkv'])
  let deadline: ReturnType<typeof setTimeout> | undefined
  let sameHashControl: Promise<void> | undefined
  let sameHashFinished = false
  try {
    await ready
    sameHashControl = qbControlTorrents({ ...config, qbittorrent_pass: 'updated-password' }, [a], 'pause').then(() => { sameHashFinished = true })
    await Promise.race([
      Promise.all([qbGetTorrents(config).then(torrents => assert.equal(torrents[0].hash, b)), qbControlTorrents(config, [b], 'pause')]),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Independent reads and controls were blocked by metadata')), 1000) }),
    ])
    assert.ok(controls.includes(b))
    assert.equal(sameHashFinished, false, 'Credential changes must retain the mutation lock for the same endpoint and hash')
  } finally { clearTimeout(deadline); unblock(); await add; await sameHashControl; globalThis.fetch = original; resetQbRuntime() }
})

test('scan service rejects overlapping runs and storage overrides retain history behavior', async () => {
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  let history = 0
  const service = createScanService({ seadexBest: async () => { await gate; return new Map() }, localItems: async () => [], saveLastResults: () => {}, recordScanHistory: (previous, current, runAt) => { history += 1; return buildScanHistoryEntry(previous, current, runAt) } })
  const first = service.run(DEFAULT_CONFIG)
  await assert.rejects(service.run(DEFAULT_CONFIG), /already running/)
  cancelScan(); unblock(); await first
  assert.equal(getState().cancelled, true)
  assert.equal(history, 1, 'Injected history is also used for cancelled runs')
})

test('configuration migration is explicit and an interrupted commit preserves settings and credentials together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-atomic-config-'))
  try {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { loadConfig, saveConfig, migrateConfig, DEFAULT_CONFIG } = await import('./dist/server/config.js');
      const { CONFIG_FILE, ENCRYPTED_SECRETS_FILE } = await import('./dist/server/paths.js');
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ sonarr_url: 'http://old', sonarr_key: 'old-secret' }));
      const original = fs.readFileSync(CONFIG_FILE, 'utf8');
      assert.equal(loadConfig().sonarr_key, 'old-secret');
      assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), original, 'Reads must not migrate');
      migrateConfig();
      assert.ok(!fs.readFileSync(CONFIG_FILE, 'utf8').includes('old-secret'));
      assert.ok(!fs.existsSync(ENCRYPTED_SECRETS_FILE));
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { if (to === CONFIG_FILE) throw new Error('interrupted commit'); return rename(from, to); };
      syncBuiltinESMExports();
      assert.throws(() => saveConfig({ ...loadConfig(), sonarr_url: 'http://new', sonarr_key: 'new-secret' }), /interrupted commit/);
      assert.equal(loadConfig().sonarr_url, 'http://old');
      assert.equal(loadConfig().sonarr_key, 'old-secret');
      fs.renameSync = rename; syncBuiltinESMExports();
      saveConfig({ ...loadConfig(), sonarr_key: '' });
      assert.equal(loadConfig().sonarr_key, '');
      fs.writeFileSync(CONFIG_FILE, 'broken-json');
      migrateConfig();
      assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), 'broken-json', 'Migration must not overwrite damaged configuration');
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0, child.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
