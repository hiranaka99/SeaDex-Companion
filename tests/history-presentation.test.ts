import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyDetails, historyStatus } from '../frontend/src/history.js'
import { releaseChangeDetail } from '../frontend/src/release-changes.js'
import type { ScanHistoryChange } from '../shared/contracts.js'

const change = (overrides: Partial<ScanHistoryChange> = {}): ScanHistoryChange => ({
  key: 'Sonarr:item1:2', title: 'Example anime', arr: 'Sonarr', season: 2, type: 'changed',
  from: 'upgrade', to: 'upgrade', best_group: '-ZR-', details: ['-ZR- (AB) · Torrent changed'], ...overrides,
})

test('library and history lead with the actual edit and keep its release identity separate', () => {
  assert.deepEqual(historyDetails(change()), [{ summary: 'Torrent updated', release: '-ZR- (AB)' }])
  assert.deepEqual(releaseChangeDetail('Group (Nyaa) · Quality: 1080p → 2160p; Torrent changed; Tags: tv → bd'), {
    summary: 'Quality: 1080p → 2160p · Torrent updated · Tags: tv → bd', release: 'Group (Nyaa)',
  })
  assert.deepEqual(releaseChangeDetail('New alternative: Group (Nyaa) · 1080p'), { summary: 'New alternative', release: 'Group (Nyaa) · 1080p' })
  assert.deepEqual(releaseChangeDetail('Best release changed: A → B'), { summary: 'Best release changed', release: 'A → B' })
  assert.deepEqual(releaseChangeDetail('SeaDex recommendation notes updated'), { summary: 'SeaDex recommendation notes updated' })
  assert.equal(historyDetails(change({ details: ['A (AB) · Torrent changed', 'B (Nyaa) · Release size changed'] })).length, 2)
})

test('history only shows a status transition when the status actually changed', () => {
  assert.equal(historyStatus(change()), 'Still upgradable')
  assert.equal(historyStatus(change({ from: 'best', to: 'best' })), 'Still best quality')
  assert.equal(historyStatus(change({ type: 'resolved', to: 'best' })), 'Upgradable → Best quality')
  assert.equal(historyStatus(change({ type: 'new', from: null })), 'Upgradable')
  assert.equal(historyStatus(change({ type: 'removed', to: null })), null)
})

test('legacy history without details describes new, removed, resolved, and upgrade outcomes', () => {
  assert.deepEqual(historyDetails(change({ type: 'new', from: null, details: undefined })), [{ summary: 'Added to your library' }])
  assert.deepEqual(historyDetails(change({ type: 'removed', to: null, details: [] })), [{ summary: 'Removed from your library' }])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'best', details: [] })), [{ summary: 'You now have the best release' }])
  assert.deepEqual(historyDetails(change({ from: 'best', to: 'best', details: [] })), [{ summary: 'Release recommendation updated', release: '-ZR-' }])
  assert.deepEqual(historyDetails(change({ type: 'resolved', to: 'missing', details: [] })), [{ summary: 'Library status changed' }])
  assert.deepEqual(historyDetails(change({ type: 'upgrade', from: 'best', details: [] })), [{ summary: 'An upgrade is now available', release: '-ZR-' }])
})
