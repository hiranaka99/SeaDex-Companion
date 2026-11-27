import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  Flight,
  FlightTable,
  LookupEpoch,
  LookupGuardTimeout,
  WarningThrottle,
  guarded,
} from '../server/lookup-flights.js'
import { LookupScheduler } from '../server/usenet-scheduler.js'

test('a lookup already running for a key is joined instead of started again', async () => {
  const table = new FlightTable<string>()
  let runs = 0
  const release = Promise.withResolvers<string>()
  const first = table.start('source', { background: false }, () => {
    runs++
    return release.promise
  })
  const joined = table.join('source', false)
  assert.equal(joined, first)
  assert.equal(table.join('other', false), undefined)
  release.resolve('answer')
  assert.equal(await joined.promise, 'answer')
  assert.equal(runs, 1)
  assert.equal(table.join('source', false), undefined, 'a settled lookup is forgotten')
})

test('a foreground caller joining a background lookup promotes the requests it waits on', async () => {
  // Every slot is reserved for foreground work, so a background request only starts once promoted.
  const scheduler = new LookupScheduler({ concurrency: 1, foregroundReserved: 1, minIntervalMs: 0 })
  const table = new FlightTable<string>()
  let started = false
  const flight = table.start('source', { background: true }, running =>
    running.wait(
      scheduler.schedule({
        channel: 'indexer',
        background: running.background,
        signal: running.signal,
        guardMs: 60_000,
        work: async () => {
          started = true
          return 'answer'
        },
        outcome: () => undefined,
      }),
    ),
  )
  await nextTurn()
  assert.equal(started, false, 'background work waits behind the reserved slot')
  assert.equal(table.join('source', true), flight, 'another background caller changes nothing')
  assert.equal(flight.background, true)
  table.join('source', false)
  assert.equal(flight.background, false)
  assert.equal(await flight.promise, 'answer')
  assert.equal(started, true)
})

test('invalidating the epoch cancels every lookup sharing it, and what they learn is discarded', async () => {
  const epoch = new LookupEpoch()
  const searches = new FlightTable<string>(epoch)
  const checks = new FlightTable<string>(epoch)
  const before = epoch.stamp()
  const release = Promise.withResolvers<void>()
  const learned: string[] = []
  const run = async (flight: Flight<string>, answer: string) => {
    await release.promise
    if (flight.current) learned.push(answer)
    return answer
  }
  const search = searches.start('source', { background: false }, flight => run(flight, 'old search'))
  const check = checks.start('source', { background: false }, flight => run(flight, 'old check'))
  assert.equal(search.current, true)
  assert.equal(before(), true)

  epoch.invalidate()
  assert.equal(before(), false, 'work stamped before the invalidation is discarded')
  assert.equal(search.signal.aborted, true)
  assert.equal(check.signal.aborted, true, 'a table sharing the epoch is cancelled too')
  assert.equal(search.current, false)
  assert.equal(checks.join('source', false), undefined)

  const fresh = searches.start('source', { background: false }, flight => run(flight, 'new search'))
  assert.equal(epoch.stamp()(), true)
  release.resolve()
  await Promise.all([search.promise, check.promise, fresh.promise])
  assert.deepEqual(learned, ['new search'])
})

test('a lookup that is started again or cancelled under its key is no longer current', async () => {
  const table = new FlightTable<string>()
  const release = Promise.withResolvers<string>()
  const old = table.start('source', { background: false }, () => release.promise)
  const replacement = table.start('source', { background: false }, () => new Promise<string>(() => {}))
  assert.equal(old.signal.aborted, true, 'a refresh cancels the lookup it replaces')
  assert.equal(old.current, false)
  assert.equal(table.join('source', false), replacement)
  release.resolve('answer')
  await old.promise
  assert.equal(table.has('source'), true, 'the replaced lookup settling leaves its successor in place')
  table.cancel('source')
  assert.equal(replacement.current, false)
  assert.equal(table.has('source'), false)
})

test('the wall-clock guard settles with the work, or rejects on timeout or cancellation first', async () => {
  const live = new AbortController().signal
  assert.equal(await guarded(Promise.resolve('answer'), live, 1_000), 'answer')
  await assert.rejects(guarded(Promise.reject(new Error('refused')), live, 1_000), /refused/)

  const hung = new Promise<string>(() => {})
  await assert.rejects(guarded(hung, live, 20), (error: unknown) => error instanceof LookupGuardTimeout)

  const controller = new AbortController()
  const waiting = guarded(hung, controller.signal, 60_000)
  controller.abort(new Error('changed configuration'))
  await assert.rejects(waiting, /changed configuration/)
  await assert.rejects(guarded(hung, controller.signal, 60_000), /changed configuration/, 'already cancelled')
})

test('a warning repeats at most once a minute per subject, unless it says something new', () => {
  let now = 0
  const written: string[] = []
  const throttle = new WarningThrottle({ write: message => written.push(message), now: () => now })
  throttle.warn('animetosho', 'timed out')
  throttle.warn('animetosho', 'timed out')
  throttle.warn('amenzb', 'timed out')
  throttle.warn('animetosho', 'refused the key')
  now = 59_999
  throttle.warn('amenzb', 'timed out')
  now = 60_000
  throttle.warn('amenzb', 'timed out')
  throttle.clear()
  throttle.warn('amenzb', 'timed out')
  assert.deepEqual(written, ['timed out', 'timed out', 'refused the key', 'timed out', 'timed out'])
})
