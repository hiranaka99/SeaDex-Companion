// What a release row can do with its release, decided per card: the send verdict its download button shows,
// and the one-click send behind it. The card answers a row by season and release; the season details only lay
// the rows out.

import { downloadCategory } from '../../shared/arr-instances.js'
import { normalizeTorrentPath as normalizeFile, releaseForbidden, releaseOwned } from '../../shared/download-plan.js'
import { estimateDownloads } from '../../shared/download-estimate.js'
import { episodeRangeLabel, releaseIdentity } from '../../shared/releases.js'
import { EPISODE_MISFIT_TITLE, episodeMisfitDetail } from '../../shared/episode-order.js'
import type { UsenetAvailabilityResult } from '../../shared/usenet-contracts.js'
import { errorMessage } from '../../shared/errors.js'
import type { DiskSpaceCheck, DownloadProtocol, preflightDownload, sendDownload } from './api.js'
import { clientName, phaseLabel, protocolClientName, type DownloadEntry } from './download-entry.js'
import type { DownloadRoutes, ReleaseRoute } from './download-routes.js'
import type { Config, Release, ResultItem } from './types.js'
import { describeUsenet } from './usenet-review.js'
import { formatBytes, seasonLabel } from './utils.js'

/**
 * The release's Usenet availability, when the answer is about this very release. SeaDex can replace the release at
 * an index while an older answer is still cached, and that answer must not decide the new release's send.
 */
export const currentAvailability = (
  byRelease: Record<number, UsenetAvailabilityResult> | undefined,
  release: Release,
  index: number,
): UsenetAvailabilityResult | undefined =>
  byRelease?.[index]?.identity === releaseIdentity(release) ? byRelease[index] : undefined

/** The files a torrent send of this release covers, and how sure their size is. */
export interface ReleaseFileScope {
  /** Release preferences picked some of the release's files. */
  selected: boolean
  /** The size is known to the byte. */
  exact: boolean
  bytes: number
  /** An estimate of the whole release when its file list is incomplete. */
  approximateBytes: number | null
  files: { name: string; size: number | null }[]
}

export function releaseFileScope(rel: Release): ReleaseFileScope {
  const estimate = estimateDownloads([{ release: rel, category: '' }])
  const privateFiles = rel.torrent_available ? [] : (rel.private_sources || []).flatMap(source => source.files)
  const selected = [...new Map((rel.selected_files || []).map(name => [normalizeFile(name), name])).values()]
  // SeaDex lists a private torrent's files with exact sizes, even without its hash.
  const privateBytes = privateFiles.length
    ? (selected.length
        ? privateFiles.filter(file => selected.some(name => normalizeFile(name) === normalizeFile(file.name)))
        : privateFiles
      ).reduce((sum, file) => sum + file.length, 0)
    : null
  const exact =
    privateBytes !== null ||
    (estimate.torrents.length > 0 && estimate.unknown_torrents === 0 && estimate.approximate_torrents === 0)
  const catalogs = new Map<string, { name: string; sizes: number[] }>()
  const sources = [
    ...(rel.torrent_files || []).filter(catalog =>
      rel.info_hashes.some(hash => hash.toLowerCase() === catalog.hash.toLowerCase()),
    ),
    ...(privateFiles.length ? [{ hash: '', files: privateFiles }] : []),
  ]
  for (const catalog of sources) {
    for (const file of catalog.files) {
      const key = normalizeFile(file.name)
      const current = catalogs.get(key) || { name: file.name, sizes: [] }
      current.sizes.push(file.length)
      catalogs.set(key, current)
    }
  }
  const names = selected.length ? selected : [...catalogs.values()].map(file => file.name)
  return {
    selected: selected.length > 0,
    exact,
    bytes: privateBytes ?? estimate.new_bytes,
    approximateBytes:
      !selected.length && estimate.unknown_torrents === 0 && estimate.torrents.length > 0 ? estimate.new_bytes : null,
    files: names.map(name => {
      const sizes = catalogs.get(normalizeFile(name))?.sizes || []
      const size = sizes.length === 1 && Number.isSafeInteger(sizes[0]) && sizes[0] >= 0 ? sizes[0] : null
      return { name, size }
    }),
  }
}

/** What a release row's download button offers, decided in one place. */
export interface SendVerdict {
  /** The protocol a send uses. */
  protocol: DownloadProtocol
  label: string
  /** A send can start: nothing of this release is in a client yet and the protocol can receive it. */
  enabled: boolean
  /** Where an enabled send goes, or why the release cannot be sent. */
  reason: string
  /** The row's recommended next step: the preferred target, or SeaDex's best release when nothing is targeted. */
  recommended: boolean
  /** What an enabled send covers and where it goes; empty when no send is possible. */
  facts: string
}

/**
 * The category the server files a send of this result under, as the row names it. A blank category, or an instance
 * that no longer exists, sends the release without one.
 */
export function categoryPhrase(config: Config | null, result: ResultItem, protocol: DownloadProtocol): string {
  const category = config ? downloadCategory(config, result, protocol) : ''
  return category ? `(category: ${category})` : 'without a category'
}

export interface SendVerdictInput {
  result: ResultItem
  release: Release
  config: Config | null
  routes: DownloadRoutes
  route: ReleaseRoute
  /** The release's Usenet availability, already checked against its identity. */
  availability?: UsenetAvailabilityResult
  transfers: DownloadEntry[]
  /** Computed by the caller when it already has it; derived from the release otherwise. */
  fileScope?: ReleaseFileScope
}

export function sendVerdict({
  result: r,
  release: rel,
  config,
  routes,
  route,
  availability,
  transfers,
  fileScope = releaseFileScope(rel),
}: SendVerdictInput): SendVerdict {
  const active = transfers.filter(transfer => transfer.phase !== 'complete')
  const complete = transfers.length > 0 && active.length === 0
  const inClient = active.length > 0
  const protocol = route.protocol
  const usable = protocol === 'torrent' ? route.torrent.sendable : route.usenet.sendable
  const enabled = !inClient && !complete && usable
  const owned = releaseOwned(r, rel)
  const categoryNote = categoryPhrase(config, r, protocol)
  const fileCount = `${fileScope.files.length} selected file${fileScope.files.length === 1 ? '' : 's'}`

  const reason = complete
    ? `Download completed in ${clientName(transfers[0].client)}`
    : inClient
      ? `${phaseLabel(active[0].phase)} in ${clientName(active[0].client)}`
      : !usable && route.blocked
        ? route.blocked
        : protocol === 'usenet'
          ? usable
            ? `Send this release to SABnzbd ${categoryNote}`
            : usenetDetail(rel, routes, availability) || 'Usenet is not available for this release'
          : rel.torrent_available
            ? `Send this release to qBittorrent ${categoryNote}`
            : route.torrent.viaProwlarr
              ? `Find this release on ${rel.tracker.trim() || 'its tracker'} through Prowlarr, check its files, and send it to qBittorrent ${categoryNote}`
              : 'No magnet available (private tracker)'
  const label = complete
    ? 'Download completed'
    : inClient
      ? phaseLabel(active[0].phase)
      : !usable
        ? protocol === 'usenet'
          ? 'Usenet unavailable'
          : 'Unavailable'
        : protocol === 'usenet'
          ? owned
            ? 'Re-download on Usenet'
            : 'Download on Usenet'
          : fileScope.selected
            ? `${owned ? 'Re-download' : 'Download'} ${fileScope.files.length} file${fileScope.files.length === 1 ? '' : 's'}`
            : owned
              ? 'Re-download'
              : 'Download release'
  // Movies have no episodes; a number in a movie's filename is a version, year or audio layout.
  const episodes = r.arr === 'Sonarr' ? episodeRangeLabel(fileScope.files.map(file => file.name)) : null
  const facts = enabled
    ? [
        protocol === 'usenet' ? 'Whole Usenet source' : fileScope.selected ? fileCount : 'Whole release',
        protocol === 'torrent' ? episodes : null,
        protocol === 'torrent' && route.torrent.viaProwlarr ? 'found through Prowlarr' : null,
        `to ${protocolClientName(protocol)}`,
        'free space checked on send',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  // Owned and excluded releases stay available but never look like the next step.
  const recommended =
    !owned &&
    !rel.excluded_by &&
    (rel.target === true || (rel.kind === 'best' && !r.releases.some(other => other.target)))
  return { protocol, label, enabled, reason, recommended, facts }
}

/** What a release card says about an excluded release, and whether the release can still be downloaded on its own. */
export interface ExclusionNote {
  title: string
  detail: string
  downloadable: boolean
}

/**
 * Why a release is excluded, in the words its kind calls for. Results saved before exclusions had a kind carry a
 * preference reason or an unreachable tracker, which both read as today's preference copy.
 */
export function exclusionNote(result: ResultItem, rel: Release): ExclusionNote | null {
  if (!rel.excluded_by) return null
  if (releaseForbidden(rel))
    return {
      title: EPISODE_MISFIT_TITLE,
      detail: rel.episode_misfit
        ? episodeMisfitDetail(rel.releaseGroup, result.season, rel.episode_misfit)
        : 'Sonarr would import its files onto the wrong episodes.',
      downloadable: false,
    }
  if (rel.excluded_kind === 'unreachable_tracker')
    return {
      title: `${rel.excluded_by}, so another release is your target.`,
      detail: 'Bulk download skips it.',
      downloadable: true,
    }
  return {
    title: `Excluded by your release preferences: ${rel.excluded_by}.`,
    detail: 'Bulk download skips it.',
    downloadable: true,
  }
}

const usenetDetail = (rel: Release, routes: DownloadRoutes, availability: UsenetAvailabilityResult | undefined) =>
  routes.usenetAllowed
    ? describeUsenet(availability, routes.usenetReady, Boolean(rel.private_sources?.length), routes.prowlarrConfigured)
        ?.detail
    : undefined

/** One release of one season: the season's result key and the release's index in it. */
export interface ReleaseRef {
  key: string
  release: number
}

/** Identifies one release of one season in per-release download state. */
export const sendKey = (ref: ReleaseRef) => `${ref.key}\u0000${ref.release}`

/** Whether `held` is about the release `ref` names. */
export const sameRelease = (held: ReleaseRef | null, ref: ReleaseRef) =>
  held !== null && held.key === ref.key && held.release === ref.release

/**
 * A one-click send that stopped before submission because the fit on disk is not established: a client reported
 * too little free space (`low`), or did not report free space at all (`unknown`).
 */
export interface LowSpaceHold extends ReleaseRef {
  protocol: DownloadProtocol
  /** An unproven NZB the user chose, sent again by "Send anyway". */
  nzb?: string
  reason: 'low' | 'unknown'
  checks: DiskSpaceCheck[]
}

/** One-click send state of a card. */
export interface ReleaseSendsState {
  /** The release whose send is running; every other send on the card waits for it. */
  sending: ReleaseRef | null
  lowSpace: LowSpaceHold | null
  /** The last failed send per release (`sendKey`), shown in that release's row until it is retried or dismissed. */
  errors: Record<string, string>
}

/** The part of the api a one-click send uses. */
export interface SendApi {
  preflightDownload: typeof preflightDownload
  sendDownload: typeof sendDownload
}

/** Shows a toast. */
export type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

export interface ReleaseSendsOptions {
  api: SendApi
  /** Refreshes download progress once a send settled. */
  reload: () => Promise<void>
  notify: Notify
  /** Details are open, so a failure belongs to the release row rather than to a notification. */
  detailsShown: () => boolean
}

/** "412 GB free" when every destination reported its free space and they all agree on one figure. */
function freeSpaceNote(checks: DiskSpaceCheck[]): string {
  const free = [...new Set(checks.map(check => check.free_bytes))]
  return free.length === 1 && free[0] !== null ? ` · ${formatBytes(free[0]) || '0 B'} free` : ''
}

/**
 * The one-click sends of one card. A send pauses only when free space is not established: a client reports less
 * free space than the release needs, or reports no free space at all. The release row then asks before sending. An
 * estimated size with known free space, and whole Usenet sources, send without asking.
 */
export function createReleaseSends({ api, reload, notify, detailsShown }: ReleaseSendsOptions) {
  let state: ReleaseSendsState = { sending: null, lowSpace: null, errors: {} }
  const listeners = new Set<() => void>()
  let aborter: AbortController | null = null
  const update = (changes: Partial<ReleaseSendsState>) => {
    state = { ...state, ...changes }
    for (const listener of [...listeners]) listener()
  }
  const setError = (ref: ReleaseRef, message: string | null) => {
    const id = sendKey(ref)
    if (message !== null) return update({ errors: { ...state.errors, [id]: message } })
    if (!(id in state.errors)) return
    const { [id]: _, ...rest } = state.errors
    update({ errors: rest })
  }

  const run = async (season: ResultItem, index: number, protocol: DownloadProtocol, anyway: boolean, nzb?: string) => {
    if (state.sending) return
    const release = season.releases[index]
    if (!release) return
    const key = season.key
    const ref: ReleaseRef = { key, release: index }
    const label = `${seasonLabel(season)} · ${release.releaseGroup || season.title}`
    const controller = new AbortController()
    aborter = controller
    update({ sending: ref, ...(sameRelease(state.lowSpace, ref) ? { lowSpace: null } : {}) })
    setError(ref, null)
    // A failure belongs to the release row while Details is open; a closed modal falls back to a notification.
    const report = (message: string) => {
      setError(ref, message)
      if (!detailsShown()) notify(`Could not send ${label}: ${message}`, 'error')
    }
    try {
      const preflight = await api.preflightDownload(
        [{ key, release: index, identity: releaseIdentity(release), protocol, ...(nzb ? { nzb } : {}) }],
        true,
        controller.signal,
      )
      if (controller.signal.aborted) return
      const blocked = preflight.blocked.find(row => row.key === key && row.release === index)
      if (blocked) throw new Error(blocked.reason)
      if (!preflight.units.length) throw new Error('This release is already queued in the download client')
      const low = preflight.disk_space.some(check => check.sufficient === false)
      const unknown = preflight.disk_space.some(check => check.free_bytes === null)
      if (!anyway && (low || unknown)) {
        update({
          lowSpace: {
            ...ref,
            protocol,
            ...(nzb ? { nzb } : {}),
            reason: low ? 'low' : 'unknown',
            checks: preflight.disk_space,
          },
        })
        return
      }
      const outcome = await api.sendDownload(preflight.plan_id, protocol, { whole_source: true, disk_space: true })
      if (outcome.kind === 'rejected') report(outcome.reason)
      else if (outcome.kind === 'acceptance_unknown') {
        const where = clientName(outcome.client)
        report(
          `${outcome.reason ?? `${where} was asked to start this download but did not confirm it.`} Check ${where} before retrying.`,
        )
      } else notify(`Sent ${label} to ${clientName(outcome.client)}${freeSpaceNote(preflight.disk_space)}`, 'success')
    } catch (error) {
      if (controller.signal.aborted) return
      report(errorMessage(error))
    } finally {
      update({ sending: null })
      await reload()
    }
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Sends one release with one click; `nzb` is an unproven NZB the user chose, always sent over Usenet. */
    send: (season: ResultItem, index: number, protocol: DownloadProtocol, nzb?: string) =>
      run(season, index, nzb ? 'usenet' : protocol, false, nzb),
    /** Repeats the send held for low free space, the chosen NZB included, without asking again. */
    sendAnyway: async (season: ResultItem, index: number) => {
      const held = state.lowSpace
      if (held && sameRelease(held, { key: season.key, release: index }))
        await run(season, index, held.protocol, true, held.nzb)
    },
    cancelLowSpace: () => update({ lowSpace: null }),
    dismissError: (key: string, index: number) => setError({ key, release: index }, null),
    /** Stops a running send whose card went away; nothing is reported for it. */
    abort: () => aborter?.abort(),
  }
}

export type ReleaseSends = ReturnType<typeof createReleaseSends>
