import { alMedia, alBatch } from './anilist-client.js'
import { scanRequests } from './http.js'
import { saveCache } from './results.js'
import type { JsonObject } from './types.js'

export const ANILIST_CACHE_TTL = 24 * 60 * 60 * 1000
const BATCH_SIZE = 25
const MEDIA_FIELDS = 'id format season seasonYear episodes title{romaji english native} coverImage{large extraLarge} bannerImage relations{edges{relationType node{id type}}}'
const MEDIA_QUERY = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`
const BATCH_QUERY = `query($ids:[Int]){Page(page:1,perPage:${BATCH_SIZE}){media(id_in:$ids,type:ANIME){${MEDIA_FIELDS}}}}`

export interface MetadataDependencies {
  media?: typeof alMedia
  batch?: typeof alBatch
  persist?: typeof saveCache
  now?: () => number
  prefetchIds?: number[]
}

export function freshCache(entry: JsonObject | undefined, now: number): boolean {
  return typeof entry?.fetched_at === 'number' && entry.fetched_at <= now && now - entry.fetched_at < ANILIST_CACHE_TTL
}

/** Cache raw metadata by ID so automatic chains and manual matches share it. */
export async function loadAniListMedia(ids: number[], cache: JsonObject, dependencies: MetadataDependencies = {}, refreshIds: number[] = []): Promise<Map<number, JsonObject>> {
  const now = dependencies.now ?? Date.now
  const persist = dependencies.persist ?? saveCache
  const refresh = new Set(refreshIds)
  const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0)
  const missing = unique.filter(id => {
    const cached = cache[`media:v1:${id}`]
    return refresh.has(id) || !freshCache(cached, now()) || !(cached.media === null || cached.media?.id === id)
  })
  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    scanRequests.getStore()?.throwIfAborted()
    const batchIds = missing.slice(offset, offset + BATCH_SIZE)
    // Keep support for integrations supplying a single-entry transport.
    const records = dependencies.media && !dependencies.batch
      ? await singleEntries(batchIds, dependencies.media)
      : await (dependencies.batch ?? alBatch)(BATCH_QUERY, { ids: batchIds })
    scanRequests.getStore()?.throwIfAborted()
    if (!Array.isArray(records) || records.some(record => !record || !batchIds.includes(record.id))) throw new Error('AniList returned invalid batch metadata')
    const byId = new Map(records.map(record => [record.id as number, record]))
    const fetchedAt = now()
    for (const id of batchIds) cache[`media:v1:${id}`] = { media: byId.get(id) ?? null, fetched_at: fetchedAt }
    persist(cache)
  }
  return new Map(unique.flatMap(id => {
    const media = cache[`media:v1:${id}`]?.media
    return media ? [[id, media] as [number, JsonObject]] : []
  }))
}

async function singleEntries(ids: number[], media: typeof alMedia): Promise<JsonObject[]> {
  const records: JsonObject[] = []
  for (const id of ids) {
    scanRequests.getStore()?.throwIfAborted()
    const data = await media(MEDIA_QUERY, { id })
    if (data.id === id) records.push(data)
    else if (Object.keys(data).length) throw new Error('AniList returned invalid media metadata')
  }
  return records
}

/** Derived caches must not extend the lifetime of the raw data used to build them. */
export function metadataFetchedAt(ids: number[], cache: JsonObject, now: number): number {
  return Math.min(now, ...ids.map(id => Number(cache[`media:v1:${id}`]?.fetched_at ?? now)))
}
