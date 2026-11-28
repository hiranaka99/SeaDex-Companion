import { isRecord, asRecord } from '../shared/guards.js'
import type { ExclusionKind, Release, ResultItem } from '../shared/contracts.js'
import { torrentHashes, planTorrents } from '../shared/download-plan.js'
import { sameRelease } from '../shared/releases.js'
import { FILES_SOURCE_PATTERN } from '../shared/ids.js'

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
/** Only absolute web addresses become links; anything else would resolve against this app. */
const trackerUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined
/** Private-tracker sources survive only whole: an ID of the right shape and files with exact sizes. */
function privateSources(value: unknown): Release['private_sources'] {
  if (!Array.isArray(value)) return undefined
  const sources = value.flatMap(raw => {
    const source = asRecord(raw)
    const id = typeof source.id === 'string' ? source.id.toLowerCase() : ''
    const files = (Array.isArray(source.files) ? source.files : []).map(entry => asRecord(entry))
    if (!FILES_SOURCE_PATTERN.test(id) || !files.length) return []
    if (!files.every(file => typeof file.name === 'string' && file.name && Number.isSafeInteger(file.length))) return []
    return [
      {
        id,
        ...(trackerUrl(source.page) ? { page: trackerUrl(source.page) } : {}),
        files: files.map(file => ({ name: String(file.name), length: Number(file.length) })),
      },
    ]
  })
  return sources.length ? sources : undefined
}
const EXCLUSION_KINDS: readonly ExclusionKind[] = ['preferences', 'unreachable_tracker', 'episode_order']
const positiveCount = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null

/**
 * An exclusion's kind, and an episode-order exclusion's counts, only beside a reason. Results saved before kinds
 * existed, or with a kind this version does not know, keep the reason alone, as preference reasons are.
 */
function exclusionDetails(source: Record<string, unknown>): Pick<Release, 'excluded_kind' | 'episode_misfit'> {
  const kind = EXCLUSION_KINDS.find(known => known === source.excluded_kind)
  if (!text(source.excluded_by) || !kind) return {}
  if (kind !== 'episode_order') return { excluded_kind: kind }
  const misfit = asRecord(source.episode_misfit)
  const releaseEpisodes = positiveCount(misfit.release_episodes)
  const seriesEpisodes = positiveCount(misfit.series_episodes)
  // Without its counts, nothing could say why the release does not fit: it stays excluded, by an unnamed reason.
  if (releaseEpisodes === null || seriesEpisodes === null) return { excluded_kind: kind }
  return {
    excluded_kind: kind,
    episode_misfit: {
      release_episodes: releaseEpisodes,
      series_episodes: seriesEpisodes,
      ...(text(misfit.episode_order) ? { episode_order: String(misfit.episode_order).slice(0, 40) } : {}),
    },
  }
}
const dictionary = <T>(value: unknown, parse: (value: unknown) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(asRecord(value)).map(([key, entry]) => [key, parse(entry)]))

/** Legacy compatibility is confined to loading results, before either API or commands see them. */
export function normalizeResults(value: unknown): ResultItem[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => isRecord(item))
    .map(raw => {
      const item = asRecord(raw)
      const releases: Release[] = []
      for (const rawRelease of Array.isArray(item.releases) ? item.releases : []) {
        const source = asRecord(rawRelease)
        const hashes = strings(source.info_hashes)
        const release: Release = {
          kind: source.kind === 'alt' ? 'alt' : 'best',
          releaseGroup: text(source.releaseGroup) || '',
          tracker: text(source.tracker) || '',
          quality: text(source.quality) || '',
          tags: strings(source.tags),
          dual_audio: source.dual_audio === true,
          size: number(source.size),
          info_hashes: hashes,
          torrent_available: torrentHashes({ info_hashes: hashes }).length > 0,
          ...(text(source.part) ? { part: String(source.part) } : {}),
          ...(text(source.url) ? { url: String(source.url) } : {}),
          ...(trackerUrl(source.tracker_url) ? { tracker_url: trackerUrl(source.tracker_url) } : {}),
          ...(strings(source.selected_files).length ? { selected_files: strings(source.selected_files) } : {}),
          ...(source.target === true ? { target: true } : {}),
          ...(typeof source.satisfies === 'boolean' ? { satisfies: source.satisfies } : {}),
          ...(source.files_match === true ? { files_match: true } : {}),
          ...(text(source.excluded_by) ? { excluded_by: String(source.excluded_by) } : {}),
          ...exclusionDetails(source),
          ...(Array.isArray(source.torrent_files)
            ? {
                torrent_files: source.torrent_files.map(raw => {
                  const catalog = asRecord(raw)
                  return {
                    hash: text(catalog.hash) || '',
                    files: (Array.isArray(catalog.files) ? catalog.files : []).map(raw => {
                      const file = asRecord(raw)
                      return { name: text(file.name) || '', length: typeof file.length === 'number' ? file.length : -1 }
                    }),
                  }
                }),
              }
            : {}),
        }
        release.info_hashes = planTorrents([{ release, category: '' }]).map(torrent => torrent.hash)
        release.torrent_available = release.info_hashes.length > 0
        const sources = release.torrent_available ? undefined : privateSources(source.private_sources)
        if (sources) release.private_sources = sources
        // Older results could list one release once per tracker; a group's other releases stay listed.
        const index = releases.findIndex(
          previous => (previous.part || '') === (release.part || '') && sameRelease(previous, release, true),
        )
        if (index < 0) releases.push(release)
        else if (!releases[index].torrent_available && release.torrent_available) releases[index] = release
      }
      const status =
        item.status === 'best' || item.status === 'partial' || item.status === 'upgrade' || item.status === 'uncovered'
          ? item.status
          : 'missing'
      return {
        key: text(item.key) || '',
        group_id: typeof item.group_id === 'number' ? item.group_id : null,
        arr: text(item.arr) || '',
        ...(text(item.instance)
          ? {
              instance: String(item.instance),
              ...(text(item.instance_name) ? { instance_name: String(item.instance_name) } : {}),
            }
          : {}),
        title: text(item.title) || '',
        season: typeof item.season === 'number' ? item.season : null,
        status,
        have: strings(item.have),
        local_size: number(item.local_size),
        best_group: text(item.best_group),
        best_size: number(item.best_size),
        releases,
        url: text(item.url),
        notes: text(item.notes),
        image: text(item.image),
        banner: text(item.banner),
        anilist_id: typeof item.anilist_id === 'number' ? item.anilist_id : null,
        arr_url: text(item.arr_url),
        ...(typeof item.library_key === 'string' ? { library_key: item.library_key } : {}),
        ...(item.match_status === 'matched' || item.match_status === 'unmatched'
          ? { match_status: item.match_status }
          : {}),
        ...(typeof item.missing_episode_count === 'number'
          ? { missing_episode_count: item.missing_episode_count }
          : {}),
        upgrade_available: item.upgrade_available === true,
        precise_part_ownership: item.precise_part_ownership === true,
        have_by_part: dictionary(item.have_by_part, strings),
        owned_by_part: dictionary(item.owned_by_part, strings),
        ...(Object.keys(asRecord(item.verified_by_part)).length
          ? { verified_by_part: dictionary(item.verified_by_part, strings) }
          : {}),
        ...(Object.keys(asRecord(item.mismatched_by_part)).length
          ? { mismatched_by_part: dictionary(item.mismatched_by_part, strings) }
          : {}),
        ...(item.preference_blocked === true ? { preference_blocked: true } : {}),
        ...(item.private_only === true ? { private_only: true } : {}),
        local_size_by_part: dictionary(item.local_size_by_part, number),
        notes_by_part: dictionary(item.notes_by_part, value => text(value) || ''),
        excluded: item.excluded === true,
        excluded_parts: strings(item.excluded_parts),
        mapping_override: item.mapping_override === true,
        season_mapping_override: item.season_mapping_override === true,
        ...(strings(item.search_titles).length
          ? { search_titles: strings(item.search_titles).filter(Boolean).slice(0, 10) }
          : {}),
        ...(Array.isArray(item.anilist_ids)
          ? { anilist_ids: item.anilist_ids.filter((id): id is number => typeof id === 'number') }
          : {}),
        urls: (Array.isArray(item.urls) ? item.urls : []).flatMap(raw => {
          const value = asRecord(raw)
          return typeof value.url === 'string' ? [{ label: text(value.label) || '', url: value.url }] : []
        }),
        unavailable_parts: (Array.isArray(item.unavailable_parts) ? item.unavailable_parts : []).map(raw => {
          const value = asRecord(raw)
          return { label: text(value.label) || '', reason: text(value.reason) || '' }
        }),
      } satisfies ResultItem
    })
}
