import type { EstimatableRelease } from './download-estimate.js'

export const normalizeTorrentPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').toLowerCase()
export const torrentHashes = (release: EstimatableRelease): string[] => [...new Set(release.info_hashes.map(hash => hash.toLowerCase()).filter(hash => /^[0-9a-f]{40}$/.test(hash)))]

export interface RecommendationRelease extends EstimatableRelease {
  kind: 'best' | 'alt'
  part?: string
  releaseGroup: string
  downloadable: boolean
}

export interface RecommendationSeason<R extends RecommendationRelease = RecommendationRelease> {
  key: string
  status: string
  upgrade_available?: boolean
  excluded?: boolean
  excluded_parts?: string[]
  precise_part_ownership?: boolean
  owned_by_part?: Record<string, string[]>
  have?: string[]
  releases: R[]
}

export const isSeasonUpgradable = (season: Pick<RecommendationSeason, 'status' | 'upgrade_available'>): boolean =>
  season.status === 'upgrade' || (season.status === 'partial' && season.upgrade_available === true)

export function releaseOwned(season: Pick<RecommendationSeason, 'precise_part_ownership' | 'owned_by_part' | 'have'>, release: RecommendationRelease): boolean {
  const groups = season.precise_part_ownership ? season.owned_by_part?.[release.part || ''] || [] : season.have || []
  return groups.some(group => group.trim().toLowerCase() === release.releaseGroup.trim().toLowerCase())
}

/** One eligibility policy for review, preflight validation, and submission. */
export function upgradeParts<R extends RecommendationRelease>(season: RecommendationSeason<R>): { part: string; options: { index: number; release: R }[]; downloadable: boolean }[] {
  if (!isSeasonUpgradable(season) || season.excluded) return []
  const parts = new Map<string, { index: number; release: R }[]>()
  season.releases.forEach((release, index) => {
    if (release.kind !== 'best' || season.excluded_parts?.includes(release.part || '')) return
    const part = release.part || ''
    parts.set(part, [...(parts.get(part) || []), { index, release }])
  })
  return [...parts].filter(([, options]) => !options.some(({ release }) => releaseOwned(season, release))).map(([part, options]) => {
    const available = options.filter(({ release }) => release.downloadable && torrentHashes(release).length > 0)
    return { part, options: available.length ? available : options, downloadable: available.length > 0 }
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
export function planTorrents(selections: { release: EstimatableRelease; category: string; label?: string }[]): PlannedTorrent[] {
  const plan = new Map<string, PlannedTorrent>()
  for (const { release, category, label } of selections) {
    const catalogs = release.torrent_files || []
    const allNames = new Set(catalogs.flatMap(catalog => catalog.files.map(file => normalizeTorrentPath(file.name))))
    const completeScope = torrentHashes(release).every(hash => catalogs.some(catalog => catalog.hash.toLowerCase() === hash && catalog.files.length > 0)) && release.selected_files?.every(name => allNames.has(normalizeTorrentPath(name)))
    for (const hash of torrentHashes(release)) {
      const ownNames = new Set(catalogs.filter(catalog => catalog.hash.toLowerCase() === hash).flatMap(catalog => catalog.files.map(file => normalizeTorrentPath(file.name))))
      const selected = release.selected_files?.filter(name => !completeScope || ownNames.has(normalizeTorrentPath(name)))
      if (release.selected_files?.length && !selected?.length) continue
      const existing = plan.get(hash)
      if (!existing) {
        plan.set(hash, { hash, category, labels: label ? [label] : [], releases: [release], ...(selected?.length ? { selectedFiles: [...new Map(selected.map(name => [normalizeTorrentPath(name), name])).values()] } : {}) })
        continue
      }
      existing.releases.push(release)
      if (label && !existing.labels.includes(label)) existing.labels.push(label)
      if (!selected?.length) delete existing.selectedFiles
      else if (existing.selectedFiles) existing.selectedFiles = [...new Map([...existing.selectedFiles, ...selected].map(name => [normalizeTorrentPath(name), name])).values()]
    }
  }
  return [...plan.values()]
}
