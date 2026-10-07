import { ReactNode, useEffect, useId, useRef, useState } from 'react'
import Icon from './Icons'
import { buttonBase, cx } from '../styles'
import Modal from './Modal'

interface Props {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  dangerous?: boolean
  children?: ReactNode
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

export default function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', dangerous = false, children, onConfirm, onClose }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const id = useId()
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    setError('')
    if (!open) return
    cancelRef.current?.focus()
    return () => { generation.current += 1 }
  }, [open])
  useEffect(() => { if (!open) setSubmitting(false) }, [open])
  const confirm = async () => {
    const current = generation.current
    setError('')
    setSubmitting(true)
    try {
      await onConfirm()
      if (current === generation.current) onClose()
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : 'Could not complete this action. Please retry.')
    } finally {
      if (current === generation.current) setSubmitting(false)
    }
  }
  if (!open) return null
  return (
    <Modal open={open} labelledBy={`${id}-title`} describedBy={`${id}-description`} busy={submitting} onClose={onClose}>
      <section className="w-full max-w-md animate-rise rounded-card border border-line-strong bg-panel-raised p-5 shadow-card" aria-busy={submitting}>
        <div className="mb-4 flex items-start gap-3">
          <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', dangerous ? 'bg-bad/12 text-bad' : 'bg-accent/12 text-accent-bright')}><Icon name={dangerous ? 'alert' : 'sparkles'} /></span>
          <div><h2 id={`${id}-title`} className="m-0 text-lg font-bold">{title}</h2><p id={`${id}-description`} className="mt-1 mb-0 text-sm text-muted">{description}</p></div>
        </div>
        {children}
        {error && <p role="alert" className="mb-4 text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={`${buttonBase} border-line bg-panel text-ink hover:text-ink`} onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className={cx(buttonBase, dangerous ? 'border-bad/35 bg-bad/12 text-bad hover:bg-bad/20' : 'border-accent/35 bg-accent text-on-accent')} onClick={() => void confirm()} disabled={submitting}>{submitting && <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/>}{submitting ? 'Working…' : confirmLabel}</button>
        </div>
      </section>
    </Modal>
  )
}
