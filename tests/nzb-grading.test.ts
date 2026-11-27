// Proof levels of a fetched NZB: the segment bytes of every file, and the grade they give against the files a
// release lists. The NZBs are built here; three large segments per file stand for the thousands of a real post.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  gradeNzb,
  NEAR_EXACT_RATIO,
  nzbFileMatches,
  nzbFiles,
  nzbHasFiles,
  PROBABLE_MIN_FILES,
  SIZE_ONLY_RATIO,
  SPREAD_MIN_BYTES,
  type NzbFile,
  type NzbGrade,
  type SourceFile,
} from '../server/source-files.js'

/** The overhead measured on AnimeTosho's own posts. */
const OVERHEAD = 1.031

interface Posted {
  subject: string
  segments: number[]
}

function nzb(files: Posted[]): Uint8Array {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const body = files
    .map((file, index) => {
      const segments = file.segments
        .map((bytes, part) => `<segment bytes="${bytes}" number="${part + 1}">${index}.${part}@test</segment>`)
        .join('')
      return `<file poster="p@test" date="1700000000" subject="${escape(file.subject)}"><groups><group>alt.binaries.test</group></groups><segments>${segments}</segments></file>`
    })
    .join('')
  return new TextEncoder().encode(`<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">${body}</nzb>`)
}

/** Three segments that add up to what a file of this size takes on Usenet at the given ratio. */
function segments(length: number, ratio = OVERHEAD): number[] {
  const total = Math.round(length * ratio)
  const part = Math.floor(total / 3)
  return [part, part, total - 2 * part]
}

/** Nyuu and ngPost style: the name and the decoded size. */
const stated = (file: SourceFile, ratio = OVERHEAD): Posted => ({
  subject: `"${file.name.split('/').pop()}" yEnc (1/3) ${file.length}`,
  segments: segments(file.length, ratio),
})
/** The name without a trailing size. */
const named = (file: SourceFile, ratio = OVERHEAD): Posted => ({
  subject: `"${file.name.split('/').pop()}" yEnc (1/3)`,
  segments: segments(file.length, ratio),
})
/** Obfuscated: by turns a subject that does not parse and one that parses to a random name. */
function obfuscated(file: SourceFile, index: number, ratio = OVERHEAD): Posted {
  const random = ((index + 1) * 0x9e3779b1).toString(16).padStart(12, '0').slice(-12)
  return { subject: index % 2 ? `"${random}" yEnc (1/3)` : random, segments: segments(file.length, ratio) }
}

/** Grades a post, and checks that the grade carries the counts `nzbFileMatches` gives for it. */
function grade(posted: Posted[], expected: SourceFile[]): NzbGrade {
  const files = nzbFiles(nzb(posted))
  const result = gradeNzb(files, expected)
  assert.deepEqual(
    {
      files_matched: result.files_matched,
      names_matched: result.names_matched,
      files_expected: result.files_expected,
      sizes_known: result.sizes_known,
    },
    nzbFileMatches(files, expected),
  )
  return result
}

/** The reported ratio, to a tolerance far below every threshold. */
function assertRatio(actual: [number, number] | undefined, low: number, high = low): void {
  assert.ok(actual, 'a ratio was measured')
  assert.ok(
    Math.abs(actual[0] - low) < 1e-4 && Math.abs(actual[1] - high) < 1e-4,
    `${actual.join(',')} is not ${low} to ${high}`,
  )
}

const total = (files: SourceFile[]) => files.reduce((sum, file) => sum + file.length, 0)

const EPISODES: SourceFile[] = [
  { name: '[Group] Show - 01 [1080p].mkv', length: 1_512_345_678 },
  { name: '[Group] Show - 02 [1080p].mkv', length: 1_398_765_432 },
  { name: '[Group] Show - 03 [1080p].mkv', length: 1_287_654_321 },
]
/** Listed with the release without being a video: it counts towards the total only. */
const NOTES: SourceFile = { name: '[Group] Show - Notes.txt', length: 12_345 }
const RELEASE = [...EPISODES, NOTES]
const SEASON: SourceFile[] = Array.from({ length: 12 }, (_, index) => ({
  name: `[Group] Long Show - ${String(index + 1).padStart(2, '0')} [1080p].mkv`,
  length: 1_450_000_000 - index * 41_234_567,
}))
const PAR2: Posted = {
  subject: '"[Group] Show.vol00+64.par2" yEnc (1/3) 209715200',
  segments: segments(209_715_200),
}

test('nzbFiles sums the segment bytes of every file, and keeps a file whose subject does not parse', () => {
  const files = nzbFiles(
    nzb([
      { subject: `[1/3] - "${EPISODES[0].name}" yEnc (1/3) ${EPISODES[0].length}`, segments: [700_000, 700_000, 31] },
      { subject: 'c4ca4238a0b923820dcc509a6f75849b', segments: [400, 600] },
      { subject: `${EPISODES[1].name} yEnc (1/1)`, segments: [5] },
    ]),
  )
  assert.deepEqual(files, [
    { name: EPISODES[0].name, size: EPISODES[0].length, bytes: 1_400_031 },
    { name: '', size: null, bytes: 1_000 },
    { name: EPISODES[1].name, size: null, bytes: 5 },
  ])
  // A file without a name matches no name and no size.
  const unnamed = files.filter(file => !file.name)
  assert.equal(nzbHasFiles(unnamed, EPISODES), false)
  assert.deepEqual(nzbFileMatches(unnamed, EPISODES), {
    files_matched: 0,
    names_matched: 0,
    files_expected: 3,
    sizes_known: false,
  })
})

test('subjects that state every name and exact size grade as exact, with ratios inside the accepted range', () => {
  const result = grade([...RELEASE.map(file => stated(file)), PAR2], RELEASE)
  assert.equal(result.proof, 'exact')
  assert.deepEqual([result.files_matched, result.names_matched, result.files_expected], [3, 3, 3])
  assertRatio(result.ratio, OVERHEAD)
  assert.ok(result.ratio![0] >= NEAR_EXACT_RATIO[0] && result.ratio![1] <= NEAR_EXACT_RATIO[1])

  // The subjects decide an exact match. Its ratios are reported as measured, which is what calibrates the range.
  const incomplete = grade([stated(EPISODES[0]), stated(EPISODES[1], OVERHEAD * 0.9), stated(EPISODES[2])], RELEASE)
  assert.equal(incomplete.proof, 'exact')
  assertRatio(incomplete.ratio, OVERHEAD * 0.9, OVERHEAD)
})

test('correct names without sizes and with a constant overhead grade as near_exact', () => {
  const result = grade([...RELEASE.map(file => named(file)), PAR2], RELEASE)
  assert.equal(result.proof, 'near_exact')
  assert.deepEqual([result.files_matched, result.names_matched, result.files_expected], [0, 3, 3])
  assertRatio(result.ratio, OVERHEAD)
  // The PAR2 subject states a size, the video subjects do not.
  assert.equal(result.sizes_known, true)
  assert.equal(
    grade(
      EPISODES.map(file => named(file)),
      RELEASE,
    ).sizes_known,
    false,
  )
  // A single video file is enough when its name is right.
  assert.equal(grade([named(EPISODES[0])], [EPISODES[0]]).proof, 'near_exact')
})

test('correct names with one file two percent off grade below near_exact', () => {
  const result = grade([named(EPISODES[0]), named(EPISODES[1], OVERHEAD * 1.02), named(EPISODES[2])], RELEASE)
  // Every ratio is in range, but they do not agree; only the total is left to compare.
  assert.equal(result.proof, 'size_only')
  assert.equal(result.names_matched, 3)
  assert.equal(result.ratio![0], result.ratio![1])
})

test('random names with sizes in a constant ratio grade as probable from three video files on', () => {
  for (const count of [1, 2, 3]) {
    const listed = EPISODES.slice(0, count)
    const result = grade([...listed.map((file, index) => obfuscated(file, index)), obfuscated(NOTES, 9)], listed)
    assert.equal(result.proof, count >= PROBABLE_MIN_FILES ? 'probable' : 'size_only', `${count} video files`)
    assert.deepEqual([result.files_matched, result.names_matched, result.sizes_known], [0, 0, false])
    assertRatio(result.ratio, OVERHEAD)
  }
  const season = grade(
    SEASON.map((file, index) => obfuscated(file, index)),
    SEASON,
  )
  assert.equal(season.proof, 'probable')
  assertRatio(season.ratio, OVERHEAD)
  // One file at another ratio leaves a listed size without a partner.
  const uneven = SEASON.map((file, index) => obfuscated(file, index, index === 7 ? OVERHEAD * 1.02 : OVERHEAD))
  assert.equal(grade(uneven, SEASON).proof, 'size_only')
})

test('every video file needs an NZB file of its own for a probable match', () => {
  const twins: SourceFile[] = [1, 2, 3].map(index => ({ name: `Twin ${index}.mkv`, length: 1_000_000_000 }))
  const file = (bytes: number): NzbFile => ({ name: '', size: null, bytes })
  assert.equal(gradeNzb([file(1_031_000_000), file(1_031_000_000), file(1_031_000_000)], twins).proof, 'probable')
  assert.equal(gradeNzb([file(1_031_000_000), file(1_031_000_000), file(200_000_000)], twins).proof, 'unverified')
})

test('a post that packs every listed file into one archive grades as size_only', () => {
  const listed = [...SEASON, NOTES]
  const part = Math.ceil(total(listed) / 9)
  const recovery = Math.round(total(listed) * 0.08)
  const result = grade(
    [
      ...Array.from({ length: 9 }, (_, index) => ({
        subject: `"8f1c2e7ab94d.part0${index + 1}.rar" yEnc (1/3) ${part}`,
        segments: segments(part),
      })),
      { subject: `"8f1c2e7ab94d.vol00+40.par2" yEnc (1/3) ${recovery}`, segments: segments(recovery) },
    ],
    listed,
  )
  assert.equal(result.proof, 'size_only')
  assert.deepEqual([result.files_matched, result.names_matched, result.files_expected], [0, 0, 12])
  assertRatio(result.ratio, OVERHEAD * 1.08)
})

test('a PAR2 volume larger than an episode does not break a probable match', () => {
  const listed = [...EPISODES, { name: '[Group] Show - NCOP [1080p].mkv', length: 702_345_678 }]
  const volume = (bytes: number, index: number): Posted => ({
    subject: `"${index}.vol${index}+99.par2" yEnc (1/3)`,
    segments: [bytes],
  })
  const result = grade(
    [
      // Larger than every episode and a possible partner of the largest one: that trial has to fail.
      volume(Math.round(EPISODES[0].length * 1.05), 0),
      ...listed.map((file, index) => obfuscated(file, index)),
      // Larger than the smallest episode, and between two others.
      volume(800_000_000, 1),
      volume(1_380_000_000, 2),
      volume(40_000, 3),
    ],
    listed,
  )
  assert.equal(result.proof, 'probable')
  assertRatio(result.ratio, OVERHEAD)
})

test('thousands of archive parts and recovery volumes neither hide nor fake a probable match', () => {
  const file = (bytes: number): NzbFile => ({ name: '', size: null, bytes })
  const parts = Array.from({ length: 5000 }, (_, index) => file(50_000_000 + index * 1_000))
  const videos = EPISODES.map(episode => file(Math.round(episode.length * OVERHEAD)))
  assert.equal(gradeNzb([...parts, ...videos], EPISODES).proof, 'probable')
  // Each of these could stand for the largest episode, and nothing fits the second.
  const decoys = Array.from({ length: 5000 }, (_, index) =>
    file(Math.round(EPISODES[0].length * 1.006) + index * 1_000),
  )
  assert.equal(gradeNzb(decoys, EPISODES).proof, 'unverified')
})

test('a post with missing segments grades below near_exact', () => {
  // One of three episodes at nine tenths of its size: the total falls short as well.
  const short = grade([named(EPISODES[0]), named(EPISODES[1], OVERHEAD * 0.9), named(EPISODES[2])], RELEASE)
  assert.equal(short.proof, 'unverified')
  assert.equal(short.names_matched, 3)
  assert.ok(short.ratio![1] < NEAR_EXACT_RATIO[0])
  // In a season the total hides one short episode, but the file itself still fails.
  const season = grade(
    SEASON.map((file, index) => named(file, index === 5 ? OVERHEAD * 0.9 : OVERHEAD)),
    SEASON,
  )
  assert.equal(season.proof, 'size_only')
  assert.equal(season.names_matched, 12)
})

test('a wrong release grades as unverified', () => {
  // Another release of the show: other names, about half the size.
  const smaller = EPISODES.map((file, index) => ({
    name: `[Other] Show - 0${index + 1} [720p].mkv`,
    length: Math.round(file.length * 0.55),
  }))
  const other = grade(
    smaller.map(file => stated(file)),
    RELEASE,
  )
  assert.equal(other.proof, 'unverified')
  assert.deepEqual([other.files_matched, other.names_matched, other.sizes_known], [0, 0, true])
  assertRatio(other.ratio, OVERHEAD * 0.55)
  // The same names from another encode, too large to be the listed files.
  const larger = grade(
    EPISODES.map(file => named(file, OVERHEAD * 1.4)),
    RELEASE,
  )
  assert.equal(larger.proof, 'unverified')
  assert.equal(larger.names_matched, 3)
})

test('the accepted ratio includes 1.005 and 1.06 and nothing beyond them', () => {
  const video: SourceFile = { name: 'Film.mkv', length: 1_000_000_000 }
  const proof = (bytes: number) => grade([{ subject: '"Film.mkv" yEnc (1/1)', segments: [bytes] }], [video]).proof
  assert.deepEqual(NEAR_EXACT_RATIO, [1.005, 1.06])
  assert.deepEqual(SIZE_ONLY_RATIO, [1.005, 1.35])
  assert.equal(proof(1_004_999_999), 'unverified')
  assert.equal(proof(1_005_000_000), 'near_exact')
  assert.equal(proof(1_060_000_000), 'near_exact')
  assert.equal(proof(1_060_000_001), 'size_only')
  assert.equal(proof(1_350_000_000), 'size_only')
  assert.equal(proof(1_350_000_001), 'unverified')
})

test('larger files must agree within the spread, and small files only have to be in range', () => {
  const large: SourceFile[] = [
    { name: 'Show - 01.mkv', length: 1_000_000_000 },
    { name: 'Show - 02.mkv', length: 800_000_000 },
  ]
  assert.equal(grade([named(large[0], 1.03), named(large[1], 1.034)], large).proof, 'near_exact')
  assert.equal(grade([named(large[0], 1.03), named(large[1], 1.036)], large).proof, 'size_only')

  const small: SourceFile = { name: 'Show - NCED.mkv', length: SPREAD_MIN_BYTES - 1 }
  const exempt = grade([...large.map(file => named(file)), named(small, 1.05)], [...large, small])
  assert.equal(exempt.proof, 'near_exact')
  assertRatio(exempt.ratio, OVERHEAD, 1.05)
  assert.equal(grade([...large.map(file => named(file)), named(small, 1.07)], [...large, small]).proof, 'size_only')
  // At 64 MiB the file counts as large.
  const edge: SourceFile = { name: 'Show - NCED.mkv', length: SPREAD_MIN_BYTES }
  assert.equal(grade([...large.map(file => named(file)), named(edge, 1.05)], [...large, edge]).proof, 'size_only')
})

test('video files that share a base name each need an NZB file of that name', () => {
  const listed: SourceFile[] = [
    { name: 'Season 1/Episode 01.mkv', length: 1_500_000_000 },
    { name: 'Season 2/Episode 01.mkv', length: 1_200_000_000 },
    { name: 'Season 2/Episode 02.mkv', length: 1_100_000_000 },
  ]
  // Posted in another order: the larger file stands for the larger listed size.
  const both = grade([named(listed[1]), named(listed[2]), named(listed[0])], listed)
  assert.equal(both.proof, 'near_exact')
  assert.equal(both.names_matched, 3)
  assertRatio(both.ratio, OVERHEAD)
  // A subject that states the listed size identifies its file before sizes are compared.
  const mixed = grade([named(listed[0]), stated(listed[1]), named(listed[2])], listed)
  assert.deepEqual([mixed.proof, mixed.files_matched, mixed.names_matched], ['near_exact', 1, 3])
  assertRatio(mixed.ratio, OVERHEAD)
  const once = grade([named(listed[0]), named(listed[2])], listed)
  assert.equal(once.names_matched, 2)
  assert.notEqual(once.proof, 'near_exact')
  assert.equal(grade([stated(listed[0]), stated(listed[1]), stated(listed[2])], listed).proof, 'exact')
})

test('a release without video files can only be compared by its total', () => {
  const disc: SourceFile[] = [
    { name: 'BDMV/STREAM/00001.m2ts', length: 30_000_000_000 },
    { name: 'BDMV/index.bdmv', length: 4_096 },
  ]
  const posted = grade(
    disc.map(file => stated(file)),
    disc,
  )
  assert.equal(posted.proof, 'size_only')
  assert.equal(posted.files_expected, 0)
  assertRatio(posted.ratio, OVERHEAD)
  assert.equal(grade([stated(disc[0], 0.5), stated(disc[1])], disc).proof, 'unverified')
  // Nothing listed means nothing to measure.
  assert.deepEqual(grade([stated(disc[0])], []), {
    proof: 'unverified',
    files_matched: 0,
    names_matched: 0,
    files_expected: 0,
    sizes_known: true,
  })
})
