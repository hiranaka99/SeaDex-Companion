import { log } from './logging.js'
import type { UsenetFailureCode } from '../shared/usenet-contracts.js'
import type { ProviderLookup } from './usenet-provider-types.js'

/** A finished job's work: what it returned, or what it threw. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** One request to send on a channel, and what its result tells the channel. */
export interface LookupRequest<T> {
  /** What the request is paced and paused by: a hash indexer's ID, or `prowlarr:<indexer id>`. */
  channel: string
  /** Background work yields to interactive lookups until its handle promotes it. */
  background?: boolean
  /** Cancels the job: the wait for a slot, or the work under way, which is then no longer waited for. */
  signal: AbortSignal
  /** Gives up only the wait for a slot; work that started runs on. `signal` when left out. */
  waitSignal?: AbortSignal
  /** How long the work may hold the slot; past it the job fails with `LookupGuardTimeout`. */
  guardMs: number
  /** The request itself, run with the slot in hand. */
  work: () => Promise<T>
  /**
   * What the work tells the channel's health; `undefined` tells it nothing. Not asked when the job was
   * cancelled, since a cancelled request says nothing about the provider.
   */
  outcome: (settled: Settled<T>) => LookupOutcome | undefined
}

/** A scheduled job. */
export interface LookupHandle<T> {
  /**
   * Settles with what the work returned. Rejects with the reason of the signal that cancelled the job, with
   * `ProviderPausedError` when the channel of a foreground job is paused before the job starts, with
   * `LookupGuardTimeout`, or with what the work threw.
   */
  result: Promise<T>
  /** Someone now waits on the job: from here on it is foreground work. Nothing changes once it started. */
  promote(): void
}

/** The work of a job held its slot longer than its guard allows; the slot was freed. */
export class LookupGuardTimeout extends Error {
  constructor() {
    super('lookup exceeded the wall-clock guard')
  }
}

/** How a scheduler paces its channels; fixed when the scheduler is created. */
export interface LookupPacing {
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

const DEFAULT_PACING: LookupPacing = {
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
  channel: string
  background: boolean
  signal: AbortSignal
  run: () => void
  cancel: () => void
  /** Rejects a foreground waiter whose channel is paused, so interactive work fails fast. */
  paused: (until: number) => void
}

function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
}

/** Settles with `work`, or rejects once `signal` aborts or `work` is still pending after `guardMs`. */
async function guarded<T>(work: Promise<T>, signal: AbortSignal, guardMs: number): Promise<T> {
  const stop = Promise.withResolvers<never>()
  const cancel = () => stop.reject(signal.reason)
  // The provider clients carry their own timeouts; this is the last line of defense, and never keeps the process alive.
  const timer = setTimeout(() => stop.reject(new LookupGuardTimeout()), guardMs)
  timer.unref?.()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    return await Promise.race([work, stop.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
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
 * Runs requests to providers. A job gets a slot only when its channel's pacing lets it start;
 * foreground work goes first, and a channel that pushes back is paused for everyone instead of
 * being retried by each lookup on its own. A channel is one provider or indexer and exists from
 * its first use; instances share nothing, so each has its own slots and channels.
 */
export class LookupScheduler {
  private readonly pacing: LookupPacing
  private readonly channels = new Map<string, Channel>()
  private readonly waiting: Waiter[] = []
  private active = 0
  private timer?: NodeJS.Timeout

  /** `now` is the clock pacing and pauses are measured on. */
  constructor(
    pacing: Partial<LookupPacing> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.pacing = { ...DEFAULT_PACING, ...pacing }
  }

  /**
   * Runs `work` once the job has a slot, and always frees the slot: when the work settles, fails, is
   * cancelled or outlives its guard. What it came to is recorded for the channel before the next job starts.
   */
  schedule<T>(request: LookupRequest<T>): LookupHandle<T> {
    const { slot, waiter } = this.enqueue(
      request.channel,
      request.background ?? false,
      request.waitSignal ?? request.signal,
    )
    return {
      result: slot.then(() => this.runHeld(request)),
      promote: () => {
        if (!waiter.background) return
        waiter.background = false
        this.pump()
      },
    }
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
    return Math.max(state.minIntervalMs ?? this.pacing.minIntervalMs, state.widenedMs)
  }

  isPaused(channel: string, now = this.now()): boolean {
    return now < this.channel(channel).pausedUntil
  }

  pausedUntil(channel: string): number {
    return this.channel(channel).pausedUntil
  }

  /** Active channel pauses, for status reporting. */
  pauses(): ChannelPause[] {
    const now = this.now()
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
    if (until <= this.now() || until <= state.pausedUntil) return
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
    const remaining = Math.max(0, until - this.now())
    const cause = reason === 'rate_limited' ? 'is rate limiting lookups' : 'lookups are failing'
    return {
      kind: 'failed',
      code: reason || 'network',
      message: `${label} ${cause}; retrying in about ${describeWait(remaining)}`,
      retry_after_ms: remaining,
    }
  }

  /**
   * Tracks channel health from real answers: paces the channel to what it tolerates and pauses it when it
   * pushes back. `schedule` records every job's outcome; this is public for tests of the health rules.
   */
  recordOutcome(channel: string, outcome: LookupOutcome): void {
    const health = this.channel(channel)
    if (outcome.kind !== 'failed') {
      health.failures = 0
      health.pauses = 0
      if (++health.successes < NARROW_AFTER_SUCCESSES) return
      health.successes = 0
      const narrowed = Math.round(health.widenedMs * NARROW_FACTOR)
      // Back at the minimum the channel follows it again, including a minimum that changes later.
      health.widenedMs = narrowed > (health.minIntervalMs ?? this.pacing.minIntervalMs) ? narrowed : 0
      return
    }
    health.successes = 0
    if (!outcome.code || !TRANSIENT_CODES.has(outcome.code)) return
    health.failures++
    if (outcome.code !== 'rate_limited' && health.failures < this.pacing.transientFailuresBeforePause) return
    const now = this.now()
    const requested = outcome.retry_after_ms || 0
    // Concurrent requests that fail together escalate the pause, and widen the spacing, only once.
    if (this.isPaused(channel, now)) {
      health.pausedUntil = Math.max(health.pausedUntil, now + requested)
      return
    }
    if (outcome.code === 'rate_limited')
      health.widenedMs = Math.min(this.pacing.maxIntervalMs, Math.round(this.interval(channel) * WIDEN_FACTOR))
    const delay = Math.max(requested, Math.min(this.pacing.pauseBaseMs * 2 ** health.pauses, this.pacing.pauseMaxMs))
    health.pausedUntil = now + delay
    health.reason = outcome.code
    health.pauses++
    health.failures = 0
    log(
      'WARNING',
      `${health.label} ${outcome.code === 'rate_limited' ? 'rate limited' : 'failed'} Usenet lookups; pausing it for ${describeWait(delay)}`,
    )
  }

  /** Resolves when the job holds a slot. Rejects when its wait is cancelled first, or its channel paused while it is foreground. */
  private enqueue(channel: string, background: boolean, signal: AbortSignal): { slot: Promise<void>; waiter: Waiter } {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const waiter: Waiter = {
      channel,
      background,
      signal,
      run: resolve,
      cancel: () => {
        const index = this.waiting.indexOf(waiter)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(signal.reason)
        this.pump()
      },
      paused: until => reject(new ProviderPausedError(channel, until)),
    }
    if (signal.aborted) {
      reject(signal.reason)
      return { slot: promise, waiter }
    }
    signal.addEventListener('abort', waiter.cancel, { once: true })
    this.waiting.push(waiter)
    this.pump()
    return { slot: promise, waiter }
  }

  /** The work of a job that holds a slot; the slot is freed after the outcome is recorded, whatever happened. */
  private async runHeld<T>(request: LookupRequest<T>): Promise<T> {
    const { channel, signal } = request
    let settled: Settled<T>
    try {
      signal.throwIfAborted()
      settled = { ok: true, value: await guarded(request.work(), signal, request.guardMs) }
    } catch (error) {
      settled = { ok: false, error }
    }
    try {
      const outcome = signal.aborted ? undefined : request.outcome(settled)
      if (outcome) this.recordOutcome(channel, outcome)
    } finally {
      this.active--
      this.pump()
    }
    if (settled.ok) return settled.value
    throw settled.error
  }

  /** Assigns free capacity to waiters. Called after anything that changes who may start. */
  private pump(): void {
    const { concurrency, foregroundReserved } = this.pacing
    clearTimeout(this.timer)
    this.timer = undefined
    const startedAt = this.now()
    for (const waiter of [...this.waiting]) {
      if (waiter.background || !this.isPaused(waiter.channel, startedAt)) continue
      this.dequeue(waiter)
      waiter.paused(this.pausedUntil(waiter.channel))
    }
    while (this.active < concurrency && this.waiting.length) {
      const now = this.now()
      const ready = ({ channel }: Waiter) => now >= this.readyAt(channel)
      const next =
        this.waiting.find(waiter => !waiter.background && ready(waiter)) ??
        (this.active < concurrency - foregroundReserved ? this.waiting.find(ready) : undefined)
      if (!next) break
      this.dequeue(next)
      this.active++
      this.channel(next.channel).lastStartedAt = now
      next.run()
    }
    if (this.active >= concurrency) return
    // Background waiters held back by the reserved slot need no timer: an active
    // lookup exists and its release pumps again. A timer for them would only spin.
    const backgroundBlocked = this.active >= concurrency - foregroundReserved
    let soonest = Infinity
    for (const { channel, background } of this.waiting)
      if (!background || !backgroundBlocked) soonest = Math.min(soonest, this.readyAt(channel))
    if (soonest === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.pump()
      },
      Math.max(0, soonest - this.now()),
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
    waiter.signal.removeEventListener('abort', waiter.cancel)
  }
}
