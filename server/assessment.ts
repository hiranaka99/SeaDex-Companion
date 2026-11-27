import { seasonTag } from '../shared/ids.js'
import type {
  ChainEntry,
  ResultItem,
  LocalItem,
  LocalSeason,
  ReleaseCandidate,
  ReleasePreferences,
  SeaDexEntry,
  ResolvedPart,
} from './types.js'
import type { TrackerMode } from '../shared/contracts.js'
import {
  effectiveSeasonParts,
  entryParts,
  exclusionReason,
  isDownloadable,
  localPartOwnership,
  seadexSlot,
  pickBest,
  scopeReleaseToPart,
  scopeReleaseToSeasonRange,
  commonBestRelease,
  orderedPartReleases,
  releaseDict,
} from './matching.js'
import { verifyPart, type PartVerification } from './verification.js'
import { sameRelease } from '../shared/releases.js'
import { sourceKeyOf } from '../shared/arr-instances.js'
import {
  DEFAULT_RELEASE_PREFERENCES,
  DEFAULT_TRACKER_MODE,
  PREFERENCE_BLOCKED_REASON,
  PRIVATE_ONLY_REASON,
  unreachableTrackerReason,
} from '../shared/settings.js'

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
  const seasonNumbers = Object.keys(item.seasons || {})
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
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
      if (offset !== chainCount)
        return currentSeason === season
          ? { entry: currentChain, seasonEpisodeOffset: 0, multiSeasonSplit: false }
          : unresolved
      const split = splits.find(part => part.season === season)
      if (split)
        return {
          entry: {
            ...currentChain,
            season,
            episodeCount: split.count,
            parts: [{ ...currentChain.parts[0], episodeCount: split.count }],
          },
          seasonEpisodeOffset: split.offset,
          multiSeasonSplit: true,
        }
      seasonIndex = splitIndex
      aligned = true
      chainIndex += 1
      continue
    }

    // Case 2: Multiple AniList sequel entries grouped into a single TVDB season (e.g. Bleach S17 -> TYBW Cours 1-4).
    const nextChainCount = Number(chain[chainIndex + 1]?.episodeCount || 0)
    if (localCount > 0 && chainCount > 0 && nextChainCount > 0 && chainCount + nextChainCount <= localCount) {
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
        const parts = mergedEntries.flatMap(entry => entryParts(entry))
        return {
          entry: {
            season,
            id: first.id,
            ids: mergedEntries.flatMap(entry => entry.ids),
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

/** Settings that change how a season is judged; a change makes earlier results incomparable. */
export interface AssessmentSettings {
  preferences: ReleasePreferences
  /** Compare library file sizes with the listed release before counting it as owned. */
  verify: boolean
  /** In public mode, releases without a public torrent are treated as unlisted. */
  trackers: TrackerMode
  /**
   * Reachable mode only: the private trackers Prowlarr has a torrent indexer for, as SeaDex names them.
   * A target on any other private tracker gives way to the best release of its season or cour that can be
   * fetched. The scan reads them once; `assessSeason` itself asks nobody.
   */
  coveredTrackers?: readonly string[]
}

export const DEFAULT_ASSESSMENT: AssessmentSettings = {
  preferences: DEFAULT_RELEASE_PREFERENCES,
  verify: true,
  trackers: DEFAULT_TRACKER_MODE,
}
export { PREFERENCE_BLOCKED_REASON, PRIVATE_ONLY_REASON }

const groupKey = (group: string) => group.trim().toLowerCase()
// A listing can lack its tracker name; such a release is on no tracker Prowlarr covers.
const trackerKey = (tracker: string) =>
  String(tracker || '')
    .trim()
    .toLowerCase()

/** Everything one season's recommendation is computed from. */
export interface SeasonAssessment {
  item: LocalItem
  season: number
  local: LocalSeason
  /** The title's AniList entries in season order. */
  chain: ChainEntry[]
  /** SeaDex entries by AniList ID. */
  best: Map<number, SeaDexEntry>
  libraryKey: string
  /** The user's manual title match, when there is one. */
  mappingId?: number
  arrUrl: string | null
  /** The user's manual match for this season, which replaces the automatic chain entry. */
  override?: { entry: ChainEntry | null; groupId: number | null; ids: number[] }
  /** Release preferences and ownership verification; defaults apply when omitted. */
  settings?: AssessmentSettings
}

export function assessSeason({
  item,
  season,
  local,
  chain,
  best,
  libraryKey,
  mappingId,
  arrUrl,
  override,
  settings = DEFAULT_ASSESSMENT,
}: SeasonAssessment): ResultItem {
  const localGroups: string[] = local.groups
  const automatic = resolveSeasonChainEntry(item, season, chain)
  const sameContinuousEntry =
    override?.entry &&
    automatic.multiSeasonSplit &&
    override.entry.ids.length === 1 &&
    override.entry.id === automatic.entry?.id
  const { entry, seasonEpisodeOffset, multiSeasonSplit } = override
    ? {
        entry: sameContinuousEntry ? automatic.entry : override.entry,
        seasonEpisodeOffset: sameContinuousEntry ? automatic.seasonEpisodeOffset : 0,
        multiSeasonSplit: Boolean(sameContinuousEntry),
      }
    : automatic
  const groupId = override ? override.groupId : (chain[0]?.id ?? null)
  // Results of an additional instance carry its key prefix, so the same anime in two libraries stays two results.
  const source = sourceKeyOf(item)
  const instance = item.instance
    ? { instance: item.instance, ...(item.instance_name ? { instance_name: item.instance_name } : {}) }
    : {}
  // Sonarr's own search terms for this season: titles for every season, and those of this season.
  const sceneTitles = [
    ...new Set(
      (item.alternate_titles || [])
        .filter(alternate => alternate.season === null || alternate.season === season)
        .map(alternate => alternate.title)
        .filter(title => title.toLowerCase() !== item.title.toLowerCase()),
    ),
  ].slice(0, 10)
  const searchTitles = sceneTitles.length ? { search_titles: sceneTitles } : {}
  if (!entry) {
    return {
      key: `${source}:item${item.id}:${season}:missing`,
      ...searchTitles,
      group_id: groupId,
      arr: item.arr,
      ...instance,
      title: item.title,
      season,
      library_key: libraryKey,
      mapping_override: Boolean(mappingId),
      season_mapping_override: Boolean(override),
      ...(override ? { anilist_ids: override.ids } : {}),
      status: 'missing',
      match_status: 'unmatched',
      have: [...localGroups].sort(),
      local_size: local.size || 0,
      missing_episode_count: local.missing_episode_count,
      best_group: null,
      best_size: 0,
      releases: [],
      url: null,
      notes: 'No AniList season match was found. Review the title mapping before downloading.',
      image: chain[0]?.cover || null,
      banner: chain[0]?.banner || null,
      anilist_id: null,
      arr_url: arrUrl,
    }
  }
  const alid = entry.id
  // A movie is a single file, so a per-episode size limit says nothing about it.
  const preferences = season === 0 ? { ...settings.preferences, max_episode_gb: 0 } : settings.preferences
  const parts = effectiveSeasonParts(local, entryParts(entry))
  const partOwnership = localPartOwnership(local, parts)
  const common: Omit<ResultItem, 'key' | 'status' | 'best_group' | 'best_size' | 'releases'> = {
    group_id: groupId,
    arr: item.arr,
    ...instance,
    title: item.title,
    ...searchTitles,
    season,
    have: [...localGroups].sort(),
    match_status: 'matched',
    missing_episode_count: local.missing_episode_count,
    library_key: libraryKey,
    mapping_override: Boolean(mappingId),
    season_mapping_override: Boolean(override),
    have_by_part: partOwnership.have,
    owned_by_part: partOwnership.owned,
    precise_part_ownership: partOwnership.precise,
    local_size_by_part: partOwnership.sizes,
    local_size: local.size || 0,
    url: null,
    notes: null,
    image: entry.cover || null,
    banner: entry.banner || null,
    anilist_id: alid,
    arr_url: arrUrl,
  }
  const resolved: ResolvedPart[] = []
  const resolvedOutcome: number[] = []
  const sources: { label: string; url: string }[] = []
  const unavailableParts: { label: string; reason: string }[] = []
  const outcomes: ('missing' | 'uncovered' | 'resolved')[] = []
  const partName = (label: string | null) => label || (season ? seasonTag(season) : 'Movie')
  // Reachable mode: a private-tracker release can only be fetched where Prowlarr has an indexer for its tracker.
  const coveredTrackers = new Set((settings.coveredTrackers || []).map(trackerKey))
  const unreachable = (release: ReleaseCandidate) =>
    settings.trackers === 'reachable' && !isDownloadable(release) && !coveredTrackers.has(trackerKey(release.tracker))
  /** The private-tracker release each part's target replaced because Prowlarr cannot reach its tracker. */
  const displaced = new Map<ResolvedPart, ReleaseCandidate>()
  let episodeOffset = seasonEpisodeOffset
  for (const [partIndex, part] of parts.entries()) {
    const currentEpisodeOffset = episodeOffset
    episodeOffset += Number(part.episodeCount || 0)
    const label = parts.length > 1 ? `Cour ${partIndex + 1}` : null
    const source = best.get(part.id)
    if (!source) {
      outcomes.push('missing')
      unavailableParts.push({ label: partName(label), reason: 'Not listed on SeaDex' })
      continue
    }
    sources.push({ label: label || 'seadex.moe', url: source.url })
    const slot = seadexSlot(source, season)
    if (!slot) {
      outcomes.push('uncovered')
      unavailableParts.push({ label: partName(label), reason: 'No releases available on SeaDex' })
      continue
    }
    const slotCandidates = multiSeasonSplit
      ? slot.candidates.flatMap(candidate => {
          const episodeNumbers =
            part.episodeNumbers || Array.from({ length: Number(part.episodeCount || 0) }, (_, index) => index + 1)
          const scoped = scopeReleaseToSeasonRange(candidate, episodeNumbers, currentEpisodeOffset, season)
          return scoped ? [scoped] : []
        })
      : slot.candidates
    // Public-tracker mode treats a release nobody can fetch without a private-tracker account as unlisted,
    // unless the library already holds it: then it stays listed, so your own release is recognized, but never targeted.
    const publicOnly = settings.trackers === 'public'
    const ownedGroups = new Set((partOwnership.owned[label || ''] || []).map(groupKey))
    const publicCandidates = publicOnly ? slotCandidates.filter(isDownloadable) : slotCandidates
    const ownedPrivate = publicOnly
      ? slotCandidates.filter(
          candidate => !isDownloadable(candidate) && ownedGroups.has(groupKey(candidate.releaseGroup)),
        )
      : []
    if (slotCandidates.length && !publicCandidates.length && !ownedPrivate.length) {
      outcomes.push('uncovered')
      unavailableParts.push({ label: partName(label), reason: PRIVATE_ONLY_REASON })
      continue
    }
    // The catalog is shared between library titles, so exclusions are noted on copies.
    const noteExclusion = (candidate: ReleaseCandidate): ReleaseCandidate => {
      const reason = exclusionReason(candidate, part.episodeCount, preferences)
      return reason ? { ...candidate, excluded_by: reason } : candidate
    }
    const eligibleCandidates = (publicCandidates.length ? publicCandidates : ownedPrivate).map(noteExclusion)
    let [selected, alternatives] = pickBest(eligibleCandidates, part.episodeCount, preferences)
    // When the preferences exclude every release, SeaDex's own pick still shows what the library holds.
    const blocked = !selected && eligibleCandidates.length > 0
    if (blocked) [selected, alternatives] = pickBest(eligibleCandidates, part.episodeCount)
    if (publicCandidates.length) alternatives = [...alternatives, ...ownedPrivate.map(noteExclusion)]
    // Reachable mode: a target Prowlarr cannot fetch gives way to the pick among the releases that can be fetched,
    // public ones and those on a covered tracker: a best-flagged one, or an alternative when none is flagged.
    // Where SeaDex lists nothing else that can be fetched, the target stays.
    let replaced: ReleaseCandidate | undefined
    if (selected && !blocked && unreachable(selected)) {
      const chosen = selected
      const [replacement] = pickBest(
        eligibleCandidates.filter(candidate => !unreachable(candidate)),
        part.episodeCount,
        preferences,
      )
      if (replacement) {
        // The same release on a covered tracker is listed as one release with the chosen one. Any other pick
        // leaves the chosen release listed, where it says why it is not the target.
        if (!sameRelease(replacement, chosen, true))
          replaced = { ...chosen, excluded_by: unreachableTrackerReason(chosen.tracker) }
        selected = replacement
        alternatives = eligibleCandidates
          .filter(candidate => candidate !== replacement)
          .map(candidate => (candidate === chosen ? replaced || chosen : candidate))
      }
    }
    if (!selected) {
      outcomes.push('uncovered')
      unavailableParts.push({
        label: partName(label),
        reason: multiSeasonSplit ? 'No releases available on SeaDex' : 'No release candidates available',
      })
      continue
    }
    resolvedOutcome.push(outcomes.length)
    outcomes.push('resolved')
    resolved.push({
      label,
      source,
      best: multiSeasonSplit
        ? selected
        : scopeReleaseToPart(selected, part.episodeCount, partIndex, parts.length, currentEpisodeOffset, season),
      alts: alternatives.map(release =>
        multiSeasonSplit
          ? release
          : scopeReleaseToPart(release, part.episodeCount, partIndex, parts.length, currentEpisodeOffset, season),
      ),
      ...(blocked ? { blocked } : {}),
      ...(part.episodeNumbers ? { episodeNumbers: part.episodeNumbers } : {}),
    })
    const resolvedPart = resolved[resolved.length - 1]
    if (replaced) displaced.set(resolvedPart, resolvedPart.alts[alternatives.indexOf(replaced)])
  }
  common.urls = sources
  common.anilist_ids = parts.map(part => part.id)
  common.unavailable_parts = unavailableParts
  // Flagged only while private trackers are the sole reason a part is unavailable.
  const notePrivateOnly = () => {
    if (unavailableParts.length && unavailableParts.every(part => part.reason === PRIVATE_ONLY_REASON))
      common.private_only = true
    else delete common.private_only
  }
  notePrivateOnly()
  common.notes_by_part = Object.fromEntries(resolved.map(part => [part.label || '', part.source.notes || '-']))
  if (sources.length) {
    common.url = sources[0].url
    const notes = [...new Set(resolved.map(part => part.source.notes || '-').filter(note => note !== '-'))]
    common.notes = notes.length ? notes.join('\n') : '-'
  }
  if (!resolved.length) {
    const status = outcomes.includes('missing') ? 'missing' : 'uncovered'
    return {
      ...common,
      key: `${source}:${alid}:${season}:${status}`,
      status,
      best_group: null,
      best_size: 0,
      releases: [],
    }
  }

  // Ownership: release group names, corrected by the file-size fingerprint of each listed release.
  const candidatesOf = (part: ResolvedPart) => [part.best, ...part.alts]
  const verification = resolved.map((part): PartVerification =>
    settings.verify && (parts.length === 1 || part.episodeNumbers)
      ? verifyPart(local, part.episodeNumbers, partOwnership.owned[part.label || ''] || [], candidatesOf(part))
      : { verified: [], mismatched: [], other: [], matches: [] },
  )
  const ownedByPart = resolved.map((part, index) => {
    const owned = new Set<string>((partOwnership.owned[part.label || ''] || []).map(groupKey))
    // Holding another of a group's releases is not holding the group's best release.
    for (const group of [...verification[index].mismatched, ...verification[index].other]) owned.delete(groupKey(group))
    for (const group of verification[index].verified) owned.add(groupKey(group))
    return owned
  })
  const byPart = (pick: (index: number) => string[]) =>
    Object.fromEntries(
      resolved.flatMap((part, index) => (pick(index).length ? [[part.label || '', [...pick(index)].sort()]] : [])),
    )
  const verifiedByPart = byPart(index => verification[index].verified)
  const mismatchedByPart = byPart(index => verification[index].mismatched)
  if (Object.keys(verifiedByPart).length) common.verified_by_part = verifiedByPart
  if (Object.keys(mismatchedByPart).length) common.mismatched_by_part = mismatchedByPart

  // SeaDex marks its picks as best; an unmarked listing treats the chosen release as its best.
  // A release that gave way in reachable mode was that choice, so it keeps the kind it has in private mode.
  const isBestKind = (part: ResolvedPart, release: ReleaseCandidate) =>
    release.is_best ||
    (!candidatesOf(part).some(candidate => candidate.is_best) &&
      [part.best, displaced.get(part)].some(
        chosen => chosen && groupKey(release.releaseGroup) === groupKey(chosen.releaseGroup),
      ))
  // The pick that replaced an unreachable release is what the part is judged against, whatever its kind.
  const replacesUnreachable = (part: ResolvedPart, release: ReleaseCandidate) =>
    displaced.has(part) && sameRelease(release, part.best, true)
  const settlingGroups = (part: ResolvedPart): Set<string> =>
    preferences.strict && !part.blocked
      ? new Set([groupKey(part.best.releaseGroup)])
      : new Set(
          candidatesOf(part)
            .filter(
              release =>
                isBestKind(part, release) || preferences.accept_alternatives || replacesUnreachable(part, release),
            )
            .map(release => groupKey(release.releaseGroup)),
        )
  // A group can list several releases, so a release settles its part by itself, not by its group name.
  const releaseSettles = (part: ResolvedPart, release: ReleaseCandidate) =>
    preferences.strict && !part.blocked
      ? sameRelease(release, part.best, true)
      : preferences.accept_alternatives ||
        replacesUnreachable(part, release) ||
        candidatesOf(part).some(listing => isBestKind(part, listing) && sameRelease(listing, release, true))
  const settled = resolved.map(
    (part, index) =>
      [...settlingGroups(part)].some(group => ownedByPart[index].has(group)) ||
      verification[index].matches.some(release => releaseSettles(part, release)),
  )
  // A part whose releases are all excluded has nothing to offer unless the library already settles it.
  const dormant = resolved.map((part, index) => Boolean(part.blocked) && !settled[index])
  resolved.forEach((part, index) => {
    if (!dormant[index]) return
    outcomes[resolvedOutcome[index]] = 'uncovered'
    unavailableParts.push({ label: partName(part.label), reason: PREFERENCE_BLOCKED_REASON })
  })
  notePrivateOnly()
  const listReleases = (part: ResolvedPart, primary: ReleaseCandidate) => {
    const matches = verification[resolved.indexOf(part)].matches
    return orderedPartReleases(primary, part.alts).map(([, release]) => {
      const kind = isBestKind(part, release) ? 'best' : 'alt'
      const satisfies = releaseSettles(part, release)
      return releaseDict(kind, release, part.label, part.source.url, {
        // A private-tracker release is never a public-tracker mode target, even when it is all the library holds.
        // Nor is the release Prowlarr cannot reach, whose place another release took.
        target:
          !part.blocked &&
          release !== displaced.get(part) &&
          sameRelease(release, part.best, true) &&
          (settings.trackers !== 'public' || isDownloadable(release)),
        // Stored only where it departs from the kind, which is what older results imply.
        ...(satisfies !== (kind === 'best') ? { satisfies } : {}),
        ...(matches.some(match => sameRelease(match, release)) ? { files_match: true } : {}),
      })
    })
  }
  const active = resolved.filter((_, index) => !dormant[index])
  if (!active.length) {
    const status = outcomes.includes('missing') ? 'missing' : 'uncovered'
    return {
      ...common,
      key: `${source}:${alid}:${season}:${status}`,
      status,
      best_group: null,
      best_size: 0,
      preference_blocked: true,
      releases: resolved.flatMap(part => listReleases(part, part.best)),
    }
  }
  const partiallyResolved = outcomes.some(outcome => outcome !== 'resolved')
  const bestGroups = [...new Set(active.map(part => part.best.releaseGroup))]
  let bestGroup = bestGroups.join(' + ')
  let bestSize = active.reduce((sum, part) => sum + (part.best.size || 0), 0)
  let ownsAllBest = resolved.every((_, index) => dormant[index] || settled[index])
  const activeOwned = resolved.flatMap((_, index) => (dormant[index] ? [] : [ownedByPart[index]]))
  const commonOwnedGroups = [
    ...activeOwned
      .slice(1)
      .reduce((commonGroups, groups) => new Set([...commonGroups].filter(group => groups.has(group))), activeOwned[0]),
  ]
  let commonBest = commonBestRelease(active, new Set(commonOwnedGroups))
  // In strict mode only the targeted release settles a part, so a shared batch must be that target.
  if (
    commonBest &&
    preferences.strict &&
    !active.every(part => part.blocked || groupKey(part.best.releaseGroup) === groupKey(commonBest!.releaseGroup))
  )
    commonBest = null
  if (commonBest) {
    bestGroup = commonBest.releaseGroup
    bestSize = commonBest.size || 0
    ownsAllBest = true
  }
  const releases = resolved.flatMap((part, index) =>
    listReleases(part, !dormant[index] && !partiallyResolved && ownsAllBest ? commonBest || part.best : part.best),
  )
  const status = partiallyResolved ? 'partial' : ownsAllBest ? 'best' : 'upgrade'
  return {
    ...common,
    key: `${source}:${alid}:${season}:${bestGroup}`,
    status,
    ...(partiallyResolved ? { upgrade_available: !ownsAllBest } : {}),
    ...(dormant.some(Boolean) ? { preference_blocked: true } : {}),
    best_group: bestGroup,
    best_size: bestSize,
    releases,
  }
}
