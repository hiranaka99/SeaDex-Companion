import type { Release } from '../types'
import type { DownloadProtocol } from '../api'
import * as api from '../api'
import { cx } from '../styles'
import { displayDateTime } from '../datetime'
import Icon from './Icons'

export function ReleaseSummary({ release }: { release: Release }) {
  const tags = [...new Set(release.tags || [])].filter(
    tag => tag && tag !== release.quality && (!release.dual_audio || tag !== 'Dual Audio'),
  )
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1.5 text-xs wrap-anywhere">
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-muted">Group</span>
        <strong className="font-semibold text-ink">{release.releaseGroup}</strong>
      </span>
      {release.quality && (
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-muted">Quality</span>
          <span className="text-ink/85">{release.quality}</span>
        </span>
      )}
      {release.dual_audio && (
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-muted">Audio</span>
          <span className="text-ink/85">Dual Audio</span>
        </span>
      )}
      {tags.length > 0 && (
        <span className="inline-flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-muted">Tags</span>
          <span className="text-ink/85">{tags.join(', ')}</span>
        </span>
      )}
    </span>
  )
}

export function OutcomeLabel({
  status,
  protocols,
}: {
  status: 'success' | 'failure' | 'pending' | 'existing' | 'partial' | null
  protocols: DownloadProtocol[]
}) {
  if (!status) return null
  const clients =
    [...new Set(protocols.map(protocol => (protocol === 'usenet' ? 'SABnzbd' : 'qBittorrent')))].join(' and ') ||
    'the download client'
  const copy =
    status === 'success'
      ? `Sent to ${clients}`
      : status === 'existing'
        ? 'Already queued in the client'
        : status === 'partial'
          ? `Partly sent — see Operation Center`
          : status === 'failure'
            ? 'Could not be added — review the operation error details'
            : `Waiting for ${clients}`
  const tone =
    status === 'success'
      ? 'text-good'
      : status === 'existing'
        ? 'text-muted'
        : status === 'failure'
          ? 'text-bad'
          : status === 'partial'
            ? 'text-warn'
            : 'text-accent-bright'
  return <span className={cx('basis-full text-xs font-semibold', tone)}>{copy}</span>
}

export function UsenetStatus({ row, loading }: { row: api.UsenetAvailabilityResult | undefined; loading: boolean }) {
  if (!row)
    return (
      <span className="basis-full text-xs text-muted">
        {loading ? 'Checking Usenet sources…' : 'Usenet: not checked'}
      </span>
    )
  const labels = {
    available: 'Usenet source found',
    no_match: 'No Usenet match',
    processing: 'Usenet source processing',
    incomplete: 'Usenet source uncertain',
    unsupported_hash: 'Usenet unavailable',
    not_configured: 'Usenet not set up',
    lookup_failed: 'Usenet lookup failed',
    not_checked: row.refreshing ? 'Checking Usenet sources…' : 'Usenet: not checked',
  }
  const tone =
    row.aggregate === 'available' ? 'text-good' : row.aggregate === 'lookup_failed' ? 'text-warn' : 'text-ink/85'
  return (
    <span className="basis-full block min-w-0 border-t border-line/70 pt-2.5 text-xs wrap-anywhere">
      <span className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted">Availability</span>
          <span className={cx('font-semibold', tone)}>{labels[row.aggregate]}</span>
        </span>
        {row.checked_at && (
          <>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-muted">Cache</span>
              <span className="text-ink/85">{row.stale ? 'Last-known cached result' : 'Cached result'}</span>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-muted">Last checked</span>
              <time className="tabular-nums text-ink/85" dateTime={row.checked_at}>
                {displayDateTime(row.checked_at)}
              </time>
            </span>
          </>
        )}
        {row.aggregate !== 'not_checked' && (row.refreshing || loading) && (
          <span className="inline-flex items-center gap-1.5 self-end text-muted">
            <Icon name="refresh" size={12} />
            Refreshing…
          </span>
        )}
      </span>
      {row.refresh_error && (
        <span className="mt-2.5 flex items-start gap-2 text-warn">
          <span className="mt-0.5 shrink-0">
            <Icon name="alert" size={14} />
          </span>
          <span className="min-w-0">
            <strong className="block font-semibold">Refresh failed</strong>
            <span className="mt-0.5 block max-w-prose leading-relaxed">{row.refresh_error}</span>
          </span>
        </span>
      )}
    </span>
  )
}
