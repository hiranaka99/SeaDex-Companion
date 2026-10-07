import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { formatBytes, formatEta } from '../utils'
import { buttonBase, control, cx, downloadTextTone } from '../styles'
import Icon from './Icons'
import ConfirmDialog from './ConfirmDialog'
import { useToast } from './Toast'

export default function DownloadsTab() {
  const [downloads, setDownloads] = useState<api.TrackedDownload[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [remove, setRemove] = useState<api.TrackedDownload | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const toast = useToast()
  const request = useRef(0)
  const controlling = useRef(false)
  const load = useCallback(async () => {
    const current = ++request.current
    try { const data = await api.getTrackedDownloads(); if (current === request.current) { setDownloads(data.downloads); setError('') } }
    catch (caught) { if (current === request.current) setError(caught instanceof Error ? caught.message : 'Could not load downloads') }
    finally { if (current === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    let active = true
    let timer = 0
    const poll = async () => { await load(); if (active) timer = window.setTimeout(poll, 3000) }
    void poll()
    return () => { active = false; request.current += 1; window.clearTimeout(timer) }
  }, [load])
  const controlDownload = async (download: api.TrackedDownload, action: api.DownloadAction) => {
    if (controlling.current) throw new Error('Wait for the current torrent action to finish')
    controlling.current = true
    setBusy(download.hash)
    try {
      await api.controlTrackedDownload(download.hash, action, action === 'remove' && deleteFiles)
      await load()
      toast.show(action === 'remove' ? `Torrent removed; files ${deleteFiles ? 'deleted' : 'kept'}` : action === 'pause' ? 'Torrent paused' : 'Torrent resumed', 'success')
    } catch (caught) { toast.show(caught instanceof Error ? caught.message : 'Could not update the torrent', 'error'); throw caught }
    finally { controlling.current = false; setBusy('') }
  }
  const shown = downloads.filter(download => `${download.title} ${download.name} ${download.releaseGroup}`.toLowerCase().includes(query.toLowerCase()))
  return <section>
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-xs font-bold tracking-[.14em] text-muted-dim uppercase">Transfers</p><h1 className="m-0 text-3xl font-extrabold">Downloads</h1><p className="mt-2 mb-0 text-sm text-muted">Manage torrents added by SeaDex Companion, even after library recommendations change.</p></div><button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => void load()}><Icon name="refresh" size={16}/>Refresh</button></header>
    <label className="mb-4 block"><span className="sr-only">Search downloads</span><input type="search" className={cx(control, 'w-full')} placeholder="Search titles, release groups, or torrent names" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {error && <div className="mb-4 rounded-xl border border-bad/30 bg-bad/8 p-4 text-sm text-bad" role="alert">Could not update downloads: {error}. Displayed progress may be outdated.</div>}
    {loading ? <p className="text-sm text-muted">Loading downloads…</p> : !shown.length && <p className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">{query ? 'No downloads match this search.' : 'No app-added torrents are currently in qBittorrent.'}</p>}
    <div className="space-y-3">{shown.map(download => <article key={download.hash} className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h2 className="m-0 text-sm font-bold">{download.title}{download.season ? ` · S${String(download.season).padStart(2, '0')}` : ''}{download.part ? ` · ${download.part}` : ''}</h2><p className="mt-1 mb-0 break-all text-xs text-muted">{download.name || download.releaseGroup}</p></div><span className={cx('text-xs font-bold', downloadTextTone(download.state === 'complete' ? 'complete' : download.paused || download.state === 'paused' ? 'paused' : download.state))}>{download.state === 'complete' ? 'Complete' : (download.paused || download.state === 'paused') ? 'Paused' : download.state === 'error' ? 'Error' : download.state === 'downloading' ? 'Downloading' : 'Waiting'}</span><button type="button" className={cx(buttonBase, 'border-line text-muted')} disabled={Boolean(busy)} aria-label={`${(download.paused || download.state === 'paused') ? 'Resume' : 'Pause'} ${download.title}`} onClick={() => void controlDownload(download, (download.paused || download.state === 'paused') ? 'resume' : 'pause').catch(() => {})}><Icon name={(download.paused || download.state === 'paused') ? 'play' : 'pause'} size={15}/></button><button type="button" className={cx(buttonBase, 'border-bad/30 text-bad')} disabled={Boolean(busy)} aria-label={`Remove ${download.title}`} onClick={() => { setRemove(download); setDeleteFiles(false) }}><Icon name="trash" size={15}/></button></div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-canvas-soft" role="progressbar" aria-label={`${download.title} progress`} aria-valuenow={Math.round(download.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.min(100, Math.max(0, download.progress * 100))}%` }}/></div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted tabular-nums"><span>{(download.progress * 100).toFixed(1)}%</span><span>{formatBytes(download.downloaded) || '0 B'} / {formatBytes(download.total_size) || 'Unknown size'}</span>{download.speed > 0 && <span>{formatBytes(download.speed)}/s · {formatEta(download.total_size - download.downloaded, download.speed)} remaining</span>}</div>
    </article>)}</div>
    <ConfirmDialog open={remove !== null} title="Remove torrent?" description={`Remove ${remove?.title || 'this torrent'} from qBittorrent? Downloaded files are kept by default.`} confirmLabel="Remove torrent" dangerous onClose={() => setRemove(null)} onConfirm={async () => { if (remove) await controlDownload(remove, 'remove') }}><label className="mb-5 flex items-center gap-3 text-sm"><input type="checkbox" checked={deleteFiles} onChange={event => setDeleteFiles(event.target.checked)}/><span>Also delete downloaded files</span></label></ConfirmDialog>
  </section>
}
