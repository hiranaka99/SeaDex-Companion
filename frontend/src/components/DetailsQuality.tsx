import type { QualityStatus } from '../release-status'
import { cx } from '../styles'
import Icon, { type IconName } from './Icons'

export const QUALITY_ICONS: Record<QualityStatus['kind'], IconName> = {
  best: 'check',
  upgrade: 'arrow-up',
  review: 'alert',
  partial: 'info',
  missing: 'minus',
  incomplete: 'alert',
}

/** The same tones as the library card: green owned, blue upgrade, amber attention, muted absence. */
export const QUALITY_TONES: Record<QualityStatus['kind'], string> = {
  best: 'text-good',
  upgrade: 'text-accent-bright',
  review: 'text-warn',
  partial: 'text-warn',
  missing: 'text-muted',
  incomplete: 'text-warn',
}

export default function DetailsQuality({ status }: { status: QualityStatus }) {
  return (
    <span className={cx('details-quality', QUALITY_TONES[status.kind])} data-quality={status.kind}>
      <Icon name={QUALITY_ICONS[status.kind]} size={15} />
      <span>{status.label}</span>
    </span>
  )
}
