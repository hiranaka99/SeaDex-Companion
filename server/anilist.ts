import { ANILIST, sleep, fetchWithTimeout, scanRequests } from './http.js'
import { saveCache } from './results.js'
import { log, errorMessage } from './logging.js'
import type { JsonObject, ChainPart, ChainEntry } from './types.js'

let lastAnilist = 0

async function pacedAniList(payload: JsonObject, search: boolean): Promise<any> {
  let lastError = 'unknown error'
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = 2050 - (Date.now() - lastAnilist)
    if (wait > 0) await sleep(wait)
    lastAnilist = Date.now()
    let response: Response
    try {
      response = await fetchWithTimeout(ANILIST, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, 30_000)
    } catch (error) {
      scanRequests.getStore()?.throwIfAborted()
      lastError = errorMessage(error)
      log('WARNING', `AniList ${search ? 'search ' : ''}network error, retrying: ${lastError}`)
      await sleep(3000)
      continue
    }
    if (response.status === 429) {
      log('WARNING', `AniList ${search ? 'search ' : ''}rate limit (HTTP 429), backing off`)
      await sleep((Number(response.headers.get('Retry-After') || 60) + 1) * 1000)
      continue
    }
    if (response.status === 404) {
      log('WARNING', `AniList ${search ? 'search ' : ''}returned HTTP 404 (not found / non-anime ID), skipping`)
      return search ? [] : {}
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160)
      lastError = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
      log('WARNING', `AniList ${search ? 'search ' : ''}request failed (${lastError}), retrying`)
      await sleep(3000)
      continue
    }
    let body: any = null
    try { body = await response.json() } catch (error) {
      lastError = `invalid JSON: ${errorMessage(error)}`
      log('WARNING', `AniList ${search ? 'search ' : ''}response was invalid, retrying: ${lastError}`)
      await sleep(3000)
      continue
    }
    if (Array.isArray(body?.errors) && body.errors.length) {
      if (body.errors.some((error: JsonObject) => error?.status === 404 || error?.message === 'Not Found.')) {
        log('WARNING', `AniList ${search ? 'search ' : ''}returned GraphQL 404 Not Found, skipping`)
        return search ? [] : {}
      }
      lastError = body.errors.map((error: JsonObject) => error.message || 'GraphQL error').join('; ')
      log('WARNING', `AniList ${search ? 'search ' : ''}GraphQL error, retrying: ${lastError}`)
      await sleep(3000)
      continue
    }
    return search ? (body?.data?.Page?.media || []) : (body?.data?.Media || {})
  }
  throw new Error(`AniList ${search ? 'search ' : ''}request failed after 6 attempts: ${lastError}`)
}

export async function alMedia(query: string, variables: JsonObject): Promise<JsonObject> {
  return pacedAniList({ query, variables }, false)
}
export async function alSearch(query: string, variables: JsonObject): Promise<JsonObject[]> {
  return pacedAniList({ query, variables }, true)
}

export async function searchAniListTitles(title: string): Promise<JsonObject[]> {
  const query = 'query($t:String){Page(perPage:12){media(search:$t,type:ANIME,sort:SEARCH_MATCH){id format seasonYear episodes title{romaji english native} coverImage{large extraLarge}}}}'
  const matches = await alSearch(query, { t: title.trim() })
  return matches.map((media) => {
    const titles = media.title || {}; const cover = media.coverImage || {}
    return {
      id: Number(media.id), title: titles.english || titles.romaji || titles.native || `AniList #${media.id}`,
      romaji: titles.romaji || null, year: media.seasonYear || null, format: media.format || null,
      episodes: media.episodes ?? null, cover: cover.extraLarge || cover.large || null,
    }
  })
}

export function normalizeTitle(title: string): string {
  if (!title) return ''
  return title.replace(/×/g, 'x').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[«»]/g, '').replace(/\s*[:-]\s*(The\s+Movie|Movie|Theatrical)\b.*$/i, '')
    .replace(/\s+/g, ' ').trim()
}

export function searchCandidates(title: string): string[] {
  const normalized = normalizeTitle(title)
  const spaced = normalized.replace(/([a-z])\s*([Xx])\s*([A-Z])/g, '$1 $2 $3')
  const seen = new Set<string>()
  return [title, normalized, spaced].filter((candidate) => {
    const key = candidate?.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function titleKey(title?: string | null): string {
  return (title || '').toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9]+/g, '')
}

export function pickAniListSearchResult(candidates: JsonObject[], title: string): JsonObject | null {
  const wanted = titleKey(title)
  const score = (media: JsonObject): number[] => {
    const titles = media.title || {}
    const exact = Boolean(wanted && ['english', 'romaji', 'native'].some((key) => titleKey(titles[key]) === wanted))
    const seasonFormat = ['TV', 'TV_SHORT', 'ONA'].includes(media.format)
    return [exact ? 3 : 0, seasonFormat ? 1 : 0, -(media.seasonYear || 9999), -(media.id || 0)]
  }
  const compare = (left: number[], right: number[]) => {
    for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i]
    return 0
  }
  return candidates.reduce<JsonObject | null>((best, candidate) => !best || compare(score(candidate), score(best)) > 0 ? candidate : best, null)
}

export async function anilistLookup(title: string, cache: JsonObject, search = alSearch, persist = saveCache): Promise<JsonObject | null> {
  const cacheKey = `lookup:v2:${title}`
  if (cache[cacheKey]) return cache[cacheKey]
  const query = 'query($t:String){Page(perPage:10){media(search:$t,type:ANIME,sort:SEARCH_MATCH){id format season seasonYear episodes title{romaji english native} coverImage{large extraLarge} bannerImage}}}'
  for (const candidate of searchCandidates(title)) {
    const data = pickAniListSearchResult(await search(query, { t: candidate }), candidate)
    if (data) {
      const cover = data.coverImage || {}
      const entry = { id: data.id, cover: cover.extraLarge || cover.large, banner: data.bannerImage }
      cache[cacheKey] = entry
      persist(cache)
      return entry
    }
  }
  return null
}

const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA'])
const SEASON_ORDER: JsonObject = { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 }
const COUR_PART_RE = /\b(?:part|cour)\s*(?:[-:]\s*)?(\d+|first|second|third|fourth|1st|2nd|3rd|4th)\b/i
const COUR_ORDINALS: JsonObject = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 }

export function courPartNumber(media: JsonObject): number | null {
  const titles = media.title || {}
  for (const title of [titles.english, titles.romaji, titles.native]) {
    const value = String(title || '').match(COUR_PART_RE)?.[1]?.toLowerCase()
    if (value) return /^\d+$/.test(value) ? Number(value) : COUR_ORDINALS[value]
  }
  return null
}

function mediaPart(id: number, data: JsonObject, fallback: JsonObject = {}): ChainPart {
  const cover = data.coverImage || {}
  const titles = data.title || {}
  return {
    id, cover: cover.extraLarge || cover.large || fallback.cover,
    banner: data.bannerImage || fallback.banner,
    episodeCount: data.episodes ?? null,
    title: titles.english || titles.romaji,
  }
}

export interface AniListDependencies {
  lookup?: typeof anilistLookup
  media?: typeof alMedia
  persist?: typeof saveCache
}

export async function anilistChain(title: string, cache: JsonObject, dependencies: AniListDependencies = {}, overrideId?: number): Promise<ChainEntry[]> {
  const lookup = dependencies.lookup || anilistLookup
  const media = dependencies.media || alMedia
  const persist = dependencies.persist || saveCache
  const base = overrideId ? { id: overrideId } : await lookup(title, cache)
  if (!base) return []
  const chainKey = `chain:v8:${base.id}`
  if (cache[chainKey]) return cache[chainKey].chain || []
  const query = 'query($id:Int){Media(id:$id,type:ANIME){id format season seasonYear episodes title{romaji english native} coverImage{large extraLarge} bannerImage relations{edges{relationType node{id type}}}}}'
  const nodes = new Map<number, JsonObject>()
  const seen = new Set<number>([base.id])
  const queue = [base.id as number]
  while (queue.length && nodes.size < 50) {
    const id = queue.shift()!
    const data = await media(query, { id })
    if (!Object.keys(data).length) continue
    nodes.set(id, data)
    for (const edge of data.relations?.edges || []) {
      const nextId = edge.node?.id
      const nextType = edge.node?.type
      if (edge.relationType === 'SEQUEL' && (!nextType || nextType === 'ANIME') && nextId && !seen.has(nextId)) {
        seen.add(nextId)
        queue.push(nextId)
      }
    }
  }
  if (overrideId && !nodes.has(base.id)) return []
  const discovery = new Map([...nodes.keys()].map((id, index) => [id, index]))
  const seasonIds = [...nodes.keys()].filter((id) => id !== base.id && SEASON_FORMATS.has(nodes.get(id)?.format))
  seasonIds.sort((left, right) => {
    const a = nodes.get(left) || {}; const b = nodes.get(right) || {}
    const aa = [discovery.get(left) || 0, a.seasonYear || 0, SEASON_ORDER[a.season] ?? 4, left]
    const bb = [discovery.get(right) || 0, b.seasonYear || 0, SEASON_ORDER[b.season] ?? 4, right]
    for (let index = 0; index < aa.length; index += 1) if (aa[index] !== bb[index]) return aa[index] - bb[index]
    return 0
  })
  const groups: number[][] = [[base.id]]
  const groupById = new Map<number, number[]>([[base.id, groups[0]]])
  for (const id of seasonIds) {
    const data = nodes.get(id)!
    let group: number[] | undefined
    if ((courPartNumber(data) || 0) >= 2) {
      const prequels = (data.relations?.edges || []).filter((edge: JsonObject) => edge.relationType === 'PREQUEL').map((edge: JsonObject) => edge.node?.id)
      group = prequels.map((prequel: number) => groupById.get(prequel)).find(Boolean) || groups.at(-1)
    }
    if (!group) { group = []; groups.push(group) }
    group.push(id); groupById.set(id, group)
  }
  const chain = groups.map((ids, index) => {
    const parts = ids.map((id) => mediaPart(id, nodes.get(id) || {}, id === base.id ? base : {}))
    const first = parts[0]
    const counts = parts.map((part) => part.episodeCount)
    return {
      season: index + 1, id: first.id, ids: parts.map((part) => part.id), parts,
      cover: first.cover, banner: first.banner,
      episodeCount: counts.every((count) => count !== null) ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : null,
    } satisfies ChainEntry
  })
  cache[chainKey] = { chain }
  persist(cache)
  return chain
}
