import { INFO_HASH_PATTERN } from './ids.js'

/** Identity includes file scope so a refreshed recommendation cannot silently change a selection. */
export function releaseIdentity(release: {
  part?: string
  releaseGroup?: string
  tracker?: string
  info_hashes?: string[]
  selected_files?: string[]
}): string {
  return JSON.stringify([
    release.part || '',
    release.releaseGroup || '',
    release.tracker || '',
    [...(release.info_hashes || [])].map(hash => hash.toLowerCase()).sort(),
    [...(release.selected_files || [])].sort(),
  ])
}

export const VIDEO_FILE = /\.(?:mkv|mp4|avi|m4v|ts|webm)$/i

export interface ParsedEpisode {
  episode: number
  season: number | null
  explicit: boolean
}

/** An audio codec followed by its channel layout, such as "E-AC3 5.1", "DDP7.1" or "FLAC 2.0". */
const AUDIO_CHANNELS =
  /\b(?:E-?AC-?3|AC-?3|DDP?\+?|DD\+|AAC(?:-LC)?|FLAC|Opus|DTS(?:-HD)?(?:[ .-]?(?:MA|HRA|X))?|TrueHD|Atmos|L?PCM|MP3|Vorbis)[ ._-]?\d\.\d\b/gi

export function episodeFromFilename(name: string): ParsedEpisode | null {
  const filename = name.split(/[\\/]/).pop() || ''
  if (!VIDEO_FILE.test(filename) || /NCOP|NCED/i.test(filename)) return null
  const standard = filename.match(/S(\d{1,3})E(\d{1,3}(?:\.\d+)?)/i)
  if (standard) return { season: Number(standard[1]), episode: Number(standard[2]), explicit: true }
  const named = filename.match(/\b(?:Episode|Ep\.?)\s*[._-]*\s*(\d{1,3}(?:\.\d+)?)(?=[ ._[\]()-]|$)/i)
  if (named) return { season: null, episode: Number(named[1]), explicit: true }
  // Unlabelled absolute episode numbers are common in whole-season encodes.
  // Only use these when no explicitly numbered episodes exist in the torrent.
  // Audio channel layouts such as "E-AC3 5.1" or "AAC 2.0" are not episode numbers, and a number never
  // matches as just the whole part of a decimal, so "5.1)" cannot read as episode 5.
  const absolute = filename.replace(AUDIO_CHANNELS, ' ').match(/(?:^|[\s_-])(\d{1,3}(?:\.\d+)?)(?!\.?\d)(?=[\s(.\]]|$)/)
  return absolute ? { season: null, episode: Number(absolute[1]), explicit: false } : null
}

/**
 * Episode ranges a file list covers, such as "Eps 13–24" or "Ep 5". Null unless every video file names its
 * episode, so a partial parse never understates what a download contains.
 */
export function episodeRangeLabel(names: string[]): string | null {
  // Creditless openings and endings are extras, not episodes.
  const parsed = names.filter(name => VIDEO_FILE.test(name) && !/NCOP|NCED/i.test(name)).map(episodeFromFilename)
  if (!parsed.length || parsed.some(episode => !episode)) return null
  const explicit = parsed.some(episode => episode!.explicit)
  const numbers = [
    ...new Set(parsed.filter(episode => !explicit || episode!.explicit).map(episode => episode!.episode)),
  ]
  if (!numbers.length || numbers.some(number => !Number.isInteger(number))) return null
  numbers.sort((a, b) => a - b)
  const ranges: string[] = []
  for (let index = 0; index < numbers.length;) {
    let end = index
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end++
    ranges.push(end > index ? `${numbers[index]}–${numbers[end]}` : String(numbers[index]))
    index = end + 1
  }
  if (ranges.length > 3) return null
  return `${numbers.length === 1 ? 'Ep' : 'Eps'} ${ranges.join(', ')}`
}

type ListedFile = { name: string; length: number }
interface Listing {
  releaseGroup: string
  info_hashes?: string[]
  source_files?: ListedFile[]
  torrent_files?: { files: ListedFile[] }[]
  selected_files?: string[]
}

/**
 * The sizes of a listing's video files. Extras and subtitles never identify a release. A listing scoped to
 * some of its torrent's files, such as one season of a whole-series batch, is identified by those files alone.
 */
function videoSizes(listing: Listing): number[] {
  const listed = listing.source_files?.length
    ? listing.source_files
    : (listing.torrent_files || []).flatMap(torrent => torrent.files)
  const selected = new Set(listing.selected_files || [])
  const scoped = selected.size ? listed.filter(file => selected.has(file.name)) : []
  const files = scoped.length ? scoped : listed
  return files
    .filter(file => VIDEO_FILE.test(file.name) && Number.isSafeInteger(file.length) && file.length > 0)
    .map(file => file.length)
}

/** Whether every size in `inner` has its own byte-identical counterpart in `outer`. */
function containsAll(outer: number[], inner: number[]): boolean {
  const remaining = new Map<number, number>()
  for (const size of outer) remaining.set(size, (remaining.get(size) || 0) + 1)
  return inner.every(size => {
    const count = remaining.get(size) || 0
    remaining.set(size, count - 1)
    return count > 0
  })
}

/**
 * Whether two SeaDex listings are the same release, such as one encode uploaded to two trackers.
 * A group often has several listed releases (a BD and a WEB release, or two encodes of a movie),
 * so the group name alone never decides. Two listings are the same release when one's video files all appear,
 * byte for byte, in the other, which covers a copy that leaves out a bonus episode. Without file sizes, two
 * different torrents are two releases; `lenient` lets the group name decide only for a listing without a torrent, such as a private-tracker copy.
 */
export function sameRelease(left: Listing, right: Listing, lenient = false): boolean {
  if (left.releaseGroup.trim().toLowerCase() !== right.releaseGroup.trim().toLowerCase()) return false
  const torrents = (listing: Listing) =>
    (listing.info_hashes || []).map(hash => hash.toLowerCase()).filter(hash => INFO_HASH_PATTERN.test(hash))
  const leftTorrents = torrents(left)
  const rightTorrents = torrents(right)
  if (rightTorrents.some(hash => leftTorrents.includes(hash))) return true
  const leftFiles = videoSizes(left)
  const rightFiles = videoSizes(right)
  // One upload can add extras to the same encode, such as an OVA beside the season's episodes.
  if (leftFiles.length && rightFiles.length) {
    return leftFiles.length <= rightFiles.length
      ? containsAll(rightFiles, leftFiles)
      : containsAll(leftFiles, rightFiles)
  }
  return lenient && (!leftTorrents.length || !rightTorrents.length)
}
