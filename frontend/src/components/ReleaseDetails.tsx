import { useMemo } from 'react'
import type { Config, Release, ResultItem } from '../types'
import { formatBytes, formatEta, seasonLabel, sizeDelta } from '../utils'
import { buttonBase, cx, downloadTextTone } from '../styles'
import Icon from './Icons'
import { DownloadActions, type DownloadEntry } from './DownloadsPanel'
import { estimateDownloads } from '../../../shared/download-estimate'
import { releaseIdentity } from '../../../shared/releases'

export interface DetailsDownloadState {
  phase: 'idle' | 'sending' | 'downloading' | 'paused' | 'complete' | 'error'
  progress: number
  downloaded: number
  total_size: number
  speed: number
}

interface Props {
  result: ResultItem
  release: Release
  index: number
  config: Config | null
  state: DetailsDownloadState
  busy: boolean
  onDownload: () => void
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
}

const bytesOrUnknown = (bytes: number) => bytes > 0 ? formatBytes(bytes) : 'Size unavailable'
const normalizeFile = (name: string) => name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').toLowerCase()

export default function ReleaseDetails({ result: r, release: rel, index, config, state, busy, onDownload, onPause, onResume, onRemove }: Props) {
  const isBest = rel.kind === 'best'
  const localSize = rel.part ? r.local_size_by_part?.[rel.part] || 0 : r.local_size
  const delta = sizeDelta(rel.size, localSize)
  const ownedGroups = r.precise_part_ownership ? r.owned_by_part?.[rel.part || ''] || [] : r.have
  const owned = ownedGroups.some(group => group.toLowerCase() === rel.releaseGroup.toLowerCase())
  const inClient = ['sending', 'downloading', 'paused', 'error'].includes(state.phase)
  const complete = state.phase === 'complete'
  const category = (r.arr === 'Sonarr' ? config?.sonarr_category : config?.radarr_category)?.trim() || r.arr
  const disabled = owned || complete || !rel.downloadable || inClient
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
      // A release-total fallback is not a selected-file estimate.
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
  const buttonTitle = owned ? 'You already have this release'
    : complete ? 'Download completed in qBittorrent'
    : inClient ? state.phase === 'error' ? 'qBittorrent reported a download error' : state.phase === 'paused' ? 'Paused in qBittorrent' : 'Downloading…'
    : rel.downloadable ? `Send this release to qBittorrent (category: ${category})` : 'No magnet available (private tracker)'
  const buttonLabel = owned ? 'Already owned' : complete ? 'Download completed'
    : state.phase === 'sending' ? 'Sending…' : state.phase === 'downloading' ? 'Downloading'
    : state.phase === 'paused' ? 'Paused' : state.phase === 'error' ? 'Download stopped'
    : !rel.downloadable ? 'Unavailable'
    : fileScope.selected ? `Download ${fileScope.files.length} file${fileScope.files.length === 1 ? '' : 's'}` : 'Download release'
  const activeEntry: DownloadEntry | null = inClient ? {
    id: `${r.key}\u0000${index}`, season: seasonLabel(r), releaseGroup: rel.releaseGroup,
    seasonKey: r.key, release: index, identity: releaseIdentity(rel),
    ...state, phase: state.phase as DownloadEntry['phase'],
  } : null
  const percent = Math.max(0, Math.min(100, Math.round(state.progress * 1000) / 10))
  const qbitURL = /^https?:\/\//i.test(config?.qbittorrent_url || '') ? config!.qbittorrent_url : null
  const tags = [...new Set([...(rel.dual_audio ? ['Dual Audio'] : []), ...(rel.tags || [])])]
  const phaseLabel = owned ? 'Release already owned' : complete ? 'Download completed in qBittorrent'
    : state.phase === 'sending' ? 'Sending to qBittorrent…' : state.phase === 'paused' ? 'Download paused'
    : state.phase === 'error' ? 'qBittorrent reported a download error' : state.phase === 'downloading' ? 'Downloading' : ''

  return (
    <article className={cx('release-row min-w-0 rounded-xl border p-4 max-[600px]:p-3.5', inClient ? 'border-accent bg-accent/5' : isBest ? 'border-good/35 bg-good/5' : 'border-line bg-panel')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={cx('shrink-0 text-xs font-bold', isBest ? 'text-good' : 'text-muted')}>{isBest ? 'BEST' : 'ALTERNATIVE'}</span>
        <div className="release-identity flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="max-w-full text-sm font-semibold text-ink wrap-anywhere">{rel.releaseGroup}</span>
          {tags.length > 0 && <div className="flex min-w-0 flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className={cx('max-w-full rounded-md border px-2 py-0.5 text-xs font-semibold text-ink wrap-anywhere', tag === 'Dual Audio' ? 'border-sky/40 bg-sky/12' : 'border-purple/40 bg-purple/12')}>{tag}</span>)}</div>}
        </div>
      </div>
      <dl className="m-0 mb-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
        <div><dt className="mb-1 text-muted">Current files</dt><dd className="m-0 font-semibold tabular-nums text-ink">{bytesOrUnknown(localSize)}</dd></div>
        <div><dt className="mb-1 text-muted">{rel.part ? 'Cour release' : r.season !== null ? 'Season release' : 'Release'}</dt><dd className="m-0 font-semibold tabular-nums text-ink">{bytesOrUnknown(rel.size)}</dd></div>
        <div><dt className="mb-1 text-muted">Release size change</dt><dd className="m-0 font-semibold tabular-nums text-ink">{rel.size > 0 && localSize > 0 ? delta || 'No change' : 'Unavailable'}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0 flex-1 basis-44">
          <p className="m-0 text-sm font-semibold text-ink wrap-anywhere">{owned ? 'Release already owned' : complete ? 'Download completed in qBittorrent' : !rel.downloadable ? 'Individual download unavailable' : scopeLabel}</p>
          {!rel.downloadable && <p className="mt-1 mb-0 text-xs text-muted">A public magnet is not available for this release.</p>}
          {!owned && !complete && rel.downloadable && !fileScope.exact && <p className="mt-1 mb-0 text-xs text-muted">{fileScope.selected ? 'Selected-file size is unavailable. Release size is shown above.' : fileScope.approximateBytes !== null ? 'Approximate release estimate; file metadata is unavailable.' : 'Download size is unavailable.'}</p>}
        </div>
        <button type="button" className={cx(buttonBase, 'min-h-11 justify-center px-3 text-xs max-[600px]:w-full', owned || complete ? 'border-good/40 bg-good/12 text-good' : disabled ? 'border-line bg-panel-raised text-muted' : 'border-good/40 bg-good/12 text-good enabled:hover:bg-good/20')} disabled={disabled} title={buttonTitle} aria-label={`${buttonTitle} · ${r.title} · ${seasonLabel(r)} · ${rel.releaseGroup}`} onClick={onDownload}>
          {owned || complete ? <Icon name="check" size={17}/> : state.phase === 'sending' || state.phase === 'downloading' ? <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden="true"/> : <Icon name={state.phase === 'paused' ? 'pause' : 'download'} size={17}/>}{buttonLabel}
        </button>
      </div>
      {fileScope.files.length > 0 && !owned && !complete && <details className="mt-3 min-w-0">
        <summary className="touch-target flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold text-accent-bright"><Icon name="chevron-right" size={14}/>{fileScope.selected ? 'View' : 'Inspect'} {fileScope.files.length} {fileScope.selected ? 'selected' : 'release'} file{fileScope.files.length === 1 ? '' : 's'}</summary>
        <ul className="app-scrollbar mt-2 mb-0 max-h-52 list-none overflow-y-auto rounded-lg bg-canvas/50 px-3 py-2" aria-label={`${rel.releaseGroup} ${fileScope.selected ? 'selected' : 'release'} files`}>{fileScope.files.map(file => <li key={file.name} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-1.5 text-xs"><span className="min-w-0 flex-1 basis-40 text-muted wrap-anywhere">{file.name}</span><span className="shrink-0 tabular-nums text-muted">{file.size === null ? 'Size unavailable' : formatBytes(file.size) || '0 B'}</span></li>)}</ul>
      </details>}
      {activeEntry && <div className="mt-3 border-t border-line pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums"><span className={cx('font-semibold', downloadTextTone(state.phase))}>{state.phase === 'sending' ? 'Sending to qBittorrent…' : state.phase === 'error' ? 'Download stopped' : state.phase === 'paused' ? 'Paused' : 'Downloading'}</span>{state.total_size > 0 && <span className="text-muted">{percent.toFixed(1)}% · {formatBytes(state.downloaded) || '0 B'} / {formatBytes(state.total_size)}</span>}</div>
        <div role="progressbar" aria-label={`Download progress · ${seasonLabel(r)} · ${rel.releaseGroup}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.phase === 'sending' ? undefined : percent} aria-valuetext={state.phase === 'sending' ? 'Sending to qBittorrent' : `${percent.toFixed(1)}% · ${state.phase}`} className="h-1.5 overflow-hidden rounded-full bg-panel-raised"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${state.phase === 'sending' ? 2 : percent}%` }}/></div>
        {state.phase === 'error' && <div className="mt-3 rounded-lg bg-bad/5 p-3"><p className="m-0 text-sm font-semibold text-bad">qBittorrent reported a download error</p><p className="mt-1 mb-2 text-xs text-ink wrap-anywhere">Check this torrent in qBittorrent, resolve the issue, then resume the download.</p>{qbitURL && <a href={qbitURL} target="_blank" rel="noopener" className={cx(buttonBase, 'min-h-11 border-line bg-panel-raised px-3 text-xs text-accent-bright')}>Open qBittorrent <Icon name="chevron-right" size={14}/></a>}</div>}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted wrap-anywhere">{state.phase === 'downloading' ? state.total_size > 0 ? [state.speed > 0 ? `${formatBytes(state.speed)}/s` : '', formatEta(Math.max(0, state.total_size - state.downloaded), state.speed)].filter(Boolean).join(' · ') : 'Waiting for torrent metadata…' : ''}</span><span className="ml-auto inline-flex gap-2"><DownloadActions entry={activeEntry} busy={busy} onPause={() => onPause(activeEntry)} onResume={() => onResume(activeEntry)} onRemove={() => onRemove(activeEntry)}/></span></div>
      </div>}
      <span className="sr-only" role="status" aria-atomic="true">{phaseLabel && `${rel.releaseGroup} · ${phaseLabel}`}</span>
    </article>
  )
}
