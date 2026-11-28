import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ResultItem } from '../shared/contracts.js'
import { episodeRangeLabel } from '../shared/releases.js'
import { upgradeAvailable, wantedParts } from '../shared/download-plan.js'
import { WRONG_EPISODES_NOTE, wrongEpisodesNote } from '../shared/episode-order.js'
import { listingViolations } from './support/listing-invariants.js'
import { replayCatalog } from './support/seadex-replay.js'

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/seadex/${name}`, import.meta.url), 'utf8')).items

const listedReleases = (result: ResultItem) =>
  result.releases.map(release => [
    release.part,
    `${release.releaseGroup} (${release.tracker})`,
    episodeRangeLabel(release.selected_files || []),
  ])

// SeaDex's entries for Dr. STONE: NEW WORLD (AniList 131518 and 162670) as its API returned them on 2026-11-27:
// sam's 22-episode batch on Nyaa, whose first-part episodes are "v2" re-releases, and the same encode on AB per part.
test('replaying the real Dr. STONE catalog lists sam once per cour, each with its own episodes', async () => {
  const { result, violations } = await replayCatalog(fixture('dr-stone-new-world.json'), {
    season: 3,
    parts: [
      { alid: 131518, episodes: 11 },
      { alid: 162670, episodes: 11 },
    ],
    own: ['sam'],
  })
  assert.deepEqual(violations, [])
  assert.equal(result.status, 'best')
  assert.deepEqual(listedReleases(result), [
    ['Cour 1', 'sam (Nyaa)', 'Eps 1–11'],
    ['Cour 2', 'sam (Nyaa)', 'Eps 12–22'],
  ])
})

// SeaDex's entries for Fate/Zero (AniList 10087 and 11741) as its API returned them on 2026-11-28:
// Okay-Subs's 25-episode batch and LYS1TH3A's dot-separated S01E01.1080p 25-episode batch on Nyaa,
// alongside per-part copies of both encodes on AB.
test('replaying the real Fate/Zero catalog scopes both Okay-Subs and LYS1TH3A per part with no duplicates', async () => {
  const { result, violations } = await replayCatalog(fixture('fate-zero.json'), {
    season: 1,
    parts: [
      { alid: 10087, episodes: 13 },
      { alid: 11741, episodes: 12 },
    ],
    own: ['Okay-Subs'],
    trackers: 'private',
  })
  assert.deepEqual(violations, [])
  assert.equal(result.status, 'best')
  assert.deepEqual(listedReleases(result), [
    ['Cour 1', 'Okay-Subs (Nyaa)', 'Eps 1–13'],
    ['Cour 1', 'LYS1TH3A (Nyaa)', 'Eps 1–13'],
    ['Cour 2', 'Okay-Subs (Nyaa)', 'Eps 14–25'],
    ['Cour 2', 'LYS1TH3A (Nyaa)', 'Eps 14–25'],
  ])
})

// SeaDex's entries for Panty & Stocking with Garterbelt as its API returned them on 2026-11-28. TVDB's aired order
// counts every segment as an episode (26 in Season 1, 30 in Season 2); its DVD order combines them into 13 per season.
// Season 1 (AniList 8795): Underwater's 13 combined files. Season 2 (AniList 151799): NAN0's 30 segment files
// S02E01–S02E30, best, and GetItTwisted's 13 combined files S02E01–S02E13, alternative.
const pantyStocking = (season: 1 | 2) => fixture(`panty-stocking-s${season}.json`)
const releaseRow = (result: ResultItem, group: string) => {
  const release = result.releases.find(release => release.releaseGroup === group)
  assert.ok(release, `${group} is listed`)
  return release
}

test('replaying Panty & Stocking Season 2 in DVD order lists NAN0 as not fitting and never targets it', async () => {
  const { result, violations } = await replayCatalog(pantyStocking(2), {
    season: 2,
    parts: [{ alid: 151799, episodes: 13 }],
    seasonEpisodes: 13,
    episodeOrder: 'dvd',
    own: ['GetItTwisted'],
  })
  assert.deepEqual(violations, [])
  const nan0 = releaseRow(result, 'NAN0')
  assert.equal(nan0.kind, 'best')
  assert.equal(nan0.excluded_kind, 'episode_order')
  assert.deepEqual(nan0.episode_misfit, { release_episodes: 30, series_episodes: 13, episode_order: 'dvd' })
  assert.equal(nan0.target, undefined)
  assert.equal(nan0.selected_files, undefined)
  // GetItTwisted fits, but as an alternative it is no target while alternatives are not accepted, as when the
  // preferences exclude SeaDex's best release.
  const twisted = releaseRow(result, 'GetItTwisted')
  assert.equal(twisted.excluded_by, undefined)
  assert.equal(twisted.target, undefined)
  assert.equal(result.best_group, 'NAN0')
  assert.equal(result.preference_blocked, undefined)
  assert.equal(upgradeAvailable(result), true)
  assert.deepEqual(wantedParts(result), [])
})

test('replaying Panty & Stocking Season 2 in aired order excludes GetItTwisted and targets NAN0', async () => {
  const { result, violations } = await replayCatalog(pantyStocking(2), {
    season: 2,
    parts: [{ alid: 151799, episodes: 13 }],
    seasonEpisodes: 30,
    episodeOrder: 'official',
  })
  assert.deepEqual(violations, [])
  const twisted = releaseRow(result, 'GetItTwisted')
  assert.equal(twisted.excluded_kind, 'episode_order')
  assert.deepEqual(twisted.episode_misfit, { release_episodes: 13, series_episodes: 30, episode_order: 'official' })
  const nan0 = releaseRow(result, 'NAN0')
  assert.equal(nan0.excluded_by, undefined)
  assert.equal(nan0.target, true)
  assert.equal(episodeRangeLabel(nan0.selected_files || []) ?? 'whole release', 'whole release')
})

test('replaying Panty & Stocking Season 1 in DVD order keeps Underwater as the target', async () => {
  const { result, violations } = await replayCatalog(pantyStocking(1), {
    season: 1,
    parts: [{ alid: 8795, episodes: 13 }],
    seasonEpisodes: 13,
    episodeOrder: 'dvd',
  })
  assert.deepEqual(violations, [])
  const underwater = releaseRow(result, 'Underwater')
  assert.equal(underwater.excluded_by, undefined)
  assert.equal(underwater.target, true)
  assert.equal(episodeRangeLabel(underwater.selected_files || []), 'Eps 1–13')
})

test('replaying Panty & Stocking Season 1 in aired order, holding Underwater, says the files are on the wrong episodes', async () => {
  const { result, violations } = await replayCatalog(pantyStocking(1), {
    season: 1,
    parts: [{ alid: 8795, episodes: 13 }],
    seasonEpisodes: 26,
    own: ['Underwater'],
  })
  assert.deepEqual(violations, [])
  const underwater = releaseRow(result, 'Underwater')
  assert.equal(underwater.excluded_kind, 'episode_order')
  // Sonarr v3 reports no episode order, so none is named.
  assert.deepEqual(underwater.episode_misfit, { release_episodes: 13, series_episodes: 26 })
  assert.equal(underwater.target, undefined)
  assert.equal(wrongEpisodesNote(result, underwater), WRONG_EPISODES_NOTE)
  assert.deepEqual(wantedParts(result), [])
})

test('the listing rules catch a release excluded for its episode order that is targeted or selects files', async () => {
  const { result } = await replayCatalog(pantyStocking(2), {
    season: 2,
    parts: [{ alid: 151799, episodes: 13 }],
    seasonEpisodes: 13,
  })
  const broken: ResultItem = {
    ...result,
    releases: result.releases.map(release =>
      release.releaseGroup === 'NAN0' ? { ...release, target: true, selected_files: ['a.mkv'] } : release,
    ),
  }
  assert.deepEqual(listingViolations(broken), [
    "NAN0 (Nyaa) is the target of the season, although it does not fit the series' episode order",
    "NAN0 (Nyaa) selects files to download, although it does not fit the series' episode order",
  ])
})
