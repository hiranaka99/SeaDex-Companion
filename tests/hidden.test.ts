import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { applyConfigUpdate, DEFAULT_CONFIG, loadConfig, saveConfig } from '../server/config.js'
import { CONFIG_FILE } from '../server/paths.js'
import { unhideNewBestReleases } from '../server/hidden.js'
import { runScan } from '../server/scan.js'
import { getState, resetRuntimeForTests, setState } from '../server/app.js'
import type { Config, JsonObject } from '../server/types.js'

const best = (hash = 'a', changes = {}) => ({ kind: 'best', releaseGroup: 'Group', tracker: 'Nyaa', quality: '1080p', info_hashes: [hash.repeat(40)], ...changes })
const anime = (releases = [best()], changes = {}): JsonObject => ({ key: 'Sonarr:42:1:Group', group_id: 42, anilist_id: 42, library_key: 'Sonarr:item1', arr: 'Sonarr', title: 'Anime', season: 1, releases, ...changes })

function check(previous: JsonObject[], current: JsonObject[], changes: Partial<Config> = {}) {
  let config = { ...DEFAULT_CONFIG, unhide_on_new_best: true, hidden: ['42', '99'], ...changes }
  let saves = 0
  const restored = unhideNewBestReleases(previous, current, { loadConfig: () => config, saveConfig: next => { config = next; saves++ } })
  return { restored, config, saves }
}

test('automatic unhiding defaults off and requires a boolean setting', () => {
  assert.equal(DEFAULT_CONFIG.unhide_on_new_best, false)
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { unhide_on_new_best: true }).unhide_on_new_best, true)
  assert.equal(applyConfigUpdate({ ...DEFAULT_CONFIG, unhide_on_new_best: true }, {}).unhide_on_new_best, true)
  assert.throws(() => applyConfigUpdate(DEFAULT_CONFIG, { unhide_on_new_best: 'true' }), /must be a boolean/)
  assert.equal(check([anime()], [anime([best('b')])], { unhide_on_new_best: false }).saves, 0)
})

test('new best torrents, groups, promotions, and newly covered seasons restore the entire anime', () => {
  for (const [previous, current] of [
    [[anime()], [anime([best('b')])]],
    [[anime()], [anime([best('b', { releaseGroup: 'New group' })])]],
    [[anime([best(), best('b', { kind: 'alt' })])], [anime([best(), best('b')])]],
    [[anime([])], [anime()]],
    [[anime()], [anime(), anime([best('b')], { season: 2 })]],
  ]) {
    const { restored, config, saves } = check(previous, current)
    assert.deepEqual(restored, ['42'])
    assert.deepEqual(config.hidden, ['99'])
    assert.equal(saves, 1)
    assert.equal(config.unhide_on_new_best, true)
  }
})

test('unchanged releases, alternatives, metadata, file selection, and removals stay hidden', () => {
  for (const releases of [
    [best()],
    [best(), best('b', { kind: 'alt' })],
    [best('a', { size: 200, quality: '1080p Blu-ray', selected_files: ['02.mkv'], info_hashes: ['A'.repeat(40)] })],
    [],
  ]) assert.equal(check([anime()], [anime(releases, { notes: 'Updated notes', status: 'upgrade', have: ['Different local group'] })]).saves, 0)
  assert.equal(check([anime([best('a', { info_hashes: ['a', 'b'] })])], [anime([best('a', { info_hashes: ['b', 'a'] })])]).saves, 0)
  assert.equal(check([anime([best('a', { info_hashes: ['a', 'b'] })])], [anime([best('a', { info_hashes: ['a'] })])]).saves, 0)
})

test('first scans establish a baseline and retained incremental results do not restore unrelated titles', () => {
  assert.equal(check([], [anime()]).saves, 0)
  assert.equal(check([anime()], [anime(), anime([best('b')], { group_id: 99 })]).saves, 0)
  assert.equal(check([anime()], [anime([best('b')])], { hidden: ['99'] }).saves, 0)
  const { config } = check([anime()], [anime([best('b')]), anime([best('c')], { season: 2 })])
  assert.deepEqual(config.hidden, ['99'])
})

test('a completed scan unhides after saving results and failures or cancellation never unhide', async () => {
  resetRuntimeForTests()
  const previous = [anime()]
  setState({ results: previous })
  const normalizedPrevious = getState().results
  const calls: string[] = []
  let compared: { before: JsonObject[]; after: JsonObject[] } | undefined
  const dependencies = {
    seadexBest: async () => new Map(), localItems: async () => [], loadCache: () => ({}),
    saveLastResults: () => { calls.push('save') }, autoNotifyNew: async () => 0,
    unhideNewBestReleases: (before: JsonObject[], after: JsonObject[]) => {
      compared = { before, after }
      calls.push('unhide')
      return []
    },
  }
  try {
    await runScan(DEFAULT_CONFIG, dependencies)
    assert.deepEqual(calls, ['save', 'unhide'])
    assert.deepEqual(compared, { before: normalizedPrevious, after: [] })
    calls.length = 0
    await runScan(DEFAULT_CONFIG, { ...dependencies, seadexBest: async () => { throw new Error('Catalog unavailable') } })
    assert.deepEqual(calls, [])
    assert.match(getState().error || '', /Catalog unavailable/)
    await runScan(DEFAULT_CONFIG, { ...dependencies, seadexBest: async () => { throw new DOMException('Cancelled', 'AbortError') } })
    assert.deepEqual(calls, [])
    assert.equal(getState().cancelled, true)
  } finally { resetRuntimeForTests() }
})

test('scans persist restored visibility using current settings and allow hiding the anime again', async () => {
  const saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : null
  resetRuntimeForTests()
  setState({ results: [anime()] })
  const latest = { ...DEFAULT_CONFIG, unhide_on_new_best: true, hidden: ['42', '99'], sonarr_category: 'edited-during-scan' }
  const dependencies = {
    seadexBest: async () => new Map([[42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 1: { candidates: [{
      releaseGroup: 'Group', tracker: 'Nyaa', quality: '1080p', tags: [], size: 200, file_count: 1, info_hashes: ['b'.repeat(40)], is_best: true,
    }] } } }]]),
    localItems: async () => [{ arr: 'Sonarr' as const, id: 1, title: 'Anime', seasons: { 1: { groups: ['Old'], size: 100 } } }],
    anilistChain: async () => [{ season: 1, id: 42, ids: [42], episodeCount: 1, parts: [{ id: 42, episodeCount: 1 }] }],
    loadCache: () => ({}), saveLastResults: () => {}, autoNotifyNew: async () => 0,
  }
  try {
    saveConfig(latest)
    // The scan's initial configuration can be stale by the time it completes.
    await runScan(DEFAULT_CONFIG, dependencies)
    assert.equal(getState().error, null)
    assert.deepEqual(loadConfig().hidden, ['99'])
    assert.equal(loadConfig().unhide_on_new_best, true)
    assert.equal(loadConfig().sonarr_category, 'edited-during-scan')
    saveConfig(latest)
    await runScan(DEFAULT_CONFIG, dependencies)
    assert.deepEqual(loadConfig().hidden, ['42', '99'], 'The same best release must not repeatedly restore a rehidden anime')
  } finally {
    if (saved) writeFileSync(CONFIG_FILE, saved)
    else rmSync(CONFIG_FILE, { force: true })
    resetRuntimeForTests()
  }
})
