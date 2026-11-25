import { errorMessage } from '../shared/errors.js'
import { api } from './http.js'
import { arrBaseUrl, arrApiUrl, sonarrApiUrl } from './arr-urls.js'
import { log } from './logging.js'
import { configuredArrInstances, instanceFields, instanceOf, type ArrInstance } from './arr-instances.js'
import { scopeIsEmpty } from '../shared/settings.js'
import type { Config, JsonObject, ScanScope, LocalFile, LocalItem, LocalSeason } from './types.js'

/** A title the library scope leaves out, kept so its status tags can still be cleared. */
export interface OutOfScopeItem {
  instance: string
  id: number
  tags: number[]
}
interface InstanceLibrary {
  items: LocalItem[]
  outOfScope: OutOfScopeItem[]
}

/** API root of an instance; Sonarr advertises its current API version. */
export async function arrApiBase(instance: Pick<ArrInstance, 'kind' | 'url' | 'key'>): Promise<string> {
  return instance.kind === 'sonarr' ? sonarrApiUrl(instance.url, instance.key) : arrApiUrl(instance.url)
}

export function scopeIds(scope: ScanScope, instance: Pick<ArrInstance, 'id'>): number[] | undefined {
  if (instance.id === 'sonarr') return scope.sonarrIds
  if (instance.id === 'radarr') return scope.radarrIds
  return scope.instances?.[instance.id]
}

export function isScopedScan(scope: ScanScope): boolean {
  return Boolean(scope.sonarrIds || scope.radarrIds || scope.instances)
}

const normalizeFolder = (value: unknown): string =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
const tagIds = (item: JsonObject): number[] =>
  Array.isArray(item.tags) ? item.tags.map(Number).filter(Number.isInteger) : []

/** Builds the saved library scope of one instance as a predicate over its series or movies. */
async function scopeFilter(instance: ArrInstance, base: string): Promise<(item: JsonObject) => boolean> {
  const scope = instance.scope
  if (scopeIsEmpty(scope)) return () => true
  let include = new Set<number>()
  let exclude = new Set<number>()
  if (scope.include_tags.length || scope.exclude_tags.length) {
    const tags = (await api(`${base}/tag`, instance.key, {}, instance.kind === 'sonarr')) as JsonObject[]
    const byLabel = new Map(
      (Array.isArray(tags) ? tags : []).map(tag => [
        String(tag.label || '')
          .trim()
          .toLowerCase(),
        Number(tag.id),
      ]),
    )
    const resolve = (labels: string[]) =>
      new Set(labels.map(label => byLabel.get(label)).filter((id): id is number => id !== undefined))
    include = resolve(scope.include_tags)
    exclude = resolve(scope.exclude_tags)
    const unknown = [...scope.include_tags, ...scope.exclude_tags].filter(label => !byLabel.has(label))
    if (unknown.length)
      log(
        'WARNING',
        `${instance.name} has no tag named ${unknown.map(label => `"${label}"`).join(', ')}; the library scope cannot match it`,
      )
  }
  const roots = scope.root_folders.map(normalizeFolder).filter(Boolean)
  return item => {
    if (instance.kind === 'sonarr' && scope.anime_only && String(item.seriesType || '').toLowerCase() !== 'anime')
      return false
    const tags = tagIds(item)
    if (scope.include_tags.length && !tags.some(tag => include.has(tag))) return false
    if (tags.some(tag => exclude.has(tag))) return false
    if (roots.length) {
      const root = normalizeFolder(item.rootFolderPath)
      const path = normalizeFolder(item.path)
      if (!roots.some(folder => root === folder || path === folder || path.startsWith(`${folder}/`))) return false
    }
    return true
  }
}

function logScope(instance: ArrInstance, total: number, kept: number): void {
  if (!scopeIsEmpty(instance.scope))
    log(
      'INFO',
      `${instance.name} library scope: ${kept} of ${total} ${instance.kind === 'sonarr' ? 'series' : 'movies'} in scope`,
    )
}

async function sonarrItems(instance: ArrInstance, ids?: number[]): Promise<InstanceLibrary> {
  const items: LocalItem[] = [],
    outOfScope: OutOfScopeItem[] = [],
    now = Date.now()
  const base = await sonarrApiUrl(instance.url, instance.key)
  const series = (await api(`${base}/series`, instance.key, {}, true)) as JsonObject[]
  const inScope = await scopeFilter(instance, base)
  let kept = 0
  for (const show of series) {
    if (!inScope(show)) {
      outOfScope.push({ instance: instance.id, id: Number(show.id), tags: tagIds(show) })
      continue
    }
    kept += 1
    if (ids?.length && !ids.includes(Number(show.id))) continue
    const [episodes, episodeFiles] = (await Promise.all([
      api(`${base}/episode?seriesId=${show.id}`, instance.key, {}, true),
      api(`${base}/episodefile?seriesId=${show.id}`, instance.key, {}, true),
    ])) as [JsonObject[], JsonObject[]]
    const fileGroups = new Map<number, string>()
    const fileSizes = new Map<number, number>()
    for (const file of episodeFiles) {
      const group = String(file.releaseGroup || '').trim()
      if (file.id && group) fileGroups.set(Number(file.id), group)
      if (file.id) fileSizes.set(Number(file.id), Number(file.size || 0))
    }
    const groupsBySeasonEpisode = new Map<number, Map<string, Set<number>>>()
    const episodeNumbersBySeason = new Map<number, Set<number>>()
    const fileEpisodes = new Map<number, { season: number; episode: number }[]>()
    // A season is shown when any episode has aired or any episode file exists;
    // announced seasons with neither signal (TVDB usually leaves air dates
    // empty until a schedule is set) are assumed unreleased and hidden.
    const seasonAired = new Map<number, boolean>()
    const seasonHasFile = new Set<number>()
    for (const episode of episodes) {
      const season = Number(episode.seasonNumber || 0)
      if (Number.isInteger(season) && season > 0) {
        const airDate = Date.parse(String(episode.airDate || ''))
        if (Number.isFinite(airDate)) seasonAired.set(season, (seasonAired.get(season) ?? false) || airDate <= now)
      }
      const number = Number(episode.episodeNumber || 0)
      if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(number) || number <= 0) continue
      const seasonNumbers = episodeNumbersBySeason.get(season) || new Set<number>()
      seasonNumbers.add(number)
      episodeNumbersBySeason.set(season, seasonNumbers)
      const fileId = Number(episode.episodeFileId || episode.episodeFile?.id || 0)
      if (fileId > 0) seasonHasFile.add(season)
      const group = String(episode.episodeFile?.releaseGroup || fileGroups.get(fileId) || '').trim()
      if (fileId && group && !fileGroups.has(fileId)) fileGroups.set(fileId, group)
      if (fileId && !fileSizes.has(fileId) && episode.episodeFile?.size)
        fileSizes.set(fileId, Number(episode.episodeFile.size))
      if (fileId) fileEpisodes.set(fileId, [...(fileEpisodes.get(fileId) || []), { season, episode: number }])
      if (!group) continue
      const groups = groupsBySeasonEpisode.get(season) || new Map<string, Set<number>>()
      const numbers = groups.get(group) || new Set<number>()
      numbers.add(number)
      groups.set(group, numbers)
      groupsBySeasonEpisode.set(season, groups)
    }
    const sizesBySeasonEpisode = new Map<number, Map<number, number>>()
    const filesBySeason = new Map<number, LocalFile[]>()
    for (const [fileId, linkedEpisodes] of fileEpisodes) {
      const size = fileSizes.get(fileId) || 0
      if (!size || !linkedEpisodes.length) continue
      const share = size / linkedEpisodes.length
      for (const linked of linkedEpisodes) {
        const sizes = sizesBySeasonEpisode.get(linked.season) || new Map<number, number>()
        sizes.set(linked.episode, (sizes.get(linked.episode) || 0) + share)
        sizesBySeasonEpisode.set(linked.season, sizes)
      }
      // The exact file size is the release fingerprint; a file is listed under each season it spans.
      for (const season of new Set(linkedEpisodes.map(linked => linked.season))) {
        const numbers = linkedEpisodes
          .filter(linked => linked.season === season)
          .map(linked => linked.episode)
          .sort((left, right) => left - right)
        filesBySeason.set(season, [
          ...(filesBySeason.get(season) || []),
          { size, episodes: numbers, group: fileGroups.get(fileId) || '' },
        ])
      }
    }
    const seasons: Record<number, LocalSeason> = {}
    for (const season of show.seasons || []) {
      const number = season.seasonNumber || 0
      if (number === 0) continue
      if (seasonAired.get(Number(number)) !== true && !seasonHasFile.has(Number(number))) continue
      const stats = season.statistics || {}
      const groups = stats.releaseGroups || []
      const episodeGroups = groupsBySeasonEpisode.get(Number(number))
      const episodeSizes = sizesBySeasonEpisode.get(Number(number))
      const episodeNumbers = [...(episodeNumbersBySeason.get(Number(number)) || [])].sort((left, right) => left - right)
      seasons[number] = {
        groups,
        size: stats.sizeOnDisk || 0,
        episode_numbers: episodeNumbers,
        episode_count: episodeNumbers.length || Number(stats.episodeCount || stats.totalEpisodeCount || 0) || null,
        missing_episode_count: episodes.filter(
          episode =>
            Number(episode.seasonNumber) === Number(number) &&
            Date.parse(String(episode.airDate || '')) <= now &&
            !Number(episode.episodeFileId || episode.episodeFile?.id || 0),
        ).length,
        groups_by_episode: episodeGroups
          ? Object.fromEntries(
              [...episodeGroups].map(([group, numbers]) => [group, [...numbers].sort((left, right) => left - right)]),
            )
          : {},
        sizes_by_episode: episodeSizes ? Object.fromEntries(episodeSizes) : {},
        ...(filesBySeason.has(Number(number))
          ? {
              files: filesBySeason
                .get(Number(number))!
                .sort((left, right) => (left.episodes[0] ?? 0) - (right.episodes[0] ?? 0)),
            }
          : {}),
      }
    }
    if (Object.keys(seasons).length)
      items.push({
        arr: 'Sonarr',
        ...instanceFields(instance),
        id: show.id,
        title: show.title,
        slug: show.titleSlug,
        ...(Array.isArray(show.tags) ? { tags: tagIds(show) } : {}),
        ...(alternateTitles(show).length ? { alternate_titles: alternateTitles(show) } : {}),
        seasons,
      })
  }
  logScope(instance, series.length, kept)
  return { items, outOfScope }
}

/** Sonarr's scene titles for a series, as its own indexer searches use them. */
function alternateTitles(show: JsonObject): { title: string; season: number | null }[] {
  if (!Array.isArray(show.alternateTitles)) return []
  return show.alternateTitles.flatMap((entry: JsonObject) => {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
    if (!title) return []
    // Sonarr marks a title that applies to all seasons with -1 or leaves the season out.
    const raw = entry.sceneSeasonNumber ?? entry.seasonNumber
    const season = typeof raw === 'number' && raw >= 0 ? raw : null
    return [{ title: title.slice(0, 200), season }]
  })
}

async function radarrItems(instance: ArrInstance, ids?: number[]): Promise<InstanceLibrary> {
  const items: LocalItem[] = [],
    outOfScope: OutOfScopeItem[] = [],
    now = Date.now()
  const base = arrApiUrl(instance.url)
  const movies = (await api(`${base}/movie`, instance.key)) as JsonObject[]
  const inScope = await scopeFilter(instance, base)
  let kept = 0
  for (const movie of movies) {
    if (!inScope(movie)) {
      outOfScope.push({ instance: instance.id, id: Number(movie.id), tags: tagIds(movie) })
      continue
    }
    kept += 1
    if (ids?.length && !ids.includes(Number(movie.id))) continue
    const stats = movie.statistics || {}
    // Direct-to-video movies may never have a cinema date. Older Radarr
    // versions expose ownership on the movie/file instead of statistics.
    const size = Number(stats.sizeOnDisk || movie.sizeOnDisk || movie.movieFile?.size || 0)
    const hasFile = size > 0 || movie.hasFile === true || Number(movie.movieFileId || movie.movieFile?.id || 0) > 0
    const released = [movie.inCinemas, movie.digitalRelease, movie.physicalRelease, movie.releaseDate].some(value => {
      const date = Date.parse(String(value || ''))
      return Number.isFinite(date) && date <= now
    })
    if (!released && !hasFile) continue
    const fileGroup = String(movie.movieFile?.releaseGroup || '').trim()
    const groups =
      Array.isArray(stats.releaseGroups) && stats.releaseGroups.length
        ? stats.releaseGroups
        : fileGroup
          ? [fileGroup]
          : []
    const fileSize = Number(movie.movieFile?.size || 0) || size
    items.push({
      arr: 'Radarr',
      ...instanceFields(instance),
      id: movie.id,
      title: movie.title,
      slug: movie.titleSlug,
      ...(Array.isArray(movie.tags) ? { tags: tagIds(movie) } : {}),
      seasons: {
        0: {
          groups,
          size,
          ...(fileSize > 0
            ? { files: [{ size: fileSize, episodes: [], group: fileGroup || String(groups[0] || '') }] }
            : {}),
        },
      },
    })
  }
  logScope(instance, movies.length, kept)
  return { items, outOfScope }
}

const loadInstance = (instance: ArrInstance, ids?: number[]) =>
  instance.kind === 'sonarr' ? sonarrItems(instance, ids) : radarrItems(instance, ids)

export async function localItems(config: Config, scope: ScanScope = {}): Promise<LocalItem[]> {
  return (
    await Promise.all(configuredArrInstances(config).map(instance => loadInstance(instance, scopeIds(scope, instance))))
  ).flatMap(library => library.items)
}

type InstanceSource = Parameters<typeof instanceOf>[0]

export function arrItemUrl(
  config: InstanceSource,
  item: { arr: string; instance?: string; id?: number; slug?: string },
): string | null {
  const base = arrBaseUrl(instanceOf(config, item)?.url)
  if (!base) return null
  const path = item.arr === 'Sonarr' ? 'series' : 'movie'
  return `${base}/${path}/${item.slug || item.id}`
}

export interface LibraryLoad {
  items: LocalItem[]
  sourceErrors: Record<string, string>
  outOfScope: OutOfScopeItem[]
}

export async function loadLocalLibrary(config: Config, scope: ScanScope = {}): Promise<LibraryLoad> {
  const scoped = isScopedScan(scope)
  const sources = configuredArrInstances(config).filter(instance => !scoped || scopeIds(scope, instance)?.length)
  const outcomes = await Promise.allSettled(sources.map(instance => loadInstance(instance, scopeIds(scope, instance))))
  const items: LocalItem[] = [],
    outOfScope: OutOfScopeItem[] = [],
    sourceErrors: Record<string, string> = {}
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      items.push(...outcome.value.items)
      outOfScope.push(...outcome.value.outOfScope)
    } else {
      if (outcome.reason instanceof DOMException && outcome.reason.name === 'AbortError') throw outcome.reason
      sourceErrors[sources[index].name] = errorMessage(outcome.reason)
    }
  })
  if (sources.length && Object.keys(sourceErrors).length === sources.length)
    throw new Error(
      Object.entries(sourceErrors)
        .map(([source, message]) => `${source}: ${message}`)
        .join('; '),
    )
  return { items, sourceErrors, outOfScope }
}
