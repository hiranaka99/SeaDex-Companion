import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { describeReleaseChanges, releaseResultIdentity } from '../shared/release-changes.js'
import {
  loadReleaseChanges,
  recordReleaseChanges,
  restoreReleaseChanges,
  reviewReleaseChanges,
  withReleaseChanges,
} from '../server/release-changes.js'
import { normalizeResults } from '../server/result-model.js'
import { buildScanHistoryEntry, loadScanHistory, recordScanHistory } from '../server/history.js'
import { compareScans } from '../server/scan-comparison.js'
import { groupResults } from '../frontend/src/utils.js'
import { groupReleaseChanges, latestReleaseChange } from '../frontend/src/release-changes.js'
import type { Release, ResultItem } from '../shared/contracts.js'

const release = (overrides: Partial<Release> = {}): Release => ({
  kind: 'best',
  releaseGroup: 'Group A',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 100,
  info_hashes: ['a'.repeat(40)],
  torrent_available: true,
  ...overrides,
})
const result = (overrides: Partial<ResultItem> = {}): ResultItem =>
  normalizeResults([
    {
      key: 'Sonarr:1:1:Group A',
      library_key: 'Sonarr:item1',
      title: 'Example anime',
      arr: 'Sonarr',
      season: 1,
      status: 'upgrade',
      best_group: 'Group A',
      anilist_id: 1,
      releases: [release()],
      ...overrides,
    },
  ]).map(item => ({ ...item, ...(overrides.unseen_changes ? { unseen_changes: overrides.unseen_changes } : {}) }))[0]
const alternative = release({ kind: 'alt', releaseGroup: 'Group B', info_hashes: ['b'.repeat(40)] })
const fixture = (run: (file: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-release-changes-'))
  try {
    run(join(dir, 'changes.json'))
  } finally {
    assert.equal(
      resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'),
      true,
    )
    rmSync(dir, { recursive: true, force: true })
  }
}

test('alternative-only additions, updates, and removals are detected with unchanged upgrade status', () => {
  const old = result(),
    added = result({ releases: [release(), alternative] })
  assert.equal(describeReleaseChanges(old, added)[0].kind, 'alternative')
  assert.match(describeReleaseChanges(old, added)[0].description, /Group B.*1080p/)
  const edited = result({
    releases: [release(), { ...alternative, quality: '2160p', tags: ['Dual audio'], info_hashes: ['c'.repeat(40)] }],
  })
  assert.match(describeReleaseChanges(added, edited)[0].description, /1080p → 2160p.*Torrent changed.*Tags/)
  assert.deepEqual(
    describeReleaseChanges(added, old).map(change => change.kind),
    ['removed'],
  )
  assert.equal(buildScanHistoryEntry(compareScans([old], [added]), 'today').changes[0].type, 'changed')
})

test("a group's second release on the same tracker is a new listing, not an edit of the first", () => {
  const large = release({ releaseGroup: 'Group A', info_hashes: ['a'.repeat(40)], size: 200 })
  const small = release({ kind: 'alt', releaseGroup: 'Group A', info_hashes: ['b'.repeat(40)], size: 100 })
  const before = result({ releases: [large] })
  const after = result({ releases: [small, large] })
  assert.deepEqual(
    describeReleaseChanges(before, after).map(change => [change.kind, change.description]),
    [['alternative', 'New alternative: Group A (Nyaa) · 1080p']],
  )
  assert.deepEqual(describeReleaseChanges(after, after), [], 'Listing both releases again changes nothing')
  assert.deepEqual(
    describeReleaseChanges(after, before).map(change => [change.kind, change.description]),
    [['removed', 'Alternative removed: Group A (Nyaa)']],
  )
})

test('best replacement shows before and after, while a same-group replacement still records its new torrent', () => {
  const old = result()
  const next = result({ key: 'new-key', best_group: 'Group B', releases: [release({ releaseGroup: 'Group B' })] })
  assert.deepEqual(describeReleaseChanges(old, next), [
    {
      kind: 'best',
      part: '',
      description: 'Best release changed: Group A → Group B',
      release_replacement: { previous: 'Group A (Nyaa)', next: 'Group B (Nyaa)', torrent_changed: false },
    },
  ])
  assert.match(
    describeReleaseChanges(old, result({ releases: [release({ info_hashes: ['d'.repeat(40)] })] }))[0].description,
    /Torrent changed/,
  )
})

test('ownership, selected scope, ordering, whitespace, and case do not create release alerts', () => {
  const old = result({
    releases: [release({ info_hashes: ['a'.repeat(40), 'b'.repeat(40)], tags: ['TV', 'Dual audio'] }), alternative],
  })
  const next = result({
    status: 'best',
    have: ['Group A'],
    local_size: 999,
    releases: [
      alternative,
      release({
        releaseGroup: 'group a',
        tracker: 'nyaa',
        quality: ' 1080p ',
        tags: ['dual audio', 'tv'],
        info_hashes: ['B'.repeat(40), 'A'.repeat(40)],
        selected_files: ['01.mkv'],
      }),
    ],
  })
  assert.deepEqual(describeReleaseChanges(old, next), [])
})

test('cour changes retain their affected part and notes/coverage edits remain visible', () => {
  const old = result({
    releases: [release({ part: 'Cour 1' }), release({ part: 'Cour 2' })],
    unavailable_parts: [{ label: 'Cour 3', reason: 'No release' }],
  })
  const next = result({
    releases: [release({ part: 'Cour 1' }), release({ part: 'Cour 2', quality: '2160p' })],
    notes: 'Updated guidance',
  })
  const changes = describeReleaseChanges(old, next)
  assert.equal(changes[0].part, 'Cour 2')
  assert(changes.some(change => change.description.includes('notes updated')))
  assert(changes.some(change => change.part === 'Cour 3' && change.description.includes('now covered')))
})

test('history and unseen changes keep the same before/after data after a later scan', () =>
  fixture(file => {
    const historyFile = file + '.history'
    const previousNote = 'Use the weekly releases.\nThe specials are separate.'
    const currentNote = 'Use the season batch.\nThe specials are separate.'
    const otherBest = release({
      part: 'Cour 1',
      releaseGroup: 'Unchanged recommendation',
      info_hashes: ['c'.repeat(40)],
    })
    const previous = result({
      releases: [release({ part: 'Cour 1' }), otherBest],
      notes_by_part: { 'Cour 1': previousNote, 'Cour 2': '-' },
    })
    const current = result({
      status: 'best',
      best_group: 'Group B',
      notes_by_part: { 'Cour 1': currentNote, 'Cour 2': 'Special edition' },
      releases: [
        release({ part: 'Cour 1', releaseGroup: 'Group B', tracker: 'AB', info_hashes: ['b'.repeat(40)] }),
        otherBest,
      ],
    })
    const later = result({ ...current, notes_by_part: { 'Cour 1': 'Final guidance', 'Cour 2': '-' } })
    recordReleaseChanges(compareScans([previous], [current]), file, '2026-11-18T10:00:00Z')
    recordScanHistory(compareScans([previous], [current]), '2026-11-18T10:00:00Z', historyFile)
    recordReleaseChanges(compareScans([current], [later]), file, '2026-11-18T11:00:00Z')
    recordScanHistory(compareScans([current], [later]), '2026-11-18T11:00:00Z', historyFile)
    const oldHistory = loadScanHistory(historyFile)[1].changes[0]
    assert.equal(oldHistory.type, 'resolved')
    const [replacement, editedNote, addedNote] = oldHistory.release_changes!
    assert.deepEqual(replacement.release_replacement, {
      previous: 'Group A (Nyaa)',
      next: 'Group B (AB)',
      torrent_changed: true,
    })
    assert.equal(editedNote.part, 'Cour 1')
    assert.deepEqual(editedNote.note_change, { previous: previousNote, next: currentNote })
    assert.deepEqual(addedNote.note_change, { previous: null, next: 'Special edition' })
    const unseen = withReleaseChanges([later], file)[0].unseen_changes!
    assert.deepEqual(unseen[0].release_replacement, replacement.release_replacement)
    assert.deepEqual(unseen[1].note_change, editedNote.note_change)
    assert.deepEqual(unseen.at(-1)?.note_change, { previous: 'Special edition', next: null })
    assert.equal(buildScanHistoryEntry(compareScans([later], [later]), 'unchanged').changes.length, 0)
  }))

test('first scan establishes a baseline and unseen events survive unchanged scans and reloads', () =>
  fixture(file => {
    const old = result(),
      next = result({ releases: [release(), alternative] })
    recordReleaseChanges(compareScans([], [old]), file)
    assert.deepEqual(withReleaseChanges([old], file)[0].unseen_changes, [])
    recordReleaseChanges(compareScans([old], [next]), file, '2026-11-04T12:00:00.000Z')
    const saved = readFileSync(file, 'utf8')
    recordReleaseChanges(compareScans([next], [next]), file)
    assert.equal(readFileSync(file, 'utf8'), saved)
    assert.equal(withReleaseChanges([next], file)[0].unseen_changes?.length, 1)
    assert.equal(Object.keys(loadReleaseChanges(file)).length, 1)
  }))

test('reviewing a snapshot never clears events from a later scan, and unchanged scans stay reviewed', () =>
  fixture(file => {
    const old = result(),
      next = result({ releases: [release(), alternative] })
    recordReleaseChanges(compareScans([old], [next]), file)
    const seen = withReleaseChanges([next], file)[0].unseen_changes!.map(change => change.id)
    const newest = result({ releases: [release({ quality: '2160p' }), alternative] })
    recordReleaseChanges(compareScans([next], [newest]), file)
    assert.equal(reviewReleaseChanges(seen, file), 1)
    const remaining = withReleaseChanges([newest], file)[0].unseen_changes!
    assert.equal(remaining.length, 1)
    assert.match(remaining[0].description, /2160p/)
    assert.equal(reviewReleaseChanges(seen, file), 0)
    assert.equal(
      reviewReleaseChanges(
        remaining.map(change => change.id),
        file,
      ),
      1,
    )
    recordReleaseChanges(compareScans([newest], [newest]), file)
    assert.deepEqual(withReleaseChanges([newest], file)[0].unseen_changes, [])
  }))

test('undoing a review restores exactly the reviewed changes, once, beside newer ones', () =>
  fixture(file => {
    const old = result(),
      next = result({ releases: [release(), alternative] })
    recordReleaseChanges(compareScans([old], [next]), file)
    const reviewed = withReleaseChanges([next], file)[0].unseen_changes!
    const newest = result({ releases: [release({ quality: '2160p' }), alternative] })
    recordReleaseChanges(compareScans([next], [newest]), file)
    assert.equal(
      reviewReleaseChanges(
        reviewed.map(change => change.id),
        file,
      ),
      1,
    )
    const entries = reviewed.map(change => ({ key: releaseResultIdentity(newest), change }))
    assert.equal(restoreReleaseChanges(entries, file), 1)
    assert.equal(restoreReleaseChanges(entries, file), 0, 'A repeated undo adds nothing twice')
    const unseen = withReleaseChanges([newest], file)[0].unseen_changes!
    assert.equal(unseen.length, 2, 'The newer change stays and the reviewed one comes back')
    assert.ok(unseen.some(change => change.id === reviewed[0].id))
  }))

test('a title re-added under a new item ID keeps the release changes it had not reviewed', () =>
  fixture(file => {
    const old = result(),
      next = result({ releases: [release(), alternative] })
    recordReleaseChanges(compareScans([old], [next]), file)
    const unseen = withReleaseChanges([next], file)[0].unseen_changes!
    const readded = result({ library_key: 'Sonarr:item2', releases: [release(), alternative] })
    recordReleaseChanges(compareScans([next], [readded]), file)
    assert.deepEqual(withReleaseChanges([readded], file)[0].unseen_changes, unseen)
    assert.deepEqual(Object.keys(loadReleaseChanges(file)), [releaseResultIdentity(readded)])
  }))

test('removed titles and cleared scan baselines prune stale events; malformed storage recovers', () =>
  fixture(file => {
    const old = result(),
      next = result({ releases: [release(), alternative] })
    recordReleaseChanges(compareScans([old], [next]), file)
    recordReleaseChanges(compareScans([], [next]), file)
    assert.deepEqual(loadReleaseChanges(file), {})
    recordReleaseChanges(compareScans([old], [next]), file)
    recordReleaseChanges(compareScans([next], []), file)
    assert.deepEqual(loadReleaseChanges(file), {})
    writeFileSync(
      file,
      JSON.stringify({
        invalid: [null, {}, { id: 'x', kind: 'best', detected_at: 'invalid', description: 'Bad date' }],
      }),
    )
    assert.deepEqual(withReleaseChanges([next], file)[0].unseen_changes, [])
  }))

test('grouping counts an anime once across seasons and exposes its latest change for sorting', () => {
  const changes = [
    { id: 'a', kind: 'alternative' as const, description: 'New alternative', detected_at: '2026-11-04T12:00:00.000Z' },
  ]
  const groups = groupResults([
    result({ unseen_changes: changes }),
    result({
      key: 'season2',
      season: 2,
      unseen_changes: [{ ...changes[0], id: 'b', detected_at: '2026-11-04T13:00:00.000Z' }],
    }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groupReleaseChanges(groups[0]).length, 2)
  assert.equal(groupReleaseChanges(groups[0])[0].season.season, 2)
  assert.equal(latestReleaseChange(groups[0]), Date.parse('2026-11-04T13:00:00.000Z'))
})
