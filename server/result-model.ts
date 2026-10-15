import type { Release, ResultItem } from '../shared/contracts.js'
import { torrentHashes, planTorrents } from '../shared/download-plan.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const dictionary = <T>(value: unknown, parse: (value: unknown) => T): Record<string, T> => Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key, parse(entry)]))

/** Legacy compatibility is confined to loading results, before either API or commands see them. */
export function normalizeResults(value: unknown): ResultItem[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(raw => {
    const item = object(raw)
    const releases = new Map<string, Release>()
    for (const rawRelease of Array.isArray(item.releases) ? item.releases : []) {
      const source = object(rawRelease)
      const hashes = strings(source.info_hashes)
      const release: Release = {
        kind: source.kind === 'alt' ? 'alt' : 'best', releaseGroup: text(source.releaseGroup) || '', tracker: text(source.tracker) || '',
        quality: text(source.quality) || '', tags: strings(source.tags), dual_audio: source.dual_audio === true,
        size: number(source.size), info_hashes: hashes, downloadable: torrentHashes({ info_hashes: hashes }).length > 0,
        ...(text(source.part) ? { part: String(source.part) } : {}), ...(text(source.url) ? { url: String(source.url) } : {}),
        ...(strings(source.selected_files).length ? { selected_files: strings(source.selected_files) } : {}),
        ...(Array.isArray(source.torrent_files) ? { torrent_files: source.torrent_files.map(raw => {
          const catalog = object(raw)
          return { hash: text(catalog.hash) || '', files: (Array.isArray(catalog.files) ? catalog.files : []).map(raw => {
            const file = object(raw); return { name: text(file.name) || '', length: typeof file.length === 'number' ? file.length : -1 }
          }) }
        }) } : {}),
      }
      release.info_hashes = planTorrents([{ release, category: '' }]).map(torrent => torrent.hash)
      release.downloadable = release.info_hashes.length > 0
      const id = `${release.part || ''}\0${release.releaseGroup.trim().toLowerCase()}`
      const previous = releases.get(id)
      if (!previous || (!previous.downloadable && release.downloadable)) releases.set(id, release)
    }
    const status = item.status === 'best' || item.status === 'partial' || item.status === 'upgrade' || item.status === 'uncovered' ? item.status : 'missing'
    return {
      key: text(item.key) || '', group_id: typeof item.group_id === 'number' ? item.group_id : null,
      arr: text(item.arr) || '', title: text(item.title) || '', season: typeof item.season === 'number' ? item.season : null,
      status, have: strings(item.have), local_size: number(item.local_size), best_group: text(item.best_group), best_size: number(item.best_size),
      releases: [...releases.values()], url: text(item.url), notes: text(item.notes), image: text(item.image), banner: text(item.banner),
      anilist_id: typeof item.anilist_id === 'number' ? item.anilist_id : null, arr_url: text(item.arr_url),
      ...(typeof item.library_key === 'string' ? { library_key: item.library_key } : {}),
      ...(item.match_status === 'matched' || item.match_status === 'unmatched' ? { match_status: item.match_status } : {}),
      ...(typeof item.missing_episode_count === 'number' ? { missing_episode_count: item.missing_episode_count } : {}),
      upgrade_available: item.upgrade_available === true, precise_part_ownership: item.precise_part_ownership === true,
      have_by_part: dictionary(item.have_by_part, strings), owned_by_part: dictionary(item.owned_by_part, strings),
      local_size_by_part: dictionary(item.local_size_by_part, number), notes_by_part: dictionary(item.notes_by_part, value => text(value) || ''),
      excluded: item.excluded === true, excluded_parts: strings(item.excluded_parts), mapping_override: item.mapping_override === true,
      ...(Array.isArray(item.anilist_ids) ? { anilist_ids: item.anilist_ids.filter((id): id is number => typeof id === 'number') } : {}),
      urls: (Array.isArray(item.urls) ? item.urls : []).flatMap(raw => { const value = object(raw); return typeof value.url === 'string' ? [{ label: text(value.label) || '', url: value.url }] : [] }),
      unavailable_parts: (Array.isArray(item.unavailable_parts) ? item.unavailable_parts : []).map(raw => { const value = object(raw); return { label: text(value.label) || '', reason: text(value.reason) || '' } }),
    } satisfies ResultItem
  })
}
