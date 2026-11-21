import { normalizeTorrentPath as normalizeFile } from '../../../shared/download-plan'
import { useMemo } from 'react'
import type { Config, Release, ResultItem } from '../types'
import { formatBytes, formatEta, providerNames, seasonLabel, sizeDelta } from '../utils'
import { buttonBase, cx, downloadTextTone } from '../styles'
import Icon from './Icons'
import { DownloadActions, clientName, phaseLabel, type DownloadEntry } from './DownloadsPanel'
import { estimateDownloads } from '../../../shared/download-estimate'
import type { DownloadProtocol, UsenetAvailabilityResult } from '../api'
import type { DetailsDownloadState } from '../useCardDownloads'

interface Props {
  result: ResultItem
  release: Release
  config: Config | null
  state: DetailsDownloadState
  busy: boolean
  /** Effective protocol for this release (resolved against the download mode). */
  protocol: DownloadProtocol
  availability?: UsenetAvailabilityResult
  availabilityLoading: boolean
  sabnzbdConfigured: boolean
  onProtocol: (protocol: DownloadProtocol) => void
  onRefreshAvailability: () => void
  onDownload: () => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
}

const bytesOrUnknown = (bytes: number) => bytes > 0 ? formatBytes(bytes) : 'Size unavailable'

interface UsenetInfo {
  usable: boolean
  label: string
  detail: string
}

/** Human Usenet state for one release; the server re-validates everything. */
function describeUsenet(row: UsenetAvailabilityResult | undefined, sabnzbdConfigured: boolean | undefined): UsenetInfo | null {
  if (!row) return null
  const hash = row.hashes[0]
  if (!sabnzbdConfigured) return { usable: false, label: 'Usenet needs SABnzbd', detail: 'Set up SABnzbd in Settings to download over Usenet.' }
  if (row.aggregate === 'available') {
    const foundOn = providerNames(row.hashes.map(item => item.provider))
    const size = hash?.total_bytes ? ` · ~${formatBytes(hash.total_bytes).replace(' ', '\u00a0')}` : ''
    const extras = hash?.files_known && hash.file_count ? ` · ${hash.file_count} file source` : ''
    return { usable: true, label: `Usenet source found${foundOn.length ? ` on ${foundOn.join(' and ')}` : ''}${size}${extras}`, detail: 'The Usenet source is the whole upload; files beyond the selected episodes will also download.' }
  }
  if (row.aggregate === 'processing') return { usable: false, label: 'Not found on Usenet indexers yet', detail: 'The indexer is still converting this release on their side; it can take hours after release. Re-check refreshes the status.' }
  if (row.aggregate === 'incomplete') return { usable: false, label: 'Usenet source uncertain', detail: 'Providers returned partial results for this release.' }
  if (row.aggregate === 'no_match') return { usable: false, label: 'Not found on Usenet indexers', detail: 'None of the enabled Usenet indexers has this release.' }
  if (row.aggregate === 'lookup_failed') {
    const providers = providerNames(hash?.providers_failed || [])
    return { usable: false, label: 'Usenet lookup failed', detail: `${providers.length ? `${providers.join(' and ')} ` : 'The Usenet source '}could not be reached. Retry in a moment.` }
  }
  if (row.aggregate === 'unsupported_hash') return { usable: false, label: 'Usenet unavailable', detail: 'This release has no hash the enabled Usenet sources can search.' }
  return { usable: false, label: 'Usenet not set up', detail: 'Enable an Usenet source (AnimeTosho or AmeNZB) in Settings.' }
}

export default function ReleaseDetails({ result: r, release: rel, config, state, busy, protocol, availability, availabilityLoading, sabnzbdConfigured, onProtocol, onRefreshAvailability, onDownload, onPause, onResume, onRemove }: Props) {
  const isBest = rel.kind === 'best'
  const localSize = rel.part ? r.local_size_by_part?.[rel.part] || 0 : r.local_size
  const delta = sizeDelta(rel.size, localSize)
  const transfers = state.transfers
  const active = transfers.filter(transfer => transfer.phase !== 'complete')
  const complete = transfers.length > 0 && active.length === 0
  const inClient = active.length > 0
  const mode = config?.download_mode || 'torrent_only'
  const category = (r.arr === 'Sonarr' ? config?.sonarr_category : config?.radarr_category)?.trim() || r.arr
  const usenetEnabled = mode !== 'torrent_only'
  const sabReady = sabnzbdConfigured || Boolean(config?.sabnzbd_url && config?.sabnzbd_key_configured)
  const usenet = usenetEnabled ? describeUsenet(availability, sabReady) : null
  const chosen: DownloadProtocol = mode === 'torrent_only' ? 'torrent' : mode === 'usenet_only' ? 'usenet' : protocol
  const torrentUsable = rel.torrent_available
  const usenetUsable = usenet?.usable === true
  const protocolUsable = chosen === 'torrent' ? torrentUsable : usenetUsable
  const disabled = inClient || complete || !protocolUsable

  const fileScope = useMemo(() => {
    const estimate = estimateDownloads([{ release: rel, category: '' }])
    const exact = estimate.torrents.length > 0 && estimate.unknown_torrents === 0 && estimate.approximate_torrents === 0
    const selected = [...new Map((rel.selected_files || []).map(name => [normalizeFile(name), name])).values()]
    const catalogs = new Map<string, { name: string; sizes: number[] }>()
    for (const catalog of rel.torrent_files || []) {
      if (!rel.info_hashes.some(hash => hash.toLowerCase() === catalog.hash.toLowerCase())) continue
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
      bytes: estimate.new_bytes,
      approximateBytes: !selected.length && estimate.unknown_torrents === 0 && estimate.torrents.length > 0 ? estimate.new_bytes : null,
      files: names.map(name => {
        const sizes = catalogs.get(normalizeFile(name))?.sizes || []
        const size = sizes.length === 1 && Number.isSafeInteger(sizes[0]) && sizes[0] >= 0 ? sizes[0] : null
        return { name, size }
      }),
    }
  }, [rel])
  const sizeLabel = fileScope.exact ? formatBytes(fileScope.bytes) || '0 B'
    : fileScope.approximateBytes !== null ? `~${formatBytes(fileScope.approximateBytes) || '0 B'}` : 'size unavailable'
  const scopeLabel = fileScope.selected
    ? `${fileScope.files.length} selected file${fileScope.files.length === 1 ? '' : 's'} · ${sizeLabel}`
    : `Whole release · ${sizeLabel}`

  const buttonTitle = complete ? `Download completed in ${clientName(transfers[0].client)}`
    : inClient ? `${phaseLabel(active[0].phase)} in ${clientName(active[0].client)}`
    : chosen === 'usenet' ? (usenetUsable ? `Send this release to SABnzbd (category: ${r.arr === 'Sonarr' ? config?.sabnzbd_sonarr_category : config?.sabnzbd_radarr_category})` : usenet?.detail || 'Usenet is not available for this release')
    : rel.torrent_available ? `Send this release to qBittorrent (category: ${category})` : 'No magnet available (private tracker)'
  const buttonLabel = complete ? 'Download completed'
    : inClient ? phaseLabel(active[0].phase)
    : !protocolUsable ? (chosen === 'usenet' ? 'Usenet unavailable' : 'Unavailable')
    : chosen === 'usenet' ? 'Download on Usenet'
    : fileScope.selected ? `Download ${fileScope.files.length} file${fileScope.files.length === 1 ? '' : 's'}` : 'Download release'

  const tags = [...new Set([...(rel.dual_audio ? ['Dual Audio'] : []), ...(rel.tags || [])])]
  const statusCopy = complete ? `Download completed in ${clientName(transfers[0].client)}` : ''
  const usenetCategory = r.arr === 'Sonarr' ? config?.sabnzbd_sonarr_category : config?.sabnzbd_radarr_category

  return (
    <article className={cx('release-row min-w-0 rounded-xl border p-4 max-[600px]:p-3.5', inClient ? 'border-accent bg-accent/5' : isBest ? 'border-good/35 bg-good/5' : 'border-line bg-panel')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={cx('shrink-0 text-xs font-bold', isBest ? 'text-good' : 'text-muted')}>{isBest ? 'BEST' : 'ALTERNATIVE'}</span>
        <div className="release-identity flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="max-w-full text-sm font-semibold text-ink wrap-anywhere">{rel.releaseGroup}</span>
          {tags.length > 0 && <div className="flex min-w-0 flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className={cx('max-w-full rounded-md border px-2 py-0.5 text-xs font-semibold text-ink wrap-anywhere', tag === 'Dual Audio' ? 'border-sky/40 bg-sky/12' : 'border-purple/40 bg-purple/12')}>{tag}</span>)}</div>}
        </div>
      </div>
      <dl className="release-sizes m-0 mb-3 flex flex-wrap gap-x-6 gap-y-2 text-xs wrap-anywhere">
        <div><dt className="mb-1 text-muted">Current files</dt><dd className="m-0 font-semibold tabular-nums text-ink">{bytesOrUnknown(localSize)}</dd></div>
        <div><dt className="mb-1 text-muted">{rel.part ? 'Cour release' : r.arr === 'Radarr' || r.season === 0 ? 'Movie release' : r.season !== null ? 'Season release' : 'Release'}</dt><dd className="m-0 font-semibold tabular-nums text-ink">{bytesOrUnknown(rel.size)}</dd></div>
        {rel.size > 0 && localSize > 0 && <div><dt className="mb-1 text-muted">Release size change</dt><dd className="m-0 font-semibold tabular-nums text-ink">{delta || 'No change'}</dd></div>}
      </dl>
      {usenetEnabled && <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-xs">
        <span className={cx('font-semibold', usenet ? (usenet.usable ? 'text-good' : 'text-warn') : 'text-muted')}>{usenet ? usenet.label : availabilityLoading ? 'Checking Usenet sources…' : 'Usenet: not checked'}</span>
        {usenet && !usenet.usable && <span className="min-w-0 basis-44 flex-1 text-muted-dim">{usenet.detail}</span>}
        <button type="button" className="touch-target inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-accent-bright hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60" disabled={availabilityLoading} onClick={onRefreshAvailability} title="Re-check the Usenet sources for this season" aria-label={`Re-check Usenet sources · ${seasonLabel(r)}`}><Icon name="refresh" size={13}/>{availabilityLoading ? 'Checking…' : 'Re-check'}</button>
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0 flex-1 basis-44">
          {mode === 'choose' && !inClient && !complete && <div className="mb-2.5 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={`Download method · ${seasonLabel(r)} · ${rel.releaseGroup}`}>
            <button type="button" role="radio" aria-checked={chosen === 'torrent'} disabled={!torrentUsable} title={torrentUsable ? 'Download with qBittorrent' : 'No magnet available (private tracker)'} onClick={() => onProtocol('torrent')} className={cx('cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors', chosen === 'torrent' ? 'border-accent bg-accent/14 text-ink' : 'border-line bg-panel text-muted hover:text-ink', !torrentUsable && 'cursor-not-allowed opacity-50')}>Torrent</button>
            <button type="button" role="radio" aria-checked={chosen === 'usenet'} disabled={!usenetUsable} title={usenet?.detail || 'Usenet availability not checked'} onClick={() => onProtocol('usenet')} className={cx('cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors', chosen === 'usenet' ? 'border-sky bg-sky/14 text-ink' : 'border-line bg-panel text-muted hover:text-ink', !usenetUsable && 'cursor-not-allowed opacity-50')}>Usenet</button>
          </div>}
          <p className="m-0 text-sm font-semibold text-ink wrap-anywhere">{complete ? statusCopy : inClient ? `${phaseLabel(active[0].phase)} in ${clientName(active[0].client)}` : chosen === 'usenet' ? 'Whole Usenet source' : !rel.torrent_available && usenetUsable ? 'Usenet only — individual download unavailable' : !rel.torrent_available ? 'Individual download unavailable' : scopeLabel}</p>
          {chosen === 'usenet' && <p className="mt-1 mb-0 text-xs text-muted">Usenet sources cannot be split; {usenetCategory ? `category: ${usenetCategory}` : 'the configured Usenet category will be used'}.</p>}
          {chosen === 'torrent' && !rel.torrent_available && <p className="mt-1 mb-0 text-xs text-muted">A public magnet is not available for this release.</p>}
          {chosen === 'torrent' && !inClient && !complete && rel.torrent_available && !fileScope.exact && <p className="mt-1 mb-0 text-xs text-muted">{fileScope.selected ? 'Selected-file size is unavailable. Release size is shown above.' : fileScope.approximateBytes !== null ? 'Approximate release estimate; file metadata is unavailable.' : 'Download size is unavailable.'}</p>}
        </div>
        {!inClient && <button type="button" className={cx(buttonBase, 'release-download-button min-h-11 min-w-0 max-w-full justify-center px-3 text-xs max-[600px]:w-full', complete ? 'border-good/40 bg-good/12 text-good' : disabled ? 'border-line bg-panel-raised text-muted' : chosen === 'usenet' ? 'border-sky/40 bg-sky/12 text-sky enabled:hover:bg-sky/20' : 'border-good/40 bg-good/12 text-good enabled:hover:bg-good/20')} disabled={disabled} title={buttonTitle} aria-label={`${buttonTitle} · ${r.title} · ${seasonLabel(r)} · ${rel.releaseGroup}`} onClick={onDownload}>
          {complete ? <Icon name="check" size={17}/> : <Icon name="download" size={17}/>}{/* preflight happens before send, so no spinner belongs on this button */}
          <span className="min-w-0 wrap-anywhere">{buttonLabel}</span>
        </button>}
      </div>
      {fileScope.files.length > 0 && !inClient && !complete && chosen !== 'usenet' && <details className="mt-3 min-w-0">
        <summary className="touch-target flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold text-accent-bright"><Icon name="chevron-right" size={14}/>{fileScope.selected ? 'View' : 'Inspect'} {fileScope.files.length} {fileScope.selected ? 'selected' : 'release'} file{fileScope.files.length === 1 ? '' : 's'}</summary>
        <ul className="app-scrollbar mt-2 mb-0 max-h-52 list-none overflow-y-auto rounded-lg bg-canvas/50 px-3 py-2" aria-label={`${rel.releaseGroup} ${fileScope.selected ? 'selected' : 'release'} files`}>{fileScope.files.map(file => <li key={file.name} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5 text-xs"><span className="min-w-0 flex-1 basis-40 text-muted wrap-anywhere">{file.name}</span><span className="shrink-0 tabular-nums text-muted">{file.size === null ? 'Size unavailable' : formatBytes(file.size) || '0 B'}</span></li>)}</ul>
      </details>}
      {transfers.map(transfer => {
        const percent = Math.max(0, Math.min(100, Math.round(transfer.progress * 1000) / 10))
        const showsBar = transfer.phase !== 'complete'
        const client = clientName(transfer.client)
        return <div key={transfer.record_id} className="mt-3 border-t border-line pt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
            <span className={cx('font-semibold', downloadTextTone(transfer.phase))}>{transfer.phase === 'complete' ? `Completed in ${client}` : `${phaseLabel(transfer.phase)} in ${client}`}</span>
            {transfer.total_size > 0 && <span className="text-muted">{percent.toFixed(1)}% · {formatBytes(transfer.downloaded) || '0 B'} / {formatBytes(transfer.total_size)}</span>}
          </div>
          {showsBar && <div role="progressbar" aria-label={`Download progress · ${seasonLabel(r)} · ${rel.releaseGroup}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer.phase === 'acceptance_unknown' ? undefined : percent} aria-valuetext={`${phaseLabel(transfer.phase)} · ${percent.toFixed(1)}%`} className="h-1.5 overflow-hidden rounded-full bg-panel-raised"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(percent, transfer.phase === 'queued' || transfer.phase === 'acceptance_unknown' ? 2 : 0)}%` }}/></div>}
          {transfer.phase === 'error' && <div className="mt-3 rounded-lg bg-bad/5 p-3"><p className="m-0 text-sm font-semibold text-bad">{client} reported a download error</p><p className="mt-1 mb-2 text-xs text-ink wrap-anywhere">{transfer.error || `Open this download in ${client}, resolve the issue, then retry.`}</p></div>}
          {transfer.phase === 'acceptance_unknown' && <p className="mt-2 mb-0 text-xs text-warn">SABnzbd was asked to start this download but did not confirm it. Check SABnzbd before retrying.</p>}
          {transfer.phase === 'missing' && <p className="mt-2 mb-0 text-xs text-bad">This download is no longer in {client}. Remove the entry and send it again if you still want it.</p>}
          {transfer.unbound && <p className="mt-2 mb-0 text-xs text-warn">This download belongs to a different client URL and cannot be controlled from here.</p>}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted wrap-anywhere">{transfer.phase === 'downloading' ? [transfer.speed > 0 && transfer.client === 'qbittorrent' ? `${formatBytes(transfer.speed)}/s` : '', transfer.client === 'qbittorrent' ? formatEta(Math.max(0, transfer.total_size - transfer.downloaded), transfer.speed) : ''].filter(Boolean).join(' · ') : transfer.phase === 'post_processing' || transfer.phase === 'unpacking' ? `${client} is preparing the files…` : ''}</span><span className="ml-auto inline-flex gap-2"><DownloadActions entry={transfer} busy={busy} onPause={() => onPause(transfer)} onResume={() => onResume(transfer)} onRemove={() => onRemove(transfer)}/></span></div>
        </div>
      })}
      <span className="sr-only" role="status" aria-atomic="true">{statusCopy && `${rel.releaseGroup} · ${statusCopy}`}</span>
    </article>
  )
}
