import { api } from './http.js'
import { arrBaseUrl, arrApiUrl, sonarrApiUrl } from './config.js'
import { errorMessage } from './logging.js'
import type { Config, JsonObject, ScanScope, LocalItem, LocalSeason } from './types.js'

async function sonarrItems(config: Config, scope: ScanScope): Promise<LocalItem[]> {
  const items: LocalItem[] = [], now = Date.now()
  const base = await sonarrApiUrl(config.sonarr_url, config.sonarr_key)
  const series = await api(`${base}/series`, config.sonarr_key, {}, true) as JsonObject[]
  for (const show of series) {
    if (scope.sonarrIds?.length && !scope.sonarrIds.includes(Number(show.id))) continue
    const [episodes, episodeFiles] = await Promise.all([
      api(`${base}/episode?seriesId=${show.id}`, config.sonarr_key, {}, true),
      api(`${base}/episodefile?seriesId=${show.id}`, config.sonarr_key, {}, true),
    ]) as [JsonObject[], JsonObject[]]
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
      seasonNumbers.add(number); episodeNumbersBySeason.set(season, seasonNumbers)
      const fileId = Number(episode.episodeFileId || episode.episodeFile?.id || 0)
      if (fileId > 0) seasonHasFile.add(season)
      const group = String(episode.episodeFile?.releaseGroup || fileGroups.get(fileId) || '').trim()
      if (fileId && !fileSizes.has(fileId) && episode.episodeFile?.size) fileSizes.set(fileId, Number(episode.episodeFile.size))
      if (fileId) fileEpisodes.set(fileId, [...(fileEpisodes.get(fileId) || []), { season, episode: number }])
      if (!group) continue
      const groups = groupsBySeasonEpisode.get(season) || new Map<string, Set<number>>()
      const numbers = groups.get(group) || new Set<number>()
      numbers.add(number); groups.set(group, numbers); groupsBySeasonEpisode.set(season, groups)
    }
    const sizesBySeasonEpisode = new Map<number, Map<number, number>>()
    for (const [fileId, linkedEpisodes] of fileEpisodes) {
      const size = fileSizes.get(fileId) || 0
      if (!size || !linkedEpisodes.length) continue
      const share = size / linkedEpisodes.length
      for (const linked of linkedEpisodes) {
        const sizes = sizesBySeasonEpisode.get(linked.season) || new Map<number, number>()
        sizes.set(linked.episode, (sizes.get(linked.episode) || 0) + share)
        sizesBySeasonEpisode.set(linked.season, sizes)
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
        missing_episode_count: episodes.filter(episode => Number(episode.seasonNumber) === Number(number) && Date.parse(String(episode.airDate || '')) <= now && !Number(episode.episodeFileId || episode.episodeFile?.id || 0)).length,
        groups_by_episode: episodeGroups
          ? Object.fromEntries([...episodeGroups].map(([group, numbers]) => [group, [...numbers].sort((left, right) => left - right)]))
          : {},
        sizes_by_episode: episodeSizes ? Object.fromEntries(episodeSizes) : {},
      }
    }
    if (Object.keys(seasons).length) items.push({ arr: 'Sonarr', id: show.id, title: show.title, slug: show.titleSlug, seasons })
  }
  return items
}
async function radarrItems(config: Config, scope: ScanScope): Promise<LocalItem[]> {
  const items: LocalItem[] = [], now = Date.now()
  const movies = await api(`${arrApiUrl(config.radarr_url)}/movie`, config.radarr_key) as JsonObject[]
  for (const movie of movies) {
    if (scope.radarrIds?.length && !scope.radarrIds.includes(Number(movie.id))) continue
    const stats = movie.statistics || {}
    // A movie is shown once it has reached its cinema release date or any
    // file exists; entries with neither signal are assumed unreleased.
    const inCinemas = Date.parse(String(movie.inCinemas || ''))
    if (!(Number.isFinite(inCinemas) && inCinemas <= now) && Number(stats.sizeOnDisk || 0) <= 0) continue
    const groups = stats.releaseGroups || []
    items.push({
      arr: 'Radarr', id: movie.id, title: movie.title, slug: movie.titleSlug,
      seasons: { 0: { groups, size: stats.sizeOnDisk || 0 } },
    })
  }
  return items
}
export async function localItems(config: Config, scope: ScanScope = {}): Promise<LocalItem[]> {
  return (await Promise.all([
    config.sonarr_url && config.sonarr_key ? sonarrItems(config, scope) : [],
    config.radarr_url && config.radarr_key ? radarrItems(config, scope) : [],
  ])).flat()
}

export function arrItemUrl(config: Partial<Pick<Config, 'sonarr_url' | 'radarr_url'>>, item: { arr: string; id?: number; slug?: string }): string | null {
  const base = arrBaseUrl(item.arr === 'Sonarr' ? config.sonarr_url : config.radarr_url)
  if (!base) return null
  const path = item.arr === 'Sonarr' ? 'series' : 'movie'
  return `${base}/${path}/${item.slug || item.id}`
}

export async function loadLocalLibrary(config: Config, scope: ScanScope = {}): Promise<{ items: LocalItem[]; sourceErrors: Record<string, string> }> {
  const scoped = Boolean(scope.sonarrIds || scope.radarrIds)
  const sources: { name: string; load: () => Promise<LocalItem[]> }[] = []
  if (config.sonarr_url && config.sonarr_key && (!scoped || scope.sonarrIds?.length)) sources.push({ name: 'Sonarr', load: () => sonarrItems(config, scope) })
  if (config.radarr_url && config.radarr_key && (!scoped || scope.radarrIds?.length)) sources.push({ name: 'Radarr', load: () => radarrItems(config, scope) })
  const outcomes = await Promise.allSettled(sources.map(source => source.load()))
  const items: LocalItem[] = [], sourceErrors: Record<string, string> = {}
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') items.push(...outcome.value)
    else {
      if (outcome.reason instanceof DOMException && outcome.reason.name === 'AbortError') throw outcome.reason
      sourceErrors[sources[index].name] = errorMessage(outcome.reason)
    }
  })
  if (sources.length && Object.keys(sourceErrors).length === sources.length) throw new Error(Object.entries(sourceErrors).map(([source, message]) => `${source}: ${message}`).join('; '))
  return { items, sourceErrors }
}
