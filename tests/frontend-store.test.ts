import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jobResult } from '../shared/download-contracts.js'
import { waitForDownloadJob } from '../frontend/src/bulk-job-store.js'
import {
  controlDownload,
  currentDownloadAssociations,
  getDownloadSnapshot,
  refreshDownloads,
  subscribeDownloads,
} from '../frontend/src/download-store.js'
import {
  invalidateDownloadProgress,
  type DownloadJobStatus,
  type DownloadProgress,
  type SelectionInput,
  type UsenetAvailabilityResult,
} from '../frontend/src/api.js'
import type { ResultItem } from '../frontend/src/types.js'
import { setImmediate as settle } from 'node:timers/promises'
import {
  availabilityKey,
  observeUsenetAvailability,
  type AvailabilitySnapshot,
} from '../frontend/src/usenet-observation.js'

const unit = {
  unit_id: 'torrent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:anime',
  protocol: 'torrent' as const,
  source_hash: 'a'.repeat(40),
  label: 'Show',
  selections: [{ key: 'show-1', release: 0 }],
}

test('one job observer retries connectivity failures and follows the accepted ID', async () => {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch
  const timers: (() => void)[] = []
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      timers.push(callback)
      return timers.length
    },
    clearTimeout: () => {},
  } as unknown as Window & typeof globalThis
  const accepted: DownloadJobStatus = {
    id: 'accepted-job',
    existing: [],
    targets: [{ key: 'show-1', release: 0 }],
    ok: true,
    finished: false,
    pending: [unit],
    added: [],
    failures: [],
  }
  const finished = { ...accepted, finished: true, pending: [], added: [unit] }
  const paths: string[] = []
  let attempts = 0
  globalThis.fetch = async input => {
    paths.push(String(input))
    if (++attempts === 1) throw new Error('Temporary connection failure')
    return Response.json(finished)
  }
  try {
    const updates: boolean[] = []
    const result = waitForDownloadJob(accepted, job => updates.push(job.finished))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(updates, [false], 'A lost status request must not mark the job failed')
    assert.equal(timers.length, 1)
    timers.shift()!()
    assert.deepEqual((await result).added, accepted.pending)
    assert.deepEqual(paths, ['/api/download-jobs/accepted-job', '/api/download-jobs/accepted-job'])
    assert.deepEqual(updates, [false, true])
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('record-keyed snapshot reloads after control commands even without subscribers', async () => {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => {}, dispatchEvent: () => true } as unknown as Window &
    typeof globalThis
  const recordId = 't:' + 'a'.repeat(40)
  const row: DownloadProgress = {
    record_id: recordId,
    protocol: 'torrent',
    client: 'qbittorrent',
    source_hash: 'a'.repeat(40),
    native_id: 'a'.repeat(40),
    phase: 'downloading',
    state: 'downloading',
    category: 'anime',
    labels: [],
    title: 'Show',
    season: 1,
    part: '',
    release_group: 'Group',
    tracker: 'Nyaa',
    size: 100,
    associations: [{ key: 'show-1', release: 0 }],
    progress: 0.5,
    downloaded: 50,
    total_size: 100,
    speed: 10,
    capabilities: { pause: true, resume: true, remove: true, remove_files: true },
    updated_at: new Date().toISOString(),
  }
  let acceptControl!: (value: Response) => void
  let removed = false
  globalThis.fetch = async input => {
    if (String(input) === '/api/download_control')
      return new Promise<Response>(resolve => {
        acceptControl = resolve
      })
    return Response.json({ ok: true, downloads: removed ? {} : { [recordId]: row } })
  }
  try {
    invalidateDownloadProgress()
    const unsubscribe = subscribeDownloads(() => {})
    const command = controlDownload(recordId, 'remove', false)
    unsubscribe()
    removed = true
    acceptControl(Response.json({ ok: true }))
    await command
    assert.equal(getDownloadSnapshot()[recordId], undefined, 'A removed record leaves the snapshot after reload')
    const again = subscribeDownloads(() => {})
    await new Promise(resolve => setImmediate(resolve))
    removed = false
    await refreshDownloads()
    assert.equal(getDownloadSnapshot()[recordId]?.phase, 'downloading')
    again()
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
    invalidateDownloadProgress()
  }
})

test('jobResult reports in-flight units as pending rows and settles them once added', () => {
  const unitB = {
    unit_id: 'usenet:bbbbbbbbbbbb:anime',
    protocol: 'usenet' as const,
    source_hash: 'b'.repeat(40),
    label: 'Show 2',
    selections: [{ key: 'show-2', release: 1 }],
  }
  const inflight = {
    ok: true,
    finished: false,
    targets: [
      { key: 'show-1', release: 0 },
      { key: 'show-2', release: 1 },
    ],
    pending: [unit, unitB],
    existing: [],
    added: [],
    failures: [],
  }
  const running = jobResult(inflight)
  const row = running.rows.find(item => item.key === 'show-1' && item.release === 0)
  assert.ok(row, 'A still-pending unit keeps a visible row')
  assert.equal(row.status, 'pending')
  assert.deepEqual(row.protocols, ['torrent'])
  assert.equal(running.rows.find(item => item.key === 'show-2')?.status, 'pending')
  assert.equal(running.count, 0)
  const settled = jobResult({ ...inflight, finished: true, pending: [], added: [unit], existing: [unitB] })
  assert.equal(settled.rows.find(item => item.key === 'show-1')?.status, 'added')
  assert.equal(settled.rows.find(item => item.key === 'show-2')?.status, 'existing')
  assert.equal(settled.count, 2)
})

test('shared records attach to all covered current releases without duplicate associations', () => {
  const hash = 'a'.repeat(40)
  const release = {
    kind: 'best',
    releaseGroup: 'Current',
    tracker: 'Nyaa',
    info_hashes: [hash],
    selected_files: ['01.mkv'],
    torrent_available: true,
    size: 100,
  }
  const seasons = [
    { key: 'one', releases: [release] },
    { key: 'two', releases: [{ ...release, selected_files: ['02.mkv'] }] },
  ] as ResultItem[]
  const associations = [
    { key: 'one', release: 0 },
    { key: 'two', release: 0 },
    { key: 'one', release: 0 },
  ]
  const progress = {
    record_id: 'original-record',
    protocol: 'torrent',
    source_hash: hash,
    category: 'anime',
    associations,
    scope: ['01.mkv', '02.mkv'],
  } as DownloadProgress
  assert.deepEqual(currentDownloadAssociations(progress, seasons), associations.slice(0, 2))
  assert.deepEqual(
    currentDownloadAssociations({ ...progress, scope: ['01.mkv'] }, seasons),
    associations.slice(0, 1),
    'A partial acquisition cannot cover a different cour',
  )
  assert.deepEqual(
    currentDownloadAssociations({ ...progress, scope: undefined }, seasons),
    associations.slice(0, 2),
    'A whole source covers each saved current association',
  )
  assert.deepEqual(
    currentDownloadAssociations(progress, [
      { key: 'one', releases: [{ ...release, selected_files: undefined }] },
    ] as ResultItem[]),
    [],
    'A scoped acquisition cannot block a new whole-source recommendation',
  )
  const replaced = [{ key: 'one', releases: [{ ...release, info_hashes: ['b'.repeat(40)] }] }] as ResultItem[]
  assert.deepEqual(
    currentDownloadAssociations(progress, replaced),
    [],
    'An obsolete hash stays an original record rather than blocking its replacement',
  )
  assert.equal(progress.record_id, 'original-record')
  assert.deepEqual(
    progress.associations,
    associations,
    'Resolving the current recommendation does not rewrite the original acquisition',
  )
  assert.deepEqual(
    currentDownloadAssociations({ ...progress, protocol: 'usenet', scope: undefined }, seasons),
    associations.slice(0, 2),
  )
})

const availabilitySelection = (key: string): SelectionInput => ({ key, release: 0, identity: `identity:${key}` })
const availabilityRow = (key: string, changes: Partial<UsenetAvailabilityResult> = {}): UsenetAvailabilityResult => ({
  ...availabilitySelection(key),
  identity: `identity:${key}`,
  hashes: [
    {
      hash: 'a'.repeat(40),
      state: changes.aggregate || 'available',
      checked_at: changes.checked_at ?? '2026-11-18T10:00:00.000Z',
      stale: changes.stale ?? true,
      refreshing: changes.refreshing ?? true,
    },
  ],
  aggregate: 'available',
  checked_at: '2026-11-18T10:00:00.000Z',
  stale: true,
  refreshing: true,
  ...changes,
})
const availabilityReply = (rows: UsenetAvailabilityResult[], generation = 1) =>
  Response.json({
    ok: true,
    config_generation: generation,
    sabnzbd_configured: true,
    providers_enabled: { animetosho: true, amenzb: false },
    results: rows,
  })

async function availabilityFixture(
  run: (
    timers: Map<number, () => void>,
    snapshots: AvailabilitySnapshot[],
    controller: AbortController,
  ) => Promise<void>,
) {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback)
      return nextTimer
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
  } as unknown as Window & typeof globalThis
  const controller = new AbortController()
  try {
    await run(timers, [], controller)
  } finally {
    controller.abort()
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

const pollAvailability = async (timers: Map<number, () => void>) => {
  const [id, callback] = [...timers.entries()][0] || []
  assert.ok(callback, 'A refreshing snapshot schedules an observation')
  timers.delete(id)
  callback()
  await settle()
}

test('cached availability appears before a held refresh and manual refresh retains its timestamp', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    const held = Promise.withResolvers<Response>()
    const requests: { selections: SelectionInput[]; refresh?: boolean }[] = []
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return requests.length === 1 ? availabilityReply([availabilityRow('cached')]) : held.promise
    }
    const observing = observeUsenetAvailability([availabilitySelection('cached')], {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    const cached = snapshots.at(-1)!
    assert.equal(cached.rows[availabilityKey(availabilitySelection('cached'))].aggregate, 'available')
    assert.equal(cached.rows[availabilityKey(availabilitySelection('cached'))].checked_at, '2026-11-18T10:00:00.000Z')
    await pollAvailability(timers)
    assert.equal(requests.length, 2)
    assert.equal(snapshots.at(-1), cached, 'A held background read does not erase visible availability')
    controller.abort()
    held.resolve(availabilityReply([availabilityRow('cached', { aggregate: 'no_match', refreshing: false })]))
    await observing
    const manualController = new AbortController()
    const manualHeld = Promise.withResolvers<Response>()
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return manualHeld.promise
    }
    const manual = observeUsenetAvailability([availabilitySelection('cached')], {
      signal: manualController.signal,
      refresh: true,
      initial: cached,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))].aggregate, 'available')
    assert.equal(
      snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))].checked_at,
      cached.rows[availabilityKey(availabilitySelection('cached'))].checked_at,
    )
    assert.equal(requests.at(-1)!.refresh, true)
    manualHeld.resolve(
      availabilityReply([
        availabilityRow('cached', { stale: false, refreshing: false, checked_at: '2026-11-22T10:00:00.000Z' }),
      ]),
    )
    await manual
    assert.equal(
      snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))].checked_at,
      '2026-11-22T10:00:00.000Z',
    )
    assert.equal(timers.size, 0)
  })
})

test('mixed snapshots poll only refreshing identities without forcing work and stop after a refresh failure', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    const requests: { selections: SelectionInput[]; refresh?: boolean }[] = []
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      if (requests.length === 1)
        return availabilityReply([
          availabilityRow('known', { refreshing: false }),
          availabilityRow('missing', { aggregate: 'not_checked', checked_at: '', stale: false }),
        ])
      return availabilityReply([
        availabilityRow('missing', {
          aggregate: 'not_checked',
          checked_at: '',
          stale: false,
          refreshing: false,
          refresh_error: 'Fixture provider timed out',
        }),
      ])
    }
    const observing = observeUsenetAvailability([availabilitySelection('known'), availabilitySelection('missing')], {
      signal: controller.signal,
      refresh: true,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('missing'))].aggregate, 'not_checked')
    await pollAvailability(timers)
    await observing
    assert.deepEqual(requests, [
      { selections: [availabilitySelection('known'), availabilitySelection('missing')], refresh: true },
      { selections: [availabilitySelection('missing')] },
    ])
    assert.equal(snapshots.at(-1)!.error, 'Fixture provider timed out')
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('known'))].aggregate, 'available')
    assert.equal(timers.size, 0, 'Failed work does not poll forever')
  })
})

test('connectivity failures keep last-known availability and cancel the refreshing indicator', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    let calls = 0
    globalThis.fetch = async () => {
      if (++calls === 1) return availabilityReply([availabilityRow('cached')])
      throw new Error('Fixture connection lost')
    }
    const observing = observeUsenetAvailability([availabilitySelection('cached')], {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    await pollAvailability(timers)
    await observing
    const row = snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))]
    assert.equal(row.aggregate, 'available')
    assert.equal(row.checked_at, '2026-11-18T10:00:00.000Z')
    assert.equal(row.refreshing, false)
    assert.equal(row.refresh_error, 'Fixture connection lost')
    assert.equal(timers.size, 0)
  })
})

test('closing an observation clears polling and a replacement ignores the canceled response', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    const held = Promise.withResolvers<Response>()
    globalThis.fetch = async () => held.promise
    const old = observeUsenetAvailability([availabilitySelection('old')], {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    controller.abort()
    const replacement = new AbortController()
    globalThis.fetch = async () =>
      availabilityReply([
        availabilityRow('replacement', { refreshing: false }),
        availabilityRow('old', { refreshing: false }),
      ])
    await observeUsenetAvailability([availabilitySelection('replacement')], {
      signal: replacement.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    const latest = snapshots.at(-1)
    held.resolve(availabilityReply([availabilityRow('old')]))
    await old
    assert.equal(snapshots.at(-1), latest)
    assert.deepEqual(
      Object.keys(latest!.rows),
      [availabilityKey(availabilitySelection('replacement'))],
      'Only requested canonical identities may attach',
    )
    const closing = new AbortController()
    globalThis.fetch = async () => availabilityReply([availabilityRow('cached')])
    const polling = observeUsenetAvailability([availabilitySelection('cached')], {
      signal: closing.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    assert.equal(timers.size, 1)
    closing.abort()
    await polling
    assert.equal(timers.size, 0)
  })
})

test('a changed config generation discards old rows and re-observes the whole requested scope', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    const requests: { selections: SelectionInput[] }[] = []
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      if (requests.length === 1)
        return availabilityReply([availabilityRow('cached', { refreshing: false }), availabilityRow('pending')], 4)
      if (requests.length === 2)
        return availabilityReply([availabilityRow('pending', { aggregate: 'no_match', refreshing: false })], 5)
      return availabilityReply(
        [
          availabilityRow('cached', { aggregate: 'not_checked', checked_at: '', refreshing: false }),
          availabilityRow('pending', { aggregate: 'no_match', refreshing: false }),
        ],
        5,
      )
    }
    const selections = [availabilitySelection('cached'), availabilitySelection('pending')]
    const observing = observeUsenetAvailability(selections, {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    await pollAvailability(timers)
    await observing
    const changed = snapshots.find(snapshot => snapshot.configGeneration === 5)!
    assert.equal(
      changed.rows[availabilityKey(availabilitySelection('cached'))],
      undefined,
      'The old provider scope is cleared before any new result appears',
    )
    assert.deepEqual(
      requests.map(request => request.selections),
      [selections, [availabilitySelection('pending')], selections],
    )
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))].aggregate, 'not_checked')
    assert.equal(timers.size, 0)
  })
})

test('search, verify and cancel go out with the first request only and are confirmed before its snapshot', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    const requests: Record<string, unknown>[] = []
    const usage = [{ indexer: 'Geek', fetches_left: 19 }]
    const unverified = (key: string, refreshing: boolean) =>
      availabilityRow(key, {
        aggregate: 'unverified',
        search: 'prowlarr',
        refreshing,
        hashes: [{ hash: 'files:' + 'a'.repeat(40), state: 'unverified', provider: 'prowlarr', candidate_count: 2 }],
      })
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      if (requests.length === 1)
        return Response.json({
          ok: true,
          config_generation: 1,
          sabnzbd_configured: true,
          providers_enabled: { animetosho: true, amenzb: false },
          prowlarr_usage: usage,
          results: [unverified('checked', true), unverified('dropped', false), unverified('searched', true)],
        })
      return availabilityReply([
        availabilityRow('checked', { search: 'prowlarr', refreshing: false }),
        availabilityRow('searched', { aggregate: 'no_match', search: 'prowlarr', refreshing: false }),
      ])
    }
    const selections = ['checked', 'dropped', 'searched'].map(availabilitySelection)
    const order: string[] = []
    const observing = observeUsenetAvailability(selections, {
      signal: controller.signal,
      search: [{ key: 'searched', release: 0 }],
      verify: [selections[0], { key: 'elsewhere', release: 0 }],
      cancelVerify: [selections[1]],
      onRequested: sent => {
        order.push('requested')
        assert.deepEqual(sent, { verify: [selections[0]], cancel: [selections[1]] })
      },
      onSnapshot: snapshot => {
        if (Object.keys(snapshot.rows).length) order.push('snapshot')
        snapshots.push(snapshot)
      },
    })
    await settle()
    assert.deepEqual(order, ['requested', 'snapshot'], 'The ledger knows about a check before its row is shown')
    assert.deepEqual(snapshots.at(-1)!.usage, usage)
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(selections[0])].aggregate, 'unverified')
    await pollAvailability(timers)
    await observing
    assert.deepEqual(requests, [
      {
        selections,
        search: [{ key: 'searched', release: 0 }],
        verify: [{ key: 'checked', release: 0 }],
        cancel_verify: [{ key: 'dropped', release: 0 }],
      },
      { selections: [selections[0], selections[2]] },
    ])
    assert.deepEqual(order, ['requested', 'snapshot', 'snapshot'], 'Polling asks for no work')
    assert.equal(snapshots.at(-1)!.rows[availabilityKey(selections[0])].aggregate, 'available')
    assert.deepEqual(snapshots.at(-1)!.usage, usage, 'The last reported usage stays while a poll does not repeat it')
    assert.equal(timers.size, 0)
  })
})

test('a changed config generation discards unverified rows and what the indexers allowed', async () => {
  await availabilityFixture(async (_timers, snapshots, controller) => {
    const selections = [availabilitySelection('unverified')]
    const row = availabilityRow('unverified', {
      aggregate: 'unverified',
      search: 'prowlarr',
      refreshing: false,
      hashes: [{ hash: 'files:' + 'a'.repeat(40), state: 'unverified', provider: 'prowlarr', candidate_count: 3 }],
    })
    const initial: AvailabilitySnapshot = {
      rows: { [availabilityKey(selections[0])]: row },
      configGeneration: 4,
      sabnzbdConfigured: true,
      loading: false,
      error: null,
      usage: [{ indexer: 'Geek', fetches_left: 3 }],
    }
    globalThis.fetch = async () =>
      availabilityReply(
        [
          availabilityRow('unverified', {
            aggregate: 'not_checked',
            search: 'prowlarr',
            checked_at: '',
            refreshing: false,
          }),
        ],
        5,
      )
    await observeUsenetAvailability(selections, {
      signal: controller.signal,
      initial,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    assert.equal(snapshots[0].rows[availabilityKey(selections[0])].aggregate, 'unverified')
    assert.deepEqual(snapshots[0].usage, initial.usage, 'Known rows stay visible until the server answers')
    const latest = snapshots.at(-1)!
    assert.equal(latest.configGeneration, 5)
    assert.equal(latest.rows[availabilityKey(selections[0])].aggregate, 'not_checked')
    assert.equal(latest.usage, undefined, 'Usage of the earlier provider configuration is not carried over')
  })
})

test('large reviews publish each cached batch before later batches finish', async () => {
  await availabilityFixture(async (_timers, snapshots, controller) => {
    const held = Promise.withResolvers<Response>()
    let calls = 0
    let generation = 1
    globalThis.fetch = async (_input, init) => {
      const { selections } = JSON.parse(String(init?.body)) as { selections: SelectionInput[] }
      if (++calls === 2) return held.promise
      return availabilityReply(
        selections.map(selection => availabilityRow(selection.key, { refreshing: false })),
        generation,
      )
    }
    const selections = Array.from({ length: 201 }, (_, index) => availabilitySelection(`row-${index}`))
    const observing = observeUsenetAvailability(selections, {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    assert.equal(Object.keys(snapshots.at(-1)!.rows).length, 200)
    assert.equal(snapshots.at(-1)!.loading, true)
    generation = 2
    held.resolve(availabilityReply([availabilityRow('row-200', { refreshing: false })], generation))
    await observing
    assert.equal(Object.keys(snapshots.at(-1)!.rows).length, 201)
    assert.equal(snapshots.at(-1)!.loading, false)
    assert.equal(snapshots.at(-1)!.configGeneration, 2)
    assert.equal(calls, 4, 'A generation change between chunks re-reads every requested identity')
  })
})

test('a mismatched snapshot preserves last-known data, reports the missing identity, and stops polling', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    let calls = 0
    globalThis.fetch = async () =>
      availabilityReply([
        availabilityRow('cached', calls++ ? { identity: 'obsolete-identity', refreshing: false } : {}),
      ])
    const observing = observeUsenetAvailability([availabilitySelection('cached')], {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    await settle()
    await pollAvailability(timers)
    await observing
    const row = snapshots.at(-1)!.rows[availabilityKey(availabilitySelection('cached'))]
    assert.equal(row.aggregate, 'available')
    assert.equal(row.identity, 'identity:cached')
    assert.equal(row.checked_at, '2026-11-18T10:00:00.000Z')
    assert.equal(row.refreshing, false)
    assert.match(snapshots.at(-1)!.error || '', /requested release/)
    assert.equal(timers.size, 0)
  })
})

test('a row-level refresh failure warns without replacing successful cached hashes', async () => {
  await availabilityFixture(async (timers, snapshots, controller) => {
    globalThis.fetch = async () =>
      availabilityReply([
        availabilityRow('cached', { refreshing: false, refresh_error: 'Fixture row-level refresh failure' }),
      ])
    await observeUsenetAvailability([availabilitySelection('cached')], {
      signal: controller.signal,
      onSnapshot: snapshot => snapshots.push(snapshot),
    })
    const latest = snapshots.at(-1)!
    const row = latest.rows[availabilityKey(availabilitySelection('cached'))]
    assert.equal(row.aggregate, 'available')
    assert.equal(row.hashes[0].state, 'available')
    assert.equal(row.hashes[0].error, undefined)
    assert.equal(row.hashes[0].refresh_error, undefined)
    assert.equal(latest.error, 'Fixture row-level refresh failure')
    assert.equal(row.checked_at, '2026-11-18T10:00:00.000Z')
    assert.equal(timers.size, 0)
  })
})
