import { useEffect, useRef } from 'react'
import Icon from './Icons'
import { buttonBase, cx } from '../styles'

interface Props {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  dangerous?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', dangerous = false, onConfirm, onClose }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/65 px-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="w-full max-w-md animate-rise rounded-card border border-line-strong bg-panel-raised p-5 shadow-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <div className="mb-4 flex items-start gap-3">
          <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', dangerous ? 'bg-bad/12 text-bad' : 'bg-accent/12 text-accent-bright')}><Icon name={dangerous ? 'alert' : 'sparkles'} /></span>
          <div><h2 id="confirm-title" className="m-0 text-lg font-bold">{title}</h2><p id="confirm-description" className="mt-1 mb-0 text-sm text-muted">{description}</p></div>
        </div>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={`${buttonBase} border-line bg-panel text-muted hover:text-ink`} onClick={onClose}>Cancel</button>
          <button type="button" className={cx(buttonBase, dangerous ? 'border-bad/35 bg-bad/12 text-bad hover:bg-bad/20' : 'border-accent/35 bg-accent text-white')} onClick={() => { onConfirm(); onClose() }}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}

