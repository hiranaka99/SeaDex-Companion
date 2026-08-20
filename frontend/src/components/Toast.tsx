import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import Icon from './Icons'
import { cx } from '../styles'

type ToastTone = 'success' | 'error' | 'info'
interface ToastItem { id: number; message: string; tone: ToastTone }
interface ToastApi { show: (message: string, tone?: ToastTone, durationMs?: number) => void }

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const show = useCallback((message: string, tone: ToastTone = 'info', durationMs?: number) => {
    const id = Date.now() + Math.random()
    setItems((current) => [...current, { id, message, tone }])
    // Errors need to stay on screen long enough to be read in full.
    const duration = durationMs ?? (tone === 'error' ? 10_000 : 4200)
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), duration)
  }, [])
  const value = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" aria-atomic="true">
        {items.map((item) => (
          <div key={item.id} className={cx(
            'pointer-events-auto flex animate-rise items-start gap-3 rounded-xl border bg-panel-raised/95 px-4 py-3 text-sm shadow-card backdrop-blur-xl',
            item.tone === 'success' && 'border-good/35 text-good',
            item.tone === 'error' && 'border-bad/35 text-bad',
            item.tone === 'info' && 'border-accent/35 text-ink',
          )}>
            <Icon name={item.tone === 'success' ? 'check' : item.tone === 'error' ? 'alert' : 'sparkles'} size={18} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{item.message}</span>
            <button type="button" className="pointer-events-auto cursor-pointer text-muted hover:text-ink" onClick={() => setItems((current) => current.filter((currentItem) => currentItem.id !== item.id))} aria-label="Dismiss notification"><Icon name="close" size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}

