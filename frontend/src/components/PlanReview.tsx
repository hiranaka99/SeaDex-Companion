import { formatBytes } from '../utils'
import { cx } from '../styles'
import Icon from './Icons'
import type { DiskSpaceCheck, DownloadPreflight, PlannedUnit } from '../api'
import { clientName } from './DownloadsPanel'

function unitSize(unit: PlannedUnit): string {
  if (unit.size_bytes === null) return 'size unknown'
  return `${unit.approximate ? '≈' : ''}${formatBytes(unit.size_bytes) || '0 B'}`
}

export function UnitLine({ unit }: { unit: PlannedUnit }) {
  const name = unit.nzb_name || unit.labels[0] || unit.source_hash.slice(0, 12)
  const extras = unit.extra_file_count
    ? ` · includes ${unit.extra_file_count} extra file${unit.extra_file_count === 1 ? '' : 's'}${unit.known_extra_files?.length ? ` (${unit.known_extra_files.slice(0, 3).join(', ')}${unit.known_extra_files.length > 3 ? '…' : ''})` : ''}`
    : unit.scope_unknown ? ' · exact scope unknown' : ''
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 first:pt-0 last:pb-0">
      <span className={cx('shrink-0 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-bold', unit.protocol === 'usenet' ? 'border-sky/40 bg-sky/10 text-sky' : 'border-accent/40 bg-accent/10 text-accent-bright')}>{unit.protocol === 'usenet' ? 'Usenet' : 'Torrent'}</span>
      <span className="min-w-0 basis-40 flex-1 truncate text-xs font-semibold text-ink" title={name}>{name}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{unitSize(unit)}</span>
      <span className="shrink-0 text-xs text-muted-dim">{clientName(unit.client)} · {unit.category}</span>
      {unit.status === 'existing' && <span className="shrink-0 rounded-md border border-good/35 bg-good/10 px-1.5 py-0.5 text-[0.6875rem] font-bold text-good">already queued</span>}
      {(unit.whole_source || extras) && <span className="basis-full text-xs text-warn">{unit.whole_source ? 'Whole Usenet source — files beyond the requested episodes will be downloaded' : ''}{extras}</span>}
    </li>
  )
}

export function DiskLine({ check }: { check: DiskSpaceCheck }) {
  const sufficient = check.sufficient
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 first:pt-0 last:pb-0">
      <span className="min-w-0 basis-40 flex-1 truncate text-xs font-semibold text-ink" title={check.path || undefined}>{check.label || clientName(check.client)}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted">needs {formatBytes(check.required_bytes) || '0 B'}</span>
      {sufficient === true && <span className="shrink-0 text-xs font-semibold text-good">· {formatBytes(check.free_bytes || 0)} free</span>}
      {sufficient === false && <span className="shrink-0 text-xs font-semibold text-bad">· only {formatBytes(check.free_bytes || 0)} free</span>}
      {sufficient === null && <span className="shrink-0 text-xs font-semibold text-warn">· free space unknown</span>}
      {(check.unknown_units > 0 || check.reason) && <span className="basis-full text-xs text-muted-dim">{[check.unknown_units ? `${check.unknown_units} unit${check.unknown_units === 1 ? '' : 's'} with unknown size` : '', check.reason || ''].filter(Boolean).join(' · ')}</span>}
    </li>
  )
}

/** Compact preflight summary shared by the single-release and bulk reviews. */
export default function PlanReview({ preflight }: { preflight: DownloadPreflight }) {
  const newUnits = preflight.units.filter(unit => unit.status === 'new')
  const parts = [
    preflight.new_torrents ? `${preflight.new_torrents} torrent${preflight.new_torrents === 1 ? '' : 's'}` : '',
    preflight.new_nzbs ? `${preflight.new_nzbs} NZB${preflight.new_nzbs === 1 ? '' : 's'}` : '',
    preflight.existing_units ? `${preflight.existing_units} already queued` : '',
  ].filter(Boolean)
  const total = preflight.total_new_bytes
    ? `${preflight.approximate_bytes ? '≈' : ''}${formatBytes(preflight.total_new_bytes) || '0 B'}${preflight.unknown_bytes ? ' + unknown size' : ''}`
    : preflight.unknown_bytes ? 'size unknown' : '0 B'
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-muted"><span className="font-bold text-ink tabular-nums">{parts.join(' · ') || 'Nothing new to send'}</span> · {total} new</p>
      {newUnits.length > 0 && <div>
        <h3 className="m-0 mb-1 text-xs font-bold text-muted">To send</h3>
        <ul className="m-0 list-none divide-y divide-line rounded-lg border border-line bg-canvas-soft px-3 py-1">{newUnits.map(unit => <UnitLine key={unit.unit_id} unit={unit}/>)}</ul>
      </div>}
      {preflight.disk_space.length > 0 && <div>
        <h3 className="m-0 mb-1 text-xs font-bold text-muted">Storage</h3>
        <ul className="m-0 list-none divide-y divide-line rounded-lg border border-line bg-canvas-soft px-3 py-1">{preflight.disk_space.map((check, index) => <DiskLine key={`${check.client}-${index}`} check={check}/>)}</ul>
      </div>}
      {preflight.approximate_bytes && <p className="m-0 flex items-start gap-1.5 text-xs text-muted-dim"><Icon name="info" size={13} className="mt-0.5 shrink-0"/>Usenet source sizes are provider estimates and may exclude post-processing overhead.</p>}
    </div>
  )
}
