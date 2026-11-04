import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ResultItem } from '../shared/contracts.js'
import { currentReleases, releaseCours, releaseOverview, releaseQuality } from '../frontend/src/release-status.js'

const best = { kind: 'best' as const, releaseGroup: 'sam', tracker: 'Nyaa', quality: '1080p', tags: [], size: 200, info_hashes: ['a'.repeat(40)], downloadable: true }
const season: ResultItem = { key: 'Sonarr:1:1', group_id: 1, arr: 'Sonarr', title: 'Example', season: 1, status: 'best', match_status: 'matched', have: ['sam'], local_size: 200, best_group: 'sam', best_size: 200, releases: [best], url: null, notes: null, image: null, banner: null, anilist_id: 1, arr_url: null }
const split: ResultItem = { ...season, precise_part_ownership: true, have_by_part: { 'Cour 1': ['sam'], 'Cour 2': ['Other'] }, owned_by_part: { 'Cour 1': ['sam'], 'Cour 2': ['Other'] }, status: 'upgrade', releases: [{ ...best, part: 'Cour 1' }, { ...best, part: 'Cour 2' }] }

test('best ownership requires every cour, and a matching alternative cannot imply best', () => {
  const cours = releaseCours(split)
  assert.equal(releaseQuality(split).kind, 'upgrade')
  assert.equal(releaseQuality(split, cours[0]).kind, 'best')
  assert.equal(releaseQuality(split, cours[1]).kind, 'upgrade')
  const ownsAlternative = { ...season, status: 'upgrade' as const, have: ['Other'], releases: [best, { ...best, kind: 'alt' as const, releaseGroup: 'Other' }] }
  assert.equal(releaseQuality(ownsAlternative).label, 'Upgrade available')
})

test('complete ownership is not inferred from groups found in some cour files', () => {
  const incomplete = { ...split, have_by_part: { 'Cour 1': ['sam'], 'Cour 2': ['sam'] }, owned_by_part: { 'Cour 1': ['sam'], 'Cour 2': [] } }
  const second = releaseCours(incomplete)[1]
  assert.deepEqual(currentReleases(incomplete, 'Cour 2'), ['sam'])
  assert.equal(releaseQuality(incomplete, second).kind, 'upgrade')
  assert.notEqual(releaseOverview([incomplete], 'Sonarr').kind, 'best')
  const unscoped = { ...split, precise_part_ownership: false, have: ['sam'] }
  assert.notEqual(releaseQuality(unscoped, releaseCours(unscoped)[0]).kind, 'best')
  const legacyBest = { ...unscoped, status: 'best' as const }
  assert.notEqual(releaseQuality(legacyBest, releaseCours(legacyBest)[0]).kind, 'best')
  assert.notEqual(releaseOverview([legacyBest], 'Sonarr').kind, 'best', 'Legacy season-wide group names do not prove each cour is complete')
})

test('a complete best alternative for each cour is sufficient, even with multiple best choices', () => {
  const owned = { ...split, status: 'best' as const, owned_by_part: { 'Cour 1': ['sam'], 'Cour 2': ['sam'] }, releases: [...split.releases, { ...best, part: 'Cour 2', releaseGroup: 'Another best' }] }
  assert.equal(releaseQuality(owned).label, 'Best owned')
  assert.equal(releaseOverview([owned], 'Sonarr').title, 'You have the best release')
  assert.equal(releaseQuality({ ...owned, excluded: true, excluded_parts: ['Cour 2'] }).kind, 'best', 'Exclusions change download scope, not quality')
})

test('unavailable cours and their current files stay visible and cannot turn the season green', () => {
  const partial = { ...split, status: 'partial' as const, upgrade_available: false, releases: [split.releases[0]], unavailable_parts: [{ label: 'Cour 2', reason: 'Not listed on SeaDex' }] }
  const cours = releaseCours(partial)
  assert.deepEqual(cours.map(cour => cour.part), ['Cour 1', 'Cour 2'])
  assert.equal(cours[1].unavailable, 'Not listed on SeaDex')
  assert.deepEqual(currentReleases(partial, 'Cour 2'), ['Other'])
  assert.equal(releaseQuality(partial, cours[1]).kind, 'missing')
  assert.equal(releaseOverview([partial, season], 'Sonarr').kind, 'partial')
})

test('cour grouping merges nonadjacent releases and uses numeric order', () => {
  const courSeason = { ...season, releases: [{ ...best, part: 'Cour 10' }, { ...best, part: 'Cour 2' }, { ...best, kind: 'alt' as const, part: 'Cour 10' }] }
  const cours = releaseCours(courSeason)
  assert.deepEqual(cours.map(cour => [cour.part, cour.items.map(item => item.index)]), [['Cour 2', [1]], ['Cour 10', [0, 2]]])
})

test('missing episodes and uncertain mappings override best group names', () => {
  const incomplete = { ...season, missing_episode_count: 2 }
  assert.equal(releaseQuality(incomplete).kind, 'incomplete')
  assert.equal(releaseOverview([season, incomplete], 'Sonarr').title, 'Your library has missing episodes')
  const unmatched = { ...season, status: 'upgrade' as const, match_status: 'unmatched' as const }
  assert.equal(releaseQuality(unmatched).kind, 'review')
  const summary = releaseOverview([unmatched, season], 'Sonarr')
  assert.equal(summary.title, '1 season needs a match review')
  assert.ok(!summary.description.includes('upgradable'), 'Uncertain recommendations are not counted as upgrades')
  assert.deepEqual(currentReleases(unmatched), ['sam'], 'Matching uncertainty must not hide known local files')
})

test('summaries use movie terminology and do not claim ownership without release evidence', () => {
  assert.equal(releaseOverview([{ ...season, arr: 'Radarr', season: 0 }], 'Radarr').description, 'Your movie matches SeaDex recommendations.')
  assert.equal(releaseQuality({ ...season, releases: [] }).kind, 'partial')
  const missing = { ...season, status: 'missing' as const, releases: [] }
  assert.equal(releaseOverview([missing], 'Sonarr').title, 'No releases found on SeaDex')
})
