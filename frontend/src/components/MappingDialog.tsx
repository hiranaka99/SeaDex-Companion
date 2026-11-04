import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import Icon from './Icons'
import Modal from './Modal'

interface Props {
  open: boolean
  title: string
  currentAniListId: number | string | null
  currentAniListIds?: number[]
  season?: number
  hasOverride: boolean
  onApply: (anilistIds: number[] | null) => Promise<void>
  onClose: () => void
}

export default function MappingDialog({ open, title, currentAniListId, currentAniListIds, season, hasOverride, onApply, onClose }: Props) {
  const [query, setQuery] = useState(title)
  const [results, setResults] = useState<api.AniListSearchResult[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [selectedTitles, setSelectedTitles] = useState<Record<number, string>>({})
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const searchGeneration = useRef(0)

  const search = async (value = query) => {
    const generation = ++searchGeneration.current
    if (value.trim().length < 2) { setResults([]); setSearching(false); setError('Enter at least two characters'); return }
    setSearching(true); setError('')
    try {
      const response = await api.searchAniList(value)
      if (generation === searchGeneration.current) {
        const matches = response.results || []
        setResults(matches)
        setSelectedTitles(titles => ({ ...titles, ...Object.fromEntries(matches.map(result => [result.id, result.title])) }))
      }
    } catch (caught: any) {
      if (generation === searchGeneration.current) setError(caught?.message || 'AniList search failed')
    } finally {
      if (generation === searchGeneration.current) setSearching(false)
    }
  }

  useEffect(() => {
    if (!open) {
      searchGeneration.current += 1
      return
    }
    const current = Number(currentAniListId)
    const initialQuery = season && season > 1 ? `${title} Season ${season}` : title
    setQuery(initialQuery); setResults([]); setSelected(season && currentAniListIds?.length ? currentAniListIds : current > 0 ? [current] : []); setSelectedTitles({}); setError('')
    window.setTimeout(() => inputRef.current?.focus(), 0)
    void search(initialQuery)
  // Search only when a fresh dialog opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, title, season])


  if (!open) return null

  const apply = async (value: number[] | null) => {
    setSaving(true); setError('')
    try { await onApply(value) }
    catch (caught: any) { setError(caught?.message || 'Could not save the match') }
    finally { setSaving(false) }
  }

  return <Modal open={open} labelledBy="mapping-title" busy={saving} onClose={onClose}>
    <section className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-raised shadow-[0_24px_70px_rgba(0,0,0,.55)]" aria-busy={saving}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-bright"><Icon name="search" size={19}/></span><div className="min-w-0 flex-1"><h2 id="mapping-title" className="m-0 text-lg font-extrabold">{season ? `Correct Season ${season} match` : 'Correct AniList match'}</h2><p className="mt-1 mb-0 text-sm text-muted">{season ? <>Choose the AniList entry for Season {season} of <span className="font-bold text-ink">{title}</span>. For split cours, add entries in episode order.</> : <>Choose the anime that should anchor automatic season matching for <span className="font-bold text-ink">{title}</span>. Season-specific matches take priority.</>}</p></div><button type="button" className="grid touch-target size-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onClose} disabled={saving} aria-label="Close"><Icon name="close" size={18}/></button></header>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void search() }}><label className="min-w-0 flex-1"><span className="mb-1.5 block text-xs font-bold text-ink">Search AniList</span><input ref={inputRef} className={cx(control, 'w-full')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Anime title"/></label><button type="submit" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} disabled={searching || saving}>{searching ? <span className="size-4 animate-spin rounded-full border-2 border-muted/30 border-t-accent"/> : <Icon name="search" size={16}/>}Search</button></form>
        {error && <p className="mt-3 mb-0 rounded-lg border border-bad/30 bg-bad/8 px-3 py-2 text-xs text-bad" role="alert">{error}</p>}
        {season && selected.length > 0 && <div className="mt-4" aria-label="Selected AniList entries"><p className="mb-2 text-xs font-bold text-ink">Season {season} entries · episode order</p><ol className="m-0 list-none divide-y divide-line p-0">{selected.map((id, index) => <li key={id} className="flex items-center gap-2 py-2 text-sm"><span className="min-w-0 flex-1 wrap-anywhere">{index + 1}. {selectedTitles[id] || results.find(result => result.id === id)?.title || `AniList #${id}`}</span>{index > 0 && <button type="button" className={cx(buttonBase, 'shrink-0 border-line bg-panel px-2 text-xs text-ink')} disabled={saving} aria-label={`Move AniList ${id} earlier`} onClick={() => setSelected(ids => { const next = [...ids]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next })}>Move up</button>}<button type="button" className="touch-target shrink-0 cursor-pointer rounded-lg p-2 text-muted hover:bg-panel hover:text-ink" aria-label={`Remove AniList ${id}`} disabled={saving} onClick={() => setSelected(ids => ids.filter(value => value !== id))}><Icon name="close" size={16}/></button></li>)}</ol></div>}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">{results.map((result) => <button key={result.id} type="button" className={cx('flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition-colors', selected.includes(result.id) ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:border-line-strong')} onClick={() => { setSelectedTitles(titles => ({ ...titles, [result.id]: result.title })); setSelected(ids => season ? ids.includes(result.id) ? ids.filter(id => id !== result.id) : [...ids, result.id] : [result.id]) }} aria-pressed={selected.includes(result.id)} disabled={saving || Boolean(season && selected.length >= 20 && !selected.includes(result.id))}>{result.cover ? <img src={result.cover} alt="" className="h-16 w-11 shrink-0 rounded-md object-cover"/> : <span className="h-16 w-11 shrink-0 rounded-md bg-canvas-soft"/>}<span className="min-w-0"><span className="block text-sm font-bold text-ink">{result.title}</span>{result.romaji && result.romaji !== result.title && <span className="mt-0.5 block text-xs wrap-anywhere text-muted">{result.romaji}</span>}<span className="mt-1 block text-xs text-muted-dim">AniList #{result.id} · {[result.format, result.year, result.episodes ? `${result.episodes} eps` : ''].filter(Boolean).join(' · ')}</span></span></button>)}</div>
        {!searching && results.length === 0 && !error && <p className="mt-5 text-center text-sm text-muted">No results found.</p>}
      </div>
      <footer className="grid gap-2 border-t border-line px-5 py-4 sm:flex sm:flex-wrap sm:items-center">{hasOverride && <button type="button" className={cx(buttonBase, 'border-warn/35 bg-warn/10 text-warn')} onClick={() => void apply(null)} disabled={saving}>Use automatic match</button>}<span className="hidden sm:block sm:flex-1"/><button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink hover:text-ink')} onClick={onClose} disabled={saving}>Cancel</button><button type="button" className={buttonPrimary} onClick={() => selected.length && void apply(selected)} disabled={!selected.length || saving}>{saving ? <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/> : <Icon name="check" size={16}/>}Save and rescan</button></footer>
    </section>
  </Modal>
}
