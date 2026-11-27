// The Prowlarr file-list search: the query ladder and candidate ranking, the search stage, the verify stage, and
// what availability, review and submission read from the store. Prowlarr and its indexers are a fake `fetch`
// that records every request; records and NZBs live in the shared temp DATA_DIR (tests/run-tests.mjs).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DEFAULT_CONFIG } from '../server/config.js'
import { NZB_STORE_DIR, USENET_SEARCH_FILE } from '../server/paths.js'
import { prowlarrFingerprint, resetProwlarrRuntime } from '../server/prowlarr.js'
import { filesSourceId, type SourceFile } from '../server/source-files.js'
import type { Config, PrivateSource } from '../server/types.js'
import { resetUsenetLookups, resolveUsenetHash, usenetScheduler } from '../server/usenet.js'
import { LookupScheduler, ProviderPausedError } from '../server/usenet-scheduler.js'
import { searchRecordState } from '../server/usenet-search-state.js'
import type { SearchRecord, StoredCandidate, StoredCheck } from '../server/usenet-search-store.js'
import {
  cancelSourceCheck,
  chosenSearchCandidate,
  flushUsenetSearch,
  invalidateUsenetSearch,
  prowlarrIndexerUsage,
  rejectSearchCandidate,
  resetUsenetSearch,
  resolveSource,
  retainSearchSources,
  searchNzbBytes,
  searchScheduler,
  searchSnapshot,
  searchSource,
  searchStore,
  usenetSearchPauses,
  verifySource,
} from '../server/usenet-search.js'
import {
  candidateEntryId,
  commonTokens,
  groupMatches,
  isPlausible,
  isStrong,
  nameCoverage,
  orderTitles,
  queryLadder,
  rankCandidates,
  searchTokens,
  sourceFacts,
} from '../server/usenet-search-terms.js'

const PROWLARR = 'http://prowlarr-search.test:9696'
const KEY = 'prowlarr-key-5c1d'
const FINGERPRINT = prowlarrFingerprint({ baseUrl: PROWLARR, apiKey: KEY })
const GEEK = { id: 2, name: 'Geek', protocol: 'usenet', privacy: 'private', enable: true }
const SLUG = { id: 5, name: 'Slug', protocol: 'usenet', privacy: 'private', enable: true }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** The overhead measured on AnimeTosho's own posts. */
const OVERHEAD = 1.031
const SIZES = [1_512_345_678, 1_398_765_432, 1_287_654_321]

/** A three-episode release of the group Vault; the tag is its title. */
function release(tag: string, group = '[Vault] '): PrivateSource {
  const files = SIZES.map((length, index) => ({ name: `${group}${tag} - 0${index + 1} (BD 1080p).mkv`, length }))
  return { id: filesSourceId(files), files }
}

const SOURCE = release('Show')
const EPISODES = SOURCE.files
const TOTAL = SIZES.reduce((sum, size) => sum + size, 0)
const TERMS = { titles: ['Show'], releaseGroup: 'Vault' }
const terms = (tag: string) => ({ titles: [tag], releaseGroup: 'Vault' })

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    tracker_mode: 'private',
    prowlarr_enabled: true,
    prowlarr_url: PROWLARR,
    prowlarr_key: KEY,
    ...overrides,
  }
}

// --- NZB fixtures -------------------------------------------------------------------

interface Posted {
  subject: string
  segments: number[]
}

function nzb(files: Posted[]) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const body = files
    .map((file, index) => {
      const segments = file.segments
        .map((bytes, part) => `<segment bytes="${bytes}" number="${part + 1}">${index}.${part}@test</segment>`)
        .join('')
      return `<file poster="p@test" date="1700000000" subject="${escape(file.subject)}"><groups><group>alt.binaries.test</group></groups><segments>${segments}</segments></file>`
    })
    .join('')
  return new TextEncoder().encode(`<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${body}</nzb>`)
}

/** Three segments that add up to what a file of this size takes on Usenet. */
function segments(length: number, ratio = OVERHEAD): number[] {
  const total = Math.round(length * ratio)
  const part = Math.floor(total / 3)
  return [part, part, total - 2 * part]
}

/** The name and the decoded size, as Nyuu writes subjects. */
const stated = (file: SourceFile): Posted => ({
  subject: `"${file.name}" yEnc (1/3) ${file.length}`,
  segments: segments(file.length),
})
/** The name without a size. */
const named = (file: SourceFile): Posted => ({ subject: `"${file.name}" yEnc (1/3)`, segments: segments(file.length) })
/** A random name, with the size of the file. */
const obfuscated = (file: SourceFile, index: number): Posted => ({
  subject: `"${((index + 1) * 0x9e3779b1).toString(16)}" yEnc (1/3)`,
  segments: segments(file.length),
})

const EXACT_NZB = nzb(EPISODES.map(stated))
const NEAR_EXACT_NZB = nzb(EPISODES.map(named))
const PROBABLE_NZB = nzb(EPISODES.map(obfuscated))
/** One archive in three equal parts: only the total can be compared. */
const SIZE_ONLY_NZB = nzb(
  [1, 2, 3].map(part => ({
    subject: `"8f1c2e7a.part0${part}.rar" yEnc (1/3)`,
    segments: segments(Math.ceil(TOTAL / 3)),
  })),
)
/** Another release of the show, at about half the size. */
const OTHER_NZB = nzb(
  EPISODES.map((file, index) => stated({ name: `[Other] Show - 0${index + 1} (720p).mkv`, length: file.length >> 1 })),
)

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// --- Fake Prowlarr ------------------------------------------------------------------

interface Post {
  title: string
  /** Stands for Prowlarr's encrypted download link, and names the post. */
  link: string
  /** Size the indexer reports, as a multiple of the listed total; left out when it reports none. */
  size?: number
  files?: number
  grabs?: number
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A Newznab answer of one indexer, as Prowlarr writes it. Prowlarr names its own host as it sees itself. */
function feed(indexerId: number, posts: Post[] = []): Response {
  const attr = (name: string, value: number | undefined) =>
    value === undefined ? '' : `<newznab:attr name="${name}" value="${value}" />`
  const items = posts.map(post => {
    const proxy = escapeXml(
      `http://localhost:9696/${indexerId}/download?${new URLSearchParams({ apikey: KEY, link: post.link, file: post.title })}`,
    )
    const page = `https://indexer${indexerId}.test/details/${post.link}`
    return [
      `<item><title>${escapeXml(post.title)}</title><guid>${page}</guid><comments>${page}#comments</comments>`,
      `<pubDate>Tue, 24 Nov 2026 18:03:11 +0100</pubDate><link>${proxy}</link>`,
      `<enclosure url="${proxy}" type="application/x-nzb" />`,
      attr('size', post.size === undefined ? undefined : Math.round(TOTAL * post.size)),
      attr('files', post.files),
      attr('grabs', post.grabs),
      '</item>',
    ].join('')
  })
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Prowlarr</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/rss+xml' } },
  )
}

const newznabError = (code: number, init: ResponseInit = {}) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="Limit reached" />`, init)

interface Fake {
  /** Every request, in order. */
  calls: { url: URL; headers: Headers }[]
  indexers: unknown[]
  search: (indexerId: number, query: URLSearchParams) => Response | Promise<Response>
  download: (indexerId: number, link: string) => Response | Promise<Response>
  /** Anything that is not Prowlarr: an indexer after a redirect, or a hash indexer. */
  elsewhere: (url: URL) => Response | Promise<Response>
}

/**
 * Resets the finder, its store files, both schedulers' pacing and the Prowlarr client, and routes `fetch` to a
 * fake Prowlarr. Everything is put back when the test ends.
 */
function setup(t: TestContext, overrides: Partial<Fake> = {}): Fake {
  const original = globalThis.fetch
  const pacing = { ...searchScheduler.options }
  const clean = () => {
    resetUsenetSearch()
    resetProwlarrRuntime()
    fs.rmSync(USENET_SEARCH_FILE, { force: true })
    fs.rmSync(NZB_STORE_DIR, { recursive: true, force: true })
  }
  clean()
  searchScheduler.options.minIntervalMs = 0
  const fake: Fake = {
    calls: [],
    indexers: [GEEK],
    search: indexerId => feed(indexerId),
    download: () => new Response('gone', { status: 404 }),
    elsewhere: () => new Response('not found', { status: 404 }),
    ...overrides,
  }
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    fake.calls.push({ url, headers })
    if (url.origin !== PROWLARR) return await fake.elsewhere(url)
    if (headers.get('x-api-key') !== KEY) return new Response('unauthorized', { status: 401 })
    if (url.pathname === '/api/v1/indexer') return Response.json(fake.indexers)
    const search = url.pathname.match(/^\/(\d+)\/api$/)
    if (search) return await fake.search(Number(search[1]), url.searchParams)
    const download = url.pathname.match(/^\/(\d+)\/download$/)
    if (download) return await fake.download(Number(download[1]), url.searchParams.get('link') ?? '')
    throw new Error(`unexpected request: ${url.pathname}`)
  }
  t.after(() => {
    globalThis.fetch = original
    Object.assign(searchScheduler.options, pacing)
    clean()
  })
  return fake
}

/** Search requests so far, optionally of one indexer. */
const searches = (fake: Fake, indexerId?: number) =>
  fake.calls
    .filter(call => (indexerId ? call.url.pathname === `/${indexerId}/api` : /^\/\d+\/api$/.test(call.url.pathname)))
    .map(call => call.url.searchParams)
/** Links of the NZBs fetched through Prowlarr so far. */
const downloads = (fake: Fake) =>
  fake.calls.filter(call => /^\/\d+\/download$/.test(call.url.pathname)).map(call => call.url.searchParams.get('link'))

const record = (source = SOURCE) => searchStore.get(FINGERPRINT, source.id)
const entryOf = (link: string, indexerId = 2) =>
  candidateEntryId(indexerId, `https://indexer${indexerId}.test/details/${link}`)

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !condition(); turn++) await nextTurn()
  assert.ok(condition(), 'the awaited condition never held')
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { opened: promise, open: () => resolve() }
}

// --- Query ladder -------------------------------------------------------------------

test('file names give the common tokens: lower case, no diacritics, no episode numbers, no extras', () => {
  assert.deepEqual(searchTokens("[Vault] Hero's Café & Re:Zero – 01_v2.mkv"), [
    'vault',
    'heros',
    'cafe',
    'and',
    're',
    'zero',
    '01',
    'v2',
    'mkv',
  ])
  assert.deepEqual(commonTokens(EPISODES), ['vault', 'show', 'bd', '1080p'])
  // Files in folders named like extras, and files that are no video, say nothing about the release's name.
  const withExtras = [
    ...EPISODES.map(file => ({ ...file, name: `[Vault] Show (BD 1080p)/${file.name}` })),
    { name: '[Vault] Show (BD 1080p)/Extras/Clean Opening.mkv', length: 90_000_000 },
    { name: '[Vault] Show (BD 1080p)\\NC\\Menu 01.mkv', length: 5_000_000 },
    { name: '[Vault] Show (BD 1080p)/Scans/Booklet.mkv', length: 5_000_000 },
    { name: '[Vault] Show (BD 1080p)/cover.jpg', length: 400_000 },
  ]
  assert.deepEqual(commonTokens(withExtras), ['vault', 'show', 'bd', '1080p'])
  // A release that is itself a folder of specials is described by its own files.
  assert.deepEqual(
    commonTokens([
      { name: 'Specials/[Vault] Show - SP1.mkv', length: 1 },
      { name: 'Specials/[Vault] Show - SP2.mkv', length: 1 },
    ]),
    ['vault', 'show'],
  )
  assert.deepEqual(commonTokens([{ name: 'BDMV/STREAM/00001.m2ts', length: 1 }]), [])
  assert.deepEqual(commonTokens([]), [])
})

test('titles the file names spell out come first, whichever place they had', () => {
  const common = commonTokens(EPISODES)
  assert.deepEqual(
    orderTitles(
      ['Banished From the Hero’s Party', 'Shin no Nakama', 'Third', 'Fourth', 'Fifth', 'The Show', 'show', 'BD Show'],
      common,
    ),
    ['Show', 'BD Show', 'Banished From the Heros Party', 'Shin no Nakama', 'Third', 'Fourth', 'Fifth'],
  )
  // Nothing fits: the order stays.
  assert.deepEqual(orderTitles(['One', 'Two'], common), ['One', 'Two'])
  // A title with an apostrophe or an ampersand fits file names that spell it either way.
  const files = [1, 2].map(episode => ({ name: `[Vault] Hero's Party & Friends - 0${episode}.mkv`, length: 1 }))
  assert.deepEqual(orderTitles(['Other', "Hero's Party and Friends"], commonTokens(files)), [
    'Heros Party and Friends',
    'Other',
  ])
})

test('the ladder asks by group first when the file names carry it, and by title and size first when they do not', () => {
  const window = { minSize: TOTAL * 0.97, maxSize: TOTAL * 1.35 }
  const titles = ['Other Name', 'Show', 'Third', 'Fourth', 'Fifth']
  assert.deepEqual(queryLadder(EPISODES, { titles, releaseGroup: '-Vault-' }), [
    { q: 'Vault Show' },
    { q: 'Show', ...window },
    { q: 'Vault Other Name' },
    { q: 'Vault Third' },
  ])
  // The file names do not name the group: a post of them is found by its title and size only.
  const anonymous = release('Show', '').files
  assert.deepEqual(queryLadder(anonymous, { titles, releaseGroup: 'Vault' }), [
    { q: 'Show', ...window },
    { q: 'Vault Show' },
    { q: 'Vault Other Name' },
    { q: 'Vault Third' },
  ])
  // Without a group every query is a title within the size window; without a title the group is.
  assert.deepEqual(queryLadder(EPISODES, { titles, releaseGroup: '' }), [
    { q: 'Show', ...window },
    { q: 'Other Name', ...window },
    { q: 'Third', ...window },
  ])
  assert.deepEqual(queryLadder(EPISODES, { titles: [], releaseGroup: 'Vault' }), [{ q: 'Vault', ...window }])
  assert.deepEqual(queryLadder(EPISODES, { titles: [], releaseGroup: '' }), [])
  // One title gives two queries, and the same query is never sent twice.
  assert.deepEqual(queryLadder(EPISODES, { titles: ['Show', 'show'], releaseGroup: 'Vault' }), [
    { q: 'Vault Show' },
    { q: 'Show', ...window },
  ])
})

// --- Candidates ---------------------------------------------------------------------

test('a release group matches whole tokens only', () => {
  assert.equal(groupMatches('-ZR-', '[ZR] Show'), true)
  assert.equal(groupMatches('-ZR-', 'Show.Remux-ZR'), true)
  assert.equal(groupMatches('ZR', 'Dragon Ball Z Remastered'), false)
  assert.equal(groupMatches('sam', 'Samurai Champloo'), false)
  assert.equal(groupMatches('sam', '[sam] Samurai Champloo'), true)
  // A group of several words, as consecutive tokens or written as one.
  assert.equal(groupMatches('Kawaiika-Raws', '[Kawaiika-Raws] Show'), true)
  assert.equal(groupMatches('Kawaiika-Raws', 'Show.1080p.KawaiikaRaws'), true)
  assert.equal(groupMatches('Kawaiika-Raws', '[Kawaiika] Show Raws'), false)
  assert.equal(groupMatches('D-Z0N3', 'Show [D Z0N3]'), true)
  assert.equal(groupMatches('', 'Show'), false)
  assert.equal(groupMatches('--', 'Show'), false)
})

test('a candidate is plausible by group or by name, within the size a post can have, and strong when its size fits', () => {
  const facts = sourceFacts(EPISODES, 'Vault')
  assert.deepEqual(facts, { group: 'Vault', common: ['vault', 'show', 'bd', '1080p'], total: TOTAL, fileCount: 3 })
  const listing = (title: string, size: number | null) => ({
    title,
    size: size === null ? null : Math.round(TOTAL * size),
  })

  assert.equal(nameCoverage(facts.common, 'Show.BD.1080p.x265'), 0.75)
  assert.equal(nameCoverage([], 'Show'), 0)
  assert.equal(isPlausible(listing('[Vault] Something', null), facts), true, 'the group, size unknown')
  assert.equal(isPlausible(listing('Show.BD.1080p', null), facts), true, 'three of four common tokens')
  assert.equal(isPlausible(listing('Show.720p', null), facts), false, 'one of four common tokens')
  assert.equal(isPlausible(listing('[Vault] Show', 0.969), facts), false)
  assert.equal(isPlausible(listing('[Vault] Show', 0.971), facts), true)
  assert.equal(isPlausible(listing('[Vault] Show', 1.349), facts), true)
  assert.equal(isPlausible(listing('[Vault] Show', 1.351), facts), false)

  assert.equal(isStrong(listing('[Vault] Show', null), facts), false, 'an unknown size is never strong')
  assert.equal(isStrong(listing('[Vault] Show', 0.99), facts), false)
  assert.equal(isStrong(listing('[Vault] Show', 1.001), facts), true)
  assert.equal(isStrong(listing('Show.BD.1080p', 1.249), facts), true, 'a strong candidate need not name the group')
  assert.equal(isStrong(listing('[Vault] Show', 1.251), facts), false)
  assert.equal(isStrong(listing('Show.720p', 1.08), facts), false)
})

test('candidates rank by group, then name coverage, then size, and file and grab counts only break ties', () => {
  const facts = sourceFacts(EPISODES, 'Vault')
  const size = (factor: number) => Math.round(TOTAL * factor)
  const ranked = rankCandidates(
    [
      { title: 'Show.BD.1080p', size: size(1.08) },
      { title: '[Vault] Show', size: size(1.2) },
      { title: '[Vault] Show', size: null },
      { title: '[Vault] Show BD 1080p', size: size(1.3) },
      { title: '[Vault] Show', size: size(1.1), files: 2, grabs: 9 },
      { title: '[Vault] Show', size: size(1.1), files: 40 },
      { title: '[Vault] Show', size: size(1.1), files: 40, grabs: 1 },
      { title: '[Vault] Show', size: size(1.07) },
    ],
    facts,
  )
  assert.deepEqual(
    ranked.map(listing => [
      listing.title,
      listing.size === null ? null : listing.size / TOTAL,
      listing.files,
      listing.grabs,
    ]),
    [
      ['[Vault] Show BD 1080p', size(1.3) / TOTAL, undefined, undefined],
      ['[Vault] Show', size(1.07) / TOTAL, undefined, undefined],
      ['[Vault] Show', size(1.1) / TOTAL, 40, 1],
      ['[Vault] Show', size(1.1) / TOTAL, 40, undefined],
      // A file count below the number of listed files ranks last among equals, and is never left out.
      ['[Vault] Show', size(1.1) / TOTAL, 2, 9],
      ['[Vault] Show', size(1.2) / TOTAL, undefined, undefined],
      ['[Vault] Show', null, undefined, undefined],
      ['Show.BD.1080p', size(1.08) / TOTAL, undefined, undefined],
    ],
  )
  assert.equal(
    candidateEntryId(7, 'https://indexer.test/details/abc'),
    `7-${createHash('sha1').update('https://indexer.test/details/abc').digest('hex').slice(0, 20)}`,
  )
})

// --- Record states ------------------------------------------------------------------

const AT = Date.UTC(2026, 10, 26, 12)

function stored(indexerId: number, digit: string, overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    entry_id: `${indexerId}-${digit.repeat(20)}`,
    indexer_id: indexerId,
    indexer: indexerId === 2 ? 'Geek' : 'Slug',
    title: '[Vault] Show',
    size: Math.round(TOTAL * 1.08),
    download: { link: `link-${digit}`, file: 'Show' },
    ...overrides,
  }
}

function graded(proof: StoredCheck['proof'], at = AT): StoredCheck {
  return {
    at,
    proof,
    files_matched: 3,
    names_matched: 3,
    files_expected: 3,
    sizes_known: true,
    nzb_sha256: 'a'.repeat(64),
  }
}

function searched(candidates: StoredCandidate[], overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    source_id: SOURCE.id,
    fingerprint: FINGERPRINT,
    searched_at: AT,
    last_attempt_at: AT,
    retry_at: 0,
    indexers: [{ id: 2, name: 'Geek', answered: true, at: AT }],
    candidates,
    ...overrides,
  }
}

test('a record gives the state and freshness of its source', () => {
  const state = (entry: SearchRecord | undefined, after = 0) => searchRecordState(entry, AT + after, [GEEK])
  assert.deepEqual(state(undefined), { state: 'not_checked', fresh_until: 0, stale: true, ask: [2] })

  // A proven candidate: available for 30 days, whatever else was found.
  const exact = stored(2, 'a', { check: graded('exact') })
  const proven = searched([stored(2, 'b', { check: graded('unverified') }), exact, stored(2, 'c')])
  assert.deepEqual(state(proven), {
    state: 'available',
    entry_id: exact.entry_id,
    proof: 'exact',
    fresh_until: AT + 30 * DAY,
    stale: false,
    ask: [],
  })
  assert.ok(!JSON.stringify(state(proven)).includes('link'), 'a state names a candidate without its reference')
  assert.equal(state(searched([stored(2, 'a', { check: graded('near_exact') })])).proof, 'near_exact')
  assert.equal(state(proven, 30 * DAY - 1).stale, false)
  assert.deepEqual(state(proven, 30 * DAY).ask, [2])
  assert.equal(state(proven, 30 * DAY).state, 'available', 'an aged result is still what is known')

  // Candidates nobody opened: unverified for 7 days.
  const unverified = state(searched([stored(2, 'a'), stored(2, 'b')]))
  assert.deepEqual(unverified, { state: 'unverified', fresh_until: AT + 7 * DAY, stale: false, ask: [] })

  // One graded without a proof: no match, also while others are unchecked.
  for (const proof of ['probable', 'size_only', 'unverified'] as const)
    assert.equal(state(searched([stored(2, 'a', { check: graded(proof) }), stored(2, 'b')])).state, 'no_match', proof)
  const checkedLater = searched([stored(2, 'a', { check: graded('probable', AT + DAY) })])
  assert.equal(state(checkedLater).fresh_until, AT + 8 * DAY, 'a check renews the 7 days')

  // A rejected candidate is no match, whatever its NZB showed.
  const rejected = stored(2, 'd', { check: graded('near_exact'), rejected: { at: AT, reason: 'import_mismatch' } })
  assert.equal(state(searched([rejected, stored(2, 'b')])).state, 'no_match')
  assert.equal(state(searched([rejected, stored(2, 'b')])).entry_id, undefined)
  assert.equal(state(searched([rejected, exact])).state, 'available')
  assert.equal(state(searched([rejected, exact])).entry_id, exact.entry_id)
})

test('a failed fetch or a silent indexer is a failed lookup until its retry time, never an absence', () => {
  const state = (entry: SearchRecord, after = 0, enabled = [GEEK, SLUG]) =>
    searchRecordState(entry, AT + after, enabled)
  const both = [
    { id: 2, name: 'Geek', answered: true, at: AT },
    { id: 5, name: 'Slug', answered: true, at: AT },
  ]
  const unavailable = (code: 'rate_limited' | 'invalid_response', retry_at: number): StoredCheck => ({
    ...graded('unverified'),
    files_matched: 0,
    names_matched: 0,
    nzb_sha256: undefined,
    unavailable: { code, retry_at },
  })

  // The indexer refused the fetch: failed until the retry time, then unchecked again.
  const refused = searched([stored(2, 'a', { check: unavailable('rate_limited', AT + HOUR) }), stored(5, 'b')], {
    indexers: both,
  })
  assert.deepEqual(state(refused).failed, { indexer_id: 2, indexer: 'Geek', code: 'rate_limited', retry_at: AT + HOUR })
  assert.equal(state(refused).state, 'lookup_failed')
  assert.equal(state(refused, HOUR).state, 'unverified')
  // Another candidate that is proven outranks it; one that is merely graded does not.
  const beside = (proof: StoredCheck['proof']) =>
    searched(
      [stored(2, 'a', { check: unavailable('rate_limited', AT + HOUR) }), stored(5, 'b', { check: graded(proof) })],
      {
        indexers: both,
      },
    )
  assert.equal(state(beside('exact')).state, 'available')
  assert.equal(state(beside('probable')).state, 'lookup_failed')
  // A body that is no NZB is the post's fault: it counts as checked.
  assert.equal(
    state(searched([stored(2, 'a', { check: unavailable('invalid_response', AT + DAY) })])).state,
    'no_match',
  )

  // No candidate and an indexer that did not answer: failed, naming it, until the retry time.
  const silent = searched([], {
    retry_at: AT + HOUR,
    indexers: [both[0], { id: 5, name: 'Slug', answered: false, at: AT }],
  })
  assert.deepEqual(state(silent), {
    state: 'lookup_failed',
    failed: { indexer_id: 5, indexer: 'Slug', retry_at: AT + HOUR },
    fresh_until: AT + HOUR,
    stale: false,
    ask: [],
  })
  assert.deepEqual(state(silent, HOUR).ask, [5], 'only the silent indexer is asked again')
  assert.equal(state(silent, HOUR).stale, true)
  // A retry is never due sooner than a minute after the attempt.
  const soon = { ...silent, retry_at: 0 }
  assert.equal(state(soon, MINUTE - 1).stale, false)
  assert.equal(state(soon, MINUTE).stale, true)
  // With candidates from the other indexer the source is not failed, but the silent indexer is still owed.
  const partial = { ...silent, candidates: [stored(2, 'a')] }
  assert.equal(state(partial).state, 'unverified')
  assert.deepEqual([state(partial, HOUR).stale, state(partial, HOUR).ask], [true, [5]])

  // An indexer that is new in Prowlarr makes the record stale at once, and only it is asked.
  const before = searched([stored(2, 'a')])
  assert.deepEqual([state(before).stale, state(before).ask], [true, [5]])
  assert.deepEqual([state(before, 0, [GEEK]).stale, state(before, 0, [GEEK]).ask], [false, []])
  // An indexer that left Prowlarr is no longer waited for.
  assert.equal(state(silent, 0, [GEEK]).state, 'no_match')
})

test('an absence stays fresh for 1, 3, 7 and then 30 days as it repeats', () => {
  const fresh = (negative_streak: number | undefined) =>
    (searchRecordState(searched([], negative_streak ? { negative_streak } : {}), AT, [GEEK]).fresh_until - AT) / DAY
  assert.deepEqual([undefined, 1, 2, 3, 4, 5, 40].map(fresh), [1, 1, 3, 7, 30, 30, 30])
  const absent = searchRecordState(searched([], { negative_streak: 2 }), AT + 3 * DAY, [GEEK])
  assert.deepEqual(absent, { state: 'no_match', fresh_until: AT + 3 * DAY, stale: true, ask: [2] })
  // Nothing was ever asked: that is no absence.
  assert.equal(searchRecordState(searched([], { indexers: [] }), AT, [GEEK]).state, 'not_checked')
})

// --- Search stage -------------------------------------------------------------------

test('the first query that finds a strong candidate ends the search, with one query per indexer and no category', async t => {
  const fake = setup(t, {
    indexers: [GEEK, SLUG],
    search: indexerId => feed(indexerId, [{ title: '[Vault] Show (BD 1080p)', link: 'post', size: 1.08, files: 14 }]),
  })
  const found = await searchSource(config(), SOURCE, { titles: ['Other Name', 'Show', 'Third'], releaseGroup: 'Vault' })
  assert.equal(found.availability.state, 'unverified')
  assert.equal(found.availability.candidate_count, 2)
  assert.equal(found.fetched, 0)
  assert.deepEqual(found.queries, [
    { indexer: 'Geek', count: 1 },
    { indexer: 'Slug', count: 1 },
  ])
  for (const indexerId of [2, 5])
    assert.deepEqual(Object.fromEntries(searches(fake, indexerId)[0]), {
      t: 'search',
      q: 'Vault Show',
      limit: '100',
      extended: '1',
    })
  assert.equal(searches(fake).length, 2)
  assert.deepEqual(downloads(fake), [], 'a search never fetches an NZB')

  // Without a strong candidate every rung is sent, and still no request names a category.
  fake.search = indexerId => feed(indexerId, [{ title: '[Vault] Show (BD 1080p)', link: 'post' }])
  fake.calls.length = 0
  await searchSource(
    config(),
    SOURCE,
    { titles: ['Other Name', 'Show', 'Third', 'Fourth'], releaseGroup: 'Vault' },
    {
      refresh: true,
    },
  )
  assert.deepEqual(
    searches(fake, 2).map(query => query.get('q')),
    ['Vault Show', 'Show', 'Vault Other Name', 'Vault Third'],
  )
  assert.equal(searches(fake, 5).length, 4)
  for (const { url } of fake.calls) {
    assert.equal(url.searchParams.has('cat'), false)
    assert.equal(url.searchParams.has('categories'), false)
    assert.ok(!url.href.includes(KEY), 'the key travels in a header only')
  }
})

test('a release whose file names lack the group is found by the title alone, within its size', async t => {
  const anonymous = release('Show', '')
  const fake = setup(t, {
    search: (indexerId, query) =>
      feed(indexerId, query.get('q') === 'Show' ? [{ title: 'Show.BD.1080p.x265', link: 'post', size: 1.1 }] : []),
  })
  const found = await searchSource(config(), anonymous, TERMS)
  assert.equal(found.availability.state, 'unverified')
  assert.equal(found.availability.candidates?.[0].title, 'Show.BD.1080p.x265')
  const [only, ...more] = searches(fake)
  assert.deepEqual(more, [])
  assert.deepEqual(
    [only.get('q'), only.get('minsize'), only.get('maxsize')],
    ['Show', String(Math.floor(TOTAL * 0.97)), String(Math.ceil(TOTAL * 1.35))],
  )
})

test('search results become ranked candidates that never show their download reference', async t => {
  const fake = setup(t, {
    search: indexerId =>
      feed(indexerId, [
        { title: 'Show 720p', link: 'small', size: 0.5 },
        { title: '[Vault] Show <b>v2</b>', link: 'second', size: 1.2, files: 14, grabs: 3 },
        { title: 'Unrelated', link: 'unrelated', size: 1.08 },
        { title: '[Vault] Show (BD 1080p)', link: 'first', size: 1.08, files: 14 },
      ]),
  })
  const found = await searchSource(config(), SOURCE, TERMS)
  assert.deepEqual(found.availability, {
    hash: SOURCE.id,
    provider: 'prowlarr',
    state: 'unverified',
    candidate_count: 2,
    candidates: [
      {
        entry_id: entryOf('first'),
        title: '[Vault] Show (BD 1080p)',
        indexer: 'Geek',
        size: Math.round(TOTAL * 1.08),
        info_url: 'https://indexer2.test/details/first#comments',
        files_matched: 0,
        names_matched: 0,
        files_expected: 0,
        sizes_known: false,
        checked: false,
        posted_at: '2026-11-24T17:03:11.000Z',
        files: 14,
      },
      {
        entry_id: entryOf('second'),
        // Markup in a title is cleaned before it is stored.
        title: '[Vault] Show b v2 /b',
        indexer: 'Geek',
        size: Math.round(TOTAL * 1.2),
        info_url: 'https://indexer2.test/details/second#comments',
        files_matched: 0,
        names_matched: 0,
        files_expected: 0,
        sizes_known: false,
        checked: false,
        posted_at: '2026-11-24T17:03:11.000Z',
        files: 14,
      },
    ],
  })
  assert.equal(found.stale, false)
  assert.equal(found.running, false)
  assert.deepEqual(searchSnapshot(config(), SOURCE.id).availability, found.availability)
  assert.deepEqual(record()?.candidates[0].download, { link: 'first', file: '[Vault] Show (BD 1080p)' })
  for (const shown of [found, searchSnapshot(config(), SOURCE.id)]) {
    const text = JSON.stringify(shown)
    assert.ok(!text.includes(KEY) && !text.includes('download') && !text.includes('"link"'), text)
  }
  // A fresh record is not searched again; "Search again" is.
  fake.calls.length = 0
  await searchSource(config(), SOURCE, TERMS)
  assert.equal(searches(fake).length, 0)
  await searchSource(config(), SOURCE, TERMS, { refresh: true })
  assert.equal(searches(fake).length, 1)
})

test('one indexer failing and one answering gives the candidates of the second, and the record says who was silent', async t => {
  const fake = setup(t, {
    indexers: [GEEK, SLUG],
    search: indexerId =>
      indexerId === 2
        ? new Response('boom', { status: 503 })
        : feed(indexerId, [{ title: '[Vault] Show', link: 'post' }]),
  })
  const found = await searchSource(config(), SOURCE, { titles: ['Show', 'Second'], releaseGroup: 'Vault' })
  assert.equal(found.availability.state, 'unverified')
  assert.deepEqual(
    found.availability.candidates?.map(candidate => candidate.indexer),
    ['Slug'],
  )
  assert.deepEqual(
    record()?.indexers.map(indexer => [indexer.name, indexer.answered]),
    [
      ['Geek', false],
      ['Slug', true],
    ],
  )
  // The failed indexer is not asked again in this search; the other one gets every rung.
  assert.equal(searches(fake, 2).length, 1)
  assert.equal(searches(fake, 5).length, 3)
  assert.ok((record()?.retry_at ?? 0) >= Date.now() + MINUTE - 1000)
})

test('no candidates and a failed indexer is a failed lookup; every indexer answering is an absence that backs off', async t => {
  let now = AT
  t.mock.method(Date, 'now', () => now)
  let geek: () => Response = () => new Response('boom', { status: 503 })
  const fake = setup(t, { indexers: [GEEK, SLUG], search: indexerId => (indexerId === 2 ? geek() : feed(indexerId)) })
  const failed = await searchSource(config(), SOURCE, TERMS)
  assert.deepEqual(failed.availability, {
    hash: SOURCE.id,
    state: 'lookup_failed',
    provider: 'prowlarr',
    error_code: 'server',
    error: 'Prowlarr returned HTTP 503 for the search of Geek',
    providers_failed: ['prowlarr'],
  })
  assert.equal(failed.checkedAt, 0)
  assert.equal(record()?.negative_streak, undefined, 'a failure is not stored as an absence')

  // Within the minute nothing is asked again; after it only the indexer that failed is.
  fake.calls.length = 0
  now += MINUTE - 1
  await searchSource(config(), SOURCE, TERMS)
  assert.equal(searches(fake).length, 0)
  now += 1
  geek = () => feed(2)
  const absent = await searchSource(config(), SOURCE, TERMS)
  assert.equal(absent.availability.state, 'no_match')
  assert.equal(absent.availability.error, 'Prowlarr found no Usenet post that could be this release.')
  assert.deepEqual([searches(fake, 2).length, searches(fake, 5).length], [2, 0])
  assert.equal(record()?.negative_streak, 1)

  // Consecutive absences stay fresh for 1, 3, 7 and 30 days.
  for (const [days, streak] of [
    [1, 2],
    [3, 3],
    [7, 4],
    [30, 5],
  ]) {
    now = record()!.searched_at + days * DAY - 1
    fake.calls.length = 0
    assert.equal((await searchSource(config(), SOURCE, TERMS)).stale, false)
    assert.equal(searches(fake).length, 0, `still fresh within ${days} days`)
    now += 1
    assert.equal(searchSnapshot(config(), SOURCE.id).stale, true)
    await searchSource(config(), SOURCE, TERMS)
    assert.equal(searches(fake).length, 4, `searched again after ${days} days`)
    assert.equal(record()?.negative_streak, streak)
  }
})

test('a Prowlarr 429 with Retry-After: 3600 is not retried within the hour', async t => {
  let now = AT
  t.mock.method(Date, 'now', () => now)
  const fake = setup(t, {
    search: () => newznabError(429, { status: 429, headers: { 'retry-after': '3600' } }),
  })
  const limited = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(limited.availability.state, 'lookup_failed')
  assert.equal(limited.availability.error_code, 'rate_limited')
  assert.match(limited.availability.error ?? '', /^Prowlarr is not searching Geek for now/)
  assert.equal(searches(fake).length, 1, 'no further rung is sent to an indexer that refused')
  assert.equal(record()?.retry_at, AT + HOUR)
  assert.deepEqual(
    usenetSearchPauses().map(pause => [pause.channel, pause.label, pause.until, pause.reason]),
    [['prowlarr:2', 'Geek', AT + HOUR, 'rate_limited']],
  )

  fake.search = indexerId => feed(indexerId, [{ title: '[Vault] Show', link: 'post', size: 1.08 }])
  now = AT + HOUR - 1
  assert.equal(searchSnapshot(config(), SOURCE.id).stale, false)
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  // Not even when asked to search again: the indexer is paused, and a paused indexer is not asked.
  const again = await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
  assert.equal(again.availability.state, 'lookup_failed')
  assert.match(again.availability.error ?? '', /^Geek is rate limiting requests/)
  assert.equal(searches(fake).length, 1)

  // The attempt that was not sent counts as one: the next is due a minute after it, and the pause is over.
  now = AT + HOUR + MINUTE - 2
  await searchSource(config(), SOURCE, TERMS)
  assert.equal(searches(fake).length, 1)
  now = AT + HOUR + MINUTE
  const later = await searchSource(config(), SOURCE, TERMS)
  assert.equal(later.availability.state, 'unverified')
  assert.equal(searches(fake).length, 2)
})

test('a paused indexer fails a waiting search fast and makes a background search wait', async t => {
  let limited = true
  const fake = setup(t, {
    search: indexerId => {
      if (!limited) return feed(indexerId, [{ title: '[Vault] Show', link: 'post', size: 1.08 }])
      limited = false
      return new Response('slow down', { status: 429 })
    },
  })
  searchScheduler.options.pauseBaseMs = 300
  await searchSource(config(), release('First'), terms('First'))
  const until = searchScheduler.pausedUntil('prowlarr:2')
  assert.ok(until > Date.now(), 'rate limiting paused the indexer')
  assert.equal(searches(fake).length, 1)

  const waiting = await searchSource(config(), release('Second'), terms('Second'))
  assert.equal(waiting.availability.state, 'lookup_failed')
  assert.equal(waiting.availability.error, 'Geek is rate limiting requests and is not asked for now.')
  assert.ok(Date.now() < until, 'the foreground search did not wait for the pause to end')
  assert.equal(searches(fake).length, 1, 'and sent nothing')

  const background = await searchSource(config(), release('Third'), terms('Third'), { background: true })
  assert.ok(Date.now() >= until, 'the background search waited out the pause')
  assert.equal(background.availability.state, 'unverified')
  assert.equal(searches(fake).length, 2)
})

test('an indexer Prowlarr disabled is not searched, and its channel is paused until Prowlarr asks it again', async t => {
  const disabledTill = new Date(Date.now() + 2 * HOUR).toISOString()
  const fake = setup(t, { indexers: [{ ...GEEK, status: { disabledTill } }, SLUG] })
  const found = await searchSource(config(), SOURCE, TERMS, { background: true })
  assert.equal(found.availability.state, 'lookup_failed')
  assert.equal(found.availability.error, 'Geek is disabled in Prowlarr after repeated failures.')
  assert.equal(searches(fake, 2).length, 0)
  assert.equal(searches(fake, 5).length, 2)
  assert.equal(record()?.retry_at, Date.parse(disabledTill))
  assert.deepEqual(
    usenetSearchPauses().map(pause => [pause.label, pause.until, pause.reason]),
    [['Geek', Date.parse(disabledTill), 'server']],
  )
  assert.equal(searchScheduler.interval('prowlarr:2'), 0, 'a pause Prowlarr reports does not widen the spacing')

  // Prowlarr asks the indexer again sooner than it said: the pause ends with the next indexer list.
  fake.indexers = [GEEK, SLUG]
  resetProwlarrRuntime()
  const again = await searchSource(config(), SOURCE, TERMS, { refresh: true })
  assert.deepEqual(usenetSearchPauses(), [])
  assert.equal(searches(fake, 2).length, 2)
  assert.equal(again.availability.state, 'no_match')
})

test('a newly added indexer makes a record stale, and only that indexer is asked', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, [{ title: `[Vault] Show ${indexerId}`, link: 'post', size: 1.08 }]),
  })
  await searchSource(config(), SOURCE, TERMS)
  assert.equal(searchSnapshot(config(), SOURCE.id).stale, false)
  assert.deepEqual(searchRecordState(record(), Date.now(), [GEEK, SLUG]).ask, [5])

  fake.indexers = [GEEK, SLUG]
  resetProwlarrRuntime()
  fake.calls.length = 0
  const merged = await searchSource(config(), SOURCE, TERMS)
  assert.deepEqual([searches(fake, 2).length, searches(fake, 5).length], [0, 1])
  assert.deepEqual(merged.availability.candidates?.map(candidate => candidate.indexer).sort(), ['Geek', 'Slug'])
  assert.deepEqual(
    record()?.indexers.map(indexer => [indexer.id, indexer.answered]),
    [
      [2, true],
      [5, true],
    ],
  )
  assert.equal(merged.stale, false)
})

test('the background search limit holds background searches back and never a search someone waits for', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, [{ title: '[Vault] Show', link: 'post', size: 1.08 }]),
  })
  const limited = config({ prowlarr_search_limit: 1 })
  const first = await searchSource(limited, release('First'), terms('First'), { background: true })
  assert.deepEqual([first.availability.state, first.deferred, searches(fake).length], ['unverified', false, 1])

  const second = release('Second')
  const refused = await searchSource(limited, second, terms('Second'), { background: true })
  assert.equal(refused.deferred, true)
  assert.ok((refused.deferredUntil ?? 0) > Date.now() + 23 * HOUR)
  assert.equal(refused.availability.state, 'not_checked', 'a deferred source is not a failed one')
  assert.equal(record(second), undefined)
  assert.equal(searches(fake).length, 1)

  const waited = await searchSource(limited, second, terms('Second'))
  assert.deepEqual([waited.availability.state, waited.deferred, searches(fake).length], ['unverified', false, 2])
  assert.equal(searchStore.usage(FINGERPRINT, 2).searches, 1, 'a search someone waits for is not counted')

  // Prowlarr's own query limit leaves half to everything else that uses the indexer.
  fake.indexers = [{ ...GEEK, fields: [{ name: 'baseSettings.queryLimit', value: 2 }] }]
  resetProwlarrRuntime()
  const third = await searchSource(config({ prowlarr_search_limit: 0 }), release('Third'), terms('Third'), {
    background: true,
  })
  assert.equal(third.deferred, true)
  assert.equal(searches(fake).length, 2)
  // No limit at all: 0 from Companion, none in Prowlarr.
  fake.indexers = [GEEK]
  resetProwlarrRuntime()
  await searchSource(config({ prowlarr_search_limit: 0 }), release('Third'), terms('Third'), { background: true })
  assert.equal(searches(fake).length, 3)
})

test('a refused Prowlarr key fails the whole lookup, stores nothing, and is not retried within the minute', async t => {
  let now = AT
  t.mock.method(Date, 'now', () => now)
  const fake = setup(t, { indexers: [GEEK, SLUG], search: () => new Response('no', { status: 401 }) })
  const failed = await resolveSource(
    config(),
    SOURCE,
    { titles: ['Show', 'Second'], releaseGroup: 'Vault' },
    { limit: 3 },
  )
  assert.equal(failed.availability.state, 'lookup_failed')
  assert.equal(failed.availability.error_code, 'unauthorized')
  assert.match(failed.availability.error ?? '', /Check the Prowlarr API key/)
  assert.deepEqual(failed.availability.providers_failed, ['prowlarr'])
  assert.equal(record(), undefined)
  assert.equal(searches(fake).length, 2, 'one rung, then nothing more')
  assert.deepEqual(usenetSearchPauses(), [], 'Prowlarr refusing its key says nothing about an indexer')

  now += MINUTE - 1
  assert.equal(searchSnapshot(config(), SOURCE.id).availability.state, 'lookup_failed')
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(searches(fake).length, 2)
  now += 1
  fake.search = indexerId => feed(indexerId)
  assert.equal((await resolveSource(config(), SOURCE, TERMS, { limit: 3 })).availability.state, 'no_match')
})

test('a hash lookup still gets a slot while every indexer search hangs', async t => {
  const hang = gate()
  const fake = setup(t, {
    search: async indexerId => {
      await hang.opened
      return feed(indexerId)
    },
  })
  const pacing = usenetScheduler.options.minIntervalMs
  resetUsenetLookups()
  usenetScheduler.options.minIntervalMs = 0
  t.after(() => {
    usenetScheduler.options.minIntervalMs = pacing
    resetUsenetLookups()
  })
  const pending = ['One', 'Two', 'Three', 'Four'].map(tag => searchSource(config(), release(tag), terms(tag)))
  await until(() => searches(fake).length === 3)
  for (let turn = 0; turn < 20; turn++) await nextTurn()
  assert.equal(searches(fake).length, 3, 'three searches hold every slot of the search scheduler')

  const hashes = config({ animetosho_enabled: true, amenzb_enabled: false })
  const state = await resolveUsenetHash(hashes, 'c'.repeat(40))
  assert.equal(state.state, 'no_match')
  assert.deepEqual(state.providers_checked, ['animetosho'])
  assert.equal(searches(fake).length, 3)

  hang.open()
  for (const outcome of await Promise.all(pending)) assert.equal(outcome.availability.state, 'no_match')
})

// --- Sharing ------------------------------------------------------------------------

test('two callers at once share one search and one check', async t => {
  const hang = gate()
  const fake = setup(t, {
    search: async indexerId => {
      await hang.opened
      return feed(indexerId, [{ title: '[Vault] Show', link: 'post', size: 1.08 }])
    },
    download: () => new Response(EXACT_NZB),
  })
  const callers = [
    resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true }),
    resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true }),
    resolveSource(config(), SOURCE, TERMS, { limit: 1 }),
  ]
  await until(() => searches(fake).length === 1)
  assert.equal(searchSnapshot(config(), SOURCE.id).running, true)
  hang.open()
  const outcomes = await Promise.all(callers)
  for (const outcome of outcomes) {
    assert.equal(outcome.availability.state, 'available')
    assert.equal(outcome.availability.proof, 'exact')
    assert.equal(outcome.running, false)
    assert.deepEqual(outcome.queries, [{ indexer: 'Geek', count: 1 }])
  }
  assert.equal(searches(fake).length, 1)
  assert.deepEqual(downloads(fake), ['post'])
  assert.equal(searchSnapshot(config(), SOURCE.id).running, false)
  assert.equal(searchStore.usage(FINGERPRINT, 2).fetches, 1)
})

test('a caller that starts waiting promotes a background search of the same source', async t => {
  const hang = gate()
  const fake = setup(t, {
    search: async (indexerId, query) => {
      if (query.get('q') !== 'Vault Show') await hang.opened
      return feed(indexerId, [{ title: `[Vault] ${query.get('q')}`, link: 'post', size: 1.08 }])
    },
  })
  const queued = ['Alpha', 'Beta'].map(tag => searchSource(config(), release(tag), terms(tag), { background: true }))
  await until(() => searches(fake).length === 2)
  // Background work never takes the last slot, so this one waits behind the two that hang.
  const background = searchSource(config(), SOURCE, TERMS, { background: true })
  for (let turn = 0; turn < 20; turn++) await nextTurn()
  assert.equal(searches(fake).length, 2)

  const waited = await searchSource(config(), SOURCE, TERMS)
  assert.equal(waited.availability.state, 'unverified')
  assert.deepEqual(
    searches(fake).map(query => query.get('q')),
    ['Vault Alpha', 'Vault Beta', 'Vault Show'],
  )
  assert.deepEqual((await background).availability, waited.availability)
  // The promoted search is one someone waits for: it is paced, not counted.
  assert.equal(searchStore.usage(FINGERPRINT, 2).searches, 2)
  hang.open()
  await Promise.all(queued)
  assert.equal(searches(fake).length, 3, 'one set of requests for the shared source')
})

// --- Verify stage -------------------------------------------------------------------

/** Two strong candidates of the release, `first` ranked ahead of `second`. */
const TWO_POSTS: Post[] = [
  { title: '[Vault] Show (BD 1080p)', link: 'first', size: 1.08, files: 14 },
  { title: '[Vault] Show (BD 1080p) repost', link: 'second', size: 1.12, files: 14 },
]

const refusals: [name: string, refusal: Pick<Fake, 'download' | 'elsewhere'>, retryAfter: number][] = [
  [
    'answering 429 after the redirect',
    {
      download: () =>
        new Response(null, { status: 301, headers: { location: 'https://indexer2.test/getnzb?id=first' } }),
      elsewhere: () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    },
    120_000,
  ],
  [
    'answering HTTP 200 with a Newznab error document',
    { download: () => newznabError(501), elsewhere: () => new Response('unexpected', { status: 500 }) },
    MINUTE,
  ],
]
for (const [name, refusal, retryAfter] of refusals)
  test(`an indexer ${name} to an NZB fetch fails the lookup: no second fetch, and neither a match nor an absence is stored`, async t => {
    const fake = setup(t, { search: indexerId => feed(indexerId, TWO_POSTS), ...refusal })
    const started = Date.now()
    const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
    assert.equal(outcome.availability.state, 'lookup_failed')
    assert.equal(outcome.availability.error_code, 'rate_limited')
    assert.equal(outcome.availability.error, 'Geek is limiting NZB downloads for now.')
    assert.deepEqual(outcome.availability.providers_failed, ['prowlarr'])
    assert.equal(outcome.fetched, 1)
    assert.deepEqual(downloads(fake), ['first'], 'the second candidate of the same indexer is not fetched')

    const [first, second] = record()!.candidates
    assert.equal(first.check?.unavailable?.code, 'rate_limited')
    assert.ok(first.check.unavailable.retry_at >= started + retryAfter)
    assert.equal(second.check, undefined)
    assert.equal(record()?.negative_streak, undefined)
    assert.deepEqual(
      outcome.availability.candidates?.map(candidate => [candidate.checked, candidate.unavailable]),
      [
        [false, 'Geek is limiting NZB downloads for now.'],
        [false, undefined],
      ],
    )
    assert.equal(chosenSearchCandidate(config(), SOURCE.id, first.entry_id), undefined)
    assert.ok(searchScheduler.isPaused('prowlarr:2'), 'the indexer is paused for everyone')
    const [usage] = prowlarrIndexerUsage(config())
    assert.deepEqual([usage.indexer, usage.fetches_left], ['Geek', 19])
    assert.ok(usage.paused_seconds! > 0 && usage.paused_seconds! <= Math.max(30, retryAfter / 1000))

    // Nothing is fetched again before the retry time: not by a review, a check or "Search again".
    await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
    const waiting = await verifySource(config(), SOURCE, { limit: 3 })
    assert.match(waiting.reason ?? '', /^Geek is rate limiting lookups; retrying in about /)
    await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
    assert.deepEqual(downloads(fake), ['first'])
    assert.equal(searches(fake).length, 1, 'and a paused indexer is not searched either')
    assert.equal(searchSnapshot(config(), SOURCE.id).availability.state, 'lookup_failed')
  })

test('a body that is no NZB marks its candidate only, and the next candidate is checked', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: (_indexerId, link) => new Response(link === 'first' ? '<html>Sign in</html>' : EXACT_NZB),
  })
  const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(outcome.availability.state, 'available')
  assert.equal(outcome.availability.entry_id, entryOf('second'))
  assert.equal(outcome.fetched, 2)
  assert.deepEqual(downloads(fake), ['first', 'second'])
  assert.equal(record()?.candidates[0].check?.unavailable?.code, 'invalid_response')
  assert.equal(searchScheduler.isPaused('prowlarr:2'), false)

  // Alone, such a candidate is a checked one that proves nothing: no match, and it cannot be chosen.
  fake.search = indexerId => feed(indexerId, TWO_POSTS.slice(0, 1))
  const other = release('Solo')
  const alone = await resolveSource(config(), other, terms('Solo'), { limit: 3 })
  assert.equal(alone.availability.state, 'no_match')
  assert.equal(alone.availability.candidates?.[0].unavailable, 'Geek did not send a usable NZB.')
  assert.equal(chosenSearchCandidate(config(), other.id, entryOf('first')), undefined)
})

test('an exact NZB makes the source available, and its ratios are logged for calibration', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: () => new Response(EXACT_NZB),
  })
  const lines: string[] = []
  t.mock.method(console, 'log', (line: unknown) => {
    lines.push(String(line))
  })
  const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.deepEqual(outcome.availability, {
    hash: SOURCE.id,
    state: 'available',
    provider: 'prowlarr',
    entry_id: entryOf('first'),
    title: '[Vault] Show (BD 1080p)',
    total_bytes: Math.round(TOTAL * 1.08),
    files_known: false,
    file_count: 14,
    proof: 'exact',
    candidate_count: 2,
  })
  assert.equal(outcome.fetched, 1)
  assert.deepEqual(downloads(fake), ['first'], 'the walk stops at the first proven candidate')
  assert.ok(outcome.checkedAt > 0)
  const logged = lines.filter(line => line.includes('Usenet NZB'))
  assert.equal(logged.length, 1)
  assert.match(logged[0], /\[INFO\] Usenet NZB from Geek graded exact; ratio 1\.03\d\d to 1\.03\d\d$/)
  assert.ok(!logged[0].includes('Show') && !logged[0].includes('first'), 'neither a title nor a link is logged')
  const check = record()?.candidates[0].check
  assert.deepEqual(
    [check?.proof, check?.files_matched, check?.names_matched, check?.files_expected, check?.nzb_sha256],
    ['exact', 3, 3, 3, sha256(EXACT_NZB)],
  )
})

test('a near-exact NZB makes the source available, labelled near-exact', async t => {
  setup(t, { search: indexerId => feed(indexerId, TWO_POSTS), download: () => new Response(NEAR_EXACT_NZB) })
  const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 1 })
  assert.equal(outcome.availability.state, 'available')
  assert.equal(outcome.availability.proof, 'near_exact')
  assert.equal(outcome.availability.entry_id, entryOf('first'))
  assert.deepEqual(chosenSearchCandidate(config(), SOURCE.id, entryOf('first')), {
    hash: SOURCE.id,
    state: 'available',
    provider: 'prowlarr',
    entry_id: entryOf('first'),
    title: '[Vault] Show (BD 1080p)',
    total_bytes: Math.round(TOTAL * 1.08),
    files_known: false,
    file_count: 14,
    proof: 'near_exact',
  })
})

test('probable, size-only and unverified NZBs leave the source without a match, and each can be chosen by its entry', async t => {
  const posts = ['probable', 'size_only', 'unverified'].map((link, index) => ({
    title: `[Vault] Show ${index + 1}`,
    link,
    size: 1.08 + index * 0.02,
  }))
  const bodies: Record<string, typeof EXACT_NZB> = {
    probable: PROBABLE_NZB,
    size_only: SIZE_ONLY_NZB,
    unverified: OTHER_NZB,
  }
  const fake = setup(t, {
    search: indexerId => feed(indexerId, posts),
    download: (_indexerId, link) => new Response(bodies[link]),
  })
  const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(outcome.availability.state, 'no_match')
  assert.equal(
    outcome.availability.error,
    'Prowlarr found 3 possible NZBs, but none could be shown to be this release.',
  )
  assert.equal(outcome.fetched, 3)
  assert.deepEqual(downloads(fake), ['probable', 'size_only', 'unverified'])
  assert.deepEqual(
    outcome.availability.candidates?.map(candidate => [candidate.checked, candidate.proof, candidate.files_expected]),
    [
      [true, 'probable', 3],
      [true, 'size_only', 3],
      [true, 'unverified', 3],
    ],
  )
  for (const link of ['probable', 'size_only', 'unverified']) {
    const chosen = chosenSearchCandidate(config(), SOURCE.id, entryOf(link))
    assert.deepEqual([chosen?.state, chosen?.proof, chosen?.entry_id], ['available', link, entryOf(link)])
    assert.deepEqual(await searchNzbBytes(config(), SOURCE.id, entryOf(link)), bodies[link])
  }
  assert.equal(chosenSearchCandidate(config(), SOURCE.id, entryOf('unknown')), undefined)
  assert.equal(chosenSearchCandidate(config({ prowlarr_enabled: false }), SOURCE.id, entryOf('probable')), undefined)
  // A review that opens again spends no fetch on a source that was checked; "Search again" would.
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(downloads(fake).length, 3)
})

test('a bulk check fetches one NZB, and a source checked without a proof is not checked again on its own', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: (_indexerId, link) => new Response(link === 'first' ? OTHER_NZB : EXACT_NZB),
  })
  const bulk = await resolveSource(config(), SOURCE, TERMS, { limit: 1 })
  assert.equal(bulk.availability.state, 'no_match')
  assert.equal(
    bulk.availability.error,
    'Prowlarr found 2 possible NZBs; none of those checked so far could be shown to be this release.',
  )
  assert.deepEqual(
    bulk.availability.candidates?.map(candidate => candidate.checked),
    [true, false],
  )
  await resolveSource(config(), SOURCE, TERMS, { limit: 1 })
  assert.deepEqual(downloads(fake), ['first'])
  // "Search again" goes on with the candidates nobody opened.
  const again = await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
  assert.equal(again.availability.state, 'available')
  assert.deepEqual(downloads(fake), ['first', 'second'])
})

test('the fetch limit refuses a fetch without an error and says when the next one is possible', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS.slice(0, 1)),
    download: () => new Response(EXACT_NZB),
  })
  const limited = config({ prowlarr_fetch_limit: 1 })
  assert.deepEqual(prowlarrIndexerUsage(limited), [], 'the indexers are not known before Prowlarr was asked')
  assert.equal((await resolveSource(limited, SOURCE, TERMS, { limit: 1 })).availability.state, 'available')
  assert.deepEqual(prowlarrIndexerUsage(config()), [{ indexer: 'Geek', fetches_left: 19 }])
  assert.deepEqual(prowlarrIndexerUsage(config({ prowlarr_fetch_limit: 0 })), [{ indexer: 'Geek', fetches_left: null }])

  const other = release('Other')
  const refused = await resolveSource(limited, other, terms('Other'), { limit: 1 })
  assert.equal(refused.availability.state, 'unverified')
  assert.equal(refused.fetched, 0)
  assert.match(
    refused.reason ?? '',
    /^Daily NZB check limit reached for Geek\. Next check at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.$/,
  )
  assert.equal(refused.availability.error, refused.reason)
  assert.equal(refused.availability.error_code, undefined, 'a reached limit is no failure')
  assert.equal(searchSnapshot(limited, other.id).availability.error, refused.reason)
  assert.equal(downloads(fake).length, 1)
  const [usage] = prowlarrIndexerUsage(limited)
  assert.deepEqual([usage.indexer, usage.fetches_left], ['Geek', 0])
  assert.ok(usage.next_fetch_seconds! > 23 * 3600 && usage.next_fetch_seconds! <= 25 * 3600)
  // The setting takes effect at once.
  const allowed = await resolveSource(config({ prowlarr_fetch_limit: 2 }), other, terms('Other'), { limit: 1 })
  assert.equal(allowed.fetched, 1)
  assert.equal(downloads(fake).length, 2)
})

test('a rejected candidate is skipped by the next check and never reported as available', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: (_indexerId, link) => new Response(link === 'first' ? NEAR_EXACT_NZB : EXACT_NZB),
  })
  const sent = await resolveSource(config(), SOURCE, TERMS, { limit: 1 })
  assert.deepEqual([sent.availability.state, sent.availability.proof], ['available', 'near_exact'])
  assert.equal(rejectSearchCandidate(config(), SOURCE.id, entryOf('unknown')), false)
  assert.equal(rejectSearchCandidate(config(), SOURCE.id, entryOf('first')), true)

  // Written at once: the rejection survives a restart.
  resetUsenetSearch(true)
  const rejected = searchSnapshot(config(), SOURCE.id).availability
  assert.equal(rejected.state, 'no_match')
  assert.deepEqual(
    rejected.candidates?.map(candidate => [candidate.entry_id, candidate.rejected, candidate.checked]),
    [
      [entryOf('first'), true, true],
      [entryOf('second'), undefined, false],
    ],
  )
  assert.equal(chosenSearchCandidate(config(), SOURCE.id, entryOf('first')), undefined)
  await assert.rejects(searchNzbBytes(config(), SOURCE.id, entryOf('first')), /no longer known/)

  // The next search tries another candidate, and ranks the rejected one last.
  const next = await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
  assert.deepEqual(downloads(fake), ['first', 'second'])
  assert.deepEqual([next.availability.state, next.availability.entry_id], ['available', entryOf('second')])
  assert.deepEqual(
    record()?.candidates.map(candidate => candidate.entry_id),
    [entryOf('second'), entryOf('first')],
  )
})

test('Prowlarr failing a fetch ends the check without blaming the indexer or the candidate', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: () => new Response('bad gateway', { status: 502 }),
  })
  const outcome = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(outcome.availability.state, 'unverified', 'nothing is concluded about the source')
  assert.equal(outcome.availability.refresh_error, 'Prowlarr returned HTTP 502')
  assert.equal(outcome.fetched, 1)
  assert.deepEqual(downloads(fake), ['first'])
  assert.equal(record()?.candidates[0].check, undefined)
  assert.deepEqual(usenetSearchPauses(), [])
  // A review that follows within the minute does not try again.
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(downloads(fake).length, 1)
})

test('a check that may fetch more goes on where a running check of the same source stops', async t => {
  const hang = gate()
  const posts = ['one', 'two', 'three', 'four'].map((link, index) => ({
    title: `[Vault] Show ${link}`,
    link,
    size: 1.08 + index * 0.01,
  }))
  const fake = setup(t, {
    search: indexerId => feed(indexerId, posts),
    download: async () => {
      await hang.opened
      return new Response(OTHER_NZB)
    },
  })
  await searchSource(config(), SOURCE, TERMS)
  const single = verifySource(config(), SOURCE, { limit: 1 })
  const triple = verifySource(config(), SOURCE, { limit: 3 })
  const same = verifySource(config(), SOURCE, { limit: 1 })
  await until(() => downloads(fake).length === 1)
  assert.equal(searchSnapshot(config(), SOURCE.id).running, true)
  hang.open()
  assert.deepEqual(
    (await Promise.all([single, triple, same])).map(outcome => outcome.fetched),
    [1, 3, 1],
  )
  assert.deepEqual(downloads(fake), ['one', 'two', 'three'])
  assert.equal(searchSnapshot(config(), SOURCE.id).running, false)
})

test('a cancelled check is dropped while it waits, finishes once it fetches, and stays when someone else waits for it', async t => {
  const hang = gate()
  const tags = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
  const sources = tags.map(tag => release(tag))
  const [alpha, beta, gamma, delta, epsilon] = sources
  const bodies = new Map(sources.map((source, index) => [tags[index], nzb(source.files.map(stated))]))
  const fake = setup(t, {
    search: (indexerId, query) => {
      const tag = query.get('q')!.replace('Vault ', '')
      return feed(indexerId, [{ title: `[Vault] ${tag} (BD 1080p)`, link: tag, size: 1.08 }])
    },
    download: async (_indexerId, link) => {
      await hang.opened
      return new Response(bodies.get(link))
    },
  })
  // One request at a time, so everything behind the first fetch waits for its slot.
  searchScheduler.options.concurrency = 1
  const state = (source: PrivateSource) => searchSnapshot(config(), source.id).availability.state
  const check = (source: PrivateSource, tag: string) =>
    resolveSource(config(), source, terms(tag), { limit: 1, cancellable: true })
  for (const tag of tags.slice(0, 3)) await searchSource(config(), release(tag), terms(tag))

  const fetching = check(alpha, 'Alpha')
  await until(() => downloads(fake).length === 1)
  const waiting = check(beta, 'Beta')
  // Someone who cannot be cancelled waits for the same check, and for the same search.
  const shared = [check(gamma, 'Gamma'), verifySource(config(), gamma, { limit: 1 })]
  const unsearched = check(delta, 'Delta')
  const searched = [check(epsilon, 'Epsilon'), searchSource(config(), epsilon, terms('Epsilon'))]
  for (let turn = 0; turn < 20; turn++) await nextTurn()
  assert.equal(searches(fake).length, 3, 'the searches of the last two wait behind the fetch')

  for (const source of sources) cancelSourceCheck(config(), source.id)
  assert.equal((await waiting).fetched, 0)
  assert.equal((await unsearched).cancelled, true)
  assert.equal(searchSnapshot(config(), alpha.id).running, true, 'the fetch under way goes on')
  hang.open()
  assert.equal((await fetching).availability.proof, 'exact')
  await Promise.all([...shared, ...searched])

  assert.deepEqual(downloads(fake), ['Alpha', 'Gamma'])
  assert.deepEqual(sources.map(state), ['available', 'unverified', 'available', 'not_checked', 'unverified'])
  assert.deepEqual(
    searches(fake).map(query => query.get('q')),
    ['Vault Alpha', 'Vault Beta', 'Vault Gamma', 'Vault Epsilon'],
    'a search nobody else waited for was never sent',
  )
  assert.equal(searchStore.usage(FINGERPRINT, 2).fetches, 2)
  for (const source of sources) assert.equal(searchSnapshot(config(), source.id).running, false)

  // A cancelled check is no verdict: asking again checks the candidate.
  assert.equal((await check(beta, 'Beta')).availability.proof, 'exact')
  assert.deepEqual(downloads(fake), ['Alpha', 'Gamma', 'Beta'])
  // Cancelling does not touch a check an explicit search asked for.
  const explicit = resolveSource(config(), delta, terms('Delta'), { limit: 3, refresh: true })
  cancelSourceCheck(config(), delta.id)
  assert.equal((await explicit).availability.proof, 'exact')
})

test('an indexer that left Prowlarr is not fetched from, and the next search drops what it listed', async t => {
  const fake = setup(t, {
    indexers: [GEEK, SLUG],
    search: indexerId =>
      feed(indexerId, [{ title: '[Vault] Show', link: 'post', size: indexerId === 5 ? 1.08 : 1.12 }]),
    download: () => new Response(EXACT_NZB),
  })
  await searchSource(config(), SOURCE, TERMS)
  assert.deepEqual(
    record()?.candidates.map(candidate => candidate.indexer),
    ['Slug', 'Geek'],
  )
  fake.indexers = [GEEK]
  resetProwlarrRuntime()
  const checked = await verifySource(config(), SOURCE, { limit: 3 })
  assert.deepEqual(
    fake.calls.filter(call => call.url.pathname.endsWith('/download')).map(call => call.url.pathname),
    ['/2/download'],
  )
  assert.equal(checked.availability.entry_id, entryOf('post', 2))
  await searchSource(config(), SOURCE, TERMS, { refresh: true })
  assert.deepEqual(
    record()?.candidates.map(candidate => candidate.indexer),
    ['Geek'],
  )
  assert.deepEqual(
    record()?.indexers.map(indexer => indexer.name),
    ['Geek'],
  )
})

test('the twenty best candidates are kept, and a background call never fetches one', async t => {
  const posts = Array.from({ length: 30 }, (_, index) => ({
    title: '[Vault] Show',
    link: `post-${index}`,
    size: 1.3 - index * 0.01,
  }))
  const fake = setup(t, { search: indexerId => feed(indexerId, posts), download: () => new Response(EXACT_NZB) })
  const found = await resolveSource(config(), SOURCE, TERMS, { background: true, limit: 3 })
  assert.equal(found.availability.state, 'unverified')
  assert.equal(found.availability.candidate_count, 20)
  assert.equal(found.fetched, 0)
  assert.deepEqual(downloads(fake), [])
  // Closest to the usual size of a post first; the outliers were left out.
  const sizes = record()!.candidates.map(candidate => Math.round((candidate.size! / TOTAL) * 100))
  assert.equal(sizes[0], 108)
  assert.deepEqual(sizes.slice(1, 3).sort(), [107, 109])
  assert.deepEqual([Math.min(...sizes), Math.max(...sizes)], [101, 120])
})

// --- Persistence and submission -----------------------------------------------------

test('a proven match survives a restart and is reported and sent without a request', async t => {
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: () => new Response(EXACT_NZB),
  })
  const found = await resolveSource(config(), SOURCE, TERMS, { limit: 3, refresh: true })
  assert.equal(found.availability.state, 'available')

  // The process is killed here: the check was written when it was made, nothing is flushed by hand.
  resetUsenetSearch(true)
  resetProwlarrRuntime()
  fake.calls.length = 0
  const snapshot = searchSnapshot(config(), SOURCE.id)
  assert.deepEqual(snapshot.availability, found.availability)
  assert.deepEqual([snapshot.stale, snapshot.running, snapshot.checkedAt], [false, false, found.checkedAt])
  assert.deepEqual(await searchNzbBytes(config(), SOURCE.id, entryOf('first')), EXACT_NZB)
  assert.equal(fake.calls.length, 0, 'neither the report nor the submission asked Prowlarr anything')

  // A review reads the indexer list at most; it neither searches nor fetches.
  const reviewed = await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(reviewed.availability.state, 'available')
  assert.equal(reviewed.fetched, 0)
  assert.deepEqual([searches(fake).length, downloads(fake).length], [0, 0])

  // With Prowlarr turned off the store is not consulted, and nothing can be sent.
  const off = config({ prowlarr_enabled: false })
  assert.deepEqual(searchSnapshot(off, SOURCE.id).availability, {
    hash: SOURCE.id,
    state: 'not_configured',
    provider: 'prowlarr',
    error: 'Prowlarr is not set up.',
  })
  assert.equal((await resolveSource(off, SOURCE, TERMS, { limit: 3 })).availability.state, 'not_configured')
  await assert.rejects(searchNzbBytes(off, SOURCE.id, entryOf('first')), /Prowlarr is no longer configured/)
  // A private-tracker release is not searched in public-tracker mode; a public torrent still is.
  assert.equal(searchSnapshot(config({ tracker_mode: 'public' }), SOURCE.id).availability.state, 'not_configured')
  assert.equal(searchSnapshot(config({ tracker_mode: 'public' }), 'c'.repeat(40)).availability.state, 'not_checked')
})

test('an evicted NZB is fetched again for a submission and sent only when it is still the checked post', async t => {
  let body = EXACT_NZB
  const fake = setup(t, {
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: () => new Response(body),
  })
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  const entry = entryOf('first')
  const evict = () => fs.rmSync(NZB_STORE_DIR, { recursive: true, force: true })

  // The same bytes pass, cost one fetch, and are kept again.
  evict()
  assert.deepEqual(await searchNzbBytes(config(), SOURCE.id, entry), EXACT_NZB)
  assert.deepEqual(downloads(fake), ['first', 'first'])
  assert.equal(searchStore.usage(FINGERPRINT, 2).fetches, 2)
  assert.deepEqual(await searchNzbBytes(config(), SOURCE.id, entry), EXACT_NZB)
  assert.equal(downloads(fake).length, 2)

  // Other bytes that prove as much pass too: an indexer may add a comment to the file it serves.
  evict()
  body = new TextEncoder().encode(`${new TextDecoder().decode(EXACT_NZB)}<!-- served by Geek -->`)
  assert.deepEqual(await searchNzbBytes(config(), SOURCE.id, entry), body)
  assert.equal(record()?.candidates[0].check?.nzb_sha256, sha256(body))

  // Without the daily limit's leave nothing is fetched, and the error says when it can be.
  evict()
  await assert.rejects(
    searchNzbBytes(config({ prowlarr_fetch_limit: 3 }), SOURCE.id, entry),
    /^Error: The checked NZB has to be fetched again first\. Daily NZB check limit reached for Geek\. Next check at /,
  )
  assert.equal(downloads(fake).length, 3)

  // A different post under the same entry is not sent, and the source loses its match.
  body = OTHER_NZB
  await assert.rejects(
    searchNzbBytes(config(), SOURCE.id, entry),
    /The NZB changed since it was checked\. Re-run the review/,
  )
  assert.equal(record()?.candidates[0].check?.proof, 'unverified')
  assert.equal(searchSnapshot(config(), SOURCE.id).availability.state, 'no_match')

  // After a restart the file list is not known here: a changed file is fetched and graded by the next review.
  const other = release('Other')
  const otherNzb = nzb(other.files.map(stated))
  const commented = new TextEncoder().encode(`${new TextDecoder().decode(otherNzb)}<!-- changed -->`)
  body = otherNzb
  assert.equal((await resolveSource(config(), other, terms('Other'), { limit: 3 })).availability.proof, 'exact')
  resetUsenetSearch(true)
  evict()
  body = commented
  await assert.rejects(searchNzbBytes(config(), other.id, entry), /The NZB changed since it was checked/)
  assert.equal(searchSnapshot(config(), other.id).availability.state, 'unverified')
  // Given the file list, the same case is graded on the spot.
  assert.equal((await resolveSource(config(), other, terms('Other'), { limit: 3 })).availability.proof, 'exact')
  resetUsenetSearch(true)
  evict()
  body = otherNzb
  assert.deepEqual(await searchNzbBytes(config(), other.id, entry, other.files), otherNzb)
})

test('the stored file holds neither the Prowlarr key nor a download address', async t => {
  setup(t, {
    indexers: [GEEK, SLUG],
    search: indexerId => feed(indexerId, TWO_POSTS),
    download: () => new Response(EXACT_NZB),
  })
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  await searchSource(config(), release('Other'), terms('Other'), { background: true })
  assert.equal(flushUsenetSearch(), true)
  const text = fs.readFileSync(USENET_SEARCH_FILE, 'utf8')
  assert.ok(text.includes('"link":"first"'), 'the reference is stored without its address')
  for (const secret of [KEY, 'apikey', '/download', 'localhost', PROWLARR]) assert.ok(!text.includes(secret), secret)
  if (process.platform !== 'win32') assert.equal(fs.statSync(USENET_SEARCH_FILE).mode & 0o777, 0o600)
})

test('a changed Prowlarr connection leaves no record, no stored NZB and no running work behind', async t => {
  const hang = gate()
  let hanging = false
  const fake = setup(t, {
    search: async indexerId => {
      if (hanging) await hang.opened
      return feed(indexerId, TWO_POSTS)
    },
    download: () => new Response(EXACT_NZB),
  })
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  assert.equal(fs.readdirSync(NZB_STORE_DIR).length, 1)

  // A search of the old connection is still running when the key changes.
  hanging = true
  const other = release('Other')
  const running = searchSource(config(), other, terms('Other'))
  await until(() => searches(fake).length === 2)
  const changed = config({ prowlarr_key: 'another-key' })
  invalidateUsenetSearch(changed)
  const discarded = await running
  assert.equal(discarded.cancelled, true)
  assert.equal(discarded.availability.state, 'lookup_failed')
  hang.open()

  assert.equal(record(), undefined)
  assert.equal(record(other), undefined)
  assert.deepEqual(fs.readdirSync(NZB_STORE_DIR), [])
  assert.equal(searchStore.usage(FINGERPRINT, 2).fetches, 0)
  assert.equal(searchSnapshot(changed, SOURCE.id).availability.state, 'not_checked')
  await assert.rejects(searchNzbBytes(changed, SOURCE.id, entryOf('first')), /no longer known/)
})

test('records of sources that left the results are pruned with their NZBs', async t => {
  setup(t, { search: indexerId => feed(indexerId, TWO_POSTS), download: () => new Response(EXACT_NZB) })
  const other = release('Other')
  await resolveSource(config(), SOURCE, TERMS, { limit: 3 })
  await searchSource(config(), other, terms('Other'))
  assert.equal(retainSearchSources(new Set([SOURCE.id, other.id])), 0)
  assert.equal(retainSearchSources(new Set([other.id])), 1)
  assert.equal(record(), undefined)
  assert.notEqual(record(other), undefined)
  assert.deepEqual(fs.readdirSync(NZB_STORE_DIR), [])
})

// --- Scheduler ----------------------------------------------------------------------

test('a pause set from outside holds a channel back without widening its spacing or its next backoff', async () => {
  const scheduler = new LookupScheduler({ minIntervalMs: 2_000, pauseBaseMs: 30_000 })
  scheduler.describe('prowlarr:7', { label: 'Indexer Seven' })
  const until = Date.now() + 5_000
  scheduler.pause('prowlarr:7', until, 'server')
  assert.deepEqual(scheduler.pauses(), [{ channel: 'prowlarr:7', label: 'Indexer Seven', until, reason: 'server' }])
  assert.equal(scheduler.interval('prowlarr:7'), 2_000)
  // A shorter pause, or one that is already over, changes nothing.
  scheduler.pause('prowlarr:7', until - 1_000, 'rate_limited')
  scheduler.pause('prowlarr:8', Date.now() - 1, 'server')
  assert.equal(scheduler.pausedUntil('prowlarr:7'), until)
  assert.equal(scheduler.pauses()[0].reason, 'server')
  assert.equal(scheduler.isPaused('prowlarr:8'), false)
  await assert.rejects(
    scheduler.acquire({ channel: 'prowlarr:7', background: false, controller: new AbortController() }),
    ProviderPausedError,
  )
  // The pause can be ended once its cause is over.
  scheduler.resume('prowlarr:7')
  assert.deepEqual(scheduler.pauses(), [])
  await scheduler.acquire({ channel: 'prowlarr:7', background: false, controller: new AbortController() })
  scheduler.release()
  // The first real rate limit afterwards starts the backoff at its base.
  scheduler.reset()
  scheduler.pause('prowlarr:7', Date.now() + 10, 'server')
  await new Promise(resolve => setTimeout(resolve, 20))
  const before = Date.now()
  scheduler.recordOutcome('prowlarr:7', { kind: 'failed', code: 'rate_limited' })
  assert.ok(scheduler.pausedUntil('prowlarr:7') - before <= 30_050)
  assert.equal(scheduler.interval('prowlarr:7'), 3_000)
  scheduler.reset()
})
