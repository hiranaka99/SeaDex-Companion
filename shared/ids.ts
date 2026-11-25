import type { DownloadSelectionRef } from './download-contracts.js'

/** A normalized v1 torrent info hash (lower-case SHA-1): the identity of every release source. */
export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/

/** Lower-cased info hash, or null when the value is not one. */
export function normalizeInfoHash(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
}

export const isInfoHash = (value: unknown): value is string => normalizeInfoHash(value) !== null

/**
 * A release SeaDex lists without a public info hash (a private-tracker torrent) is identified by its
 * file list instead: `files:` plus the SHA-1 of its sorted file names and sizes. It is never a torrent hash.
 */
export const FILES_SOURCE_PATTERN = /^files:[0-9a-f]{40}$/

/** A source identity: a v1 info hash, or the file-list identity of a private-tracker release. */
export function normalizeSourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()
  return INFO_HASH_PATTERN.test(lower) || FILES_SOURCE_PATTERN.test(lower) ? lower : null
}

/** Identity of one review row: a result key plus a release index. */
export const rowKey = (ref: DownloadSelectionRef): string => `${ref.key}\u0000${ref.release}`

/** `S01`-style season tag. */
export const seasonTag = (season: number): string => `S${String(season).padStart(2, '0')}`

interface GroupedResult {
  instance?: string | null
  group_id?: number | null
  anilist_id?: number | null
  key?: string
  arr: string
  title: string
}

/**
 * Results sharing this value form one library card; titles without an AniList match group by library item.
 * The same anime in an additional Sonarr or Radarr instance is a separate card.
 */
export function resultGroupKey(result: GroupedResult): number | string {
  const base = baseGroupKey(result)
  return result.instance ? `${result.instance}:${base}` : base
}

/** The card identity before an additional instance is told apart: the AniList group, or the library item. */
export function baseGroupKey(result: GroupedResult): number | string {
  if (result.group_id != null) return result.group_id
  if (result.anilist_id != null) return result.anilist_id
  const parts = String(result.key || '').split(':')
  return `${result.arr}:${parts.length >= 2 ? parts[1] : result.title}`
}

/** The card identity as stored in hidden-title settings. */
export const cardKey = (result: GroupedResult): string => String(resultGroupKey(result))
