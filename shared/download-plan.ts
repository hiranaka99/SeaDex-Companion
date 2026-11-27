import { INFO_HASH_PATTERN } from './ids.js'
import type { EstimatableRelease } from './download-estimate.js'

export const normalizeTorrentPath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
export const torrentHashes = (release: EstimatableRelease): string[] => [
  ...new Set(release.info_hashes.map(hash => hash.toLowerCase()).filter(hash => INFO_HASH_PATTERN.test(hash))),
]

export interface RecommendationRelease extends EstimatableRelease {
  kind: 'best' | 'alt'
  part?: string
  releaseGroup: string
  torrent_available: boolean
  /** The download target the saved preferences pick for the part. */
  target?: boolean
  /** Owning this release makes its part count as best; absent means the kind decides. */
  satisfies?: boolean
  /** The library's files are this release's files, byte for byte. */
  files_match?: boolean
  /** Set when the saved preferences never offer this release for download. */
  excluded_by?: string
}

export interface RecommendationSeason<R extends RecommendationRelease = RecommendationRelease> {
  key: string
  status: string
  upgrade_available?: boolean
  excluded?: boolean
  excluded_parts?: string[]
  precise_part_ownership?: boolean
  owned_by_part?: Record<string, string[]>
  verified_by_part?: Record<string, string[]>
  mismatched_by_part?: Record<string, string[]>
  have?: string[]
  releases: R[]
}

/**
 * SeaDex lists a better release for this season than the library holds. A fact about the catalog and the
 * library, whatever the user has ignored: the card, the Upgrade filter, history and regressions ask this.
 */
export const upgradeAvailable = (season: Pick<RecommendationSeason, 'status' | 'upgrade_available'>): boolean =>
  season.status === 'upgrade' || (season.status === 'partial' && season.upgrade_available === true)

/** Whether the user ignored this release's part of the season. */
export const partIgnored = (
  season: Pick<RecommendationSeason, 'excluded_parts'>,
  release: Pick<RecommendationRelease, 'part'>,
): boolean => Boolean(season.excluded_parts?.includes(release.part || ''))

type OwnedRelease = Pick<RecommendationRelease, 'part' | 'releaseGroup' | 'files_match'>
type OwnershipFacts = Pick<
  RecommendationSeason,
  'precise_part_ownership' | 'owned_by_part' | 'verified_by_part' | 'mismatched_by_part' | 'have'
> & { releases?: OwnedRelease[] }

const sameGroup = (left: OwnedRelease, right: OwnedRelease) =>
  (left.part || '') === (right.part || '') &&
  left.releaseGroup.trim().toLowerCase() === right.releaseGroup.trim().toLowerCase()

/** The library's files are, byte for byte, another release the same group lists for this part. */
const holdsSibling = (season: OwnershipFacts, release: OwnedRelease) =>
  !release.files_match && Boolean(season.releases?.some(other => other.files_match && sameGroup(other, release)))

/** Whether the library's files are exactly this release's files. Older results only know it per release group. */
export function releaseFilesMatch(season: OwnershipFacts, release: OwnedRelease): boolean {
  if (release.files_match) return true
  if (holdsSibling(season, release)) return false
  const wanted = release.releaseGroup.trim().toLowerCase()
  return Boolean(season.verified_by_part?.[release.part || '']?.some(group => group.trim().toLowerCase() === wanted))
}

/**
 * Whether the library holds this release. A file-size match proves ownership whatever the
 * files are named; a size mismatch disproves it even when the release group name matches,
 * and so does a match with another release by the same group.
 */
export function releaseOwned(season: OwnershipFacts, release: OwnedRelease): boolean {
  const part = release.part || ''
  const wanted = release.releaseGroup.trim().toLowerCase()
  const named = (groups: string[] | undefined) => Boolean(groups?.some(group => group.trim().toLowerCase() === wanted))
  if (releaseFilesMatch(season, release)) return true
  if (holdsSibling(season, release)) return false
  if (named(season.mismatched_by_part?.[part])) return false
  return named(season.precise_part_ownership ? season.owned_by_part?.[part] : season.have)
}

/** Whether owning this release settles its season or cour. Results saved before preferences existed rely on the kind. */
export const releaseSatisfies = (release: Pick<RecommendationRelease, 'kind' | 'satisfies'>): boolean =>
  release.satisfies ?? release.kind === 'best'

/** Whether bulk download may offer this release: SeaDex's best releases and the preferred target, minus exclusions. */
export const releaseOffered = (release: Pick<RecommendationRelease, 'kind' | 'target' | 'excluded_by'>): boolean =>
  !release.excluded_by && (release.kind === 'best' || release.target === true)

/** Parts the library already settles: it holds a release whose ownership settles the part. */
const settledParts = (season: RecommendationSeason): Set<string> =>
  new Set(
    season.releases
      .filter(release => releaseOwned(season, release) && releaseSatisfies(release))
      .map(release => release.part || ''),
  )

/** Why a release is not a wanted option of its season. */
export type UnwantedReason =
  /** The season has no upgrade available. */
  | 'no_upgrade'
  /** The user ignored the whole season. */
  | 'ignored'
  /** Neither SeaDex's best release nor the preferred target, or excluded by the release preferences. */
  | 'not_offered'
  /** The user ignored the release's part. */
  | 'ignored_part'
  /** The library holds this release. */
  | 'owned'
  /** The library holds another release that settles the part. */
  | 'settled'

/** Why this release is not one of the season's wanted options, or undefined when it is one. */
export function unwantedReason(season: RecommendationSeason, index: number): UnwantedReason | undefined {
  const release = season.releases[index]
  if (!upgradeAvailable(season)) return 'no_upgrade'
  if (season.excluded) return 'ignored'
  if (!release || !releaseOffered(release)) return 'not_offered'
  if (partIgnored(season, release)) return 'ignored_part'
  if (releaseOwned(season, release)) return 'owned'
  if (settledParts(season).has(release.part || '')) return 'settled'
  return undefined
}

/**
 * The wanted parts of a season, each with the releases that may fetch it: what Bulk download fetches and what
 * notifications and upgrade tags announce. One eligibility policy for review, preflight validation, and
 * submission. A part stays wanted when nothing can fetch it yet; `torrent_available` says whether a torrent can.
 */
export function wantedParts<R extends RecommendationRelease>(
  season: RecommendationSeason<R>,
): { part: string; options: { index: number; release: R }[]; torrent_available: boolean }[] {
  if (!upgradeAvailable(season) || season.excluded) return []
  const settled = settledParts(season)
  const parts = new Map<string, { index: number; release: R }[]>()
  season.releases.forEach((release, index) => {
    const part = release.part || ''
    if (settled.has(part) || releaseOwned(season, release)) return
    if (!releaseOffered(release) || partIgnored(season, release)) return
    parts.set(part, [...(parts.get(part) || []), { index, release }])
  })
  return [...parts].map(([part, offered]) => {
    // The preferred target leads, so it is the default choice wherever several releases are offered.
    const options = [...offered].sort(
      (left, right) => Number(right.release.target === true) - Number(left.release.target === true),
    )
    const available = options.filter(({ release }) => release.torrent_available && torrentHashes(release).length > 0)
    return { part, options: available.length ? available : options, torrent_available: available.length > 0 }
  })
}

export interface PlannedTorrent {
  hash: string
  category: string
  labels: string[]
  releases: EstimatableRelease[]
  /** Undefined means the whole torrent. Otherwise paths are scoped to this hash. */
  selectedFiles?: string[]
}

/** Deduplicate hashes and union file scopes once. Any whole-torrent selection wins. */
export function planTorrents(
  selections: { release: EstimatableRelease; category: string; label?: string }[],
): PlannedTorrent[] {
  const plan = new Map<string, PlannedTorrent>()
  for (const { release, category, label } of selections) {
    const catalogs = release.torrent_files || []
    const allNames = new Set(catalogs.flatMap(catalog => catalog.files.map(file => normalizeTorrentPath(file.name))))
    const completeScope =
      torrentHashes(release).every(hash =>
        catalogs.some(catalog => catalog.hash.toLowerCase() === hash && catalog.files.length > 0),
      ) && release.selected_files?.every(name => allNames.has(normalizeTorrentPath(name)))
    for (const hash of torrentHashes(release)) {
      const ownNames = new Set(
        catalogs
          .filter(catalog => catalog.hash.toLowerCase() === hash)
          .flatMap(catalog => catalog.files.map(file => normalizeTorrentPath(file.name))),
      )
      const selected = release.selected_files?.filter(
        name => !completeScope || ownNames.has(normalizeTorrentPath(name)),
      )
      if (release.selected_files?.length && !selected?.length) continue
      const existing = plan.get(hash)
      if (!existing) {
        plan.set(hash, {
          hash,
          category,
          labels: label ? [label] : [],
          releases: [release],
          ...(selected?.length
            ? { selectedFiles: [...new Map(selected.map(name => [normalizeTorrentPath(name), name])).values()] }
            : {}),
        })
        continue
      }
      existing.releases.push(release)
      if (label && !existing.labels.includes(label)) existing.labels.push(label)
      if (!selected?.length) delete existing.selectedFiles
      else if (existing.selectedFiles)
        existing.selectedFiles = [
          ...new Map([...existing.selectedFiles, ...selected].map(name => [normalizeTorrentPath(name), name])).values(),
        ]
    }
  }
  return [...plan.values()]
}
