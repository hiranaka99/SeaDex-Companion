import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessSeason } from '../server/assessment.js'
import { exclusionReason, pickBest } from '../server/matching.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { applyConfigUpdate, DEFAULT_CONFIG } from '../server/config.js'
import { normalizeResults } from '../server/result-model.js'
import { releaseOffered, releaseOwned, releaseSatisfies, upgradeParts } from '../shared/download-plan.js'
import { releaseIdentity } from '../shared/releases.js'
import {
  DEFAULT_RELEASE_PREFERENCES,
  PREFERENCE_BLOCKED_REASON,
  PRIVATE_ONLY_REASON,
  normalizeReleasePreferences,
  preferencesAreDefault,
} from '../shared/settings.js'
import type { TrackerMode } from '../shared/contracts.js'
import type {
  ChainEntry,
  LocalItem,
  LocalSeason,
  ReleaseCandidate,
  ReleasePreferences,
  SeaDexEntry,
} from '../server/types.js'

const GB = 1024 ** 3
let created = 0
/** Every candidate gets its own valid torrent hash. */
const nextHash = () => '0123456789abcdef'[created++ % 16].repeat(40)
const prefs = (changes: Partial<ReleasePreferences> = {}): ReleasePreferences => ({
  ...DEFAULT_RELEASE_PREFERENCES,
  ...changes,
})

/** A twelve-episode release whose episodes all have the given size. */
function candidate(group: string, episodeGb: number, extra: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  const length = Math.round(episodeGb * GB)
  return {
    releaseGroup: group,
    tracker: 'Nyaa',
    quality: '1080p Blu-ray',
    tags: [],
    size: length * 12,
    file_count: 12,
    info_hashes: [nextHash()],
    is_best: true,
    source_files: Array.from({ length: 12 }, (_, index) => ({
      name: `Show - S01E${String(index + 1).padStart(2, '0')}.mkv`,
      length,
    })),
    ...extra,
  }
}

const remux = candidate('Remux', 6)
const encode = candidate('Encode', 1.5)
const dualAlt = candidate('Dub', 2, { is_best: false, dual_audio: true })
const privateBest = candidate('Vault', 7, { tracker: 'AB', info_hashes: ['<redacted>'] })

function season(groups: string[] = ['Old']): LocalSeason {
  const episodes = Array.from({ length: 12 }, (_, index) => index + 1)
  return {
    groups,
    size: 12 * GB,
    episode_numbers: episodes,
    episode_count: 12,
    missing_episode_count: 0,
    groups_by_episode: Object.fromEntries(groups.map(group => [group, episodes])),
    sizes_by_episode: {},
  }
}

const chain: ChainEntry[] = [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 12 }], episodeCount: 12 }]
function assess(
  candidates: ReleaseCandidate[],
  preferences: ReleasePreferences,
  groups?: string[],
  trackers: TrackerMode = 'public',
) {
  const local = season(groups)
  const item: LocalItem = { arr: 'Sonarr', id: 1, title: 'Show', seasons: { 1: local } }
  const catalog = new Map<number, SeaDexEntry>([
    [42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 1: { candidates } } }],
  ])
  return assessSeason({
    item: item,
    season: 1,
    local: local,
    chain: chain,
    best: catalog,
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: {
      preferences,
      verify: true,
      trackers,
    },
  })
}
const targetOf = (result: ReturnType<typeof assess>) => result.releases.find(release => release.target)?.releaseGroup

test("the default preferences keep SeaDex's own pick: the largest best release", () => {
  assert.equal(pickBest([encode, remux], 12)[0], remux)
  assert.equal(pickBest([encode, remux], 12, prefs())[0], remux)
  const result = assess([encode, remux], prefs())
  assert.equal(result.best_group, 'Remux')
  assert.equal(targetOf(result), 'Remux')
  assert.deepEqual(
    result.releases.map(release => [release.kind, release.releaseGroup]),
    [
      ['best', 'Remux'],
      ['best', 'Encode'],
    ],
  )
  assert.ok(
    result.releases.every(release => release.satisfies === undefined && release.excluded_by === undefined),
    'Default results carry no preference markers',
  )
  assert.equal(preferencesAreDefault(prefs()), true)
})

test('the smallest release can be targeted instead, and an unknown size never wins', () => {
  const unknown = candidate('Unknown', 0)
  assert.equal(pickBest([remux, encode, unknown], 12, prefs({ size: 'smallest' }))[0], encode)
  const result = assess([remux, encode], prefs({ size: 'smallest' }))
  assert.equal(result.best_group, 'Encode')
  assert.equal(result.best_size, encode.size)
  assert.equal(result.releases[0].releaseGroup, 'Encode', 'The target leads the release list')
})

test('a dual-audio release becomes the target whenever one is listed', () => {
  const dualBest = candidate('DualBest', 3, { dual_audio: true })
  assert.equal(targetOf(assess([remux, dualBest], prefs({ dual_audio: true }))), 'DualBest')
  assert.equal(
    targetOf(assess([remux, encode], prefs({ dual_audio: true }))),
    'Remux',
    'Without a dual-audio release the preference changes nothing',
  )
  // An alternative is only reachable when alternatives are accepted.
  assert.equal(targetOf(assess([remux, dualAlt], prefs({ dual_audio: true }))), 'Remux')
  const withAlternative = assess([remux, dualAlt], prefs({ dual_audio: true, accept_alternatives: true }))
  assert.equal(targetOf(withAlternative), 'Dub')
  assert.equal(
    withAlternative.releases.find(release => release.releaseGroup === 'Dub')?.kind,
    'alt',
    "SeaDex's own label is kept",
  )
})

test('a size limit excludes larger releases from the target and from bulk download', () => {
  assert.equal(exclusionReason(remux, 12, prefs({ max_episode_gb: 4 })), 'Over 4 GB per episode')
  assert.equal(exclusionReason(encode, 12, prefs({ max_episode_gb: 4 })), undefined)
  const result = assess([remux, encode], prefs({ max_episode_gb: 4 }))
  assert.equal(result.status, 'upgrade')
  assert.equal(result.best_group, 'Encode')
  assert.equal(result.releases.find(release => release.releaseGroup === 'Remux')?.excluded_by, 'Over 4 GB per episode')
  assert.deepEqual(
    upgradeParts(result).map(part => part.options.map(option => option.release.releaseGroup)),
    [['Encode']],
  )
  // Owning the excluded release is still owning a best release.
  assert.equal(assess([remux, encode], prefs({ max_episode_gb: 4 }), ['Remux']).status, 'best')
})

test('the per-episode limit is measured on episodes, not on the batch a cour is cut from', () => {
  // A 24-episode batch that covers two cours: 1.5 GB per episode, 36 GB in total.
  const batch = candidate('Encode', 1.5, {
    file_count: 24,
    size: 36 * GB,
    source_files: Array.from({ length: 24 }, (_, index) => ({
      name: `Show - ${String(index + 1).padStart(2, '0')}.mkv`,
      length: 1.5 * GB,
    })),
  })
  assert.equal(exclusionReason(batch, 12, prefs({ max_episode_gb: 2 })), undefined)
})

test('movies are not held to a per-episode limit', () => {
  const movie = candidate('Film', 30, {
    file_count: 1,
    size: 30 * GB,
    source_files: [{ name: 'Movie (2020).mkv', length: 30 * GB }],
  })
  const local: LocalSeason = { groups: [], size: 0 }
  const result = assessSeason({
    item: { arr: 'Radarr', id: 5, title: 'Movie', seasons: { 0: local } },
    season: 0,
    local: local,
    chain: [{ season: 1, id: 42, ids: [42], parts: [{ id: 42, episodeCount: 1 }] }],
    best: new Map([[42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 0: { candidates: [movie] } } }]]),
    libraryKey: 'Radarr:item5',
    arrUrl: null,
    settings: { preferences: prefs({ max_episode_gb: 2 }), verify: true, trackers: 'public' },
  })
  assert.equal(result.status, 'upgrade')
  assert.equal(result.releases[0].excluded_by, undefined)
})

test('ignored groups and trackers are never targeted', () => {
  assert.equal(
    targetOf(assess([remux, encode], prefs({ ignored_groups: ['remux'] }))),
    'Encode',
    'Group names are matched without regard to case',
  )
  const result = assess([privateBest, encode], prefs({ ignored_trackers: ['ab'] }), undefined, 'private')
  assert.equal(targetOf(result), 'Encode')
  assert.equal(result.releases.find(release => release.releaseGroup === 'Vault')?.excluded_by, 'Ignored tracker')
})

test('when the preferences exclude every release the season offers nothing, but the releases stay visible', () => {
  const result = assess([remux, privateBest], prefs({ max_episode_gb: 2 }), undefined, 'private')
  assert.equal(result.status, 'uncovered')
  assert.equal(result.preference_blocked, true)
  assert.equal(result.best_group, null)
  assert.deepEqual(result.unavailable_parts, [{ label: 'S01', reason: PREFERENCE_BLOCKED_REASON }])
  assert.deepEqual(
    result.releases.map(release => release.excluded_by),
    ['Over 2 GB per episode', 'Over 2 GB per episode'],
  )
  assert.ok(result.releases.every(release => !release.target))
  assert.deepEqual(
    upgradeParts({ ...result, status: 'upgrade' }),
    [],
    'Even a forced upgrade status offers no excluded release',
  )
  // The same library already holding one of them is simply on its best release.
  const owned = assess([remux, privateBest], prefs({ max_episode_gb: 2 }), ['Remux'], 'private')
  assert.equal(owned.status, 'best')
  assert.equal(owned.preference_blocked, undefined)
})

test('including private trackers is the default and the only other mode is public trackers only', () => {
  assert.equal(DEFAULT_CONFIG.tracker_mode, 'private')
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: 'public' }).tracker_mode, 'public')
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: null }).tracker_mode, 'private')
  assert.throws(
    () => applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: 'all' }),
    /tracker_mode must be public or private/,
  )
})

test('public-tracker mode leaves out releases that have no public torrent', () => {
  const result = assess([privateBest, encode], prefs())
  assert.deepEqual(
    result.releases.map(release => release.releaseGroup),
    ['Encode'],
  )
  assert.equal(targetOf(result), 'Encode')
  assert.equal(result.private_only, undefined)
  const listed = assess([privateBest, encode], prefs(), undefined, 'private')
  assert.deepEqual(listed.releases.map(release => release.releaseGroup).sort(), ['Encode', 'Vault'])
  assert.equal(targetOf(listed), 'Encode', 'A release nobody can send is never the target while another can be')
})

test('public-tracker mode targets the best public release when SeaDex flags only a private one', () => {
  const publicAlts = [candidate('Mini', 1, { is_best: false }), candidate('Bigger', 3, { is_best: false })]
  const result = assess([privateBest, ...publicAlts], prefs())
  assert.equal(result.status, 'upgrade')
  assert.equal(targetOf(result), 'Bigger')
  assert.equal(result.releases.find(release => release.releaseGroup === 'Bigger')?.kind, 'best')
  assert.equal(assess([privateBest, ...publicAlts], prefs(), ['Bigger']).status, 'best')
})

test('a season SeaDex lists only on private trackers has no public release in public-tracker mode', () => {
  const result = assess([privateBest], prefs())
  assert.equal(result.status, 'uncovered')
  assert.equal(result.private_only, true)
  assert.equal(result.preference_blocked, undefined)
  assert.deepEqual(result.releases, [])
  assert.deepEqual(result.unavailable_parts, [{ label: 'S01', reason: PRIVATE_ONLY_REASON }])
  const listed = assess([privateBest], prefs(), undefined, 'private')
  assert.equal(listed.private_only, undefined)
  assert.deepEqual(
    listed.releases.map(release => release.releaseGroup),
    ['Vault'],
  )
})

test('public-tracker mode keeps a private release the library owns, marked but never targeted', () => {
  // SeaDex lists a private best, a public alternative, and a private alternative you already own.
  const vaultBest = candidate('Vault', 7, { tracker: 'AB', info_hashes: ['<redacted>'] })
  const raws = candidate('Raws', 1.4, { is_best: false })
  const ownedPrivate = candidate('-ZR-', 1.5, { is_best: false, tracker: 'AB', info_hashes: ['<redacted>'] })
  const result = assess([vaultBest, raws, ownedPrivate], prefs(), ['-ZR-'])
  assert.deepEqual(
    result.releases.map(release => [release.releaseGroup, release.torrent_available, release.target === true]),
    [
      ['Raws', true, true],
      ['-ZR-', false, false],
    ],
    'The unowned private best stays out; the owned private release is listed without a magnet',
  )
  assert.ok(releaseOwned(result, result.releases[1]))
  // Owning SeaDex's private best release still settles the season, though the public release stays the target.
  const ownsBest = assess([vaultBest, raws], prefs(), ['Vault'])
  assert.equal(ownsBest.status, 'best')
  assert.equal(targetOf(ownsBest), 'Raws')
  // With nothing public listed, the owned private release is what the season resolves to, still without a target.
  const onlyPrivate = assess([vaultBest], prefs(), ['Vault'])
  assert.equal(onlyPrivate.status, 'best')
  assert.equal(onlyPrivate.private_only, undefined)
  assert.equal(targetOf(onlyPrivate), undefined)
})

test('owning any best release settles a season unless only the target counts', () => {
  const relaxed = assess([remux, encode], prefs({ size: 'smallest' }), ['Remux'])
  assert.equal(relaxed.status, 'best', 'Preferences only choose what to download')
  const strict = assess([remux, encode], prefs({ size: 'smallest', strict: true }), ['Remux'])
  assert.equal(strict.status, 'upgrade')
  assert.equal(strict.best_group, 'Encode')
  const owned = strict.releases.find(release => release.releaseGroup === 'Remux')!
  assert.equal(owned.satisfies, false)
  assert.equal(releaseSatisfies(owned), false)
  assert.deepEqual(
    upgradeParts(strict).map(part => part.options.map(option => option.release.releaseGroup)),
    [['Encode']],
    'The owned release is not offered again',
  )
  assert.equal(assess([remux, encode], prefs({ size: 'smallest', strict: true }), ['Encode']).status, 'best')
})

test('an owned alternative counts as best only when alternatives are accepted', () => {
  const alternative = candidate('Alt', 1, { is_best: false })
  assert.equal(assess([remux, alternative], prefs(), ['Alt']).status, 'upgrade')
  const accepted = assess([remux, alternative], prefs({ accept_alternatives: true }), ['Alt'])
  assert.equal(accepted.status, 'best')
  const release = accepted.releases.find(item => item.releaseGroup === 'Alt')!
  assert.equal(release.kind, 'alt')
  assert.equal(release.satisfies, true)
  assert.equal(releaseOwned(accepted, release) && releaseSatisfies(release), true)
})

test('preference markers survive saving and reloading results', () => {
  const result = assess([remux, encode, dualAlt], prefs({ max_episode_gb: 4, accept_alternatives: true, strict: true }))
  const [saved] = normalizeResults(JSON.parse(JSON.stringify([result])))
  assert.deepEqual(
    saved.releases.map(release => [
      release.releaseGroup,
      release.target === true,
      release.satisfies,
      release.excluded_by,
    ]),
    result.releases.map(release => [
      release.releaseGroup,
      release.target === true,
      release.satisfies,
      release.excluded_by,
    ]),
  )
  assert.equal(saved.releases.filter(release => release.target).length, 1)
})

test('bulk review refuses a release the preferences exclude, while a single download stays possible', async () => {
  const result = { ...assess([remux, encode], prefs({ max_episode_gb: 4 })), key: 'row' }
  const remuxIndex = result.releases.findIndex(release => release.releaseGroup === 'Remux')
  const encodeIndex = result.releases.findIndex(release => release.releaseGroup === 'Encode')
  assert.equal(releaseOffered(result.releases[remuxIndex]), false)
  const config = { ...DEFAULT_CONFIG, qbittorrent_url: '' }
  const pick = (index: number) => ({ key: 'row', release: index, identity: releaseIdentity(result.releases[index]) })
  const other = { ...result, key: 'other' }
  assert.equal(releaseOffered(result.releases[encodeIndex]), true)
  const bulk = await buildDownloadPlan(config, [pick(remuxIndex), { ...pick(remuxIndex), key: 'other' }], {
    results: [result, other],
  })
  assert.ok('review' in bulk)
  assert.deepEqual(
    bulk.review.blocked.map(row => [row.key, row.code, row.reason]),
    [
      ['row', 'invalid', 'Your release preferences exclude this release. (Over 4 GB per episode)'],
      ['other', 'invalid', 'Your release preferences exclude this release. (Over 4 GB per episode)'],
    ],
  )
  const single = await buildDownloadPlan(config, [pick(remuxIndex)], { results: [result] })
  assert.ok('review' in single)
  assert.equal(
    single.review.blocked.some(row => row.code === 'invalid'),
    false,
    "An explicit single download is the person's own choice",
  )
})

test('preferences are validated and normalized', () => {
  assert.deepEqual(normalizeReleasePreferences(null), DEFAULT_RELEASE_PREFERENCES)
  assert.deepEqual(
    normalizeReleasePreferences({
      size: 'smallest',
      max_episode_gb: '2.456',
      ignored_groups: ' A, a ,B\nC ',
      ignored_trackers: ['AB', 'ab', ''],
    }),
    {
      ...DEFAULT_RELEASE_PREFERENCES,
      size: 'smallest',
      max_episode_gb: 2.46,
      ignored_groups: ['A', 'B', 'C'],
      ignored_trackers: ['AB'],
    },
  )
  assert.throws(() => normalizeReleasePreferences({ size: 'medium' }), /largest or smallest/)
  assert.throws(() => normalizeReleasePreferences({ max_episode_gb: -1 }), /between 0 and 1000/)
  assert.throws(() => normalizeReleasePreferences({ strict: 'yes' }), /must be a boolean/)
  assert.throws(() => normalizeReleasePreferences({ ignored_groups: [1] }), /only text values/)
  assert.equal(preferencesAreDefault(prefs({ dual_audio: true })), false)
})
