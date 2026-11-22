import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentDownloadAssociations, getDownloadSnapshot, subscribeDownloads, reloadDownloads, controlDownload } from './download-store'
import * as api from './api'
import { releaseIdentity } from '../../shared/releases'
import type { Release, ResultItem } from './types'
import type { GroupedCard } from './types'
import type { DownloadEntry } from './components/DownloadsPanel'
import { toDownloadEntry, clientName } from './components/DownloadsPanel'
import { seasonLabel } from './utils'
import type { DownloadPreflight, DownloadProtocol, UsenetAvailabilityResult } from './api'

export interface DetailsDownloadState { transfers: DownloadEntry[] }
export const IDLE_DOWNLOAD: DetailsDownloadState = { transfers: [] }

type Notify = (message: string, tone: 'success' | 'error' | 'info') => void

interface ActivePlan { preflight: DownloadPreflight | null; selection: api.SelectionInput; label: string; error: string | null }

/** Record controls and a one-shot review for one canonical release intent. */
export function useCardDownloads(group: GroupedCard, notify: Notify) {
  const snapshot = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controlling = useRef(false)
  const [plan, setPlan] = useState<ActivePlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const preparing = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const currentGroup = useRef(group)
  currentGroup.current = group
  const groupSignature = JSON.stringify(group.seasons.map(season => [season.key, season.releases.map(releaseIdentity)]))

  useEffect(() => () => { preparing.current?.abort() }, [])
  useEffect(() => {
    if (!plan || plan.selection.identity === releaseIdentity(group.seasons.find(season => season.key === plan.selection.key)?.releases[plan.selection.release] || {})) return
    preparing.current?.abort()
    if (!submitting.current) { setPlanBusy(false); setPlan(null) }
  }, [groupSignature])

  useEffect(() => {
    if (!plan?.preflight) return
    const id = plan.preflight.plan_id
    const timer = window.setTimeout(() => {
      if (!submitting.current) setPlan(current => current?.preflight?.plan_id === id ? { ...current, preflight: null, error: 'This review has expired. Refresh the review before sending.' } : current)
    }, plan.preflight.expires_in * 1000)
    return () => window.clearTimeout(timer)
  }, [plan?.preflight])

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

  const preparePlan = async (intent: ActivePlan) => {
    preparing.current?.abort()
    const controller = new AbortController()
    preparing.current = controller
    setPlan({ ...intent, preflight: null, error: null })
    setPlanBusy(true)
    try {
      const preflight = await api.preflightDownload([intent.selection], true, controller.signal)
      if (controller.signal.aborted) return
      const release = currentGroup.current.seasons.find(season => season.key === intent.selection.key)?.releases[intent.selection.release]
      if (!release || releaseIdentity(release) !== intent.selection.identity) return
      const blocked = preflight.blocked.find(row => row.key === intent.selection.key && row.release === intent.selection.release)
      if (blocked) throw new Error(blocked.reason)
      if (!preflight.units.length) throw new Error('This release is already queued in the download client')
      setPlan({ ...intent, preflight, error: null })
    } catch (error) {
      if (!controller.signal.aborted) setPlan({ ...intent, preflight: null, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (preparing.current === controller) { preparing.current = null; setPlanBusy(false) }
    }
  }

  const handleDownload = async (key: string, index: number, protocol: DownloadProtocol) => {
    if (planBusy) return
    const season = group.seasons.find(item => item.key === key)
    const release: Release | undefined = season?.releases[index]
    if (!season || !release) return
    await preparePlan({ selection: { key, release: index, identity: releaseIdentity(release), protocol }, preflight: null, error: null, label: `${seasonLabel(season)} · ${release.releaseGroup || season.title}` })
  }

  const confirmPlan = async (acknowledge: { whole_source?: boolean; disk_space?: boolean }) => {
    if (!plan?.preflight || planBusy || submitting.current) return
    const intent = plan
    const planId = plan.preflight.plan_id
    submitting.current = true
    setPlanBusy(true)
    setPlan({ ...intent, preflight: null, error: null })
    try {
      const receipt = await api.submitDownload(planId, acknowledge)
      const where = clientName(receipt.client)
      if (receipt.acceptance_unknown || receipt.failures?.some(failure => failure.code === 'acceptance_unknown')) {
        notify(`${where} was asked to start this download but did not confirm it. Check ${where} before retrying.`, 'error')
      } else if (!receipt.ok) throw new Error(receipt.error || 'The download client rejected the submission')
      else notify(`Sent ${intent.label} to ${where}`, 'success')
      setPlan(null)
    } catch (error) {
      if (error instanceof api.SubmissionError && (error.detail?.acceptance_unknown || Array.isArray(error.detail?.failures) && error.detail.failures.some(failure => failure?.code === 'acceptance_unknown'))) {
        const where = clientName(error.detail?.client === 'sabnzbd' || error.detail?.client === 'qbittorrent' ? error.detail.client : intent.selection.protocol === 'usenet' ? 'sabnzbd' : 'qbittorrent')
        notify(`${error.message} Check ${where} before retrying.`, 'error')
        setPlan(null)
      } else {
        setPlan({ ...intent, preflight: null, error: `${error instanceof Error ? error.message : String(error)} Refresh the review before sending again.` })
      }
    } finally {
      submitting.current = false
      setPlanBusy(false)
      await reloadDownloads()
    }
  }

  const closePlan = () => {
    if (submitting.current) return
    preparing.current?.abort()
    preparing.current = null
    setPlanBusy(false)
    setPlan(null)
  }
  const refreshPlan = async () => { if (plan && !planBusy) await preparePlan(plan) }

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

  const singleFlow = { plan, busy: planBusy, submitting: submitting.current, confirm: confirmPlan, refresh: refreshPlan, close: closePlan }
  return { dlBySeason, activeDownloads, busyDownload, handleDownload, handleDownloadAction, singleFlow }
}

/** Usenet availability per release for one season, fetched when details open. */
export interface SeasonAvailability {
  signature: string
  loading: boolean
  error: string | null
  byRelease: Record<number, UsenetAvailabilityResult>
  sabnzbdConfigured: boolean
}

export function useSeasonAvailability(enabled: boolean, seasons: ResultItem[], open: boolean) {
  const [saved, setAvailability] = useState<Record<string, SeasonAvailability>>({})
  const requests = useRef(new Map<string, { controller: AbortController; signature: string }>())
  const signatures = Object.fromEntries(seasons.map(season => [season.key, JSON.stringify(season.releases.map(releaseIdentity))]))
  const currentSignatures = useRef(signatures)
  currentSignatures.current = signatures
  const signature = JSON.stringify(signatures)

  useEffect(() => {
    for (const [key, request] of requests.current) if (!enabled || !open || request.signature !== currentSignatures.current[key]) {
      request.controller.abort()
      requests.current.delete(key)
    }
  }, [signature, enabled, open])
  useEffect(() => () => { for (const request of requests.current.values()) request.controller.abort() }, [])

  const load = async (season: ResultItem, refresh = false) => {
    if (!enabled || !open) return
    const key = season.key
    const signature = JSON.stringify(season.releases.map(releaseIdentity))
    requests.current.get(key)?.controller.abort()
    const controller = new AbortController()
    requests.current.set(key, { controller, signature })
    setAvailability(current => ({ ...current, [key]: { signature, loading: true, error: null, byRelease: {}, sabnzbdConfigured: false } }))
    try {
      const selections: api.SelectionInput[] = season.releases.map((release, index) => ({ key, release: index, identity: releaseIdentity(release) }))
      const response = await api.usenetAvailability(selections, refresh, controller.signal)
      if (controller.signal.aborted || currentSignatures.current[key] !== signature) return
      if (!response.ok) throw new Error(response.error || 'Could not check Usenet sources')
      const byRelease: Record<number, UsenetAvailabilityResult> = {}
      for (const row of response.results) if (row.key === key && row.identity === selections[row.release]?.identity) byRelease[row.release] = row
      setAvailability(current => ({ ...current, [key]: { signature, loading: false, error: null, byRelease, sabnzbdConfigured: response.sabnzbd_configured } }))
    } catch (error) {
      if (controller.signal.aborted || currentSignatures.current[key] !== signature) return
      setAvailability(current => ({ ...current, [key]: { signature, loading: false, error: error instanceof Error ? error.message : 'Could not check Usenet sources', byRelease: {}, sabnzbdConfigured: false } }))
    } finally { if (requests.current.get(key)?.controller === controller) requests.current.delete(key) }
  }

  const availability = Object.fromEntries(Object.entries(saved).filter(([key, value]) => value.signature === signatures[key]))
  return { availability, load }
}
