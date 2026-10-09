import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icons'
import { cx } from '../styles'

type ToastTone = 'success' | 'error' | 'info'
interface ToastAction { label: string; onClick: () => void }
interface ToastItem { id: number; message: string; tone: ToastTone; action?: ToastAction }
interface ToastApi { show: (message: string, tone?: ToastTone, durationMs?: number, action?: ToastAction) => void }

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const [host, setHost] = useState<Element>(document.body)
  useEffect(() => {
    const updateHost = () => setHost(Array.from(document.querySelectorAll('dialog.modal-shell[open]')).slice(-1)[0] || document.body)
    window.addEventListener('seadex:modal-change', updateHost)
    updateHost()
    return () => window.removeEventListener('seadex:modal-change', updateHost)
  }, [])
  const show = useCallback((message: string, tone: ToastTone = 'info', durationMs?: number, action?: ToastAction) => {
    const id = Date.now() + Math.random()
    setItems((current) => [...current, { id, message, tone, action }])
    // Keep error details available until dismissed unless a duration was requested.
    if (tone !== 'error' || durationMs !== undefined) {
      window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), durationMs ?? 4200)
    }
  }, [])
  const value = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(<div className="pointer-events-none fixed top-4 right-4 z-[100] app-scrollbar flex max-h-[calc(100dvh-12rem)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-y-auto gap-2 max-[900px]:top-auto max-[900px]:bottom-24" aria-live="polite" aria-atomic="true">
        {items.map((item) => (
          <div key={item.id} role={item.tone === 'error' ? 'alert' : 'status'} className={cx(
            'pointer-events-auto flex animate-rise items-start gap-3 rounded-xl border bg-panel-raised/95 px-4 py-3 text-sm text-ink shadow-card backdrop-blur-xl',
            item.tone === 'success' && 'border-good/35',
            item.tone === 'error' && 'border-bad/35',
            item.tone === 'info' && 'border-accent/35',
          )}>
            <Icon name={item.tone === 'success' ? 'check' : item.tone === 'error' ? 'alert' : 'sparkles'} size={18} className={cx('mt-0.5 shrink-0', item.tone === 'success' ? 'text-good' : item.tone === 'error' ? 'text-bad' : 'text-accent-bright')} />
            <div className="min-w-0 flex-1"><span className="block whitespace-pre-wrap wrap-anywhere">{item.message}</span>{item.action && <button type="button" className="touch-target mt-1 cursor-pointer rounded-md px-1 text-sm font-semibold text-accent-bright hover:underline" onClick={() => { setItems(current => current.filter(toast => toast.id !== item.id)); item.action?.onClick() }}>{item.action.label}</button>}</div>
            <button type="button" className="touch-target pointer-events-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={() => setItems((current) => current.filter((currentItem) => currentItem.id !== item.id))} aria-label="Dismiss notification"><Icon name="close" size={16} /></button>
          </div>
        ))}
      </div>, host)}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}
