// Usenet copies found through Prowlarr, from an availability request to the ledger: what a row reports and
// starts, what a bulk review plans from stored results, what an acceptance sends, and what must not change for
// hash-linked NZBs. Prowlarr, its indexer, the hash indexer and both download clients are fakes behind `fetch`;
// records, NZBs and the ledger live in the shared temp DATA_DIR (tests/run-tests.mjs).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { loadConfig, saveConfig } from '../server/config.js'
import { saveSettings } from '../server/config-service.js'
import { consumePlan } from '../server/download-plans.js'
import { buildDownloadPlan, parseSelections } from '../server/download-preflight.js'
import { downloadRoutes } from '../server/download-routes.js'
import { downloadRecords, resetOwnedRuntime } from '../server/download-store.js'
import { acceptDownloadPlan, PlanRejected } from '../server/download-submit.js'
import {
  CONFIG_FILE,
  DATA_DIR,
  ENCRYPTED_SECRETS_FILE,
  NZB_STORE_DIR,
  SECRETS_KEY_FILE,
  USENET_SEARCH_FILE,
} from '../server/paths.js'
import { resetProwlarrRuntime } from '../server/prowlarr.js'
import { matchRoute } from '../server/router.js'
import { autocheckState, setState } from '../server/scan-state.js'
import { filesSourceId, type SourceFile } from '../server/source-files.js'
import type { Config, PrivateSource, ResultItem } from '../server/types.js'
import { resolveUsenetHash, usenetAvailability, usenetScheduler } from '../server/usenet.js'
import {
  chosenSearchCandidate,
  prowlarrIndexerUsage,
  resetUsenetSearch,
  searchScheduler,
  searchSnapshot,
  searchSource,
} from '../server/usenet-search.js'
import { candidateEntryId } from '../server/usenet-search-terms.js'
import type { UsenetAvailabilityResponse, UsenetAvailabilityResult } from '../shared/usenet-contracts.js'
import {
  animetoshoMatch,
  baseConfig,
  installRouter,
  purgeTestDataDir,
  releaseFixture,
  resultFixture,
  SAB,
  type RouterState,
} from './support/download-fixtures.js'

const PROWLARR = 'http://prowlarr-review.test:9696'
const KEY = 'prowlarr-review-key-71f0'
/** Where the fake indexer serves NZBs once Prowlarr redirects a download to it. */
const DOWNLOAD_HOST = 'https://dl.geek-review.test'
const INDEXER_SECRET = 'indexer-secret-93ab'
const GEEK = { id: 2, name: 'Geek', protocol: 'usenet', privacy: 'private', enable: true }
const OVERHEAD = 1.031
const SIZES = [1_512_345_678, 1_398_765_432, 1_287_654_321]
const TOTAL = SIZES.reduce((sum, size) => sum + size, 0)

// --- Releases -----------------------------------------------------------------------

/** The three episodes of the release named by `tag`, as SeaDex lists them. */
function show(tag: string): PrivateSource {
  const files = SIZES.map((length, index) => ({ name: `[Vault] ${tag} - 0${index + 1} (BD 1080p).mkv`, length }))
  return { id: filesSourceId(files), files }
}

/** A library row whose best release is on a private tracker: SeaDex lists its files and no info hash. */
function privateRow(tag: string, overrides: Record<string, unknown> = {}): ResultItem {
  const release = releaseFixture({
    releaseGroup: 'Vault',
    tracker: 'AB',
    torrent_available: false,
    info_hashes: [],
    torrent_files: undefined,
    private_sources: [show(tag)],
    size: TOTAL,
    part: '',
    ...overrides,
  })
  return resultFixture([release], { key: tag.toLowerCase(), title: tag }) as unknown as ResultItem
}

/** A library row whose best release is a public torrent with a listed file list. */
function publicRow(tag: string, hash: string, key = tag.toLowerCase()): ResultItem {
  const release = releaseFixture({
    releaseGroup: 'Vault',
    info_hashes: [hash],
    torrent_files: [{ hash, files: show(tag).files }],
    size: TOTAL,
    part: '',
  })
  return resultFixture([release], { key, title: tag }) as unknown as ResultItem
}

const row = (tag: string) => ({ key: tag.toLowerCase(), release: 0 })

function config(overrides: Partial<Config> = {}): Config {
  return baseConfig({
    tracker_mode: 'private',
    download_mode: 'usenet_only',
    prowlarr_enabled: true,
    prowlarr_url: PROWLARR,
    prowlarr_key: KEY,
    ...overrides,
  })
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
function segments(length: number): number[] {
  const total = Math.round(length * OVERHEAD)
  const part = Math.floor(total / 3)
  return [part, part, total - 2 * part]
}

/** The name and the decoded size in the subject: an exact match. */
const stated = (file: SourceFile): Posted => ({
  subject: `"${file.name}" yEnc (1/3) ${file.length}`,
  segments: segments(file.length),
})
/** The name without a size, at a constant overhead: a near-exact match. */
const named = (file: SourceFile): Posted => ({ subject: `"${file.name}" yEnc (1/3)`, segments: segments(file.length) })
/** A random name with the size of the file: a probable match. */
const obfuscated = (file: SourceFile, index: number): Posted => ({
  subject: `"${((index + 1) * 0x9e3779b1).toString(16)}" yEnc (1/3)`,
  segments: segments(file.length),
})

const exactNzb = (tag: string) => nzb(show(tag).files.map(stated))
const nearExactNzb = (tag: string) => nzb(show(tag).files.map(named))
const probableNzb = (tag: string) => nzb(show(tag).files.map(obfuscated))
/** One archive in three equal parts: only the total can be compared. */
const SIZE_ONLY_NZB = nzb(
  [1, 2, 3].map(part => ({
    subject: `"8f1c2e7a.part0${part}.rar" yEnc (1/3)`,
    segments: segments(Math.ceil(TOTAL / 3)),
  })),
)
/** Another release, at about half the size: no proof at all. */
const OTHER_NZB = nzb(
  SIZES.map((length, index) => stated({ name: `[Other] Show - 0${index + 1} (720p).mkv`, length: length >> 1 })),
)

type Nzb = ReturnType<typeof nzb>

const text = (bytes: Nzb) => new TextDecoder().decode(bytes)

// --- Fakes --------------------------------------------------------------------------

interface Post {
  title: string
  /** Stands for Prowlarr's encrypted download link, and names the post. */
  link: string
  /** Size the indexer reports, as a multiple of the listed total. */
  size: number
}

interface Fake {
  /** Every request to Prowlarr or to the indexer behind it, in order. */
  calls: URL[]
  indexers: unknown[]
  /** Posts a search for a release lists, by its tag; one post of the right size by default. */
  posts: Record<string, Post[]>
  /** NZBs by post link; a post named like a release is that release with exact subjects by default. */
  bodies: Record<string, Nzb>
  /** Runs before an NZB is sent, so a test can hold a fetch. */
  beforeNzb: () => Promise<void>
  /** Prowlarr hands a download on to the indexer's own address instead of the file. */
  redirect: boolean
  /** AnimeTosho's answer for a hash; it has no entry by default. */
  animetosho: (hash: string) => Response
  /** NZBs SABnzbd was sent. */
  sent: { nzb: string; name: string; category: string }[]
  router: RouterState
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const pageOf = (link: string) => `https://indexer2.test/details/${link}`
const entryOf = (link: string) => candidateEntryId(2, pageOf(link))

/** A Newznab answer as Prowlarr writes it: download links carry its key, and the page address a credential. */
function feed(indexerId: number, posts: Post[]): Response {
  const items = posts.map(post => {
    const proxy = escapeXml(
      `http://localhost:9696/${indexerId}/download?${new URLSearchParams({ apikey: KEY, link: post.link, file: post.title })}`,
    )
    return [
      `<item><title>${escapeXml(post.title)}</title><guid>${pageOf(post.link)}</guid>`,
      `<comments>${escapeXml(`${pageOf(post.link)}?apikey=${INDEXER_SECRET}`)}</comments><link>${proxy}</link>`,
      `<enclosure url="${proxy}" type="application/x-nzb" />`,
      `<newznab:attr name="size" value="${Math.round(TOTAL * post.size)}" /></item>`,
    ].join('')
  })
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Prowlarr</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/rss+xml' } },
  )
}

function forgetSearches(): void {
  resetUsenetSearch()
  fs.rmSync(USENET_SEARCH_FILE, { force: true })
  fs.rmSync(NZB_STORE_DIR, { recursive: true, force: true })
}

/**
 * Resets the finder, the Prowlarr client, the ledger and both schedulers' pacing, and routes `fetch` to the
 * fakes. Everything is put back when the test ends.
 */
function setup(t: TestContext): Fake {
  const router: RouterState = { calls: [], sabQueue: [] }
  const restoreRouter = installRouter(router)
  const routed = globalThis.fetch
  const pacing = { ...searchScheduler.options }
  const hashPacing = { ...usenetScheduler.options }
  forgetSearches()
  resetProwlarrRuntime()
  searchScheduler.options.minIntervalMs = 0
  usenetScheduler.options.minIntervalMs = 0
  const fake: Fake = {
    calls: [],
    indexers: [GEEK],
    posts: {},
    bodies: {},
    beforeNzb: async () => {},
    redirect: false,
    animetosho: () => new Response('gone', { status: 404 }),
    sent: [],
    router,
  }
  const sendNzb = async (link: string) => {
    await fake.beforeNzb()
    return new Response(fake.bodies[link] ?? exactNzb(link))
  }
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    if (url.origin === PROWLARR) {
      fake.calls.push(url)
      if (headers.get('x-api-key') !== KEY) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/api/v1/indexer') return Response.json(fake.indexers)
      const search = url.pathname.match(/^\/(\d+)\/api$/)
      if (search) {
        const tag = (url.searchParams.get('q') ?? '').replace(/^Vault /, '')
        const posts = fake.posts[tag] ?? [{ title: `[Vault] ${tag} (BD 1080p)`, link: tag, size: 1.08 }]
        return feed(Number(search[1]), posts)
      }
      if (/^\/\d+\/download$/.test(url.pathname)) {
        const link = url.searchParams.get('link') ?? ''
        if (!fake.redirect) return sendNzb(link)
        const location = `${DOWNLOAD_HOST}/getnzb?id=${encodeURIComponent(link)}&apikey=${INDEXER_SECRET}`
        return new Response(null, { status: 301, headers: { location } })
      }
      throw new Error(`unexpected Prowlarr request: ${url.pathname}`)
    }
    if (url.origin === DOWNLOAD_HOST) {
      fake.calls.push(url)
      // The indexer must never receive the Prowlarr API key.
      if (headers.get('x-api-key')) return new Response('leaked', { status: 400 })
      return sendNzb(url.searchParams.get('id') ?? '')
    }
    if (url.href.includes('animetosho.net/json')) return fake.animetosho(url.searchParams.get('hash') ?? '')
    if (url.origin === SAB && init?.method === 'POST') {
      const form = init.body as FormData
      const job = {
        nzb: await (form.get('name') as Blob).text(),
        name: String(form.get('nzbname')),
        category: String(form.get('cat')),
      }
      fake.sent.push(job)
      const id = `nzo_review_${fake.sent.length}`
      router.sabQueue!.push({
        nzo_id: id,
        status: 'Downloading',
        filename: job.name,
        cat: job.category,
        mb: '4200',
        mbleft: '4000',
        percentage: '5',
      })
      return Response.json({ status: true, nzo_ids: [id] })
    }
    return routed(input, init)
  }
  t.after(() => {
    restoreRouter()
    Object.assign(searchScheduler.options, pacing)
    Object.assign(usenetScheduler.options, hashPacing)
    forgetSearches()
    resetProwlarrRuntime()
  })
  return fake
}

/** Queries sent to the indexer so far. */
const searches = (fake: Fake) =>
  fake.calls.filter(url => /^\/\d+\/api$/.test(url.pathname)).map(url => url.searchParams.get('q'))
/** Links of the NZBs fetched through Prowlarr so far: one grab each. */
const downloads = (fake: Fake) =>
  fake.calls.filter(url => /^\/\d+\/download$/.test(url.pathname)).map(url => url.searchParams.get('link'))
/** Searches and fetches so far; reading the indexer list costs neither. */
const spent = (fake: Fake) => searches(fake).length + downloads(fake).length

type Work = NonNullable<Parameters<typeof usenetAvailability>[3]>

/**
 * Sends one availability request with the work it names, then reads snapshots as the browser's observer does
 * until no row reports a search or a check under way.
 */
async function observe(
  settings: Config,
  rows: { key: string; release: number }[],
  results: ResultItem[],
  work: Work = {},
): Promise<UsenetAvailabilityResult[]> {
  let snapshot = await usenetAvailability(settings, rows, results, work)
  const deadline = Date.now() + 10_000
  while (snapshot.some(entry => entry.refreshing)) {
    assert.ok(Date.now() < deadline, 'Usenet availability never settled')
    await nextTurn()
    snapshot = await usenetAvailability(settings, rows, results)
  }
  return snapshot
}

async function accept(
  settings: Config,
  plan: { id: string },
  results: ResultItem[],
  acknowledge: { whole_source?: boolean; disk_space?: boolean } = { disk_space: true },
) {
  const { completion } = await acceptDownloadPlan(settings, consumePlan(plan.id)!, acknowledge, results)
  return completion
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { opened: promise, open: () => resolve() }
}

/** Nothing that lets a browser fetch from Prowlarr or from the indexer may appear in what it is sent. */
function assertNoReference(sent: unknown, what: string): void {
  const json = JSON.stringify(sent)
  for (const secret of [KEY, INDEXER_SECRET, 'apikey', 'link=', '/download', new URL(DOWNLOAD_HOST).host])
    assert.ok(!json.includes(secret), `${what} contains ${secret}`)
}

// --- Phase 2: persistence -----------------------------------------------------------

test('a proven match survives a restart, and a bulk review then plans and sends it without asking Prowlarr', async t => {
  const fake = setup(t)
  const results = [privateRow('Alpha'), privateRow('Beta')]
  const rows = [row('Alpha'), row('Beta')]
  const [searched] = await observe(config(), [row('Alpha')], results, { search: [row('Alpha')] })
  assert.deepEqual([searched.aggregate, searched.hashes[0].proof], ['available', 'exact'])
  assert.deepEqual([searches(fake), downloads(fake)], [['Vault Alpha'], ['Alpha']])

  // The server restarts between "Search Prowlarr" and the bulk download.
  resetUsenetSearch(true)
  resetProwlarrRuntime()
  fake.calls.length = 0
  const built = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(
    built.review.units.map(unit => [unit.source_hash, unit.status, unit.provider, unit.proof]),
    [[show('Alpha').id, 'new', 'prowlarr', 'exact']],
  )
  assert.deepEqual(built.review.blocked, [
    {
      key: 'beta',
      release: 0,
      code: 'not_searched',
      reason: 'This release has not been searched on Usenet yet. Open the review again, or search it in its details.',
    },
  ])
  assert.equal(built.review.requires_whole_ack, false)

  const outcome = await accept(config(), built.plan, results)
  assert.deepEqual(
    outcome.rows.map(entry => [entry.key, entry.status]),
    [
      ['alpha', 'added'],
      ['beta', 'failed'],
    ],
  )
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0].nzb, text(exactNzb('Alpha')), 'SABnzbd gets the bytes that were checked')
  assert.equal(fake.sent[0].name, '[Vault] Alpha (BD 1080p)')
  assert.deepEqual(fake.calls, [], 'neither the review nor the submission asked Prowlarr anything')

  // The copy is owned under the file-list identity of the private release, and a new review finds it.
  const [record] = downloadRecords()
  assert.deepEqual(
    [record.protocol, record.source_hash, record.provider, record.proof, record.entry_id],
    ['usenet', show('Alpha').id, 'prowlarr', 'exact', entryOf('Alpha')],
  )
  const again = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(
    again.review.units.map(unit => [unit.status, unit.existing_record_id]),
    [['existing', record.id]],
  )
  assert.equal(again.review.new_nzbs, 0)
  assert.deepEqual(fake.calls, [])
})

// --- Phase 5: proof levels ----------------------------------------------------------

test('a near-exact NZB is planned without a confirmation and labelled on the unit and in the ledger', async t => {
  const fake = setup(t)
  fake.bodies.Alpha = nearExactNzb('Alpha')
  const results = [privateRow('Alpha')]
  const [checked] = await observe(config(), [row('Alpha')], results, { verify: [row('Alpha')] })
  assert.deepEqual([checked.aggregate, checked.hashes[0].proof], ['available', 'near_exact'])

  const built = await buildDownloadPlan(config(), [row('Alpha'), { key: 'gone', release: 0 }], { results })
  assert.deepEqual(
    built.review.units.map(unit => [unit.status, unit.proof, unit.whole_source, unit.scope_expanded]),
    [['new', 'near_exact', true, false]],
  )
  assert.equal(built.review.requires_whole_ack, false)
  assert.deepEqual(
    built.review.blocked.map(blocked => blocked.key),
    ['gone'],
  )
  assert.deepEqual(built.plan.selections, [
    { key: 'alpha', release: 0, identity: built.plan.selections[0].identity, protocol: 'usenet' },
  ])

  await accept(config(), built.plan, results)
  assert.equal(fake.sent[0].nzb, text(nearExactNzb('Alpha')))
  assert.deepEqual(
    downloadRecords().map(record => [record.source_hash, record.proof]),
    [[show('Alpha').id, 'near_exact']],
  )
  assert.deepEqual(downloads(fake), ['Alpha'])
})

test('probable, size-only and unverified candidates are sent only when chosen, and never for a torrent row', async t => {
  const fake = setup(t)
  const links = ['probable', 'size_only', 'unverified', 'unopened']
  fake.posts.Alpha = links.map((link, index) => ({
    title: `[Vault] Alpha ${index + 1}`,
    link,
    size: 1.08 + index * 0.02,
  }))
  Object.assign(fake.bodies, { probable: probableNzb('Alpha'), size_only: SIZE_ONLY_NZB, unverified: OTHER_NZB })
  const results = [privateRow('Alpha')]
  const [searched] = await observe(config(), [row('Alpha')], results, { search: [row('Alpha')] })
  assert.equal(searched.aggregate, 'no_match')
  assert.deepEqual(
    searched.hashes[0].candidates?.map(candidate => [candidate.entry_id, candidate.checked, candidate.proof]),
    [
      [entryOf('probable'), true, 'probable'],
      [entryOf('size_only'), true, 'size_only'],
      [entryOf('unverified'), true, 'unverified'],
      [entryOf('unopened'), false, undefined],
    ],
  )
  assert.deepEqual(downloads(fake), ['probable', 'size_only', 'unverified'])

  // On its own no review sends any of them, alone or in bulk, and none fetches another NZB.
  for (const selections of [[row('Alpha')], [row('Alpha'), { key: 'gone', release: 0 }]]) {
    const plain = await buildDownloadPlan(config(), selections, { results })
    assert.deepEqual(plain.review.units, [])
    const blocked = plain.review.blocked.find(entry => entry.key === 'alpha')
    assert.equal(blocked?.code, 'no_match')
    assert.match(blocked.reason, /Prowlarr found 4 possible NZBs; none of those checked so far could be shown/)
  }

  // Naming a checked candidate is the confirmation, whatever its NZB showed.
  for (const proof of ['probable', 'size_only', 'unverified'] as const) {
    const chosen = { ...row('Alpha'), protocol: 'usenet' as const, nzb: entryOf(proof) }
    const built = await buildDownloadPlan(config(), [chosen], { results })
    assert.deepEqual(built.review.blocked, [], proof)
    assert.deepEqual(
      built.review.units.map(unit => [unit.status, unit.provider, unit.proof]),
      [['new', 'prowlarr', proof]],
    )
    assert.equal(built.plan.selections[0].nzb, entryOf(proof))
  }
  // A candidate nobody fetched cannot be chosen, and neither can one that is not known.
  for (const link of ['unopened', 'elsewhere']) {
    const chosen = { ...row('Alpha'), protocol: 'usenet' as const, nzb: entryOf(link) }
    const refused = await buildDownloadPlan(config(), [chosen], { results })
    assert.deepEqual(refused.review.units, [])
    assert.deepEqual(refused.review.blocked, [
      {
        key: 'alpha',
        release: 0,
        code: 'not_searched',
        reason: 'The chosen NZB is no longer known or could not be fetched; search Prowlarr again.',
      },
    ])
  }

  // A choice only ever applies to Usenet: the request is refused, and a torrent row that carries one is not sent.
  const torrent = { ...row('Alpha'), protocol: 'torrent', nzb: entryOf('probable') }
  assert.throws(() => parseSelections([torrent]), /A chosen NZB needs the Usenet protocol/)
  assert.throws(() => parseSelections([{ ...row('Alpha'), nzb: entryOf('probable') }]), /needs the Usenet protocol/)
  const asTorrent = await buildDownloadPlan(
    config({ download_mode: 'choose' }),
    [torrent as { key: string; release: number; protocol: 'torrent'; nzb: string }],
    { results },
  )
  assert.deepEqual(asTorrent.review.units, [])
  assert.deepEqual(
    asTorrent.review.blocked.map(blocked => [blocked.code, blocked.reason]),
    [['invalid', 'A chosen NZB can only be sent over Usenet.']],
  )

  // The chosen NZB is sent as it was checked, with its proof on the ledger record.
  const chosen = { ...row('Alpha'), protocol: 'usenet' as const, nzb: entryOf('size_only') }
  const built = await buildDownloadPlan(config(), [chosen], { results })
  await accept(config(), built.plan, results)
  assert.equal(fake.sent[0].nzb, text(SIZE_ONLY_NZB))
  assert.deepEqual(
    downloadRecords().map(record => [record.source_hash, record.entry_id, record.proof]),
    [[show('Alpha').id, entryOf('size_only'), 'size_only']],
  )
  assert.deepEqual(downloads(fake), ['probable', 'size_only', 'unverified'], 'no NZB was fetched a second time')
  assert.deepEqual(searches(fake), ['Vault Alpha'], 'and no review searched again')
})

// --- Phase 6: bulk verification -----------------------------------------------------

test('a bulk review checks one NZB for each row it names, plans the proven ones and keeps the rest blocked', async t => {
  const fake = setup(t)
  fake.posts.Beta = [
    { title: '[Vault] Beta (BD 1080p)', link: 'beta-first', size: 1.08 },
    { title: '[Vault] Beta (BD 1080p) repost', link: 'beta-second', size: 1.12 },
  ]
  Object.assign(fake.bodies, { 'beta-first': OTHER_NZB, 'beta-second': exactNzb('Beta') })
  const results = [privateRow('Alpha'), privateRow('Beta'), privateRow('Gamma')]
  const rows = [row('Alpha'), row('Beta'), row('Gamma')]
  const named = [row('Alpha'), row('Beta')]

  const [alpha, beta, gamma] = await observe(config(), rows, results, { verify: named })
  assert.deepEqual(searches(fake).sort(), ['Vault Alpha', 'Vault Beta'])
  assert.deepEqual(downloads(fake).sort(), ['Alpha', 'beta-first'], 'one NZB for each source')
  assert.deepEqual([alpha.aggregate, alpha.search, alpha.hashes[0].proof], ['available', 'prowlarr', 'exact'])
  // The best candidate proved nothing: the row lists what was found, and the other candidate stays unopened.
  assert.equal(beta.aggregate, 'no_match')
  assert.equal(beta.hashes[0].candidate_count, 2)
  assert.deepEqual(
    beta.hashes[0].candidates?.map(candidate => [candidate.entry_id, candidate.checked, candidate.proof]),
    [
      [entryOf('beta-first'), true, 'unverified'],
      [entryOf('beta-second'), false, undefined],
    ],
  )
  assert.deepEqual([gamma.aggregate, gamma.search, gamma.refreshing], ['not_checked', 'prowlarr', false])

  // Naming the rows again changes nothing: what was concluded stands, and no second NZB is fetched.
  await observe(config(), rows, results, { verify: named })
  await observe(config(), rows, results, { verify: named, refresh: true })
  assert.equal(spent(fake), 4)
  // Not even a search, when one is due because Prowlarr has an indexer the stored results do not know.
  fake.indexers = [GEEK, { ...GEEK, id: 5, name: 'Slug' }]
  resetProwlarrRuntime()
  await observe(config(), rows, results, { verify: named })
  assert.equal(spent(fake), 4)
  fake.indexers = [GEEK]
  resetProwlarrRuntime()

  // The review that follows reads what is stored. The row nobody named is neither searched nor fetched.
  const built = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(
    built.review.units.map(unit => [unit.source_hash, unit.proof]),
    [[show('Alpha').id, 'exact']],
  )
  assert.deepEqual(
    built.review.blocked.map(blocked => [blocked.key, blocked.code]),
    [
      ['beta', 'no_match'],
      ['gamma', 'not_searched'],
    ],
  )
  assert.match(built.review.blocked[0].reason, /^Not found on Usenet indexers\. Prowlarr found 2 possible NZBs; none/)
  const outcome = await accept(config(), built.plan, results)
  assert.deepEqual(
    outcome.rows.map(entry => entry.status),
    ['added', 'failed', 'failed'],
  )
  assert.equal(fake.sent.length, 1)
  assert.equal(spent(fake), 4, 'neither the review nor the acceptance searched or fetched')
  assert.equal(searchSnapshot(config(), show('Gamma').id).availability.state, 'not_checked')
})

test('rows beyond the daily fetch limit stay unchecked and say when the next check is possible', async t => {
  const fake = setup(t)
  const limited = config({ prowlarr_fetch_limit: 1 })
  const results = [privateRow('Alpha'), privateRow('Beta')]
  const rows = [row('Alpha'), row('Beta')]
  const checked = await observe(limited, rows, results, { verify: rows })
  assert.equal(downloads(fake).length, 1)
  assert.deepEqual(checked.map(entry => entry.aggregate).sort(), ['available', 'unverified'])
  const waiting = checked.find(entry => entry.aggregate === 'unverified')!
  const reason = /Daily NZB check limit reached for Geek\. Next check at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.$/
  assert.match(waiting.hashes[0].error ?? '', reason)
  assert.equal(waiting.hashes[0].error_code, undefined, 'a reached limit is no failure')
  const [usage] = prowlarrIndexerUsage(limited)
  assert.deepEqual([usage.indexer, usage.fetches_left], ['Geek', 0])

  const built = await buildDownloadPlan(limited, rows, { results })
  assert.equal(built.review.units.length, 1)
  assert.deepEqual(
    built.review.blocked.map(blocked => [blocked.key, blocked.code]),
    [[waiting.key, 'not_verified']],
  )
  assert.match(built.review.blocked[0].reason, /^Usenet results for this release have not been checked yet\. Daily/)
  assert.match(built.review.blocked[0].reason, reason)
  // Naming the row again spends nothing while the limit stands.
  await observe(limited, rows, results, { verify: rows })
  assert.equal(downloads(fake).length, 1)
})

test('accepting a plan spends no search and no fetch, also when its stored result has disappeared', async t => {
  const fake = setup(t)
  const results = [privateRow('Alpha')]
  // A review of one release searches and checks by itself.
  const built = await buildDownloadPlan(config(), [row('Alpha')], { results })
  assert.deepEqual(
    built.review.units.map(unit => unit.proof),
    ['exact'],
  )
  assert.deepEqual([searches(fake), downloads(fake)], [['Vault Alpha'], ['Alpha']])
  // Opening it again costs nothing more.
  const reopened = await buildDownloadPlan(config(), [row('Alpha')], { results })
  assert.equal(reopened.review.units.length, 1)
  assert.equal(spent(fake), 2)

  // The stored result is gone by the time the plan is confirmed.
  forgetSearches()
  fake.calls.length = 0
  const outcome = await accept(config(), built.plan, results)
  assert.equal(outcome.ok, false)
  assert.deepEqual(
    outcome.failures.map(failure => [failure.code, failure.error]),
    [
      [
        'not_searched',
        'This release has not been searched on Usenet yet. Open the review again, or search it in its details.',
      ],
    ],
  )
  assert.equal(spent(fake), 0)
  assert.equal(fake.sent.length, 0)
  assert.deepEqual(downloadRecords(), [])

  // With the result in place, the other plan is sent from the store alone.
  await buildDownloadPlan(config(), [row('Alpha')], { results })
  fake.calls.length = 0
  resetProwlarrRuntime()
  const sent = await accept(config(), reopened.plan, results)
  assert.equal(sent.ok, true)
  assert.equal(fake.sent[0].nzb, text(exactNzb('Alpha')))
  assert.deepEqual(fake.calls, [])
})

test('cancelling a review drops the checks that wait, and the one under way finishes', async t => {
  const fake = setup(t)
  const hang = gate()
  fake.beforeNzb = () => hang.opened
  // One request at a time, so every check behind the first waits for its slot.
  searchScheduler.options.concurrency = 1
  const tags = ['Alpha', 'Beta', 'Gamma']
  const results = tags.map(tag => privateRow(tag))
  const rows = tags.map(row)
  // The rows were searched before, as the background search does: only the checks are left.
  for (const tag of tags) await searchSource(config(), show(tag), { titles: [tag], releaseGroup: 'Vault' })
  assert.equal(searches(fake).length, 3)

  const started = await usenetAvailability(config(), rows, results, { verify: rows })
  assert.deepEqual(
    started.map(entry => [entry.aggregate, entry.refreshing]),
    rows.map(() => ['unverified', true]),
  )
  for (let turn = 0; turn < 500 && downloads(fake).length < 1; turn++) await nextTurn()
  assert.deepEqual(downloads(fake), ['Alpha'])

  // The dialog closes, or its rows are switched to torrents.
  const [fetching] = await usenetAvailability(config(), rows, results, { cancelVerify: rows })
  assert.equal(fetching.refreshing, true, 'the fetch that was already sent goes on')
  hang.open()
  const settled = await observe(config(), rows, results)
  assert.deepEqual(
    settled.map(entry => [entry.aggregate, entry.hashes[0].proof]),
    [
      ['available', 'exact'],
      ['unverified', undefined],
      ['unverified', undefined],
    ],
  )
  assert.deepEqual(downloads(fake), ['Alpha'], 'no further NZB was fetched')
  assert.equal(searches(fake).length, 3)

  const built = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(
    built.review.blocked.map(blocked => [blocked.key, blocked.code, blocked.reason]),
    ['beta', 'gamma'].map(key => [key, 'not_verified', 'Usenet results for this release have not been checked yet.']),
  )
  // A cancelled check is no verdict: selecting the row again checks it.
  const [, beta] = await observe(config(), rows, results, { cancelVerify: [row('Beta')], verify: [row('Beta')] })
  assert.deepEqual([beta.aggregate, beta.hashes[0].proof], ['available', 'exact'])
  assert.deepEqual(downloads(fake), ['Alpha', 'Beta'])
})

// --- Section 19: what must not change -----------------------------------------------

test('a hash-linked NZB is used as before, and a failed or processing hash lookup never starts a Prowlarr search', async t => {
  const fake = setup(t)
  const hashes = { Linked: 'a1'.repeat(20), Failing: 'b2'.repeat(20), Pending: 'c3'.repeat(20) }
  fake.animetosho = hash => {
    if (hash === hashes.Linked) return animetoshoMatch(hash)
    if (hash === hashes.Failing) return new Response('down', { status: 500 })
    return Response.json({ id: 77, info_hash: hash, status: 'processing', title: 'Pending' })
  }
  const tags = ['Linked', 'Failing', 'Pending'] as const
  const results = tags.map(tag => publicRow(tag, hashes[tag]))
  const rows = tags.map(row)

  // Every row is named for a search and for a check; only the hash indexer is asked.
  const [linked, failing, pending] = await observe(config(), rows, results, { search: rows, verify: rows })
  assert.deepEqual(
    [linked.aggregate, linked.hashes[0].provider, linked.hashes[0].entry_id],
    ['available', 'animetosho', '1234'],
  )
  assert.deepEqual([linked.hashes[0].proof, linked.search, linked.fallback], [undefined, undefined, undefined])
  assert.deepEqual([failing.aggregate, failing.search, failing.fallback], ['lookup_failed', undefined, undefined])
  assert.deepEqual([pending.aggregate, pending.search, pending.fallback], ['processing', undefined, undefined])
  await observe(config(), rows, results, { search: rows, verify: rows, cancelVerify: rows })
  assert.equal(spent(fake), 0)

  // A review of one release may search Prowlarr, and still does not for these.
  const reviews = await Promise.all(rows.map(entry => buildDownloadPlan(config(), [entry], { results })))
  assert.deepEqual(
    reviews.map(built => built.review.blocked.map(blocked => blocked.code)),
    [[], ['lookup_failed'], ['processing']],
  )
  const bulk = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(
    bulk.review.blocked.map(blocked => [blocked.key, blocked.code]),
    [
      ['failing', 'lookup_failed'],
      ['pending', 'processing'],
    ],
  )
  assert.equal(spent(fake), 0)
  assert.equal(searchSnapshot(config(), hashes.Failing).availability.state, 'not_checked')

  // The linked release is planned, sent and owned as it always was.
  assert.deepEqual(
    bulk.review.units.map(unit => [unit.source_hash, unit.provider, unit.proof, unit.status]),
    [[hashes.Linked, 'animetosho', undefined, 'new']],
  )
  assert.ok(!('proof' in bulk.review.units[0]))
  await accept(config(), bulk.plan, results)
  assert.equal(fake.sent.length, 1)
  assert.match(fake.sent[0].nzb, /show-part-1@example\.test/, 'the NZB comes from the hash indexer')
  const [record] = downloadRecords()
  assert.deepEqual([record.source_hash, record.provider, record.entry_id], [hashes.Linked, 'animetosho', '1234'])
  assert.ok(!('proof' in record))
  assert.equal(spent(fake), 0)
})

test('public-tracker mode makes no Prowlarr request for a private-tracker release', async t => {
  const fake = setup(t)
  const results = [privateRow('Alpha')]
  const rows = [row('Alpha')]
  for (const mode of ['usenet_only', 'choose'] as const) {
    const settings = config({ tracker_mode: 'public', download_mode: mode })
    const [shown] = await observe(settings, rows, results, { search: rows, verify: rows, cancelVerify: rows })
    assert.deepEqual([shown.aggregate, shown.search, shown.fallback], ['unsupported_hash', undefined, undefined])
    for (const selections of [rows, [...rows, { key: 'gone', release: 0 }]]) {
      const usenet = selections.map(entry => ({ ...entry, protocol: 'usenet' as const }))
      const built = await buildDownloadPlan(settings, usenet, { results })
      assert.deepEqual(built.review.units, [])
      assert.equal(built.review.blocked.find(blocked => blocked.key === 'alpha')?.code, 'no_match')
    }
  }
  const torrent = await buildDownloadPlan(config({ tracker_mode: 'public', download_mode: 'torrent_only' }), rows, {
    results,
  })
  assert.equal(torrent.review.blocked[0].code, 'no_torrent')
  assert.deepEqual(fake.calls, [])
  assert.equal(fs.existsSync(USENET_SEARCH_FILE), false)
})

test('a source requested through both protocols in one review is sent through neither', async t => {
  const fake = setup(t)
  const hash = 'd4'.repeat(20)
  // Two library rows share one public torrent, which the hash indexer does not have.
  const results = [publicRow('Delta', hash, 'one'), publicRow('Delta', hash, 'two')]
  const settings = config({ download_mode: 'choose' })
  assert.equal((await resolveUsenetHash(settings, hash)).state, 'no_match')
  const one = { key: 'one', release: 0 }
  const [found] = await observe(settings, [one], results, { verify: [one] })
  assert.deepEqual([found.aggregate, found.search, found.hashes[0].provider], ['available', 'prowlarr', 'prowlarr'])
  assert.deepEqual(found.hashes[0].providers_checked, ['animetosho'])
  assert.deepEqual(downloads(fake), ['Delta'])

  const both = await buildDownloadPlan(
    settings,
    [
      { ...one, protocol: 'usenet' },
      { key: 'two', release: 0, protocol: 'torrent' },
    ],
    { results },
  )
  assert.deepEqual(both.review.units, [])
  assert.deepEqual(both.review.blocked.map(blocked => [blocked.key, blocked.code]).sort(), [
    ['one', 'conflict'],
    ['two', 'conflict'],
  ])
  // Either protocol alone is planned.
  const usenet = await buildDownloadPlan(
    settings,
    [
      { ...one, protocol: 'usenet' },
      { key: 'gone', release: 0 },
    ],
    {
      results,
    },
  )
  assert.deepEqual(
    usenet.review.units.map(unit => [unit.protocol, unit.source_hash, unit.provider, unit.proof]),
    [['usenet', hash, 'prowlarr', 'exact']],
  )
  assert.deepEqual(downloads(fake), ['Delta'])
  assert.equal(fake.sent.length, 0)
})

test('a whole-source NZB with a selected-file scope needs the acknowledgement at exact and at near-exact', async t => {
  const fake = setup(t)
  fake.bodies.Beta = nearExactNzb('Beta')
  const scoped = (tag: string) => privateRow(tag, { selected_files: [show(tag).files[0].name] })
  const results = [scoped('Alpha'), scoped('Beta')]
  const rows = [row('Alpha'), row('Beta')]
  await observe(config(), rows, results, { verify: rows })

  const built = await buildDownloadPlan(config(), rows, { results })
  assert.deepEqual(built.review.blocked, [])
  assert.deepEqual(
    built.review.units.map(unit => [unit.proof, unit.whole_source, unit.scope_expanded, unit.scope_unknown]),
    [
      ['exact', true, true, true],
      ['near_exact', true, true, true],
    ],
  )
  assert.equal(built.review.requires_whole_ack, true)
  for (const tag of ['Alpha', 'Beta']) {
    const single = await buildDownloadPlan(config(), [row(tag)], { results })
    assert.equal(single.review.requires_whole_ack, true, tag)
    await assert.rejects(
      accept(config(), single.plan, results),
      (error: PlanRejected) => error.status === 409 && /whole Usenet sources/.test(error.message),
    )
  }
  assert.equal(fake.sent.length, 0)

  const outcome = await accept(config(), built.plan, results, { whole_source: true, disk_space: true })
  assert.equal(outcome.ok, true)
  assert.deepEqual(
    fake.sent.map(job => job.nzb),
    [text(exactNzb('Alpha')), text(nearExactNzb('Beta'))],
  )
  assert.deepEqual(
    downloadRecords()
      .map(record => record.proof)
      .sort(),
    ['exact', 'near_exact'],
  )
})

// --- Lifecycle and what the browser is sent -----------------------------------------

const SCHEDULE_FILE = join(DATA_DIR, 'scan_schedule_state.json')

/** Makes `settings` the saved configuration for one test, and puts back what was saved before. */
function storeConfig(t: TestContext, settings: Config): Config {
  const files = [CONFIG_FILE, ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE, SCHEDULE_FILE]
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
  return loadConfig()
}

test('a changed Prowlarr key or address leaves no usable record and no stored NZB behind, and a changed limit keeps both', async t => {
  const fake = setup(t)
  const results = [privateRow('Alpha')]
  const rows = [row('Alpha')]
  const source = show('Alpha')
  for (const change of [{ prowlarr_key: 'another-key-0d2e' }, { prowlarr_url: 'http://prowlarr-moved.test:9696' }]) {
    forgetSearches()
    fake.calls.length = 0
    const saved = storeConfig(t, config())
    const [checked] = await observe(saved, rows, results, { verify: rows })
    assert.equal(checked.aggregate, 'available')
    assert.equal(fs.readdirSync(NZB_STORE_DIR).length, 1)

    // The daily limits are settings of their own: nothing is forgotten when one changes.
    const relimited = saveSettings({ prowlarr_fetch_limit: 5, prowlarr_search_limit: 50 })
    assert.equal(searchSnapshot(relimited, source.id).availability.state, 'available')
    assert.deepEqual(prowlarrIndexerUsage(relimited), [{ indexer: 'Geek', fetches_left: 4 }])
    assert.equal(fs.readdirSync(NZB_STORE_DIR).length, 1)

    const changed = saveSettings(change)
    assert.equal(searchSnapshot(changed, source.id).availability.state, 'not_checked')
    assert.equal(chosenSearchCandidate(changed, source.id, entryOf('Alpha')), undefined)
    assert.deepEqual(fs.readdirSync(NZB_STORE_DIR), [])
    const stored = fs.readFileSync(USENET_SEARCH_FILE, 'utf8')
    assert.ok(!stored.includes(source.id) && !stored.includes('"link"'), 'the record is gone from the file as well')
    const built = await buildDownloadPlan(changed, [...rows, { key: 'gone', release: 0 }], { results })
    assert.equal(built.review.blocked.find(blocked => blocked.key === 'alpha')?.code, 'not_searched')
    // Going back to the old connection does not bring the record back.
    resetUsenetSearch(true)
    assert.equal(searchSnapshot(saved, source.id).availability.state, 'not_checked')
    assert.deepEqual(downloads(fake), ['Alpha'])
  }
})

/** Posts to a download route as the browser does, and returns what it answered. */
async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  request.method = 'POST'
  const answer = { status: 0, text: '' }
  const response = {
    writeHead: (status: number) => {
      answer.status = status
    },
    end: (data: Buffer) => {
      answer.text = data.toString('utf8')
    },
  } as unknown as ServerResponse
  const url = new URL(`http://companion.test${path}`)
  await matchRoute(downloadRoutes, 'POST', url.pathname)!.route.handle({ request, response, url, params: [] })
  return answer
}

test('the availability response and the review carry no download reference, no key and no indexer address with a credential', async t => {
  const fake = setup(t)
  fake.redirect = true
  fake.posts.Beta = [
    { title: '[Vault] Beta (BD 1080p)', link: 'beta-first', size: 1.08 },
    { title: '[Vault] Beta (BD 1080p) repost', link: 'beta-second', size: 1.12 },
  ]
  fake.bodies['beta-first'] = OTHER_NZB
  const results = [privateRow('Alpha'), privateRow('Beta')]
  const rows = [row('Alpha'), row('Beta')]
  storeConfig(t, config())
  setState({ results })
  t.after(() => setState({ results: [] }))

  const availability = async (work: Record<string, unknown> = {}) => {
    const answer = await post('/api/usenet/availability', { selections: rows, ...work })
    assert.equal(answer.status, 200)
    assertNoReference(answer.text, 'the availability response')
    return JSON.parse(answer.text) as UsenetAvailabilityResponse
  }
  let shown = await availability({ verify: rows })
  for (let turn = 0; turn < 5000 && shown.results.some(entry => entry.refreshing); turn++) {
    await nextTurn()
    shown = await availability()
  }
  assert.deepEqual(
    shown.results.map(entry => [entry.key, entry.aggregate, entry.refreshing]),
    [
      ['alpha', 'available', false],
      ['beta', 'no_match', false],
    ],
  )
  // The NZBs came from the indexer's own address, which Prowlarr redirected to.
  assert.deepEqual(
    fake.calls
      .filter(url => url.origin === DOWNLOAD_HOST)
      .map(url => url.searchParams.get('id'))
      .sort(),
    ['Alpha', 'beta-first'],
  )
  assert.equal(shown.prowlarr_configured, true)
  assert.deepEqual(shown.prowlarr_usage, [{ indexer: 'Geek', fetches_left: 18 }])
  // A candidate is named by an opaque ID and linked to its page, without the credential the indexer added.
  assert.deepEqual(
    shown.results[1].hashes[0].candidates?.map(candidate => [candidate.entry_id, candidate.info_url]),
    [
      [entryOf('beta-first'), pageOf('beta-first')],
      [entryOf('beta-second'), pageOf('beta-second')],
    ],
  )
  // The other request fields are read the same way, and a malformed row is refused.
  assert.equal((await availability({ search: [], cancel_verify: rows, verify: [row('Alpha')] })).results.length, 2)
  await assert.rejects(
    post('/api/usenet/availability', { selections: rows, verify: [{ key: 'alpha' }] }),
    /Release must be/,
  )
  await assert.rejects(
    post('/api/usenet/availability', { selections: rows, cancel_verify: [{ release: 0 }] }),
    /No key/,
  )
  assert.deepEqual(downloads(fake).sort(), ['Alpha', 'beta-first'])

  const review = await post('/api/download_bulk/preflight', { selections: rows })
  assert.equal(review.status, 200)
  assertNoReference(review.text, 'the review')
  const { units, blocked } = JSON.parse(review.text) as Awaited<ReturnType<typeof buildDownloadPlan>>['review']
  assert.deepEqual(
    units.map(unit => Object.keys(unit).sort()),
    [
      [
        'approximate',
        'category',
        'client',
        'labels',
        'nzb_name',
        'proof',
        'protocol',
        'provider',
        'scope_expanded',
        'scope_unknown',
        'selections',
        'size_bytes',
        'source_hash',
        'status',
        'unit_id',
        'whole_source',
      ],
    ],
    'a unit carries neither its entry nor the file list it was checked against',
  )
  assert.deepEqual(
    blocked.map(entry => entry.code),
    ['no_match'],
  )
})

test('with Prowlarr turned off, availability neither reports a Prowlarr state nor reads the search store', async t => {
  const fake = setup(t)
  const hash = 'e5'.repeat(20)
  const results = [privateRow('Alpha'), publicRow('Epsilon', hash)]
  const rows = [row('Alpha'), row('Epsilon')]
  await resolveUsenetHash(config(), hash)
  const found = await observe(config(), rows, results, { verify: rows })
  assert.deepEqual(
    found.map(entry => [entry.aggregate, entry.search]),
    [
      ['available', 'prowlarr'],
      ['available', 'prowlarr'],
    ],
  )

  // After a restart the store is read on first use. With its file out of the way, a read would find nothing.
  resetUsenetSearch(true)
  resetProwlarrRuntime()
  const aside = `${USENET_SEARCH_FILE}.aside`
  fs.renameSync(USENET_SEARCH_FILE, aside)
  t.after(() => fs.rmSync(aside, { force: true }))
  fake.calls.length = 0
  const off = config({ prowlarr_enabled: false })
  const hidden = await observe(off, rows, results, { search: rows, verify: rows, cancelVerify: rows })
  assert.deepEqual(
    hidden.map(entry => [entry.aggregate, entry.search, entry.fallback, entry.hashes[0].provider]),
    [
      ['unsupported_hash', undefined, undefined, undefined],
      ['no_match', undefined, undefined, undefined],
    ],
  )
  assert.deepEqual(prowlarrIndexerUsage(off), [])
  assert.deepEqual(fake.calls, [])
  assert.equal(fs.existsSync(USENET_SEARCH_FILE), false, 'nothing was written either')

  // The store was not touched: with Prowlarr on again, what it holds is still there to be read.
  fs.renameSync(aside, USENET_SEARCH_FILE)
  const back = await observe(config(), rows, results)
  assert.deepEqual(
    back.map(entry => [entry.aggregate, entry.hashes[0].proof]),
    [
      ['available', 'exact'],
      ['available', 'exact'],
    ],
  )
  assert.equal(spent(fake), 0)
})

// --- Ledger -------------------------------------------------------------------------

test('a ledger record without a proof loads unchanged, and a proof this version does not know is dropped', t => {
  const file = join(DATA_DIR, 'owned_downloads.json')
  resetOwnedRuntime()
  purgeTestDataDir()
  t.after(() => {
    resetOwnedRuntime()
    purgeTestDataDir()
  })
  const record = (id: string, proof?: string) => ({
    id,
    protocol: 'usenet',
    client: 'sabnzbd',
    endpoint: 'sab',
    native_id: `nzo_${id}`,
    state: 'accepted',
    source_hash: show(id).id,
    category: 'sonarr-anime',
    provider: 'prowlarr',
    entry_id: entryOf(id),
    added_at: '2026-11-26T10:00:00.000Z',
    updated_at: '2026-11-26T10:00:00.000Z',
    labels: [],
    ...(proof ? { proof } : {}),
  })
  const stored = [
    record('before'),
    record('near', 'near_exact'),
    record('later', 'certified'),
    record('odd', 'constructor'),
  ]
  fs.writeFileSync(file, JSON.stringify({ version: 2, records: stored, rows: {} }))
  resetOwnedRuntime()
  const loaded = downloadRecords()
  assert.deepEqual(loaded[0], stored[0], 'a record from before proofs were stored is read as it is')
  assert.deepEqual(
    loaded.map(entry => [entry.id, entry.proof, 'proof' in entry]),
    [
      ['before', undefined, false],
      ['near', 'near_exact', true],
      ['later', undefined, false],
      ['odd', undefined, false],
    ],
  )
})
