import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateDownloads, type EstimatableRelease } from '../shared/download-estimate.js'
import { mergeComplementaryCandidates, releaseDict, scopeReleaseToPart } from '../server/app.js'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const files = [{ name: 'Show.S01E01.mkv', length: 100 }, { name: 'Show.S01E02.mkv', length: 200 }, { name: 'extra.txt', length: 50 }]
const release: EstimatableRelease = { info_hashes: [a], size: 350, torrent_files: [{ hash: a, files }] }
const select = (item: EstimatableRelease) => ({ release: item, category: 'anime' })

test('bulk size counts shared hashes and overlapping file scopes once', () => {
  const estimate = estimateDownloads([
    select({ ...release, selected_files: [files[0].name] }),
    select({ ...release, info_hashes: [a.toUpperCase(), a], selected_files: [files[0].name, files[1].name] }),
  ])
  assert.equal(estimate.new_bytes, 300)
  assert.equal(estimate.new_torrents, 1)
  assert.equal(estimate.selected_file_count, 2)
  assert.equal(estimate.unknown_torrents, 0)
  assert.equal(estimate.approximate_torrents, 0)
})

test('whole-torrent requests override file scopes and include extras and other seasons', () => {
  const estimate = estimateDownloads([select({ ...release, size: 100, selected_files: [files[0].name] }), select(release), select(release)])
  assert.equal(estimate.new_bytes, 350)
  assert.equal(estimate.whole_torrents, 1)
  assert.equal(estimate.selected_file_count, 0)
})

test('merged releases retain per-hash sizes and exclude existing torrents independently', () => {
  const merged = { info_hashes: [a, b], size: 550, torrent_files: [release.torrent_files![0], { hash: b, files: [{ name: 'Show.S01E03.mkv', length: 200 }] }], selected_files: [files[0].name, 'Show.S01E03.mkv'] }
  const estimate = estimateDownloads([select(merged)], [a.toUpperCase()])
  assert.equal(estimate.new_bytes, 200)
  assert.equal(estimate.new_torrents, 1)
  assert.equal(estimate.existing_torrents, 1)
  assert.equal(estimate.selected_file_count, 1)
  assert.equal(estimate.unknown_torrents, 0)
  assert.equal(estimateDownloads([select(merged)], [a, b]).new_bytes, 0)
})

test('legacy totals are approximate and unresolved overlapping or multi-hash sizes stay unknown', () => {
  const legacy = { info_hashes: [a], size: 300 }
  const whole = estimateDownloads([select(legacy), select(legacy)])
  assert.equal(whole.new_bytes, 300)
  assert.equal(whole.approximate_torrents, 1)
  const scoped = estimateDownloads([select({ ...legacy, selected_files: ['01.mkv'] }), select({ ...legacy, selected_files: ['02.mkv'] })])
  assert.equal(scoped.new_bytes, 0)
  assert.equal(scoped.unknown_torrents, 1)
  assert.equal(estimateDownloads([select({ info_hashes: [a, b], size: 300 })]).unknown_torrents, 2)
  assert.equal(estimateDownloads([select({ info_hashes: [a], size: 0 })]).unknown_torrents, 1)
})

test('invalid file lengths and unmatched selections cannot produce a verified estimate', () => {
  const invalid = estimateDownloads([select({ ...release, size: 0, torrent_files: [{ hash: a, files: [...files, { name: 'broken', length: -1 }] }] })])
  assert.equal(invalid.unknown_torrents, 1)
  assert.equal(estimateDownloads([select({ ...release, size: 0, selected_files: ['missing.mkv'] })]).unknown_torrents, 1)
  assert.deepEqual(estimateDownloads([]).torrents, [])
})

test('release serialization and cour scoping preserve the complete per-torrent file catalog', () => {
  const candidate = { ...release, releaseGroup: 'Group', tracker: 'Nyaa', quality: '1080p', tags: [], size: 350, file_count: 2, is_best: true, source_files: files }
  const scoped = scopeReleaseToPart(candidate, 1, 0, 2)
  assert.deepEqual(scoped.selected_files, [files[0].name])
  assert.deepEqual(releaseDict('best', scoped).torrent_files, release.torrent_files)
  const second = { ...candidate, info_hashes: [b], source_files: [{ name: 'Show.S01E03.mkv', length: 400 }], torrent_files: [{ hash: b, files: [{ name: 'Show.S01E03.mkv', length: 400 }] }] }
  const merged = mergeComplementaryCandidates([candidate, second])[0]
  assert.equal(merged.torrent_files!.length, 2)
})
