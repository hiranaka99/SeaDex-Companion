import { log } from './logging.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import type { ProviderLookup } from './usenet-provider-types.js'

export interface LookupJob {
  /** What the request is paced and paused by: a hash indexer's ID, or `prowlarr:<indexer id>`. */
  channel: string
  /** Background work yields to interactive lookups; a job is promoted when someone starts waiting on it. */
  background: boolean
  controller: AbortController
}

export interface LookupSchedulerOptions {
  /** Requests that may run at once, across all channels of this scheduler. */
  concurrency: number
  /** Slots background work never takes, so an interactive lookup cannot queue behind slow sweeps. */
  foregroundReserved: number
  /**
   * Minimum spacing between requests on a channel that was described without its own. Background
   * sweeps start at this rate: 1 req/s stalled and drew rate-limit errors during startup sweeps,
   * and AnimeTosho still rate limits a long sweep at 1 req/2s, which the adaptive spacing absorbs.
   */
  minIntervalMs: number
  /** Widest spacing rate limiting can push a channel to. */
  maxIntervalMs: number
  /** First channel-wide pause after rate limiting or repeated transient failures; doubles per consecutive pause. */
  pauseBaseMs: number
  pauseMaxMs: number
  transientFailuresBeforePause: number
}

const DEFAULT_OPTIONS: LookupSchedulerOptions = {
  concurrency: 4,
  foregroundReserved: 1,
  minIntervalMs: 2_000,
  maxIntervalMs: 15_000,
  pauseBaseMs: 30_000,
  pauseMaxMs: 10 * 60_000,
  transientFailuresBeforePause: 3,
}

/** Rate limiting widens a channel's spacing by half; every run of answers this long takes a tenth back off. */
const WIDEN_FACTOR = 1.5
const NARROW_FACTOR = 0.9
const NARROW_AFTER_SUCCESSES = 20

/** Failures that say something about the provider's health rather than about one lookup. */
export const TRANSIENT_CODES = new Set<UsenetFailureCode>(['network', 'timeout', 'server', 'rate_limited'])

/** What a finished request tells the scheduler; a `ProviderLookup` fits. Anything but `failed` counts as an answer. */
export interface LookupOutcome {
  kind: string
  code?: UsenetFailureCode
  retry_after_ms?: number
}

/** An active pause of one channel, for status reporting. */
export interface ChannelPause {
  channel: string
  label: string
  until: number
  reason: UsenetFailureCode
}

/** A foreground lookup was still queued when its channel was paused. */
export class ProviderPausedError extends Error {
  constructor(
    readonly channel: string,
    readonly until: number,
  ) {
    super(`${channel} is paused`)
  }
}

/** Pacing and health of one channel; `reset` forgets all of it. */
interface ChannelState {
  lastStartedAt: number
  /** Spacing rate limiting asked for; 0 while the channel runs at its minimum. */
  widenedMs: number
  /** Consecutive answers since the last failure or the last narrowing. */
  successes: number
  /** No request on this channel starts before this time. */
  pausedUntil: number
  /** Failure kind that caused the current pause. */
  reason: UsenetFailureCode | undefined
  /** Consecutive transient failures since the last answer. */
  failures: number
  /** Consecutive pauses since the last answer; drives exponential backoff. */
  pauses: number
}

interface Channel extends ChannelState {
  /** Name shown in messages and status. */
  label: string
  /** The channel's own minimum spacing; without one it follows the scheduler's. */
  minIntervalMs?: number
}

interface Waiter {
  job: LookupJob
  run: () => void
  cancel: () => void
  /** Rejects a foreground waiter whose channel is paused, so interactive work fails fast. */
  paused: (until: number) => void
}

function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
}

const idle = (): ChannelState => ({
  lastStartedAt: 0,
  widenedMs: 0,
  successes: 0,
  pausedUntil: 0,
  reason: undefined,
  failures: 0,
  pauses: 0,
})

/**
 * Hands out request slots. Capacity is assigned only when a channel's pacing lets a request
 * start; foreground work goes first, and a channel that pushes back is paused for everyone
 * instead of being retried by each lookup on its own. A channel is one provider or indexer and
 * exists from its first use; instances share nothing, so each has its own slots and channels.
 */
export class LookupScheduler {
  /** Live settings; tests shorten the intervals. */
  readonly options: LookupSchedulerOptions
  private readonly channels = new Map<string, Channel>()
  private readonly waiting: Waiter[] = []
  private active = 0
  private timer?: NodeJS.Timeout

  constructor(options: Partial<LookupSchedulerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Names a channel and, when given, sets its own minimum spacing. Calling it again updates the
   * description and keeps pacing and health; a minimum that is left out stays as it was.
   */
  describe(channel: string, { label, minIntervalMs }: { label: string; minIntervalMs?: number }): void {
    const state = this.channel(channel)
    state.label = label
    if (minIntervalMs !== undefined) state.minIntervalMs = minIntervalMs
    this.pump()
  }

  /**
   * Current spacing between requests on a channel: the larger of its minimum and what rate
   * limiting widened it to. A new minimum therefore applies at once to a channel that is not
   * widened beyond it, and a widened channel keeps its spacing until answers narrow it.
   */
  interval(channel: string): number {
    const state = this.channel(channel)
    return Math.max(state.minIntervalMs ?? this.options.minIntervalMs, state.widenedMs)
  }

  isPaused(channel: string, now = Date.now()): boolean {
    return now < this.channel(channel).pausedUntil
  }

  pausedUntil(channel: string): number {
    return this.channel(channel).pausedUntil
  }

  /** Active channel pauses, for status reporting. */
  pauses(): ChannelPause[] {
    const now = Date.now()
    return [...this.channels]
      .filter(([, state]) => now < state.pausedUntil)
      .map(([channel, state]) => ({
        channel,
        label: state.label,
        until: state.pausedUntil,
        reason: state.reason || 'network',
      }))
  }

  /**
   * Pauses a channel until `until` for a reason learned elsewhere, such as an indexer Prowlarr has disabled.
   * A pause that already lasts as long stays as it is. Unlike a failed request this says nothing about
   * pacing, so the spacing and the backoff of later pauses are left alone.
   */
  pause(channel: string, until: number, reason: UsenetFailureCode): void {
    const state = this.channel(channel)
    if (until <= Date.now() || until <= state.pausedUntil) return
    state.pausedUntil = until
    state.reason = reason
    this.pump()
  }

  /** Ends a pause before its time, for one set with `pause` whose cause is over. Pacing and backoff stay. */
  resume(channel: string): void {
    const state = this.channel(channel)
    state.pausedUntil = 0
    state.reason = undefined
    this.pump()
  }

  /** The failure a lookup reports when its channel is paused until `until`. */
  pausedFailure(channel: string, until: number): Extract<ProviderLookup, { kind: 'failed' }> {
    const { label, reason } = this.channel(channel)
    const remaining = Math.max(0, until - Date.now())
    const cause = reason === 'rate_limited' ? 'is rate limiting lookups' : 'lookups are failing'
    return {
      kind: 'failed',
      code: reason || 'network',
      message: `${label} ${cause}; retrying in about ${describeWait(remaining)}`,
      retry_after_ms: remaining,
    }
  }

  /** Tracks channel health from real answers: paces the channel to what it tolerates and pauses it when it pushes back. */
  recordOutcome(channel: string, outcome: LookupOutcome): void {
    const health = this.channel(channel)
    if (outcome.kind !== 'failed') {
      health.failures = 0
      health.pauses = 0
      if (++health.successes < NARROW_AFTER_SUCCESSES) return
      health.successes = 0
      const narrowed = Math.round(health.widenedMs * NARROW_FACTOR)
      // Back at the minimum the channel follows it again, including a minimum that changes later.
      health.widenedMs = narrowed > (health.minIntervalMs ?? this.options.minIntervalMs) ? narrowed : 0
      return
    }
    health.successes = 0
    if (!outcome.code || !TRANSIENT_CODES.has(outcome.code)) return
    health.failures++
    if (outcome.code !== 'rate_limited' && health.failures < this.options.transientFailuresBeforePause) return
    const now = Date.now()
    const requested = outcome.retry_after_ms || 0
    // Concurrent requests that fail together escalate the pause, and widen the spacing, only once.
    if (this.isPaused(channel, now)) {
      health.pausedUntil = Math.max(health.pausedUntil, now + requested)
      return
    }
    if (outcome.code === 'rate_limited')
      health.widenedMs = Math.min(this.options.maxIntervalMs, Math.round(this.interval(channel) * WIDEN_FACTOR))
    const delay = Math.max(requested, Math.min(this.options.pauseBaseMs * 2 ** health.pauses, this.options.pauseMaxMs))
    health.pausedUntil = now + delay
    health.reason = outcome.code
    health.pauses++
    health.failures = 0
    log(
      'WARNING',
      `${health.label} ${outcome.code === 'rate_limited' ? 'rate limited' : 'failed'} Usenet lookups; pausing it for ${describeWait(delay)}`,
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
      paused: until => reject(new ProviderPausedError(job.channel, until)),
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
    const { concurrency, foregroundReserved } = this.options
    clearTimeout(this.timer)
    this.timer = undefined
    const startedAt = Date.now()
    for (const waiter of [...this.waiting]) {
      if (waiter.job.background || !this.isPaused(waiter.job.channel, startedAt)) continue
      this.dequeue(waiter)
      waiter.paused(this.pausedUntil(waiter.job.channel))
    }
    while (this.active < concurrency && this.waiting.length) {
      const now = Date.now()
      const ready = ({ job }: Waiter) => now >= this.readyAt(job.channel)
      const next =
        this.waiting.find(waiter => !waiter.job.background && ready(waiter)) ??
        (this.active < concurrency - foregroundReserved ? this.waiting.find(ready) : undefined)
      if (!next) break
      this.dequeue(next)
      this.active++
      this.channel(next.job.channel).lastStartedAt = now
      next.run()
    }
    if (this.active >= concurrency) return
    // Background waiters held back by the reserved slot need no timer: an active
    // lookup exists and its release pumps again. A timer for them would only spin.
    const backgroundBlocked = this.active >= concurrency - foregroundReserved
    let soonest = Infinity
    for (const { job } of this.waiting)
      if (!job.background || !backgroundBlocked) soonest = Math.min(soonest, this.readyAt(job.channel))
    if (soonest === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.pump()
      },
      Math.max(0, soonest - Date.now()),
    )
  }

  /** Forgets pacing and health of every channel, not their descriptions; queued and running work is left to its owners. */
  reset(): void {
    for (const state of this.channels.values()) Object.assign(state, idle())
    this.pump()
  }

  /** A channel's state, created on first use: one nobody described is labelled by its name. */
  private channel(name: string): Channel {
    let state = this.channels.get(name)
    if (!state) this.channels.set(name, (state = { label: name, ...idle() }))
    return state
  }

  /** When pacing and any pause let the next request on a channel start. */
  private readyAt(channel: string): number {
    const state = this.channel(channel)
    return Math.max(state.lastStartedAt + this.interval(channel), state.pausedUntil)
  }

  private dequeue(waiter: Waiter): void {
    this.waiting.splice(this.waiting.indexOf(waiter), 1)
    waiter.job.controller.signal.removeEventListener('abort', waiter.cancel)
  }
}
