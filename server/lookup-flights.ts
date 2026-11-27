// Machinery the hash-indexer lookups and the Prowlarr finder share: one running lookup per key that later
// callers join, promotion of background work once someone waits for it, discarding what work learned after
// its configuration was invalidated, the wall-clock guard behind every request, and a throttle for warnings
// a sweep would otherwise repeat.

import { log } from './logging.js'
import type { LookupHandle } from './usenet-scheduler.js'

/**
 * The configuration lookups run under. Invalidating it cancels every lookup of the tables that share it,
 * and work stamped before then learns that what it found is to be discarded.
 */
export class LookupEpoch {
  private value = 0
  private readonly tables = new Set<{ cancelAll(): void }>()

  /** A check that holds until the next invalidation. */
  stamp(): () => boolean {
    const at = this.value
    return () => at === this.value
  }

  invalidate(): void {
    this.value++
    for (const table of this.tables) table.cancelAll()
  }

  /** @internal A table cancelled with this epoch. */
  attach(table: { cancelAll(): void }): void {
    this.tables.add(table)
  }
}

/** One running lookup. */
export class Flight<T> {
  promise!: Promise<T>
  private readonly controller = new AbortController()
  /** Scheduled requests the lookup waits on, which a promotion reaches. */
  private readonly jobs = new Set<LookupHandle<unknown>>()
  private backgroundWork: boolean
  private readonly stamp: () => boolean

  constructor(background: boolean, stamp: () => boolean) {
    this.backgroundWork = background
    this.stamp = stamp
  }

  /** Cancels the lookup's requests. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Background work until someone waits on it; schedule its requests at this priority. */
  get background(): boolean {
    return this.backgroundWork
  }

  /**
   * False once the lookup was cancelled, started again under its key, or its epoch invalidated: what it
   * learns from then on is discarded.
   */
  get current(): boolean {
    return this.stamp() && !this.controller.signal.aborted
  }

  /** Cancels the lookup's requests; what it learns from now on is discarded. */
  abort(): void {
    this.controller.abort()
  }

  /** Someone now waits on the lookup: it and every request it waits on become foreground work. */
  promote(): void {
    if (!this.backgroundWork) return
    this.backgroundWork = false
    for (const job of this.jobs) job.promote()
  }

  /** Waits on a scheduled request; a promotion of the lookup meanwhile promotes the request. */
  async wait<V>(job: LookupHandle<V>): Promise<V> {
    this.jobs.add(job)
    try {
      return await job.result
    } finally {
      this.jobs.delete(job)
    }
  }
}

/** A running lookup with what its owner keeps about it besides. */
export type Running<T, X extends object = object> = Flight<T> & X

/**
 * The running lookups of one kind, at most one per key, which later callers join. `X` is what the owner keeps
 * on each lookup besides, given when it starts.
 */
export class FlightTable<T, X extends object = object> {
  private running = new Map<string, Running<T, X>>()

  constructor(readonly epoch = new LookupEpoch()) {
    epoch.attach(this)
  }

  has(key: string): boolean {
    return this.running.has(key)
  }

  /** The lookup running under `key`, without promoting it. */
  get(key: string): Running<T, X> | undefined {
    return this.running.get(key)
  }

  /** Every running lookup. */
  flights(): Running<T, X>[] {
    return [...this.running.values()]
  }

  /** The lookup running under `key`; a caller that is not `background` promotes it. */
  join(key: string, background: boolean): Running<T, X> | undefined {
    const flight = this.running.get(key)
    if (flight && !background) flight.promote()
    return flight
  }

  /**
   * Starts `run` under `key` on the next microtask, cancelling a lookup that runs under it already. The key
   * is forgotten once the lookup settles.
   */
  start(
    key: string,
    { background, ...extras }: { background: boolean } & X,
    run: (flight: Running<T, X>) => Promise<T>,
  ): Running<T, X> {
    this.running.get(key)?.abort()
    const flight = Object.assign(new Flight<T>(background, this.epoch.stamp()), extras) as Running<T, X>
    flight.promise = Promise.resolve()
      .then(() => run(flight))
      .finally(() => {
        if (this.running.get(key) === flight) this.running.delete(key)
      })
    this.running.set(key, flight)
    return flight
  }

  /** Cancels and forgets the lookup running under `key`; whoever asks next starts another. */
  cancel(key: string): void {
    const flight = this.running.get(key)
    if (!flight) return
    this.running.delete(key)
    flight.abort()
  }

  /** Cancels and forgets every running lookup; `LookupEpoch.invalidate` does this for each table it has. */
  cancelAll(): void {
    const cancelled = this.running
    this.running = new Map()
    for (const flight of cancelled.values()) flight.abort()
  }
}

/** Work outlived its wall-clock guard; whoever waited on it no longer does. */
export class LookupGuardTimeout extends Error {
  constructor() {
    super('lookup exceeded the wall-clock guard')
  }
}

/**
 * Settles with `work`, or rejects once `signal` aborts (with its reason) or `work` is still pending after
 * `guardMs` (with `LookupGuardTimeout`). The work itself is not stopped; that is what `signal` is for.
 */
export async function guarded<T>(work: Promise<T>, signal: AbortSignal, guardMs: number): Promise<T> {
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

/**
 * Failure warnings of lookups: a sweep would repeat the same one for every source, so the same text for the
 * same subject is written at most once per interval. A new text is written at once.
 */
export class WarningThrottle {
  private readonly last = new Map<string, { at: number; message: string }>()
  private readonly intervalMs: number
  private readonly write: (message: string) => void
  private readonly now: () => number

  constructor({
    intervalMs = 60_000,
    write = message => log('WARNING', message),
    now = Date.now,
  }: { intervalMs?: number; write?: (message: string) => void; now?: () => number } = {}) {
    this.intervalMs = intervalMs
    this.write = write
    this.now = now
  }

  warn(subject: string, message: string): void {
    const at = this.now()
    const previous = this.last.get(subject)
    if (previous && previous.message === message && at - previous.at < this.intervalMs) return
    this.last.set(subject, { at, message })
    this.write(message)
  }

  /** Forgets what was written, so the next warning of every subject is written. */
  clear(): void {
    this.last.clear()
  }
}
