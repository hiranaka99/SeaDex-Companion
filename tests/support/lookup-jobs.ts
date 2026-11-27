import type { LookupHandle, LookupOutcome, LookupScheduler } from '../../server/usenet-scheduler.js'

/** A scheduled job whose work runs until the test ends it. */
export interface HeldJob {
  handle: LookupHandle<LookupOutcome | undefined>
  controller: AbortController
  /** Resolves when the work starts, that is once the job holds a slot. */
  started: Promise<void>
  /** Epoch ms at which the work started; 0 while it has not. */
  startedAt: () => number
  /** Ends the work; the job records `outcome` for its channel, or nothing without one. */
  finish: (outcome?: LookupOutcome) => Promise<void>
}

/** What a job whose work threw records: the provider did not answer. */
export const NOT_ANSWERED: LookupOutcome = { kind: 'failed', code: 'network' }

/** Schedules a job whose work holds its slot until `finish`. */
export function holdJob(
  scheduler: LookupScheduler,
  channel: string,
  { background = false, guardMs = 60_000 }: { background?: boolean; guardMs?: number } = {},
): HeldJob {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<LookupOutcome | undefined>()
  let startedAt = 0
  const handle = scheduler.schedule({
    channel,
    background,
    signal: controller.signal,
    guardMs,
    work: () => {
      startedAt = Date.now()
      started.resolve()
      return answer.promise
    },
    outcome: settled => (settled.ok ? settled.value : NOT_ANSWERED),
  })
  // A job the test never finishes or that fails on purpose must not surface as an unhandled rejection.
  handle.result.catch(() => {})
  return {
    handle,
    controller,
    started: started.promise,
    startedAt: () => startedAt,
    finish: async outcome => {
      answer.resolve(outcome)
      await handle.result
    },
  }
}

/** Runs one foreground job whose work answers at once. */
export function runJob<T>(scheduler: LookupScheduler, channel: string, value: T): Promise<T> {
  return scheduler.schedule({
    channel,
    signal: new AbortController().signal,
    guardMs: 60_000,
    work: async () => value,
    outcome: () => undefined,
  }).result
}
