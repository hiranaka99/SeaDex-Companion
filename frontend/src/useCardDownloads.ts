import { useRef, useState, useSyncExternalStore } from 'react'
import { getDownloadSnapshot, subscribeDownloads, reloadDownloads, controlDownload } from './download-store'
import * as api from './api'
import { releaseIdentity } from '../../shared/releases'
import { releaseOwned } from '../../shared/download-plan'
import type { Release, ResultItem } from './types'
import type { GroupedCard } from './types'
import type { DownloadEntry } from './components/DownloadsPanel'
import { toDownloadEntry, clientName } from './components/DownloadsPanel'
import { seasonLabel } from './utils'
import type { DownloadPreflight, DownloadProtocol, UsenetAvailabilityResult } from './api'

export interface DetailsDownloadState { transfers: DownloadEntry[] }
export const IDLE_DOWNLOAD: DetailsDownloadState = { transfers: [] }

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

interface ActivePlan { preflight: DownloadPreflight; label: string }

/**
 * Card-scoped download state: record-keyed client progress plus the
 * review-then-submit flow for a single release (plan is consumed on submit,
 * so every attempt starts with a fresh preflight).
 */
export function useCardDownloads(group: GroupedCard, notify: Notify) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)
  const [plan, setPlan] = useState<ActivePlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)

  const dlBySeason: Record<string, Record<number, DetailsDownloadState>> = {}
  const activeDownloads: DownloadEntry[] = []
  for (const progress of Object.values(snapshot)) {
    if (!progress.key || progress.release == null) continue
    const season = group.seasons.find(item => item.key === progress.key)
    if (!season) continue
    const release = season.releases[progress.release]
    if (!release || releaseOwned(season, release)) continue
    const entry = toDownloadEntry(progress)
    const state = (dlBySeason[progress.key] ||= {})[progress.release] ||= { transfers: [] }
    state.transfers.push(entry)
    if (progress.phase !== 'complete') activeDownloads.push(entry)
  }

  const handleDownload = async (key: string, index: number, protocol: DownloadProtocol) => {
    if (planBusy) return
    const season = group.seasons.find(item => item.key === key)
    const release: Release | undefined = season?.releases[index]
    if (!season || !release) return
    setPlanBusy(true)
    try {
      const selection: api.SelectionInput = { key, release: index, identity: releaseIdentity(release), protocol }
      const preflight = await api.preflightDownload([selection], true)
      const blocked = preflight.blocked.find(row => row.key === key && row.release === index)
      if (blocked) throw new Error(blocked.reason)
      if (!preflight.units.length) throw new Error('This release is already queued in the download client')
      setPlan({ preflight, label: `${seasonLabel(season)} · ${release.releaseGroup || season.title}` })
    } catch (error) {
      notify(`Could not prepare download: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setPlanBusy(false) }
  }

  const confirmPlan = async (acknowledge: { whole_source?: boolean; disk_space?: boolean }) => {
    if (!plan || planBusy) return
    setPlanBusy(true)
    try {
      const receipt = await api.submitDownload(plan.preflight.plan_id, acknowledge)
      const where = clientName(receipt.client)
      if (receipt.acceptance_unknown) notify(`${where} was asked to start this download but did not confirm it. Check ${where} before retrying.`, 'error')
      else if (!receipt.ok) throw new Error(receipt.error || 'The download client rejected the submission')
      else notify(`Sent ${plan.label} to ${where}`, 'success')
      setPlan(null)
    } catch (error) {
      if (error instanceof api.SubmissionError && error.detail?.acceptance_unknown) {
        notify(`${error.message} Check SABnzbd before retrying.`, 'error')
        setPlan(null)
      } else {
        notify(`Download failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    } finally {
      setPlanBusy(false)
      await reloadDownloads()
    }
  }

  const closePlan = () => { if (!planBusy) setPlan(null) }

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

  const singleFlow = { plan, busy: planBusy, confirm: confirmPlan, close: closePlan }
  return { dlBySeason, activeDownloads, busyDownload, handleDownload, handleDownloadAction, singleFlow }
}

/** Usenet availability per release for one season, fetched when details open. */
export interface SeasonAvailability {
  loading: boolean
  error: string | null
  byRelease: Record<number, UsenetAvailabilityResult>
  sabnzbdConfigured: boolean
}

export function useSeasonAvailability(enabled: boolean) {
  const [availability, setAvailability] = useState<Record<string, SeasonAvailability>>({})
  const requests = useRef(new Map<string, number>())

  const load = async (season: ResultItem, refresh = false) => {
    if (!enabled) return
    const key = season.key
    const generation = (requests.current.get(key) || 0) + 1
    requests.current.set(key, generation)
    setAvailability(current => ({ ...current, [key]: { loading: true, error: null, byRelease: current[key]?.byRelease || {}, sabnzbdConfigured: current[key]?.sabnzbdConfigured || false } }))
    try {
      const selections: api.SelectionInput[] = season.releases.map((release, index) => ({ key, release: index, identity: releaseIdentity(release) }))
      const response = await api.usenetAvailability(selections, refresh)
      if (requests.current.get(key) !== generation) return
      if (!response.ok && response.error) throw new Error(response.error)
      const byRelease: Record<number, UsenetAvailabilityResult> = {}
      for (const row of response.results) byRelease[row.release] = row
      setAvailability(current => ({ ...current, [key]: { loading: false, error: null, byRelease, sabnzbdConfigured: response.sabnzbd_configured } }))
    } catch (error) {
      if (requests.current.get(key) !== generation) return
      setAvailability(current => ({ ...current, [key]: { loading: false, error: error instanceof Error ? error.message : 'Could not check Usenet sources', byRelease: current[key]?.byRelease || {}, sabnzbdConfigured: current[key]?.sabnzbdConfigured || false } }))
    }
  }

  return { availability, load }
}
