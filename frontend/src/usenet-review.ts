// What the Usenet finder says and decides in the interface, kept free of components so it can be tested
// without a browser: the text of each availability state, which candidates can be chosen, which rows a
// review asks the server to check, and the Prowlarr settings summaries.

import type { ProwlarrSearchStatus, UsenetPrefetchProgress, UsenetSearchSummary } from '../../shared/contracts.js'
import type { DownloadPreflight } from '../../shared/download-contracts.js'
import type {
  ProwlarrIndexerUsage,
  UsenetAvailabilityResult,
  UsenetCandidate,
  UsenetProof,
} from '../../shared/usenet-contracts.js'
import { displayDateTimeMinutes } from './datetime.js'
import { availabilityKey as rowId, type AvailabilityRow } from './usenet-observation.js'
import { formatBytes, providerNames } from './utils.js'

/** One review row as the availability endpoint identifies it. */
export type RowRef = AvailabilityRow

const count = (amount: number, one: string, many = `${one}s`) => `${amount} ${amount === 1 ? one : many}`

/** "45s", "12 min" or "3 h": a wait short enough to read at a glance. */
function aboutWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

// ---------------------------------------------------------------------------
// Availability states
// ---------------------------------------------------------------------------

/**
 * A file-list search through Prowlarr can still find a copy of this release: nothing is proven and nothing is
 * ruled out. A public release qualifies once its hash indexers answered that they have no NZB.
 */
export function awaitsCheck(row: UsenetAvailabilityResult | undefined): boolean {
  if (!row) return false
  if (row.aggregate === 'not_checked' || row.aggregate === 'unverified')
    return row.search === 'prowlarr' || row.fallback === 'prowlarr'
  return row.aggregate === 'no_match' && row.fallback === 'prowlarr'
}

/** Search results found for a release, checked or not. */
export function candidateCount(row: UsenetAvailabilityResult): number {
  return row.hashes.reduce((total, hash) => total + (hash.candidate_count ?? hash.candidates?.length ?? 0), 0)
}

/** How a copy found through Prowlarr was proven; the weaker level when a release has several sources. */
export function rowProof(row: UsenetAvailabilityResult | undefined): UsenetProof | undefined {
  const proofs = (row?.hashes || []).filter(hash => hash.provider === 'prowlarr').map(hash => hash.proof)
  if (proofs.includes('near_exact')) return 'near_exact'
  return proofs.length && proofs.every(proof => proof === 'exact') ? 'exact' : undefined
}

/** Why no NZB could be checked, as the server words it: a daily limit that was reached, or a paused indexer. */
export function checkBlockedReason(row: UsenetAvailabilityResult | undefined): string | null {
  if (row?.aggregate !== 'unverified') return null
  return row.hashes.find(hash => hash.state === 'unverified' && hash.error)?.error || null
}

export function proofLabel(proof: UsenetProof | undefined): string {
  if (proof === 'exact') return 'On Usenet through Prowlarr: files match exactly'
  if (proof === 'near_exact') return 'On Usenet through Prowlarr: names and sizes match (near-exact)'
  return 'Usenet copy found through Prowlarr'
}

export function unverifiedLabel(results: number): string {
  return results > 0
    ? `Possible copy on Usenet: ${count(results, 'result')}, not checked yet`
    : 'Possible copy on Usenet, not checked yet'
}

export interface UsenetInfo {
  usable: boolean
  label: string
  detail: string
  /** Search results wait to be checked, so the row offers Check now. */
  action?: 'check'
}

const WHOLE_UPLOAD = 'It is the whole upload; files beyond the selected episodes will also download.'

/** Human Usenet state for one release; the server re-validates everything. */
export function describeUsenet(
  row: UsenetAvailabilityResult | undefined,
  sabnzbdConfigured: boolean | undefined,
  privateRelease = false,
  /** Prowlarr is set up. */
  prowlarr = false,
): UsenetInfo | null {
  if (!row) return null
  const hash = row.hashes[0]
  if (!sabnzbdConfigured)
    return {
      usable: false,
      label: 'Usenet needs SABnzbd',
      detail: 'Set up SABnzbd in Settings to download over Usenet.',
    }
  if (row.aggregate === 'unverified')
    return {
      usable: false,
      label: row.refreshing ? 'Checking Usenet results…' : unverifiedLabel(candidateCount(row)),
      detail:
        checkBlockedReason(row) ||
        'Prowlarr found these results, and no NZB has been fetched to compare its files with this release. Check now fetches the best one.',
      action: 'check',
    }
  if (row.search === 'prowlarr') {
    const reason = row.hashes.find(item => item.state === row.aggregate && item.error)?.error
    if (row.aggregate === 'available') {
      const size = hash?.total_bytes ? ` · ~${formatBytes(hash.total_bytes).replace(' ', ' ')}` : ''
      const proof = rowProof(row)
      return {
        usable: true,
        label: `${proofLabel(proof)}${size}`,
        detail:
          proof === 'near_exact'
            ? `The NZB names every file of this release, and each size fits the listed one once the overhead of a Usenet post is allowed for. ${WHOLE_UPLOAD}`
            : `The NZB names every file of this release with its exact size. ${WHOLE_UPLOAD}`,
      }
    }
    if (row.aggregate === 'not_checked')
      return {
        usable: false,
        label: row.refreshing ? 'Searching Prowlarr…' : 'Usenet: not searched',
        detail:
          'This release has not been searched on Usenet yet. Search Prowlarr looks for it now; each NZB checked against the release’s files counts toward the indexer’s download limit.',
      }
    if (row.aggregate === 'no_match')
      return {
        usable: false,
        label: 'No matching copy on Usenet',
        detail: reason || 'No NZB found through Prowlarr has exactly this release’s files.',
      }
    if (row.aggregate === 'lookup_failed')
      return {
        usable: false,
        label: 'Prowlarr search failed',
        detail: `${(reason || 'Prowlarr could not be reached').replace(/\.$/, '')}. Search again in a moment.`,
      }
    if (row.aggregate === 'not_configured')
      return {
        usable: false,
        label: 'Usenet search unavailable',
        detail: reason || 'Add a Usenet indexer to Prowlarr to search for private-tracker releases.',
      }
  }
  if (row.aggregate === 'available') {
    const foundOn = providerNames(row.hashes.map(item => item.provider))
    const size = hash?.total_bytes ? ` · ~${formatBytes(hash.total_bytes).replace(' ', ' ')}` : ''
    const extras =
      hash?.files_known && hash.file_count ? ` · ${hash.file_count} file${hash.file_count === 1 ? '' : 's'}` : ''
    return {
      usable: true,
      label: `Usenet source found${foundOn.length ? ` on ${foundOn.join(' and ')}` : ''}${size}${extras}`,
      detail: 'The Usenet source is the whole upload; files beyond the selected episodes will also download.',
    }
  }
  if (row.aggregate === 'processing')
    return {
      usable: false,
      label: 'Not found on Usenet indexers yet',
      detail:
        'The indexer is still converting this release on their side; it can take hours after release. Re-check refreshes the status.',
    }
  if (row.aggregate === 'incomplete')
    return {
      usable: false,
      label: 'Usenet source uncertain',
      detail: 'Providers returned partial results for this release.',
    }
  if (row.aggregate === 'no_match') {
    // Name what was actually asked: the hash providers, never Prowlarr, for a public release.
    const checked = providerNames(row.hashes.flatMap(item => item.providers_checked || []))
    const who = checked.length ? checked.join(' and ') : 'The enabled hash indexers'
    return {
      usable: false,
      label: checked.length ? `Not found on ${checked.join(' or ')}` : 'Not found on Usenet indexers',
      detail: `${who} ${checked.length === 1 ? 'has' : 'have'} no NZB for this release's torrent hash.${
        row.fallback === 'prowlarr'
          ? ' Search Prowlarr to look on your other Usenet indexers.'
          : prowlarr
            ? ' SeaDex lists no file sizes for it, so a copy found through Prowlarr could not be checked.'
            : ''
      }`,
    }
  }
  if (row.aggregate === 'lookup_failed') {
    const providers = providerNames(hash?.providers_failed || [])
    return {
      usable: false,
      label: 'Usenet lookup failed',
      detail: `${providers.length ? `${providers.join(' and ')} ` : 'The Usenet source '}could not be reached. Retry in a moment.`,
    }
  }
  if (row.aggregate === 'unsupported_hash')
    return {
      usable: false,
      label: 'Usenet unavailable',
      detail: privateRelease
        ? 'Private-tracker releases have no public hash. Set up Prowlarr with Usenet indexers and include private trackers in Release preferences to search for them.'
        : 'This release has no hash the enabled Usenet sources can search.',
    }
  if (row.aggregate === 'not_checked')
    return {
      usable: false,
      label: row.refreshing ? 'Checking Usenet sources…' : 'Usenet: not checked',
      detail: 'No provider result is available yet. Re-check the sources to try again.',
    }
  return {
    usable: false,
    label: 'Usenet not set up',
    detail: 'Enable a Usenet source (AnimeTosho or AmeNZB) in Settings.',
  }
}

/** The availability line of one review row. */
export function reviewStatusLabel(row: UsenetAvailabilityResult, planned?: UsenetProof): string {
  switch (row.aggregate) {
    case 'available': {
      const proof = planned ?? rowProof(row)
      return proof ? proofLabel(proof) : 'Usenet source found'
    }
    case 'unverified':
      return row.refreshing ? 'Checking Usenet results…' : unverifiedLabel(candidateCount(row))
    case 'not_checked':
      if (row.search === 'prowlarr' || row.fallback === 'prowlarr')
        return row.refreshing ? 'Searching Prowlarr…' : 'Usenet: not searched yet'
      return row.refreshing ? 'Checking Usenet sources…' : 'Usenet: not checked'
    case 'no_match':
      if (row.fallback === 'prowlarr')
        return row.refreshing ? 'Searching Prowlarr…' : 'Not on the hash indexers; Prowlarr not searched yet'
      return 'No Usenet match'
    case 'processing':
      return 'Usenet source processing'
    case 'incomplete':
      return 'Usenet source uncertain'
    case 'unsupported_hash':
      return 'Usenet unavailable'
    case 'not_configured':
      return 'Usenet not set up'
    case 'lookup_failed':
      return 'Usenet lookup failed'
  }
}

// ---------------------------------------------------------------------------
// Search candidates
// ---------------------------------------------------------------------------

/** Only an NZB that was fetched and read can be sent: not an unopened search result, and not one known to be wrong. */
export function candidateChoosable(candidate: UsenetCandidate): boolean {
  return candidate.checked === true && !candidate.rejected && !candidate.unavailable
}

export interface CandidateFinding {
  text: string
  /** `warn` when the finding speaks against the candidate; `quiet` when nothing was found out yet. */
  tone: 'plain' | 'quiet' | 'warn'
}

function namesMatched(candidate: UsenetCandidate): string {
  return candidate.files_expected > 0
    ? `${candidate.names_matched} of ${count(candidate.files_expected, 'episode file name')} match`
    : ''
}

/** What is known about one search result, in the words of its proof level. */
export function candidateFinding(candidate: UsenetCandidate): CandidateFinding {
  if (candidate.rejected)
    return { text: 'Not this release: the files downloaded from this post did not match it', tone: 'warn' }
  if (candidate.unavailable) return { text: `Could not be checked: ${candidate.unavailable}`, tone: 'quiet' }
  if (!candidate.checked) return { text: 'Not checked yet', tone: 'quiet' }
  switch (candidate.proof) {
    case 'exact':
      return { text: 'Files match exactly', tone: 'plain' }
    case 'near_exact':
      return { text: 'Names and sizes match (near-exact)', tone: 'plain' }
    case 'probable':
      return { text: 'File sizes match an obfuscated post', tone: 'plain' }
    case 'size_only':
      return { text: 'Only the total size could be compared (packed or obfuscated post)', tone: 'plain' }
    case 'unverified': {
      const names = namesMatched(candidate)
      return { text: `Sizes differ from the listed release${names ? `; ${names}` : ''}`, tone: 'warn' }
    }
  }
  // A checked candidate without a proof level: say what was counted.
  return {
    text: candidate.sizes_known
      ? `${candidate.files_matched} of ${count(candidate.files_expected, 'episode file')} match by name and size`
      : `${namesMatched(candidate) || 'No file name could be compared'}; the post lists no file sizes to compare`,
    tone: 'plain',
  }
}

/** Where the post is from and how large it is: the facts an indexer reports before anything is fetched. */
export function candidateFacts(candidate: UsenetCandidate): string {
  return [
    candidate.indexer,
    candidate.size ? `~${formatBytes(candidate.size)}` : null,
    candidate.files ? count(candidate.files, 'file') : null,
    candidate.posted_at ? `posted ${displayDateTimeMinutes(candidate.posted_at)}` : null,
    candidate.info_url ? null : 'no indexer page available',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The sentence above a list of search results that are no proven copy. */
export function candidatesIntro(candidates: UsenetCandidate[]): string {
  const one = candidates.length === 1
  if (candidates.some(candidateChoosable))
    return `Found but not proven. Check ${one ? 'it' : 'them'} on the indexer; if one is this release, you can still download it.`
  if (candidates.every(candidate => !candidate.checked && !candidate.rejected && !candidate.unavailable))
    return `Found by the search and not checked yet. ${one ? 'It' : 'A result'} can be chosen once its NZB was fetched and read.`
  return `Found but not proven. ${one ? 'It cannot' : 'None can'} be downloaded from here.`
}

/** What the person confirms before an unproven NZB is sent, in the words of its proof level. */
export function candidateConfirmText(candidate: UsenetCandidate, group: string): string {
  switch (candidate.proof) {
    case 'probable':
      return `Its file sizes match what SeaDex lists for ${group}, but the post hides its file names, so they could not be compared.`
    case 'size_only':
      return `Only its total size could be compared with what SeaDex lists for ${group}: the post is packed or hides its file names.`
    case 'unverified': {
      const names = namesMatched(candidate)
      return `Its sizes differ from the files SeaDex lists for ${group}${names ? `; ${names}` : ''}.`
    }
  }
  return candidate.sizes_known
    ? `Only ${candidate.files_matched} of ${candidate.files_expected} episode files match what SeaDex lists for ${group}.`
    : `The post does not list file sizes, so only names could be compared: ${candidate.names_matched} of ${candidate.files_expected} episode file names match what SeaDex lists.`
}

// ---------------------------------------------------------------------------
// Bulk review: which rows the server is asked to check
// ---------------------------------------------------------------------------

/** What one open review already asked the server to check. A row is asked for once. */
export interface VerifyLedger {
  requested: Readonly<Record<string, RowRef>>
}

export const EMPTY_LEDGER: VerifyLedger = { requested: {} }

export interface VerifyPlan {
  /** Rows to send in `verify`. */
  verify: RowRef[]
  /** Rows whose requested check is no longer wanted, to send in `cancel_verify`. */
  cancel: RowRef[]
}

export const EMPTY_PLAN: VerifyPlan = { verify: [], cancel: [] }

/**
 * `wanted` are the rows chosen for Usenet right now. A row is verified when it still needs a search or a
 * check and this review has not asked for it before, so a check that proved nothing is not repeated. A
 * requested check that is still running for a row no longer chosen for Usenet is cancelled.
 */
export function planVerification(
  ledger: VerifyLedger,
  wanted: readonly RowRef[],
  rows: Readonly<Record<string, UsenetAvailabilityResult>>,
): VerifyPlan {
  const chosen = new Set(wanted.map(rowId))
  return {
    verify: wanted.filter(row => !(rowId(row) in ledger.requested) && awaitsCheck(rows[rowId(row)])),
    cancel: Object.entries(ledger.requested)
      .filter(([id]) => !chosen.has(id) && rows[id]?.refreshing === true)
      .map(([, row]) => row),
  }
}

/**
 * The ledger after the server received these rows. A cancelled row is forgotten: choosing it for Usenet
 * again asks for its check again, since the first one was dropped.
 */
export function recordVerification(ledger: VerifyLedger, sent: Partial<VerifyPlan>): VerifyLedger {
  if (!sent.verify?.length && !sent.cancel?.length) return ledger
  const requested = { ...ledger.requested }
  for (const row of sent.verify || []) requested[rowId(row)] = row
  for (const row of sent.cancel || []) delete requested[rowId(row)]
  return { requested }
}

/** The chosen rows whose check is about to be requested or still runs. The review waits for them. */
export function checksInProgress(
  ledger: VerifyLedger,
  wanted: readonly RowRef[],
  rows: Readonly<Record<string, UsenetAvailabilityResult>>,
  plan: VerifyPlan,
): RowRef[] {
  const planned = new Set(plan.verify.map(rowId))
  return wanted.filter(row => {
    const id = rowId(row)
    return planned.has(id) || (id in ledger.requested && rows[id]?.refreshing === true)
  })
}

/** Every check this review started that may still be queued, named when the review is closed. */
export function openChecks(
  ledger: VerifyLedger,
  rows: Readonly<Record<string, UsenetAvailabilityResult>>,
  plan: VerifyPlan,
): RowRef[] {
  const open = new Map(plan.verify.map(row => [rowId(row), row]))
  for (const [id, row] of Object.entries(ledger.requested)) if (rows[id]?.refreshing === true) open.set(id, row)
  return [...open.values()]
}

export function verifyProgressText(checks: number): string {
  return `Checking ${count(checks, 'release')} on Usenet. One NZB is fetched for each, and the review continues when ${checks === 1 ? 'the check is' : 'the checks are'} done.`
}

/** What Companion may still fetch from one indexer today. */
export function fetchesLeftText(usage: ProwlarrIndexerUsage): string {
  if (usage.paused_seconds) return `${usage.indexer}: paused for about ${aboutWait(usage.paused_seconds)}`
  if (usage.fetches_left === null) return `${usage.indexer}: no limit`
  if (usage.fetches_left > 0) return `${usage.indexer}: ${usage.fetches_left} left`
  return `${usage.indexer}: none left${usage.next_fetch_seconds ? `, next in about ${aboutWait(usage.next_fetch_seconds)}` : ''}`
}

export function usageText(usage: readonly ProwlarrIndexerUsage[] | undefined): string | null {
  return usage?.length ? `NZB checks left today: ${usage.map(fetchesLeftText).join(' · ')}` : null
}

/** How the NZB planned for a row was proven, when it was found through Prowlarr. */
export function plannedProof(preflight: DownloadPreflight | null, row: RowRef): UsenetProof | undefined {
  return preflight?.units.find(
    unit =>
      unit.provider === 'prowlarr' &&
      unit.selections.some(selection => selection.key === row.key && selection.release === row.release),
  )?.proof
}

/** The note under a plan that sends near-exact NZBs. */
export function nearExactNote(preflight: DownloadPreflight | null): string | null {
  const units = (preflight?.units || []).filter(unit => unit.status === 'new' && unit.proof === 'near_exact').length
  if (!units) return null
  return `${units === 1 ? '1 NZB is a near-exact match' : `${units} NZBs are near-exact matches`}: every file name matches and the sizes fit, but the post does not state exact sizes.`
}

// ---------------------------------------------------------------------------
// Background sweep and Prowlarr settings
// ---------------------------------------------------------------------------

export interface SweepProgress {
  label: string
  checked: number
  total: number
  /** Shown when no indexer is paused. */
  detail: string
}

/** The stage of the background Usenet sweep to show: the hash lookups, then the Prowlarr search that follows. */
export function sweepProgress(usenet: UsenetPrefetchProgress): SweepProgress {
  const search = usenet.search
  if (search && (usenet.total === 0 || usenet.checked >= usenet.total))
    return {
      label: 'Searching Usenet indexers',
      checked: search.checked,
      total: search.total,
      detail: `Searching Prowlarr for ${count(search.total, 'release')}. No NZB is fetched.`,
    }
  return {
    label: 'Matching Usenet sources',
    checked: usenet.checked,
    total: usenet.total,
    detail: `Checking ${usenet.total} releases against the Usenet indexers.${search ? ` A Prowlarr search of ${count(search.total, 'release')} follows.` : ''}`,
  }
}

export const PROWLARR_SEARCH_LIMIT = { max: 10_000, fallback: 100 }
export const PROWLARR_FETCH_LIMIT = { max: 1_000, fallback: 20 }

/** A typed limit as the whole number the server accepts: nothing or nonsense is 0, which means no limit. */
export function limitValue(text: string, max: number): number {
  const value = Math.floor(Number(text))
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : 0
}

/** What turning on the background search would cost for the current library. */
export function expectedSearchesText(status: ProwlarrSearchStatus): string {
  if (!status.usenet_indexers) return 'Prowlarr reports no Usenet indexer, so there is nothing to search.'
  if (!status.eligible_sources) return 'No release in the current library needs a Prowlarr search.'
  if (!status.pending_sources)
    return `All ${count(status.eligible_sources, 'release')} of the current library that Prowlarr can look for have recent search results.`
  const searches = count(status.pending_sources, 'search', 'searches')
  const where =
    status.usenet_indexers > 1
      ? `on each of your ${status.usenet_indexers} Usenet indexers, about ${status.pending_sources * status.usenet_indexers} in total`
      : 'on your Usenet indexer'
  return `For the current library: about ${searches} ${where}. ${count(status.pending_sources, 'release')} of ${status.eligible_sources} still ${status.pending_sources === 1 ? 'needs' : 'need'} a search.`
}

/** The latest background sweep, one fact per line. */
export function sweepSummaryLines(summary: UsenetSearchSummary): string[] {
  const lines = [
    `${count(summary.searched, 'release')} searched: ${summary.with_candidates} with results, ${summary.without_candidates} without.`,
  ]
  if (summary.failed) lines.push(`${count(summary.failed, 'search', 'searches')} failed and will be tried again.`)
  if (summary.deferred)
    lines.push(
      `${count(summary.deferred, 'release')} left for later, because an indexer reached its daily search limit.`,
    )
  if (summary.queries.length)
    lines.push(`Searches sent: ${summary.queries.map(entry => `${entry.indexer} ${entry.count}`).join(' · ')}`)
  return lines
}
