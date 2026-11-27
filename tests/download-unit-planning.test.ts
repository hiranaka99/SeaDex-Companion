// Each download client adapter turns the releases a review selected into its own units; review walks the adapters.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { qbittorrentAdapter } from '../server/qbittorrent-adapter.js'
import { sabnzbdAdapter } from '../server/sabnzbd-adapter.js'
import { addDownloadRecord } from '../server/download-store.js'
import type { DownloadSelectionRef, PreflightBlocked } from '../shared/download-contracts.js'
import type {
  ClientPresence,
  RowBlocks,
  SourceOwnership,
  SubmissionUnit,
  UnitPlan,
  UnitRow,
} from '../server/download-client-types.js'
import type { Release, ResultItem } from '../server/types.js'
import { memoryDownloadClients } from './support/download-clients.js'
import {
  HASH,
  animetoshoMatch,
  baseConfig,
  installRouter,
  releaseFixture,
  resultFixture,
} from './support/download-fixtures.js'

class Blocks implements RowBlocks {
  readonly entries: { key: string; release: number; code: PreflightBlocked['code'] }[] = []
  add(row: DownloadSelectionRef, code: PreflightBlocked['code']): void {
    if (!this.has(row)) this.entries.push({ key: row.key, release: row.release, code })
  }
  has(row: DownloadSelectionRef): boolean {
    return this.entries.some(entry => entry.key === row.key && entry.release === row.release)
  }
}

function unitRow(release: Record<string, unknown>, category: string, index = 0): UnitRow {
  const result = resultFixture([release]) as unknown as ResultItem
  return {
    key: result.key,
    release: index,
    source: release as unknown as Release,
    result,
    category,
    label: 'Show S01 [Group]',
    search: { titles: ['Show'], releaseGroup: 'Group', tracker: 'Nyaa' },
  }
}

const nobody = (): SourceOwnership => ({})
const empty: ClientPresence = { ids: new Set(), complete: true }

test('the qBittorrent adapter plans one torrent unit per hash with its files to request, and nothing Usenet-only', async () => {
  const restore = installRouter({ calls: [] })
  try {
    const adapter = qbittorrentAdapter(baseConfig())
    const blocks = new Blocks()
    const scoped = unitRow(releaseFixture({ selected_files: ['Show - 01.mkv'] }), 'sonarr-anime')
    const hashless = {
      ...unitRow(releaseFixture({ info_hashes: [], torrent_files: [] }), 'sonarr-anime'),
      key: 'other',
    }
    const plan = await adapter.planUnits([scoped, hashless], { blocks, intent: 'single_review' })

    assert.deepEqual(plan.sources(scoped), [HASH])
    const units = await plan.units({ presence: empty, ownership: nobody })
    assert.equal(units.length, 1)
    const [unit] = units
    assert.equal(unit.unit_id, `torrent:${HASH}:sonarr-anime`)
    assert.equal(unit.status, 'new')
    assert.equal(unit.whole_source, false)
    assert.deepEqual(unit.send, { requestedPaths: ['Show - 01.mkv'] })
    assert.deepEqual(adapter.recordFields(unit), { scope: ['Show - 01.mkv'] })
    for (const field of ['provider', 'proof', 'nzb_name', 'known_extra_files'])
      assert.ok(!(field in unit), `a torrent unit carries no ${field}`)
    assert.deepEqual(blocks.entries, [{ key: 'other', release: 0, code: 'no_torrent' }])

    // A torrent qBittorrent already holds is an existing unit, not a new one.
    const held = await adapter.planUnits([scoped], { blocks: new Blocks(), intent: 'single_review' })
    const [existing] = await held.units({ presence: { ids: new Set([HASH]), complete: true }, ownership: nobody })
    assert.equal(existing.status, 'existing')
  } finally {
    restore()
  }
})

test('the SABnzbd adapter plans a Usenet unit with the NZB entry to fetch, and nothing torrent-only', async () => {
  const restore = installRouter({ calls: [], animetosho: () => animetoshoMatch() })
  try {
    const adapter = sabnzbdAdapter(baseConfig())
    const row = unitRow(releaseFixture(), 'sonarr-anime-nzb')
    const plan = await adapter.planUnits([row], { blocks: new Blocks(), intent: 'single_review' })

    assert.deepEqual(plan.sources(row), [HASH])
    const [unit] = await plan.units({ presence: empty, ownership: nobody })
    assert.equal(unit.unit_id, `usenet:${HASH}:sonarr-anime-nzb`)
    assert.equal(unit.status, 'new')
    assert.equal(unit.whole_source, true)
    assert.equal(unit.provider, 'animetosho')
    assert.deepEqual(unit.send, { entryId: '1234' })
    assert.deepEqual(adapter.recordFields(unit), { entry_id: '1234' })
    assert.ok(
      !('requestedPaths' in unit.send) && !('torrentFile' in unit.send),
      'a Usenet unit carries no torrent fields',
    )
  } finally {
    restore()
  }
})

test('the SABnzbd adapter plans a source an acquisition already covers as existing, without looking it up', async () => {
  const router = { calls: [] as string[] }
  const restore = installRouter(router)
  try {
    const config = baseConfig()
    const adapter = sabnzbdAdapter(config)
    const record = addDownloadRecord({
      protocol: 'usenet',
      client: 'sabnzbd',
      endpoint: adapter.endpointId,
      state: 'accepted',
      source_hash: HASH,
      category: 'sonarr-anime-nzb',
      labels: ['Show'],
      rows: [],
    })
    const plan = await adapter.planUnits([unitRow(releaseFixture(), 'sonarr-anime-nzb')], {
      blocks: new Blocks(),
      intent: 'acceptance',
    })
    const [unit] = await plan.units({ presence: empty, ownership: () => ({ record }) })
    assert.equal(unit.status, 'existing')
    assert.equal(unit.existing_record_id, record.id)
    assert.ok(!router.calls.some(call => call.includes('animetosho')), 'a covered source is not looked up')
  } finally {
    restore()
  }
})

/** A test client that plans one unit of `size` bytes for every row, acquired as `source`. */
function fixedPlanner(source: string, size: number, extra: Partial<SubmissionUnit> = {}) {
  return (rows: UnitRow[]): UnitPlan => ({
    sources: () => [source],
    units: async () =>
      rows.map(row => ({
        unit_id: `test:${source}:${row.category}`,
        protocol: 'torrent' as const,
        client: 'qbittorrent' as const,
        source_hash: source,
        category: row.category,
        status: 'new' as const,
        whole_source: true,
        scope_expanded: false,
        size_bytes: size,
        approximate: false,
        labels: [row.label],
        selections: [{ key: row.key, release: row.release }],
        requiresAck: false,
        send: { secret: 'client-only' },
        ...extra,
      })),
  })
}

test('review plans with a test adapter: its units are shown without client-only fields and sized against its disk', async () => {
  const restore = installRouter({ calls: [] })
  try {
    const config = baseConfig()
    const results = [resultFixture([releaseFixture({ info_hashes: [], torrent_files: [] })])] as unknown as ResultItem[]
    const memory = memoryDownloadClients({
      config,
      torrent: { planUnits: fixedPlanner('b'.repeat(40), 700, { requiresAck: true }), freeBytes: 500 },
    })
    const { review } = await buildDownloadPlan(config, [{ key: 'show-1', release: 0, protocol: 'torrent' }], {
      results,
      clients: memory.clients,
    })
    assert.deepEqual(review.blocked, [])
    assert.equal(review.units.length, 1)
    assert.equal(review.units[0].unit_id, `test:${'b'.repeat(40)}:sonarr-anime`)
    for (const field of ['send', 'requiresAck', 'sourceAlias'])
      assert.ok(!(field in review.units[0]), `the review never shows ${field}`)
    assert.equal(review.total_new_bytes, 700)
    assert.equal(review.requires_whole_ack, true)
    assert.equal(review.requires_space_ack, true)
  } finally {
    restore()
  }
})

test('review blocks a source two test adapters both plan as new, whatever each calls it', async () => {
  const restore = installRouter({ calls: [] })
  try {
    const config = baseConfig()
    const results = [
      resultFixture([releaseFixture()]),
      resultFixture([releaseFixture()], { key: 'show-2', title: 'Show Again' }),
    ] as unknown as ResultItem[]
    const memory = memoryDownloadClients({
      config,
      torrent: { planUnits: fixedPlanner('c'.repeat(40), 10, { sourceAlias: 'files:same' }) },
      usenet: { planUnits: fixedPlanner('files:same', 10, { protocol: 'usenet', client: 'sabnzbd' }) },
    })
    const { review } = await buildDownloadPlan(
      config,
      [
        { key: 'show-1', release: 0, protocol: 'torrent' },
        { key: 'show-2', release: 0, protocol: 'usenet' },
      ],
      { results, clients: memory.clients },
    )
    assert.deepEqual(review.units, [])
    assert.deepEqual(
      review.blocked.map(row => [row.key, row.code]),
      [
        ['show-1', 'conflict'],
        ['show-2', 'conflict'],
      ],
    )
  } finally {
    restore()
  }
})
