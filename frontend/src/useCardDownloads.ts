import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentDownloadAssociations, getDownloadSnapshot, subscribeDownloads, reloadDownloads, controlDownload } from './download-store'
import * as api from './api'
import { releaseIdentity } from '../../shared/releases'
import type { Release, ResultItem } from './types'
import type { GroupedCard } from './types'
import type { DownloadEntry } from './components/DownloadsPanel'
import { toDownloadEntry, clientName } from './components/DownloadsPanel'
import { seasonLabel } from './utils'
import type { DownloadProtocol, UsenetAvailabilityResult } from './api'
import { availabilityKey, observeUsenetAvailability, type AvailabilitySnapshot } from './usenet-observation'

export interface DetailsDownloadState { transfers: DownloadEntry[] }
export const IDLE_DOWNLOAD: DetailsDownloadState = { transfers: [] }

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

/** Record controls and one-click sending for a canonical release intent. */
export function useCardDownloads(group: GroupedCard, notify: Notify) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)
  const sending = useRef(false)
  /** The release whose one-click send is running, so its button can show progress and others stay locked. */
  const [sendingRelease, setSendingRelease] = useState<{ key: string; release: number } | null>(null)
  const aborter = useRef<AbortController | null>(null)

  useEffect(() => () => { aborter.current?.abort() }, [])

  const dlBySeason: Record<string, Record<number, DetailsDownloadState>> = {}
  const activeDownloads: DownloadEntry[] = []
  for (const progress of Object.values(snapshot)) {
    if (!progress.associations.some(ref => group.seasons.some(season => season.key === ref.key))) continue
    const entry = toDownloadEntry(progress)
    const associations = currentDownloadAssociations(progress, group.seasons)
    for (const ref of associations) {
      const state = (dlBySeason[ref.key] ||= {})[ref.release] ||= { transfers: [] }
      state.transfers.push(entry)
    }
    if (progress.phase !== 'complete' || !associations.length) activeDownloads.push(entry)
  }

  const handleDownload = async (key: string, index: number, protocol: DownloadProtocol) => {
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
    try {
      const preflight = await api.preflightDownload([{ key, release: index, identity, protocol }], true, controller.signal)
      if (controller.signal.aborted) return
      const blocked = preflight.blocked.find(row => row.key === key && row.release === index)
      if (blocked) throw new Error(blocked.reason)
      if (!preflight.units.length) throw new Error('This release is already queued in the download client')
      const receipt = await api.submitDownload(preflight.plan_id, { whole_source: true, disk_space: true })
      const where = clientName(receipt.client)
      if (receipt.acceptance_unknown || receipt.failures?.some(failure => failure.code === 'acceptance_unknown')) {
        notify(`${where} was asked to start this download but did not confirm it. Check ${where} before retrying.`, 'error')
      } else if (!receipt.ok) throw new Error(receipt.error || 'The download client rejected the submission')
      else notify(`Sent ${label} to ${where}`, 'success')
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof api.SubmissionError && (error.detail?.acceptance_unknown || Array.isArray(error.detail?.failures) && error.detail.failures.some(failure => failure?.code === 'acceptance_unknown'))) {
        const where = clientName(error.detail?.client === 'sabnzbd' || error.detail?.client === 'qbittorrent' ? error.detail.client : protocol === 'usenet' ? 'sabnzbd' : 'qbittorrent')
        notify(`${error.message} Check ${where} before retrying.`, 'error')
      } else notify(`Could not send ${label}: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      sending.current = false
      setSendingRelease(null)
      await reloadDownloads()
    }
  }

  const handleDownloadAction = async (entry: DownloadEntry, action: api.DownloadAction, deleteFiles = false): Promise<boolean> => {
    if (controlling.current) return false
    controlling.current = true; setBusyDownload(entry.record_id)
    try {
      await controlDownload(entry.record_id, action, deleteFiles)
      if (action === 'remove') {
        const where = clientName(entry.client)
        notify(deleteFiles ? `Download and files removed from ${where}` : `Download removed from ${where}; files were kept`, 'success')
      }
      return true
    } catch (error) { notify(`Could not ${action} the download: ${error instanceof Error ? error.message : String(error)}`, 'error'); return false }
    finally { controlling.current = false; setBusyDownload(null) }
  }

  return { dlBySeason, activeDownloads, busyDownload, sendingRelease, handleDownload, handleDownloadAction }
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
  const signatures = Object.fromEntries(seasons.map(season => [season.key, JSON.stringify([revision, configScope, season.releases.map(releaseIdentity)])]))
  const currentSignatures = useRef(signatures)
  currentSignatures.current = signatures
  const signature = JSON.stringify(signatures)

  const load = async (season: ResultItem, refresh = false) => {
    if (!enabled || !open) return
    const key = season.key
    const signature = signatures[key]
    if (!refresh && requested.current.get(key) === signature) return
    requested.current.set(key, signature)
    requests.current.get(key)?.controller.abort()
    const controller = new AbortController()
    requests.current.set(key, { controller, signature })
    const previous = savedRef.current[key]?.signature === signature ? savedRef.current[key] : undefined
    const selections: api.SelectionInput[] = season.releases.map((release, index) => ({ key, release: index, identity: releaseIdentity(release) }))
    const initial: AvailabilitySnapshot | undefined = previous && {
      rows: Object.fromEntries(Object.values(previous.byRelease).map(row => [availabilityKey(row), row])),
      configGeneration: previous.configGeneration,
      sabnzbdConfigured: previous.sabnzbdConfigured,
      loading: previous.loading,
      error: previous.error,
    }
    try {
      await observeUsenetAvailability(selections, { refresh, signal: controller.signal, initial, onSnapshot: snapshot => {
        if (controller.signal.aborted || currentSignatures.current[key] !== signature) return
        const value: SeasonAvailability = {
          signature, loading: snapshot.loading, error: snapshot.error,
          byRelease: Object.fromEntries(Object.values(snapshot.rows).map(row => [row.release, row])),
          sabnzbdConfigured: snapshot.sabnzbdConfigured, configGeneration: snapshot.configGeneration,
        }
        savedRef.current = { ...savedRef.current, [key]: value }
        setAvailability(savedRef.current)
      } })
    } finally { if (requests.current.get(key)?.controller === controller) requests.current.delete(key) }
  }

  useEffect(() => {
    for (const [key, request] of requests.current) if (!enabled || !open || request.signature !== currentSignatures.current[key]) {
      request.controller.abort()
      requests.current.delete(key)
    }
    if (!enabled || !open) { requested.current.clear(); return }
    for (const [key, previous] of requested.current) if (previous !== currentSignatures.current[key]) {
      requested.current.delete(key)
      const season = seasons.find(season => season.key === key)
      if (season) void load(season)
    }
  }, [signature, enabled, open])
  useEffect(() => () => { for (const request of requests.current.values()) request.controller.abort() }, [])

  const availability = Object.fromEntries(Object.entries(saved).filter(([key, value]) => value.signature === signatures[key]))
  return { availability, load, revision }
}
