import { titleKey } from './anilist.js'
import { sourceKeyOf } from '../shared/arr-instances.js'
import { upgradeAvailable } from '../shared/download-plan.js'
import { describeRegression, describeReleaseChanges } from '../shared/release-changes.js'
import type { ReleaseChangeDetail, ResultItem } from '../shared/contracts.js'

/** One season of the current results next to the same season in the previous results. */
export interface SeasonComparison {
  current: ResultItem
  /** The same season in the previous results, or null for a season new to the library. */
  previous: ResultItem | null
  /** What SeaDex changed about the season's releases since the previous scan. Empty for a new season. */
  releaseChanges: ReleaseChangeDetail[]
  /** How the season lost its best release through a library change. Always null in a baseline scan. */
  regression: ReleaseChangeDetail | null
}

/**
 * How one scan's results compare with the previous ones. The scan computes it once, and release changes,
 * scan history and notifications all read it, so they agree on which earlier season each season is.
 */
export interface ScanComparison {
  /**
   * The scan is a baseline scan (see the glossary): the first one, one after the results were cleared, or one
   * whose results were judged under other assessment settings. It records no release changes or regressions.
   */
  baseline: boolean
  /** There were no previous results to compare with: the first scan, or the first after clearing them. */
  firstScan: boolean
  /** One entry per current season, in the order of the current results. */
  seasons: SeasonComparison[]
  /** Previous seasons that no current season matched, in the order of the previous results. */
  removed: ResultItem[]
  /** The entry of a current season, also when given a copy of it, such as one with user rules applied again. */
  seasonOf(current: ResultItem): SeasonComparison | undefined
}

/** The season's identity in scan history: its library item, or its source and title, and its season number. */
export function resultIdentity(result: ResultItem): string {
  const base = result.library_key || `${sourceKeyOf(result)}:${result.group_id ?? result.anilist_id ?? result.title}`
  return `${base}:${result.season || 0}`
}

function titleIdentity(result: ResultItem): string {
  return `${sourceKeyOf(result)}:${titleKey(result.title || 'unknown')}:${result.season || 0}`
}

/**
 * Compares each season of a scan with the previous results. A season is the previous season with the same
 * identity, or else the previous season with the same source, title and season number whose own item is gone,
 * which is a title re-added to Sonarr or Radarr under a new item ID. Each previous season is matched once, and
 * seasons that share an identity are matched in order.
 *
 * `settingsChanged` says the results were judged under other assessment settings than the previous ones. Such
 * a baseline scan still lists each season's release changes, which history shows next to the status moves, but
 * finds no regressions: results judged under other settings say nothing about the library.
 */
export function compareScans(
  previous: ResultItem[],
  current: ResultItem[],
  options: { settingsChanged?: boolean } = {},
): ScanComparison {
  const firstScan = previous.length === 0
  const baseline = firstScan || options.settingsChanged === true
  const byKey = new Map<string, ResultItem[]>()
  for (const result of previous)
    byKey.set(resultIdentity(result), [...(byKey.get(resultIdentity(result)) || []), result])
  const currentKeys = new Set(current.map(resultIdentity))
  const byTitle = new Map<string, ResultItem[]>()
  for (const [key, results] of byKey) {
    if (currentKeys.has(key)) continue
    for (const result of results)
      byTitle.set(titleIdentity(result), [...(byTitle.get(titleIdentity(result)) || []), result])
  }
  const matched = new Set<ResultItem>()
  const seasons = current.map((result): SeasonComparison => {
    const old = byKey.get(resultIdentity(result))?.shift() || byTitle.get(titleIdentity(result))?.shift()
    if (!old) return { current: result, previous: null, releaseChanges: [], regression: null }
    matched.add(old)
    return {
      current: result,
      previous: old,
      releaseChanges: describeReleaseChanges(old, result),
      regression: baseline ? null : describeRegression(old, result),
    }
  })
  const byCurrent = new Map(seasons.map(season => [resultIdentity(season.current), season]))
  return {
    baseline,
    firstScan,
    seasons,
    removed: previous.filter(result => !matched.has(result)),
    seasonOf: result => byCurrent.get(resultIdentity(result)),
  }
}

function releaseGroupSet(result: ResultItem): Set<string> {
  return new Set(result.releases.map(release => release.releaseGroup.trim().toLowerCase()).filter(Boolean))
}

function bestQualitySummary(result: ResultItem): string {
  const qualities = result.releases
    .filter(release => release.kind === 'best')
    .map(release => release.quality.trim())
    .filter(Boolean)
  return [...new Set(qualities)].join(' / ')
}

function unavailableLabels(result: ResultItem): Set<string> {
  return new Set((result.unavailable_parts || []).map(part => part.label.trim()).filter(Boolean))
}

/** Human-readable specifics of what changed on seadex.moe between two scans of the same title. */
export function describeResultChange(previous: ResultItem | null, current: ResultItem): string[] {
  if (!previous) return ['Newly added to your library']
  const details: string[] = []
  // A season with an open upgrade was neither missing nor uncovered, whatever its stored status.
  const from = upgradeAvailable(previous) ? 'upgrade' : previous.status
  const hasReleases = current.releases.length > 0
  if (from === 'missing' && hasReleases) details.push('Now listed on seadex.moe')
  else if (from === 'uncovered' && hasReleases) details.push('Releases now available on SeaDex')
  const fromBest = (previous.best_group || '').trim()
  const toBest = (current.best_group || '').trim()
  if (toBest && toBest !== fromBest)
    details.push(fromBest ? `Best release changed: ${fromBest} → ${toBest}` : `New best release: ${toBest}`)
  const fromQuality = bestQualitySummary(previous)
  const toQuality = bestQualitySummary(current)
  if (fromQuality && toQuality && toQuality !== fromQuality)
    details.push(`Quality changed: ${fromQuality} → ${toQuality}`)
  const previousGroups = releaseGroupSet(previous)
  const newAlternatives: string[] = []
  for (const release of current.releases) {
    if (release.kind !== 'alt') continue
    const group = release.releaseGroup.trim()
    if (!group || previousGroups.has(group.toLowerCase()) || group.toLowerCase() === toBest.toLowerCase()) continue
    if (!newAlternatives.some(existing => existing.toLowerCase() === group.toLowerCase())) newAlternatives.push(group)
  }
  if (newAlternatives.length) {
    const heading = newAlternatives.length === 1 ? 'New alternative' : `New alternatives (${newAlternatives.length})`
    details.push(`${heading}: ${newAlternatives.slice(0, 3).join(', ')}${newAlternatives.length > 3 ? '…' : ''}`)
  }
  const previousUnavailable = unavailableLabels(previous)
  const currentUnavailable = unavailableLabels(current)
  for (const label of previousUnavailable) if (!currentUnavailable.has(label)) details.push(`${label} now covered`)
  for (const label of currentUnavailable)
    if (!previousUnavailable.has(label)) details.push(`${label} no longer available on SeaDex`)
  if ((previous.notes || '').trim() !== (current.notes || '').trim()) details.push('seadex.moe notes updated')
  const mismatched = (result: ResultItem) => [...new Set(Object.values(result.mismatched_by_part || {}).flat())].sort()
  const nowMismatched = mismatched(current).filter(group => !mismatched(previous).includes(group))
  if (nowMismatched.length) details.push(`Your ${nowMismatched.join(', ')} files differ from the listed release`)
  if (!previous.preference_blocked && current.preference_blocked)
    details.push('No listed release fits your release preferences')
  if (!details.length) details.push(...describeReleaseChanges(previous, current).map(change => change.description))
  return details.slice(0, 6)
}
