import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { useToast } from './components/Toast'
import { errorMessage } from '../../shared/errors.js'

const UNDO_MS = 12000

/** Returns keyboard focus to a card that came back after an undone hide. */
function focusCardDetails(title: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    candidate => candidate.getAttribute('aria-label') === `Details for ${title}`,
  )
  button?.scrollIntoView({ block: 'nearest' })
  button?.focus({ preventScroll: true })
}

/**
 * The set of hidden library cards. A change shows at once and is rolled back if saving it
 * fails; `titleFor` names the card in the confirmation.
 */
export function useHiddenCards(saved: string[] | undefined, titleFor: (key: string) => string | undefined) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const current = useRef(hiddenKeys)
  const requests = useRef(new Map<string, Promise<unknown>>())
  const toast = useToast()

  useEffect(() => {
    if (!saved) return
    current.current = new Set(saved)
    setHiddenKeys(current.current)
  }, [saved])

  const setCardHidden = useCallback(
    async (key: string, hidden: boolean, offerUndo = false): Promise<boolean> => {
      const wasHidden = current.current.has(key)
      const show = (value: boolean) => {
        const next = new Set(current.current)
        if (value) next.add(key)
        else next.delete(key)
        current.current = next
        setHiddenKeys(next)
      }
      show(hidden)
      // Serialize writes for each card so a quick Undo cannot finish out of order.
      const request = (requests.current.get(key) || Promise.resolve())
        .catch(() => {})
        .then(() => api.setHidden(key, hidden))
      requests.current.set(key, request)
      try {
        await request
        if (requests.current.get(key) !== request) return false
        const title = titleFor(key) || 'Title'
        const undo = {
          label: 'Undo',
          onClick: () => {
            void setCardHidden(key, wasHidden).then(restored => {
              if (restored) window.requestAnimationFrame(() => focusCardDetails(title))
            })
          },
        }
        toast.show(
          hidden ? `${title} hidden from the library` : `${title} restored to the library`,
          'success',
          offerUndo ? UNDO_MS : undefined,
          offerUndo ? undo : undefined,
        )
        return true
      } catch (error) {
        if (requests.current.get(key) === request) show(wasHidden)
        toast.show('Could not update hidden cards: ' + errorMessage(error), 'error')
        return false
      } finally {
        if (requests.current.get(key) === request) requests.current.delete(key)
      }
    },
    [titleFor, toast],
  )

  /** Flips one card and offers to undo it. */
  const toggleHidden = useCallback(
    (key: string) => void setCardHidden(key, !current.current.has(key), true),
    [setCardHidden],
  )

  return { hiddenKeys, toggleHidden }
}
