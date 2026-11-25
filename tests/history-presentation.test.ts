import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  groupChanges,
  historyDetails,
  historyStatus,
  matchesHistoryQuery,
  pluralize,
  scanTimes,
  summarizeChanges,
} from '../frontend/src/history.js'
import { releaseChangeDetail } from '../frontend/src/release-changes.js'
import type { ScanHistoryChange } from '../shared/contracts.js'

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

test('history only shows a status transition when the status actually changed', () => {
  assert.equal(historyStatus(change()), 'Still upgradable')
  assert.equal(historyStatus(change({ from: 'best', to: 'best' })), 'Still best quality')
  assert.equal(historyStatus(change({ type: 'resolved', to: 'best' })), 'Upgrade available → Best owned')
  assert.equal(historyStatus(change({ type: 'new', from: null })), 'Upgrade available')
  assert.equal(historyStatus(change({ type: 'removed', to: null })), null)
})

test('legacy history without details describes new, removed, resolved, and upgrade outcomes', () => {
  assert.deepEqual(historyDetails(change({ type: 'new', from: null, details: undefined })), [
    { summary: 'Added to your library' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'removed', to: null, details: [] })), [
    { summary: 'Removed from your library' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'best', details: [] })), [
    { summary: 'You now have the best release' },
  ])
  assert.deepEqual(historyDetails(change({ from: 'best', to: 'best', details: [] })), [
    { summary: 'Release recommendation updated', release: '-ZR-' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'missing', details: [] })), [
    { summary: 'Library status changed' },
  ])
  assert.deepEqual(historyDetails(change({ type: 'upgrade', from: 'best', details: [] })), [
    { summary: 'An upgrade is now available', release: '-ZR-' },
  ])
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
    ['1 upgradable', '1 resolved', '2 removed'],
  )
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
  assert.equal(scanTimes('2026-11-21 23:00:00', now).age, '19 h ago')
  assert.equal(scanTimes('2026-11-10 09:00:00', now).age, null)
  assert.equal(scanTimes('not a date', now).dayKey, 'unknown')
})
