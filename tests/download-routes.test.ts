import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProwlarrCoverage, Release } from '../shared/contracts.js'
import type { DownloadMode } from '../shared/download-contracts.js'
import type { UsenetAvailabilityResult, UsenetUnitState } from '../shared/usenet-contracts.js'
import { DEFAULT_CONFIG, publicConfig } from '../server/config.js'
import { downloadRoutes } from '../frontend/src/download-routes.js'
import type { Config } from '../frontend/src/types.js'

const SAB = { sabnzbd_url: 'http://sab.test', sabnzbd_key: 'sab-key' }

/** The configuration the interface reads, with what Prowlarr's indexers cover once it answered. */
const config = (
  mode: DownloadMode,
  changes: Partial<typeof DEFAULT_CONFIG> = {},
  coverage?: ProwlarrCoverage,
): Config => ({
  ...publicConfig({ ...DEFAULT_CONFIG, ...SAB, download_mode: mode, ...changes }),
  ...(coverage ? { prowlarr_coverage: coverage } : {}),
})

const publicRelease: Release = {
  kind: 'best',
  releaseGroup: 'Group A',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 1000,
  info_hashes: ['a'.repeat(40)],
  torrent_available: true,
}
const privateRelease: Release = {
  ...publicRelease,
  tracker: 'AB',
  info_hashes: [],
  torrent_available: false,
  private_sources: [{ id: 'files:' + 'b'.repeat(40), files: [{ name: '01.mkv', length: 500 }] }],
}

const row = (
  aggregate: UsenetUnitState,
  changes: Partial<UsenetAvailabilityResult> = {},
): UsenetAvailabilityResult => ({
  key: 'show',
  release: 0,
  identity: 'identity:show',
  hashes: [{ hash: 'a'.repeat(40), state: aggregate, provider: 'animetosho' }],
  aggregate,
  checked_at: '',
  stale: false,
  refreshing: false,
  ...changes,
})

test('the download mode decides the protocol whatever was chosen', () => {
  const available = row('available')
  assert.equal(downloadRoutes(config('torrent_only')).release(privateRelease, available, 'usenet').protocol, 'torrent')
  assert.equal(downloadRoutes(config('usenet_only')).release(publicRelease, undefined, 'torrent').protocol, 'usenet')
  assert.equal(downloadRoutes(config('choose')).release(publicRelease, available, 'usenet').protocol, 'usenet')
  assert.equal(downloadRoutes(config('choose')).release(privateRelease, available, 'torrent').protocol, 'torrent')
})

const PROWLARR = { prowlarr_enabled: true, prowlarr_url: 'http://prowlarr.test', prowlarr_key: 'prowlarr-key' }

test('a private-tracker torrent is sendable only through a Prowlarr indexer for its tracker', () => {
  const torrent = (settings: Config) => downloadRoutes(settings).release(privateRelease, undefined).torrent
  assert.deepEqual(torrent(config('choose')), { sendable: false, viaProwlarr: false }, 'no Prowlarr')
  assert.deepEqual(torrent(config('choose', PROWLARR)), { sendable: false, viaProwlarr: false }, 'coverage unknown')
  assert.deepEqual(torrent(config('choose', PROWLARR, { trackers: ['Nyaa'], usenet: true })), {
    sendable: false,
    viaProwlarr: false,
  })
  assert.deepEqual(torrent(config('choose', PROWLARR, { trackers: ['ab'], usenet: false })), {
    sendable: true,
    viaProwlarr: true,
  })
  assert.deepEqual(
    torrent(config('choose', { ...PROWLARR, tracker_mode: 'public' }, { trackers: ['ab'], usenet: false })),
    { sendable: false, viaProwlarr: false },
    'public-tracker mode never fetches a private torrent',
  )
  assert.deepEqual(
    torrent(config('usenet_only', PROWLARR, { trackers: ['ab'], usenet: false })),
    { sendable: false, viaProwlarr: true },
    'Usenet-only mode sends no torrent',
  )
  assert.deepEqual(downloadRoutes(config('torrent_only')).release(publicRelease, undefined).torrent, {
    sendable: true,
    viaProwlarr: false,
  })
})

const AVAILABILITY = {
  none: undefined,
  available: row('available', { search: 'prowlarr' }),
  /** Prowlarr can still search for a copy, or check the results it found. */
  pending: row('not_checked', { search: 'prowlarr' }),
  unchecked: row('unverified', { search: 'prowlarr' }),
  fallback: row('no_match', { fallback: 'prowlarr' }),
  ruledOut: row('no_match', { search: 'prowlarr' }),
}
const COVERAGE = {
  unknown: undefined,
  usenetOnly: { trackers: [], usenet: true },
  tracker: { trackers: ['AB'], usenet: true },
}

test('the default protocol follows download mode, Prowlarr coverage and Usenet availability', () => {
  // [mode, coverage, availability, default protocol, torrent sendable, Usenet sendable, Usenet pending]
  const cases: [DownloadMode, keyof typeof COVERAGE, keyof typeof AVAILABILITY, string, boolean, boolean, boolean][] = [
    ['choose', 'unknown', 'none', 'torrent', false, false, false],
    ['choose', 'unknown', 'available', 'usenet', false, true, false],
    ['choose', 'unknown', 'pending', 'usenet', false, false, true],
    ['choose', 'unknown', 'unchecked', 'usenet', false, false, true],
    ['choose', 'unknown', 'fallback', 'usenet', false, false, true],
    ['choose', 'unknown', 'ruledOut', 'torrent', false, false, false],
    ['choose', 'usenetOnly', 'pending', 'usenet', false, false, true],
    ['choose', 'tracker', 'none', 'torrent', true, false, false],
    ['choose', 'tracker', 'available', 'torrent', true, true, false],
    ['choose', 'tracker', 'pending', 'torrent', true, false, true],
    ['torrent_only', 'unknown', 'available', 'torrent', false, false, false],
    ['torrent_only', 'tracker', 'pending', 'torrent', true, false, false],
    ['usenet_only', 'tracker', 'none', 'usenet', false, false, false],
    ['usenet_only', 'unknown', 'available', 'usenet', false, true, false],
    ['usenet_only', 'unknown', 'pending', 'usenet', false, false, true],
  ]
  for (const [mode, coverage, availability, protocol, torrent, usenet, pending] of cases) {
    const route = downloadRoutes(config(mode, PROWLARR, COVERAGE[coverage])).release(
      privateRelease,
      AVAILABILITY[availability],
    )
    const name = `${mode} · coverage ${coverage} · ${availability}`
    assert.equal(route.protocol, protocol, name)
    assert.equal(route.torrent.sendable, torrent, name)
    assert.deepEqual(route.usenet, { sendable: usenet, pending }, name)
  }
})

test('Usenet is offered only with SABnzbd set up', () => {
  const routes = downloadRoutes(config('choose', { sabnzbd_url: '' }))
  const route = routes.release(privateRelease, AVAILABILITY.available)
  assert.deepEqual(route.usenet, { sendable: false, pending: false })
  assert.equal(route.protocol, 'torrent')
  assert.equal(routes.usenetAllowed, true, 'the mode still shows what Usenet holds')
  assert.equal(routes.usenetReady, false)
  assert.equal(downloadRoutes(config('choose')).usenetReady, true)
  assert.equal(downloadRoutes(config('torrent_only')).usenetAllowed, false)
  assert.equal(downloadRoutes(null).usenetAllowed, false, 'nothing is looked up before the configuration loads')
})

test('a release no route can send says why', () => {
  const blocked = (settings: Config, availability: UsenetAvailabilityResult | undefined, release = privateRelease) =>
    downloadRoutes(settings).release(release, availability).blocked
  assert.equal(blocked(config('choose'), AVAILABILITY.available), null)
  assert.equal(blocked(config('choose'), AVAILABILITY.pending), null, 'a pending check is a way forward')
  assert.equal(blocked(config('torrent_only'), undefined, publicRelease), null)
  assert.equal(blocked(config('torrent_only'), undefined), 'No public magnet: AB is a private tracker')
  assert.equal(
    blocked(config('torrent_only', PROWLARR, COVERAGE.usenetOnly), undefined),
    'No public magnet, and Prowlarr has no indexer for AB',
  )
  assert.equal(
    blocked(config('choose', { sabnzbd_url: '' }), AVAILABILITY.available),
    'No public magnet: AB is a private tracker; Usenet needs SABnzbd',
  )
  assert.equal(blocked(config('usenet_only'), undefined, publicRelease), 'Usenet not checked yet')
  assert.equal(blocked(config('usenet_only'), AVAILABILITY.ruledOut, publicRelease), 'No Usenet copy found')
})

test('the availability fingerprint changes with the Usenet sources, not with the download mode', () => {
  const base = downloadRoutes(config('choose', PROWLARR)).availabilityFingerprint
  assert.equal(downloadRoutes(config('usenet_only', PROWLARR)).availabilityFingerprint, base)
  assert.equal(
    downloadRoutes(config('choose', { ...PROWLARR, sonarr_url: 'http://sonarr.test' })).availabilityFingerprint,
    base,
  )
  for (const changes of [
    { animetosho_enabled: false },
    { amenzb_enabled: true },
    { prowlarr_url: 'http://other.test' },
    { tracker_mode: 'public' as const },
    { sabnzbd_url: 'http://other-sab.test' },
    { sabnzbd_key: '' },
  ])
    assert.notEqual(
      downloadRoutes(config('choose', { ...PROWLARR, ...changes })).availabilityFingerprint,
      base,
      JSON.stringify(changes),
    )
})

test('Usenet is looked up for a public hash, and for a private release when Prowlarr has Usenet indexers', () => {
  const searchable = (settings: Config, release: Release) => downloadRoutes(settings).usenetSearchable(release)
  assert.equal(searchable(config('choose'), publicRelease), true)
  assert.equal(searchable(config('choose'), privateRelease), false)
  assert.equal(searchable(config('choose', PROWLARR, COVERAGE.unknown), privateRelease), false)
  assert.equal(searchable(config('choose', PROWLARR, { trackers: ['AB'], usenet: false }), privateRelease), false)
  assert.equal(searchable(config('choose', PROWLARR, COVERAGE.usenetOnly), privateRelease), true)
  assert.equal(
    searchable(config('choose', { ...PROWLARR, sabnzbd_url: '' }, COVERAGE.usenetOnly), privateRelease),
    false,
  )
  assert.equal(searchable(config('torrent_only'), publicRelease), false)
})

test('Prowlarr counts as configured once it is switched on with a URL and key', () => {
  assert.equal(downloadRoutes(config('choose')).prowlarrConfigured, false)
  assert.equal(downloadRoutes(config('choose', PROWLARR)).prowlarrConfigured, true)
  assert.equal(downloadRoutes(config('choose', { ...PROWLARR, prowlarr_enabled: false })).prowlarrConfigured, false)
  assert.equal(downloadRoutes(config('choose', { ...PROWLARR, prowlarr_key: '' })).prowlarrConfigured, false)
})
