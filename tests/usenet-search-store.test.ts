import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DATA_DIR } from '../server/paths.js'
import {
  UsenetSearchStore,
  type SearchRecord,
  type StoredCandidate,
  type StoredCheck,
  type UsenetSearchStoreOptions,
} from '../server/usenet-search-store.js'
import type { UsenetSearchSummary } from '../shared/contracts.js'

const FINGERPRINT = 'a'.repeat(24)
const OTHER_FINGERPRINT = 'b'.repeat(24)
const SOURCE = 'c'.repeat(40)
const PRIVATE_SOURCE = `files:${'d'.repeat(40)}`
const THIRD_SOURCE = 'e'.repeat(40)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SEARCHED_AT = 1_800_000_000_000
const NO_USAGE = { searches: 0, fetches: 0 }
const SUMMARY: UsenetSearchSummary = {
  finished_at: new Date(SEARCHED_AT).toISOString(),
  searched: 123,
  with_candidates: 80,
  without_candidates: 38,
  failed: 3,
  deferred: 2,
  queries: [
    { indexer: 'Indexer One', count: 135 },
    { indexer: 'Indexer Two', count: 120 },
  ],
}

/** A store on its own files inside the runner's data directory, removed when the test ends. */
function workspace(t: TestContext) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const directory = fs.mkdtempSync(join(DATA_DIR, 'usenet-search-store-'))
  const file = join(directory, 'usenet_search.json')
  const nzbDir = join(directory, 'nzb_store')
  const opened: UsenetSearchStore[] = []
  const logged: string[] = []
  for (const level of ['warn', 'error'] as const)
    t.mock.method(console, level, (line: unknown) => {
      logged.push(String(line))
    })
  t.after(() => {
    for (const store of opened) store.reset()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    file,
    nzbDir,
    /** Warnings and errors the store logged. */
    logged,
    /** Another instance on the same files stands for the process after a restart or a crash. */
    open(options?: UsenetSearchStoreOptions, path = file): UsenetSearchStore {
      const store = new UsenetSearchStore(path, nzbDir, options)
      opened.push(store)
      return store
    },
  }
}

const nzb = (label: string) => new TextEncoder().encode(`<nzb><file subject="${label}"><segments/></file></nzb>`)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const source = (index: number) => index.toString(16).padStart(40, '0')

function candidate(indexerId: number, digit: string, overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    entry_id: `${indexerId}-${digit.repeat(20)}`,
    indexer_id: indexerId,
    indexer: 'Indexer One',
    title: '[Group] Show - 01 (BD 1080p)',
    size: 1_500_000_000,
    files: 14,
    grabs: 3,
    posted_at: 1_700_000_000_000,
    info_url: 'https://indexer.test/details/abc',
    download: { link: 'ZW5jcnlwdGVkLWxpbmstb2YtdGhlLWluZGV4ZXI=', file: 'Show.S01.BD.1080p-Group.nzb' },
    ...overrides,
  }
}

function checked(at: number, nzbSha256?: string, proof: StoredCheck['proof'] = 'exact'): StoredCheck {
  return {
    at,
    proof,
    files_matched: 12,
    names_matched: 12,
    files_expected: 12,
    sizes_known: true,
    ratio: [1.021, 1.034],
    ...(nzbSha256 ? { nzb_sha256: nzbSha256 } : {}),
  }
}

function record(
  sourceId = SOURCE,
  candidates: StoredCandidate[] = [candidate(1, 'a')],
  overrides: Partial<SearchRecord> = {},
): SearchRecord {
  return {
    source_id: sourceId,
    fingerprint: FINGERPRINT,
    searched_at: SEARCHED_AT,
    last_attempt_at: SEARCHED_AT,
    retry_at: 0,
    indexers: [{ id: 1, name: 'Indexer One', answered: true, at: SEARCHED_AT }],
    candidates,
    ...overrides,
  }
}

test('a fetch recorded with a durable put is on disk before put returns, a search-only update only after a flush', t => {
  const { file, open } = workspace(t)
  const store = open()
  store.put(record())
  assert.equal(fs.existsSync(file), false, 'a search-only update waits for the batched write')
  assert.equal(open().get(FINGERPRINT, SOURCE), undefined)

  const bytes = nzb('checked post')
  const stored = store.storeNzb(bytes)
  const found = store.get(FINGERPRINT, SOURCE)!
  found.candidates[0].check = checked(SEARCHED_AT + MINUTE, stored)
  store.put(found, { durable: true })
  // No flush: the process is killed here.
  const afterCrash = open()
  assert.deepEqual(afterCrash.get(FINGERPRINT, SOURCE)?.candidates[0].check, checked(SEARCHED_AT + MINUTE, stored))
  assert.deepEqual(afterCrash.readNzb(stored), bytes)

  store.put(record(PRIVATE_SOURCE))
  assert.equal(open().get(FINGERPRINT, PRIVATE_SOURCE), undefined)
  assert.equal(store.flush(), true)
  assert.deepEqual(open().get(FINGERPRINT, PRIVATE_SOURCE), record(PRIVATE_SOURCE))
})

test('records are copied on the way in and out, so a caller cannot change stored state by accident', t => {
  const store = workspace(t).open()
  const input = record()
  store.put(input)
  input.candidates[0].title = 'changed after put'
  input.indexers.length = 0
  const first = store.get(FINGERPRINT, SOURCE)!
  first.candidates.push(candidate(2, 'b'))
  first.candidates[0].download.link = 'changed after get'
  first.retry_at = 5
  assert.deepEqual(store.get(FINGERPRINT, SOURCE), record())
  const [listed] = store.records(FINGERPRINT)
  listed.candidates.length = 0
  assert.deepEqual(store.records(FINGERPRINT), [record()])
  assert.deepEqual(store.records(OTHER_FINGERPRINT), [])
  assert.equal(store.size, 1)
})

test('a proven candidate, its check, a rejection and the sweep summary survive a restart', t => {
  const { open } = workspace(t)
  const store = open()
  const proven = store.storeNzb(nzb('proven post'))
  const saved = record(
    PRIVATE_SOURCE,
    [
      candidate(1, 'a', { check: checked(SEARCHED_AT, proven, 'near_exact') }),
      candidate(2, 'b', {
        indexer: 'Indexer Two',
        size: null,
        check: checked(SEARCHED_AT, sha256(nzb('evicted post')), 'probable'),
        rejected: { at: SEARCHED_AT + HOUR, reason: 'import_mismatch' },
      }),
      candidate(2, 'c', {
        check: {
          at: SEARCHED_AT,
          proof: 'unverified',
          files_matched: 0,
          names_matched: 0,
          files_expected: 12,
          sizes_known: false,
          unavailable: { code: 'rate_limited', retry_at: SEARCHED_AT + DAY },
        },
      }),
    ],
    {
      negative_streak: 2,
      retry_at: SEARCHED_AT + DAY,
      indexers: [
        { id: 1, name: 'Indexer One', answered: true, at: SEARCHED_AT },
        { id: 2, name: 'Indexer Two', answered: false, at: SEARCHED_AT },
      ],
    },
  )
  store.put(saved, { durable: true })
  store.setSummary(SUMMARY, FINGERPRINT)
  assert.equal(open().summary(), undefined, 'the summary waits for the batched write')
  assert.equal(store.flush(), true)

  store.reset(true)
  assert.deepEqual(store.get(FINGERPRINT, PRIVATE_SOURCE), saved)
  assert.deepEqual(store.summary(), SUMMARY)
  assert.deepEqual(store.readNzb(proven), nzb('proven post'))
  const restarted = open()
  assert.deepEqual(restarted.records(FINGERPRINT), [saved])
  assert.deepEqual(restarted.summary(), SUMMARY)

  store.reset()
  assert.equal(store.get(FINGERPRINT, PRIVATE_SOURCE), undefined, 'a plain reset clears memory')
  assert.equal(open().size, 1, 'and leaves the file alone')
})

test('an invalid record and an invalid candidate are dropped on load while the valid ones are kept', t => {
  const { file, logged, open } = workspace(t)
  const start = Math.floor(Date.now() / HOUR)
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      records: [
        record(SOURCE, [
          candidate(1, 'a'),
          candidate(1, 'b', { download: { link: '', file: 'empty-link.nzb' } }),
          { ...candidate(2, 'c'), entry_id: 'https://indexer.test/get?id=1' },
          { ...candidate(1, 'd'), check: { at: 1, proof: 'certain' } } as unknown as StoredCandidate,
          { ...candidate(1, 'e'), entry_id: candidate(3, 'e').entry_id },
          candidate(1, 'a', { title: 'the same entry listed twice' }),
          { ...candidate(1, 'f'), files: -1, info_url: 'javascript:alert(1)' },
        ]),
        { ...record(PRIVATE_SOURCE), source_id: 'not-a-source' },
        { ...record(PRIVATE_SOURCE), fingerprint: 'short' },
        { ...record(PRIVATE_SOURCE), retry_at: -1 },
        { ...record(PRIVATE_SOURCE), candidates: 'none' },
        'a record that is no object',
        record(THIRD_SOURCE),
      ],
      usage: [
        { fingerprint: FINGERPRINT, indexer_id: 1, hour: start, searches: 4, fetches: 2 },
        { fingerprint: FINGERPRINT, indexer_id: 1, hour: start - 48, searches: 9, fetches: 9 },
        { fingerprint: FINGERPRINT, indexer_id: 'one', hour: start, searches: 1, fetches: 1 },
      ],
      summary: { ...SUMMARY, searched: 'many' },
    }),
  )
  const store = open()
  assert.equal(store.size, 2)
  const kept = store.get(FINGERPRINT, SOURCE)!
  const display = candidate(1, 'f')
  delete display.files
  delete display.info_url
  assert.deepEqual(kept.candidates, [candidate(1, 'a'), display], 'unusable display fields are left out')
  assert.deepEqual(store.get(FINGERPRINT, THIRD_SOURCE), record(THIRD_SOURCE))
  assert.deepEqual(store.usage(FINGERPRINT, 1), { searches: 4, fetches: 2 }, 'hours outside the window are dropped')
  assert.equal(store.summary(), undefined)
  assert.equal(logged.length, 1, 'one warning covers the load')
  assert.match(logged[0], /ignored 5 invalid records and 7 invalid entries/)
  assert.equal(store.flush(), true)
  const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rewritten.records.length, 2)
  assert.equal(rewritten.usage.length, 1)
})

test('a file of another version, shape or broken JSON starts empty with a warning that quotes nothing', t => {
  const { file, logged, open } = workspace(t)
  fs.writeFileSync(file, JSON.stringify({ version: 2, records: [record()] }))
  assert.equal(open().size, 0)
  fs.writeFileSync(file, JSON.stringify([record()]))
  assert.equal(open().size, 0)
  fs.writeFileSync(file, '{"version":1,"records":[{"download":{"link":SENSITIVELINK}}]}')
  const store = open()
  assert.equal(store.size, 0)
  assert.equal(logged.length, 3)
  assert.equal(
    logged.some(line => /SENSITIVE|link/i.test(line)),
    false,
  )
  store.put(record(), { durable: true })
  assert.deepEqual(open().get(FINGERPRINT, SOURCE), record(), 'the next write replaces the unusable file')
})

test('the stored file holds only allow-listed fields, no key, and is private to the user', t => {
  const { file, logged, open } = workspace(t)
  const store = open()
  const leaking = {
    ...candidate(1, 'a', {
      title: 'Show <b>01</b>\u0007\n',
      info_url: 'https://indexer.test/details/1?apikey=secret-key',
    }),
    download_path: '/1/download?apikey=secret-key&link=abc&file=Show.nzb',
    guid: 'https://indexer.test/api?t=get&id=1&apikey=secret-key',
    nzb: [60, 110, 122, 98],
  } as StoredCandidate
  const wholeAddress = candidate(1, 'b', {
    download: { link: 'https://prowlarr.test/1/download?apikey=secret-key&link=abc', file: 'Show.nzb' },
  })
  const userInfo = candidate(1, 'c', { info_url: 'https://user:secret-key@indexer.test/details/1' })
  store.put(
    {
      ...record(SOURCE, [leaking, wholeAddress, userInfo]),
      settings: { baseUrl: 'https://prowlarr.test', apiKey: 'secret-key' },
    } as SearchRecord,
    { durable: true },
  )
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.includes('secret'), false)
  assert.equal(/api_?key/i.test(text), false)
  for (const field of ['download_path', 'guid', 'settings', 'baseUrl', '"nzb"'])
    assert.equal(text.includes(field), false, `${field} is not persisted`)

  const cleaned = candidate(1, 'a', { title: 'Show b 01 /b' })
  delete cleaned.info_url
  const withoutLink = candidate(1, 'c')
  delete withoutLink.info_url
  assert.deepEqual(store.get(FINGERPRINT, SOURCE)?.candidates, [cleaned, withoutLink])
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['records', 'usage', 'version'])
  assert.equal(logged.length, 1, 'the candidate holding a whole download address is left out with a warning')
  assert.equal(
    logged.some(line => /secret|prowlarr\.test|Show|ZW5j/.test(line)),
    false,
    'no log line carries a link, a title or a key',
  )
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('put refuses a record without a usable identity', t => {
  const store = workspace(t).open()
  assert.throws(() => store.put({ ...record(), source_id: 'nope' }), TypeError)
  assert.throws(() => store.put({ ...record(), fingerprint: 'A'.repeat(24) }), TypeError)
  assert.throws(() => store.put({ ...record(), searched_at: Number.NaN }), TypeError)
  assert.throws(() => store.setSummary({ ...SUMMARY, finished_at: 'not a date' }), TypeError)
  assert.throws(() => store.countFetch('nope', 1), TypeError)
  assert.equal(store.size, 0)
  assert.equal(store.flush(), true)
})

test('storeNzb and readNzb round-trip by SHA-256, and a corrupted file reads as null', t => {
  const { nzbDir, open } = workspace(t)
  const store = open()
  const bytes = nzb('round trip')
  const name = store.storeNzb(bytes)
  const path = join(nzbDir, `${name}.nzb.gz`)
  assert.equal(name, sha256(bytes))
  assert.deepEqual(fs.readdirSync(nzbDir), [`${name}.nzb.gz`], 'no temporary file is left behind')
  assert.equal(store.hasNzb(name), true)
  assert.deepEqual(store.readNzb(name), bytes)
  assert.deepEqual(open().readNzb(name), bytes)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path).mode & 0o777, 0o600)

  assert.equal(store.hasNzb('f'.repeat(64)), false)
  assert.equal(store.readNzb('f'.repeat(64)), null)
  assert.equal(store.hasNzb(`../${name}`), false)
  assert.equal(store.readNzb(`../${name}`), null)

  fs.writeFileSync(path, gzipSync(nzb('another post under the same name')))
  assert.equal(store.readNzb(name), null, 'content that does not hash to its name is not an NZB')
  assert.equal(store.hasNzb(name), false, 'and the file is removed')

  assert.equal(store.storeNzb(bytes), name)
  fs.writeFileSync(path, fs.readFileSync(path).subarray(0, 12))
  assert.equal(store.readNzb(name), null, 'a torn file is not an NZB')

  assert.equal(store.storeNzb(new Uint8Array(0)), sha256(new Uint8Array(0)))
  assert.equal(store.hasNzb(sha256(new Uint8Array(0))), false, 'an empty NZB is not stored')
})

test('eviction beyond the budget removes the oldest NZBs, spares those checked in the last day up to the hard limit, and keeps every check', t => {
  const { nzbDir, open } = workspace(t)
  const payload = () => new Uint8Array(randomBytes(2048))
  const probe = open()
  const size = fs.statSync(join(nzbDir, `${probe.storeNzb(payload())}.nzb.gz`)).size
  probe.retainFingerprint(null)
  assert.deepEqual(fs.readdirSync(nzbDir), [])

  const store = open({ nzbBudgetBytes: size * 2 + 16, nzbHardLimitBytes: size * 4 + 16 })
  const now = Date.now()
  let sources = 0
  const check = (age: number) => {
    const name = store.storeNzb(payload())
    const id = source(++sources)
    store.put(record(id, [candidate(1, 'a', { check: checked(now - age, name) })]), { durable: true })
    return { id, name, check: checked(now - age, name) }
  }
  const stored = (...entries: { name: string }[]) => entries.map(entry => store.hasNzb(entry.name))

  const threeDays = check(3 * DAY)
  const twoDays = check(2 * DAY)
  assert.deepEqual(stored(threeDays, twoDays), [true, true], 'within the budget nothing is evicted')
  const overADay = check(DAY + HOUR)
  assert.deepEqual(stored(threeDays, twoDays, overADay), [false, true, true], 'the oldest goes first')
  assert.deepEqual(store.get(FINGERPRINT, threeDays.id)?.candidates[0].check, threeDays.check)

  const twoHours = check(2 * HOUR)
  const oneHour = check(HOUR)
  assert.deepEqual(stored(twoDays, overADay, twoHours, oneHour), [false, false, true, true])
  const halfHour = check(30 * MINUTE)
  const tenMinutes = check(10 * MINUTE)
  assert.deepEqual(
    stored(twoHours, oneHour, halfHour, tenMinutes),
    [true, true, true, true],
    'NZBs checked in the last 24 hours stay although the budget is exceeded',
  )
  const justNow = check(0)
  assert.deepEqual(
    stored(twoHours, oneHour, halfHour, tenMinutes, justNow),
    [false, true, true, true, true],
    'the hard limit overrides the protection, oldest first',
  )
  assert.equal(fs.readdirSync(nzbDir).length, 4)

  const restarted = open()
  for (const evicted of [threeDays, twoDays, overADay, twoHours]) {
    assert.deepEqual(restarted.get(FINGERPRINT, evicted.id)?.candidates[0].check, evicted.check)
    assert.equal(restarted.readNzb(evicted.name), null)
  }
  assert.equal(restarted.readNzb(justNow.name)?.length, 2048)
})

test('retainSources drops the records of sources that left the results with their NZBs, and a shared NZB survives while one candidate names it', t => {
  const { file, nzbDir, open } = workspace(t)
  fs.mkdirSync(nzbDir, { recursive: true })
  const unreferenced = join(nzbDir, `${'9'.repeat(64)}.nzb.gz`)
  const unfinished = join(nzbDir, `${'8'.repeat(64)}.nzb.gz.tmp`)
  const foreign = join(nzbDir, 'notes.txt')
  for (const path of [unreferenced, unfinished, foreign]) fs.writeFileSync(path, 'left behind')

  const store = open()
  const now = Date.now()
  const shared = store.storeNzb(nzb('shared by two sources'))
  const own = store.storeNzb(nzb('of one source'))
  store.put(record(SOURCE, [candidate(1, 'a', { check: checked(now, shared) })]), { durable: true })
  store.put(record(PRIVATE_SOURCE, [candidate(1, 'b', { check: checked(now, shared) })]), { durable: true })
  store.put(record(THIRD_SOURCE, [candidate(2, 'c', { check: checked(now, own) }), candidate(2, 'd')]), {
    durable: true,
  })
  assert.deepEqual(
    [unreferenced, unfinished, foreign].map(path => fs.existsSync(path)),
    [false, false, true],
    'files no candidate names are removed when the store prunes; files that are not NZBs are left alone',
  )

  const waiting = store.storeNzb(nzb('stored, its record not written yet'))
  assert.equal(store.retainSources(new Set([SOURCE, source(1)])), 2)
  assert.deepEqual(store.get(FINGERPRINT, SOURCE)?.candidates[0].check, checked(now, shared))
  assert.equal(store.get(FINGERPRINT, PRIVATE_SOURCE), undefined)
  assert.equal(store.get(FINGERPRINT, THIRD_SOURCE), undefined)
  assert.equal(store.hasNzb(shared), true)
  assert.equal(store.hasNzb(own), false)
  assert.equal(store.hasNzb(waiting), true, 'a just-stored NZB waits for the record that names it')
  assert.equal(store.pruneNzbs(Date.now() + HOUR), 1)
  assert.equal(store.hasNzb(waiting), false)

  assert.equal(store.retainSources(new Set([SOURCE])), 0)
  assert.equal(store.flush(), true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 1)
  assert.equal(store.retainSources(new Set()), 1)
  assert.equal(store.hasNzb(shared), false)
  assert.equal(store.flush(), true)
  assert.equal(open().size, 0)
})

test('retainFingerprint drops the records, counters, summary and NZBs of another connection, and null drops everything', t => {
  const { nzbDir, open } = workspace(t)
  const store = open()
  const now = Date.now()
  const kept = store.storeNzb(nzb('of this connection'))
  const dropped = store.storeNzb(nzb('of the other connection'))
  store.put(record(SOURCE, [candidate(1, 'a', { check: checked(now, kept) })]), { durable: true })
  store.put(record(SOURCE, [candidate(1, 'b', { check: checked(now, dropped) })], { fingerprint: OTHER_FINGERPRINT }), {
    durable: true,
  })
  store.put(record(PRIVATE_SOURCE, undefined, { fingerprint: OTHER_FINGERPRINT }))
  store.countFetch(FINGERPRINT, 1, now)
  store.countFetch(OTHER_FINGERPRINT, 1, now)
  store.countSearch(OTHER_FINGERPRINT, 2, now)
  store.setSummary(SUMMARY, OTHER_FINGERPRINT)

  assert.equal(store.retainFingerprint(FINGERPRINT), 2)
  assert.deepEqual(store.records(OTHER_FINGERPRINT), [])
  assert.equal(store.records(FINGERPRINT).length, 1)
  assert.equal(store.hasNzb(kept), true)
  assert.equal(store.hasNzb(dropped), false)
  assert.deepEqual(store.usage(FINGERPRINT, 1, now), { searches: 0, fetches: 1 })
  assert.deepEqual(store.usage(OTHER_FINGERPRINT, 1, now), NO_USAGE)
  assert.deepEqual(store.usage(OTHER_FINGERPRINT, 2, now), NO_USAGE)
  assert.equal(store.summary(), undefined)
  // Written before it returned: a crash now cannot bring the other connection back.
  const afterCrash = open()
  assert.deepEqual(afterCrash.records(OTHER_FINGERPRINT), [])
  assert.deepEqual(afterCrash.usage(OTHER_FINGERPRINT, 2, now), NO_USAGE)
  assert.equal(afterCrash.summary(), undefined)

  store.setSummary(SUMMARY, FINGERPRINT)
  assert.equal(store.retainFingerprint(FINGERPRINT), 0, 'an unchanged connection loses nothing')
  assert.deepEqual(store.summary(), SUMMARY)
  assert.equal(store.hasNzb(kept), true)

  assert.equal(store.retainFingerprint(null), 1)
  assert.equal(store.size, 0)
  assert.deepEqual(store.usage(FINGERPRINT, 1, now), NO_USAGE)
  assert.equal(store.summary(), undefined)
  assert.deepEqual(fs.readdirSync(nzbDir), [])
  assert.equal(open().size, 0)
})

test('usage counters add up within 24 hours, age out afterwards and survive a restart', t => {
  const { file, open } = workspace(t)
  const store = open()
  const start = Math.floor(Date.now() / HOUR) * HOUR
  const leaves = start + HOUR + DAY
  store.countSearch(FINGERPRINT, 7, start)
  store.countSearch(FINGERPRINT, 7, start + 10 * MINUTE)
  store.countSearch(FINGERPRINT, 8, start)
  store.countSearch(OTHER_FINGERPRINT, 7, start)
  assert.equal(fs.existsSync(file), false, 'a search count waits for the batched write')
  store.countFetch(FINGERPRINT, 7, start + 20 * MINUTE)
  assert.deepEqual(open().usage(FINGERPRINT, 7, start + HOUR), { searches: 2, fetches: 1 }, 'a fetch count is durable')

  assert.deepEqual(store.usage(FINGERPRINT, 7, start + 30 * MINUTE), { searches: 2, fetches: 1 })
  assert.deepEqual(store.usage(FINGERPRINT, 8, start + 30 * MINUTE), { searches: 1, fetches: 0 })
  assert.deepEqual(store.usage(OTHER_FINGERPRINT, 7, start + 30 * MINUTE), { searches: 1, fetches: 0 })
  assert.deepEqual(store.usage(FINGERPRINT, 9, start + 30 * MINUTE), NO_USAGE)
  assert.deepEqual(store.usage(FINGERPRINT, 7, start + 23 * HOUR), { searches: 2, fetches: 1 })
  assert.deepEqual(store.usage(FINGERPRINT, 7, leaves - 1), { searches: 2, fetches: 1 })
  assert.deepEqual(store.usage(FINGERPRINT, 7, leaves), NO_USAGE, 'an hour leaves the window a day after it ends')

  store.countSearch(FINGERPRINT, 7, start + 2 * HOUR)
  assert.deepEqual(store.usage(FINGERPRINT, 7, leaves), { searches: 1, fetches: 0 }, 'hours age out one by one')
  assert.equal(store.flush(), true)
  store.reset(true)
  assert.deepEqual(store.usage(FINGERPRINT, 7, start + 2 * HOUR), { searches: 3, fetches: 1 })
  assert.deepEqual(open().usage(FINGERPRINT, 8, start), { searches: 1, fetches: 0 })

  // Counting long after the window drops the hours that left it.
  store.countSearch(FINGERPRINT, 7, start + 3 * DAY)
  assert.deepEqual(store.usage(FINGERPRINT, 7, start + 2 * HOUR), NO_USAGE)
  assert.deepEqual(store.usage(FINGERPRINT, 7, start + 3 * DAY), { searches: 1, fetches: 0 })
})

test('nextAvailableAt reports when the oldest hour leaves the window, and a limit of 0 never blocks', t => {
  const store = workspace(t).open()
  const start = Math.floor(Date.now() / HOUR) * HOUR
  const now = start + 3 * HOUR
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 1, now), now, 'an unused indexer is available')
  store.countFetch(FINGERPRINT, 7, start)
  store.countFetch(FINGERPRINT, 7, start + 2 * HOUR)
  store.countFetch(FINGERPRINT, 7, start + 2 * HOUR + MINUTE)
  store.countSearch(FINGERPRINT, 7, start + HOUR)

  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 4, now), now, 'below the limit')
  const oldestLeaves = start + HOUR + DAY
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 3, now), oldestLeaves)
  assert.equal(store.usage(FINGERPRINT, 7, oldestLeaves - 1).fetches, 3)
  assert.equal(store.usage(FINGERPRINT, 7, oldestLeaves).fetches, 2)
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 2, now), start + 3 * HOUR + DAY)
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 1, now), start + 3 * HOUR + DAY)
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'fetch', 0, now), now, 'a limit of 0 is no limit')
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'search', 2, now), now, 'searches are counted apart')
  assert.equal(store.nextAvailableAt(FINGERPRINT, 7, 'search', 1, now), start + 2 * HOUR + DAY)
  assert.equal(store.nextAvailableAt(FINGERPRINT, 8, 'fetch', 1, now), now, 'each indexer has its own counters')
  assert.equal(store.nextAvailableAt(OTHER_FINGERPRINT, 7, 'fetch', 1, now), now)
})

test('a failed write reports false, keeps the change and is written by a later flush', t => {
  const { directory, logged, open } = workspace(t)
  const blocker = join(directory, 'blocked')
  fs.writeFileSync(blocker, '')
  const path = join(blocker, 'usenet_search.json')
  const store = open(undefined, path)
  store.put(record(), { durable: true })
  assert.equal(store.flush(), false)
  assert.deepEqual(store.get(FINGERPRINT, SOURCE), record())
  assert.equal(logged.length > 0, true, 'the failure is logged')
  assert.equal(
    logged.some(line => /ZW5jcnlwdGVk|\[Group\]/.test(line)),
    false,
    'without a link or a title',
  )
  fs.rmSync(blocker)
  assert.equal(store.flush(), true)
  assert.deepEqual(open(undefined, path).get(FINGERPRINT, SOURCE), record())
})
