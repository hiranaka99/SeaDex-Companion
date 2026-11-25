import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { nextScanTime } from '../shared/scan-schedule.js'
import { releaseIdentity } from '../shared/releases.js'

// The acquisition ledger resolves its files when server/paths loads: those modules must load
// after DATA_DIR is set, so they cannot be static imports. Skip the override when the suite
// runner already supplied a temporary directory.
const ownDataDir = process.env.DATA_DIR ? '' : mkdtempSync(join(tmpdir(), 'seadex-workflow-'))
if (ownDataDir) process.env.DATA_DIR = ownDataDir
after(() => {
  if (ownDataDir) rmSync(ownDataDir, { recursive: true, force: true })
})

const { DATA_DIR, DOWNLOAD_RECORDS_FILE, OWNED_TORRENTS_FILE } = await import('../server/paths.js')
const { addDownloadRecord, downloadRecords, downloadRows, migrateOwnedDownloads, resetOwnedRuntime } = await import(
  '../server/download-store.js'
)
const { findAcquisitionRecord } = await import('./support/ledger.js')
const { resultsRevision, setState } = await import('../server/scan-state.js')

const LEDGER_FILE = join(DATA_DIR, 'owned_downloads.json')
function preserveFiles(files: string[], action: () => void) {
  const saved = files.map(file => (existsSync(file) ? readFileSync(file) : null))
  try {
    action()
  } finally {
    files.forEach((file, index) => {
      const data = saved[index]
      if (data) writeFileSync(file, data)
      else rmSync(file, { force: true })
    })
    resetOwnedRuntime()
  }
}

const schedule = {
  enabled: true,
  mode: 'daily' as const,
  interval_minutes: 60,
  times: ['02:30'],
  weekdays: [0],
  timezone: 'Europe/Berlin',
}
const next = (from: string, overrides = {}) =>
  new Date(nextScanTime({ ...schedule, ...overrides }, Date.parse(from))!).toISOString()

test('frontend grouping and artwork regressions', async () => {
  await import('../frontend/src/utils.test.js')
})

test('calendar schedules skip nonexistent times and never repeat a DST occurrence', () => {
  assert.equal(next('2026-03-29T00:00:00Z'), '2026-03-30T00:30:00.000Z')
  assert.equal(next('2026-10-25T00:00:00Z'), '2026-10-25T00:30:00.000Z')
  assert.equal(next('2026-10-25T00:45:00Z'), '2026-10-26T01:30:00.000Z')
})

test('weekly and fractional timezone schedules use local calendar dates', () => {
  assert.equal(
    next('2026-10-02T15:00:00Z', { mode: 'weekly', weekdays: [1], times: ['03:00'] }),
    '2026-10-05T01:00:00.000Z',
  )
  assert.equal(
    next('2026-10-02T00:00:00Z', { timezone: 'Asia/Kathmandu', times: ['06:00'] }),
    '2026-10-02T00:15:00.000Z',
  )
  assert.equal(
    next('2026-04-04T14:40:00Z', { timezone: 'Australia/Lord_Howe', times: ['01:45'] }),
    '2026-04-04T14:45:00.000Z',
  )
  assert.equal(
    next('2026-04-04T14:50:00Z', { timezone: 'Australia/Lord_Howe', times: ['01:45'] }),
    '2026-04-05T15:15:00.000Z',
  )
})

test('release identities ignore hash ordering but detect changed torrents or file scope', () => {
  const release = {
    releaseGroup: 'Example',
    tracker: 'Nyaa',
    info_hashes: ['B'.repeat(40), 'a'.repeat(40)],
    selected_files: ['02.mkv', '01.mkv'],
  }
  assert.equal(
    releaseIdentity(release),
    releaseIdentity({
      ...release,
      info_hashes: ['a'.repeat(40), 'b'.repeat(40)],
      selected_files: ['01.mkv', '02.mkv'],
    }),
  )
  assert.notEqual(releaseIdentity(release), releaseIdentity({ ...release, selected_files: ['01.mkv'] }))
  assert.notEqual(releaseIdentity(release), releaseIdentity({ ...release, info_hashes: ['c'.repeat(40)] }))
})

test('the acquisition ledger keeps every review row and resolves ownership from the source hash', () => {
  const hash = 'c'.repeat(40)
  preserveFiles([LEDGER_FILE], () => {
    resetOwnedRuntime()
    const record = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: 'http://qb.test/',
      state: 'accepted',
      source_hash: hash,
      category: 'sonarr-anime',
      scope: ['Anime - 001.mkv'],
      labels: ['Cour 1'],
      card: {
        title: 'Original title',
        season: 2,
        part: 'Cour 1',
        release_group: 'Example',
        tracker: 'Nyaa',
        size: 100,
      },
      rows: [
        { key: 'old-result', release: 1 },
        { key: 'new-result', release: 0 },
        { key: 'old-result', release: 1 },
      ],
    })
    assert.equal(record.id, `t:${hash}`, 'Torrent records are keyed deterministically by source hash')
    assert.deepEqual(record.scope, ['Anime - 001.mkv'])
    assert.deepEqual(
      downloadRows(record.id),
      [
        { key: 'old-result', release: 1 },
        { key: 'new-result', release: 0 },
      ],
      'Duplicate rows collapse while both releases stay associated',
    )
    assert.equal(
      findAcquisitionRecord(hash.toUpperCase(), 'torrent')?.id,
      record.id,
      'Ownership resolves from a case-insensitive source hash',
    )
    assert.equal(findAcquisitionRecord(hash, 'usenet'), null, 'A torrent cannot answer a Usenet duplicate guard')
    resetOwnedRuntime()
    assert.deepEqual(
      downloadRows(record.id),
      [
        { key: 'old-result', release: 1 },
        { key: 'new-result', release: 0 },
      ],
      'Rows reload from the durable ledger',
    )
    assert.ok(downloadRecords().some(candidate => candidate.id === record.id))
  })
})

test('legacy owned torrents import their download detail records once', () => {
  const hash = 'd'.repeat(40)
  const unowned = 'e'.repeat(40)
  const files = [LEDGER_FILE, OWNED_TORRENTS_FILE, DOWNLOAD_RECORDS_FILE]
  preserveFiles(files, () => {
    files.forEach(file => rmSync(file, { force: true }))
    resetOwnedRuntime()
    writeFileSync(OWNED_TORRENTS_FILE, JSON.stringify([hash]))
    writeFileSync(
      DOWNLOAD_RECORDS_FILE,
      JSON.stringify({
        [hash]: {
          key: 'old-result',
          release: 1,
          title: 'Original title',
          season: 2,
          part: 'Cour 1',
          releaseGroup: 'Example',
          tracker: 'Nyaa',
          size: 100,
        },
      }),
    )
    migrateOwnedDownloads('http://qb.test/')
    const record = findAcquisitionRecord(hash, 'torrent')
    assert.ok(record, 'A legacy owned torrent is app-owned after migration')
    assert.equal(record.id, `t:${hash}`)
    assert.deepEqual(
      [record.client, record.endpoint, record.native_id, record.state],
      ['qbittorrent', 'http://qb.test/', hash, 'accepted'],
    )
    assert.deepEqual(
      record.card,
      { title: 'Original title', season: 2, part: 'Cour 1', release_group: 'Example', tracker: 'Nyaa', size: 100 },
      'Detail records become the card snapshot',
    )
    assert.deepEqual(
      downloadRows(record.id),
      [{ key: 'old-result', release: 1 }],
      'The legacy row keeps the release association',
    )
    writeFileSync(OWNED_TORRENTS_FILE, JSON.stringify([hash, unowned]))
    resetOwnedRuntime()
    migrateOwnedDownloads('http://qb.test/')
    assert.equal(
      findAcquisitionRecord(unowned, 'torrent'),
      null,
      'Migration reads the durable ledger once the new file exists',
    )
    assert.equal(findAcquisitionRecord(hash, 'torrent')?.id, `t:${hash}`)
  })
})

test('a damaged acquisition ledger starts empty instead of failing requests', () => {
  preserveFiles([LEDGER_FILE], () => {
    writeFileSync(LEDGER_FILE, '[]')
    resetOwnedRuntime()
    assert.deepEqual(downloadRecords(), [])
  })
})

test('result revisions change for new results but stay stable for status-only updates', () => {
  setState({ results: [] })
  const revision = resultsRevision()
  setState({ message: 'Still idle' })
  assert.equal(resultsRevision(), revision)
  setState({ results: [] })
  assert.notEqual(resultsRevision(), revision)
})
