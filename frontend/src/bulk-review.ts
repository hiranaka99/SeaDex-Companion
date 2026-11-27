import { upgradeParts } from '../../shared/download-plan.js'
import { resultGroupKey } from '../../shared/ids.js'
import { releaseIdentity } from '../../shared/releases.js'
import type { UsenetAvailabilityResult } from '../../shared/usenet-contracts.js'
import type { Release, ResultItem } from './types.js'
import { availabilityKey } from './usenet-observation.js'
import type { DownloadProtocol } from '../../shared/download-contracts.js'
import type { DownloadRoutes } from './download-routes.js'

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
  rows: Readonly<Record<string, UsenetAvailabilityResult>> | null,
  routes: DownloadRoutes,
): (result: ResultItem, option: IndexedRelease) => boolean {
  return (result, option) => {
    if (!rows) return false
    const { usenet } = routes.release(option.release, rows[optionAvailabilityKey(result, option)])
    return usenet.sendable || usenet.pending
  }
}

/** The protocol a review row sends with, decided as a card decides it for the same release. */
export function reviewProtocol(
  routes: DownloadRoutes,
  rows: Readonly<Record<string, UsenetAvailabilityResult>> | null | undefined,
  result: ResultItem,
  option: IndexedRelease,
  chosen?: DownloadProtocol,
): DownloadProtocol {
  return routes.release(option.release, rows?.[optionAvailabilityKey(result, option)], chosen).protocol
}

/** Sorts every upgradable season or cour into what can be sent now and what cannot. */
export function buildReview(
  results: ResultItem[],
  usenetEligible: (result: ResultItem, option: IndexedRelease) => boolean,
  routes: DownloadRoutes,
): Review {
  const ready: ReviewGroup[] = []
  const blocked: ReviewGroup[] = []

  for (const result of results)
    for (const part of upgradeParts(result)) {
      const group = { id: `${result.key}::${part.part || 'all'}`, result, part: part.part, options: part.options }
      const torrent = group.options.some(option => routes.release(option.release, undefined).torrent.sendable)
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
