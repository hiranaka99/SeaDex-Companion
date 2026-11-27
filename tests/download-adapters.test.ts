// Download-flow tests driven by in-memory client adapters (no HTTP) plus real-adapter freeSpace checks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../server/config.js'
import { downloadClients } from '../server/download-clients.js'
import { consumePlan } from '../server/download-plans.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { cancelRecords, collectDownloadProgress, controlRecord, listCancelable } from '../server/download-progress.js'
import { downloadSpace } from '../server/download-space.js'
import {
  addDownloadRecord,
  allDownloadRecords,
  downloadRecords,
  findDownloadRecord,
  resetOwnedRuntime,
} from '../server/download-store.js'
import { acceptDownloadPlan, receiptFromJob } from '../server/download-submit.js'
import { downloadJobs } from '../server/download-jobs.js'
import type { Config, ResultItem } from '../server/types.js'
import { EMPTY_LIBRARY_SCOPE } from '../shared/settings.js'
import { memoryDownloadClients } from './support/download-clients.js'
import {
  HASH,
  QB,
  SAB,
  baseConfig,
  installRouter,
  purgeTestDataDir,
  releaseFixture,
  resultFixture,
} from './support/download-fixtures.js'
import { findTorrentRecord } from './support/ledger.js'

async function withNoHttp(run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch
  resetOwnedRuntime()
  purgeTestDataDir()
  globalThis.fetch = () => Promise.reject(new Error('unexpected HTTP request'))
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    resetOwnedRuntime()
    purgeTestDataDir()
  }
}

test('download review plans existing units, category blocks, and space checks through in-memory adapters without HTTP', async () => {
  await withNoHttp(async () => {
    const config = baseConfig()
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]

    // Existing hash reported by the adapter's presence check becomes an existing unit.
    const existingClients = memoryDownloadClients({
      torrent: {
        jobs: new Map([
          [
            HASH,
            {
              phase: 'downloading',
              state: 'downloading',
              progress: 0.5,
              downloaded: 500,
              total_size: 1000,
              speed: 10,
              capabilities: { pause: true, resume: false, remove: true, remove_files: true },
              active: true,
            },
          ],
        ]),
      },
    })
    const existing = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: existingClients.clients,
    })
    assert.equal(existing.review.units[0].status, 'existing')
    assert.equal(existing.review.existing_units, 1)

    // Unknown categories reported by the adapter block the row.
    const missingCategoryClients = memoryDownloadClients({
      torrent: { missingCategories: ['sonarr-anime'] },
    })
    const blocked = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: missingCategoryClients.clients,
    })
    assert.deepEqual(
      blocked.review.blocked.map(row => row.code),
      ['category_missing'],
    )

    // Low disk space reported by the adapter's diskChecks requires acknowledgement.
    const tightClients = memoryDownloadClients({
      torrent: { freeBytes: 100 },
    })
    const tight = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: tightClients.clients,
    })
    assert.equal(tight.review.units[0].status, 'new')
    assert.equal(tight.review.requires_space_ack, true)
    assert.equal(tight.review.disk_space[0].sufficient, false)
  })
})

test('download submission writes durable intent, handles rejection and ambiguity through in-memory adapters without HTTP', async () => {
  await withNoHttp(async () => {
    const config = baseConfig()
    const results = [resultFixture([releaseFixture()])] as unknown as ResultItem[]

    // Successful submit records acceptance_unknown before client call, then finalizes to accepted.
    let stateDuringSubmit = ''
    const okAdapter = memoryDownloadClients({
      torrent: {
        submit: (unit, ownership) => {
          stateDuringSubmit = findTorrentRecord(unit.source_hash)?.state || ''
          ownership.accepted([unit.source_hash])
          return unit.source_hash
        },
      },
    })
    const built = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: okAdapter.clients,
    })
    const { job, completion } = await acceptDownloadPlan(
      config,
      consumePlan(built.plan.id)!,
      undefined,
      results,
      okAdapter.clients,
    )
    const outcome = await completion
    assert.equal(stateDuringSubmit, 'acceptance_unknown')
    assert.equal(outcome.count, 1)
    assert.equal(okAdapter.torrent.submitted.length, 1)
    assert.equal(findTorrentRecord(HASH)?.state, 'accepted')
    const receipt = receiptFromJob(downloadJobs.get(job.id)!)
    assert.ok(!('error' in receipt) && receipt.ok && receipt.native_id === HASH)

    // Clean rejection tombstones the intent record.
    resetOwnedRuntime()
    purgeTestDataDir()
    const rejecting = memoryDownloadClients({
      torrent: {
        submit: () => {
          throw new Error('duplicate rejected')
        },
      },
    })
    const cleanReview = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: rejecting.clients,
    })
    const cleanAccepted = await acceptDownloadPlan(
      config,
      consumePlan(cleanReview.plan.id)!,
      undefined,
      results,
      rejecting.clients,
    )
    const cleanOutcome = await cleanAccepted.completion
    assert.equal(cleanOutcome.count, 0)
    assert.equal(cleanOutcome.rows[0].status, 'failed')
    assert.equal(findTorrentRecord(HASH), null)
    assert.ok(allDownloadRecords()[0]?.removed_at)

    // Ambiguous failure preserves acceptance_unknown and reports it on the receipt.
    resetOwnedRuntime()
    purgeTestDataDir()
    const ambiguous = memoryDownloadClients({
      torrent: {
        submit: () => {
          throw new Error('timed out')
        },
        ambiguity: error =>
          error instanceof Error && error.message === 'timed out' ? 'Check qBittorrent before retrying.' : null,
      },
    })
    const ambiguousReview = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: ambiguous.clients,
    })
    const ambiguousAccepted = await acceptDownloadPlan(
      config,
      consumePlan(ambiguousReview.plan.id)!,
      undefined,
      results,
      ambiguous.clients,
    )
    await ambiguousAccepted.completion
    const ambiguousReceipt = receiptFromJob(downloadJobs.get(ambiguousAccepted.job.id)!)
    assert.ok('ok' in ambiguousReceipt && !ambiguousReceipt.ok && ambiguousReceipt.acceptance_unknown)
    assert.equal(findTorrentRecord(HASH)?.state, 'acceptance_unknown')
  })
})

test('progress, cancelable listing, control, and cancellation run through in-memory adapters without HTTP', async () => {
  await withNoHttp(async () => {
    const config = baseConfig()
    const memory = memoryDownloadClients()
    memory.torrent.jobs.set(HASH, {
      phase: 'downloading',
      state: 'downloading',
      progress: 0.25,
      downloaded: 250,
      total_size: 1000,
      speed: 50,
      capabilities: { pause: true, resume: false, remove: true, remove_files: true },
      active: true,
    })
    memory.usenet.jobs.set('nzo-1', {
      phase: 'downloading',
      state: 'Downloading',
      progress: 0.5,
      downloaded: 500,
      total_size: 1000,
      speed: 100,
      capabilities: { pause: true, resume: false, remove: true, remove_files: true },
      active: true,
    })

    const torrentRecord = addDownloadRecord({
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: memory.torrent.adapter.endpointId,
      native_id: HASH,
      state: 'accepted',
      source_hash: HASH,
      category: 'sonarr-anime',
    })
    const usenetRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: memory.usenet.adapter.endpointId,
      native_id: 'nzo-1',
      state: 'accepted',
      source_hash: 'b'.repeat(40),
      category: 'sonarr-anime',
    })
    const unconfirmedRecord = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: memory.usenet.adapter.endpointId,
      native_id: '',
      state: 'acceptance_unknown',
      source_hash: 'c'.repeat(40),
      category: 'sonarr-anime',
    })

    const initial = await collectDownloadProgress(config, memory.clients)
    assert.equal(initial.downloads[torrentRecord.id].phase, 'downloading')
    assert.equal(initial.downloads[usenetRecord.id].phase, 'downloading')
    assert.deepEqual(
      (await listCancelable(config, memory.clients)).items.map(item => item.record_id).sort(),
      [torrentRecord.id, usenetRecord.id].sort(),
    )

    await controlRecord(config, torrentRecord.id, 'pause', false, memory.clients)
    assert.deepEqual(memory.torrent.controls, [{ nativeId: HASH, action: 'pause' }])
    assert.equal((await collectDownloadProgress(config, memory.clients)).downloads[torrentRecord.id].phase, 'paused')

    await controlRecord(config, torrentRecord.id, 'resume', false, memory.clients)
    assert.deepEqual(memory.torrent.controls, [
      { nativeId: HASH, action: 'pause' },
      { nativeId: HASH, action: 'resume' },
    ])
    assert.equal(
      (await collectDownloadProgress(config, memory.clients)).downloads[torrentRecord.id].phase,
      'downloading',
    )

    await controlRecord(config, torrentRecord.id, 'remove', true, memory.clients)
    assert.deepEqual(memory.torrent.removed, [{ nativeId: HASH, removeFiles: true }])
    assert.equal(findTorrentRecord(HASH), null)
    assert.ok(findDownloadRecord(torrentRecord.id)?.removed_at)

    const cancelled = await cancelRecords(config, [usenetRecord.id], false, memory.clients)
    assert.deepEqual(cancelled.removed, [{ record_id: usenetRecord.id, client: 'sabnzbd' }])
    assert.deepEqual(memory.usenet.removed, [{ nativeId: 'nzo-1', removeFiles: false }])

    await controlRecord(config, unconfirmedRecord.id, 'remove', false, memory.clients)
    assert.deepEqual(memory.usenet.forgotten, [unconfirmedRecord.id])
    assert.deepEqual(downloadRecords(), [])
  })
})

test('downloadSpace checks only enabled modes and passes deduplicated categories across all arr instances', async () => {
  await withNoHttp(async () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      sonarr_url: 'http://sonarr.test',
      sonarr_key: 'sonarr-key',
      sonarr_category: 'tv-torrents',
      sabnzbd_sonarr_category: 'tv-nzb',
      radarr_url: 'http://radarr.test',
      radarr_key: 'radarr-key',
      radarr_category: 'movie-torrents',
      sabnzbd_radarr_category: 'movie-nzb',
      arr_instances: [
        {
          id: '4k',
          kind: 'sonarr',
          name: 'Sonarr 4K',
          url: 'http://sonarr4k.test',
          key: 'sonarr4k-key',
          category: 'tv-torrents',
          sabnzbd_category: 'tv-4k-nzb',
          scope: EMPTY_LIBRARY_SCOPE,
        },
      ],
    }

    const torrentOnly = memoryDownloadClients({
      torrent: { freeBytes: 100_000 },
      usenet: { freeBytes: 200_000 },
    })
    assert.deepEqual(await downloadSpace({ ...config, download_mode: 'torrent_only' }, torrentOnly.clients), [
      { client: 'qbittorrent', label: 'qBittorrent storage', free_bytes: 100_000 },
    ])
    assert.deepEqual(torrentOnly.torrent.freeSpaceCalls, [['tv-torrents', 'movie-torrents']])
    assert.deepEqual(torrentOnly.usenet.freeSpaceCalls, [])

    const usenetOnly = memoryDownloadClients({
      torrent: { freeBytes: 100_000 },
      usenet: { freeBytes: 200_000 },
    })
    assert.deepEqual(await downloadSpace({ ...config, download_mode: 'usenet_only' }, usenetOnly.clients), [
      { client: 'sabnzbd', label: 'SABnzbd storage', free_bytes: 200_000 },
    ])
    assert.deepEqual(usenetOnly.torrent.freeSpaceCalls, [])
    assert.deepEqual(usenetOnly.usenet.freeSpaceCalls, [['tv-nzb', 'movie-nzb', 'tv-4k-nzb']])

    const choose = memoryDownloadClients({
      torrent: { freeBytes: 100_000 },
      usenet: { freeBytes: 200_000 },
    })
    assert.deepEqual(await downloadSpace({ ...config, download_mode: 'choose' }, choose.clients), [
      { client: 'qbittorrent', label: 'qBittorrent storage', free_bytes: 100_000 },
      { client: 'sabnzbd', label: 'SABnzbd storage', free_bytes: 200_000 },
    ])
  })
})

test('real download adapters implement freeSpace with deduplicated paths, unconfigured guards, and error fallback', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const unconfigured = baseConfig({
      qbittorrent_url: '',
      sabnzbd_url: '',
      sabnzbd_key: '',
      sonarr_url: 'http://sonarr.test',
      sonarr_key: 's-key',
      radarr_url: 'http://radarr.test',
      radarr_key: 'r-key',
      sonarr_category: 'anime',
      radarr_category: 'anime',
    })
    assert.deepEqual(await downloadSpace(unconfigured, downloadClients(unconfigured)), [])

    const configured = baseConfig({
      sonarr_url: 'http://sonarr.test',
      sonarr_key: 's-key',
      radarr_url: 'http://radarr.test',
      radarr_key: 'r-key',
      sonarr_category: 'anime',
      radarr_category: 'sonarr-anime',
    })
    const locations = await downloadSpace(configured, downloadClients(configured))
    assert.deepEqual(locations, [
      { client: 'qbittorrent', label: '/downloads/anime', free_bytes: 500_000_000_000 },
      { client: 'sabnzbd', label: 'SABnzbd completed folder', free_bytes: 931_500_000_000 },
    ])

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith(QB) || url.startsWith(SAB)) throw new TypeError('client offline')
        return originalFetch(input, init)
      }
      const failing = await downloadSpace(configured, downloadClients(configured))
      assert.deepEqual(failing, [
        {
          client: 'qbittorrent',
          label: 'qBittorrent category anime',
          free_bytes: null,
          reason: 'Could not read qBittorrent download paths.',
        },
        {
          client: 'qbittorrent',
          label: 'qBittorrent category sonarr-anime',
          free_bytes: null,
          reason: 'Could not read qBittorrent download paths.',
        },
        {
          client: 'sabnzbd',
          label: 'SABnzbd completed folder',
          free_bytes: null,
          reason: 'Could not read SABnzbd storage: client offline',
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    cleanup()
  }
})
