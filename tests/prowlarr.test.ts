// Private-tracker releases through Prowlarr: file-list identity, .torrent and NZB checks, and the review,
// availability and submission paths that use them. Runs in the shared temp DATA_DIR (tests/run-tests.mjs).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { seadexBest } from '../server/catalog.js'
import { NZB_STORE_DIR, USENET_SEARCH_FILE } from '../server/paths.js'
import { normalizeResults } from '../server/result-model.js'
import { parseTorrentFile } from '../server/torrent-file.js'
import { filesSourceId, nzbFileMatches, nzbFiles, nzbHasFiles, sameFiles } from '../server/source-files.js'
import {
  prowlarrCoverage,
  prowlarrIndexers,
  resetProwlarrRuntime,
  searchProwlarr,
  testProwlarr,
  trackerIndexers,
} from '../server/prowlarr.js'
import { invalidatePrivateSources, trackerTorrentId } from '../server/private-sources.js'
import { resetUsenetSearch, resolveSource, searchScheduler } from '../server/usenet-search.js'
import { cleanSearchTitle, searchTitles } from '../server/search-titles.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { consumePlan } from '../server/download-plans.js'
import { acceptDownloadPlan } from '../server/download-submit.js'
import { addDownloadRecord, downloadRecords, resetOwnedRuntime } from '../server/download-store.js'
import { resetUsenetLookups, resolveUsenetHash, usenetAvailability } from '../server/usenet.js'
import { applyConfigUpdate, publicConfig } from '../server/config.js'
import { resetQbRuntime } from '../server/qbittorrent.js'
import type { Config, ResultItem } from '../server/types.js'
import { currentDownloadAssociations } from '../frontend/src/download-store.js'
import { findsPrivateTorrent } from '../frontend/src/utils.js'
import type { DownloadProgress } from '../shared/download-contracts.js'
import { baseConfig, purgeTestDataDir, resultFixture, releaseFixture, QB, SAB } from './support/download-fixtures.js'

const PROWLARR = 'http://prowlarr.test:9696'
const KEY = 'prowlarr-key'

type Bencodable = number | string | Bencodable[] | { [key: string]: Bencodable }
function bencode(value: Bencodable): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const keys = Object.keys(value).sort()
  return Buffer.concat([
    Buffer.from('d'),
    ...keys.flatMap(key => [bencode(key), bencode(value[key])]),
    Buffer.from('e'),
  ])
}

const FILES = [
  { name: '[Vault] Show - 01 [1080p].mkv', length: 1_500_000_123 },
  { name: '[Vault] Show - 02 [1080p].mkv', length: 1_400_000_456 },
]
const TOTAL = FILES.reduce((sum, file) => sum + file.length, 0)

function torrentFile(files = FILES) {
  const info = {
    name: '[Vault] Show',
    'piece length': 16384,
    pieces: 'x'.repeat(20),
    private: 1,
    files: files.map(file => ({ length: file.length, path: [file.name] })),
  }
  const bytes = bencode({ announce: 'https://tracker.test/announce/passkey', info })
  return { bytes, hash: createHash('sha1').update(bencode(info)).digest('hex') }
}

function nzb(subjects: string[]): string {
  const files = subjects
    .map(
      (subject, index) =>
        `<file poster="p@test" date="1700000000" subject="${subject.replace(/"/g, '&quot;')}"><groups><group>alt.binaries.test</group></groups><segments><segment bytes="700000" number="1">part${index}@test</segment></segments></file>`,
    )
    .join('')
  return `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${files}</nzb>`
}

const MATCHING_NZB = nzb([
  `[1/3] - "${FILES[0].name}" yEnc (1/2000) ${FILES[0].length}`,
  `[2/3] - "${FILES[1].name}" yEnc (1/1900) ${FILES[1].length}`,
  `[3/3] - "[Vault] Show.par2" yEnc (1/1) 40000`,
])

const source = {
  id: filesSourceId(FILES),
  page: 'https://animebytes.tv/torrents.php?id=3140&torrentid=951508',
  files: FILES,
}

function privateResults(overrides: Record<string, unknown> = {}): ResultItem[] {
  return [
    resultFixture([
      releaseFixture({
        releaseGroup: 'Vault',
        tracker: 'AB',
        torrent_available: false,
        info_hashes: [],
        torrent_files: undefined,
        private_sources: [source],
        size: TOTAL,
        part: '',
        ...overrides,
      }),
    ]),
  ] as unknown as ResultItem[]
}

function prowlarrConfig(overrides: Partial<Config> = {}): Config {
  return baseConfig({
    tracker_mode: 'private',
    prowlarr_enabled: true,
    prowlarr_url: PROWLARR,
    prowlarr_key: KEY,
    ...overrides,
  })
}

interface FakeState {
  calls: string[]
  indexers?: unknown[]
  torrentResults?: () => unknown[]
  usenetResults?: () => unknown[]
  torrents?: Record<string, Buffer>
  nzbs?: Record<string, string>
  qbAdded?: { torrent: Buffer; fields: Record<string, string> }
  qbTorrents?: { hash: string; state: string }[]
  sabAdded?: { nzb: string; name: string; category: string }
}

const INDEXERS = [
  {
    id: 1,
    name: 'AnimeBytes',
    implementationName: 'AnimeBytes',
    protocol: 'torrent',
    privacy: 'private',
    enable: true,
  },
  { id: 2, name: 'Geek', protocol: 'usenet', privacy: 'private', enable: true },
  { id: 3, name: 'Nyaa', protocol: 'torrent', privacy: 'public', enable: true },
  { id: 4, name: 'Off', protocol: 'usenet', privacy: 'private', enable: false },
]

const escapeXml = (value: unknown) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The Usenet results of one indexer as its Newznab endpoint in Prowlarr lists them. Prowlarr writes a result's
 * page address into `<comments>`.
 */
function newznabFeed(results: unknown[], indexerId: number): Response {
  const items = (results as Record<string, unknown>[])
    .filter(entry => entry.indexerId === indexerId)
    .map(entry =>
      [
        `<item><title>${escapeXml(entry.title)}</title><guid>${escapeXml(entry.guid)}</guid>`,
        entry.infoUrl ? `<comments>${escapeXml(entry.infoUrl)}</comments>` : '',
        `<link>${escapeXml(entry.downloadUrl)}</link>`,
        `<enclosure url="${escapeXml(entry.downloadUrl)}" type="application/x-nzb" />`,
        entry.size ? `<newznab:attr name="size" value="${escapeXml(entry.size)}" />` : '',
        '</item>',
      ].join(''),
    )
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Prowlarr</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/rss+xml' } },
  )
}

/** Forgets every Usenet search result, in memory and on disk. */
function forgetUsenetSearches(): void {
  resetUsenetSearch()
  rmSync(USENET_SEARCH_FILE, { force: true })
  rmSync(NZB_STORE_DIR, { recursive: true, force: true })
}

function install(state: FakeState): () => void {
  const original = globalThis.fetch
  const pacing = { ...searchScheduler.options }
  resetQbRuntime()
  resetOwnedRuntime()
  resetProwlarrRuntime()
  invalidatePrivateSources()
  forgetUsenetSearches()
  purgeTestDataDir()
  // Requests to the fake indexers need no spacing.
  searchScheduler.options.minIntervalMs = 0
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    state.calls.push(`${init?.method || 'GET'} ${url.href}`)
    if (url.origin === PROWLARR) {
      const headers = new Headers(init?.headers)
      if (headers.get('x-api-key') !== KEY) return new Response('unauthorized', { status: 401 })
      // Prowlarr can run under a URL base; the fake serves the same API under /prowlarr.
      const pathname = url.pathname.replace(/^\/prowlarr(?=\/)/, '')
      if (pathname === '/api/v1/system/status') return Response.json({ appName: 'Prowlarr', version: '1.30.2' })
      if (pathname === '/api/v1/indexer') return Response.json(state.indexers ?? INDEXERS)
      // Torrent indexers are searched together through the JSON API, each Usenet indexer through its Newznab endpoint.
      if (pathname === '/api/v1/search') return Response.json(state.torrentResults?.() || [])
      const newznab = pathname.match(/^\/(\d+)\/api$/)
      if (newznab) return newznabFeed(state.usenetResults?.() || [], Number(newznab[1]))
      const download = pathname.match(/^\/(\d+)\/download$/)
      if (download) {
        const link = url.searchParams.get('link') || ''
        // Prowlarr's per-indexer "Redirect" option hands back the indexer's own link.
        if (link.startsWith('redirect:'))
          return new Response(null, { status: 301, headers: { location: link.slice('redirect:'.length) } })
        if (download[1] === '1' && state.torrents?.[link]) return new Response(new Uint8Array(state.torrents[link]))
        if (download[1] === '2' && state.nzbs?.[link]) return new Response(state.nzbs[link])
        return new Response('gone', { status: 404 })
      }
    }
    if (url.origin === 'https://geek.test' && url.pathname === '/getnzb') {
      // The indexer must never receive the Prowlarr API key.
      if (new Headers(init?.headers).get('x-api-key')) return new Response('leaked', { status: 400 })
      return new Response(state.nzbs?.[url.searchParams.get('id') || ''] ?? 'gone', {
        status: state.nzbs?.[url.searchParams.get('id') || ''] ? 200 : 404,
      })
    }
    if (url.origin === QB) {
      if (url.pathname.endsWith('/auth/login')) return new Response('Ok.')
      if (url.pathname.endsWith('/torrents/add')) {
        const form = init?.body as FormData
        const file = form.get('torrents') as Blob
        const fields: Record<string, string> = {}
        for (const [name, value] of form.entries()) if (typeof value === 'string') fields[name] = value
        const bytes = Buffer.from(await file.arrayBuffer())
        state.qbAdded = { torrent: bytes, fields }
        state.qbTorrents = [
          ...(state.qbTorrents || []),
          { hash: parseTorrentFile(bytes).info_hash, state: 'stoppedDL' },
        ]
        return new Response('Ok.')
      }
      if (url.pathname.endsWith('/torrents/info')) {
        const wanted = url.searchParams.get('hashes')
        const torrents = state.qbTorrents || []
        return Response.json(wanted ? torrents.filter(torrent => wanted.split('|').includes(torrent.hash)) : torrents)
      }
      if (url.pathname.endsWith('/app/preferences'))
        return Response.json({ auto_tmm_enabled: true, save_path: '/downloads', temp_path_enabled: false })
      if (url.pathname.endsWith('/sync/maindata'))
        return Response.json({ server_state: { free_space_on_disk: 500_000_000_000 } })
      if (url.pathname.endsWith('/torrents/categories'))
        return Response.json({ 'sonarr-anime': { savePath: '/downloads/anime' } })
      if (url.pathname.includes('getFreeSpaceAtPath')) return new Response('500000000000')
    }
    if (url.origin === SAB) {
      const mode = url.searchParams.get('mode')
      if (init?.method === 'POST') {
        const form = init.body as FormData
        state.sabAdded = {
          nzb: await (form.get('name') as Blob).text(),
          name: String(form.get('nzbname')),
          category: String(form.get('cat')),
        }
        return Response.json({ status: true, nzo_ids: ['nzo_private'] })
      }
      if (mode === 'get_cats') return Response.json({ categories: ['*', 'sonarr-anime', 'radarr-anime'] })
      if (mode === 'queue') {
        const slots = state.sabAdded
          ? [
              {
                nzo_id: 'nzo_private',
                status: 'Downloading',
                filename: state.sabAdded.name,
                cat: state.sabAdded.category,
                mb: '2800',
                mbleft: '2000',
                percentage: '28',
              },
            ]
          : []
        return Response.json({ queue: { paused_all: false, diskspace1: '931.5', slots } })
      }
      if (mode === 'history') return Response.json({ history: { slots: [] } })
    }
    throw new Error(`unexpected request: ${url.href}`)
  }
  return () => {
    globalThis.fetch = original
    Object.assign(searchScheduler.options, pacing)
    resetQbRuntime()
    resetOwnedRuntime()
    resetProwlarrRuntime()
    invalidatePrivateSources()
    forgetUsenetSearches()
    purgeTestDataDir()
  }
}

/** Prowlarr searches and downloads (grabs); reading the indexer list is neither. */
const prowlarrCalls = (state: FakeState) =>
  state.calls.filter(call => call.startsWith(`GET ${PROWLARR}`) && !call.includes('/api/v1/indexer')).length

/** Reads availability as the browser's observer does, until no row reports a search or a check under way. */
async function settledAvailability(
  config: Config,
  selections: { key: string; release: number }[],
  results: ResultItem[],
): Promise<Awaited<ReturnType<typeof usenetAvailability>>> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await usenetAvailability(config, selections, results)
    if (!rows.some(row => row.refreshing)) return rows
    await nextTurn()
  }
  throw new Error('Usenet availability never settled')
}

/** A Prowlarr search result; download links name Prowlarr's host as it sees itself. */
const result = (overrides: Record<string, unknown>) => ({
  guid: 'guid',
  indexerId: 1,
  indexer: 'AnimeBytes',
  title: 'Show',
  size: TOTAL,
  protocol: 'torrent',
  downloadUrl: `http://localhost:9696/1/download?apikey=${KEY}&link=real&file=Show`,
  ...overrides,
})

test('a .torrent file yields its v1 info hash and every file under the torrent folder', () => {
  const { bytes, hash } = torrentFile()
  const parsed = parseTorrentFile(bytes)
  assert.equal(parsed.info_hash, hash)
  assert.equal(parsed.private, true)
  assert.deepEqual(
    parsed.files.map(file => file.name),
    FILES.map(file => `[Vault] Show/${file.name}`),
  )
  const single = parseTorrentFile(bencode({ info: { name: 'Movie.mkv', length: 42, 'piece length': 1, pieces: '' } }))
  assert.deepEqual(single.files, [{ name: 'Movie.mkv', length: 42 }])
  assert.throws(() => parseTorrentFile(Buffer.from('<html>login</html>')), /Not a valid torrent file/)
  assert.throws(() => parseTorrentFile(Buffer.concat([bytes, Buffer.from('x')])), /Not a valid torrent file/)
})

test('file-list identities ignore order and folders, and comparisons need every name and size', () => {
  assert.equal(filesSourceId(FILES), filesSourceId([...FILES].reverse()))
  assert.equal(filesSourceId(FILES), filesSourceId(FILES.map(file => ({ ...file, name: `Folder/${file.name}` }))))
  assert.match(filesSourceId(FILES), /^files:[0-9a-f]{40}$/)
  assert.ok(
    sameFiles(
      FILES.map(file => ({ ...file, name: `[Vault] Show/${file.name}` })),
      FILES,
    ),
  )
  assert.equal(sameFiles([FILES[0]], FILES), false)
  assert.equal(sameFiles([FILES[0], { ...FILES[1], length: FILES[1].length + 1 }], FILES), false)
})

test('NZB subjects disclose file sizes only when the poster wrote them', () => {
  const files = nzbFiles(new TextEncoder().encode(MATCHING_NZB))
  assert.deepEqual(files[0], { name: FILES[0].name, size: FILES[0].length, bytes: 700000 })
  assert.ok(nzbHasFiles(files, FILES))
  const sizeless = nzbFiles(new TextEncoder().encode(nzb(FILES.map(file => `"${file.name}" yEnc (1/10)`))))
  assert.equal(sizeless[0].size, null)
  assert.deepEqual(nzbFileMatches(sizeless, FILES), {
    files_matched: 0,
    names_matched: 2,
    files_expected: 2,
    sizes_known: false,
  })
  const quoted = nzbFiles(new TextEncoder().encode(nzb(['"Hero&#039;s Party - 01.mkv" yEnc (1/10) 5'])))
  assert.equal(quoted[0].name, "Hero's Party - 01.mkv")
  assert.equal(nzbHasFiles(sizeless, FILES), false)
  const obfuscated = nzbFiles(new TextEncoder().encode(nzb(['"a8f3e1c0.part01.rar" yEnc (1/10) 1000000'])))
  assert.equal(nzbHasFiles(obfuscated, FILES), false)
})

test('SeaDex private-tracker torrents keep their files as a source, and saved results keep it', async () => {
  const best = await seadexBest({
    loadPage: async () => ({
      totalPages: 1,
      items: [
        {
          alID: 9,
          expand: {
            trs: [
              {
                tracker: 'AB',
                url: '/torrents.php?id=3140&torrentid=951508',
                infoHash: '<redacted>',
                releaseGroup: 'Vault',
                isBest: true,
                files: FILES,
              },
            ],
          },
        },
      ],
    }),
  })
  const candidate = best.get(9)!.seasons[0].candidates[0]
  assert.deepEqual(candidate.private_sources, [source])
  const saved = normalizeResults(privateResults())
  assert.deepEqual(saved[0].releases[0].private_sources, [source])
  const forged = normalizeResults(privateResults({ private_sources: [{ ...source, id: 'a'.repeat(40) }] }))
  assert.equal(forged[0].releases[0].private_sources, undefined)
})

test('Prowlarr search re-roots download links on the configured origin and recognizes tracker indexers', async () => {
  const state: FakeState = {
    calls: [],
    torrentResults: () => [result({}), result({ guid: 'elsewhere', downloadUrl: 'http://localhost:9696/other' })],
  }
  const restore = install(state)
  try {
    const settings = { baseUrl: `${PROWLARR}/`, apiKey: KEY }
    assert.match(await testProwlarr(settings), /Prowlarr 1\.30\.2 · 1 Usenet indexer, 1 private torrent indexer/)
    const [found, other] = await searchProwlarr(settings, 'Show', [1])
    assert.equal(found.download_path, `/1/download?apikey=${KEY}&link=real&file=Show`)
    assert.equal(other.download_path, '/other')
    // Under a URL base, links outside it are dropped rather than followed.
    const prefixed = await searchProwlarr({ baseUrl: `${PROWLARR}/prowlarr`, apiKey: KEY }, 'Show', [1])
    assert.equal(prefixed.length, 0)
    const indexers = await prowlarrIndexers(settings)
    assert.deepEqual(
      indexers.map(indexer => indexer.id),
      [1, 2, 3],
      'disabled indexers are left out',
    )
    assert.deepEqual(
      trackerIndexers(indexers, 'AB').map(indexer => indexer.name),
      ['AnimeBytes'],
    )
    assert.deepEqual(trackerIndexers(indexers, 'Nyaa'), [], 'public trackers are never private-tracker indexers')
    assert.equal(trackerTorrentId(source.page), '951508')
    await assert.rejects(testProwlarr({ baseUrl: PROWLARR, apiKey: 'wrong' }), /API key/)
  } finally {
    restore()
  }
})

test('a private-tracker torrent is found by its tracker ID, checked file by file, and sent as a .torrent file', async () => {
  const real = torrentFile()
  const decoy = torrentFile([FILES[0], { name: 'other.mkv', length: FILES[1].length }])
  const state: FakeState = {
    calls: [],
    torrents: { real: real.bytes, decoy: decoy.bytes },
    torrentResults: () => [
      result({ guid: 'decoy', downloadUrl: `${PROWLARR}/1/download?apikey=${KEY}&link=decoy&file=x` }),
      result({ guid: 'https://animebytes.tv/torrent/951508/group', infoUrl: source.page }),
    ],
  }
  const restore = install(state)
  try {
    const config = prowlarrConfig({ download_mode: 'torrent_only' })
    const results = privateResults()
    const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0 }], { results })
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.review.units.length, 1)
    assert.equal(built.review.units[0].source_hash, real.hash)
    assert.equal(built.review.units[0].size_bytes, TOTAL)
    assert.equal(built.review.units[0].approximate, false)
    assert.ok(!('torrentFile' in built.review.units[0]), 'the torrent file never reaches the browser')
    // The tracker's own torrent ID is checked first, so the decoy is never fetched.
    assert.equal(state.calls.filter(call => call.includes('link=decoy')).length, 0)

    const { completion } = await acceptDownloadPlan(config, consumePlan(built.plan.id)!, undefined, results)
    const outcome = await completion
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.failures, [])
    assert.deepEqual(state.qbAdded?.torrent, real.bytes)
    assert.equal(state.qbAdded?.fields.category, 'sonarr-anime')
    const [record] = downloadRecords()
    assert.equal(record.source_hash, real.hash)
    assert.equal(record.native_id, real.hash)
    assert.equal(record.source_alias, source.id)
    // Review and acceptance share one search and one download of the .torrent file.
    assert.equal(state.calls.filter(call => call.includes('/api/v1/search')).length, 1)
    assert.equal(state.calls.filter(call => call.includes('link=real')).length, 1)
  } finally {
    restore()
  }
})

test('a private-tracker torrent whose files differ is never sent', async () => {
  const decoy = torrentFile([FILES[0], { name: 'other.mkv', length: FILES[1].length }])
  const state: FakeState = { calls: [], torrents: { real: decoy.bytes }, torrentResults: () => [result({})] }
  const restore = install(state)
  try {
    const built = await buildDownloadPlan(
      prowlarrConfig({ download_mode: 'torrent_only' }),
      [{ key: 'show-1', release: 0 }],
      {
        results: privateResults(),
      },
    )
    assert.equal(built.review.units.length, 0)
    assert.equal(built.review.blocked[0].code, 'private_no_match')
    assert.match(built.review.blocked[0].reason, /none holds exactly the files SeaDex lists/)
  } finally {
    restore()
  }
})

test('public-tracker mode and a missing Prowlarr keep private-tracker releases manual', async () => {
  const state: FakeState = { calls: [], torrentResults: () => [result({})] }
  const restore = install(state)
  try {
    for (const config of [
      prowlarrConfig({ download_mode: 'torrent_only', tracker_mode: 'public' }),
      prowlarrConfig({ download_mode: 'torrent_only', prowlarr_enabled: false }),
    ]) {
      const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0 }], { results: privateResults() })
      assert.equal(built.review.blocked[0].code, 'no_torrent')
      assert.match(built.review.blocked[0].reason, /Set up Prowlarr/)
    }
    assert.equal(state.calls.filter(call => call.startsWith(`GET ${PROWLARR}`)).length, 0)
  } finally {
    restore()
  }
})

test('Usenet copies of private-tracker releases are searched only when asked for', async () => {
  const state: FakeState = {
    calls: [],
    nzbs: { wrong: nzb([`"${FILES[0].name}" yEnc (1/10) 5`]), right: MATCHING_NZB },
    usenetResults: () => [
      // Not by the release group: ranked last, and never fetched once a better candidate is proven.
      result({
        guid: 'other',
        indexerId: 2,
        protocol: 'usenet',
        title: 'Show 1080p',
        downloadUrl: `${PROWLARR}/2/download?link=other`,
      }),
      result({
        guid: 'wrong',
        indexerId: 2,
        protocol: 'usenet',
        title: '[Vault] Show',
        size: TOTAL * 1.02,
        downloadUrl: `${PROWLARR}/2/download?link=wrong`,
      }),
      result({
        guid: 'right',
        indexerId: 2,
        protocol: 'usenet',
        title: '[Vault] Show (BD 1080p)',
        size: TOTAL * 1.06,
        downloadUrl: `${PROWLARR}/2/download?link=right`,
      }),
    ],
  }
  const restore = install(state)
  try {
    const config = prowlarrConfig({ download_mode: 'usenet_only' })
    const results = privateResults()
    const selections = [{ key: 'show-1', release: 0 }]
    const [unchecked] = await usenetAvailability(config, selections, results)
    assert.equal(unchecked.search, 'prowlarr')
    assert.equal(unchecked.aggregate, 'not_checked')
    assert.equal(prowlarrCalls(state), 0)

    // A bulk review never searches on its own.
    const bulk = await buildDownloadPlan(config, [...selections, { key: 'missing', release: 0 }], { results })
    assert.equal(bulk.review.blocked.find(row => row.key === 'show-1')?.code, 'not_searched')
    assert.equal(prowlarrCalls(state), 0)

    // A refresh alone (as bulk "Refresh review" sends) never searches Prowlarr.
    await usenetAvailability(config, selections, results, { refresh: true })
    assert.equal(prowlarrCalls(state), 0)
    const [searching] = await usenetAvailability(config, selections, results, { search: selections })
    assert.equal(searching.refreshing, true)
    const [found] = await settledAvailability(config, selections, results)
    assert.equal(found.aggregate, 'available')
    assert.equal(found.hashes[0].provider, 'prowlarr')
    assert.equal(found.hashes[0].hash, source.id)
    assert.equal(found.hashes[0].proof, 'exact')
    // The candidate that names every file is checked first and proven, so no other NZB is fetched.
    assert.equal(state.calls.filter(call => call.includes('link=other')).length, 0)
    assert.equal(state.calls.filter(call => call.includes('link=wrong')).length, 0)

    const built = await buildDownloadPlan(config, selections, { results })
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.review.units[0].provider, 'prowlarr')
    assert.equal(built.review.units[0].source_hash, source.id)
    const { completion } = await acceptDownloadPlan(config, consumePlan(built.plan.id)!, { disk_space: true }, results)
    await completion
    assert.equal(state.sabAdded?.nzb, MATCHING_NZB)
    assert.equal(state.sabAdded?.name, '[Vault] Show (BD 1080p)')
    const [record] = downloadRecords()
    assert.equal(record.protocol, 'usenet')
    assert.equal(record.source_hash, source.id)
    assert.equal(record.provider, 'prowlarr')
    // The checked NZB is sent as it was fetched: one grab per candidate, none for the submission.
    assert.equal(state.calls.filter(call => call.includes('link=right')).length, 1)

    // A second review sees the job it owns instead of sending the release again.
    const again = await buildDownloadPlan(config, selections, { results })
    assert.equal(again.review.units[0].status, 'existing')
  } finally {
    restore()
  }
})

test('the ledger keeps file-list identities for Usenet only, and the Prowlarr key stays secret', () => {
  const restore = install({ calls: [] })
  try {
    const record = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'sab',
      state: 'accepted',
      native_id: 'nzo1',
      source_hash: source.id,
      category: 'sonarr-anime',
      provider: 'prowlarr',
      entry_id: '2-abc',
    })
    resetOwnedRuntime()
    assert.deepEqual(
      downloadRecords().map(saved => [saved.id, saved.source_hash, saved.provider]),
      [[record.id, source.id, 'prowlarr']],
    )
    assert.throws(
      () =>
        addDownloadRecord({
          protocol: 'torrent',
          client: 'qbittorrent',
          endpoint: 'qb',
          state: 'accepted',
          source_hash: source.id,
          category: 'x',
        }),
      /Invalid source hash/,
    )
    const config = applyConfigUpdate(baseConfig(), {
      prowlarr_url: `${PROWLARR}/`,
      prowlarr_key: KEY,
      prowlarr_enabled: true,
    })
    assert.equal(config.prowlarr_url, PROWLARR)
    const shown = publicConfig(config)
    assert.equal(shown.prowlarr_key, '')
    assert.equal(shown.prowlarr_key_configured, true)
    assert.throws(() => applyConfigUpdate(config, { prowlarr_url: 'ftp://x' }), /prowlarr_url/)
  } finally {
    restore()
  }
})

test('downloads of private-tracker releases stay attached to their release row', () => {
  const seasons = privateResults()
  const row = { key: 'show-1', release: 0 }
  const progress = {
    protocol: 'torrent',
    source_hash: 'b'.repeat(40),
    source_alias: source.id,
    associations: [row],
    category: 'sonarr-anime',
  } as unknown as DownloadProgress
  assert.deepEqual(currentDownloadAssociations(progress, seasons), [row])
  // A scoped torrent covers only the release whose selected files it holds.
  assert.deepEqual(currentDownloadAssociations({ ...progress, scope: [FILES[0].name] }, seasons), [])
  const usenet = { ...progress, protocol: 'usenet', source_hash: source.id, source_alias: undefined }
  assert.deepEqual(currentDownloadAssociations(usenet as DownloadProgress, seasons), [row])
  const other = { ...progress, source_alias: filesSourceId([FILES[0]]) }
  assert.deepEqual(currentDownloadAssociations(other, seasons), [])
})

test('an unproven NZB is listed with its indexer page and can be downloaded when the user chooses it', async () => {
  // Episode 2 was renamed on Usenet, so the post cannot be proven to be the release.
  const renamed = nzb([
    `[1/2] - "${FILES[0].name}" yEnc (1/2000) ${FILES[0].length}`,
    `[2/2] - "Show 02.mkv" yEnc (1/1900) ${FILES[1].length}`,
  ])
  const state: FakeState = {
    calls: [],
    nzbs: { close: renamed },
    usenetResults: () => [
      result({
        guid: 'https://geek.test/details/abc',
        indexerId: 2,
        indexer: 'Geek',
        protocol: 'usenet',
        title: '[Vault] Show',
        size: Math.round(TOTAL * 1.05),
        infoUrl: `https://geek.test/details/abc?apikey=secret`,
        downloadUrl: `${PROWLARR}/2/download?apikey=${KEY}&link=close`,
      }),
    ],
  }
  const restore = install(state)
  try {
    const config = prowlarrConfig({ download_mode: 'usenet_only' })
    const results = privateResults()
    await resolveSource(config, source, { titles: ['Show'], releaseGroup: 'Vault' }, { limit: 3 })
    const [row] = await usenetAvailability(config, [{ key: 'show-1', release: 0 }], results)
    assert.equal(row.aggregate, 'no_match')
    const [candidate] = row.hashes[0].candidates!
    assert.deepEqual(
      { ...candidate, entry_id: undefined },
      {
        entry_id: undefined,
        title: '[Vault] Show',
        indexer: 'Geek',
        size: Math.round(TOTAL * 1.05),
        // The page address carrying an API key is skipped for the next safe one, the result's GUID.
        info_url: 'https://geek.test/details/abc',
        files_matched: 1,
        names_matched: 1,
        files_expected: 2,
        sizes_known: true,
        checked: true,
        proof: 'unverified',
      },
    )
    assert.ok(!JSON.stringify(row).includes(KEY) && !JSON.stringify(row).includes('secret'))

    // Without a choice the release stays unavailable; choosing the candidate sends exactly the checked NZB.
    const plain = await buildDownloadPlan(config, [{ key: 'show-1', release: 0 }], { results })
    assert.equal(plain.review.blocked[0].code, 'no_match')
    const chosen = { key: 'show-1', release: 0, protocol: 'usenet' as const, nzb: candidate.entry_id }
    const unknown = await buildDownloadPlan(config, [{ ...chosen, nzb: `2-${'0'.repeat(20)}` }], { results })
    assert.equal(unknown.review.blocked[0].code, 'not_searched')
    const built = await buildDownloadPlan(config, [chosen], { results })
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.plan.selections[0].nzb, candidate.entry_id)
    const { completion } = await acceptDownloadPlan(config, consumePlan(built.plan.id)!, { disk_space: true }, results)
    await completion
    assert.equal(state.sabAdded?.nzb, renamed)
    assert.equal(downloadRecords()[0].source_hash, source.id)
    assert.equal(state.calls.filter(call => call.includes('link=close')).length, 1)
  } finally {
    restore()
  }
})

test('Prowlarr download redirects are followed to the indexer, and candidates that cannot be fetched stay visible', async () => {
  const state: FakeState = {
    calls: [],
    nzbs: { proven: MATCHING_NZB },
    usenetResults: () => [
      result({
        guid: 'magnet',
        indexerId: 2,
        protocol: 'usenet',
        title: '[Vault] Show v0',
        size: Math.round(TOTAL * 1.04),
        infoUrl: 'https://geek.test/details/magnet',
        downloadUrl: `${PROWLARR}/2/download?link=${encodeURIComponent('redirect:magnet:?xt=urn:btih:abc')}`,
      }),
      result({
        guid: 'proven',
        indexerId: 2,
        protocol: 'usenet',
        title: '[Vault] Show',
        size: Math.round(TOTAL * 1.07),
        downloadUrl: `${PROWLARR}/2/download?link=${encodeURIComponent('redirect:https://geek.test/getnzb?id=proven&r=indexer-key')}`,
      }),
    ],
  }
  const restore = install(state)
  try {
    const config = prowlarrConfig({ download_mode: 'usenet_only' })
    const terms = { titles: ['Show'], releaseGroup: 'Vault' }
    const lookup = await resolveSource(config, source, terms, { limit: 3 })
    assert.equal(lookup.availability.state, 'available')
    assert.ok(state.calls.some(call => call.startsWith('GET https://geek.test/getnzb?id=proven')))

    state.nzbs = {}
    forgetUsenetSearches()
    const missing = await resolveSource(config, source, terms, { limit: 3 })
    assert.equal(missing.availability.state, 'no_match')
    const [row] = await usenetAvailability(config, [{ key: 'show-1', release: 0 }], privateResults())
    // Neither file could be read. What a candidate says names its indexer and never what the indexer answered.
    assert.deepEqual(
      row.hashes[0].candidates!.map(candidate => [candidate.title, candidate.checked, candidate.unavailable]),
      [
        ['[Vault] Show', false, 'Geek did not send a usable NZB.'],
        ['[Vault] Show v0', false, 'Geek did not send a usable NZB.'],
      ],
    )
    const candidates = row.hashes[0].candidates!
    assert.equal(candidates[1].info_url, 'https://geek.test/details/magnet')
    const chosen = { key: 'show-1', release: 0, protocol: 'usenet' as const, nzb: candidates[0].entry_id }
    const built = await buildDownloadPlan(config, [chosen], { results: privateResults() })
    assert.equal(built.review.blocked[0].code, 'not_searched')
  } finally {
    restore()
  }
})

test('a public release with no NZB names the hash indexers that were asked, never Prowlarr', async () => {
  const original = globalThis.fetch
  const asked: string[] = []
  resetUsenetLookups()
  globalThis.fetch = async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return new Response('not found', { status: 404 })
  }
  try {
    const state = await resolveUsenetHash(prowlarrConfig({ download_mode: 'usenet_only' }), 'c'.repeat(40))
    assert.equal(state.state, 'no_match')
    assert.deepEqual(state.providers_checked, ['animetosho'])
    assert.ok(asked.every(url => !url.startsWith(PROWLARR)))
  } finally {
    globalThis.fetch = original
    resetUsenetLookups()
  }
})

test('a public release the hash indexers lack can be searched on Prowlarr and sent under its torrent hash', async () => {
  const HASH = 'd'.repeat(40)
  const state: FakeState = {
    calls: [],
    nzbs: { found: MATCHING_NZB },
    usenetResults: () => [
      result({
        guid: 'found',
        indexerId: 2,
        protocol: 'usenet',
        title: '[Vault] Show 1080p',
        size: Math.round(TOTAL * 1.05),
        downloadUrl: `${PROWLARR}/2/download?link=found`,
      }),
    ],
  }
  const restore = install(state)
  const routed = globalThis.fetch
  // AnimeTosho has no entry for the hash.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('animetosho') ? new Response('missing', { status: 404 }) : routed(input, init)
  try {
    // Public releases are searchable even in public-tracker mode.
    const config = prowlarrConfig({ download_mode: 'usenet_only', tracker_mode: 'public' })
    const results = [
      resultFixture([
        releaseFixture({
          releaseGroup: 'Vault',
          info_hashes: [HASH],
          size: TOTAL,
          part: '',
          torrent_files: [{ hash: HASH, files: FILES }],
        }),
      ]),
    ] as unknown as ResultItem[]
    const selections = [{ key: 'show-1', release: 0 }]
    await resolveUsenetHash(config, HASH)
    const [missing] = await usenetAvailability(config, selections, results)
    assert.equal(missing.aggregate, 'no_match')
    assert.equal(missing.fallback, 'prowlarr')
    assert.deepEqual(missing.hashes[0].providers_checked, ['animetosho'])
    assert.equal(prowlarrCalls(state), 0, 'nothing is searched until asked')

    const bulk = await buildDownloadPlan(config, [...selections, { key: 'gone', release: 0 }], { results })
    assert.equal(bulk.review.blocked.find(row => row.key === 'show-1')?.code, 'no_match')
    assert.match(bulk.review.blocked.find(row => row.key === 'show-1')!.reason, /Search Prowlarr/)
    assert.equal(prowlarrCalls(state), 0)

    await usenetAvailability(config, selections, results, { search: selections })
    const [found] = await settledAvailability(config, selections, results)
    assert.equal(found.search, 'prowlarr')
    assert.equal(found.aggregate, 'available')

    const built = await buildDownloadPlan(config, selections, { results })
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.review.units[0].source_hash, HASH)
    assert.equal(built.review.units[0].provider, 'prowlarr')
    const { completion } = await acceptDownloadPlan(config, consumePlan(built.plan.id)!, { disk_space: true }, results)
    await completion
    assert.equal(state.sabAdded?.nzb, MATCHING_NZB)
    const [record] = downloadRecords()
    assert.equal(record.source_hash, HASH)
    assert.equal(record.provider, 'prowlarr')
  } finally {
    globalThis.fetch = routed
    restore()
  }
})

test('search titles follow Sonarr: cleaned scene titles, then AniList titles, without duplicates', () => {
  assert.equal(
    cleanSearchTitle("Banished From the Hero's Party, I Decided To Live a Quiet Life in the Countryside"),
    'Banished From the Heros Party I Decided To Live a Quiet Life in the Countryside',
  )
  assert.equal(cleanSearchTitle('The Café & Re:Zero – Mr. Ōkami'), 'Cafe and Re Zero Mr Okami')
  assert.equal(cleanSearchTitle('-ZR-'), 'ZR')
  assert.deepEqual(
    searchTitles({
      title: "Banished From the Hero's Party",
      search_titles: ['Shin no Nakama', 'banished from the heros party'],
      anilist_id: null,
    }),
    ['Banished From the Heros Party', 'Shin no Nakama'],
  )
  // Every title is returned; how many are searched is up to each search.
  const many = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']
  assert.deepEqual(searchTitles({ title: 'Zero', search_titles: many, anilist_id: null }), ['Zero', ...many])
})

test('Usenet searches ask each Usenet indexer by title and by release group, and never name a category', async () => {
  const queries: URLSearchParams[] = []
  // The candidate states no size, so it does not end the search and every query is sent.
  const state: FakeState = {
    calls: [],
    usenetResults: () => [
      result({
        guid: 'likely',
        indexerId: 2,
        protocol: 'usenet',
        title: '[-ZR-] Show',
        size: 0,
        downloadUrl: `${PROWLARR}/2/download?link=likely`,
      }),
    ],
  }
  const restore = install(state)
  const routed = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/2/api') queries.push(url.searchParams)
    return routed(input, init)
  }
  try {
    const config = prowlarrConfig({ download_mode: 'usenet_only' })
    const results = privateResults({ releaseGroup: '-ZR-' })
    results[0].title = "Banished From the Hero's Party"
    results[0].search_titles = ['Shin no Nakama ja Nai to Yuusha no Party wo Oidasareta node']
    const selections = [{ key: 'show-1', release: 0 }]
    await usenetAvailability(config, selections, results, { search: selections })
    await settledAvailability(config, selections, results)
    assert.deepEqual(
      queries.map(query => query.get('q')),
      [
        // The file names do not carry the group, so the title alone is asked first, within the size of a post.
        'Banished From the Heros Party',
        'ZR Banished From the Heros Party',
        'ZR Shin no Nakama ja Nai to Yuusha no Party wo Oidasareta node',
      ],
    )
    assert.deepEqual(
      [queries[0].get('minsize'), queries[0].get('maxsize')],
      [String(Math.floor(TOTAL * 0.97)), String(Math.ceil(TOTAL * 1.35))],
    )
    for (const query of queries) {
      assert.equal(query.has('cat'), false)
      assert.equal(query.has('categories'), false)
    }
    // Each Usenet indexer is asked on its own; the torrent indexers and the disabled one are not asked at all.
    assert.equal(state.calls.filter(call => /\/\d+\/api\?/.test(call)).length, queries.length)
    assert.equal(state.calls.filter(call => call.includes('/api/v1/search')).length, 0)
  } finally {
    globalThis.fetch = routed
    restore()
  }
})

test('private-tracker downloads are offered only for trackers Prowlarr has an indexer for', async () => {
  const state: FakeState = { calls: [] }
  const restore = install(state)
  try {
    const settings = { baseUrl: PROWLARR, apiKey: KEY }
    assert.deepEqual(await prowlarrCoverage(settings, ['AB', 'BeyondHD', 'Nyaa']), { trackers: ['AB'], usenet: true })
    const config = {
      ...publicConfig(prowlarrConfig()),
    }
    const release = privateResults()[0].releases[0]
    assert.equal(findsPrivateTorrent(release, config), false, 'unknown coverage offers nothing')
    assert.equal(findsPrivateTorrent(release, { ...config, prowlarr_coverage: { trackers: [], usenet: true } }), false)
    assert.equal(
      findsPrivateTorrent(release, { ...config, prowlarr_coverage: { trackers: ['ab'], usenet: true } }),
      true,
    )

    // Without a Usenet indexer, no Prowlarr search is offered for the release.
    state.indexers = INDEXERS.filter(indexer => indexer.protocol !== 'usenet')
    resetProwlarrRuntime()
    await prowlarrIndexers(settings)
    const results = privateResults()
    const selections = [{ key: 'show-1', release: 0 }]
    const [row] = await usenetAvailability(prowlarrConfig({ download_mode: 'usenet_only' }), selections, results, {
      search: selections,
    })
    assert.equal(row.aggregate, 'not_configured')
    assert.equal(row.hashes[0].error, 'Prowlarr has no Usenet indexer.')
    assert.equal(row.refreshing, false)
    assert.equal(state.calls.filter(call => /\/api\/v1\/search|\/\d+\/api\?/.test(call)).length, 0)
  } finally {
    restore()
  }
})
