import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nextScanTime } from '../shared/scan-schedule.js'
import { releaseIdentity } from '../shared/releases.js'
import { indexResultReleases, loadDownloadRecords, recordDownloadDetails, resultsRevision, setState, trackedDownloadInfo } from '../server/app.js'

const schedule = { enabled: true, mode: 'daily' as const, interval_minutes: 60, times: ['02:30'], weekdays: [0], timezone: 'Europe/Berlin' }
const next = (after: string, overrides = {}) => new Date(nextScanTime({ ...schedule, ...overrides }, Date.parse(after))!).toISOString()

test('frontend grouping and artwork regressions', async () => {
  await import('../frontend/src/utils.test.js')
})

test('calendar schedules skip nonexistent times and never repeat a DST occurrence', () => {
  assert.equal(next('2026-03-29T00:00:00Z'), '2026-03-30T00:30:00.000Z')
  assert.equal(next('2026-10-25T00:00:00Z'), '2026-10-25T00:30:00.000Z')
  assert.equal(next('2026-10-25T00:45:00Z'), '2026-10-26T01:30:00.000Z')
})

test('weekly and fractional timezone schedules use local calendar dates', () => {
  assert.equal(next('2026-10-02T15:00:00Z', { mode: 'weekly', weekdays: [1], times: ['03:00'] }), '2026-10-05T01:00:00.000Z')
  assert.equal(next('2026-10-02T00:00:00Z', { timezone: 'Asia/Kathmandu', times: ['06:00'] }), '2026-10-02T00:15:00.000Z')
  assert.equal(next('2026-04-04T14:40:00Z', { timezone: 'Australia/Lord_Howe', times: ['01:45'] }), '2026-04-04T14:45:00.000Z')
  assert.equal(next('2026-04-04T14:50:00Z', { timezone: 'Australia/Lord_Howe', times: ['01:45'] }), '2026-04-05T15:15:00.000Z')
})

test('release identities ignore hash ordering but detect changed torrents or file scope', () => {
  const release = { releaseGroup: 'Example', tracker: 'Nyaa', info_hashes: ['B'.repeat(40), 'a'.repeat(40)], selected_files: ['02.mkv', '01.mkv'] }
  assert.equal(releaseIdentity(release), releaseIdentity({ ...release, info_hashes: ['a'.repeat(40), 'b'.repeat(40)], selected_files: ['01.mkv', '02.mkv'] }))
  assert.notEqual(releaseIdentity(release), releaseIdentity({ ...release, selected_files: ['01.mkv'] }))
  assert.notEqual(releaseIdentity(release), releaseIdentity({ ...release, info_hashes: ['c'.repeat(40)] }))
})

test('download details survive changed scan results and legacy entries use torrent names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-records-'))
  try {
    const file = join(dir, 'records.json')
    const hash = 'a'.repeat(40)
    const info = { key: 'old-result', release: 1, title: 'Original title', season: 2, part: '', releaseGroup: 'Example', tracker: 'Nyaa', size: 100 }
    recordDownloadDetails(hash, info, file)
    assert.deepEqual(trackedDownloadInfo({ hash, name: 'raw torrent name' }, loadDownloadRecords(file), indexResultReleases([])), info)
    assert.equal(trackedDownloadInfo({ hash: 'b'.repeat(40), name: 'Legacy torrent' }, {}, indexResultReleases([])).title, 'Legacy torrent')
    writeFileSync(file, '{"bad":null}')
    assert.deepEqual(loadDownloadRecords(file), {})
    writeFileSync(file, '[]')
    assert.deepEqual(loadDownloadRecords(file), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('result revisions change for new results but stay stable for status-only updates', () => {
  setState({ results: [] })
  const revision = resultsRevision()
  setState({ message: 'Still idle' })
  assert.equal(resultsRevision(), revision)
  setState({ results: [] })
  assert.notEqual(resultsRevision(), revision)
})
