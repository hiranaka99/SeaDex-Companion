// Which client can receive a release, which protocol a send defaults to, and why neither works, decided once
// from the configuration and what Prowlarr's indexers cover. Card, release details and bulk review read
// these answers instead of the configuration flags, so they cannot disagree.

import type { DownloadMode, DownloadProtocol } from '../../shared/download-contracts.js'
import { DEFAULT_TRACKER_MODE } from '../../shared/settings.js'
import type { UsenetAvailabilityResult } from '../../shared/usenet-contracts.js'
import type { Config, Release } from './types.js'

type TorrentFacts = Pick<Release, 'torrent_available' | 'private_sources' | 'tracker'>

/** Prowlarr is switched on and has a URL and key; whether its indexers can find anything is asked separately. */
export const prowlarrConfigured = (config: Config | null | undefined): boolean =>
  Boolean(config?.prowlarr_enabled && config.prowlarr_url && config.prowlarr_key_configured)

/**
 * Prowlarr is set up and Release preferences include private trackers, so private-tracker releases can be found.
 * Only public-tracker mode leaves them out; the other two modes both search for them.
 */
export const prowlarrReady = (config: Config | null | undefined): boolean =>
  prowlarrConfigured(config) && (config?.tracker_mode || DEFAULT_TRACKER_MODE) !== 'public'

/**
 * A private-tracker release Prowlarr can look for: SeaDex lists its files but no public torrent, and Prowlarr
 * has an indexer for its tracker.
 */
export const findsPrivateTorrent = (release: TorrentFacts, config: Config | null | undefined): boolean =>
  !release.torrent_available &&
  Boolean(release.private_sources?.length) &&
  prowlarrReady(config) &&
  Boolean(
    config?.prowlarr_coverage?.trackers.some(
      tracker => tracker.trim().toLowerCase() === release.tracker.trim().toLowerCase(),
    ),
  )

/**
 * The settings Usenet availability answers depend on: the indexers asked, the private trackers searched for,
 * and SABnzbd. A change makes every cached answer stale. The download mode is not part of it; the routes apply
 * the mode to whatever availability says.
 */
export const availabilityFingerprint = (config: Config | null | undefined): string =>
  JSON.stringify([
    config?.animetosho_enabled,
    config?.animetosho_url,
    config?.amenzb_enabled,
    config?.amenzb_url,
    config?.amenzb_key_configured,
    config?.prowlarr_enabled,
    config?.prowlarr_url,
    config?.prowlarr_key_configured,
    config?.tracker_mode,
    config?.sabnzbd_url,
    config?.sabnzbd_key_configured,
  ])

export interface TorrentRoute {
  /** qBittorrent can be sent this release: the mode allows torrents and there is a magnet or a Prowlarr find. */
  sendable: boolean
  /** The torrent is a private-tracker one the server finds through Prowlarr and checks before sending. */
  viaProwlarr: boolean
}

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

export interface UsenetRoute {
  /** SABnzbd can be sent a proven copy of this release now. */
  sendable: boolean
  /**
   * SABnzbd is ready and a Prowlarr search or NZB check can still prove a copy. A pending check counts as a
   * Usenet route everywhere: the release is offered for Usenet and defaults to it when no torrent works.
   */
  pending: boolean
}

export interface ReleaseRoute {
  torrent: TorrentRoute
  usenet: UsenetRoute
  /** The protocol a send uses: the download mode's, else the one chosen, else the one that works. */
  protocol: DownloadProtocol
  /** Why neither route can send the release; null when one can or a pending check still may. */
  blocked: string | null
}

export interface DownloadRoutes {
  readonly mode: DownloadMode
  /** The mode sends to SABnzbd, so Usenet availability is looked up and shown, set up or not. */
  readonly usenetAllowed: boolean
  /** The mode sends to SABnzbd and SABnzbd is set up, so Usenet can receive releases. */
  readonly usenetReady: boolean
  /** Prowlarr is switched on and has a URL and key. */
  readonly prowlarrConfigured: boolean
  /** Changes whenever cached Usenet availability no longer answers for this configuration. */
  readonly availabilityFingerprint: string
  /**
   * Usenet can be asked about this release: SABnzbd is ready, and the release has a public hash or Prowlarr has
   * Usenet indexers to search for a private-tracker release.
   */
  usenetSearchable(release: Release): boolean
  /** What one release can be sent through, given its Usenet availability and any protocol the user chose. */
  release(release: Release, row: UsenetAvailabilityResult | undefined, chosen?: DownloadProtocol): ReleaseRoute
}

export function downloadRoutes(config: Config | null | undefined): DownloadRoutes {
  const mode: DownloadMode = config?.download_mode || 'torrent_only'
  const torrentAllowed = mode !== 'usenet_only'
  const torrent = (release: TorrentFacts): TorrentRoute => {
    const viaProwlarr = findsPrivateTorrent(release, config)
    return { sendable: torrentAllowed && (release.torrent_available || viaProwlarr), viaProwlarr }
  }
  const usenetAllowed = Boolean(config) && mode !== 'torrent_only'
  const usenetReady = usenetAllowed && Boolean(config?.sabnzbd_url && config.sabnzbd_key_configured)
  const usenet = (row: UsenetAvailabilityResult | undefined): UsenetRoute => ({
    sendable: usenetReady && row?.aggregate === 'available',
    pending: usenetReady && awaitsCheck(row),
  })
  const privateUsenet = prowlarrReady(config) && config?.prowlarr_coverage?.usenet === true
  const blockedReason = (release: Release, row: UsenetAvailabilityResult | undefined): string => {
    const tracker = release.tracker.trim() || 'its tracker'
    const reasons = [
      torrentAllowed &&
        (prowlarrReady(config) && config?.prowlarr_coverage
          ? `No public magnet, and Prowlarr has no indexer for ${tracker}`
          : `No public magnet: ${tracker} is a private tracker`),
      usenetAllowed &&
        (!usenetReady ? 'Usenet needs SABnzbd' : row ? 'No Usenet copy found' : 'Usenet not checked yet'),
    ]
    return reasons.filter(Boolean).join('; ')
  }
  return {
    mode,
    usenetAllowed,
    usenetReady,
    prowlarrConfigured: prowlarrConfigured(config),
    availabilityFingerprint: availabilityFingerprint(config),
    usenetSearchable: release =>
      usenetReady &&
      ((release.info_hashes?.length || 0) > 0 || (privateUsenet && Boolean(release.private_sources?.length))),
    release(release, row, chosen) {
      const routes = { torrent: torrent(release), usenet: usenet(row) }
      const usenetWorks = routes.usenet.sendable || routes.usenet.pending
      const route = { ...routes, blocked: routes.torrent.sendable || usenetWorks ? null : blockedReason(release, row) }
      if (mode === 'torrent_only') return { ...route, protocol: 'torrent' }
      if (mode === 'usenet_only') return { ...route, protocol: 'usenet' }
      if (chosen) return { ...route, protocol: chosen }
      return { ...route, protocol: !routes.torrent.sendable && usenetWorks ? 'usenet' : 'torrent' }
    },
  }
}
