import { log } from './logging.js'
import type { UsenetFailureCode, UsenetProvider } from '../shared/usenet-contracts.js'
import type { ProviderLookup } from './usenet-provider-types.js'

export interface LookupJob {
  provider: UsenetProvider
  /** Background work yields to interactive lookups; a job is promoted when someone starts waiting on it. */
  background: boolean
  controller: AbortController
}

export interface LookupSchedulerOptions {
  /** Provider requests that may run at once, across all providers. */
  concurrency: number
  /** Slots background work never takes, so an interactive lookup cannot queue behind slow sweeps. */
  foregroundReserved: number
  /**
   * Minimum spacing between requests to one provider. Background sweeps run at these rates
   * indefinitely; 1 req/2s per indexer stays well inside what the public AnimeTosho mirror and
   * AmeNZB tolerate (stalling and rate-limit errors were observed at 1 req/s during startup sweeps).
   */
  minIntervalMs: Record<UsenetProvider, number>
  /** First provider-wide pause after rate limiting or repeated transient failures; doubles per consecutive pause. */
  pauseBaseMs: number
  pauseMaxMs: number
  transientFailuresBeforePause: number
}

const DEFAULT_OPTIONS: LookupSchedulerOptions = {
  concurrency: 4,
  foregroundReserved: 1,
  minIntervalMs: { animetosho: 2_000, amenzb: 2_000 },
  pauseBaseMs: 30_000,
  pauseMaxMs: 10 * 60_000,
  transientFailuresBeforePause: 3,
}

/** Failures that say something about the provider's health rather than about one lookup. */
export const TRANSIENT_CODES = new Set<UsenetFailureCode>(['network', 'timeout', 'server', 'rate_limited'])

/** A foreground lookup was still queued when its provider was paused. */
export class ProviderPausedError extends Error {
  constructor(
    readonly provider: UsenetProvider,
    readonly until: number,
  ) {
    super(`${provider} is paused`)
  }
}

interface ProviderState {
  lastStartedAt: number
  timer?: NodeJS.Timeout
  /** No request to this provider starts before this time. */
  pausedUntil: number
  /** Failure kind that caused the current pause. */
  reason?: UsenetFailureCode
  /** Consecutive transient failures since the last provider answer. */
  failures: number
  /** Consecutive pauses since the last provider answer; drives exponential backoff. */
  pauses: number
}

interface Waiter {
  job: LookupJob
  run: () => void
  cancel: () => void
  /** Rejects a foreground waiter whose provider is paused, so interactive work fails fast. */
  paused: (until: number) => void
}

function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
}

const idle = (): ProviderState => ({ lastStartedAt: 0, pausedUntil: 0, failures: 0, pauses: 0 })

/**
 * Hands out provider request slots. Capacity is assigned only when provider pacing lets a
 * request start; foreground work goes first, and a provider that pushes back is paused for
 * everyone instead of being retried by each lookup on its own.
 */
export class LookupScheduler {
  /** Live settings; tests shorten the intervals. */
  readonly options: LookupSchedulerOptions
  private readonly providers: UsenetProvider[]
  private readonly state: Record<UsenetProvider, ProviderState>
  private readonly waiting: Waiter[] = []
  private active = 0

  constructor(
    private readonly labels: Record<UsenetProvider, string>,
    options: Partial<LookupSchedulerOptions> = {},
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      minIntervalMs: { ...DEFAULT_OPTIONS.minIntervalMs, ...options.minIntervalMs },
    }
    this.providers = Object.keys(labels) as UsenetProvider[]
    this.state = { animetosho: idle(), amenzb: idle() }
  }

  isPaused(provider: UsenetProvider, now = Date.now()): boolean {
    return now < this.state[provider].pausedUntil
  }

  pausedUntil(provider: UsenetProvider): number {
    return this.state[provider].pausedUntil
  }

  /** Active provider pauses, for status reporting. */
  pauses(): { provider: UsenetProvider; until: number; reason: UsenetFailureCode }[] {
    const now = Date.now()
    return this.providers
      .filter(provider => this.isPaused(provider, now))
      .map(provider => ({
        provider,
        until: this.state[provider].pausedUntil,
        reason: this.state[provider].reason || 'network',
      }))
  }

  /** The failure a lookup reports when its provider is paused until `until`. */
  pausedFailure(provider: UsenetProvider, until: number): Extract<ProviderLookup, { kind: 'failed' }> {
    const { reason } = this.state[provider]
    const remaining = Math.max(0, until - Date.now())
    const cause = reason === 'rate_limited' ? 'is rate limiting lookups' : 'lookups are failing'
    return {
      kind: 'failed',
      code: reason || 'network',
      message: `${this.labels[provider]} ${cause}; retrying in about ${describeWait(remaining)}`,
      retry_after_ms: remaining,
    }
  }

  /** Tracks provider health from real provider answers and pauses the provider when it pushes back. */
  recordOutcome(provider: UsenetProvider, lookup: ProviderLookup): void {
    const health = this.state[provider]
    if (lookup.kind !== 'failed') {
      health.failures = 0
      health.pauses = 0
      return
    }
    if (!TRANSIENT_CODES.has(lookup.code)) return
    health.failures++
    if (lookup.code !== 'rate_limited' && health.failures < this.options.transientFailuresBeforePause) return
    const now = Date.now()
    const requested = lookup.retry_after_ms || 0
    // Concurrent requests that fail together escalate the pause only once.
    if (this.isPaused(provider, now)) {
      health.pausedUntil = Math.max(health.pausedUntil, now + requested)
      return
    }
    const delay = Math.max(requested, Math.min(this.options.pauseBaseMs * 2 ** health.pauses, this.options.pauseMaxMs))
    health.pausedUntil = now + delay
    health.reason = lookup.code
    health.pauses++
    health.failures = 0
    log(
      'WARNING',
      `${this.labels[provider]} ${lookup.code === 'rate_limited' ? 'rate limited' : 'failed'} Usenet lookups; pausing that provider for ${describeWait(delay)}`,
    )
  }

  /** Resolves when the job may send its request. Rejects when it is aborted first, or paused while in the foreground. */
  acquire(job: LookupJob): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const { signal } = job.controller
    if (signal.aborted) {
      reject(signal.reason)
      return promise
    }
    const waiter: Waiter = {
      job,
      run: resolve,
      cancel: () => {
        const index = this.waiting.indexOf(waiter)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(signal.reason)
        this.pump()
      },
      paused: until => reject(new ProviderPausedError(job.provider, until)),
    }
    signal.addEventListener('abort', waiter.cancel, { once: true })
    this.waiting.push(waiter)
    this.pump()
    return promise
  }

  release(): void {
    this.active--
    this.pump()
  }

  /** Assigns free capacity to waiters. Call after anything that changes who may start. */
  pump(): void {
    const { concurrency, foregroundReserved, minIntervalMs } = this.options
    for (const provider of this.providers) {
      clearTimeout(this.state[provider].timer)
      this.state[provider].timer = undefined
    }
    const startedAt = Date.now()
    for (const waiter of [...this.waiting]) {
      if (waiter.job.background || !this.isPaused(waiter.job.provider, startedAt)) continue
      this.dequeue(waiter)
      waiter.paused(this.state[waiter.job.provider].pausedUntil)
    }
    while (this.active < concurrency && this.waiting.length) {
      const now = Date.now()
      const ready = ({ job }: Waiter) =>
        now >= this.state[job.provider].lastStartedAt + minIntervalMs[job.provider] && !this.isPaused(job.provider, now)
      const next =
        this.waiting.find(waiter => !waiter.job.background && ready(waiter)) ??
        (this.active < concurrency - foregroundReserved ? this.waiting.find(ready) : undefined)
      if (!next) break
      this.dequeue(next)
      this.active++
      this.state[next.job.provider].lastStartedAt = now
      next.run()
    }
    if (this.active >= concurrency) return
    // Background waiters held back by the reserved slot need no timer: an active
    // lookup exists and its release pumps again. A timer for them would only spin.
    const backgroundBlocked = this.active >= concurrency - foregroundReserved
    for (const provider of this.providers) {
      if (!this.waiting.some(({ job }) => job.provider === provider && (!job.background || !backgroundBlocked)))
        continue
      const state = this.state[provider]
      const wait = Math.max(
        0,
        state.lastStartedAt + minIntervalMs[provider] - Date.now(),
        state.pausedUntil - Date.now(),
      )
      state.timer = setTimeout(() => {
        state.timer = undefined
        this.pump()
      }, wait)
    }
  }

  /** Forgets pacing and health; queued and running work is left to its owners. */
  reset(): void {
    for (const provider of this.providers) {
      clearTimeout(this.state[provider].timer)
      this.state[provider] = idle()
    }
    this.pump()
  }

  private dequeue(waiter: Waiter): void {
    this.waiting.splice(this.waiting.indexOf(waiter), 1)
    waiter.job.controller.signal.removeEventListener('abort', waiter.cancel)
  }
}
