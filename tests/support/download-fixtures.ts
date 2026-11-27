// Plan-acceptance flow regressions: modes, dedup, conflicts, intent-before-mutation,
// ambiguous SABnzbd handling, progress phases, and ownership-only cancellation.
// Runs inside the shared temp DATA_DIR (tests/run-tests.mjs) or standalone with DATA_DIR set.
// static imports continue below
import { DEFAULT_CONFIG } from '../../server/config.js'
import { downloadJobs } from '../../server/download-jobs.js'
import { resetOwnedRuntime } from '../../server/download-store.js'
import { resetQbRuntime } from '../../server/qbittorrent.js'
import { Config } from '../../server/types.js'
import type { UsenetRuntimeOptions } from '../../server/usenet-runtime.js'
import { testUsenetRuntime, type TestUsenetRuntime } from './usenet-runtime.js'

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../server/paths.js'

// Fixtures shared by the download review, acceptance and tracking suites: fake clients, providers and results.

export const HASH = 'a'.repeat(40)
export const QB = 'http://qb.test:8080'
export const SAB = 'http://sab.test:8080'

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    qbittorrent_url: QB,
    qbittorrent_user: 'u',
    qbittorrent_pass: 'p',
    animetosho_enabled: true,
    amenzb_enabled: false,
    sabnzbd_url: `${SAB}/`,
    sabnzbd_key: 'sab-key',
    download_mode: 'choose',
    ...overrides,
  }
}

export function releaseFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'best',
    releaseGroup: 'Group',
    tracker: 'Nyaa',
    torrent_available: true,
    info_hashes: [HASH],
    size: 1_000_000,
    part: 'Cour 1',
    torrent_files: [{ hash: HASH, files: [{ name: 'Show - 01.mkv', length: 1_000_000 }] }],
    ...overrides,
  }
}

export function resultFixture(releases: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    key: 'show-1',
    arr: 'Sonarr',
    title: 'Show',
    season: 1,
    status: 'upgrade',
    upgrade_available: true,
    excluded: false,
    precise_part_ownership: false,
    have: [],
    owned_by_part: {},
    releases,
    ...overrides,
  }
}

export interface RouterState {
  calls: string[]
  qbTorrents?: { hash?: string; state?: string; progress?: number; size?: number; dlspeed?: number }[]
  qbAddStatus?: number
  qbAddBody?: string
  sabQueue?: Record<string, unknown>[]
  sabHistory?: Record<string, unknown>[]
  sabAddResult?: () => Response | Promise<Response>
  animetosho?: () => Response
  animetoshoNzb?: () => Response
  qbFiles?: Record<string, unknown>[]
  qbDeleteStatus?: number
  qbFreeBytes?: string
  sabDisk?: { diskspace1?: string; diskspace2?: string }
  sabCategories?: string[]
}

/** A fake AnimeTosho, which a fresh Usenet runtime asks through its own fetch. */
export function fakeAnimeTosho(state: RouterState): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.calls.push(`${init?.method || 'GET'} ${url}`)
    if (url.includes('animetosho.net/json'))
      return (state.animetosho ?? (() => new Response('gone', { status: 404 })))()
    if (url.includes('animetosho.net/nzb/') && state.animetoshoNzb) return state.animetoshoNzb()
    if (url.includes('animetosho.net/nzb/'))
      return new Response(
        '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="test@example.test" date="1700000000" subject="Show - 01.mkv"><groups><group>alt.binaries.anime</group></groups><segments><segment bytes="1000" number="1">show-part-1@example.test</segment></segments></file></nzb>',
        { headers: { 'content-type': 'application/x-nzb' } },
      )
    throw new Error(`unexpected hash indexer request: ${url}`)
  }
}

export type InstalledRouter = (() => void) & { usenet: TestUsenetRuntime }

/**
 * Routes `fetch` to fake download clients, and builds a fresh Usenet runtime whose hash indexer is a fake
 * AnimeTosho unless `usenet` gives it another fetch. Calling the result puts everything back.
 */
export function installRouter(state: RouterState, usenet: UsenetRuntimeOptions = {}): InstalledRouter {
  const original = globalThis.fetch
  resetQbRuntime()
  resetOwnedRuntime()
  purgeTestDataDir()
  const runtime = testUsenetRuntime(undefined, { fetch: fakeAnimeTosho(state), ...usenet })
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.calls.push(`${init?.method || 'GET'} ${url}`)
    const body = typeof init?.body === 'string' || init?.body instanceof URLSearchParams ? String(init.body) : ''
    if (url.startsWith(QB)) {
      if (url.includes('/auth/login')) return new Response('Ok.', { status: 200 })
      if (url.includes('/torrents/info?hashes=')) {
        if (!state.qbAddBody && body) state.qbAddBody = body
        const wanted = decodeURIComponent(url.split('hashes=')[1] || '')
        const matches = (state.qbTorrents || []).filter(
          (torrent: { hash?: string }) => String(torrent.hash || '') === wanted,
        )
        return Response.json(matches)
      }
      if (url.includes('/torrents/add')) {
        state.qbAddBody = body
        if (state.qbAddStatus === 200 || state.qbAddStatus === undefined) {
          const hash = new URLSearchParams(body).get('urls')?.match(/btih:([a-f0-9]{40})/)?.[1]
          if (hash) state.qbTorrents = [...(state.qbTorrents || []), { hash, state: 'downloading' }]
        }
        return new Response(state.qbAddStatus === 200 || state.qbAddStatus === undefined ? 'Ok.' : 'exists', {
          status: state.qbAddStatus ?? 200,
        })
      }
      if (url.includes('/torrents/info')) return Response.json(state.qbTorrents || [])
      if (url.includes('/app/preferences'))
        return Response.json({
          auto_tmm_enabled: true,
          save_path: '/downloads',
          use_category_paths_in_manual_mode: false,
          temp_path_enabled: false,
        })
      if (url.includes('/sync/maindata'))
        return Response.json({ server_state: { free_space_on_disk: 500_000_000_000 } })
      if (url.includes('/torrents/categories'))
        return Response.json({
          'sonarr-anime': { savePath: '/downloads/anime' },
          anime: { savePath: '/downloads/anime' },
        })
      if (url.includes('getFreeSpaceAtPath')) return new Response(state.qbFreeBytes ?? '500000000000')
      if (url.includes('/torrents/files'))
        return Response.json(state.qbFiles || [{ name: 'Show - 01.mkv', index: 0, size: 1_000_000 }])
      if (url.includes('/torrents/delete')) {
        if (!state.qbDeleteStatus || state.qbDeleteStatus === 200) {
          const hash = new URLSearchParams(body).get('hashes')
          state.qbTorrents = (state.qbTorrents || []).filter(torrent => torrent.hash !== hash)
        }
        return new Response('Ok.', { status: state.qbDeleteStatus ?? 200 })
      }
      if (/\/torrents\/(stop|start|pause|resume|filePrio)/.test(url)) return new Response('Ok.', { status: 200 })
    }
    if (url.startsWith(SAB)) {
      const query = new URL(url).searchParams
      const mode = query.get('mode')
      const name = query.get('name')
      if (init?.method === 'POST')
        return (state.sabAddResult ?? (() => Response.json({ status: true, nzo_ids: ['nzo1'] })))()
      if (mode === 'get_cats')
        return Response.json({ categories: state.sabCategories ?? ['*', 'sonarr-anime', 'radarr-anime'] })
      if (mode === 'queue') {
        if (name === 'pause' || name === 'resume' || name === 'delete') return Response.json({ status: true })
        const ids = (new URL(url).searchParams.get('nzo_ids') || '').split(',').filter(Boolean)
        const slots = (state.sabQueue || []).filter(
          (job: Record<string, unknown>) => !ids.length || ids.includes(String(job.nzo_id)),
        )
        return Response.json({
          queue: { paused_all: false, ...(state.sabDisk || { diskspace1: '931.5', diskspace2: '931.5' }), slots },
        })
      }
      if (mode === 'history') {
        if (name === 'delete') return Response.json({ status: true })
        const ids = (new URL(url).searchParams.get('nzo_ids') || '').split(',').filter(Boolean)
        const slots = (state.sabHistory || []).filter(
          (job: Record<string, unknown>) => !ids.length || ids.includes(String(job.nzo_id)),
        )
        return Response.json({ history: { slots } })
      }
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const restore = () => {
    globalThis.fetch = original
    runtime.close()
    resetQbRuntime()
    resetOwnedRuntime()
    purgeTestDataDir()
  }
  return Object.assign(restore, { usenet: runtime })
}

export function purgeTestDataDir(): void {
  for (const file of ['owned_downloads.json', 'download_jobs.json']) {
    const path = join(DATA_DIR, file)
    if (existsSync(path)) rmSync(path)
  }
  downloadJobs.restore()
}

export const animetoshoMatch = (hash = HASH) =>
  Response.json({
    id: 1234,
    info_hash: hash.toUpperCase(),
    nzb_url: `https://feed.animetosho.net/nzb/1234`,
    title: 'Show S01E01',
    torrent_name: 'Show 1080p',
    status: 'complete',
    deleted: false,
    num_files: 2,
    total_size: 500_000_000,
    files: [
      { name: 'Show - 01.mkv', size: 400_000_000, processed: true },
      { name: 'Show - 02.nfo', size: 100, processed: true },
    ],
  })
