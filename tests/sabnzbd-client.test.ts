import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SabnzbdAmbiguousError,
  SabnzbdAuthError,
  SabnzbdError,
  sabAddNzb,
  sabDeleteHistoryJob,
  sabDeleteQueueJob,
  sabEndpointId,
  sabMissingCategories,
  sabSubmissionName,
  sabHistoryJobs,
  sabPauseJob,
  sabQueueJobs,
  sabResumeJob,
  sabTestConnection,
  type SabnzbdSettings,
} from '../server/sabnzbd.js'

const settings: SabnzbdSettings = { apiUrl: 'http://sab.test/api', apiKey: 'sekret-key-9f3c' }
const nzoId = 'SABnzbd_nzo_test01'
const nzbBytes = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20, 0x76, 0x65, 0x72])

interface FetchCall {
  url: URL
  init: RequestInit
}

function recordingFetch(respond: (url: URL, index: number) => Response): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    calls.push({ url, init: init ?? {} })
    return respond(url, calls.length - 1)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function queueResponse(slots: unknown[], extra: Record<string, unknown> = {}): Response {
  return Response.json({ queue: { paused_all: false, slots, ...extra } })
}

function historyResponse(slots: unknown[]): Response {
  return Response.json({ history: { slots } })
}

function isPlainSabError(error: unknown): boolean {
  return error instanceof SabnzbdError && !(error instanceof SabnzbdAmbiguousError)
}

describe('sabTestConnection', () => {
  test('reads the version without a key then proves the key with a targeted queue probe', async () => {
    const { fetchImpl, calls } = recordingFetch(url =>
      url.searchParams.get('mode') === 'version'
        ? Response.json({ version: '5.1.3' })
        : Response.json({ queue: { paused_all: false, slots: [] } }),
    )

    assert.deepEqual(await sabTestConnection(settings, fetchImpl), { version: '5.1.3' })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url.searchParams.get('mode'), 'version')
    assert.equal(calls[0].url.searchParams.get('apikey'), null)
    assert.equal(calls[0].url.searchParams.get('output'), 'json')
    assert.equal(calls[1].url.searchParams.get('mode'), 'queue')
    assert.equal(calls[1].url.searchParams.get('apikey'), settings.apiKey)
    assert.equal(calls[1].url.searchParams.get('limit'), '1')
    // The probe must never enqueue anything.
    assert.ok(calls.every(call => call.url.searchParams.get('mode') !== 'addurl' && call.init.method !== 'POST'))
  })

  test('add-only key rejected on the queue probe raises SabnzbdAuthError with guidance', async () => {
    const { fetchImpl } = recordingFetch(url =>
      url.searchParams.get('mode') === 'version'
        ? Response.json({ version: '5.1.3' })
        : Response.json({ error: 'API Key Incorrect' }),
    )
    await assert.rejects(sabTestConnection(settings, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof SabnzbdAuthError)
      assert.match(error.message, /full API key \(not the NZB add-only key\)/)
      assert.ok(!error.message.includes(settings.apiKey))
      return true
    })
  })

  test('an HTML page with status 200 is an error, not a connection', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html><body>SABnzbd</body></html>', { status: 200 }))
    await assert.rejects(sabTestConnection(settings, fetchImpl), isPlainSabError)
  })
})

describe('sabAddNzb', () => {
  test('submits exact multipart fields with the NZB bytes, key only in the query', async () => {
    const { fetchImpl, calls } = recordingFetch(() => Response.json({ status: true, nzo_ids: [nzoId] }))
    const ids = await sabAddNzb(settings, nzbBytes, 'Show S01 [1080p]', 'sonarr-anime', fetchImpl)
    assert.deepEqual(ids, [nzoId])
    assert.equal(calls.length, 1)
    const { url, init } = calls[0]
    assert.equal(init.method, 'POST')
    assert.equal(url.pathname, '/api')
    assert.equal(url.searchParams.get('apikey'), settings.apiKey)
    assert.equal(url.searchParams.getAll('apikey').length, 1)
    assert.equal(url.searchParams.get('output'), 'json')
    assert.equal(url.searchParams.get('mode'), null)
    const form = init.body as FormData
    assert.ok(form instanceof FormData)
    assert.equal(form.get('mode'), 'addfile')
    assert.equal(form.get('nzbname'), 'Show S01 [1080p]')
    assert.equal(form.get('cat'), 'sonarr-anime')
    assert.equal(form.get('pp'), '-1')
    // One credential location: the key is in the query, never the body.
    assert.equal(form.get('apikey'), null)
    const file = form.get('name')
    assert.ok(file instanceof Blob)
    assert.equal(file.name, 'download.nzb')
    assert.equal(file.type, 'application/x-nzb+xml')
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), nzbBytes)
    // Never send an undefined signal — the request honors settings.signal.
    assert.ok(init.signal instanceof AbortSignal)
  })

  test('accepted submissions without usable native IDs remain ambiguous', async () => {
    for (const body of [
      { status: true },
      { status: true, nzo_ids: [] },
      { status: true, nzo_ids: [''] },
      { status: true, nzo_ids: ['   '] },
      { status: true, nzo_ids: 'oops' },
      { status: true, nzo_ids: [nzoId, null] },
    ]) {
      const { fetchImpl, calls } = recordingFetch(() => Response.json(body))
      await assert.rejects(
        sabAddNzb(settings, nzbBytes, 'name', 'cat', fetchImpl),
        (error: unknown) => error instanceof SabnzbdAmbiguousError,
        `body ${JSON.stringify(body)}`,
      )
      assert.equal(calls.length, 1)
    }
  })

  test('an acceptance response with an HTTP failure or error cannot prove rejection', async () => {
    for (const response of [
      Response.json({ status: true }, { status: 500 }),
      Response.json({ status: true, nzo_ids: [nzoId], error: 'conflicting response' }),
    ]) {
      const { fetchImpl } = recordingFetch(() => response)
      await assert.rejects(
        sabAddNzb(settings, nzbBytes, 'name', 'cat', fetchImpl),
        (error: unknown) => error instanceof SabnzbdAmbiguousError,
      )
    }
  })

  test('an API Key Incorrect add response raises SabnzbdAuthError', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ status: false, error: 'API Key Incorrect' }))
    await assert.rejects(sabAddNzb(settings, nzbBytes, 'name', 'cat', fetchImpl), (error: unknown) => {
      assert.ok(error instanceof SabnzbdAuthError)
      assert.ok(!error.message.includes(settings.apiKey))
      return true
    })
  })

  test('HTML rejection text is stripped, collapsed and bounded', async () => {
    const { fetchImpl } = recordingFetch(() =>
      Response.json({ status: false, error: `<b>${'x'.repeat(500)}</b>  bad\n\n input` }),
    )
    await assert.rejects(sabAddNzb(settings, nzbBytes, 'name', 'cat', fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.ok(!(error as Error).message.includes('<'))
      assert.ok(!(error as Error).message.includes('\n'))
      assert.ok((error as Error).message.length <= 300)
      return true
    })
  })

  test('a timed out submission maps to ambiguous and is never retried internally', async () => {
    let calls = 0
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      calls++
      const signal = init?.signal
      if (!signal) {
        reject(new Error('client must pass a signal'))
        return promise
      }
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      return promise
    }) as typeof fetch
    // A client deadline expiring mid-POST: the add outcome is unknown.
    const timedOut: SabnzbdSettings = { ...settings, signal: AbortSignal.timeout(1) }
    await assert.rejects(sabAddNzb(timedOut, nzbBytes, 'name', 'cat', fetchImpl), (error: unknown) => {
      assert.ok(error instanceof SabnzbdAmbiguousError)
      assert.ok(!error.message.includes(settings.apiKey))
      return true
    })
    assert.equal(calls, 1)
  })

  test('a network failure during the add POST is ambiguous, not a safe failure', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error('socket hang up')
    })
    await assert.rejects(
      sabAddNzb(settings, nzbBytes, 'name', 'cat', fetchImpl),
      (error: unknown) => error instanceof SabnzbdAmbiguousError,
    )
  })
})

describe('sabQueueJobs', () => {
  test('converts decimal megabytes, speed strings and diskspace gigabytes', async () => {
    const { fetchImpl } = recordingFetch(() =>
      queueResponse(
        [
          {
            nzo_id: 'q1',
            filename: 'Show',
            status: 'Downloading',
            cat: 'sonarr-anime',
            mb: '10.5',
            mbleft: '5.25',
            percentage: '50.5',
            labels: ['DUPLICATE'],
            nzf_id: 'ignored',
          },
          {
            nzo_id: 'q2',
            filename: 'Other',
            status: 'Paused',
            cat: '',
            mb: '1',
            mbleft: '1',
            percentage: '0',
            labels: [],
          },
        ],
        { kbpersec: '1296.02', diskspace1: '161.16', diskspace2: '0.5' },
      ),
    )
    const read = await sabQueueJobs(settings, ['q1', 'q2'], fetchImpl)
    assert.equal(read.read_complete, true)
    assert.equal(read.globalPaused, false)
    assert.equal(read.incomplete_free_bytes, 161160000000)
    assert.equal(read.complete_free_bytes, 500000000)
    assert.deepEqual(read.jobs, [
      {
        nzo_id: 'q1',
        name: 'Show',
        status: 'Downloading',
        category: 'sonarr-anime',
        total_bytes: 10500000,
        remaining_bytes: 5250000,
        downloaded_bytes: 5250000,
        speed_bytes_per_sec: 1296020,
        percentage: 50.5,
        labels: ['DUPLICATE'],
      },
      {
        nzo_id: 'q2',
        name: 'Other',
        status: 'Paused',
        category: '',
        total_bytes: 1000000,
        remaining_bytes: 1000000,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        percentage: 0,
        labels: [],
      },
    ])
  })

  test('global pause and unparseable diskspace surface as true and null', async () => {
    const { fetchImpl } = recordingFetch(() => queueResponse([], { paused_all: true, diskspace1: 'n/a' }))
    const read = await sabQueueJobs(settings, ['q1'], fetchImpl)
    assert.equal(read.globalPaused, true)
    assert.equal(read.incomplete_free_bytes, null)
    assert.equal(read.complete_free_bytes, null)
    assert.equal(read.read_complete, true)
  })

  test('more than twenty ids chunk into targeted requests', async () => {
    const { fetchImpl, calls } = recordingFetch(() => queueResponse([]))
    const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`)
    const read = await sabQueueJobs(settings, ids, fetchImpl)
    assert.equal(read.read_complete, true)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].url.searchParams.get('nzo_ids')?.split(','), ids.slice(0, 20))
    assert.deepEqual(calls[1].url.searchParams.get('nzo_ids')?.split(','), ids.slice(20))
    assert.equal(calls[0].url.searchParams.get('output'), 'json')
    assert.equal(calls[0].url.searchParams.get('apikey'), settings.apiKey)
    // Targeted reads only: never a broad or category-wide queue request.
    assert.ok(calls.every(call => !call.url.searchParams.has('cat') && !call.url.searchParams.has('search')))
  })

  test('an empty id list performs no request and reports a complete empty read', async () => {
    const { fetchImpl, calls } = recordingFetch(() => queueResponse([]))
    const read = await sabQueueJobs(settings, [], fetchImpl)
    assert.equal(calls.length, 0)
    assert.deepEqual(read.jobs, [])
    assert.equal(read.read_complete, true)
  })

  test('one failed chunk keeps successful jobs and marks the read incomplete', async () => {
    const { fetchImpl } = recordingFetch((_url, index) =>
      index === 0
        ? queueResponse([{ nzo_id: 'q1', filename: 'Show', status: 'Queued', mb: '2', mbleft: '2' }])
        : new Response('gateway exploded', { status: 502 }),
    )
    const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`)
    const read = await sabQueueJobs(settings, ids, fetchImpl)
    assert.equal(read.read_complete, false)
    assert.deepEqual(
      read.jobs.map(job => job.nzo_id),
      ['q1'],
    )
  })

  test('missing, malformed, or unparseable queue slots cannot prove absence', async () => {
    for (const queue of [{}, { slots: null }, { slots: {} }, { slots: [null] }, { slots: [{}] }]) {
      const { fetchImpl } = recordingFetch(() => Response.json({ queue }))
      const read = await sabQueueJobs(settings, ['missing'], fetchImpl)
      assert.equal(read.read_complete, false, JSON.stringify(queue))
    }
  })
})

describe('sabHistoryJobs', () => {
  test('merges the archive read and converts numeric byte fields', async () => {
    const { fetchImpl, calls } = recordingFetch(url =>
      url.searchParams.get('archive') === '1'
        ? historyResponse([
            {
              nzo_id: 'h2',
              name: 'Archived',
              status: 'Completed',
              fail_message: '',
              category: 'cat',
              bytes: 2000,
              downloaded: 2000,
              storage: '/archive/h2',
              loaded: false,
            },
          ])
        : historyResponse([
            {
              nzo_id: 'h1',
              name: 'Live',
              status: 'Failed',
              fail_message: 'not enough articles',
              category: 'cat',
              bytes: 1000,
              downloaded: 800,
              storage: null,
              loaded: true,
            },
          ]),
    )
    const read = await sabHistoryJobs(settings, ['h1', 'h2'], fetchImpl)
    assert.equal(read.read_complete, true)
    assert.equal(calls.length, 2)
    assert.equal(calls.filter(call => call.url.searchParams.get('archive') === '1').length, 1)
    assert.deepEqual(read.jobs, [
      {
        nzo_id: 'h1',
        name: 'Live',
        status: 'Failed',
        fail_message: 'not enough articles',
        category: 'cat',
        total_bytes: 1000,
        downloaded_bytes: 800,
        storage: null,
        loaded: true,
      },
      {
        nzo_id: 'h2',
        name: 'Archived',
        status: 'Completed',
        fail_message: '',
        category: 'cat',
        total_bytes: 2000,
        downloaded_bytes: 2000,
        storage: '/archive/h2',
        loaded: false,
      },
    ])
  })

  test('a failing archive read marks the read incomplete so absence cannot be claimed', async () => {
    const { fetchImpl } = recordingFetch(url =>
      url.searchParams.get('archive') === '1' ? new Response('boom', { status: 500 }) : historyResponse([]),
    )
    const read = await sabHistoryJobs(settings, ['h1'], fetchImpl)
    assert.equal(read.read_complete, false)
    assert.deepEqual(read.jobs, [])
  })

  test('missing, malformed, or unparseable history slots cannot prove absence', async () => {
    for (const history of [{}, { slots: null }, { slots: {} }, { slots: [null] }, { slots: [{}] }]) {
      const { fetchImpl } = recordingFetch(() => Response.json({ history }))
      const read = await sabHistoryJobs(settings, ['missing'], fetchImpl)
      assert.equal(read.read_complete, false, JSON.stringify(history))
    }
  })
})

describe('controls', () => {
  test('pause succeeds only when a fresh targeted read confirms Paused', async () => {
    const { fetchImpl, calls } = recordingFetch(url =>
      url.searchParams.get('name') === 'pause'
        ? Response.json({ status: true, nzo_ids: [nzoId] })
        : queueResponse([{ nzo_id: nzoId, filename: 'Show', status: 'Paused', mb: '1', mbleft: '1' }]),
    )
    await sabPauseJob(settings, nzoId, fetchImpl)
    const control = calls[0]
    assert.equal(control.url.searchParams.get('mode'), 'queue')
    assert.equal(control.url.searchParams.get('name'), 'pause')
    assert.equal(control.url.searchParams.get('value'), nzoId)
    assert.equal(control.url.searchParams.get('output'), 'json')
  })

  test('pause throws when the confirmation read cannot establish the pause', async () => {
    const { fetchImpl } = recordingFetch(url =>
      url.searchParams.get('name') === 'pause'
        ? Response.json({ status: true })
        : queueResponse([{ nzo_id: nzoId, filename: 'Show', status: 'Downloading', mb: '1', mbleft: '1' }]),
    )
    await assert.rejects(sabPauseJob(settings, nzoId, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.match((error as Error).message, /could not confirm/i)
      return true
    })
  })

  test('pause throws when SAB answers the control itself with an error body', async () => {
    const { fetchImpl, calls } = recordingFetch(() => Response.json({ error: 'Job not found' }))
    await assert.rejects(sabPauseJob(settings, nzoId, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.match((error as Error).message, /Job not found/)
      return true
    })
    // No confirmation read is attempted after a rejected control.
    assert.equal(calls.length, 1)
  })

  test('resume throws when the job is still paused after the control', async () => {
    const { fetchImpl } = recordingFetch(url =>
      url.searchParams.get('name') === 'resume'
        ? Response.json({ status: true })
        : queueResponse([{ nzo_id: nzoId, filename: 'Show', status: 'Paused', mb: '1', mbleft: '1' }]),
    )
    await assert.rejects(sabResumeJob(settings, nzoId, fetchImpl), isPlainSabError)
  })

  test('queue delete resolves once the job left the queue even though history already has it', async () => {
    const { fetchImpl, calls } = recordingFetch(url => {
      const mode = url.searchParams.get('mode')
      if (mode === 'queue' && url.searchParams.get('name') === 'delete')
        return Response.json({ status: true, nzo_ids: [nzoId] })
      if (mode === 'queue') return queueResponse([]) // Left the transfer queue already.
      return historyResponse([{ nzo_id: nzoId, name: 'Show', status: 'Queued' }]) // Post-processing race.
    })
    await sabDeleteQueueJob(settings, nzoId, true, fetchImpl)
    assert.ok(calls.every(call => call.url.searchParams.get('mode') === 'queue'))
    assert.ok(
      calls.every(
        call => call.url.searchParams.get('nzo_ids') === nzoId || call.url.searchParams.get('value') === nzoId,
      ),
    )
    const control = calls[0]
    assert.equal(control.url.searchParams.get('name'), 'delete')
    assert.equal(control.url.searchParams.get('value'), nzoId)
    assert.equal(control.url.searchParams.get('del_files'), '1')
    assert.equal(control.url.searchParams.get('value') !== 'all', true)
  })

  test('queue delete keeps files by default and throws while the job is still queued', async () => {
    const { fetchImpl, calls } = recordingFetch(url =>
      url.searchParams.get('name') === 'delete'
        ? Response.json({ status: true })
        : queueResponse([{ nzo_id: nzoId, filename: 'Show', status: 'Downloading', mb: '1', mbleft: '0.5' }]),
    )
    await assert.rejects(sabDeleteQueueJob(settings, nzoId, false, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.match((error as Error).message, /still in the SABnzbd queue/)
      return true
    })
    assert.equal(calls[0].url.searchParams.get('del_files'), '0')
  })

  test('queue delete cannot claim absence when the confirmation read fails', async () => {
    const { fetchImpl } = recordingFetch(url =>
      url.searchParams.get('name') === 'delete'
        ? Response.json({ status: true })
        : new Response('lost', { status: 503 }),
    )
    await assert.rejects(sabDeleteQueueJob(settings, nzoId, false, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.match((error as Error).message, /could not confirm/i)
      return true
    })
  })

  test('history delete confirms absence across both history and archive', async () => {
    const { fetchImpl, calls } = recordingFetch(url => {
      if (url.searchParams.get('name') === 'delete') return Response.json({ status: true })
      return historyResponse([])
    })
    await sabDeleteHistoryJob(settings, nzoId, false, fetchImpl)
    const control = calls[0]
    assert.equal(control.url.searchParams.get('mode'), 'history')
    assert.equal(control.url.searchParams.get('name'), 'delete')
    assert.equal(control.url.searchParams.get('value'), nzoId)
    assert.equal(control.url.searchParams.get('archive'), '0')
    assert.equal(control.url.searchParams.get('del_files'), '0')
    assert.equal(calls.filter(call => call.url.searchParams.get('mode') === 'history').length, 3)
  })

  test('history delete throws while the record survives in the archive', async () => {
    const { fetchImpl } = recordingFetch(url => {
      if (url.searchParams.get('name') === 'delete') return Response.json({ status: true })
      if (url.searchParams.get('archive') === '1') {
        return historyResponse([
          { nzo_id: nzoId, name: 'Show', status: 'Completed', category: 'cat', bytes: 1, downloaded: 1 },
        ])
      }
      return historyResponse([])
    })
    await assert.rejects(sabDeleteHistoryJob(settings, nzoId, true, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      assert.match((error as Error).message, /still in SABnzbd history or archive/)
      return true
    })
  })

  test('an API key rejection on a control raises SabnzbdAuthError, not ambiguous', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ error: 'API Key Incorrect' }))
    await assert.rejects(sabResumeJob(settings, nzoId, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof SabnzbdAuthError)
      assert.ok(!(error instanceof SabnzbdAmbiguousError))
      return true
    })
  })

  test('a transport failure during a control is a plain error, never ambiguous', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    await assert.rejects(sabPauseJob(settings, nzoId, fetchImpl), (error: unknown) => {
      assert.ok(isPlainSabError(error))
      return true
    })
  })
})

describe('sabEndpointId', () => {
  test('strips credentials, a trailing /api and normalizes host case and default ports', () => {
    assert.equal(
      sabEndpointId('https://User:Sup3rSekret@Host.Example:8443/sabnzbd/api'),
      'https://host.example:8443/sabnzbd',
    )
    assert.equal(sabEndpointId('https://host.example:443/api'), 'https://host.example')
    assert.equal(sabEndpointId('http://host.example:80/'), 'http://host.example')
    assert.ok(!sabEndpointId('https://user:pass@host/api').includes('pass'))
    assert.ok(!sabEndpointId('https://user:pass@host/api').includes('user'))
  })

  test('endpoints differing only by trailing slash or /api suffix compare equal', () => {
    const ids = new Set([
      sabEndpointId('https://sab.lan/api'),
      sabEndpointId('https://sab.lan/api/'),
      sabEndpointId('https://sab.lan'),
      sabEndpointId('https://sab.lan/'),
    ])
    assert.deepEqual([...ids], ['https://sab.lan'])
    const proxied = new Set([
      sabEndpointId('https://reverse.proxy:9443/sabnzbd/api'),
      sabEndpointId('https://reverse.proxy:9443/sabnzbd/api/'),
    ])
    assert.deepEqual([...proxied], ['https://reverse.proxy:9443/sabnzbd'])
  })

  test('malformed or unsupported endpoints throw without echoing input', () => {
    for (const bad of ['', 'not a url', 'sab.lan/api', 'ftp://sab.lan/api', 'https://:8443/api', 'https://[bad/api']) {
      assert.throws(
        () => sabEndpointId(bad),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          if (bad !== '') assert.ok(!error.message.includes(bad))
          return true
        },
        `input ${JSON.stringify(bad)}`,
      )
    }
  })
})

test('job names are sent without a .nzb suffix and fall back to the source hash', () => {
  assert.equal(sabSubmissionName('Show S01 [Group].nzb', 'f'.repeat(40)), 'Show S01 [Group]')
  assert.equal(sabSubmissionName('Show S01.mkv', 'f'.repeat(40)), 'Show S01.mkv')
  assert.equal(sabSubmissionName(undefined, 'abcdef0123456789'.repeat(3)), 'abcdef012345')
})

test('category checks report only configured categories SABnzbd lacks and never guess when the list is unreadable', async () => {
  const cats = (async () => Response.json({ categories: ['*', 'TV', 'sonarr-anime'] })) as unknown as typeof fetch
  assert.deepEqual(await sabMissingCategories(settings, ['sonarr-anime', 'tv', 'radarr-anime', ''], cats), [
    'radarr-anime',
  ])
  const broken = (async () => Response.json({ error: 'API Key Incorrect' })) as unknown as typeof fetch
  assert.equal(await sabMissingCategories(settings, ['sonarr-anime'], broken), null)
})
