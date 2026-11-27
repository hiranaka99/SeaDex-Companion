// The background search sweep: the Prowlarr search stage that follows the hash lookups, its progress, its
// summary, the search-status route, pruning of the search store and the setting that switches it. Prowlarr and
// AnimeTosho are a fake `fetch` that records every request; files live in the shared temp DATA_DIR.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../server/config.js'
import { saveSettings } from '../server/config-service.js'
import { downloadRoutes } from '../server/download-routes.js'
import { addDownloadRecord, resetOwnedRuntime, setDownloadPhase } from '../server/download-store.js'
import {
  CONFIG_FILE,
  DATA_DIR,
  ENCRYPTED_SECRETS_FILE,
  NZB_STORE_DIR,
  RESULTS_FILE,
  SECRETS_KEY_FILE,
  USENET_SEARCH_FILE,
} from '../server/paths.js'
import { prowlarrFingerprint, resetProwlarrRuntime } from '../server/prowlarr.js'
import { matchRoute } from '../server/router.js'
import { autocheckState, setState } from '../server/scan-state.js'
import { filesSourceId } from '../server/source-files.js'
import type { Config, PrivateSource, ResultItem } from '../server/types.js'
import {
  enableUsenetPrefetch,
  prefetchUsenetAvailability,
  stopUsenetPrefetch,
  usenetPrefetchProgress,
  usenetSearchStatus,
} from '../server/usenet-prefetch.js'
import { resetUsenetLookups, usenetScheduler } from '../server/usenet.js'
import { resetUsenetSearch, searchScheduler, searchSource, searchStore } from '../server/usenet-search.js'
import type { ProwlarrSearchStatus } from '../shared/contracts.js'

const PROWLARR = 'http://prowlarr-sweep.test:9696'
const KEY = 'prowlarr-key-sweep-7a3b'
const FINGERPRINT = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })
const GEEK = { id: 2, name: 'Geek', protocol: 'usenet', privacy: 'private', enable: true }
const NZB_SITE = { id: 9, name: 'Torrents', protocol: 'torrent', privacy: 'private', enable: true }
const HOUR = 60 * 60_000
const SIZES = [1_512_345_678, 1_398_765_432]
const TOTAL = SIZES.reduce((sum, size) => sum + size, 0)
const LEDGER_FILE = join(DATA_DIR, 'owned_downloads.json')
const SCHEDULE_FILE = join(DATA_DIR, 'scan_schedule_state.json')

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    tracker_mode: 'private',
    prowlarr_enabled: true,
    prowlarr_url: PROWLARR,
    prowlarr_key: KEY,
    prowlarr_background_search: true,
    sabnzbd_url: 'http://sab.test:8080/',
    sabnzbd_key: 'sab-key',
    download_mode: 'choose',
    animetosho_enabled: false,
    amenzb_enabled: false,
    ...overrides,
  } as Config
}

function show(tag: string): PrivateSource {
  const files = SIZES.map((length, index) => ({ name: `[Vault] ${tag} - 0${index + 1} (BD 1080p).mkv`, length }))
  return { id: filesSourceId(files), files }
}

let hashCounter = 0
const nextHash = () => (0x5eed00 + hashCounter++).toString(16).padStart(40, '0')

/** A library row whose release is on a private tracker: SeaDex lists its files and no info hash. */
function privateRow(tag: string, status = 'missing'): ResultItem {
  return {
    key: tag.toLowerCase(),
    title: tag,
    season: 1,
    status,
    releases: [
      {
        kind: 'best',
        releaseGroup: 'Vault',
        tracker: 'AB',
        torrent_available: false,
        info_hashes: [],
        size: TOTAL,
        private_sources: [show(tag)],
      },
    ],
  } as unknown as ResultItem
}

/** A library row whose release is a public torrent with its file list. */
function publicRow(tag: string, status = 'missing', hash = nextHash()): { row: ResultItem; hash: string } {
  const row = {
    key: tag.toLowerCase(),
    title: tag,
    season: 1,
    status,
    releases: [
      {
        kind: 'best',
        releaseGroup: 'Vault',
        tracker: 'Nyaa',
        torrent_available: true,
        info_hashes: [hash],
        size: TOTAL,
        torrent_files: [{ hash, files: show(tag).files }],
      },
    ],
  } as unknown as ResultItem
  return { row, hash }
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A Newznab answer listing one strong post for each tag in `found` that the query names. */
function feed(indexerId: number, query: string, found: ReadonlySet<string>): Response {
  const items = [...found]
    .filter(tag => query.toLowerCase().includes(tag.toLowerCase()))
    .map(tag => {
      const proxy = escapeXml(
        `http://localhost:9696/${indexerId}/download?${new URLSearchParams({ apikey: KEY, link: tag, file: tag })}`,
      )
      const page = `https://indexer${indexerId}.test/details/${tag}`
      return [
        `<item><title>[Vault] ${escapeXml(tag)} (BD 1080p)</title><guid>${page}</guid><link>${proxy}</link>`,
        `<enclosure url="${proxy}" type="application/x-nzb" />`,
        `<newznab:attr name="size" value="${Math.round(TOTAL * 1.08)}" /></item>`,
      ].join('')
    })
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Prowlarr</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/rss+xml' } },
  )
}

interface Fake {
  calls: URL[]
  indexers: unknown[]
  /** Tags whose search lists a strong post. */
  found: Set<string>
  /** Held until opened, when set: every search waits for it. */
  hold?: Promise<void>
  /** AnimeTosho's answer for one hash; no NZB by default. */
  tosho: (hash: string) => Response
}

/**
 * Resets the sweep, the finder and its files, both schedulers' pacing and the Prowlarr client, and routes
 * `fetch` to a fake Prowlarr and AnimeTosho. Everything is put back when the test ends.
 */
function setup(t: TestContext, overrides: Partial<Fake> = {}): Fake {
  const original = globalThis.fetch
  const pacing = { search: searchScheduler.options.minIntervalMs, hashes: usenetScheduler.options.minIntervalMs }
  const clean = () => {
    stopUsenetPrefetch()
    resetUsenetSearch()
    resetUsenetLookups()
    resetProwlarrRuntime()
    fs.rmSync(USENET_SEARCH_FILE, { force: true })
    fs.rmSync(NZB_STORE_DIR, { recursive: true, force: true })
  }
  clean()
  enableUsenetPrefetch()
  searchScheduler.options.minIntervalMs = 0
  usenetScheduler.options.minIntervalMs = 0
  const fake: Fake = {
    calls: [],
    indexers: [GEEK],
    found: new Set(),
    tosho: () => new Response('nope', { status: 404 }),
    ...overrides,
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    fake.calls.push(url)
    if (url.origin === 'https://feed.animetosho.net') return fake.tosho(url.searchParams.get('hash') ?? '')
    if (url.origin !== PROWLARR) throw new Error(`unexpected request: ${url.origin}`)
    if (new Headers(init?.headers).get('x-api-key') !== KEY) return new Response('unauthorized', { status: 401 })
    if (url.pathname === '/api/v1/indexer') return Response.json(fake.indexers)
    const search = url.pathname.match(/^\/(\d+)\/api$/)
    if (search) {
      await fake.hold
      return feed(Number(search[1]), url.searchParams.get('q') ?? '', fake.found)
    }
    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
    searchScheduler.options.minIntervalMs = pacing.search
    usenetScheduler.options.minIntervalMs = pacing.hashes
    clean()
  })
  return fake
}

/** The query of each search request so far, in order. */
const searches = (fake: Fake) =>
  fake.calls.filter(url => /^\/\d+\/api$/.test(url.pathname)).map(url => url.searchParams.get('q') ?? '')
/** Tags searched so far, in order of their first search. */
const searchedTags = (fake: Fake, tags: string[]) => [
  ...new Set(searches(fake).map(query => tags.find(tag => query.includes(tag)) ?? query)),
]
const downloads = (fake: Fake) => fake.calls.filter(url => url.pathname.endsWith('/download'))
const hashLookups = (fake: Fake) => fake.calls.filter(url => url.origin === 'https://feed.animetosho.net')

/** Polls with real timers, so it also ends while `Date.now` is mocked. */
async function until(condition: () => boolean, rounds = 500): Promise<void> {
  for (let round = 0; round < rounds && !condition(); round++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition(), 'the awaited condition never held')
}

/** Lets a sweep that should do nothing get as far as it would. */
async function idle(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise(resolve => setTimeout(resolve, 5))
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { opened: promise, open: () => resolve() }
}

/** Makes `settings` the saved configuration for one test, and puts back what was saved before. */
function storeConfig(t: TestContext, settings: Config): void {
  const files = [CONFIG_FILE, ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE, SCHEDULE_FILE, RESULTS_FILE]
  const saved = files.map(file => (fs.existsSync(file) ? fs.readFileSync(file) : null))
  const schedule = { ...autocheckState }
  for (const file of files) fs.rmSync(file, { force: true })
  saveConfig(settings)
  t.after(() => {
    files.forEach((file, index) => {
      const data = saved[index]
      if (data) fs.writeFileSync(file, data)
      else fs.rmSync(file, { force: true })
    })
    Object.assign(autocheckState, schedule)
  })
}

test('the sweep searches eligible sources in priority order after the hash lookups and never fetches an NZB', async t => {
  const fake = setup(t, { found: new Set(['Missing']) })
  const owned = privateRow('Owned', 'best')
  const upgrade = privateRow('Upgrade', 'upgrade')
  const missing = privateRow('Missing', 'missing')
  const fallback = publicRow('Fallback', 'partial')
  // The same private release listed twice is searched once.
  const duplicate = { ...privateRow('Upgrade', 'upgrade'), key: 'upgrade-again' } as ResultItem
  const tags = ['Owned', 'Upgrade', 'Missing', 'Fallback']
  prefetchUsenetAvailability(
    config({ animetosho_enabled: true }),
    [owned, upgrade, missing, fallback.row, duplicate],
    'test',
  )
  await until(() => searchStore.summary() !== undefined)

  assert.deepEqual(searchedTags(fake, tags), ['Missing', 'Fallback', 'Upgrade', 'Owned'])
  assert.deepEqual(downloads(fake), [], 'no NZB is fetched')
  const firstSearch = fake.calls.findIndex(url => /^\/\d+\/api$/.test(url.pathname))
  assert.ok(
    fake.calls.findLastIndex(url => url.origin === 'https://feed.animetosho.net') < firstSearch,
    'every hash lookup finished before the first search',
  )
  assert.deepEqual(
    hashLookups(fake).map(url => url.searchParams.get('hash')),
    [fallback.hash],
  )
  const summary = searchStore.summary()!
  assert.deepEqual(
    { ...summary, finished_at: '' },
    {
      finished_at: '',
      searched: 4,
      with_candidates: 1,
      without_candidates: 3,
      failed: 0,
      deferred: 0,
      queries: [{ indexer: 'Geek', count: searches(fake).length }],
    },
  )
  assert.ok(Date.parse(summary.finished_at) > 0)
  assert.equal(usenetPrefetchProgress().running, false)

  // A second sweep finds every source fresh: nothing is searched, and the summary stays.
  fake.calls.length = 0
  prefetchUsenetAvailability(config({ animetosho_enabled: true }), [owned, upgrade, missing, fallback.row], 'again')
  await idle()
  assert.deepEqual(searches(fake), [])
  assert.deepEqual(searchStore.summary(), summary)
})

test('the sweep does not search with the setting off, with Torrent only, without SABnzbd or without a Usenet indexer', async t => {
  const fake = setup(t)
  const results = [privateRow('Alpha')]
  for (const settings of [
    config({ prowlarr_background_search: false }),
    config({ download_mode: 'torrent_only' }),
    config({ sabnzbd_url: '' }),
    config({ prowlarr_enabled: false }),
  ]) {
    prefetchUsenetAvailability(settings, results, 'test')
    await idle()
    assert.deepEqual(fake.calls, [], 'not even the indexer list is read')
  }

  fake.indexers = [NZB_SITE]
  prefetchUsenetAvailability(config(), results, 'test')
  await until(() => fake.calls.length > 0)
  await idle()
  assert.deepEqual(
    fake.calls.map(url => url.pathname),
    ['/api/v1/indexer'],
    'the indexer list is read once and shows no Usenet indexer',
  )
  assert.equal(searchStore.summary(), undefined)
  assert.equal(usenetPrefetchProgress().running, false)

  // An indexer list that cannot be read skips the stage as well.
  resetProwlarrRuntime()
  fake.calls.length = 0
  fake.indexers = 'broken' as unknown as unknown[]
  prefetchUsenetAvailability(config(), results, 'test')
  await until(() => fake.calls.length > 0)
  await idle()
  assert.deepEqual(searches(fake), [])
  assert.equal(searchStore.summary(), undefined)
})

test('the sweep runs for private-only releases when both hash indexers are off, and reports the search stage', async t => {
  const hold = gate()
  const fake = setup(t, { hold: hold.opened })
  prefetchUsenetAvailability(config(), [privateRow('Alpha'), privateRow('Beta')], 'test')
  await until(() => searches(fake).length > 0)
  assert.deepEqual(usenetPrefetchProgress(), {
    running: true,
    checked: 0,
    total: 0,
    search: { checked: 0, total: 2 },
  })
  hold.open()
  await until(() => searchStore.summary() !== undefined)
  assert.deepEqual(hashLookups(fake), [])
  assert.deepEqual(searchedTags(fake, ['Alpha', 'Beta']), ['Alpha', 'Beta'])
  assert.equal(searchStore.summary()?.searched, 2)
  assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
})

test('the search stage follows the hash stage in the progress and keeps it complete', async t => {
  const hold = gate()
  const fake = setup(t, { hold: hold.opened })
  const fallback = publicRow('Fallback')
  prefetchUsenetAvailability(config({ animetosho_enabled: true }), [privateRow('Alpha'), fallback.row], 'test')
  await until(() => searches(fake).length > 0)
  assert.deepEqual(usenetPrefetchProgress(), {
    running: true,
    checked: 2,
    total: 2,
    search: { checked: 0, total: 2 },
  })
  hold.open()
  await until(() => searchStore.summary() !== undefined)
})

test('a failed or still-processing hash lookup never starts a search', async t => {
  const processing = publicRow('Processing')
  const failing = publicRow('Failing')
  const absent = publicRow('Absent')
  const fake = setup(t, {
    tosho: hash =>
      hash === processing.hash
        ? Response.json({ id: 123, info_hash: hash, nzb_url: null })
        : hash === failing.hash
          ? new Response('bad request', { status: 400 })
          : new Response('nope', { status: 404 }),
  })
  prefetchUsenetAvailability(config({ animetosho_enabled: true }), [processing.row, failing.row, absent.row], 'test')
  await until(() => searchStore.summary() !== undefined)
  assert.equal(hashLookups(fake).length, 3)
  assert.deepEqual(searchedTags(fake, ['Processing', 'Failing', 'Absent']), ['Absent'])
  assert.equal(searchStore.summary()?.searched, 1)
})

test('the sweep stops at the search limit, counts the rest as deferred, and goes on once usage ages out', async t => {
  let now = Date.UTC(2026, 10, 27, 12)
  t.mock.method(Date, 'now', () => now)
  const tags = ['Alpha', 'Beta', 'Gamma']
  const fake = setup(t, { found: new Set(tags) })
  const results = tags.map(tag => privateRow(tag))
  const limited = config({ prowlarr_search_limit: 2 })
  prefetchUsenetAvailability(limited, results, 'test')
  await until(() => searchStore.summary() !== undefined)
  assert.deepEqual(searchedTags(fake, tags), ['Alpha', 'Beta'])
  assert.equal(searches(fake).length, 2, 'a strong candidate ends each search after one query')
  const first = searchStore.summary()!
  assert.deepEqual(
    { ...first, finished_at: '' },
    {
      finished_at: '',
      searched: 2,
      with_candidates: 2,
      without_candidates: 0,
      failed: 0,
      deferred: 1,
      queries: [{ indexer: 'Geek', count: 2 }],
    },
  )

  // Still within the 24 hours: the remaining source stays deferred and nothing is asked.
  now += HOUR
  prefetchUsenetAvailability(limited, results, 'test')
  await until(() => searchStore.summary()?.finished_at !== first.finished_at)
  assert.equal(searches(fake).length, 2)
  assert.deepEqual(
    { ...searchStore.summary()!, finished_at: '' },
    {
      finished_at: '',
      searched: 0,
      with_candidates: 0,
      without_candidates: 0,
      failed: 0,
      deferred: 1,
      queries: [],
    },
  )

  now += 25 * HOUR
  resetProwlarrRuntime()
  prefetchUsenetAvailability(limited, results, 'test')
  await until(() => searchStore.summary()?.searched === 1)
  assert.deepEqual(searchedTags(fake, tags), tags)
  assert.equal(searchStore.summary()?.deferred, 0)
})

test('a superseded sweep stops reporting progress, searches nothing more and writes no summary', async t => {
  const fake = setup(t, { found: new Set(['Alpha']) })
  for (const supersede of [() => stopUsenetPrefetch(), () => prefetchUsenetAvailability(config(), [], 'replaced')]) {
    const hold = gate()
    fake.hold = hold.opened
    fake.calls.length = 0
    resetUsenetSearch()
    prefetchUsenetAvailability(config(), [privateRow('Alpha'), privateRow('Beta')], 'test')
    await until(() => searches(fake).length > 0)
    assert.ok(usenetPrefetchProgress().search)
    supersede()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    hold.open()
    await idle()
    assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
    assert.deepEqual(searchedTags(fake, ['Alpha', 'Beta']), ['Alpha'])
    assert.equal(searchStore.summary(), undefined)
  }
})

/** Calls the search-status route as the browser does, and returns what it answered. */
async function searchStatusRoute(): Promise<{ status: number; text: string }> {
  const answer = { status: 0, text: '' }
  const response = {
    writeHead: (status: number) => {
      answer.status = status
    },
    end: (data: Buffer) => {
      answer.text = data.toString('utf8')
    },
  } as unknown as ServerResponse
  const url = new URL('http://companion.test/api/prowlarr/search-status')
  const match = matchRoute(downloadRoutes, 'GET', url.pathname)!
  assert.equal(match.route.access, 'session', 'the route needs a session like the other Prowlarr routes')
  await match.route.handle({ request: {} as never, response, url, params: [] })
  return answer
}

test('the search status reports eligible and pending sources and the latest summary, with no key or link', async t => {
  const fake = setup(t, { found: new Set(['Alpha']) })
  const searched = [privateRow('Alpha'), privateRow('Beta')]
  const fallback = publicRow('Fallback')
  const unknownHash = publicRow('Unknown')
  storeConfig(t, config({ animetosho_enabled: true }))
  prefetchUsenetAvailability(loadConfig(), searched, 'test')
  await until(() => searchStore.summary() !== undefined)
  const summary = searchStore.summary()!

  // Gamma was never searched; the fallback's hash lookup answered "no NZB"; the other hash was never looked up.
  prefetchUsenetAvailability(
    config({ animetosho_enabled: true, prowlarr_background_search: false }),
    [...searched, fallback.row],
    'hashes',
  )
  await until(() => hashLookups(fake).length === 1 && !usenetPrefetchProgress().running)
  const results = [...searched, privateRow('Gamma'), fallback.row, unknownHash.row]
  setState({ results })
  t.after(() => setState({ results: [] }))
  fake.calls.length = 0

  const answer = await searchStatusRoute()
  assert.equal(answer.status, 200)
  const body = JSON.parse(answer.text) as { ok: boolean; status: ProwlarrSearchStatus }
  assert.deepEqual(body, {
    ok: true,
    status: { eligible_sources: 4, pending_sources: 2, usenet_indexers: 1, summary },
  })
  assert.deepEqual(fake.calls, [], 'the route contacts nobody')
  for (const secret of [KEY, 'apikey', 'http', 'download', 'link'])
    assert.ok(!answer.text.includes(secret), `the response carries no ${secret}`)

  // The setting is not required for the counts; Prowlarr switched off reports nothing.
  assert.equal(
    usenetSearchStatus(config({ prowlarr_background_search: false, animetosho_enabled: true }), results)
      .eligible_sources,
    4,
  )
  assert.deepEqual(usenetSearchStatus(config({ prowlarr_enabled: false }), results), {
    eligible_sources: 0,
    pending_sources: 0,
    usenet_indexers: 0,
  })
  // An indexer list that is not known counts no indexer and is not waited for.
  resetProwlarrRuntime()
  assert.equal(usenetSearchStatus(config(), results).usenet_indexers, 0)
})

test('pruning drops search records no result references and keeps those an active download still needs', async t => {
  setup(t)
  const cleanLedger = () => {
    for (const file of [LEDGER_FILE, `${LEDGER_FILE}.tmp`]) fs.rmSync(file, { force: true })
    resetOwnedRuntime()
  }
  cleanLedger()
  t.after(cleanLedger)
  const [kept, gone, downloading, imported, fallback] = ['Kept', 'Gone', 'Downloading', 'Done', 'Fallback'].map(show)
  const hash = nextHash()
  const publicSource = { id: hash, files: fallback.files }
  for (const source of [kept, gone, downloading, imported, publicSource])
    await searchSource(config(), source, { titles: ['Show'], releaseGroup: 'Vault' })
  const record = (source: PrivateSource) => searchStore.get(FINGERPRINT, source.id)
  assert.ok([kept, gone, downloading, imported, publicSource].every(source => record(source)))

  const usenet = (source: PrivateSource) =>
    addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'http://sab.test:8080',
      state: 'accepted',
      source_hash: source.id,
      category: 'tv',
      provider: 'prowlarr',
    })
  usenet(downloading)
  setDownloadPhase(usenet(imported).id, 'complete')

  const results = [privateRow('Kept'), publicRow('Fallback', 'missing', hash).row]
  // Pruning runs even when the sweep itself is not eligible, and never with empty results.
  prefetchUsenetAvailability(config({ download_mode: 'torrent_only' }), [], 'empty')
  assert.ok(record(gone), 'empty results prune nothing')
  prefetchUsenetAvailability(config({ download_mode: 'torrent_only' }), results, 'prune')
  assert.ok(record(kept), 'a source the results reference is kept')
  assert.ok(record(publicSource), 'a hash the results reference is kept')
  assert.ok(record(downloading), 'a source an active download names is kept')
  assert.equal(record(gone), undefined)
  assert.equal(record(imported), undefined, 'a finished download no longer holds its record')
})

test('switching the background search on and off through the settings starts and stops the sweep', async t => {
  const hold = gate()
  const fake = setup(t, { hold: hold.opened, found: new Set(['Alpha']) })
  storeConfig(t, config({ prowlarr_background_search: false }))
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: [privateRow('Alpha'), privateRow('Beta')], last_run: null }))

  saveSettings({ notify_enabled: !DEFAULT_CONFIG.notify_enabled })
  await idle()
  assert.deepEqual(fake.calls, [], 'an unrelated setting starts nothing')

  saveSettings({ prowlarr_background_search: true })
  await until(() => searches(fake).length > 0)
  assert.deepEqual(usenetPrefetchProgress().search, { checked: 0, total: 2 })

  saveSettings({ prowlarr_background_search: false })
  assert.deepEqual(usenetPrefetchProgress(), { running: false, checked: 0, total: 0 })
  hold.open()
  await idle()
  assert.deepEqual(searchedTags(fake, ['Alpha', 'Beta']), ['Alpha'], 'the stopped sweep searches nothing more')
  assert.equal(searchStore.summary(), undefined)

  saveSettings({ prowlarr_background_search: true })
  await until(() => searchStore.summary() !== undefined)
  assert.deepEqual(searchedTags(fake, ['Alpha', 'Beta']), ['Alpha', 'Beta'])
})
