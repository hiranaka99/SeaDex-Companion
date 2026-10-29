import { normalizeTorrentPath, torrentHashes } from '../shared/download-plan.js'
import type { ReleaseCandidate, Release, ChainPart, ChainEntry, LocalSeason, SeaDexEntry, SeaDexSlot, ResolvedPart } from './types.js'

export function isDownloadable(release: Pick<ReleaseCandidate, 'info_hashes'>): boolean {
  return torrentHashes(release).length > 0
}

export function pickBest(candidates: ReleaseCandidate[], episodeCount?: number | null): [ReleaseCandidate | null, ReleaseCandidate[]] {
  if (!candidates.length) return [null, []]
  const flagged = candidates.filter((candidate) => candidate.is_best)
  let pool = flagged.length ? flagged : [...candidates]
  if (episodeCount && episodeCount > 0) {
    const matching = pool.filter((candidate) => candidate.file_count === episodeCount)
    if (matching.length) pool = matching
  }
  const downloadable = pool.filter(isDownloadable)
  const selectedPool = downloadable.length ? downloadable : pool
  const chosen = selectedPool.reduce((best, candidate) => (candidate.size || 0) > (best.size || 0) ? candidate : best)
  return [chosen, candidates.filter((candidate) => candidate !== chosen)]
}

export interface ParsedEpisode {
  episode: number
  season: number | null
  explicit: boolean
}

export function episodeFromFilename(name: string): ParsedEpisode | null {
  const filename = name.split(/[\\/]/).at(-1) || ''
  if (!/\.(?:mkv|mp4|avi|m4v|ts|webm)$/i.test(filename) || /NCOP|NCED/i.test(filename)) return null
  const standard = filename.match(/S(\d{1,3})E(\d{1,3}(?:\.\d+)?)/i)
  if (standard) return { season: Number(standard[1]), episode: Number(standard[2]), explicit: true }
  const named = filename.match(/\b(?:Episode|Ep\.?)\s*[._-]*\s*(\d{1,3}(?:\.\d+)?)(?=[ ._[\]()-]|$)/i)
  if (named) return { season: null, episode: Number(named[1]), explicit: true }
  // Unlabelled absolute episode numbers are common in whole-season encodes.
  // Only use these when no explicitly numbered episodes exist in the torrent.
  const absolute = filename.match(/(?:^|[\s_-])(\d{1,3}(?:\.\d+)?)(?=[\s(.\]]|$)/)
  return absolute ? { season: null, episode: Number(absolute[1]), explicit: false } : null
}

function extraBelongsToPart(name: string, partNumber: number): boolean {
  const padded = String(partNumber).padStart(2, '0')
  return new RegExp(`(?:P(?:art)?[ ._-]*0?${partNumber}\\b.*(?:NCOP|NCED)|(?:NCOP|NCED)[ ._-]*${padded}\\b)`, 'i').test(name)
}

/**
 * Restrict downloads to regular episodes. For split cours this also scopes a
 * whole-season torrent to the current cour; for normal seasons it removes
 * specials, extras, and other files when the full episode set is identifiable.
 */
export function scopeReleaseToPart(
  release: ReleaseCandidate,
  episodeCount: number | null | undefined,
  partIndex: number,
  partCount: number,
  episodeOffset?: number,
  targetSeason?: number,
): ReleaseCandidate {
  const files = release.source_files || []
  if (!episodeCount || episodeCount <= 0 || !files.length) return release

  const parsedFiles = files.map((file) => ({ file, parsed: episodeFromFilename(file.name) }))
  const hasExplicitEpisodes = parsedFiles.some(({ parsed }) => parsed?.explicit)
  const parsed = hasExplicitEpisodes
    ? parsedFiles.map((item) => item.parsed?.explicit ? item : { ...item, parsed: null })
    : parsedFiles
  const seasonFrequency = new Map<number, number>()
  for (const item of parsed) {
    const season = item.parsed?.season
    if (season && season > 0 && Number.isInteger(item.parsed?.episode)) seasonFrequency.set(season, (seasonFrequency.get(season) || 0) + 1)
  }
  // A positive SxxE season wins when present; otherwise the torrent uses absolute
  // numbering (season null) and we scope on those files, ignoring S00 specials.
  const primarySeason = targetSeason !== undefined && seasonFrequency.has(targetSeason)
    ? targetSeason
    : [...seasonFrequency].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  const inScope = (season: number | null): boolean => primarySeason !== null ? season === primarySeason : season === null
  const episodeNumbers = [...new Set(
    parsed
      .filter((item) => item.parsed && Number.isInteger(item.parsed.episode) && inScope(item.parsed.season))
      .map((item) => item.parsed!.episode),
  )].sort((left, right) => left - right)
  const splitSeason = partCount > 1
  if (episodeNumbers.length < episodeCount) return release

  // A part-sized upload is already scoped to its cour, even when its episode
  // numbering starts at one. Only apply the offset to larger season batches.
  const start = (splitSeason || (episodeOffset ?? 0) > 0) && episodeNumbers.length > episodeCount
    ? (episodeOffset ?? partIndex * episodeCount)
    : 0
  const selectedNumbers = episodeNumbers.slice(start, start + episodeCount)
  if (selectedNumbers.length < episodeCount) return release
  const selected = new Set(selectedNumbers)
  const partNumber = partIndex + 1
  const selectedEpisodeFiles = parsed.filter(({ parsed: episode }) =>
    episode && selected.has(episode.episode) && inScope(episode.season),
  )
  const selectedEpisodeFileSet = new Set(selectedEpisodeFiles.map(({ file }) => file))
  // The catalog may already have narrowed source_files to one season/cour while
  // the underlying torrent still contains other seasons or extras.
  const selectedPaths = new Set(selectedEpisodeFiles.map(({ file }) => normalizeTorrentPath(file.name)))
  const hasOtherTorrentFiles = release.torrent_files?.some(catalog =>
    catalog.files.some(file => !selectedPaths.has(normalizeTorrentPath(file.name))))
  if (selectedEpisodeFiles.length === files.length && !hasOtherTorrentFiles) return release
  if (!splitSeason) {
    return {
      ...release,
      size: selectedEpisodeFiles.reduce((total, { file }) => total + file.length, 0),
      file_count: selectedNumbers.length,
      selected_files: selectedEpisodeFiles.map(({ file }) => file.name),
    }
  }
  const scopedFiles = parsed.filter(({ file, parsed: episode }) =>
    selectedEpisodeFileSet.has(file) ||
    (!episode && extraBelongsToPart(file.name, partNumber)),
  )
  if (!scopedFiles.length) return release

  return {
    ...release,
    size: scopedFiles.reduce((total, { file }) => total + file.length, 0),
    file_count: selectedNumbers.length,
    selected_files: selectedEpisodeFiles.map(({ file }) => file.name),
  }
}

export function releaseDict(kind: 'best' | 'alt', release: ReleaseCandidate, part?: string | null, url?: string): Release {
  const result: Release = {
    kind, releaseGroup: release.releaseGroup, tracker: release.tracker, quality: release.quality,
    tags: release.tags || [], dual_audio: Boolean(release.dual_audio), size: release.size || 0,
    info_hashes: [...(release.info_hashes || [])], downloadable: isDownloadable(release),
  }
  if (part) result.part = part
  if (url) result.url = url
  if (release.selected_files?.length) result.selected_files = [...release.selected_files]
  if (release.torrent_files?.length) result.torrent_files = release.torrent_files
  return result
}

export function seadexSlot(entry: SeaDexEntry, season: number): SeaDexSlot | null {
  const direct = entry.seasons?.[season]
  if (direct?.candidates?.length) return direct
  const buckets = Object.entries(entry.seasons || {}).filter(([, value]) => value.candidates?.length)
  // A single bucket may use release numbering rather than Sonarr numbering.
  // Multiple buckets explicitly distinguish seasons; guessing the nearest one
  // would offer another season's files for an uncovered mapped season.
  return buckets.length === 1 ? buckets[0][1] : null
}

export function entryParts(entry: ChainEntry): ChainPart[] {
  return entry.parts || [{ id: entry.id, episodeCount: entry.episodeCount ?? null }]
}

/**
 * AniList tells us which entries form a split season, while Sonarr's episode
 * list is sourced from TVDB and is authoritative for the episodes in it.
 */
export function effectiveSeasonParts(local: Pick<LocalSeason, 'episode_numbers'>, parts: ChainPart[]): ChainPart[] {
  const episodeNumbers = [...new Set<number>(
    (local.episode_numbers || [])
      .map(Number)
      .filter((episode: number) => Number.isInteger(episode) && episode > 0),
  )].sort((left, right) => left - right)
  if (!episodeNumbers.length || !parts.length) return parts

  if (parts.length === 1) {
    return [{ ...parts[0], episodeCount: episodeNumbers.length, episodeNumbers }]
  }

  // Earlier AniList counts define the cour boundaries. The final cour gets
  // every TVDB episode that remains, correcting stale AniList season totals.
  let offset = 0
  return parts.map((part, index) => {
    const isLast = index === parts.length - 1
    const boundaryCount = Math.max(0, Number(part.episodeCount || 0))
    const partEpisodes = isLast
      ? episodeNumbers.slice(offset)
      : episodeNumbers.slice(offset, offset + boundaryCount)
    offset += partEpisodes.length
    return { ...part, episodeCount: partEpisodes.length, episodeNumbers: partEpisodes }
  })
}

export function orderedPartReleases(best: ReleaseCandidate, alternatives: ReleaseCandidate[]): Array<['best' | 'alt', ReleaseCandidate]> {
  const byGroup = new Map<string, ReleaseCandidate>()
  for (const release of [best, ...alternatives]) {
    const key = release.releaseGroup.trim().toLowerCase()
    const current = byGroup.get(key)
    if (!current || (isDownloadable(release) && !isDownloadable(current))) byGroup.set(key, release)
  }
  const bestKey = best.releaseGroup.trim().toLowerCase()
  const ordered = [bestKey, ...[...byGroup.keys()].filter((key) => key !== bestKey)]
  return ordered.map((key) => [key === bestKey || byGroup.get(key)!.is_best ? 'best' : 'alt', byGroup.get(key)!])
}

export function commonBestRelease(resolved: Pick<ResolvedPart, 'best' | 'alts'>[], localGroups: Set<string>): ReleaseCandidate | null {
  if (resolved.length < 2) return null
  let common: Set<string> | null = null
  const releases = new Map<string, ReleaseCandidate>()
  for (const part of resolved) {
    const keys = new Set<string>()
    for (const release of [part.best, ...part.alts] as ReleaseCandidate[]) {
      if (!release.is_best || !isDownloadable(release) || !localGroups.has(release.releaseGroup.trim().toLowerCase())) continue
      const hashes = release.info_hashes.filter((hash) => /^[0-9a-f]{40}$/i.test(hash)).map((hash) => hash.toLowerCase()).sort()
      if (!hashes.length) continue
      const key = `${release.releaseGroup.trim().toLowerCase()}\0${hashes.join('\0')}`
      keys.add(key); if (!releases.has(key)) releases.set(key, release)
    }
    if (common === null) common = keys
    else {
      const intersection = new Set<string>()
      for (const key of common as Set<string>) if (keys.has(key)) intersection.add(key)
      common = intersection
    }
    if (!common.size) return null
  }
  const commonKeys = common as Set<string>
  return [...commonKeys].map((key) => releases.get(key)!).reduce<ReleaseCandidate | null>((best, release) => !best || release.size > best.size ? release : best, null)
}

export function partBestGroups(part: Pick<ResolvedPart, 'best' | 'alts'>): Set<string> {
  return new Set(orderedPartReleases(part.best, part.alts).filter(([kind]) => kind === 'best').map(([, release]) => release.releaseGroup.trim().toLowerCase()))
}

export interface PartOwnership {
  have: Record<string, string[]>
  owned: Record<string, string[]>
  sizes: Record<string, number>
  precise: boolean
}

export function localPartOwnership(local: Omit<LocalSeason, 'size'> & { size?: number }, parts: Pick<ChainPart, 'episodeCount' | 'episodeNumbers'>[]): PartOwnership {
  const groups: string[] = [...(local.groups || [])]
  const episodeEntries = Object.entries(local.groups_by_episode || {})
    .map(([group, episodes]) => [group, new Set((episodes as unknown[]).map(Number).filter((episode) => episode > 0))] as const)
    .filter(([, episodes]) => episodes.size > 0)
  const precise = episodeEntries.length > 0
  const have: Record<string, string[]> = {}
  const owned: Record<string, string[]> = {}
  const sizes: Record<string, number> = {}
  const episodeSizes = new Map(
    Object.entries(local.sizes_by_episode || {}).map(([episode, size]) => [Number(episode), Number(size || 0)]),
  )
  const hasEpisodeSizes = episodeSizes.size > 0
  let offset = 0

  for (const [index, part] of parts.entries()) {
    const label = parts.length > 1 ? `Cour ${index + 1}` : ''
    const count = Number(part.episodeCount || 0)
    const explicitEpisodes = Array.isArray(part.episodeNumbers)
      ? part.episodeNumbers.map(Number).filter((episode: number) => Number.isInteger(episode) && episode > 0)
      : null
    const expected = explicitEpisodes || Array.from({ length: count }, (_, episodeIndex) => offset + episodeIndex + 1)
    if (!precise) {
      have[label] = [...groups].sort()
      owned[label] = [...groups].sort()
      sizes[label] = parts.length > 1 ? 0 : Number(local.size || 0)
      offset += count
      continue
    }
    have[label] = episodeEntries
      .filter(([, episodes]) => expected.some((episode) => episodes.has(episode)))
      .map(([group]) => group)
      .sort()
    owned[label] = episodeEntries
      .filter(([, episodes]) => expected.length > 0 && expected.every((episode) => episodes.has(episode)))
      .map(([group]) => group)
      .sort()
    sizes[label] = expected.reduce((total, episode) => total + (episodeSizes.get(episode) || 0), 0)
    offset += count
  }
  const totalExpectedEpisodes = parts.reduce((total, part) => total + Number(part.episodeCount || 0), 0)
  const localSize = Number(local.size || 0)
  // The proportional estimate is only a stand-in for when per-episode file
  // sizes are unavailable. When episode sizes exist, a part summing to zero
  // means it is genuinely unowned, so leave it at zero.
  if (parts.length > 1 && localSize > 0 && totalExpectedEpisodes > 0 && !hasEpisodeSizes) {
    for (const [index, part] of parts.entries()) {
      const label = `Cour ${index + 1}`
      if (!sizes[label]) sizes[label] = localSize * Number(part.episodeCount || 0) / totalExpectedEpisodes
    }
  }
  return { have, owned, sizes, precise }
}
