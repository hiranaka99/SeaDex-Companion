import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

interface Position { x: number; y: number; width: number; height: number }
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

/** Keep title identity visible as a filtered/sorted collection rearranges. */
export function useLibraryMotion(gridRef: RefObject<HTMLDivElement | null>, revision: string, active: boolean) {
  const positions = useRef(new Map<string, Position>())
  const motions = useRef(new Map<string, Animation>())

  useEffect(() => () => {
    for (const animation of motions.current.values()) animation.cancel()
    motions.current.clear()
  }, [])

  useLayoutEffect(() => {
    const grid = gridRef.current
    const stop = () => {
      for (const animation of motions.current.values()) animation.cancel()
      motions.current.clear()
    }
    if (!grid || !active) { stop(); positions.current.clear(); return }
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let current = true
    const cards = [...grid.querySelectorAll<HTMLElement>(':scope > article[data-library-key]')]
    const origin = grid.getBoundingClientRect()
    // Batch geometry reads before cancelling/replacing any animations. An
    // interrupted animation starts from its current visual position.
    const measurements = cards.map(card => {
      const rect = card.getBoundingClientRect()
      const key = card.dataset.libraryKey!
      const matrix = motions.current.has(key) ? new DOMMatrixReadOnly(getComputedStyle(card).transform) : null
      const tx = matrix?.m41 || 0
      const ty = matrix?.m42 || 0
      const next = { x: rect.left - origin.left - tx, y: rect.top - origin.top - ty, width: rect.width, height: rect.height }
      const previous = positions.current.get(key)
      return { card, key, next, previous, tx, ty }
    })
    stop()
    positions.current = new Map(measurements.map(({ key, next }) => [key, next]))

    const rememberLayout = () => {
      if (!current || motions.current.size) return
      const bounds = grid.getBoundingClientRect()
      positions.current = new Map(cards.map(card => {
        const rect = card.getBoundingClientRect()
        return [card.dataset.libraryKey!, { x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height }]
      }))
    }
    if (!preference.matches && !document.hidden && typeof Element.prototype.animate === 'function') {
      let revealIndex = 0
      for (const { card, key, next, previous, tx, ty } of measurements) {
        const visible = origin.top + next.y < innerHeight && origin.top + next.y + next.height > 0
        if (!visible) continue
        let animation: Animation | undefined
        if (previous && Math.abs(previous.width - next.width) < 1) {
          const dx = previous.x + tx - next.x
          const dy = previous.y + ty - next.y
          // Avoid flying a title across pages or from far outside the viewport.
          if ((Math.abs(dx) > 1 || Math.abs(dy) > 1) && Math.abs(dy) < innerHeight && Math.abs(dx) < innerWidth) {
            animation = card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 260, easing: EASE })
          }
        } else if (!previous) {
          animation = card.animate([{ opacity: 0.72, clipPath: 'inset(0 0 12px 0 round 14px)' }, { opacity: 1, clipPath: 'inset(0 round 14px)' }], { duration: 180, delay: Math.min(revealIndex++ * 18, 72), easing: EASE, fill: 'backwards' })
        }
        if (!animation) continue
        motions.current.set(key, animation)
        void animation.finished.then(() => {
          if (!current || motions.current.get(key) !== animation) return
          motions.current.delete(key)
          rememberLayout()
        }).catch(() => { /* Cancelled by a newer interaction, resize, or preference. */ })
      }
    }

    // Download rows and artwork can change a card's height independently of
    // the collection. Refresh the baseline without animating those updates.
    let width = origin.width
    const observer = new ResizeObserver(() => {
      const nextWidth = grid.getBoundingClientRect().width
      if (Math.abs(nextWidth - width) > 1) { stop(); width = nextWidth }
      rememberLayout()
    })
    observer.observe(grid)
    for (const card of cards) observer.observe(card)
    const reduceMotion = () => { if (preference.matches) { stop(); rememberLayout() } }
    const visibility = () => { if (document.hidden) stop() }
    preference.addEventListener('change', reduceMotion)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      current = false
      observer.disconnect()
      preference.removeEventListener('change', reduceMotion)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [gridRef, revision, active])
}
