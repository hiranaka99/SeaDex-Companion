import { errorMessage } from '../shared/errors.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextScanTime } from '../shared/scan-schedule.js'
import { writeJsonAtomic } from './persistence.js'
import { DATA_DIR } from './paths.js'
import { loadConfig } from './config.js'
import { getState, autocheckState } from './scan-state.js'
import { runScan } from './scan.js'
import { log } from './logging.js'
import { followImports, importsToFollow, readArrQueue } from './import-follow.js'
import { collectDownloadProgress } from './download-progress.js'
import { sendImportProblem } from './notifications.js'
import type { ArrInstance } from './arr-instances.js'
import type { Config, ScanSchedule, ScanScope, ScanTrigger } from './types.js'
const WEBHOOK_DEBOUNCE_SECONDS = 10
const SCHEDULER_TICK_MS = 5_000
const IMPORT_FOLLOW_INTERVAL_MS = 60_000

type ArrSource = 'sonarr' | 'radarr'
/** Events announcing a new title. It is scanned whether or not the results know it yet. */
const ADD_EVENTS: Record<ArrSource, Set<string>> = {
  sonarr: new Set(['seriesadd']),
  radarr: new Set(['movieadded']),
}
/** Events announcing imported files. Only titles already in the results are rescanned, so imports of other shows cost nothing. */
const IMPORT_EVENTS: Record<ArrSource, Set<string>> = {
  sonarr: new Set(['download', 'importcomplete']),
  radarr: new Set(['download']),
}
/** Events saying an import needs a person. They bring the next import check forward. */
const ATTENTION_EVENTS = new Set(['manualinteractionrequired'])

export const webhookScanState: {
  dueAt: number | null
  sources: Set<ArrSource>
  sonarrIds: Set<number>
  radarrIds: Set<number>
  /** Item IDs of additional instances, by instance identifier. */
  instanceIds: Map<string, Set<number>>
} = { dueAt: null, sources: new Set(), sonarrIds: new Set(), radarrIds: new Set(), instanceIds: new Map() }

export function resetWebhookScanState(): void {
  webhookScanState.dueAt = null
  webhookScanState.sources.clear()
  webhookScanState.sonarrIds.clear()
  webhookScanState.radarrIds.clear()
  webhookScanState.instanceIds.clear()
}

function queueItem(instanceId: string, id: number): void {
  if (instanceId === 'sonarr') webhookScanState.sonarrIds.add(id)
  else if (instanceId === 'radarr') webhookScanState.radarrIds.add(id)
  else
    webhookScanState.instanceIds.set(
      instanceId,
      (webhookScanState.instanceIds.get(instanceId) || new Set<number>()).add(id),
    )
}

/** `known` says the title is already in the scan results; import events are ignored for any other title. */
export function queueWebhookScan(
  source: ArrSource,
  eventType: unknown,
  targetId?: unknown,
  now = Date.now() / 1000,
  options: { instanceId?: string; known?: boolean } = {},
): { accepted: boolean; dueAt: number | null } {
  const normalizedEvent = String(eventType || '').toLowerCase()
  const id = Number(targetId)
  const wanted =
    ADD_EVENTS[source].has(normalizedEvent) || (IMPORT_EVENTS[source].has(normalizedEvent) && options.known === true)
  if (!wanted || !Number.isInteger(id) || id <= 0) return { accepted: false, dueAt: webhookScanState.dueAt }
  webhookScanState.sources.add(source)
  queueItem(options.instanceId || source, id)
  webhookScanState.dueAt = now + WEBHOOK_DEBOUNCE_SECONDS
  const dueTime = new Date(webhookScanState.dueAt * 1000).toISOString()
  log(
    'INFO',
    `${source === 'sonarr' ? 'Sonarr' : 'Radarr'} ${eventType} webhook queued an automatic scan for ${dueTime}`,
  )
  return { accepted: true, dueAt: webhookScanState.dueAt }
}

/** True for a webhook event that reports imported files, which only matters for titles already in the results. */
export function isLibraryImportEvent(source: ArrSource, eventType: unknown): boolean {
  return IMPORT_EVENTS[source].has(String(eventType || '').toLowerCase())
}

/** True for a webhook event that reports an import waiting for manual interaction. */
export function isImportAttentionEvent(eventType: unknown): boolean {
  return ATTENTION_EVENTS.has(String(eventType || '').toLowerCase())
}

/** Queues a rescan of one title so a finished download can be checked against the library. */
export function queueImportScan(instance: Pick<ArrInstance, 'id'>, itemId: number, now = Date.now() / 1000): void {
  if (!Number.isInteger(itemId) || itemId <= 0) return
  queueItem(instance.id, itemId)
  // An import check never postpones a scan that is already due.
  if (webhookScanState.dueAt === null) webhookScanState.dueAt = now + WEBHOOK_DEBOUNCE_SECONDS
}

function webhookTrigger(): ScanTrigger {
  if (webhookScanState.sources.size > 1) return 'sonarr+radarr'
  return webhookScanState.sources.has('sonarr')
    ? 'sonarr'
    : webhookScanState.sources.has('radarr')
      ? 'radarr'
      : 'import'
}

let nextImportFollow = 0
let followingImports = false
/** Runs the next import check on the following scheduler tick instead of waiting out the interval. */
export function requestImportFollow(): void {
  nextImportFollow = 0
}

export async function processImportFollow(config: Config, now = Date.now()): Promise<void> {
  if (followingImports || now < nextImportFollow) return
  nextImportFollow = now + IMPORT_FOLLOW_INTERVAL_MS
  if (!importsToFollow(now)) return
  followingImports = true
  try {
    await followImports(config, {
      readProgress: collectDownloadProgress,
      readQueue: readArrQueue,
      notify: sendImportProblem,
      requestScan: (instance, itemId) => queueImportScan(instance, itemId, now / 1000),
      scanRunning: () => getState().running,
      now: () => now,
    })
  } catch (error) {
    log('WARNING', `Import follow-up failed: ${errorMessage(error)}`)
  } finally {
    followingImports = false
  }
}
export async function processWebhookScans(
  config: Config,
  now = Date.now() / 1000,
  scan: (config: Config, trigger: ScanTrigger, scope: ScanScope) => Promise<void> = runScan,
): Promise<void> {
  const scheduledPending = autocheckState.pending
  if (webhookScanState.dueAt === null || now < webhookScanState.dueAt || getState().running) return
  const trigger = scheduledPending ? 'scheduled' : webhookTrigger()
  const scope: ScanScope = scheduledPending
    ? {}
    : {
        sonarrIds: [...webhookScanState.sonarrIds],
        radarrIds: [...webhookScanState.radarrIds],
        ...(webhookScanState.instanceIds.size
          ? { instances: Object.fromEntries([...webhookScanState.instanceIds].map(([id, ids]) => [id, [...ids]])) }
          : {}),
      }
  resetWebhookScanState()
  autocheckState.pending = false
  if (scheduledPending) persistAutocheckState()
  log(
    'INFO',
    `Webhook debounce elapsed; starting ${scheduledPending ? 'full scheduled' : `incremental ${trigger}`} scan`,
  )
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
  writeJsonAtomic(SCHEDULE_STATE_FILE, {
    signature: autocheckState.signature,
    next: autocheckState.next,
    pending: autocheckState.pending,
  })
}

function restoreAutocheckState(): void {
  try {
    const stored = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf8'))
    if (typeof stored.signature === 'string' && (stored.next === null || Number.isFinite(stored.next))) {
      autocheckState.signature = stored.signature
      autocheckState.next = stored.next
      autocheckState.pending = stored.pending === true
    }
  } catch {
    /* A missing or damaged state file starts a fresh schedule. */
  }
}

function skipMissedAutocheck(config: Config, now: number): void {
  if (config.scan_schedule.missed_run === 'skip' && autocheckState.pending) {
    autocheckState.pending = false
    persistAutocheckState()
  }
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

export async function processAutocheck(
  config: Config,
  now = Date.now() / 1000,
  scan: (config: Config, trigger: ScanTrigger) => Promise<void> = runScan,
): Promise<void> {
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
  try {
    const config = loadConfig()
    refreshAutocheckSchedule(config)
    skipMissedAutocheck(config, Date.now() / 1000)
  } catch (error) {
    log('ERROR', `Scheduler initialization failed: ${errorMessage(error)}`)
  }
  return setInterval(() => {
    void (async () => {
      try {
        const config = loadConfig()
        void processImportFollow(config)
        await processAutocheck(config)
        await processWebhookScans(config)
      } catch (error) {
        log('ERROR', `Scheduler error: ${errorMessage(error)}`)
      }
    })()
  }, SCHEDULER_TICK_MS)
}
