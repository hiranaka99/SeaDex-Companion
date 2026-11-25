import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabId } from './types'

const TABS: TabId[] = ['anime', 'history', 'config', 'log']

function readTab(): TabId {
  // A page may keep its own state after a "?" (e.g. #history?type=upgrade); only the part before it names the page.
  const value = window.location.hash.slice(1).split('?')[0]
  return TABS.find(tab => tab === value) ?? 'anime'
}

/** The open page, kept in the URL hash so reloads and the back button return to it. */
export function useHashTab() {
  const [tab, setTab] = useState<TabId>(readTab)
  // Pages mount on their first visit and then stay mounted, so drafts survive navigation.
  const visited = useRef(new Set<TabId>())
  visited.current.add(tab)

  useEffect(() => {
    const navigate = () => setTab(readTab())
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])

  const changeTab = useCallback(
    (next: TabId) => {
      if (next !== tab) window.location.hash = next
      setTab(next)
    },
    [tab],
  )

  return { tab, changeTab, visited: visited.current }
}
