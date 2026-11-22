import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jobResult, type DownloadJob, type DownloadUnitEntry, type DownloadUnitFailure } from '../shared/download-contracts.js'

const unit = (id: string, key = 'anime'): DownloadUnitEntry => ({
  unit_id: id, protocol: 'usenet', source_hash: id, label: key, selections: [{ key, release: 0 }],
})
const job = (overrides: Partial<DownloadJob> = {}): DownloadJob => ({
  id: 'reviewed-job', finished: true, targets: [{ key: 'anime', release: 0, protocol: 'usenet' }],
  pending: [], added: [], existing: [], failures: [], ...overrides,
})
const failure = (id: string, key = 'anime'): DownloadUnitFailure => ({
  ...unit(id, key), code: 'client', error: 'The required source was rejected',
})

test('a release with an existing source and a newly added source is fully successful', () => {
  const result = jobResult(job({ existing: [unit('source-1')], added: [unit('source-2')] }))
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.deepEqual(result.rows, [{ key: 'anime', release: 0, status: 'added', protocols: ['usenet'] }])
})

test('one added source cannot complete a release while another source is pending', () => {
  const running = jobResult(job({ finished: false, added: [unit('source-1')], pending: [unit('source-2')] }))
  assert.equal(running.ok, false)
  assert.equal(running.count, 0)
  assert.equal(running.rows[0].status, 'pending')
  const completed = jobResult(job({ added: [unit('source-1'), unit('source-2')] }))
  assert.equal(completed.count, 1)
  assert.equal(completed.rows[0].status, 'added')
})

test('partial success does not claim that all sources of a release were sent', () => {
  const failed = failure('source-2')
  const result = jobResult(job({ existing: [unit('source-1')], failures: [failed] }))
  assert.equal(result.ok, false)
  assert.equal(result.count, 0)
  assert.equal(result.rows[0].status, 'partial')
  assert.deepEqual(result.failures, [failed])
})

test('a successful source cannot turn an unrelated failed release into partial success', () => {
  const result = jobResult(job({
    targets: [{ key: 'anime-a', release: 0, protocol: 'usenet' }, { key: 'anime-b', release: 0, protocol: 'usenet' }],
    added: [unit('source-a', 'anime-a')], failures: [failure('source-b', 'anime-b')],
  }))
  assert.equal(result.count, 1)
  assert.deepEqual(result.rows.map(row => [row.key, row.status]), [['anime-a', 'added'], ['anime-b', 'failed']])
})
