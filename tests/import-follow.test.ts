import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { DATA_DIR } from '../server/paths.js'
import {
  addDownloadRecord,
  findDownloadRecord,
  resetOwnedRuntime,
  setDownloadPhase,
  updateDownloadImport,
  type NewDownloadRecord,
} from '../server/download-store.js'
import {
  followImports,
  importsToFollow,
  queueProblem,
  resetImportFollowRuntime,
  settleImports,
  type ArrQueueItem,
  type FollowDependencies,
  type ImportProblem,
} from '../server/import-follow.js'
import { downloadClients } from '../server/download-clients.js'
import { collectDownloadProgress } from '../server/download-progress.js'
import { applyConfigUpdate, DEFAULT_CONFIG } from '../server/config.js'
import { qbEndpointId } from '../server/client-identity.js'
import { resetQbRuntime } from '../server/qbittorrent.js'
import { sendImportProblem } from '../server/notifications.js'
import { filesSourceId } from '../server/source-files.js'
import { rejectSearchCandidate, resolveSource, searchSnapshot, verifySource } from '../server/usenet-search.js'
import { candidateEntryId } from '../server/usenet-search-terms.js'
import { testUsenetRuntime } from './support/usenet-runtime.js'
import type { ArrInstance } from '../shared/arr-instances.js'
import type { Config, PrivateSource, ResultItem } from '../server/types.js'

const ledgerFile = join(DATA_DIR, 'owned_downloads.json')
const cleanLedger = () => {
  rmSync(ledgerFile, { force: true })
  rmSync(`${ledgerFile}.tmp`, { force: true })
  resetOwnedRuntime()
  resetImportFollowRuntime()
}
beforeEach(cleanLedger)
after(cleanLedger)

const hash = 'a'.repeat(40)
const MINUTE = 60_000
const config: Config = applyConfigUpdate(
  {
    ...DEFAULT_CONFIG,
    sonarr_url: 'http://sonarr',
    sonarr_key: 'key',
    qbittorrent_url: 'http://qbit',
    qbittorrent_user: 'user',
    qbittorrent_pass: 'pass',
    webhook: 'https://discord.test/hook',
  },
  { arr_instances: [{ id: 'uhd4k', kind: 'sonarr', name: 'Sonarr 4K', url: 'http://sonarr4k', key: 'key' }] },
)

function record(changes: Partial<NewDownloadRecord> = {}) {
  return addDownloadRecord({
    protocol: 'torrent',
    client: 'qbittorrent',
    endpoint: qbEndpointId(config),
    state: 'accepted',
    source_hash: hash,
    category: 'sonarr-anime',
    card: { title: 'Show', season: 1, part: '', release_group: 'Best', tracker: 'Nyaa', size: 100 },
    labels: ['Show S01 [Best]'],
    rows: [{ key: 'Sonarr:42:1:Best', release: 0 }],
    library: [{ key: 'Sonarr:item10', season: 1, part: '', group: 'Best' }],
    ...changes,
  })
}
const tracking = (id: string) => findDownloadRecord(id)!.import!

function result(changes: Partial<ResultItem> = {}): ResultItem {
  return {
    key: 'Sonarr:42:1:Best',
    group_id: 42,
    arr: 'Sonarr',
    title: 'Show',
    season: 1,
    status: 'upgrade',
    have: ['Old'],
    local_size: 0,
    best_group: 'Best',
    best_size: 0,
    library_key: 'Sonarr:item10',
    url: null,
    notes: null,
    image: null,
    banner: null,
    anilist_id: 42,
    arr_url: null,
    releases: [
      {
        kind: 'best',
        releaseGroup: 'Best',
        tracker: 'Nyaa',
        quality: '',
        tags: [],
        size: 0,
        info_hashes: [hash],
        torrent_available: true,
      },
    ],
    ...changes,
  }
}

/** Follow-up dependencies driven by a clock and a queue the test controls. */
function harness(startedAt: number) {
  const state = {
    now: startedAt,
    queue: [] as ArrQueueItem[],
    queueError: '',
    scanning: false,
    scans: [] as string[],
    problems: [] as ImportProblem[],
    reads: 0,
  }
  const dependencies: FollowDependencies = {
    readProgress: async () => {
      state.reads += 1
    },
    readQueue: async () => {
      if (state.queueError) throw new Error(state.queueError)
      return state.queue
    },
    requestScan: (instance: ArrInstance, itemId: number) => {
      state.scans.push(`${instance.id}:${itemId}`)
    },
    notify: async (_config, problem) => {
      state.problems.push(problem)
      return true
    },
    scanRunning: () => state.scanning,
    now: () => state.now,
  }
  return { state, tick: (config_ = config) => followImports(config_, dependencies) }
}

test('only downloads with known library seasons are followed, starting when they finish', () => {
  const untracked = record({ library: undefined, source_hash: 'b'.repeat(40) })
  assert.equal(untracked.import, undefined)
  assert.equal(importsToFollow(), false)
  const followed = record()
  assert.equal(followed.import?.state, 'waiting')
  assert.deepEqual(followed.library, [{ key: 'Sonarr:item10', season: 1, part: '', group: 'Best' }])
  setDownloadPhase(followed.id, 'downloading')
  assert.equal(tracking(followed.id).state, 'waiting')
  setDownloadPhase(followed.id, 'seeding')
  assert.equal(tracking(followed.id).state, 'pending')
  assert.ok(tracking(followed.id).completed_at)
  setDownloadPhase(followed.id, 'complete')
  assert.equal(tracking(followed.id).state, 'pending', 'A later phase does not restart the wait')
  resetOwnedRuntime()
  assert.equal(tracking(followed.id).state, 'pending', 'The state survives a restart')
  assert.equal(importsToFollow(), true)
})

test('an import is confirmed by the library holding the release, not by anything Sonarr says', () => {
  const download = record()
  setDownloadPhase(download.id, 'complete')
  assert.equal(settleImports([result()]), 0, 'The season still holds the old release')
  assert.equal(
    settleImports([result({ library_key: 'Sonarr:item99' })]),
    0,
    'A season that is not in the results proves nothing',
  )
  assert.equal(settleImports([result({ status: 'best', have: ['Best'] })]), 1)
  assert.equal(tracking(download.id).state, 'imported')
  assert.equal(
    settleImports([result({ status: 'best', have: ['Best'] })]),
    0,
    'A confirmed import is not counted again',
  )
})

test('a file-size mismatch after import keeps the download unconfirmed', () => {
  const download = record()
  setDownloadPhase(download.id, 'complete')
  assert.equal(settleImports([result({ have: ['Best'], mismatched_by_part: { '': ['Best'] } })]), 0)
  assert.equal(tracking(download.id).state, 'pending')
  // The recommendation moved on, but the files of the downloaded group are in the library.
  assert.equal(
    settleImports([
      result({
        have: ['Best'],
        best_group: 'Newer',
        releases: [
          {
            kind: 'best',
            releaseGroup: 'Newer',
            tracker: 'Nyaa',
            quality: '',
            tags: [],
            size: 0,
            info_hashes: [hash],
            torrent_available: true,
          },
        ],
      }),
    ]),
    1,
  )
})

test('the queue of Sonarr explains a stuck import in its own words', async () => {
  assert.equal(queueProblem({ downloadId: hash, state: 'downloading', status: 'ok', messages: [] }, 'Sonarr'), null)
  assert.equal(
    queueProblem({ downloadId: hash, state: 'importPending', status: 'ok', messages: ['Waiting'] }, 'Sonarr'),
    null,
  )
  assert.equal(
    queueProblem({ downloadId: hash, state: 'importBlocked', status: 'warning', messages: [] }, 'Sonarr'),
    'Sonarr reports a problem importing this download.',
  )
  assert.equal(
    queueProblem(
      {
        downloadId: hash,
        state: 'importPending',
        status: 'warning',
        messages: ['Not an upgrade for existing episode file(s)'],
      },
      'Sonarr',
    ),
    'Not an upgrade for existing episode file(s)',
  )

  const start = Date.now()
  const { state, tick } = harness(start)
  const download = record()
  setDownloadPhase(download.id, 'complete')
  state.queue = [
    {
      downloadId: hash.toUpperCase(),
      state: 'importPending',
      status: 'warning',
      messages: ['Not an upgrade for existing episode file(s)'],
    },
  ]
  await tick()
  assert.equal(state.reads, 1, 'The download clients are read first, so a just-finished download is noticed')
  assert.deepEqual(
    [tracking(download.id).state, tracking(download.id).message],
    ['blocked', 'Not an upgrade for existing episode file(s)'],
  )
  assert.deepEqual(state.problems, [], 'A warning that may pass is not reported at once')
  state.now += 6 * MINUTE
  await tick()
  assert.deepEqual(state.problems, [
    {
      title: 'Show',
      season: 1,
      releaseGroup: 'Best',
      app: 'Sonarr',
      state: 'blocked',
      message: 'Not an upgrade for existing episode file(s)',
    },
  ])
  await tick()
  assert.equal(state.problems.length, 1, 'One notification per download')
  // Once Sonarr stops complaining, the wait continues.
  state.queue = [{ downloadId: hash, state: 'importing', status: 'ok', messages: [] }]
  await tick()
  assert.deepEqual([tracking(download.id).state, tracking(download.id).message], ['pending', undefined])
  assert.deepEqual(state.scans, [], 'Nothing is rescanned while the queue still holds the download')
})

test('a download that left the queue is checked against the library, then reported when nothing changed', async () => {
  const start = Date.now()
  const { state, tick } = harness(start)
  const download = record({
    library: [
      { key: 'Sonarr:item10', season: 1, part: '', group: 'Best' },
      { key: 'Sonarr:item10', season: 2, part: '', group: 'Best' },
    ],
  })
  setDownloadPhase(download.id, 'complete')
  await tick()
  assert.deepEqual(state.scans, [], 'Sonarr gets time to notice the finished download')
  state.now += 3 * MINUTE
  await tick()
  assert.deepEqual(
    state.scans,
    ['sonarr:10'],
    'One rescan of the title, however many of its seasons the download covers',
  )
  await tick()
  assert.equal(state.scans.length, 1, 'The rescan is not requested again a minute later')
  state.now += 20 * MINUTE
  await tick()
  assert.deepEqual(state.scans, ['sonarr:10', 'sonarr:10'], 'A last look before giving up')
  assert.equal(tracking(download.id).state, 'pending')
  state.now += 2 * MINUTE
  await tick()
  assert.equal(tracking(download.id).state, 'pending', 'The requested rescan gets time to finish')
  state.now += 2 * MINUTE
  state.scanning = true
  await tick()
  assert.equal(tracking(download.id).state, 'pending', 'No verdict while a scan is still running')
  state.scanning = false
  await tick()
  assert.equal(tracking(download.id).state, 'not_imported')
  assert.match(tracking(download.id).message || '', /Sonarr is not handling this download.*"sonarr-anime" category/)
  assert.deepEqual(
    state.problems.map(problem => [problem.state, problem.app]),
    [['not_imported', 'Sonarr']],
  )
  // A later scan can still find the files, for example after a manual import.
  assert.equal(
    settleImports(
      [
        result({ status: 'best', have: ['Best'] }),
        result({ key: 'Sonarr:43:2:Best', season: 2, status: 'best', have: ['Best'] }),
      ],
      state.now,
    ),
    1,
  )
  assert.equal(tracking(download.id).state, 'imported')
  assert.equal(importsToFollow(state.now), false)
})

test('each instance is asked about its own downloads, and failures wait instead of repeating', async () => {
  const start = Date.now()
  const { state, tick } = harness(start)
  const second = record({
    source_hash: 'c'.repeat(40),
    library: [{ key: 'Sonarr@uhd4k:item7', season: 1, part: '', group: 'Best' }],
  })
  const orphan = record({
    source_hash: 'd'.repeat(40),
    library: [{ key: 'Sonarr@gone:item7', season: 1, part: '', group: 'Best' }],
  })
  setDownloadPhase(second.id, 'complete')
  setDownloadPhase(orphan.id, 'complete')
  state.now += 3 * MINUTE
  state.queueError = 'HTTP 503'
  await tick()
  assert.deepEqual(state.scans, [], 'An unreadable queue decides nothing')
  state.queueError = ''
  state.now += MINUTE
  await tick()
  assert.deepEqual(state.scans, [], 'A failed instance is not asked again right away')
  state.now += 5 * MINUTE
  await tick()
  assert.deepEqual(state.scans, ['uhd4k:7'])
  assert.equal(tracking(orphan.id).state, 'pending', 'A download of a removed instance is left alone')
})

test('import problems are only sent when that notification is enabled', async () => {
  const start = Date.now()
  const { state, tick } = harness(start)
  const download = record()
  setDownloadPhase(download.id, 'complete')
  updateDownloadImport(download.id, { state: 'not_imported', message: 'Sonarr is not handling this download.' })
  await tick({ ...config, notify_import_problems: false })
  await tick({ ...config, notify_enabled: false })
  await tick({ ...config, webhook: '' })
  assert.deepEqual(state.problems, [])
  await tick()
  assert.equal(state.problems.length, 1)
  assert.equal(tracking(download.id).notified, true)

  const original = globalThis.fetch
  const sent: { content: string; embeds: { fields: { name: string; value: string }[] }[] }[] = []
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }
  try {
    assert.equal(await sendImportProblem(config, state.problems[0]), true)
    assert.equal(sent[0].content, 'Show (S01) — A finished download was not imported by Sonarr')
    assert.deepEqual(sent[0].embeds[0].fields, [
      { name: 'Release', value: 'Best', inline: true },
      { name: 'Sonarr reports', value: 'Sonarr is not handling this download.' },
    ])
    assert.equal(await sendImportProblem({ ...config, webhook: '' }, state.problems[0]), false)
  } finally {
    globalThis.fetch = original
  }
})

test('download progress reports the import state with the name of the instance', async () => {
  const original = globalThis.fetch
  resetQbRuntime()
  let torrentState = { hash: 'c'.repeat(40), state: 'downloading', progress: 0.4, size: 1000 }
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } })
    if (url.pathname.endsWith('/torrents/info')) return Response.json([torrentState])
    return new Response('Ok.')
  }
  try {
    const download = record({
      source_hash: 'c'.repeat(40),
      library: [{ key: 'Sonarr@uhd4k:item7', season: 1, part: '', group: 'Best' }],
    })
    assert.deepEqual((await collectDownloadProgress(config, downloadClients(config))).downloads[download.id].import, {
      state: 'waiting',
      app: 'Sonarr 4K',
    })
    torrentState = { ...torrentState, state: 'stalledUP', progress: 1 }
    const finished = (await collectDownloadProgress(config, downloadClients(config))).downloads[download.id]
    assert.equal(finished.phase, 'seeding')
    assert.equal(
      finished.import?.state,
      'pending',
      'The read that sees the download finish already reports the wait for import',
    )
    assert.equal(finished.import?.app, 'Sonarr 4K')
    updateDownloadImport(download.id, { state: 'blocked', message: 'Unable to parse file' })
    assert.deepEqual((await collectDownloadProgress(config, downloadClients(config))).downloads[download.id].import, {
      state: 'blocked',
      app: 'Sonarr 4K',
      message: 'Unable to parse file',
      completed_at: finished.import?.completed_at,
    })
  } finally {
    globalThis.fetch = original
    resetQbRuntime()
  }
})

// --- Outcome feedback: an NZB whose files are not the listed release -------------------

const PROWLARR = 'http://prowlarr-feedback.test:9696'
const PROWLARR_KEY = 'prowlarr-key-71ab'
const prowlarrConfig = {
  ...config,
  tracker_mode: 'private',
  prowlarr_enabled: true,
  prowlarr_url: PROWLARR,
  prowlarr_key: PROWLARR_KEY,
} as Config
const EPISODE_SIZES = [1_512_345_678, 1_398_765_432, 1_287_654_321]
const EPISODES = EPISODE_SIZES.map((length, index) => ({
  name: `[Vault] Show - 0${index + 1} (BD 1080p).mkv`,
  length,
}))
const SOURCE: PrivateSource = { id: filesSourceId(EPISODES), files: EPISODES }
const TOTAL = EPISODE_SIZES.reduce((sum, size) => sum + size, 0)
const pageOf = (link: string) => `https://indexer2.test/details/${link}`
const entryOf = (link: string) => candidateEntryId(2, pageOf(link))

/** An NZB of the release: with the file sizes in the subjects it is exact, with the names only near-exact. */
function nzbOf(withSizes: boolean) {
  const files = EPISODES.map((file, index) => {
    const total = Math.round(file.length * 1.031)
    const part = Math.floor(total / 3)
    const segments = [part, part, total - 2 * part]
      .map((bytes, number) => `<segment bytes="${bytes}" number="${number + 1}">${index}.${number}@test</segment>`)
      .join('')
    const subject = `&quot;${file.name}&quot; yEnc (1/3)${withSizes ? ` ${file.length}` : ''}`
    return `<file poster="p@test" date="1700000000" subject="${subject}"><groups><group>alt.binaries.test</group></groups><segments>${segments}</segments></file>`
  })
  return new TextEncoder().encode(
    `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${files.join('')}</nzb>`,
  )
}

/** Two posts of the release on one indexer: `first` is near-exact, `second` exact. */
function feed(): Response {
  const items = [
    { title: '[Vault] Show (BD 1080p)', link: 'first', size: 1.08 },
    { title: '[Vault] Show (BD 1080p) repost', link: 'second', size: 1.12 },
  ].map(post => {
    const proxy = `http://localhost:9696/2/download?${new URLSearchParams({ apikey: PROWLARR_KEY, link: post.link, file: post.title })}`
    return [
      `<item><title>${post.title}</title><guid>${pageOf(post.link)}</guid><link>${proxy.replace(/&/g, '&amp;')}</link>`,
      `<enclosure url="${proxy.replace(/&/g, '&amp;')}" type="application/x-nzb" />`,
      `<newznab:attr name="size" value="${Math.round(TOTAL * post.size)}" /><newznab:attr name="files" value="14" /></item>`,
    ].join('')
  })
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Prowlarr</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/rss+xml' } },
  )
}

/** A fresh Usenet runtime that asks a fake Prowlarr; the default runtime is put back when the test ends. */
function finder(t: TestContext): { fetched: string[] } {
  const fetched: string[] = []
  const send = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.origin !== PROWLARR) return new Response('not found', { status: 404 })
    if (url.pathname === '/api/v1/indexer')
      return Response.json([{ id: 2, name: 'Geek', protocol: 'usenet', privacy: 'private', enable: true }])
    if (url.pathname === '/2/api') return feed()
    if (url.pathname === '/2/download') {
      const link = url.searchParams.get('link') ?? ''
      fetched.push(link)
      return new Response(nzbOf(link === 'second'))
    }
    throw new Error(`unexpected request: ${url.pathname}`)
  }
  testUsenetRuntime(t, { fetch: send })
  return { fetched }
}

const rejectFor = (config_: Config = prowlarrConfig) => ({
  rejectCandidate: (sourceId: string, entryId: string) => rejectSearchCandidate(config_, sourceId, entryId),
})

/** A finished Usenet download of the Vault release, sent while the library held 900 bytes of the season. */
function nzbRecord(changes: Partial<NewDownloadRecord> = {}) {
  const download = addDownloadRecord({
    protocol: 'usenet',
    client: 'sabnzbd',
    endpoint: 'sabnzbd:test',
    native_id: 'SABnzbd_nzo_vault',
    state: 'accepted',
    source_hash: SOURCE.id,
    category: 'sonarr-anime',
    provider: 'prowlarr',
    proof: 'near_exact',
    entry_id: entryOf('first'),
    card: { title: 'Show', season: 1, part: '', release_group: 'Vault', tracker: 'AB', size: TOTAL },
    labels: ['Show S01 [Vault]'],
    rows: [{ key: 'Sonarr:42:1:Vault', release: 0 }],
    library: [{ key: 'Sonarr:item10', season: 1, part: '', group: 'Vault', local_size: 900 }],
    ...changes,
  })
  setDownloadPhase(download.id, 'complete')
  return download
}

/** The season after a scan: Vault's name on files of `localSize` bytes that are not the listed release. */
const mismatched = (localSize = TOTAL + 4096) =>
  result({
    key: 'Sonarr:42:1:Vault',
    best_group: 'Vault',
    have: ['Vault'],
    local_size: localSize,
    mismatched_by_part: { '': ['Vault'] },
    releases: [
      {
        kind: 'best',
        releaseGroup: 'Vault',
        tracker: 'AB',
        quality: '',
        tags: [],
        size: TOTAL,
        info_hashes: [],
        torrent_available: false,
      },
    ],
  })

test('a near-exact download whose import shows a size mismatch rejects its candidate and is reported once', async t => {
  finder(t)
  const found = await resolveSource(prowlarrConfig, SOURCE, { titles: ['Show'], releaseGroup: 'Vault' }, { limit: 1 })
  assert.deepEqual([found.availability.state, found.availability.proof], ['available', 'near_exact'])
  const download = nzbRecord()
  const { state, tick } = harness(Date.now())

  assert.equal(settleImports([mismatched()], Date.now(), rejectFor()), 0, 'A mismatch is no import')
  assert.deepEqual(
    [tracking(download.id).state, tracking(download.id).message],
    ['mismatch', 'The downloaded files are not the release SeaDex lists; their sizes differ.'],
  )
  const after = searchSnapshot(prowlarrConfig, SOURCE.id).availability
  assert.equal(after.state, 'no_match')
  assert.deepEqual(
    after.candidates?.map(candidate => [candidate.entry_id, candidate.rejected]),
    [
      [entryOf('first'), true],
      [entryOf('second'), undefined],
    ],
  )

  assert.equal(importsToFollow(), true, 'The problem still has to be reported')
  await tick()
  await tick()
  assert.deepEqual(state.problems, [
    {
      title: 'Show',
      season: 1,
      releaseGroup: 'Vault',
      app: 'Sonarr',
      state: 'mismatch',
      message: 'The downloaded files are not the release SeaDex lists; their sizes differ.',
    },
  ])
  assert.equal(importsToFollow(), false)

  // Final: neither a later mismatch nor files that now match change or report it again.
  const rejections: string[] = []
  const counting = { rejectCandidate: (_sourceId: string, entryId: string) => rejections.push(entryId) > 0 }
  settleImports([mismatched(TOTAL + 8192)], Date.now(), counting)
  settleImports([result({ ...mismatched(), mismatched_by_part: undefined, verified_by_part: { '': ['Vault'] } })])
  assert.deepEqual(rejections, [])
  assert.equal(tracking(download.id).state, 'mismatch')
  await tick()
  assert.equal(state.problems.length, 1)

  const original = globalThis.fetch
  const sent: { content: string; embeds: { fields: { name: string; value: string }[] }[] }[] = []
  globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }
  try {
    assert.equal(await sendImportProblem(config, state.problems[0]), true)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(sent[0].content, 'Show (S01) — The downloaded files are not the release SeaDex lists')
  assert.deepEqual(sent[0].embeds[0].fields, [
    { name: 'Release', value: 'Vault', inline: true },
    { name: 'Library scan', value: 'The downloaded files are not the release SeaDex lists; their sizes differ.' },
  ])
})

test('a candidate rejected after a mismatched import is skipped by the next verify', async t => {
  const prowlarr = finder(t)
  await resolveSource(prowlarrConfig, SOURCE, { titles: ['Show'], releaseGroup: 'Vault' }, { limit: 1 })
  assert.deepEqual(prowlarr.fetched, ['first'])
  nzbRecord()
  settleImports([mismatched()], Date.now(), rejectFor())

  const next = await verifySource(prowlarrConfig, SOURCE, { limit: 3 })
  assert.deepEqual(prowlarr.fetched, ['first', 'second'], 'The rejected post is not fetched again')
  assert.deepEqual(
    [next.availability.state, next.availability.entry_id, next.availability.proof],
    ['available', entryOf('second'), 'exact'],
  )
})

test('an exact download, a hash-provider download and a torrent are never rejected for a mismatch', () => {
  const rejections: string[] = []
  const counting = { rejectCandidate: (_sourceId: string, entryId: string) => rejections.push(entryId) > 0 }
  const exact = nzbRecord({ proof: 'exact' })
  const hashed = nzbRecord({
    source_hash: 'e'.repeat(40),
    provider: 'animetosho',
    proof: undefined,
    entry_id: 'animetosho-1',
  })
  const amenzb = nzbRecord({ source_hash: 'f'.repeat(40), provider: 'amenzb', proof: undefined, entry_id: 'amenzb-1' })
  const torrent = record({ library: [{ key: 'Sonarr:item10', season: 1, part: '', group: 'Vault', local_size: 900 }] })
  setDownloadPhase(torrent.id, 'complete')

  assert.equal(settleImports([mismatched()], Date.now(), counting), 0)
  assert.deepEqual(rejections, [])
  for (const download of [exact, hashed, amenzb, torrent])
    assert.equal(tracking(download.id).state, 'pending', 'The download keeps waiting, as before')
})

test('a near-exact download from before entry IDs were kept is reported without a rejection', () => {
  const rejections: string[] = []
  const counting = { rejectCandidate: (_sourceId: string, entryId: string) => rejections.push(entryId) > 0 }
  const download = nzbRecord({ entry_id: undefined })
  assert.doesNotThrow(() => settleImports([mismatched()], Date.now(), counting))
  assert.deepEqual(rejections, [])
  assert.equal(tracking(download.id).state, 'mismatch')
})

test('a confirmed import and files that did not change since sending leave the search store alone', async t => {
  finder(t)
  await resolveSource(prowlarrConfig, SOURCE, { titles: ['Show'], releaseGroup: 'Vault' }, { limit: 1 })
  const rejections: string[] = []
  const counting = { rejectCandidate: (_sourceId: string, entryId: string) => rejections.push(entryId) > 0 }

  // A record that predates the size snapshot cannot tell new files from old ones, so it is not judged.
  const old = nzbRecord({ library: [{ key: 'Sonarr:item10', season: 1, part: '', group: 'Vault' }] })
  assert.equal(settleImports([mismatched()], Date.now(), counting), 0)
  assert.equal(tracking(old.id).state, 'pending')
  // The library held another release of Vault before; a scan of other titles keeps this season's result.
  const stale = nzbRecord()
  assert.equal(settleImports([mismatched(900)], Date.now(), counting), 0)
  assert.equal(tracking(stale.id).state, 'pending')
  assert.deepEqual(rejections, [])

  const imported = result({ ...mismatched(), status: 'best', mismatched_by_part: undefined })
  assert.equal(settleImports([imported], Date.now(), counting), 2)
  assert.deepEqual(rejections, [])
  assert.deepEqual(
    [searchSnapshot(prowlarrConfig, SOURCE.id).availability.state, tracking(stale.id).state],
    ['available', 'imported'],
  )
})
