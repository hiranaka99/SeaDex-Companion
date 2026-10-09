import { useEffect, useId, useRef, useState } from 'react'
import { GroupedCard, Release, ResultItem, Config } from '../types'
import { seasonLabel, STATUS_LABEL, cardSizeDelta, isSeasonUpgradable } from '../utils'
import * as api from '../api'
import { buttonBase, cx } from '../styles'
import Icon, { IconName } from './Icons'
import BrandLogo from './BrandLogo'
import { useToast } from './Toast'
import DownloadsPanel, { DownloadEntry } from './DownloadsPanel'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'
import { releaseIdentity } from '../../../shared/releases'
import MappingDialog from './MappingDialog'
import SeasonBadge from './SeasonBadge'
import LibrarySizeChange from './LibrarySizeChange'
import ReleaseDetails, { type DetailsDownloadState } from './ReleaseDetails'

function HideActionIcon({ hidden }: { hidden: boolean }) {
  return <Icon name={hidden ? 'eye' : 'eye-off'} size={18} />
}

interface CardProps {
  active: boolean
  openRequested?: boolean
  onOpened?: () => void
  group: GroupedCard
  index: number
  config: Config | null
  hidden?: boolean
  onToggle: () => void
  onRulesChanged: () => Promise<void>
  onRescan: () => void
}

const HIDE_DURATION_MS = 280

const CARD_BASE =
  'group/card flex flex-col overflow-hidden rounded-card border border-line bg-panel transition-opacity duration-200'
const CARD_STATUS: Record<string, { icon: IconName; color: string }> = {
  upgrade: { icon: 'arrow-up', color: 'text-accent-bright' },
  best: { icon: 'check', color: 'text-good' },
  missing: { icon: 'minus', color: 'text-muted' },
  partial: { icon: 'alert', color: 'text-warn' },
  review: { icon: 'alert', color: 'text-warn' },
}
const STATUS_BADGE: Record<string, string> = {
  upgrade: 'border-accent/65 bg-[#0d1c42]/88 text-ink',
  best: 'border-good/65 bg-[#062e20]/88 text-ink',
  missing: 'border-muted/50 bg-[#1e232e]/88 text-ink',
  partial: 'border-warn/65 bg-[#3a2806]/88 text-ink',
}
const ICON_BUTTON =
  'grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-panel-raised hover:text-ink'
export default function Card({ active, openRequested, onOpened, group, index, config, hidden = false, onToggle, onRulesChanged, onRescan }: CardProps) {
  const [hiding, setHiding] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [busyDownload, setBusyDownload] = useState<string | null>(null)
  const controllingDownload = useRef(false)
  const [removeTarget, setRemoveTarget] = useState<DownloadEntry | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [ruleBusy, setRuleBusy] = useState('')
  const hideTimer = useRef<number | null>(null)
  const closing = useRef(false)
  const openFrame = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const copyRef = useRef<HTMLDivElement>(null)
  const [copyOverflows, setCopyOverflows] = useState(false)
  const toast = useToast()
  const srcClass = group.arr === 'Sonarr' ? 'sonarr' : 'radarr'
  const st = group.status === 'review' ? 'partial' : group.status || 'upgrade'

  useEffect(() => {
    const copy = copyRef.current
    if (!copy) return
    const update = () => setCopyOverflows(copy.scrollHeight > copy.clientHeight + 1)
    const observer = new ResizeObserver(update)
    observer.observe(copy)
    Array.from(copy.children).forEach(child => observer.observe(child))
    update()
    return () => observer.disconnect()
  }, [group.title, group.status])

  useEffect(() => {
    if (!active) { setDetailsOpen(false); setMappingOpen(false); setRemoveTarget(null) }
    else if (openRequested) { handleOpenDetails(); onOpened?.() }
  }, [active, openRequested])
  // Live download state for every release in this card, keyed by season key
  // then release index. Tracking lives here so progress stays current even
  // while the details are closed.
  const [dlBySeason, setDlBySeason] = useState<Record<string, Record<number, DlState>>>({})
  const dlBySeasonRef = useRef<Record<string, Record<number, DlState>>>({})
  dlBySeasonRef.current = dlBySeason
  const unsubscribers = useRef<Record<string, () => void>>({})
  const downloadGeneration = useRef(0)
  const downloadSignature = JSON.stringify(group.seasons.map(season => [season.key, season.have, season.owned_by_part, season.releases.map(releaseIdentity)])) + JSON.stringify([config?.qbittorrent_url, config?.qbittorrent_user, config?.qbittorrent_pass_configured])

  const stopPolling = (seasonKey: string, release: number) => {
    const idKey = `${seasonKey}\u0000${release}`
    const unsubscribe = unsubscribers.current[idKey]
    if (unsubscribe) {
      unsubscribe()
      delete unsubscribers.current[idKey]
    }
  }

  // Live progress is driven by one shared /api/download_progress/all timer
  // (see api.watchDownloadProgress) instead of an interval per release, so many
  // simultaneous downloads cost a single qBittorrent request per tick.
  const startPolling = (seasonKey: string, release: number) => {
    const idKey = `${seasonKey}\u0000${release}`
    if (unsubscribers.current[idKey]) return
    const generation = downloadGeneration.current
    unsubscribers.current[idKey] = api.watchDownloadProgress(idKey, (progress) => { if (generation === downloadGeneration.current) applyProgress(seasonKey, release, progress) })
  }

  const applyProgress = (seasonKey: string, release: number, p: api.DownloadProgress) => {
    if (!p.ok) return
    const selected = group.seasons.find(season => season.key === seasonKey)?.releases[release]
    if (!selected || (p.identity && p.identity !== releaseIdentity(selected))) return
    // A torrent we just sent ("sending") that is no longer in qBittorrent means
    // the add failed and qBittorrent removed it (e.g. the magnet metadata fetch
    // timed out). Reset to idle so the card stops animating instead of waiting
    // forever on a torrent that will never download.
    if (!p.found) {
      stopPolling(seasonKey, release)
      setDlBySeason((s) => ({ ...s, [seasonKey]: { ...(s[seasonKey] || {}), [release]: IDLE_DL } }))
      return
    }
    const complete = p.state === 'complete'
    const phase = complete ? 'complete' : p.state === 'error' ? 'error' : p.state === 'paused' ? 'paused' : 'downloading'
    setDlBySeason((s) => ({
      ...s,
      [seasonKey]: {
        ...(s[seasonKey] || {}),
        [release]: {
          phase,
          progress: p.progress,
          downloaded: p.downloaded,
          total_size: p.total_size,
          speed: p.speed,
        },
      },
    }))
    startPolling(seasonKey, release)
  }

  const pollProgress = (seasonKey: string, release: number) => {
    const generation = downloadGeneration.current
    api.getDownloadProgress(seasonKey, release)
      .then((p) => { if (generation === downloadGeneration.current) applyProgress(seasonKey, release, p) })
      .catch(() => {
        /* transient network/backend error — keep polling */
      })
  }

  // Re-attach to downloads that are already running in qBittorrent (e.g. after
  // a page reload or server restart): check each downloadable release once and
  // resume polling for any that are in progress or already complete. The
  // backend caches the qBittorrent response, so this burst stays cheap.
  useEffect(() => {
    downloadGeneration.current += 1
    setDlBySeason({})
    dlBySeasonRef.current = {}
    let active = true
    api.getAllDownloadProgress().then(({ downloads }) => {
      if (!active) return
      for (const season of group.seasons) {
        // Mirror the Season download-button logic: for split seasons (cours) use
        // the per-part ownership so a download for one cour is not skipped just
        // because the same release group is owned for a different cour.
        const owned = (rel: Release) => {
          const ownedGroups = season.precise_part_ownership
            ? (season.owned_by_part?.[rel.part || ''] || [])
            : season.have
          return ownedGroups.some((h) => h.toLowerCase() === rel.releaseGroup.toLowerCase())
        }
        for (const { rel, index } of uniqueReleases(season.releases || [])) {
          if (!rel.downloadable || owned(rel)) continue
          const progress = downloads[`${season.key}\0${index}`]
          if (progress?.found) applyProgress(season.key, index, progress)
        }
      }
    }).catch(() => {
      /* qBittorrent may be unconfigured or temporarily unavailable. */
    })
    return () => {
      active = false
      downloadGeneration.current += 1
      for (const unsubscribe of Object.values(unsubscribers.current)) unsubscribe()
      unsubscribers.current = {}
    }
    // Reattach whenever release identities, ownership, or the connection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadSignature, config])

  useEffect(() => {
    const handleBulkChange = (event: Event) => {
      const detail = (event as CustomEvent<{ action: 'start' | 'cancel'; targets: api.BulkDownloadTarget[] }>).detail
      if (!detail?.targets?.length) return
      const seasonKeys = new Set(group.seasons.map((season) => season.key))
      const relevant = detail.targets.filter((target) => seasonKeys.has(target.key))
      if (!relevant.length) return

      if (detail.action === 'cancel') {
        for (const target of relevant) stopPolling(target.key, target.release)
        setDlBySeason((current) => {
          const next = { ...current }
          for (const target of relevant) {
            next[target.key] = { ...(next[target.key] || {}), [target.release]: IDLE_DL }
          }
          return next
        })
        return
      }

      setDlBySeason((current) => {
        const next = { ...current }
        for (const target of relevant) {
          next[target.key] = { ...(next[target.key] || {}), [target.release]: { ...IDLE_DL, phase: 'sending' } }
        }
        return next
      })
      for (const target of relevant) {
        pollProgress(target.key, target.release)
        startPolling(target.key, target.release)
      }
    }
    window.addEventListener(api.DOWNLOADS_CHANGED_EVENT, handleBulkChange)
    return () => window.removeEventListener(api.DOWNLOADS_CHANGED_EVENT, handleBulkChange)
    // Card groups are stable for the life of a scan result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.seasons])

  const handleDownload = async (seasonKey: string, release: number) => {
    const generation = downloadGeneration.current
    setDlBySeason((s) => ({
      ...s,
      [seasonKey]: { ...(s[seasonKey] || {}), [release]: { ...IDLE_DL, phase: 'sending' } },
    }))
    try {
      const selected = group.seasons.find(season => season.key === seasonKey)?.releases[release]
      if (!selected) throw new Error('This release is no longer available')
      const res = await api.download(seasonKey, release, releaseIdentity(selected))
      if (!res.ok) throw new Error(res.error || 'Download failed')
      if (generation !== downloadGeneration.current) return
      pollProgress(seasonKey, release)
      startPolling(seasonKey, release)
    } catch (e: any) {
      if (generation !== downloadGeneration.current) { toast.show('Download failed: ' + e.message, 'error'); return }
      stopPolling(seasonKey, release)
      setDlBySeason((s) => ({
        ...s,
        [seasonKey]: { ...(s[seasonKey] || {}), [release]: IDLE_DL },
      }))
      toast.show('Download failed: ' + e.message, 'error')
    }
  }

  const handleDownloadAction = async (entry: DownloadEntry, action: api.DownloadAction, removeFiles = false) => {
    if (controllingDownload.current) return false
    controllingDownload.current = true
    const generation = downloadGeneration.current
    setBusyDownload(entry.id)
    try {
      await api.controlDownload(entry.seasonKey, entry.release, action, removeFiles, entry.identity)
      if (generation !== downloadGeneration.current) return true
      if (action === 'remove') {
        stopPolling(entry.seasonKey, entry.release)
        setDlBySeason((current) => ({
          ...current,
          [entry.seasonKey]: { ...(current[entry.seasonKey] || {}), [entry.release]: IDLE_DL },
        }))
        toast.show(removeFiles ? 'Torrent and files removed from qBittorrent' : 'Torrent removed; downloaded files were kept', 'success')
      } else {
        setDlBySeason((current) => ({
          ...current,
          [entry.seasonKey]: {
            ...(current[entry.seasonKey] || {}),
            [entry.release]: {
              ...(current[entry.seasonKey]?.[entry.release] || IDLE_DL),
              phase: action === 'pause' ? 'paused' : 'downloading',
              speed: action === 'pause' ? 0 : current[entry.seasonKey]?.[entry.release]?.speed || 0,
            },
          },
        }))
        startPolling(entry.seasonKey, entry.release)
        pollProgress(entry.seasonKey, entry.release)
      }
      return true
    } catch (error: any) {
      toast.show(`Could not ${action} torrent: ${error.message}`, 'error')
      return false
    } finally {
      controllingDownload.current = false
      setBusyDownload(null)
    }
  }

  const activeDownloads: DownloadEntry[] = []
  for (const season of group.seasons) {
    const seasonDl = dlBySeason[season.key]
    if (!seasonDl) continue
    const byIndex = new Map(uniqueReleases(season.releases || []).map((x) => [x.index, x.rel]))
    for (const [releaseIndex, state] of Object.entries(seasonDl)) {
      if (state.phase !== 'sending' && state.phase !== 'downloading' && state.phase !== 'paused' && state.phase !== 'error') continue
      const rel = byIndex.get(Number(releaseIndex))
      activeDownloads.push({
        id: `${season.key}\u0000${releaseIndex}`,
        season: seasonLabel(season),
        releaseGroup: rel?.releaseGroup || 'Unknown release',
        seasonKey: season.key,
        release: Number(releaseIndex),
        identity: rel ? releaseIdentity(rel) : undefined,
        phase: state.phase,
        progress: state.progress,
        downloaded: state.downloaded,
        total_size: state.total_size,
        speed: state.speed,
      })
    }
  }

  const seasonCount = group.seasons.length
  const upgradableSeasonCount = group.seasons.filter(isSeasonUpgradable).length
  const delta = cardSizeDelta(group)

  useEffect(() => {
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
      if (openFrame.current !== null) window.cancelAnimationFrame(openFrame.current)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  const requestClose = () => {
    if (closing.current) return
    closing.current = true
    if (openFrame.current !== null) {
      window.cancelAnimationFrame(openFrame.current)
      openFrame.current = null
    }
    setDetailsVisible(false)
    closeTimer.current = window.setTimeout(() => {
      closing.current = false
      setDetailsOpen(false)
    }, 220)
  }

  useEffect(() => {
    if (!detailsOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    openFrame.current = window.requestAnimationFrame(() => {
      setDetailsVisible(true)
      openFrame.current = null
    })
    closeRef.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [detailsOpen])

  const handleHide = () => {
    if (hiding) return
    if (hidden) {
      onToggle()
      return
    }
    setHiding(true)
    hideTimer.current = window.setTimeout(onToggle, HIDE_DURATION_MS)
  }

  const handleOpenDetails = () => {
    setDetailsVisible(false)
    setDetailsOpen(true)
  }

  const toggleExclusion = async (season: ResultItem, part: string, excluded: boolean) => {
    if (!season.library_key) return
    const id = `${season.key}:${part || '*'}`
    setRuleBusy(id)
    try {
      await api.setExclusion(season.library_key, season.season, part, excluded)
      await onRulesChanged()
      toast.show(`${part || seasonLabel(season)} ${excluded ? 'ignored' : 'restored'} for bulk downloads and notifications`, 'success')
    } catch (error: any) {
      toast.show('Could not update the exclusion: ' + error.message, 'error')
    } finally { setRuleBusy('') }
  }

  const applyMapping = async (anilistId: number | null) => {
    const libraryKey = group.seasons[0]?.library_key
    if (!libraryKey) throw new Error('Run a new scan before correcting this match')
    await api.setMappingOverride(libraryKey, anilistId)
    setMappingOpen(false)
    toast.show(anilistId ? `Manual AniList match saved; rescanning ${group.title}` : 'Automatic AniList matching restored; rescanning library', 'success')
    onRescan()
  }

  const statusBadge = <div className="library-status-badge" data-library-status={group.status}>
    <span className="library-status-label"><Icon name={CARD_STATUS[group.status].icon} size={14} className="shrink-0"/><span>{STATUS_LABEL[group.status]}</span></span>
    {group.status === 'partial' && upgradableSeasonCount > 0 && <span className="library-status-upgrades"><Icon name="arrow-up" size={13} className="shrink-0"/><span>{upgradableSeasonCount} {group.arr === 'Radarr' ? (upgradableSeasonCount === 1 ? 'movie' : 'movies') : (upgradableSeasonCount === 1 ? 'season' : 'seasons')} upgradable</span></span>}
  </div>

  return <>
    <article
      className={cx(
        CARD_BASE, 'library-card-readable',
        hiding && 'pointer-events-none !translate-y-1 !scale-[0.98] opacity-0',
        hidden && 'border-dashed !border-line-strong',
      )}
    >
      <div className={cx('library-card-body', st === 'missing' && 'grayscale', hidden && 'grayscale-70')}>
        <div className="library-card-poster">
          <span className="absolute inset-0 grid place-items-center text-muted-dim" aria-hidden="true"><Icon name="library" size={32}/></span>
          {group.image && <img className="absolute inset-0 h-full w-full object-cover" src={group.image} alt="" loading={index < 4 ? 'eager' : 'lazy'} decoding="async" onError={event => { event.currentTarget.style.display = 'none' }}/>}
        </div>
        <div className="library-card-info">
        {group.banner && <img src={group.banner} alt="" loading={index < 4 ? 'eager' : 'lazy'} decoding="async" className="library-card-banner" onError={event => { event.currentTarget.style.display = 'none' }}/>}
        <div ref={copyRef} className="library-card-copy app-scrollbar" tabIndex={copyOverflows ? 0 : undefined} role={copyOverflows ? 'group' : undefined} aria-label={copyOverflows ? `${group.title}: scroll to read the full title` : undefined}>
        <h2 className="anime-art-title relative m-0 text-lg leading-snug font-bold text-white wrap-anywhere" title={group.title}>{group.title}</h2>
        </div>
        <div className="library-status-banner app-scrollbar">{statusBadge}</div>
        </div>
      </div>
        <div className="library-card-seasons flex flex-wrap gap-1.5 px-3.5 pb-3.5 max-[600px]:px-3 max-[600px]:pb-3" aria-label={`${seasonCount} seasons`}>
          {group.seasons.slice(0, 6).map((season) => <SeasonBadge key={season.key} season={season} fallback={st} animeTitle={group.title} className="rounded-md border px-2 py-1 text-xs font-extrabold"/>)}
          {seasonCount > 6 && <span className="rounded-md border border-line bg-panel-raised px-2 py-1 text-xs font-bold text-muted">+{seasonCount - 6}</span>}
        </div>
      {activeDownloads.length > 0 && <div className="border-t border-line px-3.5 py-3 max-[600px]:px-3">
            <DownloadsPanel
              downloads={activeDownloads}
              busyId={busyDownload}
              onPause={(entry) => void handleDownloadAction(entry, 'pause')}
              onResume={(entry) => void handleDownloadAction(entry, 'resume')}
              onRemove={(entry) => { setDeleteFiles(false); setRemoveTarget(entry) }}
            />
      </div>}
        <footer className="mt-auto flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3.5 py-3 max-[600px]:px-3">
          <div className="flex min-w-0 grow basis-24 flex-wrap items-center gap-x-2 gap-y-1 wrap-anywhere">
            {delta !== 0 ? <LibrarySizeChange delta={delta} title={group.title}/> : <span className="text-xs text-muted-dim">{seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}</span>}
            {group.seasons.some(season => (season.missing_episode_count || 0) > 0) && <span className="text-xs text-warn">{group.seasons.reduce((sum, season) => sum + (season.missing_episode_count || 0), 0)} episodes missing</span>}
          </div>
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
            {group.arr_url ? (
              <a
                className="library-card-source touch-target grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-panel-raised"
                href={group.arr_url}
                target="_blank"
                rel="noopener"
                title={`Open ${group.title} in ${group.arr}`}
                aria-label={`Open ${group.title} in ${group.arr} (new tab)`}
              ><BrandLogo name={srcClass} size={20}/></a>
            ) : (
              <span className="library-card-source grid size-8 shrink-0 place-items-center rounded-lg" title={group.arr} role="img" aria-label={`Source: ${group.arr}`}><BrandLogo name={srcClass} size={20}/></span>
            )}
            <button className="touch-target inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent/10" type="button" aria-label={`Details for ${group.title}`} onClick={handleOpenDetails}>Details <Icon name="chevron-right" size={15}/></button>
            <button className={cx(ICON_BUTTON, 'touch-target size-8 shrink-0 disabled:cursor-wait', hidden && 'text-warn')} type="button" title={hidden ? 'Show this card' : 'Hide this card'} aria-label={(hidden ? 'Show ' : 'Hide ') + group.title} onClick={handleHide} disabled={hiding}><HideActionIcon hidden={hidden}/></button>
          </div>
        </footer>
    </article>
    {detailsOpen && (
      <Modal open={detailsOpen} labelledBy={titleId} onClose={requestClose} className="overflow-clip bg-transparent p-0">
        <div className={cx('details-backdrop absolute inset-0 bg-black/65', detailsVisible && 'details-backdrop-visible')} />
        <div className={cx('absolute inset-0 flex items-center justify-center overflow-clip p-4 transition-opacity duration-200 ease-out', detailsVisible ? 'opacity-100' : 'opacity-0')} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
          <aside className="flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-[864px] flex-col overflow-hidden rounded-2xl bg-canvas shadow-[0_24px_60px_rgba(0,0,0,.45)]">
          <header className="anime-details-header flex shrink-0 items-center gap-3 border-b border-line px-5 py-4 max-[600px]:px-4">
            {group.image && <img src={group.image} alt="" className="h-14 w-10 shrink-0 rounded-md object-cover max-[600px]:hidden"/>}
            <div className="min-w-0 flex-1"><h2 id={titleId} className="m-0 text-2xl leading-tight font-extrabold tracking-tight wrap-anywhere max-[600px]:text-xl">{group.title}</h2><p className="mt-1 mb-0 text-xs text-muted">{group.arr} · {seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}<span className="min-[601px]:hidden"> · {STATUS_LABEL[group.status]}</span></p></div>
            <span className={cx('shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold max-[600px]:hidden', STATUS_BADGE[st])}>{STATUS_LABEL[group.status]}</span>
            <button ref={closeRef} type="button" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-control border border-line-strong bg-panel text-ink hover:bg-panel-raised" onClick={requestClose} aria-label="Close details"><Icon name="close"/></button>
          </header>
          <div className="anime-details-body app-scrollbar min-h-0 overflow-y-auto overscroll-contain">
            {group.banner && <div className="relative h-40 shrink-0 overflow-hidden bg-panel bg-cover bg-center max-[600px]:h-28" style={{ backgroundImage: `url('${group.banner}')` }}><div className="absolute inset-0 bg-linear-to-t from-canvas via-canvas/20 to-transparent"/></div>}
            <div className="space-y-6 p-5 max-[600px]:p-4">
            <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Anime links">{group.arr_url && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={group.arr_url} target="_blank" rel="noopener"><Icon name="server" size={15}/>Open in {group.arr}</a>}{typeof group.anilist_id === 'number' && <a className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-accent-bright hover:bg-panel-raised hover:no-underline')} href={`https://anilist.co/anime/${group.anilist_id}`} target="_blank" rel="noopener">Open in AniList <Icon name="chevron-right" size={14}/></a>}<button type="button" className={cx(buttonBase, 'min-h-11 border-line bg-panel px-3 text-xs text-muted hover:bg-panel-raised hover:text-ink')} onClick={() => setMappingOpen(true)} disabled={!group.seasons[0]?.library_key} title={!group.seasons[0]?.library_key ? 'Run a new scan to enable manual matching' : undefined}><Icon name="refresh" size={14}/>{group.seasons.some((season) => season.mapping_override) ? 'Change manual match' : 'Correct match'}</button>{group.seasons.some((season) => season.mapping_override) && <span className="rounded-full border border-purple/35 bg-purple/10 px-2 py-1 text-xs font-bold text-ink">Manual match</span>}</nav>
            {group.seasons.map((season) => <Season
              key={season.key}
              r={season}
              config={config}
              dl={dlBySeason[season.key] || {}}
              busyDownload={busyDownload}
              onDownload={(release) => void handleDownload(season.key, release)}
              onPause={(entry) => void handleDownloadAction(entry, 'pause')}
              onResume={(entry) => void handleDownloadAction(entry, 'resume')}
              onRemove={(entry) => { setDeleteFiles(false); setRemoveTarget(entry) }}
              ruleBusy={ruleBusy}
              onToggleExclusion={(part, excluded) => void toggleExclusion(season, part, excluded)}
            />)}
          </div>
          </div>
          </aside>
        </div>
      </Modal>
    )}
    <ConfirmDialog
      open={removeTarget !== null}
      title="Remove torrent?"
      description="The torrent will be removed from qBittorrent. Its downloaded files are kept unless you choose to delete them below."
      confirmLabel="Remove torrent"
      dangerous
      onConfirm={async () => { if (removeTarget && !await handleDownloadAction(removeTarget, 'remove', deleteFiles)) throw new Error('Could not remove this torrent. Please retry or open qBittorrent to manage it.') }}
      onClose={() => { setRemoveTarget(null); setDeleteFiles(false) }}
    >
      <label className="mb-5 flex cursor-pointer items-center gap-3 rounded-xl border border-bad/25 bg-bad/7 p-3 text-sm text-ink">
        <input type="checkbox" className="size-4 accent-bad" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} />
        <span><span className="block font-bold text-bad">Also delete downloaded files</span><span className="mt-0.5 block text-xs text-muted">This cannot be undone.</span></span>
      </label>
    </ConfirmDialog>
    <MappingDialog open={mappingOpen} title={group.title} currentAniListId={group.anilist_id} hasOverride={group.seasons.some((season) => season.mapping_override)} onApply={applyMapping} onClose={() => setMappingOpen(false)}/>
  </>
}

interface SeasonProps {
  r: ResultItem
  config: Config | null
  dl: Record<number, DlState>
  busyDownload: string | null
  onDownload: (release: number) => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
  ruleBusy: string
  onToggleExclusion: (part: string, excluded: boolean) => void
}

interface DisplayRelease {
  rel: Release
  index: number
}

/** Live download state for one release row (keyed by its release index). */
type DlState = DetailsDownloadState

const IDLE_DL: DlState = {
  phase: 'idle',
  progress: 0,
  downloaded: 0,
  total_size: 0,
  speed: 0,
}

/**
 * Older cached scan results can still contain one row per tracker.  The
 * backend now removes those duplicates, but deduplicating here as well keeps
 * the card correct until the next scan and preserves the original download
 * index used by the API.
 */
function uniqueReleases(releases: Release[]): DisplayRelease[] {
  const selected = new Map<string, DisplayRelease>()

  releases.forEach((rel, index) => {
    const key = `${rel.part || ''}\u0000${rel.releaseGroup.trim().toLowerCase()}`
    const current = selected.get(key)
    if (!current || (rel.downloadable && !current.rel.downloadable)) {
      selected.set(key, { rel, index })
    }
  })

  return [...selected.values()].sort((a, b) => a.index - b.index)
}

/**
 * Group consecutive display releases by their cour part label so each cour
 * can be rendered with its own header and a divider separates the cours.
 */
function groupByCour(releases: DisplayRelease[]): { part: string; items: DisplayRelease[] }[] {
  const groups: { part: string; items: DisplayRelease[] }[] = []
  for (const dr of releases) {
    const part = dr.rel.part || ''
    const last = groups[groups.length - 1]
    if (last && last.part === part) {
      last.items.push(dr)
    } else {
      groups.push({ part, items: [dr] })
    }
  }
  return groups
}

function Season({ r, config, dl, busyDownload, onDownload, onPause, onResume, onRemove, ruleBusy, onToggleExclusion }: SeasonProps) {
  const groups = groupByCour(uniqueReleases(r.releases || []))
  const split = groups.some(group => group.part)
  const displaySeasonHave = !r.precise_part_ownership || !split
  const sources = (r.urls?.length ? r.urls : r.url ? [{ label: 'releases.moe', url: r.url }] : []).filter(source => source.label === 'releases.moe')
  const seasonName = typeof r.season === 'number' ? 'Season ' + r.season : seasonLabel(r)
  const ignored = Boolean(r.excluded)
  const unavailable = r.status === 'missing' || r.status === 'uncovered'

  return (
    <section className="min-w-0 border-t border-line pt-6 first:border-t-0 first:pt-0" aria-label={seasonName}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-44">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-lg font-bold tracking-tight">{seasonName}</h3>
            <SeasonBadge season={r} fallback={r.status || 'upgrade'} className="rounded-full border px-2 py-1 text-xs font-bold"/>
          </div>
          <p className="m-0 text-xs text-muted wrap-anywhere">{displaySeasonHave ? 'Current release: ' + (r.have.length ? r.have.join(', ') : 'None') : 'Split into ' + groups.length + ' cours'}{(r.missing_episode_count || 0) > 0 && <span className="text-warn"> · {r.missing_episode_count} episode{r.missing_episode_count === 1 ? '' : 's'} missing</span>}</p>
        </div>
        {sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex <Icon name="chevron-right" size={14}/></a>)}
        <button type="button" className={cx(buttonBase, 'min-h-11 shrink-0 justify-center px-3 text-xs', ignored ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line-strong bg-panel text-ink hover:bg-panel-raised')} aria-pressed={ignored} aria-label={(ignored ? 'Include ' : 'Ignore ') + seasonName + ' in bulk downloads and notifications'} title={!r.library_key ? 'Run a new scan to enable season rules' : 'Bulk downloads and notifications only. Individual downloads remain available.'} disabled={!r.library_key || Boolean(ruleBusy)} onClick={() => onToggleExclusion('', !ignored)}><Icon name="ban" size={15}/>{ignored ? 'Ignored for bulk' : 'Ignore season'}</button>
      </div>

      {unavailable ? <p className="m-0 rounded-lg border border-dashed border-line-strong bg-panel px-4 py-3 text-sm text-muted">{r.status === 'uncovered' ? 'This season is not covered on releases.moe' : r.match_status === 'unmatched' || !r.anilist_id ? 'AniList match needs review. Use Correct match to choose the right anime.' : 'Not listed on releases.moe'}</p> : <>
        {!!r.unavailable_parts?.length && <div className="mb-4 flex flex-wrap items-start gap-2 rounded-lg border border-warn/35 bg-warn/8 px-3 py-2 text-xs text-warn" role="status"><Icon name="alert" size={15}/><div className="min-w-0 flex-1"><strong>Unavailable:</strong> {r.unavailable_parts.map(part => <span key={part.label + ':' + part.reason} className="block wrap-anywhere">{part.label} · {part.reason}</span>)}</div></div>}
        {groups.length === 0 && <p className="m-0 text-sm text-muted">No release details are available. Run a new library scan to refresh this title.</p>}
        {groups.map((group, groupIndex) => {
          const partIgnored = ignored || Boolean(r.excluded_parts?.includes(group.part))
          const owned = r.precise_part_ownership ? r.have_by_part?.[group.part] || [] : []
          const partSources = (r.urls || []).filter(source => source.label === group.part)
          return <div key={group.part || 'all'} className={cx('min-w-0', groupIndex > 0 && 'mt-5 border-t border-line pt-5')}>
            {group.part && <div className="mb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1"><h4 className="m-0 text-sm font-bold">{group.part}</h4>{r.precise_part_ownership && <p className="mt-1 mb-0 text-xs text-muted wrap-anywhere">{owned.length ? 'Current release: ' + owned.join(', ') : 'No matching files owned'}</p>}</div>
                <button type="button" className={cx(buttonBase, 'min-h-11 justify-center px-3 text-xs', partIgnored ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line-strong bg-panel text-ink hover:bg-panel-raised')} aria-pressed={partIgnored} aria-label={(partIgnored ? 'Include ' : 'Ignore ') + group.part + ' in bulk downloads and notifications'} disabled={!r.library_key || ignored || Boolean(ruleBusy)} onClick={() => onToggleExclusion(group.part, !partIgnored)}><Icon name="ban" size={15}/>{partIgnored ? 'Ignored for bulk' : 'Ignore cour'}</button>
              </div>
              <p className="mt-2 mb-0 text-xs text-muted">{ignored ? 'Restore the season to change individual cour rules.' : 'Cour rules affect bulk downloads and notifications only.'}</p>
              {partSources.length > 0 && <div className="mt-1 flex flex-wrap gap-2">{partSources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener" className="touch-target inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-accent-bright">SeaDex · {group.part}<Icon name="chevron-right" size={14}/></a>)}</div>}
            </div>}
            <div className="flex min-w-0 flex-col gap-3">{group.items.map(({ rel, index }) => <ReleaseDetails key={(rel.part || '') + '-' + rel.releaseGroup} result={r} release={rel} index={index} config={config} state={dl[index] || IDLE_DL} busy={busyDownload !== null} onDownload={() => onDownload(index)} onPause={onPause} onResume={onResume} onRemove={onRemove}/>)}</div>
            {group.part && r.notes_by_part?.[group.part] && r.notes_by_part[group.part] !== '-' && <p className="mt-3 mb-0 whitespace-pre-line text-xs leading-relaxed text-muted wrap-anywhere">{r.notes_by_part[group.part]}</p>}
          </div>
        })}
        {!split && r.notes && r.notes !== '-' && <p className="mt-3 mb-0 whitespace-pre-line text-xs leading-relaxed text-muted wrap-anywhere">{r.notes}</p>}
      </>}
    </section>
  )
}
