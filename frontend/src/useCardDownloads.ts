import { errorMessage } from '../../shared/errors.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentDownloadAssociations, getDownloadSnapshot, subscribeDownloads, controlDownload } from './download-store'
import * as api from './api'
import { releaseIdentity } from '../../shared/releases'
import type { ResultItem, GroupedCard } from './types'

import { toDownloadEntry, clientName, importUnsettled, type DownloadEntry } from './download-entry'
import type { UsenetAvailabilityResult } from './api'
import { availabilityKey, observeUsenetAvailability, type AvailabilitySnapshot } from './usenet-observation'

export interface DetailsDownloadState {
  transfers: DownloadEntry[]
}
export const IDLE_DOWNLOAD: DetailsDownloadState = { transfers: [] }

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

/** The card's owned downloads by season and release, and the pause, resume and remove controls for them. */
export function useCardDownloads(group: GroupedCard, notify: Notify) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)

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

  return { dlBySeason, activeDownloads, busyDownload, handleDownloadAction }
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
