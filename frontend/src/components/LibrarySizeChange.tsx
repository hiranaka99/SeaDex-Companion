import { formatBytes } from '../utils'

export default function LibrarySizeChange({ delta, title }: { delta: number; title?: string }) {
  const value = `${delta > 0 ? '+' : ''}${formatBytes(delta) || '0 B'}`
  return <span className="text-xs text-muted">
    <span className="sr-only">{title ? `${title}: ` : ''}Estimated library size change: </span>
    <strong className="tabular-nums">{value}</strong>
  </span>
}
