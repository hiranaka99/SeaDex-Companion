import { upgradeParts } from '../../shared/download-plan.js'
import { resultGroupKey } from '../../shared/ids.js'
import { releaseIdentity } from '../../shared/releases.js'
import type { UsenetAvailabilityResult } from '../../shared/usenet-contracts.js'
import type { Release, ResultItem } from './types.js'
import { availabilityKey } from './usenet-observation.js'
import { awaitsCheck } from './usenet-review.js'

const hasMagnet = (release: Release) => release.torrent_available

export interface IndexedRelease {
  index: number
  release: Release
}

export interface ReviewGroup {
  id: string
  result: ResultItem
  part: string
  options: IndexedRelease[]
}

export interface Review {
  ready: ReviewGroup[]
  choices: ReviewGroup[]
  blocked: ReviewGroup[]
}

/** The availability row of one release option, as the observation keys it. */
export const optionAvailabilityKey = (result: Pick<ResultItem, 'key'>, option: IndexedRelease): string =>
  availabilityKey({ key: result.key, release: option.index, identity: releaseIdentity(option.release) })

/**
 * Whether a review can offer Usenet for a release: a proven copy is known, or a file-list search through
 * Prowlarr can still look for one. The review asks for that search and check once the release is chosen.
 */
export function usenetEligibility(
  availability: { rows: Readonly<Record<string, UsenetAvailabilityResult>>; sabnzbdConfigured: boolean } | null,
  enabled = true,
): (result: ResultItem, option: IndexedRelease) => boolean {
  return (result, option) => {
    if (!enabled || !availability?.sabnzbdConfigured) return false
    const row = availability.rows[optionAvailabilityKey(result, option)]
    return row?.aggregate === 'available' || awaitsCheck(row)
  }
}

/** Sorts every upgradable season or cour into what can be sent now and what cannot. */
export function buildReview(
  results: ResultItem[],
  usenetEligible: (result: ResultItem, option: IndexedRelease) => boolean,
  torrentEnabled = true,
  /** Whether qBittorrent can receive a release; private-tracker releases need Prowlarr. */
  torrentSendable: (release: Release) => boolean = hasMagnet,
): Review {
  const ready: ReviewGroup[] = []
  const blocked: ReviewGroup[] = []

  for (const result of results)
    for (const part of upgradeParts(result)) {
      const group = { id: `${result.key}::${part.part || 'all'}`, result, part: part.part, options: part.options }
      const torrent = torrentEnabled && group.options.some(option => torrentSendable(option.release))
      if (torrent || group.options.some(option => usenetEligible(result, option))) ready.push(group)
      else blocked.push(group)
    }

  return { ready, choices: ready.filter(group => group.options.length > 1), blocked }
}

/** The hidden-card key of the card a result belongs to. */
export const hiddenKey = (result: ResultItem): string => String(resultGroupKey(result))

/** Review rows read like the library: by title, then season, then cour. */
export function byTitleSeasonPart(a: ReviewGroup, b: ReviewGroup): number {
  return (
    a.result.title.localeCompare(b.result.title, undefined, { sensitivity: 'base' }) ||
    (a.result.season || 0) - (b.result.season || 0) ||
    a.part.localeCompare(b.part)
  )
}
