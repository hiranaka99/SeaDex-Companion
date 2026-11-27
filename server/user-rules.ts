import { isRecord } from '../shared/guards.js'
import { USER_RULES_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { sourceKeyOf } from '../shared/arr-instances.js'
import type { LocalItem, ResultItem } from './types.js'

export interface UserRules {
  mappings: Record<string, number>
  season_mappings?: Record<string, number[]>
  exclusions: string[]
}

const EMPTY_USER_RULES: UserRules = { mappings: {}, exclusions: [] }

export function loadUserRules(file = USER_RULES_FILE): UserRules {
  const raw = readJson<unknown>(file, EMPTY_USER_RULES, 'Could not read user rules')
  const stored: Partial<UserRules> = isRecord(raw) ? raw : EMPTY_USER_RULES
  const mappings = isRecord(stored.mappings)
    ? Object.fromEntries(
        Object.entries(stored.mappings)
          .filter(([key, value]) => key && Number.isInteger(value) && Number(value) > 0)
          .map(([key, value]) => [key, Number(value)]),
      )
    : {}
  const exclusions = Array.isArray(stored.exclusions)
    ? [
        ...new Set(stored.exclusions.filter((value): value is string => typeof value === 'string' && Boolean(value))),
      ].sort()
    : []
  const seasonMappings = isRecord(stored.season_mappings)
    ? Object.fromEntries(
        Object.entries(stored.season_mappings).filter(([key, ids]) => key && validSeasonMappingIds(ids)),
      )
    : {}
  return { mappings, season_mappings: seasonMappings, exclusions }
}

export function saveUserRules(rules: UserRules, file = USER_RULES_FILE): void {
  writeJsonAtomic(
    file,
    {
      mappings: rules.mappings,
      season_mappings: rules.season_mappings || {},
      exclusions: [...new Set(rules.exclusions)].sort(),
    },
    true,
    0o600,
  )
}

export function validSeasonMappingIds(ids: unknown): ids is number[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 20 &&
    ids.every(id => Number.isSafeInteger(id) && id > 0) &&
    new Set(ids).size === ids.length
  )
}

export function seasonMappingKey(libraryKey: string, season: number): string {
  return `${libraryKey}:${season}`
}

export function libraryItemKey(item: Pick<LocalItem, 'arr' | 'id' | 'instance'>): string {
  return `${sourceKeyOf(item)}:item${item.id}`
}

export function exclusionRuleKey(libraryKey: string, season: number | null, part = ''): string {
  return `${libraryKey}:${season ?? 0}:${part || '*'}`
}

/** The fields exclusion rules read; callers keep whatever richer result type they pass in. */
type RuleScopedResult = Pick<ResultItem, 'library_key' | 'season'> & { releases?: { part?: string }[] }

export function applyUserRulesToResults<Result extends RuleScopedResult>(
  results: Result[],
  rules = loadUserRules(),
): (Result & { excluded?: boolean; excluded_parts?: string[] })[] {
  const excluded = new Set(rules.exclusions)
  return results.map(result => {
    if (!result.library_key) return { ...result }
    const season = result.season || 0
    const parts = [...new Set((result.releases || []).map(release => release.part || '').filter(Boolean))]
    return {
      ...result,
      excluded: excluded.has(exclusionRuleKey(result.library_key, season)),
      excluded_parts: parts.filter(part => excluded.has(exclusionRuleKey(result.library_key!, season, part))),
    }
  })
}

/** Pins a library title to an AniList entry, or restores automatic matching with null. */
export function setTitleMapping(libraryKey: string, anilistId: number | null): void {
  const rules = loadUserRules()
  if (anilistId === null) delete rules.mappings[libraryKey]
  else rules.mappings[libraryKey] = anilistId
  saveUserRules(rules)
}

/** Pins one season to AniList entries in episode order, or restores automatic matching with null. */
export function setSeasonMapping(libraryKey: string, season: number, anilistIds: number[] | null): void {
  const rules = loadUserRules()
  const mappings = (rules.season_mappings ||= {})
  if (anilistIds === null) delete mappings[seasonMappingKey(libraryKey, season)]
  else mappings[seasonMappingKey(libraryKey, season)] = anilistIds
  saveUserRules(rules)
}

/** Keeps a season or one of its cours out of bulk downloads and notifications, or brings it back. */
export function setExclusion(libraryKey: string, season: number, part: string, excluded: boolean): void {
  const rules = loadUserRules()
  const exclusions = new Set(rules.exclusions)
  if (excluded) exclusions.add(exclusionRuleKey(libraryKey, season, part))
  else exclusions.delete(exclusionRuleKey(libraryKey, season, part))
  saveUserRules({ ...rules, exclusions: [...exclusions] })
}
