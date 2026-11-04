import type { QualityStatus } from '../release-status'
import { cx } from '../styles'
import Icon, { type IconName } from './Icons'

export const QUALITY_ICONS: Record<QualityStatus['kind'], IconName> = {
  best: 'check', upgrade: 'arrow-up', review: 'alert', partial: 'info', missing: 'minus', incomplete: 'alert',
}

export default function DetailsQuality({ status }: { status: QualityStatus }) {
  return <span className={cx('details-quality', status.kind === 'best' ? 'text-good' : status.kind === 'missing' ? 'text-muted' : 'text-warn')} data-quality={status.kind}>
    <Icon name={QUALITY_ICONS[status.kind]} size={15}/><span>{status.label}</span>
  </span>
}
