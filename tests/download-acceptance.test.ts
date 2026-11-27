// Plan-acceptance flow regressions: modes, dedup, conflicts, intent-before-mutation,
// ambiguous SABnzbd handling, progress phases, and ownership-only cancellation.
// Runs inside the shared temp DATA_DIR (tests/run-tests.mjs) or standalone with DATA_DIR set.
import assert from 'node:assert/strict'
// static imports continue below
import { test } from 'node:test'
import { downloadCategory } from '../server/config.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { spaceVerdict } from '../server/download-client-types.js'
import { consumePlan } from '../server/download-plans.js'
import { acceptDownloadPlan, PlanRejected, receiptFromJob } from '../server/download-submit.js'
import { downloadJobs } from '../server/download-jobs.js'
import { addDownloadRecord, downloadRecords, findDownloadRecord, resetOwnedRuntime } from '../server/download-store.js'
import { findTorrentRecord } from './support/ledger.js'
import { collectDownloadProgress } from '../server/download-progress.js'
import { resetUsenetLookups } from '../server/usenet.js'
import { ResultItem } from '../server/types.js'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

import {
  HASH,
  QB,
  SAB,
  baseConfig,
  releaseFixture,
  resultFixture,
  type RouterState,
  installRouter,
  animetoshoMatch,
} from './support/download-fixtures.js'

test('torrent and Usenet categories are separated for Sonarr and Radarr', async () => {
  const cleanup = installRouter({
    calls: [],
    animetosho: animetoshoMatch,
    sabCategories: ['*', 'nzb-tv', 'nzb-movies'],
  })
  try {
    const config = baseConfig({
      sonarr_category: 'torrent-tv',
      radarr_category: 'torrent-movies',
      sabnzbd_sonarr_category: 'nzb-tv',
      sabnzbd_radarr_category: 'nzb-movies',
    })
    assert.equal(downloadCategory(config, 'Sonarr', 'torrent'), 'torrent-tv')
    assert.equal(downloadCategory(config, 'Sonarr', 'usenet'), 'nzb-tv')
    assert.equal(downloadCategory(config, 'Radarr', 'torrent'), 'torrent-movies')
    assert.equal(downloadCategory(config, 'Radarr', 'usenet'), 'nzb-movies')
    for (const [arr, protocol, category] of [
      ['Sonarr', 'usenet', 'nzb-tv'],
      ['Radarr', 'usenet', 'nzb-movies'],
      ['Sonarr', 'torrent', 'torrent-tv'],
      ['Radarr', 'torrent', 'torrent-movies'],
    ] as const) {
      const results = [resultFixture([releaseFixture()], { arr })] as unknown as ResultItem[]
      const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in built)
      assert.equal(built.review.units[0].category, category)
    }
  } finally {
    cleanup()
  }
})

test('live disk and whole-source acknowledgements are checked before any intent or client mutation', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    assert.equal(built.plan.requires_space_ack, false)
    state.qbFreeBytes = '0'
    await assert.rejects(
      acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results),
      /disk space/,
    )
    assert.equal(downloadJobs.active(), false)
    assert.deepEqual(downloadRecords(), [])

    state.animetosho = () =>
      Response.json({
        id: 1234,
        info_hash: HASH,
        nzb_url: 'https://feed.animetosho.net/nzb/1234',
        status: 'complete',
        num_files: 1,
        total_size: 1000,
        files: [{ name: 'Show - 01.mkv', size: 1000, processed: true }],
      })
    const scopedResults = [
      resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })]),
    ] as unknown as ResultItem[]
    const scoped = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results: scopedResults,
    })
    assert.ok('review' in scoped)
    assert.equal(scoped.plan.requires_whole_ack, false)
    state.animetosho = animetoshoMatch
    resetUsenetLookups()
    await assert.rejects(
      acceptDownloadPlan(baseConfig(), consumePlan(scoped.plan.id)!, { disk_space: true }, scopedResults),
      /whole Usenet sources/,
    )
    assert.deepEqual(downloadRecords(), [])
    assert.equal(
      state.calls.some(call => /POST .*torrents\/add|POST .*sab\.test/.test(call)),
      false,
    )
  } finally {
    cleanup()
  }
})

test('accepted SABnzbd responses without IDs retain duplicate protection in the next review', async () => {
  const state: RouterState = {
    calls: [],
    animetosho: animetoshoMatch,
    sabAddResult: () => Response.json({ status: true }),
  }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(
      baseConfig(),
      consumePlan(built.plan.id)!,
      { disk_space: true },
      results,
    )
    await completion
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.acceptance_unknown, true)
    assert.equal(downloadRecords()[0].state, 'acceptance_unknown')
    const review = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in review)
    assert.deepEqual(
      review.review.blocked.map(row => row.code),
      ['acceptance_unknown'],
    )
    assert.deepEqual(review.review.units, [])
    assert.equal(state.calls.filter(call => /POST .*sab\.test/.test(call)).length, 1)
  } finally {
    cleanup()
  }
})

test('a torrent whose cleanup fails remains owned with its requested scope', async () => {
  const state: RouterState = { calls: [], qbFiles: [{ name: 'Different.mkv', index: 0 }], qbDeleteStatus: 500 }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture({ selected_files: ['Show - 01.mkv'] })])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.equal(result.ok, false)
    assert.match(result.failures[0].error, /cleanup/)
    const record = findTorrentRecord(HASH)!
    assert.equal(record.state, 'accepted')
    assert.equal(record.removed_at, undefined)
    assert.deepEqual(record.scope, ['Show - 01.mkv'])
    assert.equal(state.qbTorrents?.[0].hash, HASH)
  } finally {
    cleanup()
  }
})

test('single-release receipts include every failed source even after another source succeeds', () => {
  const selections = [{ key: 'show-1', release: 0 }]
  const success = {
    unit_id: `usenet:${HASH}`,
    protocol: 'usenet' as const,
    source_hash: HASH,
    label: 'Added',
    selections,
    record_id: 'u:added',
    native_id: 'nzo-added',
  }
  const failures = [
    {
      unit_id: 'usenet:missing',
      protocol: 'usenet' as const,
      label: 'Unknown source',
      code: 'acceptance_unknown',
      error: 'Check SABnzbd before retrying.',
      selections,
    },
    {
      unit_id: 'usenet:rejected',
      protocol: 'usenet' as const,
      label: 'Rejected source',
      code: 'client',
      error: 'Rejected by SABnzbd',
      selections,
    },
  ]
  const receipt = receiptFromJob({
    id: 'partial',
    finished: true,
    added: [success],
    existing: [],
    pending: [],
    failures,
    targets: selections,
  })
  assert.ok('ok' in receipt)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.acceptance_unknown, true)
  assert.deepEqual(receipt.failures, failures)
  assert.match(receipt.error || '', /1 source\(s\) ready, but 2 source\(s\) failed/)
  assert.match(receipt.error || '', /Unknown source/)
  assert.match(receipt.error || '', /Rejected source/)
})

test('fresh client presence distinguishes accepted, missing, unknown, and unbound acquisitions without deleting records', async () => {
  for (const protocol of ['torrent', 'usenet'] as const) {
    const state: RouterState = {
      calls: [],
      animetosho: animetoshoMatch,
      qbTorrents: [{ hash: HASH }],
      sabQueue: [{ nzo_id: 'existing', status: 'Queued' }],
    }
    const cleanup = installRouter(state)
    try {
      const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
      const record = addDownloadRecord({
        protocol,
        client: protocol === 'torrent' ? 'qbittorrent' : 'sabnzbd',
        endpoint: protocol === 'torrent' ? QB : SAB,
        native_id: protocol === 'torrent' ? HASH : 'existing',
        state: 'accepted',
        source_hash: HASH,
        category: 'sonarr-anime',
      })
      const existing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in existing)
      assert.equal(existing.review.units[0].status, 'existing')
      assert.equal(existing.review.units[0].existing_record_id, record.id)
      state.qbTorrents = []
      state.sabQueue = []
      const missing = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol }], { results })
      assert.ok('review' in missing)
      assert.equal(missing.review.units[0].status, 'new')
      assert.equal(
        findDownloadRecord(record.id)?.removed_at,
        undefined,
        'Read-only review must retain original ownership',
      )
      const unbound = await buildDownloadPlan(
        baseConfig(
          protocol === 'torrent'
            ? { qbittorrent_url: 'http://other-qb.test' }
            : { sabnzbd_url: 'http://other-sab.test' },
        ),
        [{ key: 'show-1', release: 0, protocol }],
        { results },
      )
      assert.ok('review' in unbound)
      assert.equal(unbound.review.units[0].status, 'existing')
      assert.equal(unbound.review.units[0].existing_unbound, true)
    } finally {
      cleanup()
    }
  }
})

test('approximate payloads fit only with headroom and each SABnzbd folder retains its unknown report', async () => {
  const state: RouterState = { calls: [], animetosho: animetoshoMatch, sabDisk: { diskspace1: '931.5' } }
  const cleanup = installRouter(state)
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const sab = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], { results })
    assert.ok('review' in sab)
    assert.equal(sab.review.disk_space.length, 2)
    assert.deepEqual(
      sab.review.disk_space.map(check => check.sufficient),
      [true, null],
      'Ample space confirms an estimate; an unreported folder stays unknown',
    )
    assert.deepEqual(
      sab.review.disk_space.map(check => check.free_bytes),
      [931_500_000_000, null],
    )
    const approximateResults = [resultFixture([releaseFixture({ torrent_files: [] })])] as unknown as ResultItem[]
    const qb = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results: approximateResults,
    })
    assert.ok('review' in qb)
    assert.ok(
      qb.review.disk_space.every(check => check.unknown_units === 1 && check.sufficient === true),
      'Ample space confirms an approximate torrent',
    )
    state.qbFreeBytes = String(qb.review.disk_space[0].required_bytes + 1)
    const tight = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results: approximateResults,
    })
    assert.ok('review' in tight)
    assert.ok(
      tight.review.disk_space.every(check => check.sufficient === null),
      'An estimate that barely fits stays unconfirmed',
    )
    state.qbFreeBytes = '0'
    const insufficient = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results: approximateResults,
    })
    assert.ok('review' in insufficient)
    assert.ok(insufficient.review.disk_space.every(check => check.sufficient === false))
  } finally {
    cleanup()
  }
})

test('estimated sizes count as fitting only with twice the estimate plus a fixed margin', () => {
  const GiB = 1024 ** 3
  assert.equal(spaceVerdict(null, GiB, 0, 0), null)
  assert.equal(spaceVerdict(GiB - 1, GiB, 1, 0), false)
  assert.equal(spaceVerdict(GiB, GiB, 0, 0), true, 'Exact sizes need no margin')
  assert.equal(spaceVerdict(2 * GiB + 5 * GiB - 1, GiB, 1, 0), null)
  assert.equal(spaceVerdict(2 * GiB + 5 * GiB, GiB, 1, 0), true)
  assert.equal(spaceVerdict(1000 * GiB, GiB, 0, 1), null, 'A unit without any size can never be confirmed')
})

test('a whole-library review keeps more than 200 selections in one deduplicated authoritative plan', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const results = Array.from({ length: 201 }, (_, index) =>
      resultFixture([releaseFixture()], { key: `show-${index}` }),
    ) as unknown as ResultItem[]
    const selections = results.map(result => ({ key: result.key, release: 0, protocol: 'torrent' as const }))
    const built = await buildDownloadPlan(baseConfig(), selections, { results })
    assert.ok('review' in built)
    assert.equal(built.review.selection_count, 201)
    assert.equal(built.review.units.length, 1)
    assert.equal(built.review.units[0].selections.length, 201)
    assert.equal(built.plan.selections.length, 201)
    assert.deepEqual(
      consumePlan(built.plan.id)?.selections.map(selection => selection.key),
      selections.map(selection => selection.key),
    )
  } finally {
    cleanup()
  }
})

test('a multi-source single submission returns a partial failure receipt instead of success', async () => {
  const state: RouterState = { calls: [] }
  const cleanup = installRouter(state)
  const router = globalThis.fetch
  const secondHash = 'b'.repeat(40)
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add') && String(init?.body).includes(secondHash))
        return new Response('Rejected', { status: 409 })
      return router(input, init)
    }
    const results = [
      resultFixture([
        releaseFixture({
          info_hashes: [HASH, secondHash],
          torrent_files: [
            { hash: HASH, files: [{ name: 'Show - 01.mkv', length: 1_000_000 }] },
            { hash: secondHash, files: [{ name: 'Show - 02.mkv', length: 1_000_000 }] },
          ],
        }),
      ]),
    ] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.equal(result.rows[0].status, 'partial')
    assert.equal(result.ok, false)
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.failures?.length, 1)
    assert.equal(receipt.failures?.[0].source_hash, secondHash)
    assert.match(receipt.error || '', /source\(s\) ready, but/)
  } finally {
    globalThis.fetch = router
    cleanup()
  }
})

test('unrelated submitted rows keep separate outcomes when only one source fails', async () => {
  const cleanup = installRouter({ calls: [] })
  const router = globalThis.fetch
  const secondHash = 'b'.repeat(40)
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add') && String(init?.body).includes(secondHash))
        return new Response('Rejected', { status: 409 })
      return router(input, init)
    }
    const results = [
      resultFixture([releaseFixture()]),
      resultFixture(
        [
          releaseFixture({
            info_hashes: [secondHash],
            torrent_files: [{ hash: secondHash, files: [{ name: 'Other.mkv', length: 1000 }] }],
          }),
        ],
        { key: 'show-2' },
      ),
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
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    const result = await completion
    assert.deepEqual(
      result.rows.map(row => [row.key, row.status]),
      [
        ['show-1', 'added'],
        ['show-2', 'failed'],
      ],
    )
    const finished = downloadJobs.get(job.id)!
    assert.deepEqual(finished.added[0].selections, [{ key: 'show-1', release: 0 }])
    assert.deepEqual(finished.failures[0].selections, [{ key: 'show-2', release: 0 }])
    assert.deepEqual(
      finished.targets.map(target => target.protocol),
      ['torrent', 'torrent'],
    )
  } finally {
    globalThis.fetch = router
    cleanup()
  }
})

test('accepted SABnzbd jobs retain ownership when binding or outcome persistence fails', async () => {
  for (const failedFile of ['owned_downloads.json.tmp', 'download_jobs.json.tmp']) {
    let failNextWrite = false
    const state: RouterState = {
      calls: [],
      animetosho: animetoshoMatch,
      sabAddResult: () => {
        failNextWrite = true
        return Response.json({ status: true, nzo_ids: ['accepted-nzo'] })
      },
    }
    const cleanup = installRouter(state)
    const write = fs.writeFileSync
    try {
      const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
      const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
        results,
      })
      assert.ok('review' in built)
      fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (failNextWrite && String(path).endsWith(failedFile)) {
          failNextWrite = false
          throw new Error('accepted job persistence failed')
        }
        return Reflect.apply(write, fs, [path, ...args])
      }) as typeof fs.writeFileSync
      syncBuiltinESMExports()
      const { job, completion } = await acceptDownloadPlan(
        baseConfig(),
        consumePlan(built.plan.id)!,
        { disk_space: true },
        results,
      )
      await assert.rejects(completion, /accepted job persistence failed/)
      const finished = downloadJobs.get(job.id)!
      assert.equal(finished.finished, true)
      assert.deepEqual(finished.added, [])
      assert.equal(finished.failures.length, 1)
      assert.match(finished.failures[0].error, /accepted job persistence failed/)
      resetOwnedRuntime()
      assert.equal(downloadRecords().length, 1)
      assert.equal(downloadRecords()[0].removed_at, undefined)
      assert.equal(state.calls.filter(call => /POST .*sab\.test/.test(call)).length, 1)
    } finally {
      fs.writeFileSync = write
      syncBuiltinESMExports()
      cleanup()
    }
  }
})

test('an ambiguous torrent add retains its intent and blocks reacquisition even when a fresh list is empty', async () => {
  const cleanup = installRouter({ calls: [] })
  const router = globalThis.fetch
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/torrents/add')) throw new TypeError('connection lost after dispatch')
      return router(input, init)
    }
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in built)
    const { job, completion } = await acceptDownloadPlan(baseConfig(), consumePlan(built.plan.id)!, undefined, results)
    await completion
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok('ok' in receipt)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.acceptance_unknown, true)
    assert.equal(receipt.client, 'qbittorrent')
    assert.match(receipt.error || '', /Check qBittorrent/)
    assert.equal(findTorrentRecord(HASH)?.state, 'acceptance_unknown')
    const review = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
    })
    assert.ok('review' in review)
    assert.deepEqual(
      review.review.blocked.map(row => row.code),
      ['acceptance_unknown'],
    )
    assert.deepEqual(review.review.units, [])
  } finally {
    globalThis.fetch = router
    cleanup()
  }
})

test('a present accepted SABnzbd source remains existing without provider rediscovery', async () => {
  const state: RouterState = { calls: [], sabQueue: [{ nzo_id: 'present', status: 'Queued' }] }
  const cleanup = installRouter(state)
  try {
    addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: SAB,
      native_id: 'present',
      state: 'accepted',
      source_hash: HASH,
      category: 'sonarr-anime',
    })
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    assert.deepEqual(built.review.blocked, [])
    assert.equal(built.review.units[0].status, 'existing')
    assert.equal(
      state.calls.some(call => call.includes('animetosho.net')),
      false,
    )
  } finally {
    cleanup()
  }
})

test('an incomplete presence read blocks an accepted source instead of proving it missing', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch })
  const router = globalThis.fetch
  try {
    addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: SAB,
      native_id: 'present',
      state: 'accepted',
      source_hash: HASH,
      category: 'sonarr-anime',
    })
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.origin === SAB && url.searchParams.get('mode') === 'history' && url.searchParams.get('archive') === '1')
        return Response.json({ history: {} })
      return router(input, init)
    }
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    assert.deepEqual(
      built.review.blocked.map(row => row.code),
      ['client_unreachable'],
      'An unreadable client is reported as unreachable, not as an unconfirmed send',
    )
    assert.deepEqual(built.review.units, [])
    assert.equal(downloadRecords().length, 1)
  } finally {
    globalThis.fetch = router
    cleanup()
  }
})

test('invalid provider NZB bytes never reach SABnzbd even after a matched review', async () => {
  const state: RouterState = { calls: [], animetosho: animetoshoMatch }
  const cleanup = installRouter(state)
  const router = globalThis.fetch
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('animetosho.net/nzb/')) {
        state.calls.push(`GET ${String(input)}`)
        return new Response('<html><body>Provider login required</body></html>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      return router(input, init)
    }
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    const { completion } = await acceptDownloadPlan(
      baseConfig(),
      consumePlan(built.plan.id)!,
      { disk_space: true },
      results,
    )
    const outcome = await completion
    assert.equal(outcome.ok, false)
    assert.equal(outcome.count, 0)
    assert.equal(outcome.failures.length, 1)
    assert.equal(
      state.calls.some(call => /POST .*sab\.test/.test(call)),
      false,
    )
    assert.equal(
      downloadRecords().some(record => record.state === 'accepted'),
      false,
    )
  } finally {
    globalThis.fetch = router
    cleanup()
  }
})

test('a Usenet category SABnzbd does not have blocks the review instead of filing the NZB under the default category', async () => {
  const cleanup = installRouter({ calls: [], animetosho: animetoshoMatch, sabCategories: ['*', 'tv'] })
  try {
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'show-1', release: 0, protocol: 'usenet' }], {
      results,
    })
    assert.ok('review' in built)
    assert.deepEqual(
      built.review.blocked.map(row => row.code),
      ['category_missing'],
    )
    assert.match(built.review.blocked[0].reason, /sonarr-anime/)
    assert.deepEqual(built.review.units, [])
  } finally {
    cleanup()
  }
})

test('an unconfirmed SABnzbd send is adopted only when exactly one job carries its name and category', async () => {
  const state: RouterState = {
    calls: [],
    sabQueue: [
      {
        nzo_id: 'nzo-match',
        filename: 'Show S01 [Group]',
        cat: 'sonarr-anime',
        status: 'Downloading',
        mb: '100',
        mbleft: '50',
      },
      {
        nzo_id: 'nzo-other-cat',
        filename: 'Show S01 [Group]',
        cat: 'tv',
        status: 'Downloading',
        mb: '100',
        mbleft: '50',
      },
    ],
  }
  const cleanup = installRouter(state)
  try {
    const record = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: SAB,
      native_id: '',
      state: 'acceptance_unknown',
      source_hash: HASH,
      category: 'sonarr-anime',
      nzb_name: 'Show S01 [Group].nzb',
    })
    const progress = await collectDownloadProgress(baseConfig())
    const adopted = findDownloadRecord(record.id)
    assert.equal(adopted?.state, 'accepted')
    assert.equal(adopted?.native_id, 'nzo-match')
    assert.equal(progress.downloads[record.id].phase, 'downloading')

    const ambiguous = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: SAB,
      native_id: '',
      state: 'acceptance_unknown',
      source_hash: 'c'.repeat(40),
      category: 'tv',
      nzb_name: 'Twin.nzb',
    })
    state.sabQueue = [
      { nzo_id: 'twin-1', filename: 'Twin', cat: 'tv', status: 'Queued', mb: '1', mbleft: '1' },
      { nzo_id: 'twin-2', filename: 'Twin', cat: 'tv', status: 'Queued', mb: '1', mbleft: '1' },
    ]
    await collectDownloadProgress(baseConfig())
    assert.equal(
      findDownloadRecord(ambiguous.id)?.state,
      'acceptance_unknown',
      'Two candidate jobs are never guessed between',
    )
  } finally {
    cleanup()
  }
})

test('an unconfirmed torrent is adopted once qBittorrent holds its hash', async () => {
  const state: RouterState = {
    calls: [],
    qbTorrents: [{ hash: HASH, state: 'downloading', progress: 0.5, size: 1000 }],
  }
  const cleanup = installRouter(state)
  try {
    const record = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: QB,
      native_id: HASH,
      state: 'acceptance_unknown',
      source_hash: HASH,
      category: 'sonarr-anime',
    })
    const progress = await collectDownloadProgress(baseConfig())
    assert.equal(findDownloadRecord(record.id)?.state, 'accepted')
    assert.equal(progress.downloads[record.id].phase, 'downloading')
  } finally {
    cleanup()
  }
})

test('a review whose every selection was blocked is refused at acceptance instead of failing as an empty request', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const built = await buildDownloadPlan(baseConfig(), [{ key: 'missing', release: 0, protocol: 'torrent' }], {
      results: [],
    })
    assert.ok('review' in built)
    assert.deepEqual(
      built.review.blocked.map(row => row.code),
      ['invalid'],
    )
    await assert.rejects(
      acceptDownloadPlan(baseConfig(), consumePlan(built.review.plan_id)!, undefined, []),
      (error: PlanRejected) => error.status === 409 && /Nothing in this review/.test(error.message),
    )
  } finally {
    cleanup()
  }
})
