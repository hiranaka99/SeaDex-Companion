import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
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
import { collectDownloadProgress } from '../server/download-progress.js'
import { applyConfigUpdate, DEFAULT_CONFIG } from '../server/config.js'
import { qbEndpointId } from '../server/client-identity.js'
import { resetQbRuntime } from '../server/qbittorrent.js'
import { sendImportProblem } from '../server/notifications.js'
import type { ArrInstance } from '../server/arr-instances.js'
import type { Config, ResultItem } from '../server/types.js'

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
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }) as typeof fetch
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } })
    if (url.pathname.endsWith('/torrents/info')) return Response.json([torrentState])
    return new Response('Ok.')
  }) as typeof fetch
  try {
    const download = record({
      source_hash: 'c'.repeat(40),
      library: [{ key: 'Sonarr@uhd4k:item7', season: 1, part: '', group: 'Best' }],
    })
    assert.deepEqual((await collectDownloadProgress(config)).downloads[download.id].import, {
      state: 'waiting',
      app: 'Sonarr 4K',
    })
    torrentState = { ...torrentState, state: 'stalledUP', progress: 1 }
    const finished = (await collectDownloadProgress(config)).downloads[download.id]
    assert.equal(finished.phase, 'seeding')
    assert.equal(
      finished.import?.state,
      'pending',
      'The read that sees the download finish already reports the wait for import',
    )
    assert.equal(finished.import?.app, 'Sonarr 4K')
    updateDownloadImport(download.id, { state: 'blocked', message: 'Unable to parse file' })
    assert.deepEqual((await collectDownloadProgress(config)).downloads[download.id].import, {
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
