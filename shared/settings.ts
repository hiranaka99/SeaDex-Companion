import type { LibraryScope, ReleasePreferences } from './contracts.js'

export const DEFAULT_RELEASE_PREFERENCES: ReleasePreferences = {
  size: 'largest',
  dual_audio: false,
  max_episode_gb: 0,
  ignored_groups: [],
  ignored_trackers: [],
  accept_alternatives: false,
  strict: false,
}

/** Shown wherever SeaDex lists releases for a season or cour but the saved preferences accept none of them. */
export const PREFERENCE_BLOCKED_REASON = 'No listed release fits your release preferences'

export const EMPTY_LIBRARY_SCOPE: LibraryScope = { anime_only: false, include_tags: [], exclude_tags: [], root_folders: [] }

export const ARR_TAG_KEYS = ['arr_tag_best', 'arr_tag_upgrade', 'arr_tag_unlisted', 'arr_tag_review'] as const
export type ArrTagKey = typeof ARR_TAG_KEYS[number]
export const DEFAULT_ARR_TAGS: Record<ArrTagKey, string> = {
  arr_tag_best: 'seadex-best',
  arr_tag_upgrade: 'seadex-upgradable',
  arr_tag_unlisted: 'seadex-unlisted',
  arr_tag_review: 'seadex-review',
}
/** Sonarr and Radarr accept lowercase letters, digits, and hyphens in tag labels. */
export const ARR_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

const MAX_LIST_ITEMS = 100
const MAX_ITEM_LENGTH = 200

/** Trimmed, case-insensitively unique entries from a list or a comma/newline separated string. */
export function textList(value: unknown, label = 'list'): string[] {
  const raw = typeof value === 'string' ? value.split(/[,\n]/) : Array.isArray(value) ? value : value == null ? [] : null
  if (!raw) throw new Error(`${label} must be a list of text values`)
  const seen = new Set<string>()
  const items: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error(`${label} must contain only text values`)
    const text = entry.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    if (text.length > MAX_ITEM_LENGTH) throw new Error(`${label} entries must be ${MAX_ITEM_LENGTH} characters or fewer`)
    seen.add(text.toLowerCase())
    items.push(text)
  }
  if (items.length > MAX_LIST_ITEMS) throw new Error(`${label} may contain at most ${MAX_LIST_ITEMS} entries`)
  return items
}

export function normalizeLibraryScope(value: unknown, label = 'scope'): LibraryScope {
  if (value == null) return { ...EMPTY_LIBRARY_SCOPE, include_tags: [], exclude_tags: [], root_folders: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const source = value as Record<string, unknown>
  if (source.anime_only !== undefined && typeof source.anime_only !== 'boolean') throw new Error(`${label}.anime_only must be a boolean`)
  return {
    anime_only: source.anime_only === true,
    include_tags: textList(source.include_tags, `${label}.include_tags`).map(tag => tag.toLowerCase()),
    exclude_tags: textList(source.exclude_tags, `${label}.exclude_tags`).map(tag => tag.toLowerCase()),
    root_folders: textList(source.root_folders, `${label}.root_folders`),
  }
}

export function scopeIsEmpty(scope: LibraryScope | undefined): boolean {
  return !scope || (!scope.anime_only && !scope.include_tags.length && !scope.exclude_tags.length && !scope.root_folders.length)
}

export function normalizeReleasePreferences(value: unknown): ReleasePreferences {
  if (value == null) return { ...DEFAULT_RELEASE_PREFERENCES, ignored_groups: [], ignored_trackers: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('release_preferences must be an object')
  const source = value as Record<string, unknown>
  if (source.size !== undefined && source.size !== 'largest' && source.size !== 'smallest') throw new Error('release_preferences.size must be largest or smallest')
  for (const key of ['dual_audio', 'accept_alternatives', 'strict'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') throw new Error(`release_preferences.${key} must be a boolean`)
  }
  const limit = source.max_episode_gb === undefined || source.max_episode_gb === null || source.max_episode_gb === '' ? 0 : Number(source.max_episode_gb)
  if (!Number.isFinite(limit) || limit < 0 || limit > 1000) throw new Error('release_preferences.max_episode_gb must be between 0 and 1000')
  return {
    size: source.size === 'smallest' ? 'smallest' : 'largest',
    dual_audio: source.dual_audio === true,
    max_episode_gb: Math.round(limit * 100) / 100,
    ignored_groups: textList(source.ignored_groups, 'release_preferences.ignored_groups'),
    ignored_trackers: textList(source.ignored_trackers, 'release_preferences.ignored_trackers'),
    accept_alternatives: source.accept_alternatives === true,
    strict: source.strict === true,
  }
}

/** True when the preferences leave SeaDex's own pick untouched. */
export function preferencesAreDefault(preferences: ReleasePreferences): boolean {
  return JSON.stringify(normalizeReleasePreferences(preferences)) === JSON.stringify(normalizeReleasePreferences(null))
}
