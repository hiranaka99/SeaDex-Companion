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
