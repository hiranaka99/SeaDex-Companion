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

export function episodeFromFilename(name: string): ParsedEpisode | null {
  const filename = name.split(/[\\/]/).pop() || ''
  if (!VIDEO_FILE.test(filename) || /NCOP|NCED/i.test(filename)) return null
  const standard = filename.match(/S(\d{1,3})E(\d{1,3}(?:\.\d+)?)/i)
  if (standard) return { season: Number(standard[1]), episode: Number(standard[2]), explicit: true }
  const named = filename.match(/\b(?:Episode|Ep\.?)\s*[._-]*\s*(\d{1,3}(?:\.\d+)?)(?=[ ._[\]()-]|$)/i)
  if (named) return { season: null, episode: Number(named[1]), explicit: true }
  // Unlabelled absolute episode numbers are common in whole-season encodes.
  // Only use these when no explicitly numbered episodes exist in the torrent.
  const absolute = filename.match(/(?:^|[\s_-])(\d{1,3}(?:\.\d+)?)(?=[\s(.\]]|$)/)
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
}

/** The sorted sizes of a listing's video files. Extras and subtitles never identify a release. */
function videoFingerprint(listing: Listing): string {
  const files = listing.source_files?.length
    ? listing.source_files
    : (listing.torrent_files || []).flatMap(torrent => torrent.files)
  return files
    .filter(file => VIDEO_FILE.test(file.name) && Number.isSafeInteger(file.length) && file.length > 0)
    .map(file => file.length)
    .sort((left, right) => left - right)
    .join(',')
}

/**
 * Whether two SeaDex listings are the same release, such as one encode uploaded to two trackers.
 * A group often has several listed releases (a BD and a WEB release, or two encodes of a movie),
 * so the group name alone never decides. Without file sizes, two different torrents are two releases;
 * `lenient` lets the group name decide only for a listing without a torrent, such as a private-tracker copy.
 */
export function sameRelease(left: Listing, right: Listing, lenient = false): boolean {
  if (left.releaseGroup.trim().toLowerCase() !== right.releaseGroup.trim().toLowerCase()) return false
  const torrents = (listing: Listing) =>
    (listing.info_hashes || []).map(hash => hash.toLowerCase()).filter(hash => INFO_HASH_PATTERN.test(hash))
  const leftTorrents = torrents(left)
  const rightTorrents = torrents(right)
  if (rightTorrents.some(hash => leftTorrents.includes(hash))) return true
  const leftFiles = videoFingerprint(left)
  const rightFiles = videoFingerprint(right)
  if (leftFiles && rightFiles) return leftFiles === rightFiles
  return lenient && (!leftTorrents.length || !rightTorrents.length)
}
