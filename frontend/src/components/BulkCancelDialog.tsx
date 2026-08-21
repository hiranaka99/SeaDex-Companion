import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '../utils'
import { buttonBase, cx } from '../styles'
import Icon from './Icons'
import { getCancelableBulkDownloads, BulkDownloadTarget, CancelableDownload } from '../api'
import { useRestoreFocus } from './useRestoreFocus'

interface Props {
  open: boolean
  busy: boolean
  onConfirm: (selections: BulkDownloadTarget[], deleteFiles: boolean) => void
  onClose: () => void
}

export default function BulkCancelDialog({ open, busy, onConfirm, onClose }: Props) {
  useRestoreFocus(open)
  const [downloads, setDownloads] = useState<CancelableDownload[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [deleteFiles, setDeleteFiles] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setDownloads([])
    setError('')
    setEnabled({})
    setDeleteFiles(false)
    cancelRef.current?.focus()
    getCancelableBulkDownloads()
      .then((data) => {
        const list = data.downloads || []
        setDownloads(list)
        setEnabled(Object.fromEntries(list.map((item) => [`${item.key}\0${item.release}`, true])))
      })
      .catch((caught: Error) => {
        setDownloads([])
        setError(caught.message || 'Could not load incomplete torrents')
      })
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, busy, onClose])

  if (!open) return null

  const enabledItems = downloads.filter((item) => enabled[`${item.key}\0${item.release}`] !== false)
  const allChecked = downloads.length > 0 && enabledItems.length === downloads.length
  const selections = enabledItems.map((item) => ({ key: item.key, release: item.release }))
  const selectedTorrents = enabledItems.reduce((total, item) => total + item.hashes.length, 0)

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/65 px-4 py-6 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-raised shadow-[0_24px_70px_rgba(0,0,0,.55)]" role="dialog" aria-modal="true" aria-labelledby="bulk-cancel-title" aria-busy={busy || loading}>
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/12 text-bad"><Icon name="trash" size={19}/></span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-cancel-title" className="m-0 text-lg font-extrabold">Cancel bulk downloads</h2>
            <p className="mt-1 mb-0 text-sm text-muted">Remove the incomplete torrents that SeaDex Companion added to qBittorrent. By default the downloaded files are kept, and torrents you added manually are left untouched.</p>
          </div>
          <button type="button" className="grid size-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" size={18}/></button>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/>Loading active downloads…</div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-lg border border-bad/35 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="mt-0.5 shrink-0"/>{error}</div>
          ) : downloads.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <button type="button" className={cx('cursor-pointer rounded-full border px-3 py-1.5 transition-colors', allChecked ? 'border-line-strong bg-panel text-ink hover:bg-canvas-soft hover:border-ink/25' : 'border-bad/50 bg-bad/15 font-extrabold text-bad hover:bg-bad/25')} title={allChecked ? 'Uncheck every active download' : 'Check every active download'} onClick={() => setEnabled(Object.fromEntries(downloads.map((item) => [`${item.key}\0${item.release}`, !allChecked])))}>{allChecked ? 'Uncheck all' : 'Check all'}</button>
              </div>
              <div className="space-y-1.5">
                {downloads.map((item) => {
                  const id = `${item.key}\0${item.release}`
                  return (
                    <label key={id} className={cx('flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs transition-colors', enabled[id] !== false ? 'border-line bg-panel hover:border-line-strong' : 'border-line/60 bg-canvas-soft opacity-55')}>
                      <input type="checkbox" className="size-3.5 shrink-0 accent-red-500" checked={enabled[id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [id]: event.target.checked }))} />
                      <span className="font-semibold text-ink">{item.title}</span>
                      <span className="rounded border border-line-strong bg-canvas-soft px-1.5 py-0.5 text-[10px] font-extrabold text-muted">{item.season == null ? 'Movie' : `S${String(item.season).padStart(2, '0')}`}{item.part ? ` · ${item.part}` : ''}</span>
                      <span className="ml-auto flex items-center gap-1.5 tabular-nums" title={`${item.release_group} · ${item.tracker}`}>
                        <span className="text-muted" title="Release group">{item.release_group}</span>
                        <span className="font-bold text-bad">{formatBytes(item.size) || 'Unknown'}</span>
                        {item.hashes.length > 1 && <span className="rounded border border-line px-1.5 py-0.5 text-[10px] font-bold text-muted">{item.hashes.length} torrents</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"><Icon name="check" size={26} className="text-good"/>No incomplete torrents added by the app are currently in qBittorrent.</div>
          )}

          {downloads.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-bad/35 bg-bad/6 px-3.5 py-3 text-xs transition-colors hover:border-bad/55">
              <input type="checkbox" className="size-4 shrink-0 accent-red-500" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} disabled={busy} />
              <span className="min-w-0">
                <span className={cx('block font-extrabold', deleteFiles ? 'text-bad' : 'text-ink')}>Also delete the downloaded files</span>
                <span className="mt-0.5 block text-muted">The partially downloaded files of the selected torrents will be removed from disk. This cannot be undone.</span>
              </span>
            </label>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-5 py-4">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {selectedTorrents > 0 ? <span><span className="font-bold text-ink">{selectedTorrents}</span> torrent{selectedTorrents === 1 ? '' : 's'} will be removed{deleteFiles ? ' and their downloaded files will be deleted' : ', downloaded files are kept'}.</span> : <span>Nothing selected.</span>}
          </span>
          <div className="flex gap-2">
            <button ref={cancelRef} type="button" className={cx(buttonBase, 'border-line bg-panel-raised text-muted hover:text-ink')} onClick={onClose} disabled={busy}>Keep</button>
            <button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/12 text-bad hover:bg-bad/20')} onClick={() => onConfirm(selections, deleteFiles)} disabled={busy || selections.length === 0}>{busy ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={17}/>}Cancel {selections.length || ''}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}
