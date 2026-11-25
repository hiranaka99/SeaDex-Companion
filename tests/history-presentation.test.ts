import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  groupChanges,
  historyDetails,
  changeTypeLabel,
  historyStatus,
  historyStatusText,
  matchesHistoryQuery,
  pluralize,
  scanTimes,
  sectionRows,
  summarizeChanges,
  visitDigest,
} from '../frontend/src/history.js'
import { releaseChangeDetail } from '../frontend/src/release-changes.js'
import type { ScanHistoryChange, ScanHistoryEntry } from '../shared/contracts.js'

const change = (overrides: Partial<ScanHistoryChange> = {}): ScanHistoryChange => ({
  key: 'Sonarr:item1:2',
  title: 'Example anime',
  arr: 'Sonarr',
  season: 2,
  type: 'changed',
  from: 'upgrade',
  to: 'upgrade',
  best_group: '-ZR-',
  details: ['-ZR- (AB) · Torrent changed'],
  ...overrides,
})

test('library and history lead with the actual edit and keep its release identity separate', () => {
  assert.deepEqual(historyDetails(change()), [{ summary: 'Torrent updated', release: '-ZR- (AB)' }])
  assert.deepEqual(releaseChangeDetail('Group (Nyaa) · Quality: 1080p → 2160p; Torrent changed; Tags: tv → bd'), {
    summary: 'Quality: 1080p → 2160p · Torrent updated · Tags: tv → bd',
    release: 'Group (Nyaa)',
  })
  assert.deepEqual(releaseChangeDetail('New alternative: Group (Nyaa) · 1080p'), {
    summary: 'New alternative',
    release: 'Group (Nyaa) · 1080p',
  })
  assert.deepEqual(releaseChangeDetail('Best release changed: A → B'), {
    summary: 'Best release changed',
    release: 'A → B',
  })
  assert.deepEqual(releaseChangeDetail('SeaDex recommendation notes updated'), {
    summary: 'SeaDex recommendation notes updated',
  })
  assert.equal(
    historyDetails(change({ details: ['A (AB) · Torrent changed', 'B (Nyaa) · Release size changed'] })).length,
    2,
  )
})

test('history uses the library status names and only emphasizes a status that changed', () => {
  assert.equal(historyStatusText(change()), 'Upgrade available · unchanged')
  assert.equal(historyStatusText(change({ from: 'best', to: 'best' })), 'Best owned · unchanged')
  assert.equal(historyStatusText(change({ type: 'resolved', to: 'best' })), 'Upgrade available → Best owned')
  assert.equal(historyStatusText(change({ type: 'new', from: null })), 'Upgrade available')
  assert.equal(historyStatusText(change({ type: 'new', from: null, to: 'uncovered' })), 'Not on SeaDex')
  assert.equal(historyStatusText(change({ type: 'removed', to: null })), null)
  assert.deepEqual(historyStatus(change({ type: 'upgrade', from: 'best' })), {
    from: 'best',
    fromLabel: 'Best owned',
    to: 'upgrade',
    toLabel: 'Upgrade available',
    changed: true,
  })
  assert.equal(historyStatus(change({ type: 'new', from: null, to: 'uncovered' }))?.to, 'missing')
})

test('legacy history without details adds a line only when it names a release or a recommendation edit', () => {
  assert.deepEqual(historyDetails(change({ type: 'new', from: null, details: undefined })), [])
  assert.deepEqual(historyDetails(change({ type: 'removed', to: null, details: [] })), [])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'best', details: [] })), [])
  assert.deepEqual(historyDetails(change({ from: 'best', to: 'best', details: [] })), [
    { summary: 'Release recommendation updated', release: '-ZR-' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'missing', details: [] })), [])
  assert.deepEqual(historyDetails(change({ type: 'upgrade', from: 'best', details: [] })), [
    { summary: 'Best release', release: '-ZR-' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'upgrade', from: 'best', best_group: null, details: [] })), [])
})

test('long runs of bare library additions and removals fold into one group behind the changes that matter', () => {
  const removed = Array.from({ length: 6 }, (_, index) =>
    change({ key: 'gone' + index, title: 'Gone ' + index, type: 'removed', to: null, details: [] }),
  )
  const rows = groupChanges([
    ...removed,
    change({ key: 'added', type: 'new', from: null, details: [] }),
    change({ key: 'upgrade', type: 'upgrade', from: 'best', to: 'upgrade', details: [] }),
    change({ key: 'edited' }),
  ])
  assert.deepEqual(
    rows.map(row => (row.kind === 'group' ? row.type + ':' + row.changes.length : row.change.key)),
    ['upgrade', 'edited', 'added', 'removed:6'],
  )
  assert.deepEqual(
    sectionRows(rows).map(section => section.type + ':' + section.rows.length),
    ['upgrade:1', 'changed:1', 'new:1', 'removed:1'],
    'Each change type gets one section, in reading order',
  )
  const few = groupChanges(removed.slice(0, 4))
  assert.equal(few.length, 4, 'Short runs stay as individual rows')
  const detailed = groupChanges([
    ...removed,
    change({ key: 'gone-detail', type: 'removed', to: null, details: ['Group (Nyaa) · Torrent changed'] }),
  ])
  assert.equal(
    detailed.filter(row => row.kind === 'change').length,
    1,
    'Removals that carry release details are never folded away',
  )
})

test('scan summaries lead with actionable change types and pluralize counts', () => {
  const changes = [
    change({ type: 'removed' }),
    change({ type: 'upgrade' }),
    change({ type: 'removed' }),
    change({ type: 'resolved' }),
  ]
  assert.deepEqual(
    summarizeChanges(changes).map(item => item.count + ' ' + item.label),
    ['1 upgrade available', '1 resolved', '2 removed'],
  )
  assert.deepEqual(Object.values(changeTypeLabel), [
    'No longer best',
    'Upgrade available',
    'Resolved',
    'Updated',
    'Added',
    'Removed',
  ])
  assert.equal(pluralize(1, 'title'), '1 title')
  assert.equal(pluralize(3, 'title'), '3 titles')
})

test('history search matches titles and season tokens', () => {
  assert.equal(matchesHistoryQuery(change(), '  EXAMPLE '), true)
  assert.equal(matchesHistoryQuery(change(), 's02'), true)
  assert.equal(matchesHistoryQuery(change(), 'Season 2'), true)
  assert.equal(matchesHistoryQuery(change(), 's03'), false)
  assert.equal(matchesHistoryQuery(change(), 'other'), false)
})

test('scan times name the day and the recent age', () => {
  const now = new Date(2026, 10, 22, 18, 0, 0)
  assert.deepEqual(
    [scanTimes('2026-11-22 17:30:00', now).dayLabel, scanTimes('2026-11-22 17:30:00', now).age],
    ['Today', '30 min ago'],
  )
  assert.equal(scanTimes('2026-11-21 23:00:00', now).dayLabel, 'Yesterday')
  assert.equal(scanTimes('2026-11-21 23:00:00', now).age, null, 'Only today carries an age')
  assert.equal(scanTimes('2026-11-22 07:00:00', now).age, '11 h ago')
  assert.equal(scanTimes('2026-11-10 09:00:00', now).age, null)
  assert.equal(scanTimes('not a date', now).dayKey, 'unknown')
})

test('the visit digest nets each title across the scans since the last visit', () => {
  const scan = (id: string, changes: ScanHistoryChange[], extra: Partial<ScanHistoryEntry> = {}): ScanHistoryEntry => ({
    id,
    run_at: '2026-11-22 10:00:00',
    counts: {},
    changes,
    ...extra,
  })
  const scans = [
    scan('newest', [
      change({ key: 'flip', type: 'resolved', from: 'upgrade', to: 'best' }),
      change({ key: 'kept', type: 'changed', from: 'upgrade', to: 'upgrade' }),
    ]),
    scan('failed', [], { outcome: 'failed', error: 'Catalog unavailable' }),
    scan('middle', [
      change({ key: 'flip', type: 'upgrade', from: 'best', to: 'upgrade' }),
      change({ key: 'kept', type: 'upgrade', from: 'best', to: 'upgrade' }),
      change({ key: 'added', type: 'new', from: null, to: 'missing' }),
    ]),
    scan('seen', [change({ key: 'old', type: 'upgrade', from: 'best', to: 'upgrade' })]),
  ]
  const digest = visitDigest(scans, 'seen')!
  assert.equal(digest.scope, 'since-visit')
  assert.deepEqual(
    digest.scans.map(entry => entry.id),
    ['newest', 'failed', 'middle'],
  )
  assert.deepEqual(
    digest.upgrades.map(entry => entry.key),
    ['kept'],
    'A title still upgradable after a later edit counts as an upgrade',
  )
  assert.deepEqual(
    digest.resolved.map(entry => entry.key),
    ['flip'],
    'A title upgraded and then resolved counts once, as resolved',
  )
  assert.deepEqual(
    digest.attention.map(entry => entry.id),
    ['failed'],
  )
  assert.deepEqual(
    digest.other.map(item => item.count + ' ' + item.label),
    ['1 added'],
  )
  assert.equal(visitDigest(scans, null)!.scope, 'latest', 'A first visit summarizes the latest scan')
  assert.deepEqual(
    visitDigest(scans, 'newest')!.scans.map(entry => entry.id),
    ['newest'],
    'With nothing new, the digest summarizes the latest scan',
  )
  assert.equal(visitDigest(scans, 'expired')!.scans.length, 4, 'A visit older than the history covers all of it')
  assert.equal(visitDigest([], 'seen'), null)
})
