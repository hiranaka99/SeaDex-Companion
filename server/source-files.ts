// File-list identity and comparison for private-tracker releases. SeaDex lists their files with exact
// sizes even though it withholds the info hash; that list is what a copy found elsewhere is checked against.

import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { VIDEO_FILE } from '../shared/releases.js'
import { normalizeTorrentPath } from '../shared/download-plan.js'
import { isRecord } from '../shared/guards.js'
import type { UsenetProof } from '../shared/usenet-contracts.js'
import { listOf, safeByteSize, validateNzbBytes } from './usenet-provider-types.js'

export interface SourceFile {
  name: string
  length: number
}

const baseName = (name: string): string => normalizeTorrentPath(name).split('/').pop() || ''
const fileKey = (name: string, length: number): string => `${baseName(name)}\u0000${length}`

/** `files:<sha1>` of a file list; independent of order and of the folder the files sit in. */
export function filesSourceId(files: SourceFile[]): string {
  const lines = files.map(file => fileKey(file.name, file.length)).sort()
  return `files:${createHash('sha1').update(lines.join('\n')).digest('hex')}`
}

function counts(keys: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const key of keys) map.set(key, (map.get(key) || 0) + 1)
  return map
}

/** Whether a torrent holds exactly the listed files: every name and size, nothing more and nothing less. */
export function sameFiles(actual: SourceFile[], expected: SourceFile[]): boolean {
  if (!expected.length || actual.length !== expected.length) return false
  const wanted = counts(expected.map(file => fileKey(file.name, file.length)))
  for (const [key, count] of counts(actual.map(file => fileKey(file.name, file.length))))
    if (wanted.get(key) !== count) return false
  return true
}

export interface NzbFile {
  /** File name from the subject line; empty when the subject does not parse. */
  name: string
  /** Decoded size from the subject line; null when the poster did not include it. */
  size: number | null
  /** Sum of the file's `<segment bytes>`: its encoded size on Usenet, a few percent above the decoded one. */
  bytes: number
}

const nzbParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false })

/**
 * Posting tools such as Nyuu and ngPost write subjects like
 * `[3/24] - "Show - 01.mkv" yEnc (1/812) 1234567890`; the trailing number is the decoded file size.
 */
const QUOTED_SUBJECT = /"([^"]+)"\s*yEnc\s*\(\d+\/\d+\)\s*(\d+)?\s*$/i
const BARE_SUBJECT = /^(?:\[\d+\/\d+\]\s*-?\s*)?(.+?)\s+yEnc\s*\(\d+\/\d+\)\s*(\d+)?\s*$/i

/** Numeric character references the XML parser leaves in attribute values, such as `&#039;` in subjects. */
function decodeCharacterReferences(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (reference, code: string) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : reference
  })
}

/** Validation has already required a safe, non-negative byte count on every segment. */
function segmentBytes(file: Record<string, unknown>): number {
  let sum = 0
  for (const segment of listOf(isRecord(file.segments) ? file.segments.segment : undefined))
    sum += (isRecord(segment) && safeByteSize(segment['@_bytes'])) || 0
  return sum
}

/**
 * Every `<file>` of an NZB: the name and decoded size its subject discloses, and the sum of its segment bytes.
 * A subject that does not parse gives a file with an empty name instead of being dropped, so an obfuscated
 * post can still be compared by size.
 */
export function nzbFiles(bytes: Uint8Array): NzbFile[] {
  validateNzbBytes(bytes)
  const xml = new TextDecoder('utf-8').decode(bytes).replace(/<!DOCTYPE[^>]*>/i, '')
  const document = nzbParser.parse(xml)
  const nzb = isRecord(document) && isRecord(document.nzb) ? document.nzb : undefined
  const files: NzbFile[] = []
  for (const file of listOf(nzb?.file)) {
    if (!isRecord(file)) continue
    const subject = typeof file['@_subject'] === 'string' ? file['@_subject'].trim() : ''
    const match = subject.match(QUOTED_SUBJECT) || subject.match(BARE_SUBJECT)
    const size = match?.[2] === undefined ? null : (safeByteSize(match[2]) ?? null)
    files.push({ name: match ? decodeCharacterReferences(match[1].trim()) : '', size, bytes: segmentBytes(file) })
  }
  return files
}

/**
 * Whether an NZB carries every video file of the release, byte for byte by its subject sizes. Extra files
 * such as PAR2 sets are allowed; a renamed, repacked or size-less post never matches.
 */
export function nzbHasFiles(files: NzbFile[], expected: SourceFile[]): boolean {
  const videos = expected.filter(file => VIDEO_FILE.test(file.name))
  if (!videos.length) return false
  const available = counts(files.filter(file => file.size !== null).map(file => fileKey(file.name, file.size!)))
  for (const [key, count] of counts(videos.map(file => fileKey(file.name, file.length))))
    if ((available.get(key) || 0) < count) return false
  return true
}

export interface NzbFileMatches {
  files_matched: number
  names_matched: number
  files_expected: number
  sizes_known: boolean
}

/**
 * How close an unproven NZB came: video files present with name and exact size, and whether it states sizes.
 * A file without a name matches no name.
 */
export function nzbFileMatches(files: NzbFile[], expected: SourceFile[]): NzbFileMatches {
  const videos = expected.filter(file => VIDEO_FILE.test(file.name))
  const available = counts(files.filter(file => file.size !== null).map(file => fileKey(file.name, file.size!)))
  let matched = 0
  for (const file of videos) {
    const key = fileKey(file.name, file.length)
    const left = available.get(key) || 0
    if (left > 0) {
      matched++
      available.set(key, left - 1)
    }
  }
  const names = counts(files.map(file => baseName(file.name)))
  let named = 0
  for (const file of videos) {
    const left = names.get(baseName(file.name)) || 0
    if (left > 0) {
      named++
      names.set(baseName(file.name), left - 1)
    }
  }
  return {
    files_matched: matched,
    names_matched: named,
    files_expected: videos.length,
    sizes_known: files.some(file => file.size !== null),
  }
}

// Proof thresholds. A "ratio" is segment bytes divided by listed size: the yEnc overhead of a posted file.
// Measured on eight AnimeTosho posts (77 video files that state their exact size): 1.030 to 1.032, varying by at
// most 0.18% within one post. Other posters use other line lengths and article sizes, so the accepted values are
// wider on purpose. They are validated against the ratios of exact matches from real fetches, which callers log,
// and are to be widened when a poster falls outside.

/** Ratio a correctly posted file may show, both ends included. */
export const NEAR_EXACT_RATIO = [1.005, 1.06] as const
/** How far apart the ratios of one post may lie. */
export const RATIO_SPREAD = 0.005
/** Files below this size are taken to have a less steady ratio: they must be in range, but need not agree. */
export const SPREAD_MIN_BYTES = 64 * 1024 * 1024
/** Sizes without names identify a release only when several agree; one or two agree by chance too easily. */
export const PROBABLE_MIN_FILES = 3
/**
 * NZB files tried as the partner of the largest video, largest first. The real partner is the largest file of
 * the release itself, so only recovery volumes that happen to be slightly larger are tried before it.
 */
export const PROBABLE_TRIAL_LIMIT = 64
/** Whole post over whole release, both ends included: PAR2 recovery data and archive packing come on top of yEnc. */
export const SIZE_ONLY_RATIO = [1.005, 1.35] as const

export interface NzbGrade extends NzbFileMatches {
  proof: UsenetProof
  /**
   * Lowest and highest measured ratio: over the video files paired by name for `exact` and `near_exact`, over
   * the files paired by size for `probable`, and the ratio of the totals, twice, for `size_only` and
   * `unverified`. Absent when nothing could be measured.
   */
  ratio?: [number, number]
}

const within = (value: number, [low, high]: readonly [number, number]): boolean => value >= low && value <= high

function ratioRange(ratios: Array<number | undefined>): [number, number] | undefined {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const ratio of ratios) {
    if (ratio === undefined || !Number.isFinite(ratio)) continue
    low = Math.min(low, ratio)
    high = Math.max(high, ratio)
  }
  return low <= high ? [low, high] : undefined
}

/**
 * The ratio of each video file to the NZB file of the same base name that stands for it, undefined where the
 * NZB has no file left for that name. A subject that states the listed size identifies its file outright; other
 * files sharing a name pair largest with largest, the assignment that keeps their ratios closest together.
 */
function ratiosByName(files: NzbFile[], videos: SourceFile[]): Array<number | undefined> {
  const pools = new Map<string, NzbFile[]>()
  for (const file of files) {
    const name = baseName(file.name)
    if (!name) continue
    const pool = pools.get(name)
    if (pool) pool.push(file)
    else pools.set(name, [file])
  }
  const partners = videos.map(video => {
    const pool = pools.get(baseName(video.name))
    const index = pool ? pool.findIndex(file => file.size === video.length) : -1
    return index < 0 ? undefined : pool!.splice(index, 1)[0]
  })
  for (const pool of pools.values()) pool.sort((left, right) => right.bytes - left.bytes)
  const largestFirst = videos.map((_, index) => index).sort((left, right) => videos[right].length - videos[left].length)
  for (const index of largestFirst) partners[index] ??= pools.get(baseName(videos[index].name))?.shift()
  return partners.map((file, index) => (file ? file.bytes / videos[index].length : undefined))
}

/** Every video has a file of its name, each ratio is accepted, and the larger files agree with each other. */
function nearExact(videos: SourceFile[], ratios: Array<number | undefined>): boolean {
  if (!videos.length || !ratios.every(ratio => ratio !== undefined && within(ratio, NEAR_EXACT_RATIO))) return false
  const large = ratioRange(ratios.filter((_, index) => videos[index].length >= SPREAD_MIN_BYTES))
  return !large || large[1] - large[0] <= RATIO_SPREAD
}

/**
 * Pairs videos with NZB files by size alone, for posts whose names say nothing. Each NZB file that can stand for
 * the largest video at an accepted ratio is tried; that ratio then has to give every other video a file of its
 * own. Returns the ratios of the first pairing found.
 */
function ratiosBySize(files: NzbFile[], videos: SourceFile[]): number[] | undefined {
  if (videos.length < PROBABLE_MIN_FILES) return undefined
  const sizes = videos.map(video => video.length).sort((left, right) => right - left)
  const smallest = sizes[sizes.length - 1]
  // Most files of a large NZB are PAR2 volumes and archive parts too small to stand for any video.
  const pool = files
    .map(file => file.bytes)
    .filter(bytes => NEAR_EXACT_RATIO[0] - bytes / smallest <= RATIO_SPREAD)
    .sort((left, right) => right - left)
  let trials = 0
  for (let partner = 0; partner < pool.length && trials < PROBABLE_TRIAL_LIMIT; partner++) {
    const fixed = pool[partner] / sizes[0]
    // An equal file was already tried, or this one is too large to be the largest video.
    if (fixed > NEAR_EXACT_RATIO[1] || pool[partner] === pool[partner - 1]) continue
    if (!(fixed >= NEAR_EXACT_RATIO[0])) break
    trials++
    const ratios = [fixed]
    let next = 0
    for (const size of sizes.slice(1)) {
      // Sizes fall, so a file too large for this video is too large for every later one. Taking the largest
      // file that fits therefore never takes one a later video needs.
      while (next < pool.length && (next === partner || pool[next] / size - fixed > RATIO_SPREAD)) next++
      if (next >= pool.length || !(fixed - pool[next] / size <= RATIO_SPREAD)) break
      ratios.push(pool[next++] / size)
    }
    if (ratios.length === sizes.length) return ratios
  }
  return undefined
}

/**
 * How strongly an NZB is shown to be the listed release: the first level that holds, with the counts of
 * `nzbFileMatches` and the measured ratios.
 *
 * - `exact`: `nzbHasFiles`. It reads subjects only, so its ratio is reported but not judged.
 * - `near_exact`: every video file's base name appears (names used twice need as many NZB files), each ratio is
 *   within `NEAR_EXACT_RATIO`, and the ratios of videos of `SPREAD_MIN_BYTES` or more differ by at most
 *   `RATIO_SPREAD`.
 * - `probable`: at least `PROBABLE_MIN_FILES` videos, and one ratio within `NEAR_EXACT_RATIO` gives every listed
 *   video size an NZB file of its own within `RATIO_SPREAD`. Names are ignored.
 * - `size_only`: all segment bytes divided by the total of all listed files is within `SIZE_ONLY_RATIO`. This
 *   is the only level a release without video files can reach, because it alone does not compare files.
 * - `unverified`: none of these.
 *
 * Missing articles lower a file's ratio, which is what takes an incomplete post out of `near_exact`.
 */
export function gradeNzb(files: NzbFile[], expected: SourceFile[]): NzbGrade {
  const videos = expected.filter(file => VIDEO_FILE.test(file.name))
  const matches = nzbFileMatches(files, expected)
  const grade = (proof: UsenetProof, ratios: Array<number | undefined>): NzbGrade => {
    const ratio = ratioRange(ratios)
    return { proof, ...(ratio ? { ratio } : {}), ...matches }
  }
  const named = ratiosByName(files, videos)
  if (nzbHasFiles(files, expected)) return grade('exact', named)
  if (nearExact(videos, named)) return grade('near_exact', named)
  const sized = ratiosBySize(files, videos)
  if (sized) return grade('probable', sized)
  const total = files.reduce((sum, file) => sum + file.bytes, 0) / expected.reduce((sum, file) => sum + file.length, 0)
  return grade(within(total, SIZE_ONLY_RATIO) ? 'size_only' : 'unverified', [total])
}
