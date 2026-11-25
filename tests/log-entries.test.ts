import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLevels, entriesSince, entryMatches, parseLogEntries, splitMatches } from '../frontend/src/log-entries.js'

const lines = [
  '  at orphaned (frame.mjs:1:1)',
  '2026-10-02 12:00:00 [INFO] Scan started',
  '2026-10-02 12:00:01 [ERROR] qBittorrent login failed',
  '  at async login (client.mjs:88:14)',
  '2026-10-02 12:00:02 [WARNING] Rate limit approaching',
  '2026-10-02 12:00:03 Plain line without a level',
  '2026-10-02 12:00:01 [ERROR] qBittorrent login failed',
]

test('log lines become entries that keep stack frames and the original text', () => {
  const entries = parseLogEntries(lines)
  assert.equal(entries.length, 6)
  assert.equal(entries[0].level, '')
  assert.equal(entries[0].message, '  at orphaned (frame.mjs:1:1)')
  assert.deepEqual(
    [entries[2].timestamp, entries[2].level, entries[2].message],
    ['2026-10-02 12:00:01', 'ERROR', 'qBittorrent login failed'],
  )
  assert.deepEqual(entries[2].continuation, ['  at async login (client.mjs:88:14)'])
  assert.deepEqual(entries[2].raw, [lines[2], lines[3]])
  assert.equal(entries[4].level, '')
  assert.equal(entries[4].message, 'Plain line without a level')
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length, 'Identical lines still get distinct keys')
})

test('lines that already contain line breaks are split into entry and continuation', () => {
  const entries = parseLogEntries([
    '2026-10-02 12:00:00 [ERROR] Failed\r\n  at one (a.mjs:1:1)\n  at two (a.mjs:2:2)',
    '2026-10-02 12:00:01 [INFO] Next',
  ])
  assert.equal(entries.length, 2)
  assert.equal(entries[0].level, 'ERROR')
  assert.deepEqual(entries[0].continuation, ['  at one (a.mjs:1:1)', '  at two (a.mjs:2:2)'])
})

test('entry keys survive older entries rolling out of the window', () => {
  const before = parseLogEntries(lines)
  const after = parseLogEntries(lines.slice(2).concat('2026-10-02 12:00:04 [INFO] Next'))
  const stable = before.find(entry => entry.message === 'Rate limit approaching')?.key
  assert.equal(after.find(entry => entry.message === 'Rate limit approaching')?.key, stable)
})

test('level filters, counts, and search agree about which entries are visible', () => {
  const entries = parseLogEntries(lines)
  assert.deepEqual(countLevels(entries), { all: 6, errors: 2, warn: 3 })
  assert.equal(entries.filter(entry => entryMatches(entry, 'error', '')).length, 2)
  assert.equal(entries.filter(entry => entryMatches(entry, 'warn', '')).length, 3)
  assert.equal(
    entries.filter(entry => entryMatches(entry, 'all', 'ASYNC LOGIN')).length,
    1,
    'Search reaches stack frames case-insensitively',
  )
  assert.equal(entries.filter(entry => entryMatches(entry, 'warn', 'scan')).length, 0)
})

test('new entries are counted from the last entry the reader saw', () => {
  const entries = parseLogEntries(lines)
  assert.equal(entriesSince(entries, null), 0)
  assert.equal(entriesSince(entries, entries[3].key), 2)
  assert.equal(entriesSince(entries, entries[entries.length - 1].key), 0)
  assert.equal(entriesSince(entries, 'gone'), null)
})

test('search highlighting preserves the text around every match', () => {
  const parts = splitMatches('Fetched Nyaa from nyaa.si', 'nyaa')
  assert.deepEqual(parts.map(part => part.text).join(''), 'Fetched Nyaa from nyaa.si')
  assert.deepEqual(
    parts.filter(part => part.match).map(part => part.text),
    ['Nyaa', 'nyaa'],
  )
  assert.deepEqual(splitMatches('anything', '  '), [{ text: 'anything', match: false }])
})
