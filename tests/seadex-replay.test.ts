import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { episodeRangeLabel } from '../shared/releases.js'
import { replayCatalog } from './support/seadex-replay.js'

// SeaDex's entries for Dr. STONE: NEW WORLD (AniList 131518 and 162670) as its API returned them on 2026-11-27:
// sam's 22-episode batch on Nyaa, whose first-cour episodes are "v2" re-releases, and the same encode on AB per cour.
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/seadex/${name}`, import.meta.url), 'utf8')).items

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
  assert.deepEqual(
    result.releases.map(release => [
      release.part,
      `${release.releaseGroup} (${release.tracker})`,
      episodeRangeLabel(release.selected_files || []),
    ]),
    [
      ['Cour 1', 'sam (Nyaa)', 'Eps 1–11'],
      ['Cour 2', 'sam (Nyaa)', 'Eps 12–22'],
    ],
  )
})
