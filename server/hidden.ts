import { loadConfig, saveConfig } from './config.js'
import { log } from './logging.js'
import type { JsonObject } from './types.js'

// Match the library's card grouping, including titles without an AniList match.
export function cardKey(result: JsonObject): string {
  // Cards of an additional instance are kept apart from the same anime in another library.
  const prefix = typeof result.instance === 'string' && result.instance ? `${result.instance}:` : ''
  if (result.group_id != null) return `${prefix}${result.group_id}`
  if (result.anilist_id != null) return `${prefix}${result.anilist_id}`
  const parts = String(result.key || '').split(':')
  return `${prefix}${result.arr}:${parts.length >= 2 ? parts[1] : result.title}`
}

function bestReleases(result: JsonObject): string[] {
  return (result.releases || []).filter((release: JsonObject) => release.kind === 'best').flatMap((release: JsonObject) => {
    const scope = [Number(result.season || 0), release.part || '', String(release.releaseGroup || '').trim().toLowerCase(), String(release.tracker || '').trim().toLowerCase()]
    const hashes = (release.info_hashes || []).map((hash: string) => hash.toLowerCase()).filter(Boolean)
    // Ignore selected files, sizes, notes, and other metadata that can change
    // without a new recommendation. Track each torrent so removals stay hidden.
    return hashes.length
      ? hashes.map((hash: string) => JSON.stringify([...scope, hash]))
      : [JSON.stringify([...scope, String(release.quality || '').trim().toLowerCase()])]
  })
}

export function unhideNewBestReleases(previous: JsonObject[], current: JsonObject[], dependencies = { loadConfig, saveConfig }): string[] {
  // Use the latest settings so a scan cannot overwrite edits made while it ran.
  const config = dependencies.loadConfig()
  if (!config.unhide_on_new_best || !config.hidden.length) return []
  const before = new Map<string, Set<string>>()
  for (const result of previous) {
    const key = cardKey(result)
    const releases = before.get(key) || new Set<string>()
    for (const identity of bestReleases(result)) releases.add(identity)
    before.set(key, releases)
  }
  const hidden = new Set(config.hidden)
  const restored = new Set<string>()
  for (const result of current) {
    const key = cardKey(result)
    const old = before.get(key)
    // A first scan (including after clearing scan data) establishes a baseline.
    if (hidden.has(key) && old && bestReleases(result).some(identity => !old.has(identity))) restored.add(key)
  }
  if (restored.size) {
    dependencies.saveConfig({ ...config, hidden: config.hidden.filter(key => !restored.has(key)) })
    log('INFO', `Restored ${restored.size} hidden anime with new best releases (keys: ${[...restored].join(', ')})`)
  }
  return [...restored]
}
