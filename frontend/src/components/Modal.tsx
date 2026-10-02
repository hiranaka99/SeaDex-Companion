import { ReactNode, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../styles'

interface Props {
  open: boolean
  labelledBy: string
  describedBy?: string
  busy?: boolean
  onClose: () => void
  className?: string
  children: ReactNode
}

/** Native dialogs keep the background inert and support nested modal focus. */
export default function Modal({ open, labelledBy, describedBy, busy = false, onClose, className, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    window.dispatchEvent(new Event('seadex:modal-change'))
    return () => {
      dialog.close()
      window.dispatchEvent(new Event('seadex:modal-change'))
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <dialog ref={ref} className={cx('modal-shell fixed inset-0 m-0 grid h-dvh w-screen max-h-none max-w-none place-items-center border-0 bg-black/65 px-4 py-6 text-ink backdrop-blur-sm', className)}
      aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy}
      onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
      {children}
    </dialog>, document.body,
  )
}
