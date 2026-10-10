import { ReactNode, useEffect, useRef, useState } from 'react'
import { formatBytes } from '../utils'
import { cx } from '../styles'
import Icon from './Icons'
import { getCancelableBulkDownloads, BulkDownloadTarget, CancelableDownload } from '../api'
import Modal from './Modal'
import { bulkDialog } from './bulk-dialog-styles'

interface Props {
  open: boolean
  busy: boolean
  scopeControl: ReactNode
  resultKeys?: Set<string>
  onConfirm: (selections: BulkDownloadTarget[], deleteFiles: boolean) => void
  onClose: () => void
}

export default function BulkCancelDialog({ open, busy, scopeControl, resultKeys, onConfirm, onClose }: Props) {
  const [allDownloads, setDownloads] = useState<CancelableDownload[]>([])
  const downloads = resultKeys ? allDownloads.filter(download => resultKeys.has(download.key)) : allDownloads
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [deleteFiles, setDeleteFiles] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setDownloads([])
    setError('')
    setEnabled({})
    setDeleteFiles(false)
    cancelRef.current?.focus()
    getCancelableBulkDownloads()
      .then((data) => {
        if (!active) return
        const list = data.downloads || []
        setDownloads(list)
        setEnabled(Object.fromEntries(list.map((item) => [`${item.key}\0${item.release}`, true])))
      })
      .catch((caught: Error) => {
        if (!active) return
        setDownloads([])
        setError(caught.message || 'Could not load incomplete torrents')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open])


  if (!open) return null

  const enabledItems = downloads.filter((item) => enabled[`${item.key}\0${item.release}`] !== false)
  const allChecked = downloads.length > 0 && enabledItems.length === downloads.length
  const selections = enabledItems.map((item) => ({ key: item.key, release: item.release }))
  const selectedTorrents = new Set(enabledItems.flatMap(item => item.hashes.map(hash => hash.toLowerCase()))).size

  return (
    <Modal open={open} labelledBy="bulk-cancel-title" busy={busy} onClose={onClose}>
      <section className={cx(bulkDialog.shell, 'max-w-2xl')} aria-busy={busy || loading}>
        <header className={bulkDialog.header}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/12 text-bad"><Icon name="trash" size={19}/></span>
          <div className="min-w-0 flex-1">
            <h2 id="bulk-cancel-title" className="m-0 text-lg font-extrabold">Cancel bulk downloads</h2>
          </div>
          <button type="button" className={bulkDialog.closeButton} onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" size={18}/></button>
          <p className="m-0 basis-full text-sm text-muted">Remove incomplete torrents added by SeaDex Companion. Files are kept unless you choose to delete them; manually added torrents are untouched.</p>
        </header>

        <div className={bulkDialog.body}>
          {scopeControl}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/>Loading active downloads…</div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-lg border border-bad/35 bg-bad/8 px-4 py-3 text-sm text-bad" role="alert"><Icon name="alert" size={18} className="mt-0.5 shrink-0"/>{error}</div>
          ) : downloads.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <button type="button" className={cx('touch-target cursor-pointer rounded-full border px-3 py-1.5 transition-colors', allChecked ? 'border-line-strong bg-panel text-ink hover:bg-canvas-soft hover:border-ink/25' : 'border-bad/50 bg-bad/15 font-extrabold text-bad hover:bg-bad/25')} disabled={busy} title={allChecked ? 'Uncheck every active download' : 'Check every active download'} onClick={() => setEnabled(Object.fromEntries(downloads.map((item) => [`${item.key}\0${item.release}`, !allChecked])))}>{allChecked ? 'Uncheck all' : 'Check all'}</button>
              </div>
              <div className="space-y-1.5">
                {downloads.map((item) => {
                  const id = `${item.key}\0${item.release}`
                  return (
                    <label key={id} className={cx(bulkDialog.row, 'cursor-pointer', enabled[id] !== false ? bulkDialog.rowSelected : bulkDialog.rowUnchecked)}>
                      <input type="checkbox" disabled={busy} className="size-3.5 shrink-0 accent-bad" checked={enabled[id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [id]: event.target.checked }))} />
                      <span className="min-w-0 flex-1 font-semibold text-ink wrap-anywhere">{item.title}</span>
                      <span className={bulkDialog.seasonBadge}>{item.season == null ? 'Movie' : `S${String(item.season).padStart(2, '0')}`}{item.part ? ` · ${item.part}` : ''}</span>
                      <span className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 tabular-nums" title={`${item.release_group} · ${item.tracker}`}>
                        <span className="min-w-0 basis-full text-muted wrap-anywhere" title="Release group">{item.release_group}</span>
                        <span className="font-semibold text-ink">{formatBytes(item.size) || 'Unknown'}</span>
                        {item.hashes.length > 1 && <span className="rounded border border-line px-1.5 py-0.5 text-xs font-bold text-muted">{item.hashes.length} torrents</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"><Icon name="check" size={26} className="text-good"/>No incomplete app-managed downloads in this scope. Choose All tracked downloads to include titles outside these results.</div>
          )}

          {downloads.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-bad/35 bg-bad/6 px-3.5 py-3 text-xs transition-colors hover:border-bad/55">
              <input type="checkbox" className="size-4 shrink-0 accent-bad" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} disabled={busy} />
              <span className="min-w-0">
                <span className={cx('block font-extrabold', deleteFiles ? 'text-bad' : 'text-ink')}>Also delete the downloaded files</span>
                <span className="mt-0.5 block text-muted">The partially downloaded files of the selected torrents will be removed from disk. This cannot be undone.</span>
              </span>
            </label>
          )}
        </div>

        <footer className={bulkDialog.footer}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {selectedTorrents > 0 ? <span><span className="font-bold text-ink">{selectedTorrents}</span> torrent{selectedTorrents === 1 ? '' : 's'} will be removed{deleteFiles ? ' and their downloaded files will be deleted' : ', downloaded files are kept'}.</span> : <span>Nothing selected.</span>}
          </span>
          <div className={bulkDialog.footerActions}>
            <button ref={cancelRef} type="button" className={bulkDialog.neutralButton} onClick={onClose} disabled={busy}>Keep</button>
            <button type="button" className={bulkDialog.removeButton} onClick={() => onConfirm(selections, deleteFiles)} disabled={busy || selections.length === 0}>{busy ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={17}/>}Remove {selectedTorrents || ''} torrent{selectedTorrents === 1 ? '' : 's'}</button>
          </div>
        </footer>
      </section>
    </Modal>
  )
}
