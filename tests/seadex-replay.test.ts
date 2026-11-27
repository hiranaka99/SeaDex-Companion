import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ResultItem } from '../shared/contracts.js'
import { episodeRangeLabel } from '../shared/releases.js'
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
