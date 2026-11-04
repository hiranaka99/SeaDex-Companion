import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { anilistChain, anilistSeason } from '../server/anilist.js'
import { DEFAULT_CONFIG } from '../server/config.js'
import { buildScanHistoryEntry } from '../server/history.js'
import { clearScannedData } from '../server/results.js'
import { normalizeResults } from '../server/result-model.js'
import { runScan, type ScanDependencies } from '../server/scan.js'
import { getState, setState } from '../server/scan-state.js'
import { loadUserRules, saveUserRules, type UserRules } from '../server/user-rules.js'
import type { ChainEntry, JsonObject, SeaDexEntry } from '../server/types.js'
import { groupResults } from '../frontend/src/utils.js'

const entry = (id: number, season = 1): ChainEntry => ({ season, id, ids: [id], parts: [{ id, episodeCount: 2 }], episodeCount: 2 })
const local = { groups: ['Local'], size: 200, episode_numbers: [1, 2] }
const media = (id: number, sequel?: number): JsonObject => ({
  id, format: 'ONA', episodes: 2, title: { english: `Anime ${id}` },
  relations: { edges: sequel ? [{ relationType: 'SEQUEL', node: { id: sequel } }] : [] },
})
const catalog = (id: number): SeaDexEntry => ({ url: `https://seadex.moe/${id}/`, notes: '-', seasons: { 0: { candidates: [{
  releaseGroup: `Best ${id}`, is_best: true, size: 300, file_count: 2,
  tracker: 'Nyaa', quality: '1080p', tags: [], info_hashes: [id.toString(16).padStart(40, '0')],
}] } } })

async function scan(rules: UserRules, overrides: ScanDependencies = {}) {
  setState({ running: false, results: [] })
  await runScan(DEFAULT_CONFIG, {
    localItems: async () => [{ arr: 'Sonarr', id: 10, title: 'Cyberpunk: Edgerunners', seasons: { 1: local, 2: local } }],
    anilistChain: async () => [entry(100), entry(200, 2)],
    anilistSeason: async ids => ({ ...entry(ids[0]), ids, parts: ids.map(id => ({ id, episodeCount: 1 })) }),
    seadexBest: async () => new Map([100, 200, 201, 900].map(id => [id, catalog(id)])),
    loadCache: () => ({}), loadUserRules: () => rules, saveLastResults: () => {},
    autoNotifyNew: async () => 0, unhideNewBestReleases: () => [],
    recordScanHistory: (previous, current, runAt) => buildScanHistoryEntry(previous, current, runAt),
    ...overrides,
  })
  assert.equal(getState().error, null)
  return getState().results
}

test('a disconnected second season resolves independently without changing season one', async () => {
  const results = await scan({ mappings: {}, season_mappings: { 'Sonarr:item10:2': [200] }, exclusions: [] }, {
    localItems: async () => [{ arr: 'Sonarr', id: 10, title: 'Cyberpunk: Edgerunners', seasons: { 1: { ...local, groups: ['Best 100'] }, 2: local } }],
    anilistChain: async (_title, _cache, _dependencies, _override, options) => {
      assert.deepEqual(options?.requiredSeasons, [1], 'Manual seasons do not trigger automatic-chain refreshes')
      return [entry(100)]
    },
  })
  assert.deepEqual(results.map(result => [result.anilist_id, result.match_status, result.season_mapping_override]), [[100, 'matched', false], [200, 'matched', true]])
  assert.deepEqual(results.map(result => result.best_group), ['Best 100', 'Best 200'])
  assert.deepEqual(results.map(result => result.status), ['best', 'upgrade'])
  assert.equal(groupResults(results).length, 1)
  assert.equal(groupResults(results)[0].status, 'upgrade')
  assert.equal(normalizeResults(results)[1].season_mapping_override, true, 'Saved results retain the manual season marker')
})

test('manual season matches take priority over automatic and show-level matches', async () => {
  let base: number | undefined
  const results = await scan({ mappings: { 'Sonarr:item10': 100 }, season_mappings: { 'Sonarr:item10:1': [900] }, exclusions: [] }, {
    anilistChain: async (_title, _cache, _dependencies, override) => { base = override; return [entry(100), entry(200, 2)] },
  })
  assert.equal(base, 100)
  assert.deepEqual(results.map(result => result.anilist_id), [900, 200])
  assert.deepEqual(results.map(result => result.group_id), [100, 100], 'Changing season one preserves the show anchor')
})

test('ordered manual cour entries preserve per-cour recommendations and ownership', async () => {
  const results = await scan({ mappings: {}, season_mappings: { 'Sonarr:item10:2': [201, 200] }, exclusions: [] }, {
    localItems: async () => [{ arr: 'Sonarr', id: 10, title: 'Anime', seasons: { 2: { ...local, groups: ['Best 201', 'Local'], groups_by_episode: { 'Best 201': [1], Local: [2] } } } }],
  })
  assert.deepEqual(results[0].anilist_ids, [201, 200])
  assert.deepEqual(results[0].releases.map(release => [release.part, release.releaseGroup]), [['Cour 1', 'Best 201'], ['Cour 2', 'Best 200']])
  assert.deepEqual(results[0].owned_by_part, { 'Cour 1': ['Best 201'], 'Cour 2': ['Local'] })
})

test('a matched season without SeaDex coverage is missing rather than awaiting match review', async () => {
  const results = await scan({ mappings: {}, season_mappings: { 'Sonarr:item10:2': [999] }, exclusions: [] })
  assert.equal(results[1].anilist_id, 999)
  assert.equal(results[1].status, 'missing')
  assert.equal(results[1].match_status, 'matched')
  assert.equal(groupResults(results)[0].status, 'partial')
})

test('manual matches still work and stay grouped when the automatic title lookup finds nothing', async () => {
  const results = await scan({ mappings: {}, season_mappings: { 'Sonarr:item10:2': [200] }, exclusions: [] }, { anilistChain: async () => [] })
  assert.equal(results[0].match_status, 'unmatched')
  assert.equal(results[1].match_status, 'matched')
  assert.equal(groupResults(results).length, 1)
})

test('an invalid explicit match stays unresolved instead of falling back to another anime', async () => {
  const results = await scan({ mappings: {}, season_mappings: { 'Sonarr:item10:2': [999] }, exclusions: [] }, { anilistSeason: async () => null })
  assert.equal(results[1].anilist_id, null)
  assert.equal(results[1].match_status, 'unmatched')
  assert.equal(results[1].season_mapping_override, true)
  assert.deepEqual(results[1].anilist_ids, [999], 'The invalid choice remains available to correct or reset')
  assert.deepEqual(results[1].releases, [])
})

test('removing a season override restores automatic mapping without affecting other seasons', async () => {
  const rules: UserRules = { mappings: {}, season_mappings: { 'Sonarr:item10:2': [900] }, exclusions: [] }
  assert.equal((await scan(rules))[1].anilist_id, 900)
  delete rules.season_mappings!['Sonarr:item10:2']
  const restored = await scan(rules)
  assert.deepEqual(restored.map(result => result.anilist_id), [100, 200])
  assert.equal(restored[1].season_mapping_override, false)
})

test('season mappings survive rule reloads and clearing scan caches, including legacy rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-season-rules-'))
  try {
    const file = join(dir, 'rules.json')
    writeFileSync(file, JSON.stringify({ mappings: { 'Sonarr:item10': 100 }, exclusions: ['Sonarr:item10:1:*'] }))
    const rules = loadUserRules(file)
    assert.deepEqual(rules.season_mappings, {})
    rules.season_mappings = { 'Sonarr:item10:2': [201, 200] }
    saveUserRules(rules, file)
    clearScannedData(join(dir, 'cache.json'), join(dir, 'results.json'))
    assert.deepEqual(loadUserRules(file), rules)
    writeFileSync(file, JSON.stringify({ ...rules, season_mappings: { valid: [200], duplicate: [1, 1], empty: [], invalid: [0], text: ['200'], huge: [Number.MAX_SAFE_INTEGER + 1] } }))
    assert.deepEqual(loadUserRules(file).season_mappings, { valid: [200] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('refreshes a recent incomplete chain once for a new Sonarr season, then caches that check', async () => {
  let clock = 1_000_000
  let calls = 0
  const cache: JsonObject = { 'chain:v8:100': { chain: [entry(100)], fetched_at: clock, checked_through_season: 1 } }
  const dependencies = {
    lookup: async () => ({ id: 100 }), persist: () => {}, now: () => clock,
    media: async () => { calls++; return media(100) },
  }
  await anilistChain('Anime', cache, dependencies, undefined, { requiredSeasons: [1, 2] })
  assert.equal(calls, 1)
  await anilistChain('Anime', cache, dependencies, undefined, { requiredSeasons: [1, 2] })
  assert.equal(calls, 1, 'Unlinked seasons do not cause a refresh on every scan')
  clock += 24 * 60 * 60 * 1000
  await anilistChain('Anime', cache, dependencies, undefined, { requiredSeasons: [1, 2] })
  assert.equal(calls, 2, 'Incomplete chains refresh after expiry')
})

test('legacy and expired chains discover newly linked sequels before marking a season unmatched', async () => {
  for (const saved of [{}, { fetched_at: 0 }]) {
    const cache: JsonObject = { 'chain:v8:100': { chain: [entry(100)], ...saved } }
    const chain = await anilistChain('Anime', cache, {
      lookup: async () => ({ id: 100 }), persist: () => {}, now: () => 100_000_000,
      media: async (_query, variables) => media(variables.id, variables.id === 100 ? 200 : undefined),
    }, undefined, { requiredSeasons: [1, 2] })
    assert.deepEqual(chain.map(item => item.id), [100, 200])
  }
})

test('a newly discovered sequel from the refreshed cache resolves during the same scan', async () => {
  const cache: JsonObject = { 'chain:v8:100': { chain: [entry(100)], fetched_at: Date.now() } }
  const results = await scan({ mappings: {}, exclusions: [] }, {
    loadCache: () => cache,
    anilistChain: (title, saved, _dependencies, id, options) => anilistChain(title, saved, {
      lookup: async () => ({ id: 100 }), persist: () => {},
      media: async (_query, variables) => media(variables.id, variables.id === 100 ? 200 : undefined),
    }, id, options),
  })
  assert.deepEqual(results.map(result => result.match_status), ['matched', 'matched'])
  assert.equal(results[1].anilist_id, 200)
})

test('explicit entry resolution keeps selection order, never follows sequels, and expires', async () => {
  const cache: JsonObject = {}
  const requested: number[] = []
  let clock = 1_000_000
  const dependencies = {
    persist: () => {}, now: () => clock,
    media: async (_query: string, variables: JsonObject) => { requested.push(variables.id); return media(variables.id, 999) },
  }
  const resolved = await anilistSeason([201, 200], cache, dependencies)
  assert.deepEqual(resolved?.ids, [201, 200])
  assert.deepEqual(requested, [201, 200])
  await anilistSeason([201, 200], cache, dependencies)
  assert.equal(requested.length, 2)
  clock += 24 * 60 * 60 * 1000
  await anilistSeason([201, 200], cache, dependencies)
  assert.deepEqual(requested, [201, 200, 201, 200])
  assert.equal(await anilistSeason([404], cache, { ...dependencies, media: async () => ({}) }), null)
})
