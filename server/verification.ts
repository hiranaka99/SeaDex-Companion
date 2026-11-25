import { VIDEO_FILE } from './matching.js'
import type { LocalFile, LocalSeason, ReleaseCandidate } from './types.js'

export interface PartVerification {
  /** Release groups whose listed files are exactly the files in the library. */
  verified: string[]
  /** Release groups the library files are named after, although their sizes differ from the listed release. */
  mismatched: string[]
}

const NONE: PartVerification = { verified: [], mismatched: [] }
const key = (group: string) => group.trim().toLowerCase()

/** Exact sizes of the video files a release lists. Extras and subtitles never identify an episode. */
function listedSizes(candidates: ReleaseCandidate[]): Set<number> {
  const sizes = new Set<number>()
  for (const candidate of candidates) for (const file of candidate.source_files || []) {
    if (VIDEO_FILE.test(file.name) && Number.isSafeInteger(file.length) && file.length > 0) sizes.add(file.length)
  }
  return sizes
}

/**
 * Compares the library files of one season or cour with the releases SeaDex lists for it.
 * A release group's name says who made a file, not which of the group's releases it is:
 * an earlier batch, or the group's WEB release beside its BD release, carries the same name.
 * The exact file size tells them apart, because Sonarr and Radarr import files unchanged.
 *
 * Nothing is concluded when either side lacks file sizes.
 */
export function verifyPart(
  local: Pick<LocalSeason, 'files'>,
  episodeNumbers: number[] | undefined,
  namedOwners: string[],
  candidates: ReleaseCandidate[],
): PartVerification {
  const files: LocalFile[] = local.files || []
  if (!files.length || !candidates.length) return NONE
  const expected = episodeNumbers ? new Set(episodeNumbers) : null
  const partFiles = expected ? files.filter(file => file.episodes.some(episode => expected.has(episode))) : files
  if (!partFiles.length || partFiles.some(file => !(file.size > 0))) return NONE
  const covered = new Set(partFiles.flatMap(file => file.episodes))
  const complete = expected ? [...expected].every(episode => covered.has(episode)) : true

  const byGroup = new Map<string, ReleaseCandidate[]>()
  for (const candidate of candidates) byGroup.set(key(candidate.releaseGroup), [...(byGroup.get(key(candidate.releaseGroup)) || []), candidate])
  const owners = new Set(namedOwners.map(key))
  const verified: string[] = []
  const mismatched: string[] = []
  for (const [group, releases] of byGroup) {
    // A group's best release is the one that has to be owned; its other uploads are different releases.
    const flagged = releases.filter(release => release.is_best)
    const sizes = listedSizes(flagged.length ? flagged : releases)
    if (!sizes.size) continue
    const name = releases[0].releaseGroup
    if (complete && partFiles.every(file => sizes.has(file.size))) { verified.push(name); continue }
    if (!owners.has(group)) continue
    const groupFiles = partFiles.filter(file => key(file.group) === group)
    if (groupFiles.length && !groupFiles.every(file => sizes.has(file.size))) mismatched.push(name)
  }
  return verified.length || mismatched.length ? { verified, mismatched } : NONE
}
