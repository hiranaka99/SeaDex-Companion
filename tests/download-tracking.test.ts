import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { NewDownloadRecord } from '../server/download-store.js'

// Static import cannot work here: the ledger freezes DATA_DIR-derived file paths at module load,
// so the temp directory must be set on the environment before this module is evaluated.
const dataDir = process.env.DATA_DIR || mkdtempSync(join(tmpdir(), 'seadex-ledger-'))
process.env.DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })
const {
  addDownloadRecord, allDownloadRecords, downloadRecords, downloadRows, findAcquisitionRecord,
  findSabnzbdRecord, findTorrentRecord, markDownloadRemoved, migrateOwnedDownloads,
  resetOwnedRuntime, setDownloadNative, setDownloadPhase, setDownloadRows,
} = await import('../server/download-store.js')

const ownedFile = join(dataDir, 'owned_torrents.json')
const detailsFile = join(dataDir, 'download_records.json')
const ledgerFile = join(dataDir, 'owned_downloads.json')
const endpoint = 'http://localhost:8080'
const h1 = 'a'.repeat(40), h2 = 'b'.repeat(40), h3 = 'c'.repeat(40), h4 = 'd'.repeat(40), h5 = 'e'.repeat(40), h6 = 'f'.repeat(40)

// Each section starts from a pristine ledger so ordering within the shared process never matters.
const cleanLedger = () => {
  for (const file of [ownedFile, detailsFile, ledgerFile]) rmSync(file, { force: true })
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
  const pending = addDownloadRecord({ protocol: 'usenet', client: 'sabnzbd', endpoint, native_id: '', state: 'acceptance_unknown', source_hash: h5, category: 'anime', provider: 'amenzb', labels: ['retry'] })
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
