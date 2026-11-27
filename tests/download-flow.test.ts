// Plan-acceptance flow regressions: modes, dedup, conflicts, intent-before-mutation,
// ambiguous SABnzbd handling, progress phases, and ownership-only cancellation.
// Runs inside the shared temp DATA_DIR (tests/run-tests.mjs) or standalone with DATA_DIR set.
import assert from 'node:assert/strict'
// static imports continue below
import { test } from 'node:test'
import { bumpGeneration, currentGeneration } from '../server/config-generation.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { HttpError } from '../server/http-error.js'
import { matchRoute } from '../server/router.js'
import { consumePlan, putPlan } from '../server/download-plans.js'
import { acceptDownloadPlan, PlanRejected, receiptFromJob } from '../server/download-submit.js'
import { downloadJobs } from '../server/download-jobs.js'
import { addDownloadRecord, allDownloadRecords, downloadRecords, findDownloadRecord } from '../server/download-store.js'
import { findTorrentRecord } from './support/ledger.js'
import { collectDownloadProgress, cancelRecords, controlRecord, OwnershipError } from '../server/download-progress.js'
import { qbPhase } from '../server/qbittorrent-adapter.js'
import { historyPhase, queuePhase } from '../server/sabnzbd-adapter.js'
import { resetQbRuntime } from '../server/qbittorrent.js'
import { ResultItem } from '../server/types.js'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { downloadRoutes } from '../server/download-routes.js'

import {
  HASH,
  QB,
  baseConfig,
  releaseFixture,
  resultFixture,
  type RouterState,
  installRouter,
  animetoshoMatch,
} from './support/download-fixtures.js'

test('torrent_only mode refuses usenet selections and choose mode requires an explicit protocol', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const refused = await buildDownloadPlan(
      baseConfig({ download_mode: 'torrent_only' }),
      [{ key: 'show-1', release: 0, protocol: 'usenet' }],
      { results },
    )
    assert.ok('review' in refused)
    assert.deepEqual(
      refused.review.blocked.map(row => row.code),
      ['mode_conflict'],
    )
    assert.equal(refused.review.units.length, 0)

    const missing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0 }], { results })
    assert.ok('review' in missing)
    assert.deepEqual(
      missing.review.blocked.map(row => row.code),
      ['protocol_required'],
    )
  } finally {
    cleanup()
  }
})

test('usenet rows are blocked while SABnzbd is missing and identities are enforced', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const noSab = await buildDownloadPlan(
      baseConfig({ sabnzbd_key: '' }),
      [{ key: 'show-1', release: 0, protocol: 'usenet' }],
      { results },
    )
    assert.ok('review' in noSab)
    assert.deepEqual(
      noSab.review.blocked.map(row => row.code),
      ['usenet_unconfigured'],
    )

    await assert.rejects(
      buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet', identity: 'stale-identity' }], {
        results,
      }),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    )
  } finally {
    cleanup()
  }
})

test('two cours sharing one hash produce one deduplicated torrent unit carrying both selections', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [
      resultFixture([releaseFixture({ part: 'Cour 1' })]),
      resultFixture([releaseFixture({ part: 'Cour 2' })], { key: 'show-2' }),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(
      baseConfig(),
      [
        { key: 'show-1', release: 0, protocol: 'torrent' },
        { key: 'show-2', release: 0, protocol: 'torrent' },
      ],
      { results },
    )
    assert.ok('review' in built)
    assert.equal(built.review.units.length, 1)
    assert.equal(built.review.units[0].selections.length, 2)
    assert.equal(built.review.new_torrents, 1)
    assert.equal(built.review.new_nzbs, 0)
  } finally {
    cleanup()
  }
})

test('a hash already present in qBittorrent is an existing unit, never a new submission', async () => {
  const cleanup = installRouter({
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'uploading', progress: 0.5, size: 1000 }],
  })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    assert.equal(built.review.units[0].status, 'existing')
    assert.equal(built.review.new_torrents, 0)
    assert.equal(built.review.existing_units, 1)
  } finally {
    cleanup()
  }
})

test('the same source requested through both protocols is blocked as a conflict', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [
      resultFixture([releaseFixture({ part: 'Cour 1' })]),
      resultFixture([releaseFixture({ part: 'Cour 2' })], { key: 'show-2' }),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(
      baseConfig(),
      [
        { key: 'show-1', release: 0, protocol: 'torrent' },
        { key: 'show-2', release: 0, protocol: 'usenet' },
      ],
      { results },
    )
    assert.ok('review' in built)
    assert.equal(built.review.units.length, 0)
    assert.deepEqual([...new Set(built.review.blocked.map(row => row.code))], ['conflict'])
  } finally {
    cleanup()
  }
})

test('usenet whole-source scope is surfaced with known extra files and forces the acknowledgement', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    const unit = built.review.units[0]
    assert.equal(unit.protocol, 'usenet')
    assert.equal(unit.whole_source, true)
    assert.equal(unit.scope_expanded, true)
    assert.deepEqual(unit.known_extra_files, ['Show - 02.nfo'])
    assert.equal(built.review.requires_whole_ack, true)
    assert.equal(built.review.new_nzbs, 1)
    assert.ok(built.review.disk_space.every(check => check.client === 'sabnzbd' && check.unknown_units === 1))
  } finally {
    cleanup()
  }
})

test('plans are single-use and stale generations or missing acknowledgements are refused at acceptance', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const config = baseConfig()
    const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in built)
    const planId = built.review.plan_id
    assert.ok(built.review.requires_whole_ack)

    await assert.rejects(
      acceptDownloadPlan(config, consumePlan(planId)!, undefined, results),
      (error: PlanRejected) => error.status === 409 && /whole Usenet sources/.test(error.message),
    )
    assert.equal(consumePlan(planId), null, 'a consumed plan can never be replayed')

    const fresh = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in fresh)
    bumpGeneration()
    await assert.rejects(
      acceptDownloadPlan(config, consumePlan(fresh.review.plan_id)!, { whole_source: true }, results),
      (error: PlanRejected) => error.status === 409 && /Settings changed/.test(error.message),
    )
  } finally {
    cleanup()
  }
})

test('torrent acceptance writes the intent before the client call and finalizes it as accepted', async () => {
  let intentVisibleDuringAdd = false
  let intentStateDuringAdd = ''
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const originalAdd = globalThis.fetch
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    const plan = consumePlan(built.review.plan_id)!
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/torrents/add') && init?.method === 'POST') {
        const record = findTorrentRecord(HASH)
        intentVisibleDuringAdd = Boolean(record)
        intentStateDuringAdd = record?.state || ''
      }
      return originalAdd(input, init)
    }
    const { job, completion } = await acceptDownloadPlan(baseConfig(), plan, undefined, results)
    const result = await completion
    assert.equal(intentVisibleDuringAdd, true, 'the intent record must exist while the client call runs')
    assert.equal(intentStateDuringAdd, 'acceptance_unknown')
    assert.equal(result.count, 1)
    const record = findTorrentRecord(HASH)!
    assert.equal(record.state, 'accepted')
    assert.equal(record.native_id, HASH)
    assert.equal(record.endpoint, QB.toLowerCase())
    assert.deepEqual(
      downloadRecords().map(entry => entry.id),
      [record.id],
    )
    const finalJob = downloadJobs.get(job.id)!
    assert.equal(finalJob.added.length, 1)
    const receipt = receiptFromJob(finalJob)
    assert.ok(!('error' in receipt) && receipt.ok && receipt.native_id === HASH)
  } finally {
    globalThis.fetch = originalAdd
    cleanup()
  }
})

test('a clean client rejection tombstones the intent and reports the row as failed', async () => {
  const cleanup = installRouter({ calls: [], qbAddStatus: 409 })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(
      baseConfig(),
      consumePlan(built.review.plan_id)!,
      undefined,
      results,
    )
    const result = await completion
    assert.equal(result.count, 0)
    assert.equal(result.rows[0].status, 'failed')
    assert.equal(findTorrentRecord(HASH), null, 'rejected intent must leave the active ledger')
    assert.equal(allDownloadRecords()[0]?.removed_at !== undefined, true, 'the tombstone audit must survive')
  } finally {
    cleanup()
  }
})

test('an ambiguous SABnzbd outcome keeps the record, never retries the add, and says so', async () => {
  let addCalls = 0
  const state: RouterState = {
    calls: [],
    animetosho: animetoshoMatch,
    sabAddResult: () => {
      addCalls++
      return Promise.reject(new TypeError('network'))
    },
  }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(
      baseConfig(),
      consumePlan(built.review.plan_id)!,
      { whole_source: true, disk_space: true },
      results,
    )
    const result = await completion
    assert.equal(addCalls, 1, 'an ambiguous submission must never be retried automatically')
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].code, 'acceptance_unknown')
    assert.match(result.failures[0].error, /Check SABnzbd before retrying/)
    const record = downloadRecords().find(entry => entry.protocol === 'usenet')!
    assert.equal(record.state, 'acceptance_unknown')
  } finally {
    cleanup()
  }
})

test('progress maps both clients to labeled phases and refuses endpoint-mismatched records', async () => {
  const cleanup = installRouter({
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'stalledDL', progress: 0.5, size: 1000, dlspeed: 10 }],
    sabQueue: [
      {
        nzo_id: 'nzoQ',
        name: 'Show',
        status: 'Downloading',
        cat: 'anime',
        mb: '500.0',
        mb_done: '125.0',
        speed: '1.0 MiB/s',
        percentage: 25,
        labels: [],
      },
    ],
    sabHistory: [
      {
        nzo_id: 'nzoH',
        name: 'Show',
        status: 'Extracting',
        cat: 'anime',
        size: '500.0',
        byte_size: 500_000_000,
        downloaded: 500_000_000,
        storage: '/downloads/anime/show',
        loaded: false,
      },
    ],
  })
  try {
    const config = baseConfig()
    const qbRecord = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: QB.toLowerCase(),
      native_id: HASH,
      state: 'accepted',
      source_hash: HASH,
      category: 'anime',
      labels: [],
      rows: [{ key: 'show-1', release: 0 }],
      card: { title: 'Show', season: 1, part: 'Cour 1', release_group: 'Group', tracker: 'Nyaa', size: 1000 },
    })
    const queueRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'http://sab.test:8080',
      native_id: 'nzoQ',
      state: 'accepted',
      source_hash: 'c'.repeat(40),
      category: 'anime',
      labels: [],
      rows: [],
    })
    const historyRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'http://sab.test:8080',
      native_id: 'nzoH',
      state: 'accepted',
      source_hash: 'd'.repeat(40),
      category: 'anime',
      labels: [],
      rows: [],
    })
    const foreignRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'http://other-sab.test:8080',
      native_id: 'nzoX',
      state: 'accepted',
      source_hash: 'e'.repeat(40),
      category: 'anime',
      labels: [],
      rows: [],
    })
    const unknownRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: 'http://sab.test:8080',
      native_id: '',
      state: 'acceptance_unknown',
      source_hash: 'f'.repeat(40),
      category: 'anime',
      labels: [],
      rows: [],
    })

    const progress = await collectDownloadProgress(config)
    assert.equal(progress.downloads[qbRecord.id].phase, 'downloading')
    assert.deepEqual(progress.downloads[qbRecord.id].associations, [{ key: 'show-1', release: 0 }])
    assert.equal(progress.downloads[queueRecord.id].phase, 'downloading')
    assert.equal(progress.downloads[queueRecord.id].capabilities.pause, true)
    assert.equal(progress.downloads[historyRecord.id].phase, 'unpacking')
    assert.equal(progress.downloads[historyRecord.id].capabilities.remove_files, false)
    assert.equal(progress.downloads[foreignRecord.id].phase, 'unavailable')
    assert.equal(progress.downloads[foreignRecord.id].state, 'unbound')
    assert.equal(progress.downloads[foreignRecord.id].capabilities.remove, false)
    assert.equal(progress.downloads[unknownRecord.id].phase, 'acceptance_unknown')

    await assert.rejects(controlRecord(config, foreignRecord.id, 'pause', false), OwnershipError)
    const cancel = await cancelRecords(config, [foreignRecord.id], false)
    assert.equal(cancel.removed.length, 0)
    assert.equal(cancel.failures.length, 1)
  } finally {
    cleanup()
  }
})

test('unreachable clients keep the persisted last phase instead of inventing missing', async () => {
  const cleanup = installRouter({
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'downloading', progress: 0.4, size: 1000, dlspeed: 5 }],
  })
  try {
    const config = baseConfig()
    const record = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: QB.toLowerCase(),
      native_id: HASH,
      state: 'accepted',
      source_hash: HASH,
      category: 'anime',
      labels: [],
      rows: [],
    })
    const first = await collectDownloadProgress(config)
    assert.equal(first.downloads[record.id].phase, 'downloading')
    assert.equal(findDownloadRecord(record.id)!.last_phase, 'downloading')

    globalThis.fetch = async () => {
      throw new TypeError('offline')
    }
    resetQbRuntime()
    const second = await collectDownloadProgress(config)
    assert.equal(second.downloads[record.id].phase, 'downloading')
    assert.ok(second.unavailable_clients?.includes('qbittorrent'))
  } finally {
    cleanup()
  }
})

test('cancellation only ever touches app-owned records and audits removal', async () => {
  const state: RouterState = {
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'downloading', progress: 0.5, size: 1000, dlspeed: 5 }],
  }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const record = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: QB.toLowerCase(),
      native_id: HASH,
      state: 'accepted',
      source_hash: HASH,
      category: 'anime',
      labels: [],
      rows: [{ key: 'show-1', release: 0 }],
    })
    const cancel = await cancelRecords(config, undefined, false)
    assert.deepEqual(cancel.removed, [{ record_id: record.id, client: 'qbittorrent' }])
    assert.ok(state.calls.some(call => call.includes('/torrents/delete')))
    assert.equal(downloadRecords().length, 0)
    assert.equal(allDownloadRecords()[0].removed_at !== undefined, true)
  } finally {
    cleanup()
  }
})

test('phase maps cover the client-specific vocabularies', () => {
  assert.equal(qbPhase('missingFiles', 0.5), 'error')
  assert.equal(qbPhase('uploading', 1), 'seeding')
  assert.equal(qbPhase('pausedUP', 1), 'complete')
  assert.equal(qbPhase('queuedDL', 0), 'queued')
  assert.equal(qbPhase('checkingUP', 1), 'verifying')
  assert.equal(queuePhase('Propagating'), 'queued')
  assert.equal(queuePhase('Paused'), 'paused')
  assert.equal(historyPhase('QuickCheck'), 'verifying')
  assert.equal(historyPhase('Running'), 'post_processing')
  assert.equal(historyPhase('Failed'), 'error')
})

test('a rejected plan row still lets the other rows submit', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = [
      resultFixture([releaseFixture()]),
      resultFixture([releaseFixture({ info_hashes: ['b'.repeat(40)] })], {
        key: 'show-2',
        status: 'complete',
        upgrade_available: false,
      }),
    ] as unknown as ResultItem[]
    const plan = putPlan({
      config_generation: currentGeneration(),
      selections: [
        { key: 'show-1', release: 0, protocol: 'torrent' },
        { key: 'show-2', release: 0, protocol: 'torrent' },
      ],
      requires_whole_ack: false,
      requires_space_ack: false,
    })
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(plan.id)!, undefined, results)
    const result = await completion
    assert.deepEqual(
      result.rows.map(row => row.status),
      ['added', 'failed'],
    )
    assert.deepEqual(
      result.failures.map(failure => failure.code),
      ['not_upgradable'],
    )
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
  } finally {
    cleanup()
  }
})

test('a rejected download-job route releases operation ownership for the next request', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = putPlan({
        config_generation: currentGeneration() - 1,
        selections: [{ key: 'show-1', release: 0, protocol: 'torrent' }],
        requires_whole_ack: false,
        requires_space_ack: false,
      })
      const request = Readable.from([Buffer.from(JSON.stringify({ plan_id: plan.id }))]) as unknown as IncomingMessage
      request.method = 'POST'
      const response = {} as ServerResponse
      const url = new URL('http://companion.test/api/download-jobs')
      const { route } = matchRoute(downloadRoutes, 'POST', url.pathname)!
      await assert.rejects(
        async () => route.handle({ request, response, url, params: [] }),
        (error: PlanRejected) => error.status === 409 && /Settings changed/.test(error.message),
      )
    }
  } finally {
    cleanup()
  }
})

test('an intent write failure finalizes every pending unit without submitting to a client', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const write = fs.writeFileSync
  try {
    const results = [
      resultFixture([releaseFixture()]),
      resultFixture([releaseFixture({ info_hashes: ['b'.repeat(40)] })], { key: 'show-2' }),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(
      baseConfig(),
      [
        { key: 'show-1', release: 0, protocol: 'torrent' },
        { key: 'show-2', release: 0, protocol: 'torrent' },
      ],
      { results },
    )
    assert.ok('review' in built)
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(path).endsWith('owned_downloads.json.tmp')) throw new Error('ledger disk full')
      return Reflect.apply(write, fs, [path, ...args])
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    const { job, completion } = await acceptDownloadPlan(
      baseConfig(),
      consumePlan(built.review.plan_id)!,
      { disk_space: true },
      results,
    )
    await assert.rejects(completion, /ledger disk full/)
    const finished = downloadJobs.get(job.id)!
    assert.equal(finished.finished, true)
    assert.deepEqual(finished.pending, [])
    assert.equal(finished.failures.length, 2)
    assert.ok(finished.failures.every(failure => /ledger disk full/.test(failure.error)))
    assert.deepEqual(
      finished.failures.map(failure => failure.selections),
      [[{ key: 'show-1', release: 0 }], [{ key: 'show-2', release: 0 }]],
    )
    assert.equal(downloadJobs.active(), false)
    assert.equal(
      state.calls.some(call => call.includes('/torrents/add')),
      false,
    )
  } finally {
    fs.writeFileSync = write
    syncBuiltinESMExports()
    cleanup()
  }
})
