import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

const COLLAPSED_KEY = 'seadex-sidebar-collapsed'
const WIDTH_KEY = 'seadex-sidebar-width'
export const SIDEBAR_MIN = 232
export const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 248
const SIDEBAR_COLLAPSED = 76
const KEYBOARD_STEP = 16

const clamp = (width: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))

/** Sidebar preferences are a convenience: a browser that blocks storage simply starts from the defaults. */
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore storage errors
  }
}

function readWidth(): number {
  const value = Number(readPreference(WIDTH_KEY))
  return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : SIDEBAR_DEFAULT
}

/** Collapsed state and width of the sidebar, with the pointer and keyboard handlers of its resize handle. */
export function useSidebar() {
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_KEY) === '1')
  const [expandedWidth, setExpandedWidth] = useState(readWidth)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      savePreference(COLLAPSED_KEY, previous ? '0' : '1')
      return !previous
    })
  }, [])

  const nudge = (delta: number) => {
    setExpandedWidth(current => {
      const next = clamp(current + delta)
      savePreference(WIDTH_KEY, String(next))
      return next
    })
  }

  const resizeHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      drag.current = { startX: event.clientX, startWidth: expandedWidth }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* synthetic or already-released pointers */
      }
      document.documentElement.classList.add('sidebar-resizing')
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current) setExpandedWidth(clamp(drag.current.startWidth + event.clientX - drag.current.startX))
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return
      drag.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        /* capture may already be gone */
      }
      document.documentElement.classList.remove('sidebar-resizing')
      // The width is saved once the drag ends, not on every pointer move.
      setExpandedWidth(current => {
        savePreference(WIDTH_KEY, String(current))
        return current
      })
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const deltas: Record<string, number> = {
        ArrowLeft: -KEYBOARD_STEP,
        ArrowRight: KEYBOARD_STEP,
        Home: SIDEBAR_MIN - expandedWidth,
        End: SIDEBAR_MAX - expandedWidth,
      }
      if (!(event.key in deltas)) return
      event.preventDefault()
      nudge(deltas[event.key])
    },
  }

  return {
    collapsed,
    toggleCollapsed,
    expandedWidth,
    width: collapsed ? SIDEBAR_COLLAPSED : expandedWidth,
    resizeHandlers,
  }
}
