import type { ChangePresentation } from '../release-changes'
import Icon from './Icons'

export default function ReleaseChangeLine({ detail, context }: { detail: ChangePresentation; context?: string }) {
  const scope = [context, detail.part].filter(Boolean).join(' · ')
  const scopeLabel = scope && <span className="text-xs text-muted">{scope}</span>
  const label = <strong className="font-bold text-ink">{detail.summary}</strong>
  if (detail.note) return <details className="group min-w-0">
    <summary className="touch-target flex w-fit cursor-pointer list-none flex-wrap items-center gap-x-2 text-[13px] wrap-anywhere hover:underline [&::-webkit-details-marker]:hidden">
      {scopeLabel}
      <span className="flex min-w-0 items-center gap-1">
        {label}<Icon name="chevron-right" size={14} className="shrink-0 text-muted group-open:rotate-90" />
      </span>
    </summary>
    <dl className="mt-1 mb-1 space-y-2 rounded-lg border border-line bg-canvas-soft px-3 py-2">
      <div><dt className="text-xs font-bold text-muted">Previous note</dt><dd className="m-0 whitespace-pre-wrap text-[13px] wrap-anywhere">{detail.note.previous ?? 'No note'}</dd></div>
      <div><dt className="text-xs font-bold text-muted">New note</dt><dd className="m-0 whitespace-pre-wrap text-[13px] wrap-anywhere">{detail.note.next ?? 'No note'}</dd></div>
    </dl>
  </details>
  return <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] wrap-anywhere">
    {scopeLabel}{label}
    {detail.release && <span className="min-w-0 text-xs text-muted"><span aria-hidden="true">· </span>{detail.release}</span>}
  </p>
}
