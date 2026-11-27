import { formatBytes, formatEta } from '../utils'
import Icon from './Icons'
import { cx, downloadTextTone } from '../styles'
import type { DownloadPhase } from '../api'
import { clientName, phaseLabel, type DownloadEntry } from '../download-entry'

/** What happened to a finished download in Sonarr or Radarr, in words and a tone; null while it is still downloading. */
export function importStatus(
  entry: Pick<DownloadEntry, 'import'>,
): { text: string; detail?: string; tone: string; alert: boolean } | null {
  const state = entry.import
  if (!state || state.state === 'waiting') return null
  if (state.state === 'pending') return { text: `Waiting for ${state.app} to import`, tone: 'text-muted', alert: false }
  if (state.state === 'imported') return { text: `Imported by ${state.app}`, tone: 'text-good', alert: false }
  if (state.state === 'blocked')
    return {
      text: `${state.app} has not imported this download`,
      detail: state.message,
      tone: 'text-warn',
      alert: true,
    }
  if (state.state === 'mismatch')
    return { text: 'Not the release SeaDex lists', detail: state.message, tone: 'text-bad', alert: true }
  return { text: `Not imported by ${state.app}`, detail: state.message, tone: 'text-bad', alert: true }
}

/** One line under a finished download saying whether it reached the library, with the app's own reason when it did not. */
export function ImportStatusLine({ entry }: { entry: Pick<DownloadEntry, 'import'> }) {
  const status = importStatus(entry)
  if (!status) return null
  return (
    <p
      className={cx('m-0 flex items-start gap-1.5 text-xs leading-snug wrap-anywhere', status.tone)}
      role={status.alert ? 'alert' : undefined}
    >
      <Icon
        name={entry.import?.state === 'imported' ? 'check' : status.alert ? 'alert' : 'clock'}
        size={13}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0">
        <span className="font-semibold">{status.text}</span>
        {status.detail && <span className="mt-0.5 block text-ink">{status.detail}</span>}
      </span>
    </p>
  )
}

/** Copy that names the recovery, never a URL or credential. */
const PHASE_HINT: Partial<Record<DownloadPhase, string>> = {
  missing: 'This download is no longer in the client. Remove the entry and send it again if you still want it.',
  unavailable: 'The download client is currently unreachable. Progress resumes when it answers.',
  error: 'The client reported an error. Open the client for details, then remove and retry.',
}

/** Progress is meaningful only while bytes move or the client verifies them. */
const showsProgress = (phase: DownloadPhase) =>
  phase === 'downloading' ||
  phase === 'queued' ||
  phase === 'paused' ||
  phase === 'verifying' ||
  phase === 'repairing' ||
  phase === 'unpacking' ||
  phase === 'post_processing' ||
  phase === 'acceptance_unknown'

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
  /** Names the download when several rows share a season and release group. */
  name?: string
}

const ACTION_BUTTON =
  'touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-accent/50 hover:text-accent-bright disabled:cursor-not-allowed disabled:opacity-50'
const REMOVE_BUTTON =
  'touch-target grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-panel-raised text-ink transition-colors hover:border-bad/50 hover:text-bad disabled:cursor-not-allowed disabled:opacity-50'

export function DownloadActions({ entry, busy, onPause, onResume, onRemove, name }: DownloadActionsProps) {
  const busyRow = busy || entry.unbound
  const label = `${entry.season} · ${entry.releaseGroup}${name ? ` · ${name}` : ''}`
  return (
    <>
      {entry.capabilities.pause && (
        <button
          type="button"
          className={ACTION_BUTTON}
          title={`Pause in ${clientName(entry.client)}`}
          aria-label={`Pause download · ${label}`}
          disabled={busyRow}
          onClick={onPause}
        >
          <Icon name="pause" size={14} />
        </button>
      )}
      {entry.capabilities.resume && (
        <button
          type="button"
          className={ACTION_BUTTON}
          title={`Resume in ${clientName(entry.client)}`}
          aria-label={`Resume download · ${label}`}
          disabled={busyRow}
          onClick={onResume}
        >
          <Icon name="play" size={14} />
        </button>
      )}
      {entry.capabilities.remove && (
        <button
          type="button"
          className={REMOVE_BUTTON}
          title={
            entry.phase === 'acceptance_unknown'
              ? 'Stop tracking this unconfirmed download'
              : `Remove from ${clientName(entry.client)}`
          }
          aria-label={`${entry.phase === 'acceptance_unknown' ? 'Stop tracking' : 'Remove download'} · ${label}`}
          disabled={busyRow}
          onClick={onRemove}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
    </>
  )
}

function EntryRow({
  entry,
  busy,
  onPause,
  onResume,
  onRemove,
}: {
  entry: DownloadEntry
  busy: boolean
  onPause: () => void
  onResume: () => void
  onRemove: () => void
}) {
  const pct = Math.max(0, Math.min(100, Math.round(entry.progress * 1000) / 10))
  const remaining = Math.max(0, entry.total_size - entry.downloaded)
  const eta = entry.phase === 'downloading' ? formatEta(remaining, entry.speed) : ''
  const speed = entry.phase === 'downloading' && entry.speed > 0 ? formatBytes(entry.speed) + '/s' : ''
  const hint =
    entry.phase === 'acceptance_unknown'
      ? `${clientName(entry.client)} was asked to start this download but did not confirm it. It is picked up automatically if it appears in ${clientName(entry.client)}. If it is not there, stop tracking it to send it again.`
      : entry.error ||
        (entry.unbound
          ? 'This download belongs to a different client URL. Reconfigure that client or remove the entry.'
          : PHASE_HINT[entry.phase])
  const statusText = `${clientName(entry.client)} · ${phaseLabel(entry.phase)}${showsProgress(entry.phase) ? ` · ${pct.toFixed(1)}%` : ''}`
  return (
    <li className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="min-w-0 basis-20 flex-1 truncate text-xs font-semibold text-ink"
          title={entry.title || entry.releaseGroup}
        >
          {entry.releaseGroup}
        </span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-xs font-extrabold text-ink">
          {entry.season}
        </span>
        <span className="shrink-0 rounded-md border border-line bg-panel-raised px-1.5 py-0.5 text-xs font-bold text-muted-dim">
          {clientName(entry.client)}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <DownloadActions entry={entry} busy={busy} onPause={onPause} onResume={onResume} onRemove={onRemove} />
        </span>
      </div>
      {showsProgress(entry.phase) && (
        <div
          role="progressbar"
          aria-label={`Download progress · ${entry.season} · ${entry.releaseGroup}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={entry.phase === 'acceptance_unknown' ? undefined : pct}
          aria-valuetext={statusText}
          className="h-1.5 overflow-hidden rounded-full bg-panel-raised"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: pct + '%' }} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pb-px text-xs leading-snug tabular-nums">
        <span className={cx('shrink-0 font-semibold', downloadTextTone(entry.phase))}>{statusText}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-dim">
          {speed && <span>{speed}</span>}
          {eta && (
            <>
              <span aria-hidden="true">·</span>
              <span>{eta}</span>
            </>
          )}
        </span>
      </div>
      {hint && (
        <p
          className={cx(
            'm-0 text-xs leading-snug',
            entry.phase === 'error' || entry.phase === 'missing' || entry.unbound ? 'text-bad' : 'text-warn',
          )}
          role={entry.phase === 'error' || entry.unbound ? 'alert' : undefined}
        >
          {hint}
        </p>
      )}
      <ImportStatusLine entry={entry} />
    </li>
  )
}

export default function DownloadsPanel({ downloads, busyId, onPause, onResume, onRemove }: Props) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/6 px-2.5 py-2">
      <ul
        className="download-scrollbar m-0 flex max-h-56 list-none flex-col gap-3 overflow-y-auto p-0"
        aria-label="Active downloads"
      >
        {downloads.map(entry => (
          <EntryRow
            key={entry.record_id}
            entry={entry}
            busy={busyId !== null}
            onPause={() => onPause(entry)}
            onResume={() => onResume(entry)}
            onRemove={() => onRemove(entry)}
          />
        ))}
      </ul>
    </div>
  )
}
