import { upgradeParts } from '../../shared/download-plan.js'
import { resultGroupKey } from '../../shared/ids.js'
import type { Release, ResultItem } from './types'

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
