import { formatBytes, formatEta } from '../utils'
import Icon from './Icons'
import { cx, downloadTextTone } from '../styles'

export interface DownloadEntry {
  id: string
  season: string
  releaseGroup: string
  seasonKey: string
  release: number
  identity?: string
  phase: 'sending' | 'downloading' | 'paused' | 'error'
  progress: number
  downloaded: number
  total_size: number
  speed: number
}

interface Props {
  downloads: DownloadEntry[]
  busyId: string | null
  onPause: (entry: DownloadEntry) => void
  onResume: (entry: DownloadEntry) => void
  onRemove: (entry: DownloadEntry) => void
}

interface DownloadActionsProps {
  entry: DownloadEntry
  busy: boolean
  onPause: () => void
  onResume: () => void
  onRemove: () => void
}

export function DownloadActions({ entry, busy, onPause, onResume, onRemove }: DownloadActionsProps) {
  return <>
    <button type="button" className="touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-accent/50 hover:text-accent-bright disabled:cursor-wait disabled:opacity-50" title={entry.phase === 'paused' ? 'Resume torrent' : 'Pause torrent'} aria-label={`${entry.phase === 'paused' ? 'Resume' : 'Pause'} torrent · ${entry.season} · ${entry.releaseGroup}`} disabled={busy || entry.phase === 'sending'} onClick={entry.phase === 'paused' ? onResume : onPause}><Icon name={entry.phase === 'paused' ? 'play' : 'pause'} size={14} /></button>
    <button type="button" className="touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-bad/50 hover:text-bad disabled:cursor-wait disabled:opacity-50" title="Remove torrent" aria-label={`Remove torrent · ${entry.season} · ${entry.releaseGroup}`} disabled={busy || entry.phase === 'sending'} onClick={onRemove}><Icon name="trash" size={14} /></button>
  </>
}

function EntryRow({ entry, busy, onPause, onResume, onRemove }: { entry: DownloadEntry; busy: boolean; onPause: () => void; onResume: () => void; onRemove: () => void }) {
  const pct = Math.min(100, Math.round(entry.progress * 1000) / 10)
  const remaining = Math.max(0, entry.total_size - entry.downloaded)
  const eta = entry.phase === 'downloading' ? formatEta(remaining, entry.speed) : ''
  const speed = entry.phase === 'downloading' && entry.speed > 0 ? formatBytes(entry.speed) + '/s' : ''
  return (
    <li className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 basis-20 flex-1 truncate text-xs font-semibold text-ink" title={entry.releaseGroup}>{entry.releaseGroup}</span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-xs font-extrabold text-ink">{entry.season}</span>
        <span className="ml-auto inline-flex items-center gap-1.5"><DownloadActions entry={entry} busy={busy} onPause={onPause} onResume={onResume} onRemove={onRemove}/></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full border border-line bg-panel-raised">
        <div className="h-full rounded-full bg-linear-to-r from-accent to-good transition-[width] duration-500" style={{ width: Math.max(pct, 2) + '%' }} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pb-px text-xs leading-snug tabular-nums">
        <span className={cx('shrink-0 font-semibold', downloadTextTone(entry.phase))}>{entry.phase === 'error' ? 'Download error' : entry.phase === 'sending' ? 'Sending…' : entry.phase === 'paused' ? `Paused · ${pct.toFixed(1)}%` : pct.toFixed(1) + '%'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-dim">
          {speed && <span>{speed}</span>}
          {eta && (<><span aria-hidden="true">·</span><span>{eta}</span></>)}
        </span>
      </div>
    </li>
  )
}

export default function DownloadsPanel({ downloads, busyId, onPause, onResume, onRemove }: Props) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/6 px-2.5 py-2">
      <ul className="download-scrollbar m-0 flex max-h-56 list-none flex-col gap-3 overflow-y-auto p-0" aria-label="Active downloads">
        {downloads.map((entry) => <EntryRow key={entry.id} entry={entry} busy={busyId !== null} onPause={() => onPause(entry)} onResume={() => onResume(entry)} onRemove={() => onRemove(entry)} />)}
      </ul>
    </div>
  )
}
