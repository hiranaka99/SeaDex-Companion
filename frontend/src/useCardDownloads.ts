import { errorMessage } from '../../shared/errors.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  currentDownloadAssociations,
  getDownloadSnapshot,
  subscribeDownloads,
  reloadDownloads,
  controlDownload,
} from './download-store'
import * as api from './api'
import { releaseIdentity } from '../../shared/releases'
import type { Release, ResultItem, GroupedCard } from './types'

import type { DownloadEntry } from './components/DownloadsPanel'
import { toDownloadEntry, clientName, importUnsettled } from './components/DownloadsPanel'
import { formatBytes, seasonLabel } from './utils'
import type { DiskSpaceCheck, DownloadProtocol, UsenetAvailabilityResult } from './api'
import { availabilityKey, observeUsenetAvailability, type AvailabilitySnapshot } from './usenet-observation'

export interface DetailsDownloadState {
  transfers: DownloadEntry[]
}
export const IDLE_DOWNLOAD: DetailsDownloadState = { transfers: [] }

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

/**
 * A one-click send that stopped before submission because the fit on disk is not established: a client reported
 * too little free space (`low`), or did not report free space at all (`unknown`).
 */
export interface LowSpaceHold {
  key: string
  release: number
  protocol: DownloadProtocol
  /** An unproven NZB the user chose, sent again by "Send anyway". */
  nzb?: string
  reason: 'low' | 'unknown'
  checks: DiskSpaceCheck[]
}

/** "412 GB free" when every destination reported its free space and they all agree on one figure. */
function freeSpaceNote(checks: DiskSpaceCheck[]): string {
  const free = [...new Set(checks.map(check => check.free_bytes))]
  return free.length === 1 && free[0] !== null ? ` · ${formatBytes(free[0]) || '0 B'} free` : ''
}

/** Identifies one release of one season in per-release download state. */
export const sendKey = (key: string, release: number) => `${key}\u0000${release}`

/** Record controls and one-click sending for a canonical release intent. */
export function useCardDownloads(group: GroupedCard, notify: Notify, detailsShown: () => boolean) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)
  const sending = useRef(false)
  /** The release whose one-click send is running, so its button can show progress and others stay locked. */
  const [sendingRelease, setSendingRelease] = useState<{ key: string; release: number } | null>(null)
  const [lowSpace, setLowSpace] = useState<LowSpaceHold | null>(null)
  /** The last failed send per release, shown in that release's row until it is retried or dismissed. */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  const aborter = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      aborter.current?.abort()
    },
    [],
  )

  const dlBySeason: Record<string, Record<number, DetailsDownloadState>> = {}
  const activeDownloads: DownloadEntry[] = []
  for (const progress of Object.values(snapshot)) {
    if (!progress.associations.some(ref => group.seasons.some(season => season.key === ref.key))) continue
    const entry = toDownloadEntry(progress)
    const associations = currentDownloadAssociations(progress, group.seasons)
    for (const ref of associations) {
      const state = ((dlBySeason[ref.key] ||= {})[ref.release] ||= { transfers: [] })
      state.transfers.push(entry)
    }
    // A finished download stays on the card until Sonarr or Radarr imported it or the person dealt with it.
    if (progress.phase !== 'complete' || !associations.length || importUnsettled(entry)) activeDownloads.push(entry)
  }

  const setSendError = (key: string, index: number, message: string | null) =>
    setSendErrors(current => {
      const id = sendKey(key, index)
      if (message === null) {
        if (!(id in current)) return current
        const { [id]: _, ...rest } = current
        return rest
      }
      return { ...current, [id]: message }
    })

  /**
   * Sends one release with one click. It pauses only when free space is not established: a client reports less free
   * space than the release needs, or reports no free space at all. The release row then asks before sending. An
   * estimated size with known free space, and whole Usenet sources, send without asking.
   */
  const handleDownload = async (
    key: string,
    index: number,
    protocol: DownloadProtocol,
    sendAnyway = false,
    /** An unproven NZB the user chose for a private-tracker release; always sent over Usenet. */
    nzb?: string,
  ) => {
    if (sending.current) return
    const season = group.seasons.find(item => item.key === key)
    const release: Release | undefined = season?.releases[index]
    if (!season || !release) return
    const identity = releaseIdentity(release)
    const label = `${seasonLabel(season)} · ${release.releaseGroup || season.title}`
    const controller = new AbortController()
    aborter.current = controller
    sending.current = true
    setSendingRelease({ key, release: index })
    setSendError(key, index, null)
    setLowSpace(current => (current?.key === key && current.release === index ? null : current))
    // A failure belongs to the release row while Details is open; a closed modal falls back to a notification.
    const report = (message: string) => {
      setSendError(key, index, message)
      if (!detailsShown()) notify(`Could not send ${label}: ${message}`, 'error')
    }
    try {
      const preflight = await api.preflightDownload(
        [{ key, release: index, identity, protocol, ...(nzb ? { nzb } : {}) }],
        true,
        controller.signal,
      )
      if (controller.signal.aborted) return
      const blocked = preflight.blocked.find(row => row.key === key && row.release === index)
      if (blocked) throw new Error(blocked.reason)
      if (!preflight.units.length) throw new Error('This release is already queued in the download client')
      const low = preflight.disk_space.some(check => check.sufficient === false)
      const unknown = preflight.disk_space.some(check => check.free_bytes === null)
      if (!sendAnyway && (low || unknown)) {
        setLowSpace({
          key,
          release: index,
          protocol,
          ...(nzb ? { nzb } : {}),
          reason: low ? 'low' : 'unknown',
          checks: preflight.disk_space,
        })
        return
      }
      const receipt = await api.submitDownload(preflight.plan_id, { whole_source: true, disk_space: true })
      const where = clientName(receipt.client)
      if (receipt.acceptance_unknown || receipt.failures?.some(failure => failure.code === 'acceptance_unknown')) {
        report(`${where} was asked to start this download but did not confirm it. Check ${where} before retrying.`)
      } else if (!receipt.ok) throw new Error(receipt.error || 'The download client rejected the submission')
      else notify(`Sent ${label} to ${where}${freeSpaceNote(preflight.disk_space)}`, 'success')
    } catch (error) {
      if (controller.signal.aborted) return
      if (
        error instanceof api.SubmissionError &&
        (error.detail?.acceptance_unknown ||
          (Array.isArray(error.detail?.failures) &&
            error.detail.failures.some(failure => failure?.code === 'acceptance_unknown')))
      ) {
        const where = clientName(
          error.detail?.client === 'sabnzbd' || error.detail?.client === 'qbittorrent'
            ? error.detail.client
            : protocol === 'usenet'
              ? 'sabnzbd'
              : 'qbittorrent',
        )
        report(`${error.message} Check ${where} before retrying.`)
      } else report(errorMessage(error))
    } finally {
      sending.current = false
      setSendingRelease(null)
      await reloadDownloads()
    }
  }

  const cancelLowSpace = () => setLowSpace(null)
  const dismissSendError = (key: string, index: number) => setSendError(key, index, null)

  const handleDownloadAction = async (
    entry: DownloadEntry,
    action: api.DownloadAction,
    deleteFiles = false,
  ): Promise<boolean> => {
    if (controlling.current) return false
    controlling.current = true
    setBusyDownload(entry.record_id)
    try {
      await controlDownload(entry.record_id, action, deleteFiles)
      if (action === 'remove') {
        const where = clientName(entry.client)
        notify(
          deleteFiles ? `Download and files removed from ${where}` : `Download removed from ${where}; files were kept`,
          'success',
        )
      }
      return true
    } catch (error) {
      notify(`Could not ${action} the download: ${errorMessage(error)}`, 'error')
      return false
    } finally {
      controlling.current = false
      setBusyDownload(null)
    }
  }

  return {
    dlBySeason,
    activeDownloads,
    busyDownload,
    sendingRelease,
    lowSpace,
    sendErrors,
    handleDownload,
    cancelLowSpace,
    dismissSendError,
    handleDownloadAction,
  }
}

/** Last-known availability stays visible while an open season observes refresh work. */
export interface SeasonAvailability {
  signature: string
  loading: boolean
  error: string | null
  byRelease: Record<number, UsenetAvailabilityResult>
  sabnzbdConfigured: boolean
  configGeneration: number | null
}

export function useSeasonAvailability(enabled: boolean, seasons: ResultItem[], open: boolean, configScope: string) {
  const revision = useSyncExternalStore(api.subscribeUsenetAvailability, api.getUsenetAvailabilityRevision)
  const [saved, setAvailability] = useState<Record<string, SeasonAvailability>>({})
  const savedRef = useRef(saved)
  savedRef.current = saved
  const requests = useRef(new Map<string, { controller: AbortController; signature: string }>())
  const requested = useRef(new Map<string, string>())
  const signatures = Object.fromEntries(
    seasons.map(season => [season.key, JSON.stringify([revision, configScope, season.releases.map(releaseIdentity)])]),
  )
  const currentSignatures = useRef(signatures)
  currentSignatures.current = signatures
  const signature = JSON.stringify(signatures)

  /**
   * `work.search` asks Prowlarr to search for that one release of the season now; `work.verify` asks for the
   * best search result of that release to be fetched and checked.
   */
  const load = async (season: ResultItem, refresh = false, work: { search?: number; verify?: number } = {}) => {
    if (!enabled || !open) return
    const key = season.key
    const signature = signatures[key]
    const asksForWork = work.search !== undefined || work.verify !== undefined
    if (!refresh && !asksForWork && requested.current.get(key) === signature) return
    requested.current.set(key, signature)
    requests.current.get(key)?.controller.abort()
    const controller = new AbortController()
    requests.current.set(key, { controller, signature })
    const previous = savedRef.current[key]?.signature === signature ? savedRef.current[key] : undefined
    const selections: api.SelectionInput[] = season.releases.map((release, index) => ({
      key,
      release: index,
      identity: releaseIdentity(release),
    }))
    const initial: AvailabilitySnapshot | undefined = previous && {
      rows: Object.fromEntries(Object.values(previous.byRelease).map(row => [availabilityKey(row), row])),
      configGeneration: previous.configGeneration,
      sabnzbdConfigured: previous.sabnzbdConfigured,
      loading: previous.loading,
      error: previous.error,
    }
    try {
      await observeUsenetAvailability(selections, {
        refresh,
        ...(work.search !== undefined ? { search: [{ key, release: work.search }] } : {}),
        ...(work.verify !== undefined ? { verify: [{ key, release: work.verify }] } : {}),
        signal: controller.signal,
        initial,
        onSnapshot: snapshot => {
          if (controller.signal.aborted || currentSignatures.current[key] !== signature) return
          const value: SeasonAvailability = {
            signature,
            loading: snapshot.loading,
            error: snapshot.error,
            byRelease: Object.fromEntries(Object.values(snapshot.rows).map(row => [row.release, row])),
            sabnzbdConfigured: snapshot.sabnzbdConfigured,
            configGeneration: snapshot.configGeneration,
          }
          savedRef.current = { ...savedRef.current, [key]: value }
          setAvailability(savedRef.current)
        },
      })
    } finally {
      if (requests.current.get(key)?.controller === controller) requests.current.delete(key)
    }
  }

  useEffect(() => {
    for (const [key, request] of requests.current)
      if (!enabled || !open || request.signature !== currentSignatures.current[key]) {
        request.controller.abort()
        requests.current.delete(key)
      }
    if (!enabled || !open) {
      requested.current.clear()
      return
    }
    for (const [key, previous] of requested.current)
      if (previous !== currentSignatures.current[key]) {
        requested.current.delete(key)
        const season = seasons.find(season => season.key === key)
        if (season) void load(season)
      }
  }, [signature, enabled, open])
  useEffect(
    () => () => {
      for (const request of requests.current.values()) request.controller.abort()
    },
    [],
  )

  const availability = Object.fromEntries(
    Object.entries(saved).filter(([key, value]) => value.signature === signatures[key]),
  )
  return { availability, load, revision }
}
