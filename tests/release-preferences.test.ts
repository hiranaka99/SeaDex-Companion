import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { assessSeason } from '../server/assessment.js'
import { exclusionReason, pickBest } from '../server/matching.js'
import { downloadClients } from '../server/download-clients.js'
import { buildDownloadPlan } from '../server/download-preflight.js'
import { applyConfigUpdate, DEFAULT_CONFIG, publicConfig } from '../server/config.js'
import { RELEASE_CHANGES_FILE, RESULTS_FILE } from '../server/paths.js'
import { privateSearchSettings, type ProwlarrIndexer } from '../server/prowlarr.js'
import { normalizeResults } from '../server/result-model.js'
import { saveLastResults } from '../server/results.js'
import { assessmentSignature, createScanService } from '../server/scan.js'
import { getState } from '../server/scan-state.js'
import { releaseOffered, releaseOwned, releaseSatisfies, wantedParts } from '../shared/download-plan.js'
import { releaseIdentity } from '../shared/releases.js'
import {
  DEFAULT_RELEASE_PREFERENCES,
  PREFERENCE_BLOCKED_REASON,
  PRIVATE_ONLY_REASON,
  normalizeReleasePreferences,
  normalizeTrackerMode,
  preferencesAreDefault,
  unreachableTrackerReason,
} from '../shared/settings.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { prowlarrReady } from '../frontend/src/download-routes.js'
import type { TrackerMode } from '../shared/contracts.js'
import type {
  ChainEntry,
  Config,
  LocalItem,
  LocalSeason,
  ReleaseCandidate,
  ReleasePreferences,
  ScanScope,
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
  coveredTrackers?: string[],
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
      ...(coveredTrackers ? { coveredTrackers } : {}),
    },
  })
}
const targetOf = (result: ReturnType<typeof assess>) => result.releases.find(release => release.target)?.releaseGroup

/** A release on a private tracker: SeaDex lists its files but withholds the torrent hash. */
function privateCandidate(
  group: string,
  episodeGb: number,
  tracker = 'AB',
  extra: Partial<ReleaseCandidate> = {},
): ReleaseCandidate {
  const release = candidate(group, episodeGb, { tracker, info_hashes: ['<redacted>'], ...extra })
  return { ...release, private_sources: [{ id: `files:${'a'.repeat(40)}`, files: release.source_files! }] }
}
const publicAlternatives = () => [candidate('Mini', 1, { is_best: false }), candidate('Bigger', 3, { is_best: false })]
/** The note a release carries when reachable-tracker mode passes it over. */
const UNREACHABLE_AB = 'On AB, which Prowlarr cannot reach'
/** What reachable-tracker mode decides and says about each listed release. */
const marked = (result: ReturnType<typeof assess>, part?: string) =>
  result.releases
    .filter(release => part === undefined || release.part === part)
    .map(release => [release.kind, release.releaseGroup, release.target === true, release.excluded_by])

/** A season SeaDex lists as two cours, each with its own releases. `owned` maps release groups to episodes. */
function assessCours(
  cours: [ReleaseCandidate[], ReleaseCandidate[]],
  trackers: TrackerMode,
  coveredTrackers?: string[],
  owned?: Record<string, number[]>,
) {
  const episodes = Array.from({ length: 24 }, (_, index) => index + 1)
  const groups = owned || { Old: episodes }
  const local: LocalSeason = {
    groups: Object.keys(groups),
    size: 24 * GB,
    episode_numbers: episodes,
    episode_count: 24,
    missing_episode_count: 0,
    groups_by_episode: groups,
    sizes_by_episode: {},
  }
  return assessSeason({
    item: { arr: 'Sonarr', id: 1, title: 'Show', seasons: { 1: local } },
    season: 1,
    local,
    chain: [
      {
        season: 1,
        id: 42,
        ids: [42, 43],
        parts: [
          { id: 42, episodeCount: 12 },
          { id: 43, episodeCount: 12 },
        ],
        episodeCount: 24,
      },
    ],
    best: new Map<number, SeaDexEntry>(
      cours.map((candidates, index) => [
        42 + index,
        { url: `https://seadex.moe/${42 + index}/`, notes: '', seasons: { 1: { candidates } } },
      ]),
    ),
    libraryKey: 'Sonarr:item1',
    arrUrl: null,
    settings: { preferences: prefs(), verify: true, trackers, ...(coveredTrackers ? { coveredTrackers } : {}) },
  })
}

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
    wantedParts(result).map(part => part.options.map(option => option.release.releaseGroup)),
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
    wantedParts({ ...result, status: 'upgrade' }),
    [],
    'Even a forced upgrade status offers no excluded release',
  )
  // The same library already holding one of them is simply on its best release.
  const owned = assess([remux, privateBest], prefs({ max_episode_gb: 2 }), ['Remux'], 'private')
  assert.equal(owned.status, 'best')
  assert.equal(owned.preference_blocked, undefined)
})

test('including private trackers is the default, and the two other modes are saved when chosen', () => {
  assert.equal(DEFAULT_CONFIG.tracker_mode, 'private')
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: 'public' }).tracker_mode, 'public')
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: 'reachable' }).tracker_mode, 'reachable')
  assert.equal(applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: null }).tracker_mode, 'private')
  assert.throws(
    () => applyConfigUpdate(DEFAULT_CONFIG, { tracker_mode: 'all' }),
    /tracker_mode must be public, private or reachable/,
  )
})

test('a tracker mode is one of three values, and nothing else is accepted', () => {
  for (const mode of ['public', 'private', 'reachable'] as const) assert.equal(normalizeTrackerMode(mode), mode)
  for (const empty of [undefined, null, '']) assert.equal(normalizeTrackerMode(empty), 'private')
  for (const invalid of ['Reachable', 'all', 'prowlarr', 1, true, ['private'], {}])
    assert.throws(() => normalizeTrackerMode(invalid), /tracker_mode must be public, private or reachable/)
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

test("reachable-tracker mode targets the public release when Prowlarr has no indexer for the best release's tracker", () => {
  const vault = privateCandidate('Vault', 7)
  const listing = [vault, ...publicAlternatives()]
  assert.equal(targetOf(assess(listing, prefs(), undefined, 'private')), 'Vault')
  const result = assess(listing, prefs(), undefined, 'reachable', [])
  assert.equal(result.status, 'upgrade')
  assert.equal(result.best_group, 'Bigger')
  assert.equal(result.best_size, 3 * 12 * GB)
  assert.deepEqual(
    marked(result),
    [
      ['alt', 'Bigger', true, undefined],
      ['best', 'Vault', false, UNREACHABLE_AB],
      ['alt', 'Mini', false, undefined],
    ],
    'Every release keeps the kind SeaDex gives it, and the passed-over best release says why',
  )
  const [target, unreachable] = result.releases
  assert.equal(unreachable.excluded_by, unreachableTrackerReason('AB'))
  assert.equal(unreachable.torrent_available, false)
  assert.deepEqual(
    unreachable.private_sources,
    vault.private_sources,
    'Its files stay known, so a Usenet copy can still be searched from its details',
  )
  assert.equal(releaseOffered(unreachable), false)
  assert.deepEqual(
    wantedParts(result).map(part => part.options.map(option => option.release.releaseGroup)),
    [['Bigger']],
  )
  // The season is judged against the public pick: owning it is owning the best release.
  assert.equal(releaseSatisfies(target), true)
  assert.equal(assess(listing, prefs(), ['Bigger'], 'reachable', []).status, 'best')
  assert.equal(assess(listing, prefs(), ['Mini'], 'reachable', []).status, 'upgrade')

  // A best-flagged public release is taken before any alternative.
  const flagged = [privateCandidate('Vault', 7, 'AB', { dual_audio: true }), remux, ...publicAlternatives()]
  const preferDual = prefs({ dual_audio: true })
  assert.equal(targetOf(assess(flagged, preferDual, undefined, 'private')), 'Vault')
  assert.deepEqual(marked(assess(flagged, preferDual, undefined, 'reachable', [])), [
    ['best', 'Remux', true, undefined],
    ['best', 'Vault', false, UNREACHABLE_AB],
    ['alt', 'Mini', false, undefined],
    ['alt', 'Bigger', false, undefined],
  ])
})

test('reachable-tracker mode judges exactly like private-tracker mode where Prowlarr covers the tracker', () => {
  const vault = privateCandidate('Vault', 7)
  const listings = [[vault, ...publicAlternatives()], [vault], [vault, remux, encode], [remux, encode, dualAlt]]
  const libraries: [ReleasePreferences, string[] | undefined][] = [
    [prefs(), undefined],
    [prefs(), ['Vault']],
    [prefs({ size: 'smallest', strict: true }), ['Vault']],
    [prefs({ accept_alternatives: true, dual_audio: true }), ['Mini']],
    [prefs({ ignored_trackers: ['AB'] }), undefined],
  ]
  for (const listing of listings)
    for (const [preferences, groups] of libraries)
      assert.deepEqual(
        assess(listing, preferences, groups, 'reachable', ['ab']),
        assess(listing, preferences, groups, 'private'),
      )
  assert.deepEqual(
    assess(listings[0], prefs(), undefined, 'reachable', [' AB ']),
    assess(listings[0], prefs(), undefined, 'private'),
    'Tracker names are compared without regard to case or surrounding spaces',
  )
})

test('a season with nothing else to download keeps its private target in reachable-tracker mode', () => {
  const vault = privateCandidate('Vault', 7)
  const result = assess([vault], prefs(), undefined, 'reachable', [])
  assert.equal(result.status, 'upgrade')
  assert.deepEqual(marked(result), [['best', 'Vault', true, undefined]])
  const mini = candidate('Mini', 1, { is_best: false })
  const unchanged: [ReleaseCandidate[], ReleasePreferences][] = [
    [[vault], prefs()],
    // Another release Prowlarr cannot reach is no better target.
    [[vault, privateCandidate('Crypt', 5, 'BeyondHD')], prefs()],
    // Nor is a public release the preferences exclude.
    [[vault, mini], prefs({ ignored_groups: ['Mini'] })],
    // Preferences that exclude every release leave nothing to target in either mode.
    [[vault, mini], prefs({ max_episode_gb: 0.5 })],
  ]
  for (const [listing, preferences] of unchanged)
    assert.deepEqual(
      assess(listing, preferences, undefined, 'reachable', []),
      assess(listing, preferences, undefined, 'private'),
    )
})

test('a release on a tracker Prowlarr covers is targeted before a public alternative', () => {
  const vault = privateCandidate('Vault', 7)
  const mini = candidate('Mini', 1, { is_best: false })
  const result = assess([vault, privateCandidate('Crypt', 5, 'BeyondHD'), mini], prefs(), undefined, 'reachable', [
    'beyondhd',
  ])
  assert.deepEqual(marked(result), [
    ['best', 'Crypt', true, undefined],
    ['best', 'Vault', false, UNREACHABLE_AB],
    ['alt', 'Mini', false, undefined],
  ])
  assert.equal(result.best_group, 'Crypt')
  // The same release on a covered tracker is the listing that stays, so there is nothing to explain.
  const mirrored = assess([vault, { ...vault, tracker: 'BeyondHD' }, mini], prefs(), undefined, 'reachable', [
    'beyondhd',
  ])
  assert.deepEqual(
    mirrored.releases.map(release => [release.releaseGroup, release.tracker, release.target === true]),
    [
      ['Vault', 'BeyondHD', true],
      ['Mini', 'Nyaa', false],
    ],
  )
  assert.ok(mirrored.releases.every(release => release.excluded_by === undefined))
})

test('a season with two cours changes only the cour whose target Prowlarr cannot reach', () => {
  const first = [privateCandidate('Vault', 7), candidate('Mini', 1, { is_best: false })]
  const second = [privateCandidate('Crypt', 5, 'BeyondHD'), candidate('Small', 1, { is_best: false })]
  const listed = assessCours([first, second], 'private')
  const result = assessCours([first, second], 'reachable', ['beyondhd'])
  assert.equal(listed.best_group, 'Vault + Crypt')
  assert.equal(result.best_group, 'Mini + Crypt')
  assert.equal(result.status, 'upgrade')
  assert.deepEqual(marked(result, 'Cour 1'), [
    ['alt', 'Mini', true, undefined],
    ['best', 'Vault', false, UNREACHABLE_AB],
  ])
  assert.deepEqual(
    result.releases.filter(release => release.part === 'Cour 2'),
    listed.releases.filter(release => release.part === 'Cour 2'),
    'The cour on a covered tracker reads as it does in private-tracker mode',
  )
  assert.deepEqual(
    wantedParts(result).map(part => [part.part, part.options.map(option => option.release.releaseGroup)]),
    [
      ['Cour 1', ['Mini']],
      ['Cour 2', ['Crypt']],
    ],
  )
  // Each cour is settled by its own target.
  const firstCour = Array.from({ length: 12 }, (_, index) => index + 1)
  const secondCour = firstCour.map(episode => episode + 12)
  const owning = (groups: Record<string, number[]>) =>
    assessCours([first, second], 'reachable', ['beyondhd'], groups).status
  assert.equal(owning({ Mini: firstCour, Crypt: secondCour }), 'best')
  assert.equal(owning({ Vault: firstCour, Crypt: secondCour }), 'best')
  assert.equal(owning({ Mini: firstCour, Small: secondCour }), 'upgrade')
  assert.equal(owning({ Old: firstCour, Crypt: secondCour }), 'upgrade')
})

test('an owned release on a tracker Prowlarr cannot reach still settles its season, unless only the target counts', () => {
  const listing = [privateCandidate('Vault', 7), ...publicAlternatives()]
  const relaxed = assess(listing, prefs(), ['Vault'], 'reachable', [])
  assert.equal(relaxed.status, 'best', 'As in private-tracker mode, and as an excluded best release does')
  assert.equal(targetOf(relaxed), 'Bigger', 'The owned release is still never the target')
  const owned = relaxed.releases.find(release => release.releaseGroup === 'Vault')!
  assert.deepEqual([owned.kind, owned.satisfies, owned.excluded_by], ['best', undefined, UNREACHABLE_AB])
  assert.equal(releaseOwned(relaxed, owned) && releaseSatisfies(owned), true)
  assert.deepEqual(wantedParts(relaxed), [])

  const strict = assess(listing, prefs({ strict: true }), ['Vault'], 'reachable', [])
  assert.equal(strict.status, 'upgrade')
  assert.equal(strict.best_group, 'Bigger')
  assert.equal(strict.releases.find(release => release.releaseGroup === 'Vault')?.satisfies, false)
  assert.deepEqual(
    wantedParts(strict).map(part => part.options.map(option => option.release.releaseGroup)),
    [['Bigger']],
  )
  assert.equal(assess(listing, prefs({ strict: true }), ['Bigger'], 'reachable', []).status, 'best')
})

test('the reachable-tracker note is saved once with its release, and private-tracker results reload as before', () => {
  const listing = [privateCandidate('Vault', 7), ...publicAlternatives()]
  const reload = (result: ReturnType<typeof assess>) => normalizeResults(JSON.parse(JSON.stringify([result])))[0]
  const result = assess(listing, prefs(), undefined, 'reachable', [])
  const saved = reload(result)
  assert.deepEqual(marked(saved), marked(result))
  assert.deepEqual(
    saved.releases.map(release => [release.satisfies, release.private_sources]),
    result.releases.map(release => [release.satisfies, release.private_sources]),
  )
  assert.equal(JSON.stringify(saved).split(UNREACHABLE_AB).length - 1, 1, 'No second field repeats the note')
  assert.deepEqual(reload(saved), saved)

  const listed = reload(assess(listing, prefs(), undefined, 'private'))
  assert.deepEqual(reload(assess(listing, prefs(), undefined, 'reachable', ['ab'])), listed)
  assert.deepEqual(marked(listed), [
    ['best', 'Vault', true, undefined],
    ['alt', 'Mini', false, undefined],
    ['alt', 'Bigger', false, undefined],
  ])
  assert.ok(listed.releases.every(release => release.satisfies === undefined))
})

test('bulk review refuses a release Prowlarr cannot reach and says why, while a single download stays possible', async () => {
  const result = assess([privateCandidate('Vault', 7), ...publicAlternatives()], prefs(), undefined, 'reachable', [])
  const index = result.releases.findIndex(release => release.releaseGroup === 'Vault')
  const config: Config = { ...DEFAULT_CONFIG, qbittorrent_url: '', tracker_mode: 'reachable' }
  const pick = (key: string) => ({ key, release: index, identity: releaseIdentity(result.releases[index]) })
  const bulk = await buildDownloadPlan(config, [pick('row'), pick('other')], {
    results: [
      { ...result, key: 'row' },
      { ...result, key: 'other' },
    ],
    clients: downloadClients(config),
  })
  assert.ok('review' in bulk)
  assert.deepEqual(
    bulk.review.blocked.map(row => [row.key, row.code, row.reason]),
    [
      ['row', 'invalid', `Your release preferences exclude this release. (${UNREACHABLE_AB})`],
      ['other', 'invalid', `Your release preferences exclude this release. (${UNREACHABLE_AB})`],
    ],
  )
  const single = await buildDownloadPlan(config, [pick('row')], {
    results: [{ ...result, key: 'row' }],
    clients: downloadClients(config),
  })
  assert.ok('review' in single)
  assert.equal(
    single.review.blocked.some(row => row.code === 'invalid'),
    false,
    "An explicit single download is the person's own choice",
  )
})

test('reachable-tracker mode lets Prowlarr look for private-tracker releases, as private-tracker mode does', () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    prowlarr_enabled: true,
    prowlarr_url: 'http://prowlarr.test',
    prowlarr_key: 'key',
  }
  for (const tracker_mode of ['private', 'reachable'] as const) {
    assert.deepEqual(privateSearchSettings({ ...config, tracker_mode }), {
      baseUrl: 'http://prowlarr.test',
      apiKey: 'key',
    })
    assert.equal(prowlarrReady(publicConfig({ ...config, tracker_mode })), true)
  }
  assert.equal(privateSearchSettings({ ...config, tracker_mode: 'public' }), null)
  assert.equal(prowlarrReady(publicConfig({ ...config, tracker_mode: 'public' })), false)
})

test('private and public tracker modes sign their results as before, and reachable-tracker mode adds what Prowlarr covers', () => {
  const settings = { release_preferences: DEFAULT_RELEASE_PREFERENCES, verify_release_files: true }
  // The strings results were saved with before reachable-tracker mode existed. A different string would turn
  // everyone's next scan into a baseline.
  const preferences =
    '{"size":"largest","dual_audio":false,"max_episode_gb":0,"ignored_groups":[],"ignored_trackers":[],"accept_alternatives":false,"strict":false}'
  assert.equal(assessmentSignature(settings), `[${preferences},true]`)
  assert.equal(assessmentSignature({ ...settings, tracker_mode: 'private' }), `[${preferences},true]`)
  assert.equal(assessmentSignature({ ...settings, tracker_mode: 'public' }), `[${preferences},true,"public"]`)
  assert.equal(
    assessmentSignature({ ...settings, verify_release_files: false, tracker_mode: 'public' }, ['ab']),
    `[${preferences},false,"public"]`,
    'What Prowlarr covers is no part of the other modes',
  )
  assert.equal(assessmentSignature({ ...settings, tracker_mode: 'private' }, ['ab']), `[${preferences},true]`)

  const reachable = { ...settings, tracker_mode: 'reachable' as const }
  assert.equal(assessmentSignature(reachable), `[${preferences},true,"reachable",[]]`)
  assert.equal(
    assessmentSignature(reachable, ['BeyondHD', ' ab', 'AB']),
    `[${preferences},true,"reachable",["ab","beyondhd"]]`,
    'Covered trackers are sorted and named once, so their order never changes the signature',
  )
})

test('a change in the trackers Prowlarr covers makes the next scan a baseline, and an unreadable Prowlarr keeps the saved coverage', async () => {
  const files = [RESULTS_FILE, RELEASE_CHANGES_FILE].map(
    file => [file, existsSync(file) ? readFileSync(file) : null] as const,
  )
  const animeBytes: ProwlarrIndexer = {
    id: 1,
    name: 'AnimeBytes',
    protocol: 'torrent',
    privacy: 'private',
    aliases: ['animebytes'],
    tvSearchParams: [],
    movieSearchParams: [],
  }
  /** Prowlarr's indexers; null while Prowlarr does not answer. */
  let indexers: ProwlarrIndexer[] | null = [animeBytes]
  const reads: unknown[] = []
  const saves: { baseline: boolean | undefined; assessment: string | undefined }[] = []
  let baseline: boolean | undefined
  const local = season()
  const listing = [privateCandidate('Vault', 7), ...publicAlternatives()]
  const service = createScanService({
    seadexBest: async () =>
      new Map([[42, { url: 'https://seadex.moe/42/', notes: '', seasons: { 1: { candidates: listing } } }]]),
    localItems: async () => [{ arr: 'Sonarr', id: 1, title: 'Show', seasons: { 1: local } }],
    anilistChain: async () => chain,
    loadCache: () => ({}),
    loadUserRules: () => ({ mappings: {}, exclusions: [] }),
    autoNotifyNew: async () => 0,
    onScanFinished: () => {},
    recordScanHistory: () => ({}) as never,
    prowlarrIndexers: async (_settings, _fetch, fresh) => {
      reads.push(fresh)
      if (!indexers) throw new Error('Prowlarr is not answering')
      return indexers
    },
    recordReleaseChanges: comparison => {
      // A baseline because the settings changed; a first scan is one anyway.
      baseline = comparison.baseline && !comparison.firstScan
    },
    saveLastResults: (results, lastRun, options) => {
      saves.push({ baseline, assessment: options?.settings?.assessment })
      saveLastResults(results, lastRun, options)
    },
  })
  const config: Config = {
    ...DEFAULT_CONFIG,
    tracker_mode: 'reachable',
    prowlarr_enabled: true,
    prowlarr_url: 'http://prowlarr.test',
    prowlarr_key: 'key',
  }
  const scan = async (changes: Partial<Config> = {}, scope: ScanScope = {}) => {
    await service.run({ ...config, ...changes }, 'manual', scope)
    assert.equal(getState().error, null)
    return { ...saves.at(-1), target: getState().results[0].releases.find(release => release.target)?.releaseGroup }
  }
  const covered = assessmentSignature(config, ['ab'])
  const uncovered = assessmentSignature(config, [])
  try {
    resetRuntimeForTests()
    for (const [file] of files) rmSync(file, { force: true })
    assert.deepEqual(
      await scan(),
      { baseline: false, assessment: covered, target: 'Vault' },
      'A first scan has no earlier results to set apart',
    )
    assert.deepEqual(await scan(), { baseline: false, assessment: covered, target: 'Vault' })

    // The AnimeBytes indexer is removed from Prowlarr: the same catalog is now judged differently.
    indexers = []
    assert.deepEqual(await scan(), { baseline: true, assessment: uncovered, target: 'Bigger' })
    assert.deepEqual(await scan(), { baseline: false, assessment: uncovered, target: 'Bigger' })
    assert.deepEqual(reads, [true, true, true, true], 'Every scan of the library reads a fresh indexer list, once')
    // A scan of single titles accepts a recent list.
    assert.deepEqual(await scan({}, { sonarrIds: [1] }), { baseline: false, assessment: uncovered, target: 'Bigger' })
    assert.equal(reads.pop(), false)

    // An unreadable Prowlarr says nothing about coverage, so the scan judges as the saved results were judged.
    indexers = null
    assert.deepEqual(await scan(), { baseline: false, assessment: uncovered, target: 'Bigger' })
    indexers = [animeBytes]
    assert.deepEqual(await scan(), { baseline: true, assessment: covered, target: 'Vault' })
    indexers = null
    assert.deepEqual(await scan(), { baseline: false, assessment: covered, target: 'Vault' })
    assert.equal(reads.length, 7)

    // The other modes never ask Prowlarr, and a change of mode is a baseline as it always was.
    const listed = assessmentSignature({ ...config, tracker_mode: 'private' })
    assert.deepEqual(await scan({ tracker_mode: 'private' }), { baseline: true, assessment: listed, target: 'Vault' })
    assert.equal(reads.length, 7)
    // With no saved coverage to fall back on, or with Prowlarr turned off, no tracker counts as covered.
    assert.deepEqual(await scan(), { baseline: true, assessment: uncovered, target: 'Bigger' })
    assert.equal(reads.length, 8)
    assert.deepEqual(await scan({ prowlarr_enabled: false }), {
      baseline: false,
      assessment: uncovered,
      target: 'Bigger',
    })
    assert.equal(reads.length, 8)
  } finally {
    for (const [file, content] of files) {
      if (content) writeFileSync(file, content)
      else rmSync(file, { force: true })
    }
    resetRuntimeForTests()
  }
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
    wantedParts(strict).map(part => part.options.map(option => option.release.releaseGroup)),
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
    clients: downloadClients(config),
  })
  assert.ok('review' in bulk)
  assert.deepEqual(
    bulk.review.blocked.map(row => [row.key, row.code, row.reason]),
    [
      ['row', 'invalid', 'Your release preferences exclude this release. (Over 4 GB per episode)'],
      ['other', 'invalid', 'Your release preferences exclude this release. (Over 4 GB per episode)'],
    ],
  )
  const single = await buildDownloadPlan(config, [pick(remuxIndex)], {
    results: [result],
    clients: downloadClients(config),
  })
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
