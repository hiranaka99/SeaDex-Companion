import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Release, ResultItem } from '../shared/contracts.js'
import type { UsenetAvailabilityResult, UsenetUnitState } from '../shared/usenet-contracts.js'
import { DEFAULT_CONFIG, publicConfig } from '../server/config.js'
import { releaseIdentity } from '../shared/releases.js'
import { downloadRoutes } from '../frontend/src/download-routes.js'
import type { DiskSpaceCheck, DownloadMode, DownloadPreflight } from '../shared/download-contracts.js'
import type { SendOutcome } from '../frontend/src/api.js'
import {
  createReleaseSends,
  currentAvailability,
  sendVerdict,
  wholeReleaseVerdict,
  type SendApi,
} from '../frontend/src/release-actions.js'
import type { Config } from '../frontend/src/types.js'

const SAB = { sabnzbd_url: 'http://sab.test', sabnzbd_key: 'sab-key' }

const config = (mode: DownloadMode, changes: Partial<typeof DEFAULT_CONFIG> = {}): Config =>
  publicConfig({ ...DEFAULT_CONFIG, ...SAB, download_mode: mode, sonarr_category: 'anime', ...changes })

const publicRelease: Release = {
  kind: 'best',
  releaseGroup: 'Group A',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 1000,
  info_hashes: ['a'.repeat(40)],
  torrent_available: true,
  torrent_files: [{ hash: 'a'.repeat(40), files: [{ name: 'Show - 01.mkv', length: 1000 }] }],
}
const privateRelease: Release = {
  ...publicRelease,
  tracker: 'AB',
  info_hashes: [],
  torrent_files: [],
  torrent_available: false,
  private_sources: [{ id: 'files:' + 'b'.repeat(40), files: [{ name: 'Show - 01.mkv', length: 500 }] }],
}

const season = (releases: Release[], changes: Partial<ResultItem> = {}): ResultItem => ({
  key: 'show',
  group_id: 1,
  arr: 'Sonarr',
  title: 'Show',
  season: 1,
  status: 'upgrade',
  have: [],
  local_size: 0,
  best_group: 'Group A',
  best_size: 1000,
  releases,
  url: null,
  notes: null,
  image: null,
  banner: null,
  anilist_id: 1,
  arr_url: null,
  ...changes,
})

const row = (
  aggregate: UsenetUnitState,
  changes: Partial<UsenetAvailabilityResult> = {},
): UsenetAvailabilityResult => ({
  key: 'show',
  release: 0,
  identity: 'identity:show',
  hashes: [{ hash: 'a'.repeat(40), state: aggregate, provider: 'animetosho', total_bytes: 2000 }],
  aggregate,
  checked_at: '',
  stale: false,
  refreshing: false,
  ...changes,
})

/** The verdict a release row shows for the first release of `result`. */
const verdictFor = (settings: Config, result: ResultItem, changes: Partial<Parameters<typeof sendVerdict>[0]> = {}) => {
  const routes = downloadRoutes(settings)
  return sendVerdict({
    result,
    release: result.releases[0],
    config: settings,
    routes,
    route: routes.release(result.releases[0], changes.availability),
    transfers: [],
    ...changes,
  })
}

test('a public torrent release sends the whole release to qBittorrent and is the recommended step', () => {
  const verdict = verdictFor(config('torrent_only'), season([publicRelease]))
  assert.deepEqual(verdict, {
    protocol: 'torrent',
    label: 'Download release',
    enabled: true,
    reason: 'Send this release to qBittorrent (category: anime)',
    recommended: true,
    facts: 'Whole release · Ep 1 · to qBittorrent · free space checked on send',
  })
})

test('a release names the category of the instance it came from, or that it has none', () => {
  const settings = config('choose', {
    sabnzbd_sonarr_category: 'anime-nzb',
    arr_instances: [
      {
        id: 'uhd4k',
        kind: 'sonarr',
        name: 'Sonarr 4K',
        url: 'http://sonarr4k',
        key: 'second-key',
        category: 'sonarr-4k',
        sabnzbd_category: 'nzb-4k',
        scope: { anime_only: false, include_tags: [], exclude_tags: [], root_folders: [] },
      },
    ],
  })
  const additional = season([publicRelease], { instance: 'uhd4k', instance_name: 'Sonarr 4K' })
  assert.equal(verdictFor(settings, additional).reason, 'Send this release to qBittorrent (category: sonarr-4k)')
  const routes = downloadRoutes(settings)
  const viaUsenet = sendVerdict({
    result: additional,
    release: publicRelease,
    config: settings,
    routes,
    route: routes.release(publicRelease, row('available'), 'usenet'),
    availability: row('available'),
    transfers: [],
  })
  assert.equal(viaUsenet.reason, 'Send this release to SABnzbd (category: nzb-4k)')

  const blank = config('torrent_only', { sonarr_category: '' })
  assert.equal(
    verdictFor(blank, season([publicRelease])).reason,
    'Send this release to qBittorrent without a category',
    'The server sends no category, so the row does not name the application instead',
  )
  const removed = season([publicRelease], { instance: 'gone', instance_name: 'Gone' })
  assert.equal(verdictFor(settings, removed).reason, 'Send this release to qBittorrent without a category')
})

test('a release no route can send names why in its verdict', () => {
  const torrentOnly = verdictFor(config('torrent_only'), season([privateRelease]))
  assert.equal(torrentOnly.enabled, false)
  assert.equal(torrentOnly.label, 'Unavailable')
  assert.equal(torrentOnly.reason, 'No public magnet: AB is a private tracker')
  assert.equal(torrentOnly.facts, '', 'Nothing is sent, so nothing is said about what a send covers')

  const either = verdictFor(config('choose'), season([privateRelease]), { availability: row('no_match') })
  assert.equal(either.reason, 'No public magnet: AB is a private tracker; No Usenet copy found')
})

test('a proven Usenet copy sends the whole source to SABnzbd', () => {
  const settings = config('usenet_only', { sabnzbd_sonarr_category: 'anime-nzb' })
  const verdict = verdictFor(settings, season([privateRelease]), { availability: row('available') })
  assert.deepEqual(verdict, {
    protocol: 'usenet',
    label: 'Download on Usenet',
    enabled: true,
    reason: 'Send this release to SABnzbd (category: anime-nzb)',
    recommended: true,
    facts: 'Whole Usenet source · to SABnzbd · free space checked on send',
  })
})

test('a release already in a client or already owned is not the next step', () => {
  const transfer = {
    record_id: 'r1',
    protocol: 'torrent' as const,
    client: 'qbittorrent' as const,
    phase: 'downloading' as const,
    capabilities: { pause: true, resume: true, remove: true, remove_files: true },
    progress: 0.5,
    downloaded: 500,
    total_size: 1000,
    speed: 10,
    title: 'Show',
    season: 'S1',
    releaseGroup: 'Group A',
    category: 'anime',
    size: 1000,
  }
  const downloading = verdictFor(config('torrent_only'), season([publicRelease]), { transfers: [transfer] })
  assert.equal(downloading.enabled, false)
  assert.equal(downloading.label, 'Downloading')
  assert.equal(downloading.reason, 'Downloading in qBittorrent')

  const finished = verdictFor(config('torrent_only'), season([publicRelease]), {
    transfers: [{ ...transfer, phase: 'complete' }],
  })
  assert.equal(finished.label, 'Download completed')
  assert.equal(finished.reason, 'Download completed in qBittorrent')

  const owned = verdictFor(config('torrent_only'), season([{ ...publicRelease, files_match: true }]))
  assert.equal(owned.enabled, true)
  assert.equal(owned.label, 'Re-download')
  assert.equal(owned.recommended, false)
})

test('selected files and a preferred target shape the verdict', () => {
  const selected = { ...publicRelease, kind: 'alt' as const, target: true, selected_files: ['Show - 01.mkv'] }
  const verdict = verdictFor(config('torrent_only'), season([selected, publicRelease]))
  assert.equal(verdict.label, 'Download 1 file')
  assert.equal(verdict.facts, '1 selected file · Ep 1 · to qBittorrent · free space checked on send')
  assert.equal(verdict.recommended, true, 'The target leads over the best release')
  const best = verdictFor(config('torrent_only'), season([publicRelease, selected]))
  assert.equal(best.recommended, false, 'A best release steps aside for a target')
})

const disk = (changes: Partial<DiskSpaceCheck> = {}): DiskSpaceCheck => ({
  client: 'qbittorrent',
  path: '/downloads',
  categories: ['anime'],
  required_bytes: 1000,
  unknown_units: 0,
  free_bytes: 5000,
  sufficient: true,
  ...changes,
})

const preflight = (changes: Partial<DownloadPreflight> = {}): DownloadPreflight => ({
  ok: true,
  plan_id: 'plan-1',
  expires_in: 600,
  mode: 'torrent_only',
  selection_count: 1,
  // A send only asks whether anything is left to send; the units themselves are the server's business.
  units: [{ unit_id: 'torrent:a' } as unknown as DownloadPreflight['units'][number]],
  new_torrents: 1,
  new_nzbs: 0,
  existing_units: 0,
  blocked: [],
  requires_whole_ack: false,
  requires_space_ack: false,
  total_new_bytes: 1000,
  unknown_bytes: 0,
  approximate_bytes: false,
  disk_space: [disk()],
  ...changes,
})

/** The api a card sends through, answering each review with `review` and each send with `outcome`. */
function apiDouble(review: () => DownloadPreflight, outcome: () => SendOutcome) {
  const calls = { preflight: [] as unknown[][], send: [] as unknown[][] }
  const api: SendApi = {
    preflightDownload: async (...args) => {
      calls.preflight.push(args)
      return review()
    },
    sendDownload: async (...args) => {
      calls.send.push(args)
      return outcome()
    },
  }
  return { api, calls }
}

function cardSends(review: () => DownloadPreflight, outcome: () => SendOutcome, detailsShown = true) {
  const double = apiDouble(review, outcome)
  const notes: { message: string; tone: string }[] = []
  let reloads = 0
  const sends = createReleaseSends({
    api: double.api,
    reload: async () => {
      reloads++
    },
    notify: (message, tone) => void notes.push({ message, tone }),
    detailsShown: () => detailsShown,
  })
  return { sends, calls: double.calls, notes, reloads: () => reloads }
}

const show = season([publicRelease, privateRelease])

test('too little free space holds a send until the person sends it anyway', async () => {
  const { sends, calls, notes } = cardSends(
    () => preflight({ disk_space: [disk({ free_bytes: 100, sufficient: false })] }),
    () => ({ kind: 'sent', client: 'sabnzbd' }),
  )
  await sends.send(show, 1, 'usenet', 'nzb-7')
  assert.equal(calls.send.length, 0, 'Nothing is sent while the fit on disk is not established')
  assert.deepEqual(sends.getState().lowSpace, {
    key: 'show',
    release: 1,
    protocol: 'usenet',
    nzb: 'nzb-7',
    reason: 'low',
    checks: [disk({ free_bytes: 100, sufficient: false })],
  })
  assert.deepEqual(notes, [])

  await sends.sendAnyway(show, 1)
  assert.equal(sends.getState().lowSpace, null)
  assert.deepEqual(
    calls.preflight.at(-1)![0],
    [{ key: 'show', release: 1, identity: releaseIdentity(privateRelease), protocol: 'usenet', nzb: 'nzb-7' }],
    'Send anyway repeats the held send, chosen NZB included',
  )
  assert.deepEqual(calls.send, [['plan-1', 'usenet', { whole_source: true, disk_space: true }]])
  assert.deepEqual(notes, [{ message: 'Sent S01 · Group A to SABnzbd · 100 B free', tone: 'success' }])
})

test('a client that reports no free space holds the send as unknown', async () => {
  const { sends, calls } = cardSends(
    () => preflight({ disk_space: [disk({ free_bytes: null, sufficient: null })] }),
    () => ({ kind: 'sent', client: 'qbittorrent' }),
  )
  await sends.send(show, 0, 'torrent')
  assert.equal(sends.getState().lowSpace?.reason, 'unknown')
  assert.equal(calls.send.length, 0)
  sends.cancelLowSpace()
  assert.equal(sends.getState().lowSpace, null)
  await sends.sendAnyway(show, 0)
  assert.equal(calls.send.length, 0, 'A cancelled hold cannot be sent anyway')
})

test('a send the client never confirmed asks the person to check that client before retrying', async () => {
  let outcome: SendOutcome = { kind: 'acceptance_unknown', client: 'qbittorrent' }
  const { sends, notes, reloads } = cardSends(
    () => preflight(),
    () => outcome,
  )
  await sends.send(show, 0, 'torrent')
  assert.deepEqual(sends.getState().errors, {
    'show\u00000':
      'qBittorrent was asked to start this download but did not confirm it. Check qBittorrent before retrying.',
  })
  assert.deepEqual(notes, [], 'Open details show the failure in the row, not as a notification')
  assert.equal(sends.getState().sending, null)
  assert.equal(reloads(), 1, 'Progress is refreshed after every send')

  outcome = { kind: 'sent', client: 'qbittorrent' }
  await sends.send(show, 0, 'torrent')
  assert.deepEqual(sends.getState().errors, {}, 'A retry clears the failure')
  assert.deepEqual(notes, [{ message: 'Sent S01 · Group A to qBittorrent · 4.9 KB free', tone: 'success' }])
})

test('a failed send with details closed is reported as a notification', async () => {
  const { sends, notes } = cardSends(
    () =>
      preflight({
        blocked: [{ key: 'show', release: 0, code: 'excluded', reason: 'Excluded by your release preferences' }],
      }),
    () => ({ kind: 'sent', client: 'qbittorrent' }),
    false,
  )
  await sends.send(show, 0, 'torrent')
  assert.equal(sends.getState().errors['show\u00000'], 'Excluded by your release preferences')
  assert.deepEqual(notes, [
    { message: 'Could not send S01 · Group A: Excluded by your release preferences', tone: 'error' },
  ])
  sends.dismissError('show', 0)
  assert.deepEqual(sends.getState().errors, {})
})

test('availability answers only for the release it was asked about', () => {
  const answer = row('available', { identity: releaseIdentity(publicRelease) })
  assert.equal(currentAvailability({ 0: answer }, publicRelease, 0), answer)
  // SeaDex replaced the release at this index since the answer arrived.
  assert.equal(currentAvailability({ 0: answer }, privateRelease, 0), undefined)
  assert.equal(currentAvailability(undefined, publicRelease, 0), undefined)
})

const GiB = 1024 ** 3
/** Six episodes of one continuous entry, two per split season. */
const splitFiles = [1, 2, 3, 4, 5, 6].map(number => ({
  name: `Bleach - ${String(number).padStart(3, '0')}.mkv`,
  length: GiB,
}))
const splitRelease = (held: number[] = []): Release => ({
  ...publicRelease,
  size: 2 * GiB,
  selected_files: [splitFiles[2].name, splitFiles[3].name],
  torrent_files: [{ hash: 'a'.repeat(40), files: splitFiles }],
  whole_release: { seasons: [1, 2, 3], held },
})
const splitSeason = (release: Release) => season([release], { season: 2, split_seasons: [1, 2, 3] })

/** The whole-release verdict for the first release of `result`. */
const wholeFor = (settings: Config, result: ResultItem, changes: Partial<Parameters<typeof sendVerdict>[0]> = {}) => {
  const routes = downloadRoutes(settings)
  return wholeReleaseVerdict({
    result,
    release: result.releases[0],
    config: settings,
    routes,
    route: routes.release(result.releases[0], changes.availability),
    transfers: [],
    ...changes,
  })
}

test('a split season offers the whole release beside its own files', () => {
  const result = splitSeason(splitRelease())
  assert.deepEqual(wholeFor(config('torrent_only'), result), {
    protocol: 'torrent',
    label: 'Download whole release',
    enabled: true,
    reason: 'Send the whole release, Seasons 1–3, to qBittorrent (category: anime)',
    // The season's own download stays the card's next step; the whole release is the bigger, deliberate choice.
    recommended: false,
    facts: 'Eps 1–6 · 6 files · 6.0 GB · Seasons 1–3 · to qBittorrent · free space checked on send',
  })
  // The season-only download keeps its own file count.
  assert.equal(verdictFor(config('torrent_only'), result).label, 'Download 2 files')
  // An ordinary season, or a release of this season alone, has no whole-release action.
  assert.equal(wholeFor(config('torrent_only'), season([splitRelease()])), null)
  assert.equal(wholeFor(config('torrent_only'), splitSeason({ ...splitRelease(), whole_release: undefined })), null)
})

test('the whole release reads as a re-download only when every season it covers holds it', () => {
  const some = wholeFor(config('torrent_only'), splitSeason(splitRelease([1, 2])))
  assert.equal(some?.label, 'Download whole release')
  assert.equal(
    some?.facts,
    'Eps 1–6 · 6 files · 6.0 GB · Seasons 1–3 · Seasons 1–2 already hold this release and will be downloaded again · to qBittorrent · free space checked on send',
  )
  const all = wholeFor(config('torrent_only'), splitSeason(splitRelease([1, 2, 3])))
  assert.equal(all?.label, 'Re-download whole release')
  assert.equal(all?.enabled, true)
  assert.equal(all?.recommended, false)
})

test('the whole release shows its own download state, not a season-only one', () => {
  const transfer = {
    record_id: 'r1',
    protocol: 'torrent' as const,
    client: 'qbittorrent' as const,
    phase: 'downloading' as const,
    capabilities: { pause: true, resume: true, remove: true, remove_files: true },
    progress: 0.5,
    downloaded: 500,
    total_size: 1000,
    speed: 10,
    title: 'Bleach',
    season: 'S2',
    releaseGroup: 'Group A',
    category: 'anime',
    size: 1000,
  }
  const result = splitSeason(splitRelease())
  const whole = wholeFor(config('torrent_only'), result, { transfers: [transfer] })
  assert.equal(whole?.label, 'Downloading')
  assert.equal(whole?.enabled, false)
  // A send of this season's files alone leaves the whole release to download; it widens that torrent.
  const seasonOnly = wholeFor(config('torrent_only'), result, {
    transfers: [{ ...transfer, scope: [splitFiles[2].name, splitFiles[3].name] }],
  })
  assert.equal(seasonOnly?.label, 'Download whole release')
  assert.equal(seasonOnly?.enabled, true)
})

test('the whole release goes to Usenet as one NZB, which a season alone cannot', () => {
  const result = splitSeason(splitRelease())
  const availability = row('available', {
    hashes: [{ hash: 'a'.repeat(40), state: 'available', provider: 'animetosho', total_bytes: 7 * GiB }],
  })
  const whole = wholeFor(config('usenet_only'), result, { availability })
  assert.deepEqual(whole, {
    protocol: 'usenet',
    label: 'Download whole release on Usenet',
    enabled: true,
    reason: 'Send the whole release, Seasons 1–3, to SABnzbd (category: sonarr-anime)',
    recommended: false,
    facts: '~7.0 GB · Seasons 1–3 · to SABnzbd · free space checked on send',
  })
  const seasonOnly = verdictFor(config('usenet_only'), result, { availability })
  assert.equal(seasonOnly.enabled, false)
  assert.equal(seasonOnly.label, 'Usenet unavailable')
  assert.equal(seasonOnly.reason, 'Usenet cannot fetch one season alone; download the whole release on Usenet instead')
  // An ordinary season keeps its Usenet download.
  assert.equal(
    verdictFor(config('usenet_only'), season([splitRelease()]), { availability }).label,
    'Download on Usenet',
  )
})

test('a whole-release send asks for the whole release, also when it is sent anyway', async () => {
  const { sends, calls } = cardSends(
    () => preflight({ disk_space: [disk({ free_bytes: 100, sufficient: false })] }),
    () => ({ kind: 'sent', client: 'qbittorrent' }),
  )
  const result = splitSeason(splitRelease())
  await sends.sendWhole(result, 0, 'torrent')
  assert.equal(sends.getState().lowSpace?.whole, true)
  await sends.sendAnyway(result, 0)
  const asked = {
    key: 'show',
    release: 0,
    identity: releaseIdentity(result.releases[0]),
    protocol: 'torrent',
    whole_release: true,
  }
  assert.deepEqual(
    calls.preflight.map(call => call[0]),
    [[asked], [asked]],
  )
  assert.equal(calls.send.length, 1)
})
