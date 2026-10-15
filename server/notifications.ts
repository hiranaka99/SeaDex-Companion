import { NOTIFIED_FILE } from './paths.js'
import { loadStringSet, writeJsonAtomic } from './persistence.js'
import { scanState } from './scan-state.js'
import { applyUserRulesToResults } from './user-rules.js'
import { describeResultChange, matchPreviousResult } from './history.js'
import { fetchWithTimeout, sleep, scanRequests } from './http.js'
import { log, errorMessage } from './logging.js'
import type { Config, JsonObject } from './types.js'

export function loadNotified(file = NOTIFIED_FILE): Set<string> { return loadStringSet(file, 'Could not read notification history') }
export function saveNotified(keys: Set<string>, file = NOTIFIED_FILE): void { writeJsonAtomic(file, [...keys].sort()) }

const DISCORD_EMBED_COLORS: Record<string, number> = {
  upgrade: 0xf1c40f,
  partial: 0xe67e22,
  best: 0x57f287,
  missing: 0xed4245,
  uncovered: 0xed4245,
}

function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value
}

function seasonSuffix(result: JsonObject): string {
  return result.season ? ` (S${String(result.season).padStart(2, '0')})` : ''
}

function bestReleaseInfo(result: JsonObject): { group: string; quality: string; tracker: string; tags: string[] } {
  const releases = (result.releases || []) as JsonObject[]
  const release = releases.find((candidate) => candidate.kind === 'best') || releases[0] || {}
  return {
    group: String(result.best_group || '').trim(),
    quality: String(release.quality || '').trim(),
    tracker: String(release.tracker || '').trim(),
    tags: (Array.isArray(release.tags) ? release.tags : []).map(String).map((tag) => tag.trim()).filter(Boolean),
  }
}

function alternativeSummary(result: JsonObject): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const release of (result.releases || []) as JsonObject[]) {
    if (release.kind !== 'alt') continue
    const group = String(release.releaseGroup || '').trim()
    if (!group || seen.has(group.toLowerCase())) continue
    seen.add(group.toLowerCase())
    parts.push(String(release.quality || '').trim() ? `${group} (${String(release.quality).trim()})` : group)
    if (parts.length >= 3) break
  }
  return parts.join(', ')
}

/** Discord webhook payload for one upgrade notification: a short content line plus a rich embed. */
export function discordMessageBody(result: JsonObject): JsonObject {
  const title = truncateText(`${result.title || 'Unknown title'}${seasonSuffix(result)}`, 256)
  const info = bestReleaseInfo(result)
  const details = (Array.isArray(result.change_details) ? result.change_details : []).map(String).filter(Boolean)
  const fields: Array<{ name: string; value: string; inline?: boolean }> = []
  if (details.length) fields.push({ name: 'What changed', value: truncateText(details.join('\n'), 1024) })
  fields.push({ name: 'Have', value: truncateText((result.have || []).map(String).join(', ') || '—', 300), inline: true })
  fields.push({ name: 'Best release', value: truncateText([info.group, info.quality, info.tracker].filter(Boolean).join(' · ') || '—', 300), inline: true })
  const alternatives = alternativeSummary(result)
  if (alternatives) fields.push({ name: 'Alternatives', value: truncateText(alternatives, 512) })
  if (info.tags.length) fields.push({ name: 'Tags', value: truncateText(info.tags.join(', '), 300), inline: true })
  const notes = String(result.notes || '').trim()
  if (notes && notes !== '-') fields.push({ name: 'Notes', value: truncateText(notes, 1024) })
  const embed: JsonObject = {
    title,
    color: DISCORD_EMBED_COLORS[String(result.status || '')] ?? 0x5865f2,
    author: { name: `SeaDex · ${String(result.arr || 'Library')}` },
    fields,
    footer: { text: 'releases.moe' },
    timestamp: new Date().toISOString(),
  }
  if (result.url) embed.url = String(result.url)
  if (result.image) embed.thumbnail = { url: String(result.image) }
  const content = info.group ? `${title} — new best release ${info.group}` : `${title} — upgrade available`
  return { content: truncateText(content, 1900), embeds: [embed] }
}

export async function sendToDiscord(webhook: string, results: JsonObject[], onSent?: (result: JsonObject) => void): Promise<number> {
  const started = Date.now()
  log('INFO', `Discord notification batch started: ${results.length} upgrade${results.length === 1 ? '' : 's'}`)
  let sent = 0
  for (const result of results) {
    try {
      const response = await fetchWithTimeout(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discordMessageBody(result)) }, 30_000)
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160)
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      sent += 1
      onSent?.(result)
      await sleep(500)
    } catch (error) {
      scanRequests.getStore()?.throwIfAborted()
      log('ERROR', `Discord webhook failed for ${String(result.title || 'Unknown title')}: ${errorMessage(error)}`)
    }
  }
  log(sent === results.length ? 'INFO' : 'WARNING', `Discord notification batch finished in ${((Date.now() - started) / 1000).toFixed(1)}s: sent ${sent}/${results.length}`)
  return sent
}

export interface NotificationDependencies {
  load?: typeof loadNotified
  save?: typeof saveNotified
  send?: typeof sendToDiscord
  previous?: JsonObject[]
}

export async function autoNotifyNew(config: Config, dependencies: NotificationDependencies = {}): Promise<number> {
  const notified = (dependencies.load || loadNotified)()
  const save = dependencies.save || saveNotified
  const currentByKey = new Map(scanState.results.filter((result) => result.key).map((result) => [String(result.key), result]))
  let notificationStateChanged = false
  for (const key of [...notified]) {
    const current = currentByKey.get(key)
    if (current && current.status !== 'upgrade' && !(current.status === 'partial' && current.upgrade_available)) {
      notified.delete(key)
      notificationStateChanged = true
    }
  }
  if (!config.notify_enabled) {
    if (notificationStateChanged) save(notified)
    log('INFO', 'Discord notifications skipped: disabled in configuration')
    return 0
  }
  if (!config.webhook) {
    if (notificationStateChanged) save(notified)
    log('WARNING', 'Discord notifications skipped: no webhook is configured')
    return 0
  }
  const fresh = applyUserRulesToResults(scanState.results).filter((result) => {
    if (result.excluded) return false
    const excludedParts = new Set((result.excluded_parts || []).map(String))
    const bestParts = [...new Set((result.releases || []).filter((release: JsonObject) => release.kind === 'best').map((release: JsonObject) => String(release.part || '')))]
    const hasIncludedPart = bestParts.length === 0 || bestParts.some((part) => !excludedParts.has(part))
    return hasIncludedPart && (result.status === 'upgrade' || (result.status === 'partial' && result.upgrade_available)) && result.key && !notified.has(result.key)
  })
  if (!fresh.length) {
    if (notificationStateChanged) save(notified)
    log('INFO', 'Discord notifications: no new upgrades to send')
    return 0
  }
  const previous = dependencies.previous || []
  const payload = fresh.map((result) => {
    if (!previous.length) return result
    const details = describeResultChange(matchPreviousResult(previous, result), result)
    return details.length ? { ...result, change_details: details } : result
  })
  const delivered: JsonObject[] = []
  try { return await (dependencies.send || sendToDiscord)(config.webhook, payload, (result) => delivered.push(result)) }
  finally {
    for (const result of delivered) notified.add(result.key)
    if (notificationStateChanged || delivered.length) save(notified)
  }
}
