import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessSeason, type AssessmentSettings } from '../server/assessment.js'
import { verifyPart } from '../server/verification.js'
import { normalizeResults } from '../server/result-model.js'
import { releaseOwned, wantedParts } from '../shared/download-plan.js'
import { DEFAULT_RELEASE_PREFERENCES } from '../shared/settings.js'
import type { ChainEntry, LocalItem, LocalSeason, ReleaseCandidate, SeaDexEntry } from '../server/types.js'

/** A whole number of bytes, as real file sizes are. */
const gb = (count: number) => Math.round(count * 1024 ** 3)
const hash = (letter: string) => letter.repeat(40)
const episodeName = (episode: number, season = 1) =>
  `Show - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`

function candidate(group: string, sizes: number[], extra: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  return {
    releaseGroup: group,
    tracker: 'Nyaa',
    quality: '1080p Blu-ray',
    tags: [],
    size: sizes.reduce((sum, size) => sum + size, 0),
    file_count: sizes.length,
    info_hashes: [hash('a')],
    is_best: true,
    source_files: sizes.map((length, index) => ({ name: episodeName(index + 1), length })),
    ...extra,
  }
}

function localSeason(group: string, sizes: number[], firstEpisode = 1): LocalSeason {
  const episodes = sizes.map((_, index) => firstEpisode + index)
  return {
    groups: [group],
    size: sizes.reduce((sum, size) => sum + size, 0),
    episode_numbers: episodes,
    episode_count: episodes.length,
    missing_episode_count: 0,
    groups_by_episode: group ? { [group]: episodes } : {},
    sizes_by_episode: Object.fromEntries(episodes.map((episode, index) => [episode, sizes[index]])),
    files: sizes.map((size, index) => ({ size, episodes: [episodes[index]], group })),
  }
}

const chain = (parts: number[]): ChainEntry[] => [
  {
    season: 1,
    id: 42,
    ids: parts.map((_, index) => 42 + index),
    parts: parts.map((episodeCount, index) => ({ id: 42 + index, episodeCount })),
    episodeCount: parts.reduce((sum, count) => sum + count, 0),
  },
]
const catalog = (entries: Record<number, ReleaseCandidate[]>, season = 1) =>
  new Map<number, SeaDexEntry>(
    Object.entries(entries).map(([id, candidates]) => [
      Number(id),
      { url: `https://seadex.moe/${id}/`, notes: '', seasons: { [season]: { candidates } } },
    ]),
  )
const settings = (verify: boolean): AssessmentSettings => ({
  preferences: DEFAULT_RELEASE_PREFERENCES,
  verify,
  trackers: 'public',
})

function assess(local: LocalSeason, candidates: ReleaseCandidate[], verify = true) {
  const item: LocalItem = { arr: 'Sonarr', id: 1, title: 'Show', seasons: { 1: local } }
  return assessSeason({
    item: item,
    season: 1,
    local: local,
    chain: chain([local.episode_count || 0]),
    best: catalog({ 42: candidates }),
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: settings(verify),
  })
}

test('files whose sizes match the listed release are verified, and the season is best', () => {
  const sizes = [gb(1.5), gb(1.6), gb(1.4)]
  const result = assess(localSeason('Best', sizes), [candidate('Best', sizes)])
  assert.equal(result.status, 'best')
  assert.deepEqual(result.verified_by_part, { '': ['Best'] })
  assert.equal(result.mismatched_by_part, undefined)
})

test('the right release group with different file sizes is an upgrade, not the best release', () => {
  const listed = [gb(1.5), gb(1.6), gb(1.4)]
  // An earlier batch by the same group: one episode was re-encoded for the listed release.
  const result = assess(localSeason('Best', [gb(1.5), gb(1.6), gb(1.3)]), [candidate('Best', listed)])
  assert.equal(result.status, 'upgrade')
  assert.deepEqual(result.mismatched_by_part, { '': ['Best'] })
  assert.equal(releaseOwned(result, result.releases[0]), false)
  assert.deepEqual(
    wantedParts(result).map(part => part.options.map(option => option.release.releaseGroup)),
    [['Best']],
    'The listed release is offered although its group name is already in the library',
  )
  assert.deepEqual(result.have, ['Best'], 'The library groups stay visible')
})

test('turning the file check off restores the name-based verdict', () => {
  const result = assess(localSeason('Best', [gb(1), gb(1)]), [candidate('Best', [gb(2), gb(2)])], false)
  assert.equal(result.status, 'best')
  assert.equal(result.verified_by_part, undefined)
  assert.equal(result.mismatched_by_part, undefined)
})

test('matching file sizes prove ownership even when the files carry no release group', () => {
  const sizes = [gb(2), gb(2.1)]
  const unnamed = localSeason('', sizes)
  unnamed.groups = []
  const result = assess(unnamed, [candidate('Best', sizes)])
  assert.equal(result.status, 'best')
  assert.deepEqual(result.verified_by_part, { '': ['Best'] })
  assert.equal(releaseOwned(result, result.releases[0]), true)
})

test('nothing is concluded without file sizes on both sides', () => {
  const sizes = [gb(2), gb(2.1)]
  const withoutFiles = { ...localSeason('Best', sizes), files: undefined }
  assert.equal(
    assess(withoutFiles, [candidate('Best', [gb(3), gb(3)])]).status,
    'best',
    'Without library file sizes the group name decides',
  )
  const unlisted = candidate('Best', [gb(3), gb(3)], { source_files: [] })
  const result = assess(localSeason('Best', sizes), [unlisted])
  assert.equal(result.status, 'best', 'Without a listed file manifest the group name decides')
  assert.equal(result.mismatched_by_part, undefined)
})

test("a group's other upload does not stand in for its best release", () => {
  const web = [gb(0.7), gb(0.7)]
  const bluRay = [gb(3), gb(3.1)]
  const candidates = [
    candidate('Group', bluRay),
    candidate('Group', web, { is_best: false, info_hashes: [hash('b')], quality: '1080p Web-DL' }),
  ]
  const result = assess(localSeason('Group', web), candidates)
  assert.equal(result.status, 'upgrade', 'Owning the WEB release is not owning the listed Blu-ray release')
  assert.equal(result.mismatched_by_part, undefined, 'The WEB release is listed, so the files do not differ from it')
  const [bluRayRelease, webRelease] = result.releases
  assert.equal(releaseOwned(result, bluRayRelease), false)
  assert.equal(releaseOwned(result, webRelease), true)
  assert.equal(webRelease.files_match, true)
  assert.deepEqual(
    wantedParts(result).map(part => part.options.map(option => option.release.info_hashes)),
    [[[hash('a')]]],
    'The Blu-ray release is still offered',
  )
})

test('a movie lists every release of a group, and the one the library holds is matched', () => {
  // SeaDex lists two BlackRose encodes of one movie: the library holds the smaller, alternative one.
  const movieFile = (name: string, length: number) => ({ name, length })
  const megaMTBB = candidate('MegaMTBB', [], {
    info_hashes: [hash('a')],
    size: 14_373_209_872,
    source_files: [movieFile('[MegaMTBB] Movie (2016) (BD 1080p).mkv', 14_373_209_872)],
  })
  const large = candidate('BlackRose', [], {
    info_hashes: [hash('b')],
    size: 13_456_862_370,
    dual_audio: true,
    source_files: [movieFile('Movie.2016.1080p.BluRay.Dual-Audio.x265-BlackRose.mkv', 13_456_862_370)],
  })
  const small = candidate('BlackRose', [], {
    info_hashes: [hash('c')],
    size: 7_222_972_083,
    dual_audio: true,
    is_best: false,
    source_files: [movieFile('Movie.2016.1080p.BluRay.Dual-Audio.x265-BlackRose.mkv', 7_222_972_083)],
  })
  const local: LocalSeason = {
    groups: ['BlackRose'],
    size: 7_222_972_083,
    files: [{ size: 7_222_972_083, episodes: [], group: 'BlackRose' }],
  }
  const assessMovie = (accept_alternatives: boolean) =>
    assessSeason({
      item: { arr: 'Radarr', id: 7, title: 'Movie', seasons: { 0: local } },
      season: 0,
      local,
      chain: [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 1 }] }],
      best: catalog({ 42: [megaMTBB, large, small] }, 0),
      libraryKey: 'Radarr:item7',
      arrUrl: null,
      settings: {
        preferences: { ...DEFAULT_RELEASE_PREFERENCES, accept_alternatives },
        verify: true,
        trackers: 'public',
      },
    })

  const result = assessMovie(false)
  assert.deepEqual(
    result.releases.map(release => [release.kind, release.releaseGroup, release.size, release.files_match === true]),
    [
      ['best', 'MegaMTBB', 14_373_209_872, false],
      ['best', 'BlackRose', 13_456_862_370, false],
      ['alt', 'BlackRose', 7_222_972_083, true],
    ],
  )
  assert.equal(result.status, 'upgrade', 'The alternative release does not settle the movie by default')
  assert.equal(result.mismatched_by_part, undefined)
  assert.equal(result.verified_by_part, undefined)
  assert.deepEqual(
    result.releases.map(release => releaseOwned(result, release)),
    [false, false, true],
  )
  assert.deepEqual(
    wantedParts(result).map(part => part.options.map(option => option.release.size)),
    [[14_373_209_872, 13_456_862_370]],
  )
  const [saved] = normalizeResults(JSON.parse(JSON.stringify([result])))
  assert.equal(saved.releases.length, 3, 'Reloading keeps both BlackRose releases')
  assert.equal(saved.releases[2].files_match, true)

  const accepting = assessMovie(true)
  assert.equal(accepting.status, 'best', 'Accepting alternatives lets the held release settle the movie')
  assert.deepEqual(wantedParts(accepting), [])
})

test("a group's copies of one release on two trackers are listed once", () => {
  const sizes = [gb(1.5), gb(1.6)]
  const privateCopy = candidate('Group', sizes, { tracker: 'AB', info_hashes: ['<redacted>'] })
  const publicCopy = candidate('Group', sizes, { info_hashes: [hash('b')] })
  const result = assess(localSeason('Group', sizes), [privateCopy, publicCopy])
  assert.deepEqual(
    result.releases.map(release => release.tracker),
    ['Nyaa'],
  )
  assert.equal(result.status, 'best')
})

test('a season of a public batch and its private season copy are listed once', () => {
  const sizes = [gb(1.5), gb(1.6)]
  const privateCopy = candidate('Group', sizes, { tracker: 'AB', info_hashes: ['<redacted>'] })
  // The public upload is a whole-series batch; only this season's files are selected from it.
  const batch = candidate('Group', sizes, { info_hashes: [hash('b')], is_best: false })
  batch.source_files!.push({ name: episodeName(1, 2), length: gb(1.7) }, { name: episodeName(2, 2), length: gb(1.8) })
  batch.size += gb(3.5)
  const result = assess(localSeason('Group', sizes), [privateCopy, batch])
  assert.deepEqual(
    result.releases.map(release => [release.tracker, release.selected_files?.length]),
    [['Nyaa', 2]],
  )
  assert.equal(result.releases[0].files_match, true)
  const [saved] = normalizeResults(JSON.parse(JSON.stringify([result])))
  assert.equal(saved.releases.length, 1)
})

test('a private copy without the bonus episode of a public upload is listed once', () => {
  const sizes = [gb(2.8), gb(2.9)]
  const privateCopy = candidate('Group', sizes, { tracker: 'AB', info_hashes: ['<redacted>'] })
  const publicUpload = candidate('Group', sizes, { info_hashes: [hash('b')] })
  publicUpload.source_files!.push({ name: 'Show - OVA.mkv', length: gb(0.8) })
  publicUpload.size += gb(0.8)
  const result = assess(localSeason('Group', sizes), [privateCopy, publicUpload])
  assert.deepEqual(
    result.releases.map(release => release.tracker),
    ['Nyaa'],
  )
  assert.equal(result.releases[0].files_match, true)
  const [saved] = normalizeResults(JSON.parse(JSON.stringify([result])))
  assert.equal(saved.releases.length, 1)
})

test('extras and subtitles in a release never count as episode files', () => {
  const sizes = [gb(2), gb(2) + 1]
  const release = candidate('Best', sizes)
  release.source_files!.push(
    { name: 'Extras/NCOP.mkv', length: 90_000_000 },
    { name: 'Show - S01E01.ass', length: gb(2) + 2 },
  )
  assert.deepEqual(verifyPart(localSeason('Best', sizes), [1, 2], ['Best'], [release]), {
    verified: ['Best'],
    mismatched: [],
    other: [],
    matches: [release],
  })
  // A subtitle file with a coincidentally equal size is not evidence for a video file.
  assert.deepEqual(verifyPart(localSeason('Best', [gb(2), gb(2) + 2]), [1, 2], ['Best'], [release]), {
    verified: [],
    mismatched: ['Best'],
    other: [],
    matches: [],
  })
})

test('each cour is verified against its own episodes', () => {
  const first = [gb(1), gb(1.1)]
  const second = [gb(1.2), gb(1.3)]
  const local = localSeason('Best', [...first, gb(1.2), gb(9)])
  const item: LocalItem = { arr: 'Sonarr', id: 1, title: 'Show', seasons: { 1: local } }
  const cour = (sizes: number[], letter: string) => candidate('Best', sizes, { info_hashes: [hash(letter)] })
  const result = assessSeason({
    item: item,
    season: 1,
    local: local,
    chain: chain([2, 2]),
    best: catalog({ 42: [cour(first, 'a')], 43: [cour(second, 'b')] }),
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: settings(true),
  })
  assert.deepEqual(result.verified_by_part, { 'Cour 1': ['Best'] })
  assert.deepEqual(result.mismatched_by_part, { 'Cour 2': ['Best'] })
  assert.equal(result.status, 'upgrade')
  assert.deepEqual(
    wantedParts(result).map(part => part.part),
    ['Cour 2'],
  )
})

test('a movie is verified by the size of its single file', () => {
  const movie = (size: number): LocalSeason => ({
    groups: ['Best'],
    size,
    files: [{ size, episodes: [], group: 'Best' }],
  })
  const release = candidate('Best', [gb(20)], { source_files: [{ name: 'Movie (2020).mkv', length: gb(20) }] })
  const assessMovie = (local: LocalSeason) =>
    assessSeason({
      item: { arr: 'Radarr', id: 7, title: 'Movie', seasons: { 0: local } },
      season: 0,
      local: local,
      chain: [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 1 }] }],
      best: catalog({ 42: [release] }, 0),
      libraryKey: 'Radarr:item7',
      arrUrl: null,
      settings: settings(true),
    })
  assert.equal(assessMovie(movie(gb(20))).status, 'best')
  const different = assessMovie(movie(gb(8)))
  assert.equal(different.status, 'upgrade')
  assert.deepEqual(different.mismatched_by_part, { '': ['Best'] })
})

test('verification survives saving and reloading results', () => {
  const sizes = [gb(1), gb(1) + 5]
  const verified = assess(localSeason('Best', sizes), [candidate('Best', sizes)])
  const mismatched = assess(localSeason('Best', [gb(1), gb(1) + 9]), [candidate('Best', sizes)])
  const [savedVerified, savedMismatched] = normalizeResults(JSON.parse(JSON.stringify([verified, mismatched])))
  assert.deepEqual(savedVerified.verified_by_part, { '': ['Best'] })
  assert.deepEqual(savedMismatched.mismatched_by_part, { '': ['Best'] })
  assert.equal(releaseOwned(savedMismatched, savedMismatched.releases[0]), false)
  assert.deepEqual(
    normalizeResults([savedVerified, savedMismatched]),
    [savedVerified, savedMismatched],
    'Normalization stays idempotent',
  )
})

test('ownership rules: a size match proves, a mismatch disproves, otherwise the name decides', () => {
  const release = { part: '', releaseGroup: 'Group' }
  assert.equal(releaseOwned({ have: [], verified_by_part: { '': ['group'] } }, release), true)
  assert.equal(releaseOwned({ have: ['Group'], mismatched_by_part: { '': ['GROUP'] } }, release), false)
  assert.equal(releaseOwned({ have: ['Group'] }, release), true)
  assert.equal(
    releaseOwned(
      { precise_part_ownership: true, owned_by_part: { 'Cour 1': ['Group'] }, have: ['Group'] },
      { part: 'Cour 2', releaseGroup: 'Group' },
    ),
    false,
  )
})
