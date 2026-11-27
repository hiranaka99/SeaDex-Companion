import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { applyUserRulesToResults } from '../server/user-rules.js'
import { arrApiUrl, arrBaseUrl } from '../server/arr-urls.js'
import { decryptSecretValues, encryptSecretValues } from '../server/config-secrets.js'
import { DEFAULT_CONFIG, publicConfig } from '../server/config.js'
import { normalizeScanSchedule } from '../server/config-schedule.js'
import { arrItemUrl, localItems } from '../server/library.js'
import { autoNotifyNew, sendToDiscord, type NotifiedResult } from '../server/notifications.js'
import { resultItem } from './support/results.js'
import { autocheckState, getState, setState } from '../server/scan-state.js'
import { buildScanHistoryEntry } from '../server/history.js'
import { compareScans } from '../server/scan-comparison.js'
import { clearScannedData, scannedDataInfo } from '../server/results.js'
import { DATA_DIR } from '../server/paths.js'
import { loadStringSet } from '../server/persistence.js'
import { seadexBest } from '../server/catalog.js'
import { resetRuntimeForTests } from './support/runtime.js'
import { createScanService } from '../server/scan.js'
import {
  nextScheduledTime,
  processAutocheck,
  processWebhookScans,
  queueWebhookScan,
  refreshAutocheckSchedule,
  resetWebhookScanState,
  webhookScanState,
} from '../server/scheduler.js'
import { wantedParts, type RecommendationSeason } from '../shared/download-plan.js'
import { JsonObject, ReleaseCandidate, ScanTrigger } from '../server/types.js'
import type { Release, ResultItem } from '../shared/contracts.js'

const bestRelease: Release = {
  kind: 'best',
  releaseGroup: 'Best',
  tracker: 'Nyaa',
  quality: '',
  tags: [],
  size: 0,
  torrent_available: true,
  info_hashes: [],
}

beforeEach(() => {
  resetRuntimeForTests()
  resetWebhookScanState()
  if (existsSync(join(DATA_DIR, 'scan_schedule_state.json'))) rmSync(join(DATA_DIR, 'scan_schedule_state.json'))
  if (existsSync(join(DATA_DIR, 'scan_schedule_state.json.tmp'))) rmSync(join(DATA_DIR, 'scan_schedule_state.json.tmp'))
})

describe('configuration secret security', () => {
  test('encrypts and authenticates configuration secrets', () => {
    const key = randomBytes(32)
    const secrets = {
      sonarr_key: 'sonarr-secret',
      radarr_key: 'radarr-secret',
      qbittorrent_pass: 'qb-secret',
      webhook: 'https://discord.example/secret',
    }
    const encrypted = encryptSecretValues(secrets, key)

    assert.equal(encrypted.algorithm, 'aes-256-gcm')
    assert.equal(JSON.stringify(encrypted).includes('sonarr-secret'), false)
    assert.deepEqual(decryptSecretValues(encrypted, key), secrets)

    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }
    assert.throws(() => decryptSecretValues(tampered, key), /Could not decrypt secrets/)
  })

  test('redacts secrets from the public configuration response', () => {
    const response = publicConfig({
      ...DEFAULT_CONFIG,
      sonarr_key: 'sonarr-secret',
      qbittorrent_pass: 'qb-secret',
    })

    assert.equal(response.sonarr_key, '')
    assert.equal(response.sonarr_key_configured, true)
    assert.equal(response.radarr_key_configured, false)
    assert.equal(response.qbittorrent_pass, '')
    assert.equal(response.qbittorrent_pass_configured, true)
  })
})
describe('persisted collection validation', () => {
  test('treats valid JSON with the wrong shape as an empty string set', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seadex-string-set-'))
    const file = join(directory, 'ledger.json')
    try {
      writeFileSync(file, '{}', 'utf8')
      assert.deepEqual([...loadStringSet(file, 'Invalid ledger')], [])
      writeFileSync(file, JSON.stringify(['valid', 3, '', 'also-valid']), 'utf8')
      assert.deepEqual([...loadStringSet(file, 'Invalid ledger')], ['valid', 'also-valid'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('scanned data maintenance', () => {
  test('replaces broken cache data and clears saved and in-memory results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seadex-clear-data-'))
    const cacheFile = join(directory, 'anilist_cache.json')
    const resultsFile = join(directory, 'last_results.json')
    try {
      writeFileSync(cacheFile, '{broken json', 'utf8')
      writeFileSync(
        resultsFile,
        JSON.stringify({ results: [{ key: 'one' }, { key: 'two' }], last_run: 'yesterday' }),
        'utf8',
      )
      setState({
        results: [{ key: 'runtime' }],
        last_run: 'today',
        progress: 1,
        total: 1,
        message: 'Done',
        error: 'old error',
      })

      assert.deepEqual(scannedDataInfo(cacheFile, resultsFile), {
        cache_entries: 0,
        results: 2,
        last_run: 'yesterday',
        cache_valid: false,
        results_valid: true,
      })

      const cleared = clearScannedData(cacheFile, resultsFile)

      assert.deepEqual(cleared, { cacheEntries: 0, results: 2 })
      assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')), {})
      assert.deepEqual(JSON.parse(readFileSync(resultsFile, 'utf8')), { results: [], last_run: null })
      assert.deepEqual(scannedDataInfo(cacheFile, resultsFile), {
        cache_entries: 0,
        results: 0,
        last_run: null,
        cache_valid: true,
        results_valid: true,
      })
      assert.deepEqual(getState().results, [])
      assert.equal(getState().last_run, null)
      assert.equal(getState().error, null)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('manual rules and scan history', () => {
  test('applies season and cour exclusions to upgrade parts', () => {
    const results = [
      {
        key: 'series:1',
        library_key: 'Sonarr:item10',
        season: 1,
        status: 'upgrade',
        arr: 'Sonarr',
        releases: [
          {
            kind: 'best',
            part: 'Cour 1',
            torrent_available: true,
            releaseGroup: 'Best',
            info_hashes: ['a'.repeat(40)],
          },
          {
            kind: 'best',
            part: 'Cour 2',
            torrent_available: true,
            releaseGroup: 'Best',
            info_hashes: ['b'.repeat(40)],
          },
        ],
      },
    ]
    const courRules = { mappings: {}, exclusions: ['Sonarr:item10:1:Cour 1'] }
    const decorated = applyUserRulesToResults(results, courRules)
    assert.deepEqual(decorated[0].excluded_parts, ['Cour 1'])
    assert.deepEqual(
      wantedParts(decorated[0] as unknown as RecommendationSeason).map(part => part.part),
      ['Cour 2'],
    )

    const seasonRules = { mappings: {}, exclusions: ['Sonarr:item10:1:*'] }
    assert.deepEqual(
      wantedParts(applyUserRulesToResults(results, seasonRules)[0] as unknown as RecommendationSeason),
      [],
    )
  })

  test('summarizes new upgrades and resolved upgrades between scans', () => {
    const previous = [
      resultItem({
        library_key: 'Sonarr:item1',
        season: 1,
        title: 'Resolved',
        arr: 'Sonarr',
        status: 'upgrade',
        best_group: 'A',
      }),
      resultItem({
        library_key: 'Sonarr:item2',
        season: 1,
        title: 'Upgrade',
        arr: 'Sonarr',
        status: 'best',
        best_group: 'B',
      }),
    ]
    const current = [
      resultItem({
        library_key: 'Sonarr:item1',
        season: 1,
        title: 'Resolved',
        arr: 'Sonarr',
        status: 'best',
        best_group: 'A',
      }),
      resultItem({
        library_key: 'Sonarr:item2',
        season: 1,
        title: 'Upgrade',
        arr: 'Sonarr',
        status: 'upgrade',
        best_group: 'C',
      }),
    ]
    const entry = buildScanHistoryEntry(compareScans(previous, current), 'today')
    assert.deepEqual(
      entry.changes.map(change => [change.title, change.type]),
      [
        ['Resolved', 'resolved'],
        ['Upgrade', 'upgrade'],
      ],
    )
    assert.deepEqual(entry.counts, { best: 1, upgrade: 1 })
  })

  test('records trigger, duration, scope size, and partial source failures', () => {
    const entry = buildScanHistoryEntry(
      compareScans([], [resultItem({ key: 'new', title: 'New', arr: 'Sonarr', status: 'missing' })]),
      'today',
      'scheduled',
      {
        durationSeconds: 4.2,
        scannedTitles: 1,
        sourceErrors: { Radarr: 'HTTP 503' },
      },
    )
    assert.equal(entry.trigger, 'scheduled')
    assert.equal(entry.duration_seconds, 4.2)
    assert.equal(entry.scanned_titles, 1)
    assert.equal(entry.outcome, 'partial')
    assert.deepEqual(entry.source_errors, { Radarr: 'HTTP 503' })
  })

  test('passes a saved manual AniList ID into title resolution', async () => {
    let receivedOverride: number | undefined
    await createScanService({
      seadexBest: async () => new Map(),
      localItems: async () => [
        { arr: 'Sonarr', id: 10, title: 'Ambiguous', seasons: { 1: { groups: ['Local'], size: 100 } } },
      ],
      anilistChain: async (_title: string, _cache: JsonObject, _dependencies: unknown, overrideId?: number) => {
        receivedOverride = overrideId
        return [{ season: 1, id: 999, ids: [999], parts: [{ id: 999, episodeCount: 1 }] }]
      },
      loadCache: () => ({}),
      loadUserRules: () => ({ mappings: { 'Sonarr:item10': 999 }, exclusions: [] }),
      recordReleaseChanges: () => {},
      saveLastResults: () => undefined,
      autoNotifyNew: async () => 0,
    }).run({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr/api/v3' })
    assert.equal(receivedOverride, 999)
    assert.equal(getState().results[0].library_key, 'Sonarr:item10')
    assert.equal(getState().results[0].mapping_override, true)
  })
})

describe('notifications and scheduling', () => {
  test('does not count Discord HTTP errors as delivered', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('rejected', { status: 500 })
    try {
      assert.equal(await sendToDiscord('https://discord.example/webhook', [resultItem({ title: 'Example' })]), 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('marks only successfully delivered notifications', async () => {
    const results = ['sent', 'failed'].map(key => resultItem({ key, status: 'upgrade', releases: [bestRelease] }))
    let saved = new Set<string>()
    const sent = await autoNotifyNew(
      { ...DEFAULT_CONFIG, webhook: 'https://discord.example/webhook' },
      results,
      compareScans([], results),
      {
        load: () => new Set(),
        save: keys => {
          saved = new Set(keys)
        },
        send: async (_webhook, results, onSent) => {
          onSent?.(results[0])
          return 1
        },
      },
    )
    assert.equal(sent, 1)
    assert.deepEqual([...saved], ['sent'])
  })

  test('migrates legacy automatic scan intervals without changing behavior', () => {
    assert.deepEqual(normalizeScanSchedule(undefined, 90), {
      enabled: true,
      mode: 'interval',
      interval_minutes: 90,
      times: ['03:00'],
      weekdays: [0],
      timezone: 'UTC',
      missed_run: 'run_once',
    })
    assert.equal(normalizeScanSchedule(undefined, 0).enabled, false)
    assert.equal(normalizeScanSchedule(undefined).enabled, true)
  })

  test('rejects invalid enabled scan schedules', () => {
    assert.throws(() => normalizeScanSchedule({ ...DEFAULT_CONFIG.scan_schedule, interval_minutes: 1 }), /between 5/)
    assert.throws(
      () => normalizeScanSchedule({ ...DEFAULT_CONFIG.scan_schedule, mode: 'daily', times: ['03:00', '03:00'] }),
      /duplicates/,
    )
    assert.throws(
      () => normalizeScanSchedule({ ...DEFAULT_CONFIG.scan_schedule, mode: 'weekly', weekdays: [] }),
      /at least one day/,
    )
    assert.throws(
      () => normalizeScanSchedule({ ...DEFAULT_CONFIG.scan_schedule, mode: 'daily', timezone: 'Not/AZone' }),
      /IANA timezone/,
    )
  })

  test('calculates interval, daily, and weekly schedules in their configured timezone', () => {
    const interval = { ...DEFAULT_CONFIG.scan_schedule, interval_minutes: 30 }
    assert.equal(nextScheduledTime(interval, 1_000), 2_800)

    const daily = {
      ...DEFAULT_CONFIG.scan_schedule,
      mode: 'daily' as const,
      times: ['03:00'],
      timezone: 'America/New_York',
    }
    assert.equal(
      nextScheduledTime(daily, Date.parse('2026-07-01T06:59:00Z') / 1000),
      Date.parse('2026-07-01T07:00:00Z') / 1000,
    )

    const weekly = { ...daily, mode: 'weekly' as const, weekdays: [1] }
    assert.equal(
      nextScheduledTime(weekly, Date.parse('2026-07-01T07:00:00Z') / 1000),
      Date.parse('2026-07-06T07:00:00Z') / 1000,
    )
  })

  test('queues one due automatic scan while another scan is running', async () => {
    const config = { ...DEFAULT_CONFIG, scan_schedule: { ...DEFAULT_CONFIG.scan_schedule, interval_minutes: 30 } }
    refreshAutocheckSchedule(config, 1_000)
    setState({ running: true })
    let scans = 0
    await processAutocheck(config, 2_800, async () => {
      scans += 1
    })
    await processAutocheck(config, 2_900, async () => {
      scans += 1
    })
    assert.equal(scans, 0)
    assert.equal(autocheckState.pending, true)
    setState({ running: false })
    await processAutocheck(config, 3_000, async () => {
      scans += 1
    })
    assert.equal(scans, 1)
    assert.equal(autocheckState.pending, false)
  })

  test('debounces only new Sonarr and Radarr entries and combines their trigger', async () => {
    const config = { ...DEFAULT_CONFIG }
    assert.deepEqual(queueWebhookScan('sonarr', 'Download', 10, 1_000), { accepted: false, dueAt: null })
    assert.deepEqual(queueWebhookScan('sonarr', 'SeriesAdd', 10, 1_000), { accepted: true, dueAt: 1_010 })
    assert.deepEqual(queueWebhookScan('radarr', 'MovieAdded', 20, 1_003), { accepted: true, dueAt: 1_013 })
    const calls: Array<{ trigger: ScanTrigger; sonarrIds?: number[]; radarrIds?: number[] }> = []
    await processWebhookScans(config, 1_012, async (_config, trigger, scope) => {
      calls.push({ trigger, ...scope })
    })
    assert.equal(calls.length, 0)
    await processWebhookScans(config, 1_013, async (_config, trigger, scope) => {
      calls.push({ trigger, ...scope })
    })
    assert.deepEqual(calls, [{ trigger: 'sonarr+radarr', sonarrIds: [10], radarrIds: [20] }])
    assert.equal(webhookScanState.dueAt, null)
  })

  test('starts a queued webhook scan after the fixed debounce', async () => {
    const config = { ...DEFAULT_CONFIG }
    queueWebhookScan('sonarr', 'SeriesAdd', 10, 2_000)
    const triggers: ScanTrigger[] = []
    await processWebhookScans(config, 2_009, async (_config, trigger) => {
      triggers.push(trigger)
    })
    assert.equal(triggers.length, 0)
    await processWebhookScans(config, 2_010, async (_config, trigger) => {
      triggers.push(trigger)
    })
    assert.deepEqual(triggers, ['sonarr'])
  })

  test('allows an upgrade notification after the same result was resolved', async () => {
    let saved = new Set<string>()
    let deliveries = 0
    const dependencies = {
      load: () => new Set(saved),
      save: (keys: Set<string>) => {
        saved = new Set(keys)
      },
      send: async (_webhook: string, results: NotifiedResult[], onSent?: (result: NotifiedResult) => void) => {
        deliveries += results.length
        for (const result of results) onSent?.(result)
        return results.length
      },
    }
    const config = { ...DEFAULT_CONFIG, notify_enabled: true, webhook: 'https://discord.example/webhook' }
    const notify = (results: ResultItem[]) => autoNotifyNew(config, results, compareScans([], results), dependencies)
    await notify([resultItem({ key: 'same', status: 'upgrade', releases: [bestRelease] })])
    await notify([resultItem({ key: 'same', status: 'best' })])
    await notify([resultItem({ key: 'same', status: 'upgrade', releases: [bestRelease] })])
    assert.equal(deliveries, 2)
  })
})

describe('Sonarr and Radarr URL normalization', () => {
  test('adds the API path to plain base URLs', () => {
    assert.equal(arrApiUrl('https://sonarr.example.com/'), 'https://sonarr.example.com/api/v3')
    assert.equal(arrApiUrl('https://host.example/radarr'), 'https://host.example/radarr/api/v3')
  })

  test('accepts and removes legacy API paths without duplicating them', () => {
    assert.equal(arrBaseUrl('https://sonarr.example.com/api/v3/'), 'https://sonarr.example.com')
    assert.equal(arrApiUrl('https://sonarr.example.com/api/v3'), 'https://sonarr.example.com/api/v3')
    assert.equal(
      arrItemUrl({ sonarr_url: 'https://host.example/sonarr/api/v3' }, { arr: 'Sonarr', slug: 'example' }),
      'https://host.example/sonarr/series/example',
    )
  })

  test('keeps TVDB episode numbers even when an episode has no file', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api')) return Response.json({ current: 'v3', deprecated: [] })
      let data: JsonObject[] = []
      if (url.endsWith('/series'))
        data = [
          {
            id: 10,
            title: 'Example',
            titleSlug: 'example',
            seasons: [{ seasonNumber: 1, statistics: { releaseGroups: ['IK'], sizeOnDisk: 100 } }],
          },
        ]
      else if (url.includes('/episode?'))
        data = [
          { seasonNumber: 1, episodeNumber: 2, episodeFileId: 0, airDate: '2024-01-12T09:00:00Z' },
          { seasonNumber: 1, episodeNumber: 1, episodeFileId: 20, airDate: '2024-01-05T09:00:00Z' },
          { seasonNumber: 0, episodeNumber: 1, episodeFileId: 0 },
        ]
      else if (url.includes('/episodefile?')) data = [{ id: 20, releaseGroup: 'IK', size: 100 }]
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const items = await localItems({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr', sonarr_key: 'key' })
      assert.deepEqual(items[0].seasons[1].episode_numbers, [1, 2])
      assert.equal(items[0].seasons[1].episode_count, 2)
      assert.deepEqual(items[0].seasons[1].groups_by_episode, { IK: [1] })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('includes newly added Sonarr series and Radarr movies before files exist', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api')) return Response.json({ current: 'v3', deprecated: [] })
      let data: JsonObject[] = []
      if (url.includes('sonarr') && url.endsWith('/series'))
        data = [
          {
            id: 11,
            title: 'New Series',
            titleSlug: 'new-series',
            seasons: [
              { seasonNumber: 0 },
              { seasonNumber: 1, statistics: { episodeCount: 12, releaseGroups: [], sizeOnDisk: 0 } },
            ],
          },
        ]
      else if (url.includes('sonarr') && url.includes('/episode?'))
        data = Array.from({ length: 12 }, (_, index) => ({
          seasonNumber: 1,
          episodeNumber: index + 1,
          episodeFileId: 0,
          airDate: '2024-01-05T09:00:00Z',
        }))
      else if (url.includes('radarr') && url.endsWith('/movie'))
        data = [
          {
            id: 12,
            title: 'New Movie',
            titleSlug: 'new-movie',
            inCinemas: '2024-03-01T00:00:00Z',
            statistics: { releaseGroups: [], sizeOnDisk: 0 },
          },
        ]
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    try {
      const items = await localItems({
        ...DEFAULT_CONFIG,
        sonarr_url: 'http://sonarr',
        sonarr_key: 'key',
        radarr_url: 'http://radarr',
        radarr_key: 'key',
      })
      assert.equal(items.length, 2)
      assert.deepEqual(items[0].seasons[1], {
        groups: [],
        size: 0,
        episode_numbers: Array.from({ length: 12 }, (_, index) => index + 1),
        episode_count: 12,
        missing_episode_count: 12,
        groups_by_episode: {},
        sizes_by_episode: {},
      })
      assert.deepEqual(items[1].seasons[0], { groups: [], size: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('hides unreleased Sonarr seasons and Radarr movies', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api')) return Response.json({ current: 'v3', deprecated: [] })
      let data: JsonObject[] = []
      if (url.includes('sonarr') && url.endsWith('/series'))
        data = [
          {
            id: 20,
            title: 'Future Show',
            titleSlug: 'future-show',
            seasons: [
              { seasonNumber: 1, statistics: { episodeCount: 2, releaseGroups: [], sizeOnDisk: 0 } },
              { seasonNumber: 2, statistics: { episodeCount: 12, releaseGroups: [], sizeOnDisk: 0 } },
              { seasonNumber: 3, statistics: { episodeCount: 8, releaseGroups: [], sizeOnDisk: 0 } },
              { seasonNumber: 4, statistics: { episodeCount: 1, releaseGroups: ['IK'], sizeOnDisk: 5 } },
            ],
          },
        ]
      else if (url.includes('sonarr') && url.includes('/episode?'))
        data = [
          { seasonNumber: 1, episodeNumber: 1, episodeFileId: 0, airDate: '2024-01-05T09:00:00Z' },
          { seasonNumber: 1, episodeNumber: 2, episodeFileId: 0, airDate: '2024-01-12T09:00:00Z' },
          { seasonNumber: 2, episodeNumber: 1, episodeFileId: 0, airDate: '2030-01-05T09:00:00Z' },
          { seasonNumber: 2, episodeNumber: 2, episodeFileId: 0, airDate: '2030-01-12T09:00:00Z' },
          { seasonNumber: 3, episodeNumber: 1, episodeFileId: 0 },
          { seasonNumber: 4, episodeNumber: 1, episodeFileId: 30 },
        ]
      else if (url.includes('sonarr') && url.includes('/episodefile?')) data = [{ id: 30, releaseGroup: 'IK', size: 5 }]
      else if (url.includes('radarr') && url.endsWith('/movie'))
        data = [
          {
            id: 21,
            title: 'Old Movie',
            titleSlug: 'old-movie',
            inCinemas: '2024-03-01T00:00:00Z',
            statistics: { releaseGroups: [], sizeOnDisk: 0 },
          },
          {
            id: 22,
            title: 'Upcoming Movie',
            titleSlug: 'upcoming-movie',
            inCinemas: '2030-03-01T00:00:00Z',
            statistics: { releaseGroups: [], sizeOnDisk: 0 },
          },
          {
            id: 23,
            title: 'Unknown Movie',
            titleSlug: 'unknown-movie',
            statistics: { releaseGroups: [], sizeOnDisk: 0 },
          },
        ]
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const items = await localItems({
        ...DEFAULT_CONFIG,
        sonarr_url: 'http://sonarr',
        sonarr_key: 'key',
        radarr_url: 'http://radarr',
        radarr_key: 'key',
      })
      assert.equal(items.length, 2)
      assert.deepEqual(Object.keys(items[0].seasons), ['1', '4'])
      assert.equal(items[1].id, 21)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('fails the scan input when a configured library API is unavailable', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    try {
      await assert.rejects(
        () => localItems({ ...DEFAULT_CONFIG, sonarr_url: 'http://sonarr', sonarr_key: 'key' }),
        /HTTP 503/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('SeaDex catalog aggregation', () => {
  test('keeps distinct torrents from the same group and tracker separate', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              alID: 10,
              expand: {
                trs: [
                  {
                    releaseGroup: 'Group',
                    tracker: 'Nyaa',
                    isBest: true,
                    infoHash: 'a'.repeat(40),
                    files: [{ name: 'Show.S01E01.mkv', length: 100 }],
                  },
                  {
                    releaseGroup: 'Group',
                    tracker: 'Nyaa',
                    isBest: true,
                    infoHash: 'b'.repeat(40),
                    files: [{ name: 'Show.S01E01.v2.mkv', length: 110 }],
                  },
                ],
              },
            },
          ],
          totalPages: 1,
        }),
        { status: 200 },
      )
    try {
      const catalog = await seadexBest()
      const candidates = catalog.get(10)?.seasons[1].candidates as ReleaseCandidate[]
      assert.equal(candidates.length, 2)
      assert.deepEqual(
        candidates.map(candidate => candidate.info_hashes),
        [['a'.repeat(40)], ['b'.repeat(40)]],
      )
      assert.deepEqual(
        candidates.map(candidate => candidate.size),
        [100, 110],
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('merges complementary per-episode torrents from the same group into one release', async () => {
    const originalFetch = globalThis.fetch
    const episode = (number: number, hashCharacter: string) => ({
      releaseGroup: 'Unfucked',
      tracker: 'Nyaa',
      isBest: false,
      infoHash: hashCharacter.repeat(40),
      files: [{ name: `Show.S01E${String(number).padStart(2, '0')}.mkv`, length: 100 }],
    })
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          items: [{ alID: 10, expand: { trs: [episode(1, 'a'), episode(2, 'b'), episode(3, 'c')] } }],
          totalPages: 1,
        }),
        { status: 200 },
      )
    try {
      const catalog = await seadexBest()
      const candidates = catalog.get(10)?.seasons[1].candidates as ReleaseCandidate[]
      assert.equal(candidates.length, 1)
      assert.deepEqual(candidates[0].info_hashes, ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)])
      assert.equal(candidates[0].size, 300)
      assert.equal(candidates[0].file_count, 3)
      assert.deepEqual(
        candidates[0].torrent_files?.map(torrent => [torrent.hash, torrent.files[0].length]),
        [
          ['a'.repeat(40), 100],
          ['b'.repeat(40), 100],
          ['c'.repeat(40), 100],
        ],
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps re-uploads of already covered episodes separate from complementary batches', async () => {
    const originalFetch = globalThis.fetch
    const batch = (first: number, last: number, hashCharacter: string) => ({
      releaseGroup: 'Batched',
      tracker: 'Nyaa',
      isBest: false,
      infoHash: hashCharacter.repeat(40),
      files: Array.from({ length: last - first + 1 }, (_, index) => ({
        name: `Show.S01E${String(first + index).padStart(2, '0')}.mkv`,
        length: 100,
      })),
    })
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          items: [{ alID: 10, expand: { trs: [batch(1, 2, 'a'), batch(3, 4, 'b'), batch(1, 4, 'c')] } }],
          totalPages: 1,
        }),
        { status: 200 },
      )
    try {
      const catalog = await seadexBest()
      const candidates = catalog.get(10)?.seasons[1].candidates as ReleaseCandidate[]
      assert.equal(candidates.length, 2)
      assert.deepEqual(candidates[0].info_hashes, ['a'.repeat(40), 'b'.repeat(40)])
      assert.equal(candidates[0].size, 400)
      assert.deepEqual(candidates[1].info_hashes, ['c'.repeat(40)])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
