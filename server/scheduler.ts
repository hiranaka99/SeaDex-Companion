import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextScanTime } from '../shared/scan-schedule.js'
import { writeJsonAtomic } from './persistence.js'
import { DATA_DIR } from './paths.js'
import { loadConfig } from './config.js'
import { getState, autocheckState } from './scan-state.js'
import { runScan } from './scan.js'
import { log } from './logging.js'
import type { Config, ScanSchedule, ScanScope, ScanTrigger } from './types.js'
const WEBHOOK_DEBOUNCE_SECONDS = 10
const SCHEDULER_TICK_MS = 5_000

const WEBHOOK_EVENTS: Record<'sonarr' | 'radarr', Set<string>> = {
  sonarr: new Set(['seriesadd']),
  radarr: new Set(['movieadded']),
}
export const webhookScanState: { dueAt: number | null; sources: Set<'sonarr' | 'radarr'>; sonarrIds: Set<number>; radarrIds: Set<number> } = { dueAt: null, sources: new Set(), sonarrIds: new Set(), radarrIds: new Set() }

export function resetWebhookScanState(): void {
  webhookScanState.dueAt = null
  webhookScanState.sources.clear()
  webhookScanState.sonarrIds.clear()
  webhookScanState.radarrIds.clear()
}

export function queueWebhookScan(source: 'sonarr' | 'radarr', eventType: unknown, targetId?: unknown, now = Date.now() / 1000): { accepted: boolean; dueAt: number | null } {
  const normalizedEvent = String(eventType || '').toLowerCase()
  const id = Number(targetId)
  if (!WEBHOOK_EVENTS[source].has(normalizedEvent) || !Number.isInteger(id) || id <= 0) return { accepted: false, dueAt: webhookScanState.dueAt }
  webhookScanState.sources.add(source)
  if (source === 'sonarr') webhookScanState.sonarrIds.add(id); else webhookScanState.radarrIds.add(id)
  webhookScanState.dueAt = now + WEBHOOK_DEBOUNCE_SECONDS
  const dueTime = new Date(webhookScanState.dueAt * 1000).toISOString()
  log('INFO', `${source === 'sonarr' ? 'Sonarr' : 'Radarr'} ${eventType} webhook queued an automatic scan for ${dueTime}`)
  return { accepted: true, dueAt: webhookScanState.dueAt }
}

function webhookTrigger(): ScanTrigger {
  return webhookScanState.sources.size > 1 ? 'sonarr+radarr' : webhookScanState.sources.has('sonarr') ? 'sonarr' : 'radarr'
}
export async function processWebhookScans(config: Config, now = Date.now() / 1000, scan: (config: Config, trigger: ScanTrigger, scope: ScanScope) => Promise<void> = (scanConfig, trigger, scope) => runScan(scanConfig, {}, trigger, scope)): Promise<void> {
  const scheduledPending = autocheckState.pending
  if (webhookScanState.dueAt === null || now < webhookScanState.dueAt || getState().running) return
  const trigger = scheduledPending ? 'scheduled' : webhookTrigger()
  const scope: ScanScope = scheduledPending ? {} : { sonarrIds: [...webhookScanState.sonarrIds], radarrIds: [...webhookScanState.radarrIds] }
  resetWebhookScanState()
  autocheckState.pending = false
  if (scheduledPending) persistAutocheckState()
  log('INFO', `Webhook debounce elapsed; starting ${scheduledPending ? 'full scheduled' : `incremental ${trigger}`} scan`)
  await scan(config, trigger, scope)
}

const SCHEDULE_STATE_FILE = resolve(DATA_DIR, 'scan_schedule_state.json')

function scheduleSignature(schedule: ScanSchedule): string {
  return JSON.stringify(schedule)
}

export function nextScheduledTime(schedule: ScanSchedule, after: number): number | null {
  const next = nextScanTime(schedule, after * 1000)
  return next === null ? null : next / 1000
}

function persistAutocheckState(): void {
  writeJsonAtomic(SCHEDULE_STATE_FILE, { signature: autocheckState.signature, next: autocheckState.next, pending: autocheckState.pending })
}

function restoreAutocheckState(): void {
  try {
    const stored = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf8'))
    if (typeof stored.signature === 'string' && (stored.next === null || Number.isFinite(stored.next))) {
      autocheckState.signature = stored.signature
      autocheckState.next = stored.next
      autocheckState.pending = stored.pending === true
    }
  } catch { /* A missing or damaged state file starts a fresh schedule. */ }
}

function skipMissedAutocheck(config: Config, now: number): void {
  if (config.scan_schedule.missed_run === 'skip' && autocheckState.pending) { autocheckState.pending = false; persistAutocheckState() }
  if (config.scan_schedule.missed_run !== 'skip' || autocheckState.next === null || autocheckState.next > now) return
  autocheckState.next = nextScheduledTime(config.scan_schedule, now)
  persistAutocheckState()
}

export function refreshAutocheckSchedule(config: Config, now = Date.now() / 1000): void {
  const schedule = config.scan_schedule
  const signature = scheduleSignature(schedule)
  if (!schedule.enabled) {
    autocheckState.signature = signature
    autocheckState.next = null
    autocheckState.pending = false
    persistAutocheckState()
    return
  }
  if (autocheckState.signature !== signature || autocheckState.next === null) {
    autocheckState.signature = signature
    autocheckState.next = nextScheduledTime(schedule, now)
    autocheckState.pending = false
    persistAutocheckState()
  }
}

export async function processAutocheck(config: Config, now = Date.now() / 1000, scan: (config: Config, trigger: ScanTrigger) => Promise<void> = (scanConfig, trigger) => runScan(scanConfig, {}, trigger)): Promise<void> {
  refreshAutocheckSchedule(config, now)
  const schedule = config.scan_schedule
  if (!schedule.enabled) return
  const due = autocheckState.next !== null && now >= autocheckState.next
  if (due) {
    autocheckState.next = nextScheduledTime(schedule, now)
    if (getState().running || webhookScanState.dueAt !== null) autocheckState.pending = true
    persistAutocheckState()
  }
  if (!due && !autocheckState.pending) return
  if (getState().running || webhookScanState.dueAt !== null) {
    if (due && getState().running) log('INFO', 'Automatic scan due while another scan is running — queued one scan')
    return
  }
  autocheckState.pending = false
  persistAutocheckState()
  log('INFO', `Automatic scan triggered (${schedule.mode} schedule)`)
  await scan(config, 'scheduled')
}

export function startScheduler(): NodeJS.Timeout {
  restoreAutocheckState()
  try { const config = loadConfig(); refreshAutocheckSchedule(config); skipMissedAutocheck(config, Date.now() / 1000) } catch (error) { log('ERROR', `Scheduler initialization failed: ${error instanceof Error ? error.message : String(error)}`) }
  return setInterval(() => {
    void (async () => {
      try { const config = loadConfig(); await processAutocheck(config); await processWebhookScans(config) }
      catch (error) { log('ERROR', `Scheduler error: ${error instanceof Error ? error.message : String(error)}`) }
    })()
  }, SCHEDULER_TICK_MS)
}
