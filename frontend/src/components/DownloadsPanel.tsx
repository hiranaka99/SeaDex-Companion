import { formatBytes, formatEta } from '../utils'
import Icon from './Icons'
import { cx, downloadTextTone } from '../styles'
import type { DownloadCapabilities, DownloadPhase, DownloadProtocol, DownloadProgress } from '../api'

/** One owned acquisition as reported by its download client. */
export interface DownloadEntry {
  id: string
  record_id: string
  protocol: DownloadProtocol
  client: DownloadProgress['client']
  phase: DownloadPhase
  capabilities: DownloadCapabilities
  progress: number
  downloaded: number
  total_size: number
  speed: number
  title: string
  season: string
  releaseGroup: string
  category: string
  size: number
  error?: string
  key?: string
  release?: number
  /** The client at a different URL no longer serves this record. */
  unbound?: boolean
}

export function toDownloadEntry(p: DownloadProgress): DownloadEntry {
  const season = p.season === null ? (p.part || 'Release') : (p.part ? `S${p.season} · ${p.part}` : `S${p.season}`)
  return {
    id: p.record_id,
    record_id: p.record_id,
    protocol: p.protocol,
    client: p.client,
    phase: p.phase,
    capabilities: p.capabilities,
    progress: p.progress,
    downloaded: p.downloaded,
    total_size: p.total_size,
    speed: p.speed,
    title: p.title,
    season,
    releaseGroup: p.release_group || p.title,
    category: p.category,
    size: p.size,
    error: p.error,
    key: p.key,
    release: p.release,
    unbound: p.state === 'unbound',
  }
}

const PHASE_LABEL: Record<DownloadPhase, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  repairing: 'Repairing',
  unpacking: 'Unpacking',
  post_processing: 'Post-processing',
  seeding: 'Seeding',
  complete: 'Complete',
  missing: 'Not in client',
  unavailable: 'Unavailable',
  acceptance_unknown: 'Awaiting confirmation',
  error: 'Error',
}

/** Copy that names the recovery, never a URL or credential. */
const PHASE_HINT: Partial<Record<DownloadPhase, string>> = {
  missing: 'This download is no longer in the client. Remove the entry and send it again if you still want it.',
  unavailable: 'The download client is currently unreachable. Progress resumes when it answers.',
  acceptance_unknown: 'SABnzbd was asked to start this download but did not confirm it. Check SABnzbd before retrying.',
  error: 'The client reported an error. Open the client for details, then remove and retry.',
}

export const clientName = (client: DownloadEntry['client']) => client === 'sabnzbd' ? 'SABnzbd' : 'qBittorrent'
export const phaseLabel = (phase: DownloadPhase) => PHASE_LABEL[phase] || 'Downloading'

/** Progress is meaningful only while bytes move or the client verifies them. */
const showsProgress = (phase: DownloadPhase) => phase === 'downloading' || phase === 'queued' || phase === 'paused' || phase === 'verifying' || phase === 'repairing' || phase === 'unpacking' || phase === 'post_processing' || phase === 'acceptance_unknown'

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

const ACTION_BUTTON = 'touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-accent/50 hover:text-accent-bright disabled:cursor-not-allowed disabled:opacity-50'
const REMOVE_BUTTON = 'touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-bad/50 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50'

export function DownloadActions({ entry, busy, onPause, onResume, onRemove }: DownloadActionsProps) {
  const busyRow = busy || entry.unbound
  const label = `${entry.season} · ${entry.releaseGroup}`
  return <>
    {entry.capabilities.pause && <button type="button" className={ACTION_BUTTON} title={`Pause in ${clientName(entry.client)}`} aria-label={`Pause download · ${label}`} disabled={busyRow} onClick={onPause}><Icon name="pause" size={14}/></button>}
    {entry.capabilities.resume && <button type="button" className={ACTION_BUTTON} title={`Resume in ${clientName(entry.client)}`} aria-label={`Resume download · ${label}`} disabled={busyRow} onClick={onResume}><Icon name="play" size={14}/></button>}
    {entry.capabilities.remove && <button type="button" className={REMOVE_BUTTON} title={`Remove from ${clientName(entry.client)}`} aria-label={`Remove download · ${label}`} disabled={busyRow} onClick={onRemove}><Icon name="trash" size={14}/></button>}
  </>
}

function EntryRow({ entry, busy, onPause, onResume, onRemove }: { entry: DownloadEntry; busy: boolean; onPause: () => void; onResume: () => void; onRemove: () => void }) {
  const pct = Math.max(0, Math.min(100, Math.round(entry.progress * 1000) / 10))
  const remaining = Math.max(0, entry.total_size - entry.downloaded)
  const eta = entry.phase === 'downloading' ? formatEta(remaining, entry.speed) : ''
  const speed = entry.phase === 'downloading' && entry.speed > 0 ? formatBytes(entry.speed) + '/s' : ''
  const hint = entry.error || (entry.unbound ? 'This download belongs to a different client URL. Reconfigure that client or remove the entry.' : PHASE_HINT[entry.phase])
  const statusText = `${clientName(entry.client)} · ${phaseLabel(entry.phase)}${showsProgress(entry.phase) ? ` · ${pct.toFixed(1)}%` : ''}`
  return (
    <li className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 basis-20 flex-1 truncate text-xs font-semibold text-ink" title={entry.title || entry.releaseGroup}>{entry.releaseGroup}</span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-xs font-extrabold text-ink">{entry.season}</span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-xs font-bold text-muted-dim">{clientName(entry.client)}</span>
        <span className="ml-auto inline-flex items-center gap-1.5"><DownloadActions entry={entry} busy={busy} onPause={onPause} onResume={onResume} onRemove={onRemove}/></span>
      </div>
      {showsProgress(entry.phase) && <div role="progressbar" aria-label={`Download progress · ${entry.season} · ${entry.releaseGroup}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.phase === 'acceptance_unknown' ? undefined : pct} aria-valuetext={statusText} className="h-1.5 overflow-hidden rounded-full bg-panel-raised">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: pct + '%' }} />
      </div>}
      <div className="flex flex-wrap items-center gap-1.5 pb-px text-xs leading-snug tabular-nums">
        <span className={cx('shrink-0 font-semibold', downloadTextTone(entry.phase))}>{statusText}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-dim">
          {speed && <span>{speed}</span>}
          {eta && (<><span aria-hidden="true">·</span><span>{eta}</span></>)}
        </span>
      </div>
      {hint && <p className={cx('m-0 text-xs leading-snug', entry.phase === 'error' || entry.phase === 'missing' || entry.unbound ? 'text-bad' : 'text-warn')} role={entry.phase === 'error' || entry.unbound ? 'alert' : undefined}>{hint}</p>}
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
