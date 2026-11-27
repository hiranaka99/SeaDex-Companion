import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProwlarrSearchStatus, Release, ResultItem, UsenetSearchSummary } from '../shared/contracts.js'
import type { DownloadPreflight, PlannedUnit } from '../shared/download-contracts.js'
import { releaseIdentity } from '../shared/releases.js'
import type {
  UsenetAvailabilityResult,
  UsenetCandidate,
  UsenetHashAvailability,
  UsenetUnitState,
} from '../shared/usenet-contracts.js'
import { buildReview, optionAvailabilityKey, reviewProtocol, usenetEligibility } from '../frontend/src/bulk-review.js'
import { serviceOfField } from '../frontend/src/config-services.js'
import { awaitsCheck, downloadRoutes } from '../frontend/src/download-routes.js'
import type { Config } from '../frontend/src/types.js'
import { DEFAULT_CONFIG, publicConfig } from '../server/config.js'
import { availabilityKey } from '../frontend/src/usenet-observation.js'
import {
  candidateChoosable,
  candidateConfirmText,
  candidateFacts,
  candidateFinding,
  candidatesIntro,
  checkBlockedReason,
  checksInProgress,
  describeUsenet,
  EMPTY_LEDGER,
  expectedSearchesText,
  fetchesLeftText,
  limitValue,
  nearExactNote,
  openChecks,
  plannedProof,
  planVerification,
  proofLabel,
  recordVerification,
  reviewStatusLabel,
  sweepProgress,
  sweepSummaryLines,
  usageText,
  verifyProgressText,
  type RowRef,
} from '../frontend/src/usenet-review.js'

const LIMIT = 'Daily NZB check limit reached for Geek. Next check at 2026-11-27 14:00.'

const row = (
  key: string,
  aggregate: UsenetUnitState,
  changes: Partial<UsenetAvailabilityResult> = {},
  hash: Partial<UsenetHashAvailability> = {},
): UsenetAvailabilityResult => ({
  key,
  release: 0,
  identity: `identity:${key}`,
  hashes: [{ hash: 'files:' + 'a'.repeat(40), state: aggregate, provider: 'prowlarr', ...hash }],
  aggregate,
  checked_at: '',
  stale: false,
  refreshing: false,
  ...changes,
})
const ref = (key: string): RowRef => ({ key, release: 0, identity: `identity:${key}` })
const rowsOf = (...rows: UsenetAvailabilityResult[]) =>
  Object.fromEntries(rows.map(item => [availabilityKey(item), item]))

const candidate = (changes: Partial<UsenetCandidate> = {}): UsenetCandidate => ({
  entry_id: '7-abcdef',
  title: '[Group] Show (BD 1080p)',
  indexer: 'Geek',
  size: 2 * 1024 ** 3,
  info_url: 'https://indexer.invalid/details/1',
  files_matched: 0,
  names_matched: 0,
  files_expected: 12,
  sizes_known: false,
  checked: true,
  ...changes,
})

test('an unverified row says how many results wait and offers the check', () => {
  const unverified = row('show', 'unverified', { search: 'prowlarr' }, { candidate_count: 3 })
  const info = describeUsenet(unverified, true)!
  assert.equal(info.label, 'Possible copy on Usenet: 3 results, not checked yet')
  assert.equal(info.action, 'check')
  assert.equal(info.usable, false, 'An unchecked result is never offered as a download')
  assert.match(info.detail, /Check now fetches the best one/)
  assert.equal(
    describeUsenet(row('show', 'unverified', { search: 'prowlarr' }, { candidate_count: 1 }), true)!.label,
    'Possible copy on Usenet: 1 result, not checked yet',
  )
  assert.equal(
    describeUsenet({ ...unverified, refreshing: true }, true)!.label,
    'Checking Usenet results…',
    'A running check is named instead of the count',
  )
  assert.equal(reviewStatusLabel(unverified), 'Possible copy on Usenet: 3 results, not checked yet')
  assert.equal(describeUsenet(unverified, false)!.label, 'Usenet needs SABnzbd', 'Without SABnzbd nothing is offered')
})

test('the fetch-limit reason is shown as the server words it', () => {
  const limited = row('show', 'unverified', { search: 'prowlarr' }, { candidate_count: 2, error: LIMIT })
  assert.equal(checkBlockedReason(limited), LIMIT)
  assert.equal(describeUsenet(limited, true)!.detail, LIMIT)
  assert.equal(describeUsenet(limited, true)!.action, 'check')
  assert.equal(checkBlockedReason(row('show', 'unverified', { search: 'prowlarr' })), null)
  assert.equal(
    checkBlockedReason(row('show', 'no_match', { search: 'prowlarr' }, { error: 'Prowlarr found 2 possible NZBs.' })),
    null,
    'Only a check that could not run is a blocked check',
  )
})

test('an available Prowlarr copy is labelled by how it was proven', () => {
  const exact = row('show', 'available', { search: 'prowlarr' }, { proof: 'exact', total_bytes: 1024 ** 3 })
  const near = row('show', 'available', { search: 'prowlarr' }, { proof: 'near_exact' })
  assert.equal(describeUsenet(exact, true)!.label, 'On Usenet through Prowlarr: files match exactly · ~1.0 GB')
  assert.equal(describeUsenet(exact, true)!.usable, true)
  assert.equal(describeUsenet(near, true)!.label, 'On Usenet through Prowlarr: names and sizes match (near-exact)')
  assert.match(describeUsenet(near, true)!.detail, /whole upload/)
  assert.equal(reviewStatusLabel(exact), 'On Usenet through Prowlarr: files match exactly')
  assert.equal(reviewStatusLabel(near), 'On Usenet through Prowlarr: names and sizes match (near-exact)')
  assert.equal(
    reviewStatusLabel(exact, 'near_exact'),
    'On Usenet through Prowlarr: names and sizes match (near-exact)',
    'The proof of the planned NZB wins over the availability row',
  )
  assert.equal(proofLabel(undefined), 'Usenet copy found through Prowlarr')
  const hashLinked = row('show', 'available', {}, { provider: 'animetosho' })
  assert.equal(reviewStatusLabel(hashLinked), 'Usenet source found', 'A hash-linked NZB has no proof level')
  assert.equal(describeUsenet(hashLinked, true)!.label, 'Usenet source found on AnimeTosho')
})

test('review rows name a search that has not run yet', () => {
  assert.equal(reviewStatusLabel(row('show', 'not_checked', { search: 'prowlarr' })), 'Usenet: not searched yet')
  assert.equal(
    reviewStatusLabel(row('show', 'not_checked', { search: 'prowlarr', refreshing: true })),
    'Searching Prowlarr…',
  )
  assert.equal(
    reviewStatusLabel(row('show', 'no_match', { fallback: 'prowlarr' }, { provider: undefined })),
    'Not on the hash indexers; Prowlarr not searched yet',
  )
  assert.equal(reviewStatusLabel(row('show', 'no_match', { search: 'prowlarr' })), 'No Usenet match')
  assert.equal(reviewStatusLabel(row('show', 'not_checked', {}, { provider: undefined })), 'Usenet: not checked')
})

test('search candidates are worded by proof level, and only a checked one can be chosen', () => {
  assert.deepEqual(candidateFinding(candidate({ proof: 'probable' })), {
    text: 'File sizes match an obfuscated post',
    tone: 'plain',
  })
  assert.deepEqual(candidateFinding(candidate({ proof: 'size_only' })), {
    text: 'Only the total size could be compared (packed or obfuscated post)',
    tone: 'plain',
  })
  const differs = candidateFinding(candidate({ proof: 'unverified', names_matched: 3 }))
  assert.equal(differs.tone, 'warn', 'Differing sizes are a warning')
  assert.equal(differs.text, 'Sizes differ from the listed release; 3 of 12 episode file names match')
  assert.ok(candidateChoosable(candidate({ proof: 'probable' })))
  assert.ok(candidateChoosable(candidate({ proof: 'unverified' })), 'The person may still choose it after the warning')

  const unchecked = candidate({ checked: false })
  assert.deepEqual(candidateFinding(unchecked), { text: 'Not checked yet', tone: 'quiet' })
  assert.equal(candidateChoosable(unchecked), false, 'A search result nobody opened cannot be sent')

  const rejected = candidate({ proof: 'near_exact', rejected: true })
  assert.deepEqual(candidateFinding(rejected), {
    text: 'Not this release: the files downloaded from this post did not match it',
    tone: 'warn',
  })
  assert.equal(candidateChoosable(rejected), false)

  const unavailable = candidate({ checked: false, unavailable: 'Geek refused the download.' })
  assert.equal(candidateFinding(unavailable).text, 'Could not be checked: Geek refused the download.')
  assert.equal(candidateChoosable(unavailable), false)

  assert.equal(
    candidateFinding(candidate({ sizes_known: true, files_matched: 11 })).text,
    '11 of 12 episode files match by name and size',
    'A checked candidate without a proof level keeps its counts',
  )
  assert.match(candidatesIntro([candidate({ proof: 'probable' }), unchecked]), /you can still download it/)
  assert.match(candidatesIntro([unchecked]), /not checked yet/)
  assert.match(candidatesIntro([rejected, unavailable]), /None can be downloaded from here/)
})

test('candidate facts and the confirmation never carry a download reference', () => {
  const facts = candidateFacts(candidate({ files: 14, info_url: undefined }))
  assert.equal(facts, 'Geek · ~2.0 GB · 14 files · no indexer page available')
  assert.match(
    candidateConfirmText(candidate({ proof: 'probable' }), 'Group'),
    /file sizes match what SeaDex lists for Group/,
  )
  assert.match(
    candidateConfirmText(candidate({ proof: 'size_only' }), 'Group'),
    /Only its total size could be compared/,
  )
  assert.match(
    candidateConfirmText(candidate({ proof: 'unverified' }), 'Group'),
    /sizes differ from the files SeaDex lists/,
  )
})

const release = (changes: Partial<Release> = {}): Release => ({
  kind: 'best',
  releaseGroup: 'Group A',
  tracker: 'Nyaa',
  quality: '1080p',
  tags: [],
  size: 1000,
  info_hashes: ['a'.repeat(40)],
  torrent_available: true,
  ...changes,
})
const season = (key: string, releases: Release[]): ResultItem => ({
  key,
  group_id: 1,
  arr: 'Sonarr',
  title: key,
  season: 1,
  status: 'upgrade',
  match_status: 'matched',
  have: ['Old group'],
  local_size: 400,
  best_group: 'Group A',
  best_size: 1000,
  releases,
  url: null,
  notes: null,
  image: null,
  banner: null,
  anilist_id: 1,
  arr_url: null,
})
const privateRelease = release({
  tracker: 'AB',
  info_hashes: [],
  torrent_available: false,
  private_sources: [{ id: 'files:' + 'b'.repeat(40), files: [{ name: '01.mkv', length: 500 }] }],
})
const availabilityFor = (
  result: ResultItem,
  aggregate: UsenetUnitState,
  changes: Partial<UsenetAvailabilityResult> = {},
) => {
  const option = { index: 0, release: result.releases[0] }
  return {
    [optionAvailabilityKey(result, option)]: row(result.key, aggregate, {
      identity: releaseIdentity(result.releases[0]),
      ...changes,
    }),
  }
}

const USENET_CONFIG: Config = publicConfig({
  ...DEFAULT_CONFIG,
  download_mode: 'choose',
  sabnzbd_url: 'http://sab.test',
  sabnzbd_key: 'key',
})
const PROWLARR_CONFIG = publicConfig({
  ...DEFAULT_CONFIG,
  prowlarr_enabled: true,
  prowlarr_url: 'http://prowlarr.test',
  prowlarr_key: 'key',
})
const USENET = downloadRoutes(USENET_CONFIG)

test('a release a file-list search can look for counts as eligible for Usenet', () => {
  const unsearched = season('unsearched', [privateRelease])
  const unverified = season('unverified', [privateRelease])
  const fallback = season('fallback', [privateRelease])
  const ruledOut = season('ruled-out', [privateRelease])
  const hashOnly = season('hash-only', [privateRelease])
  const rows = {
    ...availabilityFor(unsearched, 'not_checked', { search: 'prowlarr' }),
    ...availabilityFor(unverified, 'unverified', { search: 'prowlarr' }),
    ...availabilityFor(fallback, 'no_match', { fallback: 'prowlarr' }),
    ...availabilityFor(ruledOut, 'no_match', { search: 'prowlarr' }),
    ...availabilityFor(hashOnly, 'not_checked'),
  }
  const results = [unsearched, unverified, fallback, ruledOut, hashOnly]
  const review = buildReview(results, usenetEligibility(rows, USENET), USENET)
  assert.deepEqual(
    review.ready.map(group => group.result.key),
    ['unsearched', 'unverified', 'fallback'],
    'Rows that can still be searched or checked are offered before any search ran',
  )
  assert.deepEqual(
    review.blocked.map(group => group.result.key),
    ['ruled-out', 'hash-only'],
    'A search that found nothing, and a row Prowlarr cannot look for, stay unavailable',
  )
  const noSab = downloadRoutes({ ...USENET_CONFIG, sabnzbd_url: '' })
  assert.equal(
    buildReview(results, usenetEligibility(rows, noSab), noSab).ready.length,
    0,
    'Nothing is offered for Usenet without SABnzbd',
  )
  assert.equal(buildReview(results, usenetEligibility(null, USENET), USENET).ready.length, 0)
  const torrentOnly = downloadRoutes({ ...USENET_CONFIG, download_mode: 'torrent_only' })
  assert.equal(buildReview(results, usenetEligibility(rows, torrentOnly), torrentOnly).ready.length, 0)
})

test('bulk review offers torrents as the download mode and Prowlarr coverage allow', () => {
  const both = { ...USENET_CONFIG, ...PROWLARR_CONFIG, prowlarr_coverage: { trackers: ['AB'], usenet: true } }
  const results = [season('public', [release()]), season('private', [privateRelease])]
  const ready = (config: Config) => {
    const routes = downloadRoutes(config)
    return buildReview(results, usenetEligibility({}, routes), routes).ready.map(group => group.result.key)
  }
  assert.deepEqual(ready(both), ['public', 'private'])
  assert.deepEqual(ready({ ...both, prowlarr_coverage: { trackers: [], usenet: true } }), ['public'])
  assert.deepEqual(ready({ ...both, download_mode: 'usenet_only' }), [])
})

test('a pending Usenet check sends a release over Usenet in bulk review as on its card', () => {
  const item = season('pending', [privateRelease])
  const option = { index: 0, release: privateRelease }
  const rows = availabilityFor(item, 'not_checked', { search: 'prowlarr' })
  const row = rows[optionAvailabilityKey(item, option)]
  assert.equal(reviewProtocol(USENET, rows, item, option), 'usenet')
  assert.equal(USENET.release(privateRelease, row).protocol, 'usenet')
  assert.equal(reviewProtocol(USENET, rows, item, option, 'torrent'), 'torrent', 'a choice stands')
})

test('only rows chosen for Usenet that still need a search or a check are verified', () => {
  const rows = rowsOf(
    row('unsearched', 'not_checked', { search: 'prowlarr' }),
    row('unverified', 'unverified', { search: 'prowlarr' }),
    row('fallback', 'no_match', { fallback: 'prowlarr' }),
    row('proven', 'available', { search: 'prowlarr' }),
    row('ruled-out', 'no_match', { search: 'prowlarr' }),
    row('failed', 'lookup_failed', { search: 'prowlarr' }),
    row('torrent', 'not_checked', { search: 'prowlarr' }),
  )
  assert.ok(awaitsCheck(rows[availabilityKey(ref('unsearched'))]))
  assert.equal(awaitsCheck(rows[availabilityKey(ref('proven'))]), false)
  assert.equal(awaitsCheck(undefined), false)
  // "torrent" was switched to Torrent, so it is not among the rows chosen for Usenet.
  const wanted = ['unsearched', 'unverified', 'fallback', 'proven', 'ruled-out', 'failed', 'unknown'].map(ref)
  const plan = planVerification(EMPTY_LEDGER, wanted, rows)
  assert.deepEqual(plan.verify, ['unsearched', 'unverified', 'fallback'].map(ref))
  assert.deepEqual(plan.cancel, [])
  assert.deepEqual(planVerification(EMPTY_LEDGER, [], rows), { verify: [], cancel: [] })
})

test('a row is verified once per review, and a check for a row switched to Torrent is cancelled', () => {
  const wanted = [ref('one'), ref('two')]
  const before = rowsOf(
    row('one', 'not_checked', { search: 'prowlarr' }),
    row('two', 'unverified', { search: 'prowlarr' }),
  )
  const first = planVerification(EMPTY_LEDGER, wanted, before)
  assert.deepEqual(first.verify, wanted)
  // Nothing counts as asked for before the server received it: a lost request is planned again.
  assert.deepEqual(planVerification(EMPTY_LEDGER, wanted, before).verify, wanted)
  const ledger = recordVerification(EMPTY_LEDGER, first)
  assert.equal(recordVerification(ledger, {}), ledger, 'Recording nothing keeps the ledger')

  const running = rowsOf(
    row('one', 'not_checked', { search: 'prowlarr', refreshing: true }),
    row('two', 'unverified', { search: 'prowlarr', refreshing: true }),
  )
  assert.deepEqual(planVerification(ledger, wanted, running), { verify: [], cancel: [] })
  assert.equal(checksInProgress(ledger, wanted, running, { verify: [], cancel: [] }).length, 2)
  assert.equal(
    checksInProgress(EMPTY_LEDGER, wanted, before, first).length,
    2,
    'A check that is about to be requested already holds the review',
  )

  // The top candidate of "one" was not proven and "two" ran into the daily limit: neither is asked for again.
  const settled = rowsOf(
    row('one', 'no_match', { search: 'prowlarr' }),
    row('two', 'unverified', { search: 'prowlarr' }, { error: LIMIT }),
  )
  assert.deepEqual(planVerification(ledger, wanted, settled), { verify: [], cancel: [] })
  assert.equal(checksInProgress(ledger, wanted, settled, { verify: [], cancel: [] }).length, 0)

  // "two" is switched to Torrent while its check still runs.
  const switched = planVerification(ledger, [ref('one')], running)
  assert.deepEqual(switched, { verify: [], cancel: [ref('two')] })
  assert.deepEqual(
    planVerification(ledger, [ref('one')], settled).cancel,
    [],
    'A check that already finished needs no cancellation',
  )
  const afterCancel = recordVerification(ledger, switched)
  assert.deepEqual(Object.keys(afterCancel.requested), [availabilityKey(ref('one'))])
  assert.deepEqual(planVerification(afterCancel, [ref('one')], running), { verify: [], cancel: [] })
  // Its check was dropped, so choosing Usenet for it again asks once more.
  assert.deepEqual(planVerification(afterCancel, wanted, before).verify, [ref('two')])
})

test('closing a review names every check it started that may still be queued', () => {
  const ledger = recordVerification(EMPTY_LEDGER, { verify: [ref('running'), ref('done')] })
  const rows = rowsOf(
    row('running', 'unverified', { search: 'prowlarr', refreshing: true }),
    row('done', 'available', { search: 'prowlarr' }),
    row('unsent', 'not_checked', { search: 'prowlarr' }),
    row('other', 'not_checked', { search: 'prowlarr', refreshing: true }),
  )
  assert.deepEqual(openChecks(ledger, rows, { verify: [ref('unsent')], cancel: [] }), [ref('unsent'), ref('running')])
  assert.deepEqual(
    openChecks(EMPTY_LEDGER, rows, { verify: [], cancel: [] }),
    [],
    'Checks of other callers are left alone',
  )
})

test('the review says what is being checked and what each indexer still allows', () => {
  assert.equal(
    verifyProgressText(1),
    'Checking 1 release on Usenet. One NZB is fetched for each, and the review continues when the check is done.',
  )
  assert.match(verifyProgressText(4), /^Checking 4 releases on Usenet\..*when the checks are done\.$/)
  assert.equal(fetchesLeftText({ indexer: 'Geek', fetches_left: 17 }), 'Geek: 17 left')
  assert.equal(fetchesLeftText({ indexer: 'Slug', fetches_left: null }), 'Slug: no limit')
  assert.equal(
    fetchesLeftText({ indexer: 'Dog', fetches_left: 0, next_fetch_seconds: 3 * 3600 }),
    'Dog: none left, next in about 3 h',
  )
  assert.equal(fetchesLeftText({ indexer: 'Dog', fetches_left: 0 }), 'Dog: none left')
  assert.equal(fetchesLeftText({ indexer: 'Cat', fetches_left: 5, paused_seconds: 300 }), 'Cat: paused for about 5 min')
  assert.equal(
    usageText([
      { indexer: 'Geek', fetches_left: 17 },
      { indexer: 'Slug', fetches_left: null },
    ]),
    'NZB checks left today: Geek: 17 left · Slug: no limit',
  )
  assert.equal(usageText([]), null)
  assert.equal(usageText(undefined), null)
})

const unit = (changes: Partial<PlannedUnit>): PlannedUnit => ({
  unit_id: 'usenet:files:a:anime',
  protocol: 'usenet',
  client: 'sabnzbd',
  source_hash: 'files:a',
  category: 'anime',
  status: 'new',
  whole_source: true,
  scope_expanded: false,
  size_bytes: 100,
  approximate: true,
  labels: ['Group'],
  selections: [{ key: 'show', release: 0 }],
  ...changes,
})

test('a planned NZB found through Prowlarr carries its proof into the review', () => {
  const preflight = {
    units: [
      unit({ provider: 'prowlarr', proof: 'near_exact' }),
      unit({ provider: 'prowlarr', proof: 'exact', selections: [{ key: 'exact', release: 1 }] }),
      unit({ provider: 'animetosho', selections: [{ key: 'hash', release: 0 }] }),
      unit({ provider: 'prowlarr', proof: 'near_exact', status: 'existing', selections: [{ key: 'old', release: 0 }] }),
    ],
  } as DownloadPreflight
  assert.equal(plannedProof(preflight, { key: 'show', release: 0 }), 'near_exact')
  assert.equal(plannedProof(preflight, { key: 'exact', release: 1 }), 'exact')
  assert.equal(plannedProof(preflight, { key: 'hash', release: 0 }), undefined)
  assert.equal(plannedProof(preflight, { key: 'show', release: 1 }), undefined)
  assert.equal(plannedProof(null, { key: 'show', release: 0 }), undefined)
  assert.equal(
    nearExactNote(preflight),
    '1 NZB is a near-exact match: every file name matches and the sizes fit, but the post does not state exact sizes.',
    'Only NZBs the batch would send are counted',
  )
  assert.equal(nearExactNote({ units: [unit({ provider: 'prowlarr', proof: 'exact' })] } as DownloadPreflight), null)
  assert.equal(nearExactNote(null), null)
})

test('the sidebar shows the search sweep once the hash lookups are done', () => {
  assert.deepEqual(sweepProgress({ running: true, checked: 3, total: 40 }), {
    label: 'Matching Usenet sources',
    checked: 3,
    total: 40,
    detail: 'Checking 40 releases against the Usenet indexers.',
  })
  assert.deepEqual(sweepProgress({ running: true, checked: 40, total: 40, search: { checked: 5, total: 12 } }), {
    label: 'Searching Usenet indexers',
    checked: 5,
    total: 12,
    detail: 'Searching Prowlarr for 12 releases. No NZB is fetched.',
  })
  assert.equal(
    sweepProgress({ running: true, checked: 0, total: 0, search: { checked: 0, total: 1 } }).label,
    'Searching Usenet indexers',
    'A library without hash lookups goes straight to the search',
  )
  assert.equal(
    sweepProgress({ running: true, checked: 3, total: 40, search: { checked: 0, total: 12 } }).detail,
    'Checking 40 releases against the Usenet indexers. A Prowlarr search of 12 releases follows.',
  )
})

test('the Prowlarr settings say what a background search costs and what the latest one found', () => {
  const status = (changes: Partial<ProwlarrSearchStatus>): ProwlarrSearchStatus => ({
    eligible_sources: 123,
    pending_sources: 40,
    usenet_indexers: 3,
    ...changes,
  })
  assert.equal(
    expectedSearchesText(status({})),
    'For the current library: about 40 searches on each of your 3 Usenet indexers, about 120 in total. 40 releases of 123 still need a search.',
  )
  assert.equal(
    expectedSearchesText(status({ pending_sources: 1, usenet_indexers: 1 })),
    'For the current library: about 1 search on your Usenet indexer. 1 release of 123 still needs a search.',
  )
  assert.equal(
    expectedSearchesText(status({ pending_sources: 0 })),
    'All 123 releases of the current library that Prowlarr can look for have recent search results.',
  )
  assert.equal(
    expectedSearchesText(status({ usenet_indexers: 0 })),
    'Prowlarr reports no Usenet indexer, so there is nothing to search.',
  )
  assert.equal(
    expectedSearchesText(status({ eligible_sources: 0, pending_sources: 0 })),
    'No release in the current library needs a Prowlarr search.',
  )

  const summary: UsenetSearchSummary = {
    finished_at: '2026-11-26T10:00:00.000Z',
    searched: 120,
    with_candidates: 80,
    without_candidates: 38,
    failed: 2,
    deferred: 3,
    queries: [
      { indexer: 'Geek', count: 135 },
      { indexer: 'Slug', count: 131 },
    ],
  }
  assert.deepEqual(sweepSummaryLines(summary), [
    '120 releases searched: 80 with results, 38 without.',
    '2 searches failed and will be tried again.',
    '3 releases left for later, because an indexer reached its daily search limit.',
    'Searches sent: Geek 135 · Slug 131',
  ])
  assert.deepEqual(sweepSummaryLines({ ...summary, searched: 1, failed: 0, deferred: 0, queries: [] }), [
    '1 release searched: 80 with results, 38 without.',
  ])
})

test('limits are whole numbers within their range, and the limits keep the Prowlarr connection test', () => {
  assert.equal(limitValue('100', 10_000), 100)
  assert.equal(limitValue('20.9', 1_000), 20)
  assert.equal(limitValue('', 1_000), 0, 'An emptied field means no limit')
  assert.equal(limitValue('-5', 1_000), 0)
  assert.equal(limitValue('nonsense', 1_000), 0)
  assert.equal(limitValue('5000', 1_000), 1_000)
  assert.equal(serviceOfField('prowlarr_url'), 'prowlarr')
  assert.equal(serviceOfField('prowlarr_key'), 'prowlarr')
  for (const name of ['prowlarr_background_search', 'prowlarr_search_limit', 'prowlarr_fetch_limit'])
    assert.equal(serviceOfField(name), undefined, `${name} does not change how Prowlarr is reached`)
})
