import { loadConfig, saveConfig } from './config.js'
import { log } from './logging.js'
import { cardKey } from '../shared/ids.js'
import type { ResultItem } from '../shared/contracts.js'

function bestReleases(result: ResultItem): string[] {
  return result.releases
    .filter(release => release.kind === 'best')
    .flatMap(release => {
      const scope = [
        result.season || 0,
        release.part || '',
        release.releaseGroup.trim().toLowerCase(),
        release.tracker.trim().toLowerCase(),
      ]
      const hashes = release.info_hashes.map(hash => hash.toLowerCase()).filter(Boolean)
      // Ignore selected files, sizes, notes, and other metadata that can change
      // without a new recommendation. Track each torrent so removals stay hidden.
      return hashes.length
        ? hashes.map(hash => JSON.stringify([...scope, hash]))
        : [JSON.stringify([...scope, release.quality.trim().toLowerCase()])]
    })
}

/** Hides or restores one library card and returns the saved list of hidden card keys. */
export function setCardHidden(key: string, hidden: boolean): string[] {
  const config = loadConfig()
  const keys = new Set(config.hidden)
  if (hidden) keys.add(key)
  else keys.delete(key)
  config.hidden = [...keys].sort()
  saveConfig(config)
  return config.hidden
}

export function unhideNewBestReleases(
  previous: ResultItem[],
  current: ResultItem[],
  dependencies = { loadConfig, saveConfig },
): string[] {
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
