import { formatBytes } from '../utils'

export default function LibrarySizeChange({ delta, title, note }: { delta: number; title?: string; note?: string }) {
  const value = `${delta > 0 ? '+' : ''}${formatBytes(delta) || '0 B'}`
  return (
    <span className="relative text-xs text-muted">
      <span className="sr-only">{title ? `${title}: ` : ''}Estimated library size change: </span>
      <strong className="tabular-nums">{value}</strong>
      {note && <span className="ml-1 text-muted-dim max-[600px]:hidden">{note}</span>}
    </span>
  )
}
