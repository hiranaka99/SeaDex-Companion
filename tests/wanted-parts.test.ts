import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  unwantedReason,
  upgradeAvailable,
  wantedParts,
  type RecommendationRelease,
  type RecommendationSeason,
  type UnwantedReason,
} from '../shared/download-plan.js'
import { autoNotifyNew, type NotifiedResult } from '../server/notifications.js'
import { compareScans } from '../server/scan-comparison.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { groupResults, upgradeSummary } from '../frontend/src/utils.js'
import { resultItem } from './support/results.js'
import { baseConfig, installRouter, releaseFixture, resultFixture } from './support/download-fixtures.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { downloadClients } from '../server/download-clients.js'
import type { ResultItem } from '../shared/contracts.js'

const release = (fields: Partial<RecommendationRelease> = {}): RecommendationRelease => ({
  kind: 'best',
  releaseGroup: 'Best',
  torrent_available: true,
  info_hashes: ['a'.repeat(40)],
  size: 1000,
  ...fields,
})

/** A season split into Cour 1 and Cour 2, each with one best release the library does not hold. */
const split = (fields: Partial<RecommendationSeason> = {}): RecommendationSeason => ({
  key: 'split',
  status: 'upgrade',
  precise_part_ownership: true,
  owned_by_part: {},
  releases: [
    release({ part: 'Cour 1', releaseGroup: 'One', info_hashes: ['1'.repeat(40)] }),
    release({ part: 'Cour 2', releaseGroup: 'Two', info_hashes: ['2'.repeat(40)] }),
  ],
  ...fields,
})

/** The same season as a scan result; tests only fill the fields the rule reads. */
const asResult = (season: RecommendationSeason, fields: Partial<ResultItem> = {}): ResultItem =>
  resultItem({ ...(season as unknown as Partial<ResultItem>), ...fields })

const reasons = (season: RecommendationSeason) =>
  season.releases.map((_, index) => unwantedReason(season, index) ?? 'wanted')

describe('upgrade available and wanted parts', () => {
  const cases: {
    name: string
    season: RecommendationSeason
    available: boolean
    wanted: string[]
    reasons: (UnwantedReason | 'wanted')[]
  }[] = [
    {
      name: 'an upgrade wants every part',
      season: split(),
      available: true,
      wanted: ['Cour 1', 'Cour 2'],
      reasons: ['wanted', 'wanted'],
    },
    {
      name: 'a season holding its best releases wants nothing',
      season: split({ status: 'best' }),
      available: false,
      wanted: [],
      reasons: ['no_upgrade', 'no_upgrade'],
    },
    {
      name: 'a partial season with an upgrade available wants its parts',
      season: split({ status: 'partial', upgrade_available: true }),
      available: true,
      wanted: ['Cour 1', 'Cour 2'],
      reasons: ['wanted', 'wanted'],
    },
    {
      name: 'a partial season without an upgrade wants nothing',
      season: split({ status: 'partial' }),
      available: false,
      wanted: [],
      reasons: ['no_upgrade', 'no_upgrade'],
    },
    {
      name: 'an ignored season keeps its upgrade but wants nothing',
      season: split({ excluded: true }),
      available: true,
      wanted: [],
      reasons: ['ignored', 'ignored'],
    },
    {
      name: 'an ignored part is not wanted',
      season: split({ excluded_parts: ['Cour 2'] }),
      available: true,
      wanted: ['Cour 1'],
      reasons: ['wanted', 'ignored_part'],
    },
    {
      name: 'a part the library settles is not wanted',
      season: split({ owned_by_part: { 'Cour 1': ['One'] } }),
      available: true,
      wanted: ['Cour 2'],
      reasons: ['owned', 'wanted'],
    },
    {
      name: 'an owned release that settles its part takes the part out, other releases included',
      season: split({
        owned_by_part: { 'Cour 1': ['Held'] },
        releases: [
          release({ part: 'Cour 1', releaseGroup: 'One' }),
          release({ part: 'Cour 1', kind: 'alt', releaseGroup: 'Held', satisfies: true }),
          release({ part: 'Cour 2', releaseGroup: 'Two' }),
        ],
      }),
      available: true,
      wanted: ['Cour 2'],
      reasons: ['settled', 'not_offered', 'wanted'],
    },
    {
      name: 'an owned target that does not settle its part leaves the best release wanted (strict mode)',
      season: split({
        owned_by_part: { 'Cour 1': ['Held'] },
        releases: [
          release({ part: 'Cour 1', releaseGroup: 'One' }),
          release({ part: 'Cour 1', kind: 'alt', releaseGroup: 'Held', target: true, satisfies: false }),
          release({ part: 'Cour 2', releaseGroup: 'Two' }),
        ],
      }),
      available: true,
      wanted: ['Cour 1', 'Cour 2'],
      reasons: ['wanted', 'owned', 'wanted'],
    },
    {
      name: 'a part whose only release is excluded is not wanted',
      season: split({
        releases: [
          release({ part: 'Cour 1', releaseGroup: 'One', excluded_by: 'Ignored tracker' }),
          release({ part: 'Cour 2', releaseGroup: 'Two' }),
        ],
      }),
      available: true,
      wanted: ['Cour 2'],
      reasons: ['not_offered', 'wanted'],
    },
    {
      name: 'a part stays wanted when nothing can fetch it yet',
      season: split({
        releases: [release({ part: 'Cour 1', releaseGroup: 'One', torrent_available: false, info_hashes: [] })],
      }),
      available: true,
      wanted: ['Cour 1'],
      reasons: ['wanted'],
    },
  ]

  for (const { name, season, available, wanted, reasons: expected } of cases)
    test(name, () => {
      assert.equal(upgradeAvailable(season), available)
      assert.deepEqual(
        wantedParts(season).map(part => part.part),
        wanted,
      )
      assert.deepEqual(reasons(season), expected)
      // A release is wanted exactly when it is one of a wanted part's options.
      const options = new Set(wantedParts(season).flatMap(part => part.options.map(option => option.index)))
      assert.deepEqual(
        season.releases.map((_, index) => options.has(index)),
        expected.map(reason => reason === 'wanted'),
      )
    })
})

describe('notifications announce wanted parts', () => {
  const config = { ...DEFAULT_CONFIG, notify_enabled: true, webhook: 'https://discord.example/webhook' }
  const deliveries = () => {
    let saved = new Set<string>()
    const sent: string[] = []
    const dependencies = {
      load: () => new Set(saved),
      save: (keys: Set<string>) => {
        saved = new Set(keys)
      },
      send: async (_webhook: string, results: NotifiedResult[], onSent?: (result: NotifiedResult) => void) => {
        for (const result of results) {
          sent.push(result.key)
          onSent?.(result)
        }
        return results.length
      },
    }
    /** A scan ending with these results. */
    const notify = (results: ResultItem[]) => autoNotifyNew(config, results, compareScans([], results), dependencies)
    return { sent, notify }
  }
  /** Cour 1 is held at its best release; only the ignored Cour 2 remains. */
  const ignoredRemainder = () => asResult(split({ owned_by_part: { 'Cour 1': ['One'] }, excluded_parts: ['Cour 2'] }))

  test('a season whose only remaining part is ignored is not announced', async () => {
    const { sent, notify } = deliveries()
    assert.equal(await notify([ignoredRemainder()]), 0)
    assert.deepEqual(sent, [])
  })

  test('a season with a wanted part is announced once', async () => {
    const { sent, notify } = deliveries()
    await notify([asResult(split({ excluded_parts: ['Cour 2'] }))])
    await notify([asResult(split({ excluded_parts: ['Cour 2'] }))])
    assert.deepEqual(sent, ['split'])
  })

  test('ignoring a part and restoring it does not announce the same upgrade again', async () => {
    const { sent, notify } = deliveries()
    await notify([asResult(split({ owned_by_part: { 'Cour 1': ['One'] } }))])
    await notify([ignoredRemainder()])
    await notify([asResult(split({ owned_by_part: { 'Cour 1': ['One'] } }))])
    assert.deepEqual(sent, ['split'])
  })
})

describe('the library summary line follows wanted parts', () => {
  const season = (key: string, title: string, fields: Partial<RecommendationSeason> = {}) =>
    asResult(split({ key, ...fields }), {
      title,
      group_id: title.length,
      arr: 'Sonarr',
      season: 1,
      local_size: 500,
      best_size: 2000,
    })

  test('a title whose remaining parts are all ignored is not counted', () => {
    const groups = groupResults([
      season('wanted', 'Wanted'),
      season('ignored', 'Ignored title', { owned_by_part: { 'Cour 1': ['One'] }, excluded_parts: ['Cour 2'] }),
    ])
    const summary = upgradeSummary(groups)
    assert.equal(summary.titles, 1)
    assert.equal(summary.download.bytes, 2000)
    assert.equal(summary.growth, 1500)
  })

  test('nothing is counted when every upgrade is ignored', () => {
    const summary = upgradeSummary(groupResults([season('ignored', 'Ignored', { excluded: true })]))
    assert.deepEqual(summary, { titles: 0, download: { bytes: 0, unknown: 0 }, growth: 0 })
  })
})

describe('batch preflight refuses what bulk review does not offer', () => {
  test('each unwanted row is blocked with the reason bulk review would give', async () => {
    const cleanup = installRouter({ calls: [] })
    try {
      const hash = (digit: string) => digit.repeat(40)
      const results = [
        resultFixture(
          [
            releaseFixture({ releaseGroup: 'One', info_hashes: [hash('1')] }),
            releaseFixture({ releaseGroup: 'Held', kind: 'alt', satisfies: true, info_hashes: [hash('2')] }),
            releaseFixture({ releaseGroup: 'Two', part: 'Cour 2', info_hashes: [hash('3')] }),
            releaseFixture({ releaseGroup: 'Three', part: 'Cour 3', info_hashes: [hash('4')] }),
          ],
          { precise_part_ownership: true, owned_by_part: { 'Cour 1': ['Held'] }, excluded_parts: ['Cour 2'] },
        ),
      ] as unknown as ResultItem[]
      const config = baseConfig({ download_mode: 'torrent_only' })
      const plan = await buildDownloadPlan(
        config,
        [0, 2, 3].map(release => ({ key: 'show-1', release })),
        { results, clients: downloadClients(config) },
      )
      assert.ok('review' in plan)
      assert.deepEqual(
        plan.review.blocked.map(row => [row.release, row.code, row.reason]),
        [
          [0, 'owned', 'The library already holds a release that settles this season or cour.'],
          [2, 'excluded', 'This cour is excluded from downloads.'],
        ],
      )
    } finally {
      cleanup()
    }
  })
})
