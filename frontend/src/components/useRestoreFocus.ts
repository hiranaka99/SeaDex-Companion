import { useEffect, useRef } from 'react'

export function useRestoreFocus(open: boolean): void {
  const previous = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const target = previous.current
      window.requestAnimationFrame(() => target?.focus())
    }
  }, [open])
}
