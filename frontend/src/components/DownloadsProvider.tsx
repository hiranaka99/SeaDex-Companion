import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react'

/** One in-flight release download, reported by a card to the shared registry. */
export interface DownloadEntry {
  id: string // unique: seasonKey + release index
  title: string // anime title
  season: string // season label (e.g. "S01", "Movie")
  releaseGroup: string // release group name
  phase: 'sending' | 'downloading'
  progress: number // 0..1
  downloaded: number // bytes
  total_size: number // bytes
  speed: number // bytes/s
}

type Registry = Record<string, DownloadEntry[]>

interface DownloadsContextValue {
  /** All active downloads across every card, flattened. */
  downloads: DownloadEntry[]
  /** Replace the set of active downloads reported by one card. */
  report: (cardKey: string, entries: DownloadEntry[]) => void
  /** Remove a card's downloads (called on unmount). */
  unregister: (cardKey: string) => void
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null)

function sameEntries(a: DownloadEntry[], b: DownloadEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.phase !== y.phase ||
      x.progress !== y.progress ||
      x.downloaded !== y.downloaded ||
      x.total_size !== y.total_size ||
      x.speed !== y.speed
    )
      return false
  }
  return true
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Registry>({})

  const report = useCallback((cardKey: string, entries: DownloadEntry[]) => {
    setRegistry((prev) => {
      const existing = prev[cardKey]
      if (existing && sameEntries(existing, entries)) return prev
      return { ...prev, [cardKey]: entries }
    })
  }, [])

  const unregister = useCallback((cardKey: string) => {
    setRegistry((prev) => {
      if (!(cardKey in prev)) return prev
      const next = { ...prev }
      delete next[cardKey]
      return next
    })
  }, [])

  const downloads = useMemo(() => Object.values(registry).flat(), [registry])

  return (
    <DownloadsContext.Provider value={{ downloads, report, unregister }}>
      {children}
    </DownloadsContext.Provider>
  )
}

export function useDownloads(): DownloadsContextValue {
  const ctx = useContext(DownloadsContext)
  if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider')
  return ctx
}