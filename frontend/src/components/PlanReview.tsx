import { formatBytes } from '../utils'
import Icon from './Icons'
import type { DiskSpaceCheck, DownloadPreflight } from '../api'
import { clientName } from '../download-entry'

function DiskStatus({ check }: { check: DiskSpaceCheck }) {
  const free = check.free_bytes === null ? null : formatBytes(check.free_bytes) || '0 B'
  if (check.sufficient === true)
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-good">
        <Icon name="check" size={13} />
        {free} free
      </span>
    )
  if (check.sufficient === false)
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-bad">
        <Icon name="alert" size={13} />
        only {free} free
      </span>
    )
  if (free === null) return <span className="font-semibold text-warn">free space unknown</span>
  // Free space is known but the payload is an estimate, so a fit cannot be confirmed.
  return (
    <span className="font-semibold text-warn" title="The download size is an estimate, so a fit cannot be confirmed">
      {free} free · not confirmed
    </span>
  )
}

export function DiskLine({
  check,
  showNeeds = true,
  showReason = true,
}: {
  check: DiskSpaceCheck
  showNeeds?: boolean
  showReason?: boolean
}) {
  return (
    <li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="min-w-0 font-semibold text-ink wrap-anywhere" title={check.path || undefined}>
          {check.label || clientName(check.client)}
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
          {showNeeds && <span className="text-muted">needs {formatBytes(check.required_bytes) || '0 B'}</span>}
          <DiskStatus check={check} />
        </span>
      </span>
      {showReason && check.reason && <span className="text-xs text-muted-dim">{check.reason}</span>}
    </li>
  )
}

/** Explains, in the situation's own terms, what continuing without confirmed space risks. */
export function spaceAckDetail(preflight: DownloadPreflight | null | undefined): string {
  const checks = preflight?.disk_space || []
  if (checks.some(check => check.sufficient === false))
    return 'At least one folder has less free space than this needs. Downloads stall until space is freed.'
  const silent = [...new Set(checks.filter(check => check.free_bytes === null).map(check => clientName(check.client)))]
  if (silent.length)
    return `${silent.join(' and ')} did not report free space, so the fit cannot be checked. Downloads stall if the disk fills up.`
  return 'The download size is an estimate, so the fit cannot be guaranteed. Downloads stall if the disk fills up.'
}
