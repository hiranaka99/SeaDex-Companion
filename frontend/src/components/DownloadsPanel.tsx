import { DownloadEntry, useDownloads } from './DownloadsProvider'
import { formatBytes, formatEta } from '../utils'
import Icon from './Icons'

function EntryRow({ entry }: { entry: DownloadEntry }) {
  const pct = Math.min(100, Math.round(entry.progress * 1000) / 10)
  const remaining = Math.max(0, entry.total_size - entry.downloaded)
  const eta = entry.phase === 'downloading' ? formatEta(remaining, entry.speed) : ''
  const speed = entry.phase === 'downloading' && entry.speed > 0 ? formatBytes(entry.speed) + '/s' : ''
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-ink" title={entry.title}>{entry.title}</span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-[10px] font-extrabold text-muted">{entry.season}</span>
      </div>
      <div className="truncate text-[11px] text-muted" title={entry.releaseGroup}>{entry.releaseGroup}</div>
      <div className="h-1.5 overflow-hidden rounded-full border border-line bg-panel-raised">
        <div className="h-full rounded-full bg-linear-to-r from-accent to-good transition-[width] duration-500" style={{ width: Math.max(pct, 2) + '%' }} />
      </div>
      <div className="flex items-center gap-1.5 text-[11px] tabular-nums">
        <span className="shrink-0 font-semibold text-accent-bright">{entry.phase === 'sending' ? 'Sending…' : pct.toFixed(1) + '%'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-dim">
          {speed && <span>{speed}</span>}
          {eta && (<><span aria-hidden="true">·</span><span>{eta}</span></>)}
        </span>
      </div>
    </li>
  )
}

export default function DownloadsPanel() {
  const { downloads } = useDownloads()
  return (
    <div className="rounded-xl border border-line bg-panel/70 p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/12 text-accent-bright"><Icon name="download" size={14} /></span>
        <span className="text-[11px] font-bold tracking-[0.12em] text-muted uppercase">Downloads</span>
        {downloads.length > 0 && (
          <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-extrabold text-accent-bright">{downloads.length}</span>
        )}
      </div>
      {downloads.length === 0 ? (
        <p className="mt-2 mb-0 text-[11px] text-muted-dim">No active downloads</p>
      ) : (
        <ul className="app-scrollbar mt-3 flex max-h-[220px] flex-col gap-3 overflow-y-auto pr-1">
          {downloads.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
        </ul>
      )}
    </div>
  )
}