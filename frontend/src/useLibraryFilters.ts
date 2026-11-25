import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LIBRARY_FILTERS,
  libraryFiltersHash,
  parseLibraryFilters,
  type LibraryFilters,
} from './library-filters'

export type { LibraryFilters, LibrarySort, LibraryStatusFilter } from './library-filters'

/**
 * Library search, filters and sort, kept in the URL hash while the Library page is open so a
 * reload, a bookmark or the back button returns to the same view.
 */
export function useLibraryFilters(active: boolean) {
  const [filters, setFilters] = useState<LibraryFilters>(() => parseLibraryFilters(window.location.hash))

  useEffect(() => {
    if (!active) return
    const next = libraryFiltersHash(filters)
    // replaceState keeps typing out of the back-button history and fires no hashchange.
    if (window.location.hash !== next) window.history.replaceState(window.history.state, '', next)
  }, [active, filters])

  const update = useCallback(
    <Key extends keyof LibraryFilters>(key: Key, value: LibraryFilters[Key]) =>
      setFilters(current => (current[key] === value ? current : { ...current, [key]: value })),
    [],
  )
  const reset = useCallback(() => setFilters(DEFAULT_LIBRARY_FILTERS), [])

  return { filters, update, reset }
}
