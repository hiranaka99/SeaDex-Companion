import type { DownloadPreflight } from '../api'
import { cx } from '../styles'
import { formatBytes } from '../utils'
import Icon from './Icons'
import { DiskLine, spaceAckDetail } from './PlanReview'

interface Props {
  selectionCount: number
  /** The server's review of the current selection; null while it is being checked or after it failed. */
  preflight: DownloadPreflight | null
  error: string | null
  checking: boolean
  /** The batch already ran: the totals stay, the storage check no longer applies. */
  finished: boolean
  wholeSource: boolean
  diskSpace: boolean
  onWholeSource: (acknowledged: boolean) => void
  onDiskSpace: (acknowledged: boolean) => void
}

type Verdict = 'checking' | 'low' | 'unverified' | 'ok' | 'idle'

const VERDICT_BOX: Record<Verdict, string> = {
  checking: 'border-accent/35 bg-accent/6',
  low: 'border-bad/45 bg-bad/6',
  unverified: 'border-warn/40 bg-warn/6',
  ok: 'border-good/35 bg-good/6',
  idle: 'border-line bg-canvas-soft',
}
const VERDICT_TEXT: Record<Verdict, string> = {
  checking: 'text-accent-bright',
  low: 'text-bad',
  unverified: 'text-warn',
  ok: 'text-good',
  idle: 'text-muted',
}
const VERDICT_LABEL: Record<Verdict, string> = {
  checking: 'Checking…',
  low: 'Low space',
  unverified: 'Needs acknowledgement',
  ok: 'Space available',
  idle: 'Nothing new to send',
}

/** What a batch will send and whether it fits, with the acknowledgements the server asks for. */
export default function BulkPlanSummary({
  selectionCount,
  preflight: currentPreflight,
  error: checkError,
  checking,
  finished,
  wholeSource,
  diskSpace,
  onWholeSource: setWholeSource,
  onDiskSpace: setDiskSpace,
}: Props) {
  const newUnits = (currentPreflight?.new_torrents || 0) + (currentPreflight?.new_nzbs || 0)
  const lowSpace = currentPreflight?.disk_space.some(check => check.sufficient === false)
  const unverifiedSpace = Boolean(checkError || currentPreflight?.requires_space_ack)
  const verdict: Verdict = checking
    ? 'checking'
    : lowSpace
      ? 'low'
      : unverifiedSpace
        ? 'unverified'
        : newUnits > 0
          ? 'ok'
          : 'idle'
  const needsWhole = currentPreflight?.requires_whole_ack === true
  const needsSpace = currentPreflight?.requires_space_ack === true
  const sizeText = currentPreflight
    ? `${currentPreflight.approximate_bytes ? '≈ ' : ''}${formatBytes(currentPreflight.total_new_bytes) || '0 B'}${currentPreflight.unknown_bytes ? ' + unknown' : ''}`
    : ''
  return (
    <>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-3 sm:grid-cols-5">
        <div>
          <dt className="text-xs text-muted">Selected releases</dt>
          <dd className="m-0 text-sm font-bold text-accent-bright tabular-nums">{selectionCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">New torrents</dt>
          <dd className="m-0 text-sm font-bold tabular-nums">{currentPreflight?.new_torrents ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">New NZBs</dt>
          <dd className="m-0 text-sm font-bold tabular-nums">{currentPreflight?.new_nzbs ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">New download size</dt>
          <dd
            className={cx(
              'm-0 text-sm font-bold tabular-nums',
              currentPreflight?.unknown_bytes ? 'text-warn' : 'text-accent-bright',
            )}
            data-testid="bulk-download-size"
          >
            {checking ? 'Checking…' : currentPreflight ? sizeText : '—'}
          </dd>
        </div>
        <div className="col-span-2 flex items-baseline gap-2 sm:col-span-1 sm:block">
          <dt className="text-xs text-muted">Already queued</dt>
          <dd className={cx('m-0 text-sm font-bold tabular-nums', checkError ? 'text-warn' : 'text-ink')}>
            {checking || checkError ? 'Unknown' : currentPreflight?.existing_units}
          </dd>
        </div>
      </dl>
      {!finished && (
        <section
          className={cx('space-y-2 rounded-xl border p-3 text-xs transition-colors', VERDICT_BOX[verdict])}
          aria-label="Download storage and scope"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-xs font-bold">Storage &amp; source scope</h3>
            <span className={cx('inline-flex items-center gap-1.5 font-semibold', VERDICT_TEXT[verdict])}>
              {checking ? (
                <span className="size-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              ) : (
                <Icon name={lowSpace || unverifiedSpace ? 'alert' : 'check'} size={13} />
              )}
              {VERDICT_LABEL[verdict]}
            </span>
          </div>
          {checking && (
            <p className="m-0 text-ink/80">Checking download clients, existing acquisitions, and Usenet sources…</p>
          )}
          {checkError && (
            <p className="m-0 text-warn">
              Check unavailable: {checkError}. Run the review again before starting the batch.
            </p>
          )}
          {currentPreflight?.disk_space.length ? (
            <ul className="m-0 list-none divide-y divide-line">
              {currentPreflight.disk_space.map((check, index) => (
                <DiskLine key={`${check.client}-${index}`} check={check} />
              ))}
            </ul>
          ) : (
            <p className="m-0 text-muted">No disk-space data available from the configured clients.</p>
          )}
          {currentPreflight && !newUnits && (
            <p className="m-0 text-muted">Nothing new to send. Existing acquisitions are kept unchanged.</p>
          )}
          {currentPreflight?.approximate_bytes && (
            <p className="m-0 text-muted">Usenet sizes are provider estimates; repair and unpacking need extra room.</p>
          )}
          {needsWhole && (
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/8 p-3 text-warn">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-warn"
                checked={wholeSource}
                onChange={event => setWholeSource(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block font-bold">Download whole Usenet sources</span>
                <span className="mt-0.5 block text-[0.6875rem] text-muted">
                  Usenet sources cannot be split per episode. Files beyond the selected episodes will also be
                  downloaded.
                </span>
              </span>
            </label>
          )}
          {needsSpace && (
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/8 p-3 text-warn">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-warn"
                checked={diskSpace}
                onChange={event => setDiskSpace(event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block font-bold">Continue without confirmed free space</span>
                <span className="mt-0.5 block text-[0.6875rem] text-muted">{spaceAckDetail(currentPreflight)}</span>
              </span>
            </label>
          )}
        </section>
      )}
    </>
  )
}
