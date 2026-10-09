import { control, cx } from '../styles'

export type BulkScope = 'filtered' | 'all'

export default function BulkScopeSelector({ value, onChange, filteredCount, allCount, description, allDescription, allLabel, disabled = false }: {
  value: BulkScope
  onChange: (value: BulkScope) => void
  filteredCount: number
  allCount: number
  description: string
  allDescription?: string
  allLabel?: string
  disabled?: boolean
}) {
  return <div className="space-y-1.5 border-b border-line pb-4">
    <label className="flex flex-wrap items-center gap-2 text-sm font-semibold">
      Review scope
      <select aria-label="Bulk action scope" className={cx(control, 'min-w-0 max-w-full flex-1 max-[600px]:basis-full')} value={value} disabled={disabled} onChange={event => onChange(event.target.value as BulkScope)}>
        <option value="filtered">Current results ({filteredCount} {filteredCount === 1 ? 'title' : 'titles'})</option>
        <option value="all">{allLabel || `Entire library (${allCount} ${allCount === 1 ? 'title' : 'titles'})`}</option>
      </select>
    </label>
    <p className="m-0 text-xs text-muted">{value === 'filtered' ? `${description}. Includes every matching page.` : allDescription || 'All library titles, regardless of your search, source, or status filters. Hidden titles start unchecked.'}</p>
  </div>
}
