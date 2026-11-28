// Downloading a whole release from a split season: planning, widening torrents the app added, Usenet
// acknowledgements, and the progress links a send leaves on every split season.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadClients } from '../server/download-clients.js'
import { buildDownloadPlan, parseSelections } from '../server/download-preflight.js'
import { consumePlan } from '../server/download-plans.js'
import { acceptDownloadPlan } from '../server/download-submit.js'
import { HttpError } from '../server/http-error.js'
import { collectDownloadProgress } from '../server/download-progress.js'
import { currentDownloadAssociations } from '../frontend/src/download-store.js'
import type { DownloadSelection } from '../shared/download-contracts.js'
import { findTorrentRecord } from './support/ledger.js'
import type { ResultItem } from '../server/types.js'
import { HASH, animetoshoMatch, baseConfig, installRouter, type RouterState } from './support/download-fixtures.js'

const episode = (number: number) => ({ name: `Bleach - ${String(number).padStart(3, '0')}.mkv`, length: 1_000 })
/** Six episodes, two per split season. */
const FILES = [1, 2, 3, 4, 5, 6].map(episode)
const seasonFiles = (season: number) => FILES.slice((season - 1) * 2, season * 2).map(file => file.name)

/** The same release listed on one split season, narrowed to that season's files. */
const splitRelease = (season: number) => ({
  kind: 'best',
  releaseGroup: 'Group',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  torrent_available: true,
  info_hashes: [HASH],
  size: 2_000,
  selected_files: seasonFiles(season),
  torrent_files: [{ hash: HASH, files: FILES }],
  whole_release: { seasons: [1, 2, 3], held: [] },
})

const splitSeason = (season: number, changes: Record<string, unknown> = {}) => ({
  key: `bleach-${season}`,
  arr: 'Sonarr',
  title: 'Bleach',
  season,
  split_seasons: [1, 2, 3],
  library_key: 'Sonarr:item30',
  status: 'upgrade',
  have: [],
  owned_by_part: {},
  local_size: 0,
  releases: [splitRelease(season)],
  ...changes,
})

const splitResults = () => [1, 2, 3].map(season => splitSeason(season)) as unknown as ResultItem[]

test('a whole-release selection is one whole-source torrent with the whole size', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const config = baseConfig()
    const { review } = await buildDownloadPlan(
      config,
      [{ key: 'bleach-2', release: 0, protocol: 'torrent', whole_release: true }],
      { results: splitResults(), clients: downloadClients(config) },
    )
    assert.deepEqual(review.blocked, [])
    assert.equal(review.units.length, 1)
    const [unit] = review.units
    assert.equal(unit.status, 'new')
    assert.equal(unit.whole_source, true)
    assert.equal(unit.size_bytes, 6_000)
    assert.equal(review.total_new_bytes, 6_000)
  } finally {
    cleanup()
  }
})

test('the whole-release flag on a season that is not split is refused as a bad request', async () => {
  const cleanup = installRouter({ calls: [] })
  try {
    const config = baseConfig()
    const ordinary = [splitSeason(1, { split_seasons: undefined })] as unknown as ResultItem[]
    await assert.rejects(
      buildDownloadPlan(config, [{ key: 'bleach-1', release: 0, protocol: 'torrent', whole_release: true }], {
        results: ordinary,
        clients: downloadClients(config),
      }),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    )
    assert.throws(
      () => parseSelections([{ key: 'bleach-1', release: 0, whole_release: 'yes' }]),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    )
  } finally {
    cleanup()
  }
})

/** qBittorrent's view of the torrent's files, as the fake client reports them. */
const qbFiles = () => FILES.map((file, index) => ({ name: file.name, index, size: file.length, priority: 0 }))

/** Reviews and accepts one send, acknowledging whatever the review asks. */
async function send(config: ReturnType<typeof baseConfig>, results: ResultItem[], selections: DownloadSelection[]) {
  const { review } = await buildDownloadPlan(config, selections, { results, clients: downloadClients(config) })
  const plan = consumePlan(review.plan_id)!
  const { completion } = await acceptDownloadPlan(
    config,
    plan,
    { whole_source: true, disk_space: true },
    results,
    downloadClients(config),
  )
  return { review, result: await completion }
}

/** The split seasons whose cards show this download, as the library cards decide it. */
async function seasonsShowing(config: ReturnType<typeof baseConfig>, results: ResultItem[]) {
  const progress = await collectDownloadProgress(config, downloadClients(config))
  const [view] = Object.values(progress.downloads)
  return currentDownloadAssociations(view, results)
    .map(ref => results.find(result => result.key === ref.key)!.season)
    .sort()
}

test('a whole-release send shows on every split season, a season-only send only on its own', async () => {
  const whole: RouterState = { calls: [], qbFiles: qbFiles() }
  let cleanup = installRouter(whole)
  try {
    const config = baseConfig()
    const results = splitResults()
    const { result } = await send(config, results, [
      { key: 'bleach-2', release: 0, protocol: 'torrent', whole_release: true },
    ])
    assert.equal(result.count, 1)
    assert.deepEqual(await seasonsShowing(config, results), [1, 2, 3])
    assert.equal(findTorrentRecord(HASH)?.scope, undefined)
  } finally {
    cleanup()
  }
  cleanup = installRouter({ calls: [], qbFiles: qbFiles() })
  try {
    const config = baseConfig()
    const results = splitResults()
    await send(config, results, [{ key: 'bleach-2', release: 0, protocol: 'torrent' }])
    assert.deepEqual(await seasonsShowing(config, results), [2])
  } finally {
    cleanup()
  }
})

/** The file indexes a file-priority request switched to `priority`. */
const switched = (bodies: string[] | undefined, priority: string) =>
  (bodies || [])
    .map(body => new URLSearchParams(body))
    .filter(body => body.get('priority') === priority)
    .flatMap(body => (body.get('id') || '').split('|').map(Number))
    .sort((left, right) => left - right)

test('a torrent the app added for one split season is widened by a whole-release send', async () => {
  const state: RouterState = { calls: [], qbFiles: qbFiles() }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const results = splitResults()
    await send(config, results, [{ key: 'bleach-2', release: 0, protocol: 'torrent' }])
    state.qbFilePriorities = []
    state.calls = []
    const { review, result } = await send(config, results, [
      { key: 'bleach-2', release: 0, protocol: 'torrent', whole_release: true },
    ])
    const [unit] = review.units
    assert.equal(unit.status, 'new')
    assert.equal(unit.widens, true)
    assert.equal(unit.existing_record_id, findTorrentRecord(HASH)!.id)
    // Only the four files still to download count against free space.
    assert.equal(unit.size_bytes, 4_000)
    assert.equal(review.disk_space[0].required_bytes, 4_000)
    assert.equal(result.count, 1)
    assert.equal(state.calls.filter(call => call.includes('/torrents/add')).length, 0)
    // Files 0, 1, 4 and 5 are switched on; files 2 and 3 were already selected and are left alone.
    assert.deepEqual(switched(state.qbFilePriorities, '1'), [0, 1, 4, 5])
    assert.deepEqual(switched(state.qbFilePriorities, '0'), [])
    assert.equal(findTorrentRecord(HASH)!.scope, undefined)
    assert.deepEqual(await seasonsShowing(config, results), [1, 2, 3])
  } finally {
    cleanup()
  }
})

test('sending a second split season adds its files to the torrent the app added for the first', async () => {
  const state: RouterState = { calls: [], qbFiles: qbFiles() }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const results = splitResults()
    await send(config, results, [{ key: 'bleach-2', release: 0, protocol: 'torrent' }])
    state.qbFilePriorities = []
    const { review } = await send(config, results, [{ key: 'bleach-3', release: 0, protocol: 'torrent' }])
    assert.equal(review.units[0].widens, true)
    assert.equal(review.units[0].size_bytes, 2_000)
    assert.deepEqual(switched(state.qbFilePriorities, '1'), [4, 5])
    assert.deepEqual(findTorrentRecord(HASH)!.scope?.sort(), [...seasonFiles(2), ...seasonFiles(3)].sort())
    assert.deepEqual(await seasonsShowing(config, results), [2, 3])
  } finally {
    cleanup()
  }
})

test('a torrent the app did not add is left untouched', async () => {
  const state: RouterState = { calls: [], qbFiles: qbFiles(), qbTorrents: [{ hash: HASH, state: 'uploading' }] }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const results = splitResults()
    const { review } = await send(config, results, [
      { key: 'bleach-2', release: 0, protocol: 'torrent', whole_release: true },
    ])
    assert.equal(review.units[0].status, 'existing')
    assert.equal(review.units[0].widens, undefined)
    assert.deepEqual(state.qbFilePriorities || [], [])
    assert.equal(state.calls.filter(call => call.includes('/torrents/add')).length, 0)
    assert.equal(findTorrentRecord(HASH), null)
  } finally {
    cleanup()
  }
})

test('a recorded torrent that is gone from qBittorrent is added again with the requested files', async () => {
  const state: RouterState = { calls: [], qbFiles: qbFiles() }
  const cleanup = installRouter(state)
  try {
    const config = baseConfig()
    const results = splitResults()
    await send(config, results, [{ key: 'bleach-2', release: 0, protocol: 'torrent' }])
    // Sonarr imported the files and the torrent was removed from qBittorrent.
    state.qbTorrents = []
    state.calls = []
    const { review, result } = await send(config, results, [{ key: 'bleach-3', release: 0, protocol: 'torrent' }])
    assert.equal(review.units[0].status, 'new')
    assert.equal(review.units[0].widens, undefined)
    assert.equal(result.count, 1)
    assert.equal(state.calls.filter(call => call.includes('/torrents/add')).length, 1)
    assert.deepEqual(findTorrentRecord(HASH)!.scope, seasonFiles(3))
  } finally {
    cleanup()
  }
})

test('a whole-release Usenet send needs no acknowledgement of extra or unknown files', async () => {
  const cleanup = installRouter({ calls: [], animetosho: () => animetoshoMatch() })
  try {
    const config = baseConfig()
    const results = splitResults()
    const season = await buildDownloadPlan(config, [{ key: 'bleach-2', release: 0, protocol: 'usenet' }], {
      results,
      clients: downloadClients(config),
    })
    assert.equal(season.review.requires_whole_ack, true)
    const { review } = await buildDownloadPlan(
      config,
      [{ key: 'bleach-2', release: 0, protocol: 'usenet', whole_release: true }],
      { results, clients: downloadClients(config) },
    )
    assert.deepEqual(review.blocked, [])
    const [unit] = review.units
    assert.equal(unit.protocol, 'usenet')
    assert.equal(unit.scope_expanded, false)
    assert.equal(unit.scope_unknown, false)
    assert.equal(review.requires_whole_ack, false)
    // The indexer's total, marked approximate.
    assert.equal(unit.size_bytes, 500_000_000)
    assert.equal(unit.approximate, true)
  } finally {
    cleanup()
  }
})
