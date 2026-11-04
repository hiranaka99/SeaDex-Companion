import type { ChainEntry, ResultItem, LocalItem, LocalSeason, SeaDexEntry, ResolvedPart } from './types.js'
import { effectiveSeasonParts, entryParts, localPartOwnership, seadexSlot, pickBest, scopeReleaseToPart, scopeReleaseToSeasonRange, partBestGroups, commonBestRelease, orderedPartReleases, releaseDict } from './matching.js'

export interface ResolvedSeasonChain {
  entry: ChainEntry | undefined
  seasonEpisodeOffset: number
  multiSeasonSplit: boolean
}

function localSeasonEpisodeCount(local?: LocalSeason): number {
  if (!local) return 0
  const count = local.episode_count
  if (Number.isSafeInteger(count) && Number(count) > 0) return Number(count)
  return new Set((local.episode_numbers || []).filter(number => Number.isSafeInteger(number) && number > 0)).size
}

export function resolveSeasonChainEntry(item: LocalItem, season: number, chain: ChainEntry[]): ResolvedSeasonChain {
  if (season === 0) return { entry: chain[0], seasonEpisodeOffset: 0, multiSeasonSplit: false }
  const seasonNumbers = Object.keys(item.seasons || {}).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
  if (seasonNumbers[0] !== 1 || !seasonNumbers.includes(season)) {
    return { entry: chain.find(entry => entry.season === season), seasonEpisodeOffset: 0, multiSeasonSplit: false }
  }
  let chainIndex = 0
  let seasonIndex = 0
  let aligned = false
  const unresolved = { entry: undefined, seasonEpisodeOffset: 0, multiSeasonSplit: false }
  while (seasonIndex < seasonNumbers.length && chainIndex < chain.length) {
    const currentSeason = seasonNumbers[seasonIndex]
    const localCount = localSeasonEpisodeCount(item.seasons[currentSeason])
    const currentChain = chain[chainIndex]
    const chainCount = Number(currentChain?.episodeCount || 0)
    const nextSeason = seasonNumbers[seasonIndex + 1]
    const nextLocalCount = nextSeason !== undefined ? localSeasonEpisodeCount(item.seasons[nextSeason]) : 0
    if (currentSeason !== seasonIndex + 1 || (aligned && (!localCount || !chainCount))) return unresolved

    // Case 1: One continuous AniList entry split across multiple TVDB seasons (e.g. Bleach S01-S16 -> 269).
    if (
      currentChain.parts.length === 1 &&
      chainCount > 0 &&
      localCount > 0 &&
      nextLocalCount > 0 &&
      localCount + nextLocalCount <= chainCount
    ) {
      let offset = 0
      let splitIndex = seasonIndex
      const splits: { season: number; count: number; offset: number }[] = []
      while (splitIndex < seasonNumbers.length) {
        const splitSeason = seasonNumbers[splitIndex]
        const splitCount = localSeasonEpisodeCount(item.seasons[splitSeason])
        if (splitSeason !== splitIndex + 1 || splitCount <= 0 || offset + splitCount > chainCount) break
        splits.push({ season: splitSeason, count: splitCount, offset })
        offset += splitCount
        splitIndex += 1
        if (offset === chainCount) break
      }
      // A partial sum cannot establish that TVDB split a continuous entry.
      // The first season retains its title anchor; later seasons need review.
      if (offset !== chainCount) return currentSeason === season ? { entry: currentChain, seasonEpisodeOffset: 0, multiSeasonSplit: false } : unresolved
      const split = splits.find(part => part.season === season)
      if (split) return {
        entry: { ...currentChain, season, episodeCount: split.count, parts: [{ ...currentChain.parts[0], episodeCount: split.count }] },
        seasonEpisodeOffset: split.offset, multiSeasonSplit: true,
      }
      seasonIndex = splitIndex
      aligned = true
      chainIndex += 1
      continue
    }

    // Case 2: Multiple AniList sequel entries grouped into a single TVDB season (e.g. Bleach S17 -> TYBW Cours 1-4).
    const nextChainCount = Number(chain[chainIndex + 1]?.episodeCount || 0)
    if (
      localCount > 0 &&
      chainCount > 0 &&
      nextChainCount > 0 &&
      chainCount + nextChainCount <= localCount
    ) {
      const mergedEntries: ChainEntry[] = []
      let mergedEpisodes = 0
      let mergeIndex = chainIndex
      while (mergeIndex < chain.length) {
        const candidate = chain[mergeIndex]
        const candidateCount = Number(candidate?.episodeCount || 0)
        if (candidateCount <= 0 || mergedEpisodes + candidateCount > localCount) break
        mergedEntries.push(candidate)
        mergedEpisodes += candidateCount
        mergeIndex += 1
      }
      if (mergedEpisodes === localCount && currentSeason === season) {
        const first = mergedEntries[0]
        const parts = mergedEntries.flatMap((entry) => entryParts(entry))
        return {
          entry: {
            season,
            id: first.id,
            ids: mergedEntries.flatMap((entry) => entry.ids),
            parts,
            cover: first.cover,
            banner: first.banner,
            episodeCount: mergedEpisodes,
          },
          seasonEpisodeOffset: 0,
          multiSeasonSplit: false,
        }
      }
      if (mergedEpisodes === localCount) {
        chainIndex = mergeIndex
        seasonIndex += 1
        aligned = true
        continue
      }
    }

    if (currentSeason === season) {
      return { entry: currentChain, seasonEpisodeOffset: 0, multiSeasonSplit: false }
    }
    if (nextSeason !== undefined && !nextLocalCount && chainCount > localCount) return unresolved
    seasonIndex += 1
    chainIndex += 1
  }
  return { entry: undefined, seasonEpisodeOffset: 0, multiSeasonSplit: false }
}

export function assessSeason(item: LocalItem, season: number, local: LocalSeason, chain: ChainEntry[], best: Map<number, SeaDexEntry>, libraryKey: string, mappingId: number | undefined, arrUrl: string | null, override?: { entry: ChainEntry | null; groupId: number | null; ids: number[] }): ResultItem {
  const localGroups: string[] = local.groups
  const automatic = resolveSeasonChainEntry(item, season, chain)
  const sameContinuousEntry = override?.entry && automatic.multiSeasonSplit && override.entry.ids.length === 1 && override.entry.id === automatic.entry?.id
  const { entry, seasonEpisodeOffset, multiSeasonSplit } = override
    ? { entry: override.entry, seasonEpisodeOffset: sameContinuousEntry ? automatic.seasonEpisodeOffset : 0, multiSeasonSplit: Boolean(sameContinuousEntry) }
    : automatic
  const groupId = override ? override.groupId : chain[0]?.id ?? null
  if (!entry) {
    return {
      key: `${item.arr}:item${item.id}:${season}:missing`, group_id: groupId,
      arr: item.arr, title: item.title, season, library_key: libraryKey, mapping_override: Boolean(mappingId),
      season_mapping_override: Boolean(override), ...(override ? { anilist_ids: override.ids } : {}),
      status: 'missing', match_status: 'unmatched', have: [...localGroups].sort(), local_size: local.size || 0,
      missing_episode_count: local.missing_episode_count, best_group: null, best_size: 0, releases: [],
      url: null, notes: 'No AniList season match was found. Review the title mapping before downloading.',
      image: chain[0]?.cover || null, banner: chain[0]?.banner || null, anilist_id: null, arr_url: arrUrl,
    }
  }
  const alid = entry.id
  const parts = effectiveSeasonParts(local, entryParts(entry))
  const partOwnership = localPartOwnership(local, parts)
  const common: Omit<ResultItem, 'key' | 'status' | 'best_group' | 'best_size' | 'releases'> = {
    group_id: groupId, arr: item.arr, title: item.title, season, have: [...localGroups].sort(),
    match_status: 'matched', missing_episode_count: local.missing_episode_count,
    library_key: libraryKey, mapping_override: Boolean(mappingId),
    season_mapping_override: Boolean(override),
    have_by_part: partOwnership.have, owned_by_part: partOwnership.owned, precise_part_ownership: partOwnership.precise,
    local_size_by_part: partOwnership.sizes,
    local_size: local.size || 0, url: null, notes: null, image: entry.cover || null,
    banner: entry.banner || null, anilist_id: alid, arr_url: arrUrl,
  }
  const resolved: ResolvedPart[] = []
  const sources: { label: string; url: string }[] = []
  const unavailableParts: { label: string; reason: string }[] = []
  const outcomes: ('missing' | 'uncovered' | 'resolved')[] = []
  let episodeOffset = seasonEpisodeOffset
  for (const [partIndex, part] of parts.entries()) {
    const currentEpisodeOffset = episodeOffset
    episodeOffset += Number(part.episodeCount || 0)
    const label = parts.length > 1 ? `Cour ${partIndex + 1}` : null
    const source = best.get(part.id)
    if (!source) {
      outcomes.push('missing')
      unavailableParts.push({ label: label || (season ? `S${String(season).padStart(2, '0')}` : 'Movie'), reason: 'Not listed on SeaDex' })
      continue
    }
    sources.push({ label: label || 'seadex.moe', url: source.url })
    const slot = seadexSlot(source, season)
    if (!slot) {
      outcomes.push('uncovered')
      unavailableParts.push({ label: label || (season ? `S${String(season).padStart(2, '0')}` : 'Movie'), reason: 'No releases available on SeaDex' })
      continue
    }
    const eligibleCandidates = multiSeasonSplit
      ? slot.candidates.flatMap(candidate => {
        const episodeNumbers = part.episodeNumbers || Array.from({ length: Number(part.episodeCount || 0) }, (_, index) => index + 1)
        const scoped = scopeReleaseToSeasonRange(candidate, episodeNumbers, currentEpisodeOffset, season)
        return scoped ? [scoped] : []
      })
      : slot.candidates
    const [selected, alternatives] = pickBest(eligibleCandidates, part.episodeCount)
    if (!selected) {
      outcomes.push('uncovered')
      unavailableParts.push({ label: label || (season ? `S${String(season).padStart(2, '0')}` : 'Movie'), reason: multiSeasonSplit ? 'No releases available on SeaDex' : 'No release candidates available' })
      continue
    }
    outcomes.push('resolved')
    resolved.push({
      label,
      source,
      best: multiSeasonSplit ? selected : scopeReleaseToPart(selected, part.episodeCount, partIndex, parts.length, currentEpisodeOffset, season),
      alts: alternatives.map((release) => multiSeasonSplit ? release : scopeReleaseToPart(release, part.episodeCount, partIndex, parts.length, currentEpisodeOffset, season)),
    })
  }
  common.urls = sources
  common.anilist_ids = parts.map((part) => part.id)
  common.unavailable_parts = unavailableParts
  common.notes_by_part = Object.fromEntries(resolved.map((part) => [part.label || '', part.source.notes || '-']))
  if (sources.length) {
    common.url = sources[0].url
    const notes = [...new Set(resolved.map((part) => part.source.notes || '-').filter((note) => note !== '-'))]
    common.notes = notes.length ? notes.join('\n') : '-'
  }
  if (!resolved.length) {
    const status = outcomes.includes('missing') ? 'missing' : 'uncovered'
    return { ...common, key: `${item.arr}:${alid}:${season}:${status}`, status, best_group: null, best_size: 0, releases: [] }
  }
  const partiallyResolved = outcomes.some(outcome => outcome !== 'resolved')
  const bestGroups = [...new Set(resolved.map((part) => part.best.releaseGroup))]
  let bestGroup = bestGroups.join(' + ')
  let bestSize = resolved.reduce((sum, part) => sum + (part.best.size || 0), 0)
  const localGroupKeys = new Set(localGroups.map((group) => group.toLowerCase()))
  const fullyOwnedByPart = resolved.map((part) => new Set<string>((partOwnership.owned[part.label || ''] || []).map((group) => group.toLowerCase())))
  let ownsAllBest = resolved.every((part, index) => [...partBestGroups(part)].some((group) => fullyOwnedByPart[index].has(group)))
  const commonOwnedGroups = fullyOwnedByPart.length
    ? [...fullyOwnedByPart.slice(1).reduce((commonGroups, groups) => new Set([...commonGroups].filter((group) => groups.has(group))), fullyOwnedByPart[0])]
    : [...localGroupKeys]
  const commonBest = commonBestRelease(resolved, new Set(commonOwnedGroups))
  if (commonBest) { bestGroup = commonBest.releaseGroup; bestSize = commonBest.size || 0; ownsAllBest = true }
  const releases = resolved.flatMap(part => orderedPartReleases(!partiallyResolved && ownsAllBest ? commonBest || part.best : part.best, part.alts).map(([kind, release]) => releaseDict(kind, release, part.label, part.source.url)))
  const status = partiallyResolved ? 'partial' : ownsAllBest ? 'best' : 'upgrade'
  return { ...common, key: `${item.arr}:${alid}:${season}:${bestGroup}`, status, ...(partiallyResolved ? { upgrade_available: !ownsAllBest } : {}), best_group: bestGroup, best_size: bestSize, releases }
}
