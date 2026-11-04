import { USER_RULES_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import type { JsonObject } from './types.js'

export interface UserRules {
  mappings: Record<string, number>
  season_mappings?: Record<string, number[]>
  exclusions: string[]
}

const EMPTY_USER_RULES: UserRules = { mappings: {}, exclusions: [] }

export function loadUserRules(file = USER_RULES_FILE): UserRules {
  const raw = readJson<unknown>(file, EMPTY_USER_RULES, 'Could not read user rules')
  const stored: Partial<UserRules> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : EMPTY_USER_RULES
  const mappings = stored.mappings && typeof stored.mappings === 'object' && !Array.isArray(stored.mappings)
    ? Object.fromEntries(Object.entries(stored.mappings).filter(([key, value]) => key && Number.isInteger(value) && Number(value) > 0).map(([key, value]) => [key, Number(value)]))
    : {}
  const exclusions = Array.isArray(stored.exclusions)
    ? [...new Set(stored.exclusions.filter((value): value is string => typeof value === 'string' && Boolean(value)))].sort()
    : []
  const seasonMappings = stored.season_mappings && typeof stored.season_mappings === 'object' && !Array.isArray(stored.season_mappings)
    ? Object.fromEntries(Object.entries(stored.season_mappings).filter(([key, ids]) => key && validSeasonMappingIds(ids)))
    : {}
  return { mappings, season_mappings: seasonMappings, exclusions }
}

export function saveUserRules(rules: UserRules, file = USER_RULES_FILE): void {
  writeJsonAtomic(file, { mappings: rules.mappings, season_mappings: rules.season_mappings || {}, exclusions: [...new Set(rules.exclusions)].sort() }, true, 0o600)
}

export function validSeasonMappingIds(ids: unknown): ids is number[] {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 20 &&
    ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length
}

export function seasonMappingKey(libraryKey: string, season: number): string {
  return `${libraryKey}:${season}`
}

export function libraryItemKey(item: JsonObject): string {
  return `${String(item.arr || 'Unknown')}:item${String(item.id ?? '')}`
}

export function exclusionRuleKey(libraryKey: string, season: number | null, part = ''): string {
  return `${libraryKey}:${season ?? 0}:${part || '*'}`
}

export function applyUserRulesToResults(results: JsonObject[], rules = loadUserRules()): JsonObject[] {
  const excluded = new Set(rules.exclusions)
  return results.map((result) => {
    const libraryKey = String(result.library_key || '')
    if (!libraryKey) return { ...result }
    const season = Number(result.season || 0)
    const seasonExcluded = excluded.has(exclusionRuleKey(libraryKey, season))
    const parts = [...new Set<string>((result.releases || []).map((release: JsonObject) => String(release.part || '')).filter(Boolean))]
    const excludedParts = parts.filter((part) => excluded.has(exclusionRuleKey(libraryKey, season, part)))
    return { ...result, excluded: seasonExcluded, excluded_parts: excludedParts }
  })
}
