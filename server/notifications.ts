import { NOTIFIED_FILE } from './paths.js'
import { loadStringSet, writeJsonAtomic } from './persistence.js'
import { scanState } from './scan-state.js'
import { applyUserRulesToResults } from './user-rules.js'
import { describeResultChange, previousResultMatcher } from './history.js'
import { fetchWithTimeout, sleep, scanRequests } from './http.js'
import { log } from './logging.js'
import { errorMessage } from '../shared/errors.js'
import { isSeasonUpgradable } from '../shared/download-plan.js'
import { seasonTag } from '../shared/ids.js'
import { sourceNameOf } from './arr-instances.js'
import type { ImportProblem } from './import-follow.js'
import type { Config, JsonObject, ResultItem } from './types.js'

/** A result about to be announced, with what changed since the previous scan when that is known. */
export type NotifiedResult = ResultItem & {
  change_details?: string[]
  /** Why the result lost its best release, when a library change caused it. */
  regression?: string
}

export function loadNotified(file = NOTIFIED_FILE): Set<string> {
  return loadStringSet(file, 'Could not read notification history')
}
export function saveNotified(keys: Set<string>, file = NOTIFIED_FILE): void {
  writeJsonAtomic(file, [...keys].sort())
}

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

function bestReleaseInfo(result: ResultItem): { group: string; quality: string; tracker: string; tags: string[] } {
  const release = result.releases.find(candidate => candidate.kind === 'best') || result.releases[0]
  return {
    group: (result.best_group || '').trim(),
    quality: (release?.quality || '').trim(),
    tracker: (release?.tracker || '').trim(),
    tags: (release?.tags || []).map(tag => tag.trim()).filter(Boolean),
  }
}

function alternativeSummary(result: ResultItem): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const release of result.releases) {
    if (release.kind !== 'alt') continue
    const group = release.releaseGroup.trim()
    if (!group || seen.has(group.toLowerCase())) continue
    seen.add(group.toLowerCase())
    const quality = release.quality.trim()
    parts.push(quality ? `${group} (${quality})` : group)
    if (parts.length >= 3) break
  }
  return parts.join(', ')
}

/** Discord webhook payload for one upgrade notification: a short content line plus a rich embed. */
export function discordMessageBody(result: NotifiedResult): JsonObject {
  const title = truncateText(
    `${result.title || 'Unknown title'}${result.season ? ` (${seasonTag(result.season)})` : ''}`,
    256,
  )
  const info = bestReleaseInfo(result)
  const regression = result.regression || ''
  const mismatched = [...new Set(Object.values(result.mismatched_by_part || {}).flat())]
  const details = regression ? [regression] : (result.change_details || []).filter(Boolean)
  const fields: Array<{ name: string; value: string; inline?: boolean }> = []
  if (details.length) fields.push({ name: 'What changed', value: truncateText(details.join('\n'), 1024) })
  fields.push({ name: 'Have', value: truncateText(result.have.join(', ') || '—', 300), inline: true })
  fields.push({
    name: 'Best release',
    value: truncateText([info.group, info.quality, info.tracker].filter(Boolean).join(' · ') || '—', 300),
    inline: true,
  })
  const alternatives = alternativeSummary(result)
  if (alternatives) fields.push({ name: 'Alternatives', value: truncateText(alternatives, 512) })
  if (info.tags.length) fields.push({ name: 'Tags', value: truncateText(info.tags.join(', '), 300), inline: true })
  const notes = (result.notes || '').trim()
  if (notes && notes !== '-') fields.push({ name: 'Notes', value: truncateText(notes, 1024) })
  const embed: JsonObject = {
    title,
    color: regression ? 0xed4245 : (DISCORD_EMBED_COLORS[result.status] ?? 0x5865f2),
    author: { name: `SeaDex · ${result.arr ? sourceNameOf(result) : 'Library'}` },
    fields,
    footer: { text: 'seadex.moe' },
    timestamp: new Date().toISOString(),
  }
  if (result.url) embed.url = result.url
  if (result.image) embed.thumbnail = { url: result.image }
  // A regression or a file mismatch is not a new recommendation, so the headline says what happened instead.
  const content = regression
    ? `${title} — no longer on its best release`
    : mismatched.length
      ? `${title} — your ${mismatched.join(', ')} files differ from the listed release`
      : info.group
        ? `${title} — new best release ${info.group}`
        : `${title} — upgrade available`
  return { content: truncateText(content, 1900), embeds: [embed] }
}

export async function sendToDiscord(
  webhook: string,
  results: NotifiedResult[],
  onSent?: (result: NotifiedResult) => void,
): Promise<number> {
  const started = Date.now()
  log('INFO', `Discord notification batch started: ${results.length} upgrade${results.length === 1 ? '' : 's'}`)
  let sent = 0
  for (const result of results) {
    try {
      const response = await fetchWithTimeout(
        webhook,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(discordMessageBody(result)),
        },
        30_000,
      )
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160)
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      sent += 1
      onSent?.(result)
      await sleep(500)
    } catch (error) {
      scanRequests.getStore()?.throwIfAborted()
      log('ERROR', `Discord webhook failed for ${result.title || 'Unknown title'}: ${errorMessage(error)}`)
    }
  }
  log(
    sent === results.length ? 'INFO' : 'WARNING',
    `Discord notification batch finished in ${((Date.now() - started) / 1000).toFixed(1)}s: sent ${sent}/${results.length}`,
  )
  return sent
}

export interface NotificationDependencies {
  load?: typeof loadNotified
  save?: typeof saveNotified
  send?: typeof sendToDiscord
  previous?: ResultItem[]
  /** Result keys that lost their best release because the library files changed, with what changed. */
  regressions?: Record<string, string>
}

/** True when at least one best release of the result sits outside the user's excluded cours. */
function hasIncludedBestPart(result: ResultItem & { excluded_parts?: string[] }): boolean {
  const excludedParts = new Set(result.excluded_parts || [])
  const bestParts = new Set(
    result.releases.filter(release => release.kind === 'best').map(release => release.part || ''),
  )
  return bestParts.size === 0 || [...bestParts].some(part => !excludedParts.has(part))
}

/** One notification for a finished download that Sonarr or Radarr did not import. */
export async function sendImportProblem(config: Config, problem: ImportProblem): Promise<boolean> {
  if (!config.webhook) return false
  const season = problem.season ? ` (${seasonTag(problem.season)})` : ''
  const title = truncateText(`${problem.title}${season}`, 256)
  const headline =
    problem.state === 'blocked'
      ? `${problem.app} is not importing a finished download`
      : `A finished download was not imported by ${problem.app}`
  const fields = [
    ...(problem.releaseGroup
      ? [{ name: 'Release', value: truncateText(problem.releaseGroup, 300), inline: true }]
      : []),
    ...(problem.message ? [{ name: `${problem.app} reports`, value: truncateText(problem.message, 1024) }] : []),
  ]
  try {
    const response = await fetchWithTimeout(
      config.webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: truncateText(`${title} — ${headline}`, 1900),
          embeds: [
            {
              title,
              color: 0xe67e22,
              author: { name: `SeaDex · ${problem.app}` },
              fields,
              footer: { text: 'SeaDex Companion' },
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
      30_000,
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return true
  } catch (error) {
    log('ERROR', `Discord webhook failed for the import problem of ${problem.title}: ${errorMessage(error)}`)
    return false
  }
}

export async function autoNotifyNew(config: Config, dependencies: NotificationDependencies = {}): Promise<number> {
  const notified = (dependencies.load || loadNotified)()
  const save = dependencies.save || saveNotified
  const currentByKey = new Map(scanState.results.filter(result => result.key).map(result => [result.key, result]))
  let notificationStateChanged = false
  for (const key of [...notified]) {
    const current = currentByKey.get(key)
    if (current && !isSeasonUpgradable(current)) {
      notified.delete(key)
      notificationStateChanged = true
    }
  }
  const skip = (level: 'INFO' | 'WARNING', reason: string): number => {
    if (notificationStateChanged) save(notified)
    log(level, reason)
    return 0
  }
  if (!config.notify_enabled) return skip('INFO', 'Discord notifications skipped: disabled in configuration')
  if (!config.webhook) return skip('WARNING', 'Discord notifications skipped: no webhook is configured')
  const fresh = applyUserRulesToResults(scanState.results).filter(
    result =>
      !result.excluded &&
      hasIncludedBestPart(result) &&
      isSeasonUpgradable(result) &&
      result.key &&
      !notified.has(result.key),
  )
  if (!fresh.length) return skip('INFO', 'Discord notifications: no new upgrades to send')
  const previous = dependencies.previous || []
  const regressions = dependencies.regressions || {}
  const previousOf = previousResultMatcher(previous)
  const payload: NotifiedResult[] = fresh.map(result => {
    if (regressions[result.key]) return { ...result, regression: regressions[result.key] }
    if (!previous.length) return result
    const details = describeResultChange(previousOf(result), result)
    return details.length ? { ...result, change_details: details } : result
  })
  const delivered: NotifiedResult[] = []
  try {
    return await (dependencies.send || sendToDiscord)(config.webhook, payload, result => delivered.push(result))
  } finally {
    for (const result of delivered) notified.add(result.key)
    if (notificationStateChanged || delivered.length) save(notified)
  }
}
