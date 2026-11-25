import { api, fetchWithTimeout } from './http.js'
import { errorMessage, log } from './logging.js'
import { arrApiBase, type OutOfScopeItem } from './library.js'
import { configuredArrInstances, instanceSourceKey, sourceKeyOf, type ArrInstance } from './arr-instances.js'
import { libraryItemKey } from './user-rules.js'
import { upgradeParts } from '../shared/download-plan.js'
import type { ArrTagKey } from '../shared/settings.js'
import type { Config, JsonObject, LocalItem, ResultItem } from './types.js'

/** The one SeaDex status a series or movie can carry as a tag. */
export type TagState = 'best' | 'upgrade' | 'unlisted' | 'review'
export const TAG_SETTINGS: Record<TagState, ArrTagKey> = { best: 'arr_tag_best', upgrade: 'arr_tag_upgrade', unlisted: 'arr_tag_unlisted', review: 'arr_tag_review' }
const EDIT_BATCH = 500

/**
 * Sonarr and Radarr tag whole titles, so the seasons of a title share one state. A match that
 * needs review outranks everything, because no other status is trustworthy until it is confirmed.
 * Seasons excluded from upgrades neither make a title upgradable nor keep it from being best.
 */
export function titleTagState(seasons: ResultItem[]): TagState | null {
  if (!seasons.length) return null
  if (seasons.some(season => season.match_status === 'unmatched' || (!season.anilist_id && season.status === 'missing'))) return 'review'
  if (seasons.some(season => upgradeParts(season).length > 0)) return 'upgrade'
  const counted = seasons.filter(season => !season.excluded)
  if (counted.length && counted.every(season => season.status === 'best')) return 'best'
  if (seasons.every(season => season.status === 'missing')) return 'unlisted'
  return null
}

async function arrWrite(instance: ArrInstance, url: string, method: 'POST' | 'PUT', body: unknown): Promise<JsonObject> {
  const response = await fetchWithTimeout(url, { method, headers: { 'Content-Type': 'application/json', 'X-Api-Key': instance.key }, body: JSON.stringify(body) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${instance.name} rejected ${method} ${new URL(url).pathname} (HTTP ${response.status})`)
  }
  try { return await response.json() as JsonObject } catch { return {} }
}

async function loadTags(instance: ArrInstance, base: string): Promise<Map<string, number>> {
  const tags = await api(`${base}/tag`, instance.key, {}, instance.kind === 'sonarr') as JsonObject[]
  return new Map((Array.isArray(tags) ? tags : []).map(tag => [String(tag.label || '').trim().toLowerCase(), Number(tag.id)]))
}

async function applyTag(instance: ArrInstance, base: string, tagId: number, ids: number[], applyTags: 'add' | 'remove'): Promise<void> {
  const [path, field] = instance.kind === 'sonarr' ? ['series/editor', 'seriesIds'] : ['movie/editor', 'movieIds']
  for (let start = 0; start < ids.length; start += EDIT_BATCH) {
    await arrWrite(instance, `${base}/${path}`, 'PUT', { [field]: ids.slice(start, start + EDIT_BATCH), tags: [tagId], applyTags })
  }
}

export interface TagSyncInput {
  /** Titles loaded by this scan, with the tags they carry. */
  items: LocalItem[]
  /** Titles the library scope leaves out; a status tag on them is stale. */
  outOfScope: OutOfScopeItem[]
  results: ResultItem[]
  sourceErrors: Record<string, string>
}

/**
 * Keeps the configured status tags on series and movies in step with the scan results.
 * Only the configured tags are ever added or removed, and only on titles this scan loaded
 * or found out of scope. Nothing is written unless status tags are enabled.
 */
export async function syncArrTags(config: Config, input: TagSyncInput): Promise<void> {
  if (!config.arr_tags_enabled) return
  const states = (Object.keys(TAG_SETTINGS) as TagState[]).filter(state => config[TAG_SETTINGS[state]])
  if (!states.length) return
  const seasonsByTitle = new Map<string, ResultItem[]>()
  for (const result of input.results) {
    if (!result.library_key) continue
    seasonsByTitle.set(result.library_key, [...(seasonsByTitle.get(result.library_key) || []), result])
  }
  for (const instance of configuredArrInstances(config)) {
    if (input.sourceErrors[instance.name]) continue
    const items = input.items.filter(item => sourceKeyOf(item) === instanceSourceKey(instance))
    const outOfScope = input.outOfScope.filter(item => item.instance === instance.id)
    if (!items.length && !outOfScope.length) continue
    try {
      const base = await arrApiBase(instance)
      const tagIds = await loadTags(instance, base)
      let added = 0, removed = 0
      for (const state of states) {
        const label = config[TAG_SETTINGS[state]]
        let tagId = tagIds.get(label)
        const wanted = new Set(items.filter(item => titleTagState(seasonsByTitle.get(libraryItemKey(item)) || []) === state).map(item => Number(item.id)))
        const carries = (tags: number[] | undefined) => tagId !== undefined && Boolean(tags?.includes(tagId))
        const add = items.filter(item => wanted.has(Number(item.id)) && !carries(item.tags)).map(item => Number(item.id))
        const remove = [
          ...items.filter(item => !wanted.has(Number(item.id)) && carries(item.tags)).map(item => Number(item.id)),
          ...outOfScope.filter(item => carries(item.tags)).map(item => item.id),
        ]
        if (add.length && tagId === undefined) {
          tagId = Number((await arrWrite(instance, `${base}/tag`, 'POST', { label })).id)
          if (!Number.isInteger(tagId)) throw new Error(`${instance.name} did not return an ID for the new tag "${label}"`)
        }
        if (tagId === undefined) continue
        await applyTag(instance, base, tagId, add, 'add')
        await applyTag(instance, base, tagId, remove, 'remove')
        added += add.length; removed += remove.length
      }
      if (added || removed) log('INFO', `Status tags updated in ${instance.name}: ${added} added, ${removed} removed`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      log('WARNING', `Status tags could not be written to ${instance.name}: ${errorMessage(error)}`)
    }
  }
}

/** Removes every configured status tag from every title, for people who turn the feature off. */
export async function removeArrTags(config: Config): Promise<{ removed: number; errors: Record<string, string> }> {
  const labels = (Object.values(TAG_SETTINGS) as ArrTagKey[]).map(key => config[key]).filter(Boolean)
  const errors: Record<string, string> = {}
  let removed = 0
  for (const instance of configuredArrInstances(config)) {
    try {
      const base = await arrApiBase(instance)
      const tagIds = await loadTags(instance, base)
      const managed = labels.map(label => tagIds.get(label)).filter((id): id is number => id !== undefined)
      if (!managed.length) continue
      const titles = await api(`${base}/${instance.kind === 'sonarr' ? 'series' : 'movie'}`, instance.key, {}, instance.kind === 'sonarr') as JsonObject[]
      for (const tagId of managed) {
        const ids = titles.filter(title => Array.isArray(title.tags) && title.tags.map(Number).includes(tagId)).map(title => Number(title.id))
        await applyTag(instance, base, tagId, ids, 'remove')
        removed += ids.length
      }
    } catch (error) {
      errors[instance.name] = errorMessage(error)
    }
  }
  log(Object.keys(errors).length ? 'WARNING' : 'INFO', `Status tags removed from ${removed} title(s)${Object.keys(errors).length ? `; failed for ${Object.keys(errors).join(', ')}` : ''}`)
  return { removed, errors }
}
