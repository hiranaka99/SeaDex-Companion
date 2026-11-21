import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_DATETIME_FORMAT, formatDateTime, isValidDateTimeFormat, parseTimestamp } from '../shared/datetime-format.js'
import { applyConfigUpdate, DEFAULT_CONFIG } from '../server/config.js'

const sample = new Date(2026, 10, 21, 18, 40, 29) // 2026-11-21 18:40:29 local

test('the default format keeps the established timestamp rendering', () => {
  assert.equal(formatDateTime(sample, DEFAULT_DATETIME_FORMAT), '2026-11-21 18:40:29')
})

test('custom patterns render dates with the user’s separators and widths', () => {
  assert.equal(formatDateTime(sample, 'DD.MM.YYYY HH:mm:ss'), '21.11.2026 18:40:29')
  assert.equal(formatDateTime(sample, 'D.M.YY H:mm'), '21.11.26 18:40')
  assert.equal(formatDateTime(sample, 'YYYY/MM/DD HH:mm'), ['2026', '11', '21'].join(String.fromCharCode(47)) + ' 18:40')
  assert.equal(formatDateTime(sample, 'DD-MM-YYYY'), '21-11-2026')
})

test('format validation accepts token patterns and rejects prose', () => {
  assert.ok(isValidDateTimeFormat('DD.MM.YYYY HH:mm:ss'))
  assert.ok(isValidDateTimeFormat('YYYY-MM-DD HH:mm'))
  assert.ok(isValidDateTimeFormat('DD/MM/YYYY'))
  assert.ok(!isValidDateTimeFormat(''))
  assert.ok(!isValidDateTimeFormat('today'))
  assert.ok(!isValidDateTimeFormat('YYYY-MM-DD HH:mm:ss (local)'))
  assert.ok(!isValidDateTimeFormat(42 as unknown as string))
})

test('stored timestamps parse in both server-local and ISO forms', () => {
  assert.equal(parseTimestamp('2026-11-21 18:40:29')?.getTime(), sample.getTime())
  assert.equal(parseTimestamp('just now'), null)
  assert.equal(parseTimestamp(null), null)
})

test('configuration accepts, resets, and rejects date-time formats', () => {
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { datetime_format: 'DD.MM.YYYY HH:mm:ss' }).datetime_format, 'DD.MM.YYYY HH:mm:ss')
  assert.equal(applyConfigUpdate({ ...DEFAULT_CONFIG, datetime_format: 'DD.MM.YYYY HH:mm:ss' }, { datetime_format: '  ' }).datetime_format, DEFAULT_DATETIME_FORMAT)
  assert.equal(applyConfigUpdate({ ...DEFAULT_CONFIG, datetime_format: 'DD.MM.YYYY HH:mm:ss' }, {}).datetime_format, 'DD.MM.YYYY HH:mm:ss')
  assert.throws(() => applyConfigUpdate(DEFAULT_CONFIG, { datetime_format: 'next week maybe' }), /datetime_format/)
})
