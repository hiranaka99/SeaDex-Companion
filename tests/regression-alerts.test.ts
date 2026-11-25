import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DATA_DIR } from '../server/paths.js'
import { buildScanHistoryEntry } from '../server/history.js'
import { loadReleaseChanges, recordReleaseChanges } from '../server/release-changes.js'
import { autoNotifyNew, discordMessageBody } from '../server/notifications.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { setState } from '../server/scan-state.js'
import { describeRegression } from '../shared/release-changes.js'
import { changeTypeLabel, historyDetails, historyStatusText, summarizeChanges } from '../frontend/src/history.js'
import { presentReleaseChange } from '../frontend/src/release-changes.js'
import type { Release, ResultItem, ScanHistoryChange } from '../shared/contracts.js'
import type { JsonObject } from '../server/types.js'

const hash = (letter: string) => letter.repeat(40)
const release = (group: string, changes: Partial<Release> = {}): Release => ({
  kind: 'best',
  releaseGroup: group,
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 100,
  info_hashes: [hash('a')],
  torrent_available: true,
  ...changes,
})
function season(changes: Partial<ResultItem> = {}): ResultItem {
  return {
    key: 'Sonarr:42:1:Best',
    group_id: 42,
    arr: 'Sonarr',
    title: 'Show',
    season: 1,
    status: 'best',
    match_status: 'matched',
    have: ['Best'],
    local_size: 1000,
    best_group: 'Best',
    best_size: 100,
    releases: [release('Best')],
    library_key: 'Sonarr:item10',
    url: 'https://seadex.moe/42/',
    notes: '-',
    image: null,
    banner: null,
    anilist_id: 42,
    arr_url: null,
    ...changes,
  }
}
const replaced = () => season({ status: 'upgrade', have: ['Weekly'], local_size: 700 })

test('losing the best release because the files changed is a regression', () => {
  assert.deepEqual(describeRegression(season(), replaced()), {
    kind: 'regression',
    description: 'Your files changed: Best → Weekly',
  })
  assert.deepEqual(
    describeRegression(season(), season({ status: 'upgrade', local_size: 900, mismatched_by_part: { '': ['Best'] } })),
    { kind: 'regression', description: 'Your files changed and no longer match the best release' },
    'Same group name, different files',
  )
  assert.deepEqual(
    describeRegression(
      season({ status: 'best' }),
      season({ status: 'partial', upgrade_available: true, have: [], local_size: 0 }),
    ),
    { kind: 'regression', description: 'Your files changed: Best → none' },
  )
})

test('a changed recommendation, unchanged files, or a season that was never best is not a regression', () => {
  assert.equal(
    describeRegression(
      season(),
      season({
        status: 'upgrade',
        have: ['Best'],
        best_group: 'Newer',
        releases: [release('Newer', { info_hashes: [hash('b')] })],
      }),
    ),
    null,
    'SeaDex picked another release',
  )
  assert.equal(
    describeRegression(
      season(),
      season({
        status: 'upgrade',
        have: ['Weekly'],
        local_size: 700,
        releases: [release('Best', { info_hashes: [hash('b')] })],
      }),
    ),
    null,
    'The listed torrent itself changed',
  )
  assert.equal(
    describeRegression(season(), season({ status: 'upgrade', mismatched_by_part: { '': ['Best'] } })),
    null,
    'The same files, judged anew, are not a change in the library',
  )
  assert.equal(describeRegression(season({ status: 'upgrade', have: ['Old'] }), replaced()), null)
  assert.equal(
    describeRegression(season(), season({ have: ['Best', 'Extra'], local_size: 1200 })),
    null,
    'Still on the best release',
  )
  // A reworded SeaDex note does not turn a file change into a recommendation change.
  assert.deepEqual(describeRegression(season(), { ...replaced(), notes: 'Updated note' })?.kind, 'regression')
})

test('scan history tells a regression apart from a new upgrade', () => {
  const upgradeOnly = season({
    key: 'Sonarr:43:1:Best',
    library_key: 'Sonarr:item11',
    title: 'Other',
    status: 'upgrade',
    have: ['Old'],
  })
  const before = [
    season(),
    season({
      key: 'Sonarr:43:1:Old',
      library_key: 'Sonarr:item11',
      title: 'Other',
      status: 'best',
      have: ['Old'],
      best_group: 'Old',
      releases: [release('Old')],
    }),
  ]
  const entry = buildScanHistoryEntry(
    before as ResultItem[],
    [replaced(), upgradeOnly] as ResultItem[],
    '2026-11-25 10:00:00',
  )
  assert.deepEqual(
    entry.changes.map(change => [change.title, change.type, change.from, change.to]),
    [
      ['Show', 'regression', 'best', 'upgrade'],
      ['Other', 'upgrade', 'best', 'upgrade'],
    ],
  )
  assert.deepEqual(entry.changes[0].details, ['Your files changed: Best → Weekly'])
  assert.deepEqual(entry.changes[0].release_changes, [
    { kind: 'regression', description: 'Your files changed: Best → Weekly' },
  ])

  // After a change of preferences, a status move says nothing about the library.
  const baseline = buildScanHistoryEntry(
    before as ResultItem[],
    [replaced()] as ResultItem[],
    '2026-11-25 10:00:00',
    'manual',
    { settingsChanged: true },
  )
  assert.equal(baseline.changes.find(change => change.title === 'Show')?.type, 'upgrade')

  // Presentation: named first in the summary, with what changed underneath.
  const shown = entry.changes as unknown as ScanHistoryChange[]
  assert.deepEqual(summarizeChanges(shown), [
    { type: 'regression', count: 1, label: 'no longer best' },
    { type: 'upgrade', count: 1, label: 'upgrade available' },
  ])
  assert.equal(changeTypeLabel.regression, 'No longer best')
  assert.equal(historyStatusText(shown[0]), 'Best owned → Upgrade available')
  assert.deepEqual(historyDetails(shown[0]), [
    { summary: 'No longer on the best release', release: 'Your files changed: Best → Weekly', part: undefined },
  ])
  assert.deepEqual(
    presentReleaseChange({ kind: 'regression', description: 'Your files changed: Best → Weekly' }).summary,
    'No longer on the best release',
  )
})

test('a regression becomes an unseen change, unless the results are a new baseline', () => {
  const file = join(DATA_DIR, 'regression-changes.test.json')
  try {
    recordReleaseChanges([season()], [replaced()], file, '2026-11-25T10:00:00.000Z')
    const stored = Object.values(loadReleaseChanges(file)).flat()
    assert.deepEqual(
      stored.map(change => [change.kind, change.description, change.detected_at]),
      [['regression', 'Your files changed: Best → Weekly', '2026-11-25T10:00:00.000Z']],
    )
    // A baseline scan adds nothing and keeps what was already waiting for review.
    recordReleaseChanges(
      [replaced()],
      [season({ status: 'upgrade', have: ['Third'], local_size: 5 })],
      file,
      '2026-11-26T10:00:00.000Z',
      { baseline: true },
    )
    assert.deepEqual(
      Object.values(loadReleaseChanges(file))
        .flat()
        .map(change => change.id),
      stored.map(change => change.id),
    )
    recordReleaseChanges(
      [season()],
      [season({ status: 'upgrade', best_group: 'Newer', releases: [release('Newer', { info_hashes: [hash('b')] })] })],
      file,
      '2026-11-27T10:00:00.000Z',
      { baseline: true },
    )
    assert.equal(
      Object.values(loadReleaseChanges(file)).flat().length,
      1,
      'A baseline also records no recommendation change',
    )
  } finally {
    rmSync(file, { force: true })
  }
})

test('the notification for a regression says what happened instead of announcing a new release', async () => {
  const regression = discordMessageBody({ ...replaced(), regression: 'Your files changed: Best → Weekly' })
  assert.equal(regression.content, 'Show (S01) — no longer on its best release')
  assert.equal(regression.embeds[0].color, 0xed4245)
  assert.deepEqual(regression.embeds[0].fields[0], { name: 'What changed', value: 'Your files changed: Best → Weekly' })
  const mismatch = discordMessageBody(season({ status: 'upgrade', mismatched_by_part: { '': ['Best'] } }))
  assert.equal(mismatch.content, 'Show (S01) — your Best files differ from the listed release')
  assert.equal(
    discordMessageBody(replaced()).content,
    'Show (S01) — new best release Best',
    'An ordinary upgrade keeps its wording',
  )
  assert.equal(
    discordMessageBody({ ...replaced(), instance: 'uhd4k', instance_name: 'Sonarr 4K' }).embeds[0].author.name,
    'SeaDex · Sonarr 4K',
  )

  resetRuntimeForTests()
  const sent: JsonObject[] = []
  try {
    setState({ results: [replaced()] })
    const count = await autoNotifyNew(
      { ...DEFAULT_CONFIG, webhook: 'https://discord.test/hook' },
      {
        load: () => new Set(),
        save: () => {},
        previous: [season()] as ResultItem[],
        regressions: { 'Sonarr:42:1:Best': 'Your files changed: Best → Weekly' },
        send: async (_webhook, results) => {
          sent.push(...results)
          return results.length
        },
      },
    )
    assert.equal(count, 1)
    assert.equal(sent[0].regression, 'Your files changed: Best → Weekly')
  } finally {
    resetRuntimeForTests()
  }
})
