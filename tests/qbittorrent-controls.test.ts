import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { DEFAULT_CONFIG } from '../server/config.js'
import { DATA_DIR } from '../server/paths.js'
import { qbAddTorrent, qbControlTorrents, QbittorrentAmbiguousError } from '../server/qbittorrent.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { resetWebhookScanState } from '../server/scheduler.js'
import { qbPhase } from '../server/qbittorrent-adapter.js'

import { testIntegration } from '../server/integration-tests.js'
import { wantedParts, type RecommendationSeason } from '../shared/download-plan.js'

beforeEach(() => {
  resetRuntimeForTests()
  resetWebhookScanState()
  if (existsSync(join(DATA_DIR, 'scan_schedule_state.json'))) rmSync(join(DATA_DIR, 'scan_schedule_state.json'))
  if (existsSync(join(DATA_DIR, 'scan_schedule_state.json.tmp'))) rmSync(join(DATA_DIR, 'scan_schedule_state.json.tmp'))
})

describe('qBittorrent torrent controls', () => {
  test('selects only downloadable best releases from upgradable seasons', () => {
    const upgradeSeason: RecommendationSeason = {
      key: 'upgrade-season',
      status: 'upgrade',
      releases: [
        {
          kind: 'best',
          torrent_available: true,
          releaseGroup: 'Group',
          info_hashes: ['a'.repeat(40)],
          selected_files: ['Cour 1/episode.mkv'],
        },
        { kind: 'alt', torrent_available: true, releaseGroup: 'Group', info_hashes: ['b'.repeat(40)] },
        { kind: 'best', torrent_available: false, releaseGroup: 'Group', info_hashes: ['c'.repeat(40)] },
      ],
    }
    const parts = wantedParts(upgradeSeason)
    assert.deepEqual(
      parts.map(part => [part.part, part.torrent_available]),
      [['', true]],
    )
    assert.deepEqual(
      parts[0].options.map(option => option.index),
      [0],
      'Only the downloadable best release is offered for submission',
    )
    assert.deepEqual(
      wantedParts({
        key: 'owned-season',
        status: 'best',
        releases: [{ kind: 'best', torrent_available: true, releaseGroup: 'Group', info_hashes: ['d'.repeat(40)] }],
      }),
      [],
    )
    assert.deepEqual(wantedParts({ key: 'missing-season', status: 'missing', releases: [] }), [])
  })

  test('normalizes qBittorrent states into download phases', () => {
    assert.equal(qbPhase('pausedDL', 0.5), 'paused')
    assert.equal(qbPhase('stoppedDL', 0.5), 'paused')
    assert.equal(qbPhase('uploading', 1), 'seeding')
    assert.equal(qbPhase('checkingDL', 0.5), 'verifying')
    assert.equal(qbPhase('missingFiles', 0.5), 'error')
    assert.equal(qbPhase('forcedDL', 0.5), 'downloading')
    assert.equal(qbPhase('queuedDL', 0.5), 'queued')
    assert.equal(qbPhase('metaDL', 0.5), 'queued')
  })

  test('pauses torrents and removes them with the selected file behavior', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      return new Response('', { status: 200 })
    }
    const config = {
      ...DEFAULT_CONFIG,
      qbittorrent_url: 'http://qb.example',
      qbittorrent_user: 'admin',
      qbittorrent_pass: 'secret',
    }
    try {
      await qbControlTorrents(config, ['a'.repeat(40)], 'pause')
      await qbControlTorrents(config, ['a'.repeat(40)], 'remove', true)
      await qbControlTorrents(config, ['a'.repeat(40)], 'remove', false)
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(requests[1].url, 'http://qb.example/api/v2/torrents/stop')
    assert.equal(new URLSearchParams(requests[1].body).get('hashes'), 'a'.repeat(40))
    assert.equal(requests[2].url, 'http://qb.example/api/v2/torrents/delete')
    assert.equal(new URLSearchParams(requests[2].body).get('deleteFiles'), 'true')
    assert.equal(new URLSearchParams(requests[3].body).get('deleteFiles'), 'false')
  })

  test('falls back to the legacy pause endpoint', async () => {
    const originalFetch = globalThis.fetch
    const paths: string[] = []
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      paths.push(url)
      if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.endsWith('/api/v2/torrents/stop')) return new Response('Not Found', { status: 404 })
      return new Response('', { status: 200 })
    }
    try {
      await qbControlTorrents(
        {
          ...DEFAULT_CONFIG,
          qbittorrent_url: 'http://qb.example',
          qbittorrent_user: 'admin',
          qbittorrent_pass: 'secret',
        },
        ['b'.repeat(40)],
        'pause',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(paths.at(-1), 'http://qb.example/api/v2/torrents/pause')
  })

  test('downloads only selected cour files after magnet metadata arrives', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/info')) return new Response('[]', { status: 200 })
      if (url.includes('/api/v2/torrents/files?'))
        return new Response(
          JSON.stringify([
            { index: 4, name: 'Root/Show.S01E01.mkv' },
            { index: 9, name: 'Root/Show.S01E02.mkv' },
          ]),
          { status: 200 },
        )
      return new Response('', { status: 200 })
    }

    try {
      await qbAddTorrent(
        {
          ...DEFAULT_CONFIG,
          qbittorrent_url: 'http://qb.example',
          qbittorrent_user: 'admin',
          qbittorrent_pass: 'secret',
        },
        `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        'sonarr-anime',
        ['Show.S01E02.mkv'],
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const add = requests.find(request => request.url.endsWith('/api/v2/torrents/add'))!
    assert.equal(new URLSearchParams(add.body).get('paused'), 'true')
    assert.equal(new URLSearchParams(add.body).get('stopped'), 'true')
    const metadataRequest = requests.findIndex(request => request.url.includes('/api/v2/torrents/files?'))
    const initialStart = requests.findIndex(request => request.url.endsWith('/api/v2/torrents/start'))
    assert.ok(
      initialStart > 0 && initialStart < metadataRequest,
      'torrent must be started before requesting magnet metadata',
    )
    const priorities = requests.filter(request => request.url.endsWith('/api/v2/torrents/filePrio'))
    assert.deepEqual(
      priorities.map(request => Object.fromEntries(new URLSearchParams(request.body))),
      [
        { hash: 'a'.repeat(40), id: '4|9', priority: '0' },
        { hash: 'a'.repeat(40), id: '9', priority: '1' },
      ],
    )
    assert.equal(requests.at(-1)?.url, 'http://qb.example/api/v2/torrents/start')
  })

  test('removes the torrent and reports a metadata failure when metadata never arrives', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/info')) return new Response('[]', { status: 200 })
      if (url.includes('/api/v2/torrents/files?')) return new Response('[]', { status: 200 })
      return new Response('', { status: 200 })
    }
    const config = {
      ...DEFAULT_CONFIG,
      qbittorrent_url: 'http://qb.example',
      qbittorrent_user: 'admin',
      qbittorrent_pass: 'secret',
    }
    try {
      await assert.rejects(
        () => qbAddTorrent(config, `magnet:?xt=urn:btih:${'a'.repeat(40)}`, 'sonarr-anime', ['Show.S01E01.mkv'], 400),
        /metadata fetching failed/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const removal = requests.find(request => request.url.endsWith('/api/v2/torrents/delete'))
    assert.ok(removal, 'the torrent must be removed after the metadata timeout')
    assert.equal(new URLSearchParams(removal.body).get('deleteFiles'), 'false')
  })

  test('keeps adding the remaining torrents when one fails to fetch metadata', async () => {
    const originalFetch = globalThis.fetch
    const requests: { url: string; body: string }[] = []
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, body: String(init?.body || '') })
      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', { status: 200, headers: { 'Set-Cookie': 'SID=test; Path=/' } })
      }
      if (url.endsWith('/api/v2/torrents/add')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/info')) return new Response('[]', { status: 200 })
      if (url.includes('/api/v2/torrents/files?')) {
        const hash = new URL(url).searchParams.get('hash')
        // The first torrent never exchanges magnet metadata; the second one does.
        if (hash === 'a'.repeat(40)) return new Response('[]', { status: 200 })
        return new Response(JSON.stringify([{ index: 0, name: 'Root/Show.S01E01.mkv' }]), { status: 200 })
      }
      return new Response('', { status: 200 })
    }
    const config = {
      ...DEFAULT_CONFIG,
      qbittorrent_url: 'http://qb.example',
      qbittorrent_user: 'admin',
      qbittorrent_pass: 'secret',
    }
    const owned = new Set<string>()
    try {
      const ownership = {
        record: (hash: string) => owned.add(hash),
        forget: (hash: string) => {
          owned.delete(hash)
        },
      }
      await assert.rejects(
        qbAddTorrent(config, `magnet:?xt=urn:btih:${'a'.repeat(40)}`, undefined, ['Show.S01E01.mkv'], 400, ownership),
        /metadata fetching failed/i,
      )
      await qbAddTorrent(
        config,
        `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
        undefined,
        ['Show.S01E01.mkv'],
        4_000,
        ownership,
      )
      assert.deepEqual([...owned], ['b'.repeat(40)], 'only the successfully configured torrent remains app-owned')
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.ok(
      requests.some(
        request =>
          request.url.endsWith('/api/v2/torrents/add') &&
          new URLSearchParams(request.body).get('urls')?.includes('b'.repeat(40)),
      ),
      'the second torrent must still be added after the first one failed',
    )
    const removal = requests.find(request => request.url.endsWith('/api/v2/torrents/delete'))
    assert.ok(removal && new URLSearchParams(removal.body).get('hashes') === 'a'.repeat(40))
  })

  test('rejects a pre-existing torrent without claiming ownership', async () => {
    const originalFetch = globalThis.fetch
    let addRequested = false
    const hash = 'd'.repeat(40)
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/info?')) return new Response(JSON.stringify([{ hash }]), { status: 200 })
      if (url.endsWith('/api/v2/torrents/add')) addRequested = true
      return new Response('', { status: 200 })
    }
    let recorded = false
    try {
      await assert.rejects(
        () =>
          qbAddTorrent(
            {
              ...DEFAULT_CONFIG,
              qbittorrent_url: 'http://qb.example',
              qbittorrent_user: 'admin',
              qbittorrent_pass: 'secret',
            },
            `magnet:?xt=urn:btih:${hash}`,
            '',
            [],
            undefined,
            {
              record: () => {
                recorded = true
              },
              forget: () => undefined,
            },
          ),
        /already exists/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(addRequested, false)
    assert.equal(recorded, false)
  })

  test('removes a newly added torrent when ownership recording fails', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    const hash = 'e'.repeat(40)
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.includes('/api/v2/torrents/info')) return new Response('[]', { status: 200 })
      return new Response('Ok.', { status: 200 })
    }
    try {
      await assert.rejects(
        () =>
          qbAddTorrent(
            {
              ...DEFAULT_CONFIG,
              qbittorrent_url: 'http://qb.example',
              qbittorrent_user: 'admin',
              qbittorrent_pass: 'secret',
            },
            `magnet:?xt=urn:btih:${hash}`,
            '',
            [],
            undefined,
            {
              record: () => {
                throw new Error('disk full')
              },
              forget: () => undefined,
            },
          ),
        /disk full/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.ok(requests.some(url => url.endsWith('/api/v2/torrents/delete')))
  })

  test('forgets accepted torrent ownership only after fresh confirmed cleanup absence', async () => {
    const originalFetch = globalThis.fetch
    const config = {
      ...DEFAULT_CONFIG,
      qbittorrent_url: 'http://cleanup.example',
      qbittorrent_user: 'admin',
      qbittorrent_pass: 'secret',
    }
    const hash = 'f'.repeat(40)
    try {
      for (const read of ['absent', 'present', 'offline', 'malformed'] as const) {
        let owned = false
        let forgotten = 0
        const deletions: URLSearchParams[] = []
        globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.')
          if (url.includes('/api/v2/torrents/info?')) return Response.json([])
          if (url.endsWith('/api/v2/torrents/info')) {
            if (read === 'offline') throw new TypeError('cleanup read offline')
            if (read === 'malformed') return Response.json({ invalid: true })
            return Response.json(read === 'present' ? [{ hash }] : [])
          }
          if (url.endsWith('/api/v2/torrents/delete')) deletions.push(new URLSearchParams(String(init?.body || '')))
          return new Response('Ok.')
        }
        await assert.rejects(
          () =>
            qbAddTorrent(config, `magnet:?xt=urn:btih:${hash}`, '', ['01.mkv'], 0, {
              record: () => {
                owned = true
              },
              forget: () => {
                owned = false
                forgotten += 1
              },
            }),
          read === 'present'
            ? /torrent is still present/
            : read === 'offline'
              ? /cleanup read offline/
              : read === 'malformed'
                ? /invalid torrent list/
                : /metadata fetching failed/i,
        )
        assert.equal(forgotten, read === 'absent' ? 1 : 0)
        assert.equal(owned, read !== 'absent', 'Unproven cleanup must retain accepted ownership')
        assert.equal(deletions.length, 1, 'One caller owns cleanup after metadata failure')
        assert.equal(deletions[0].get('deleteFiles'), 'false')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('retains accepted ownership when confirmed cleanup cannot persist its removal', async () => {
    const originalFetch = globalThis.fetch
    let owned = false
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/api/v2/torrents/info')) return Response.json([])
      return new Response('Ok.')
    }
    try {
      await assert.rejects(
        () =>
          qbAddTorrent(
            {
              ...DEFAULT_CONFIG,
              qbittorrent_url: 'http://persist-cleanup.example',
              qbittorrent_user: 'admin',
              qbittorrent_pass: 'secret',
            },
            `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
            '',
            ['01.mkv'],
            0,
            {
              record: () => {
                owned = true
              },
              forget: () => {
                throw new Error('ledger write failed')
              },
            },
          ),
        /ledger write failed/,
      )
      assert.equal(owned, true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('classifies ambiguous qBittorrent dispatch and body failures without claiming acceptance', async () => {
    const originalFetch = globalThis.fetch
    const hash = 'b'.repeat(40)
    try {
      for (const failure of ['dispatch', 'body', 'unknown-response', 'rejected', 'pre-add'] as const) {
        let addCalled = false
        let recorded = false
        globalThis.fetch = async (input: string | URL | Request) => {
          const url = String(input)
          if (url.endsWith('/api/v2/auth/login')) return new Response('Ok.')
          if (url.includes('/api/v2/torrents/info')) {
            if (failure === 'pre-add') throw new TypeError('existing read offline')
            return Response.json([])
          }
          if (url.endsWith('/api/v2/torrents/add')) {
            addCalled = true
            if (failure === 'dispatch') throw new TypeError('submission connection lost')
            if (failure === 'body')
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error('submission body lost'))
                  },
                }),
              )
            return new Response(failure === 'rejected' ? 'Fails.' : 'Not Ok')
          }
          throw new Error(`Unexpected request: ${url}`)
        }
        await assert.rejects(
          () =>
            qbAddTorrent(
              {
                ...DEFAULT_CONFIG,
                qbittorrent_url: `http://${failure}.qb.example`,
                qbittorrent_user: 'admin',
                qbittorrent_pass: 'secret',
              },
              `magnet:?xt=urn:btih:${hash}`,
              '',
              [],
              undefined,
              {
                record: () => {
                  recorded = true
                },
                forget: () => undefined,
              },
            ),
          (error: unknown) => {
            assert.equal(error instanceof QbittorrentAmbiguousError, failure !== 'rejected' && failure !== 'pre-add')
            return true
          },
        )
        assert.equal(addCalled, failure !== 'pre-add')
        assert.equal(recorded, false, 'Unknown dispatch outcomes must not claim confirmed acceptance')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects misleading qBittorrent login responses', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('Not Ok', { status: 200 })
    try {
      await assert.rejects(
        () =>
          testIntegration(
            {
              ...DEFAULT_CONFIG,
              qbittorrent_url: 'http://qb.example',
              qbittorrent_user: 'admin',
              qbittorrent_pass: 'secret',
            },
            'qbittorrent',
          ),
        /login failed/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not automatically follow credential-bearing redirects', async () => {
    const originalFetch = globalThis.fetch
    let redirect: RequestRedirect | undefined
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect
      return new Response('', { status: 302, headers: { Location: 'https://attacker.example/' } })
    }
    try {
      await assert.rejects(
        () =>
          testIntegration({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr.example', sonarr_key: 'secret' }, 'sonarr'),
        /HTTP 302/,
      )
      assert.equal(redirect, 'manual')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
