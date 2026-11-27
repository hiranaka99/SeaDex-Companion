import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { releaseIdentity } from '../../shared/releases'
import * as api from './api'
import type { DownloadProtocol, UsenetAvailabilityResult } from './api'
import type { DownloadEntry } from './download-entry'
import { downloadRoutes, type DownloadRoutes, type ReleaseRoute } from './download-routes'
import { reloadDownloads } from './download-store'
import {
  createReleaseSends,
  currentAvailability,
  sendKey,
  sendVerdict,
  type LowSpaceHold,
  type SendVerdict,
} from './release-actions'
import type { Config, GroupedCard, ResultItem } from './types'
import { useCardDownloads, useSeasonAvailability } from './useCardDownloads'

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

/** Everything one release row shows about sending its release, and everything it can do with it. */
export interface ReleaseActions {
  /** Owned downloads of this release. */
  transfers: DownloadEntry[]
  /** A pause, resume or remove is running on this card. */
  busy: boolean
  /** This release is being sent right now. */
  sending: boolean
  /** Some release on this card is being sent, so no other send may start. */
  sendLocked: boolean
  /** A send of this release that stopped for the low-space decision. */
  lowSpace: LowSpaceHold | null
  /** Why the last send of this release failed. */
  error: string | null
  /** Usenet availability of this very release. */
  availability: UsenetAvailabilityResult | undefined
  availabilityLoading: boolean
  route: ReleaseRoute
  /** The protocol a send uses, with the download mode and the person's choice applied. */
  protocol: DownloadProtocol
  verdict: SendVerdict
  send: () => void
  /** Sends the release held for low free space without asking again. */
  sendAnyway: () => void
  /** Sends an unproven NZB the person chose from a Prowlarr search; always over Usenet. */
  sendNzb: (nzb: string) => void
  pickProtocol: (protocol: DownloadProtocol) => void
  /** Searches Prowlarr's Usenet indexers for this release now. */
  search: () => void
  /** Fetches the best search result's NZB and compares its files with this release. */
  check: () => void
  /** Re-checks the season's Usenet sources. */
  refresh: () => void
  cancelLowSpace: () => void
  dismissError: () => void
  pause: (entry: DownloadEntry) => void
  resume: (entry: DownloadEntry) => void
  /** Asks the card to confirm removing a download. */
  remove: (entry: DownloadEntry) => void
}

/** What a season's details need beyond layout: its availability state, and each release row's actions. */
export interface SeasonActions {
  routes: DownloadRoutes
  /** The last Usenet refresh of this season failed; last-known answers stay shown. */
  availabilityError: string | null
  /** Releases with a download still running, whose rows open on their own. */
  activeReleases: number[]
  /** The season's details opened, so its Usenet availability is looked up. */
  opened: () => void
  release: (index: number) => ReleaseActions
}

interface Options {
  notify: Notify
  /** Details are open, so the season availability is observed. */
  detailsOpen: boolean
  /** Details are open right now; a failed send is shown in its row rather than notified. */
  detailsShown: () => boolean
  /** Opens the card's remove confirmation for a download. */
  onRemove: (entry: DownloadEntry) => void
}

/** The per-card release actions: a release row asks by season and release. */
export function useReleaseActions(group: GroupedCard, config: Config | null, options: Options) {
  const { notify, detailsOpen } = options
  const { dlBySeason, activeDownloads, busyDownload, handleDownloadAction } = useCardDownloads(group, notify)
  const routes = useMemo(() => downloadRoutes(config), [config])
  const configScope = routes.availabilityFingerprint
  const { availability, load, revision } = useSeasonAvailability(
    routes.usenetAllowed,
    group.seasons,
    detailsOpen,
    configScope,
  )
  const latest = useRef(options)
  latest.current = options
  const [sends] = useState(() =>
    createReleaseSends({
      api,
      reload: reloadDownloads,
      notify: (message, tone) => latest.current.notify(message, tone),
      detailsShown: () => latest.current.detailsShown(),
    }),
  )
  const sendState = useSyncExternalStore(sends.subscribe, sends.getState)
  useEffect(() => () => sends.abort(), [sends])
  /** Protocols the person picked, forgotten when the release, its availability or the configuration change. */
  const [protocols, setProtocols] = useState<Record<string, DownloadProtocol>>({})

  const season = (item: ResultItem): SeasonActions => {
    const key = item.key
    const seasonAvailability = availability[key]
    const downloads = dlBySeason[key] || {}
    return {
      routes,
      availabilityError: seasonAvailability?.error ?? null,
      activeReleases: Object.entries(downloads)
        .filter(([, state]) => state.transfers.some(transfer => transfer.phase !== 'complete'))
        .map(([index]) => Number(index)),
      opened: () => void load(item),
      release(index) {
        const release = item.releases[index]
        const protocolKey = `${revision}\u0000${configScope}\u0000${key}\u0000${releaseIdentity(release)}`
        const rowAvailability = currentAvailability(seasonAvailability?.byRelease, release, index)
        const route = routes.release(release, rowAvailability, protocols[protocolKey])
        const transfers = downloads[index]?.transfers || []
        return {
          transfers,
          busy: busyDownload !== null,
          sending: sendState.sending?.key === key && sendState.sending.release === index,
          sendLocked: sendState.sending !== null,
          lowSpace: sendState.lowSpace?.key === key && sendState.lowSpace.release === index ? sendState.lowSpace : null,
          error: sendState.errors[sendKey(key, index)] ?? null,
          availability: rowAvailability,
          availabilityLoading: Boolean(seasonAvailability?.loading),
          route,
          protocol: route.protocol,
          verdict: sendVerdict({
            result: item,
            release,
            config,
            routes,
            route,
            availability: rowAvailability,
            transfers,
          }),
          send: () => void sends.send(item, index, route.protocol),
          sendAnyway: () => void sends.sendAnyway(item, index),
          sendNzb: nzb => void sends.send(item, index, 'usenet', nzb),
          pickProtocol: protocol => setProtocols(current => ({ ...current, [protocolKey]: protocol })),
          search: () => void load(item, false, { search: index }),
          check: () => void load(item, false, { verify: index }),
          refresh: () => void load(item, true),
          cancelLowSpace: sends.cancelLowSpace,
          dismissError: () => sends.dismissError(key, index),
          pause: entry => void handleDownloadAction(entry, 'pause'),
          resume: entry => void handleDownloadAction(entry, 'resume'),
          remove: entry => latest.current.onRemove(entry),
        }
      },
    }
  }

  return { activeDownloads, busyDownload, handleDownloadAction, season }
}
