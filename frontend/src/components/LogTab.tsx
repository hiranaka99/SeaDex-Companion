import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as api from '../api'
import Icon from './Icons'
import { buttonBase, cx } from '../styles'

interface Props { active: boolean }

export default function LogTab({ active }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [following, setFollowing] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    let timer = 0
    let current = true
    const load = async () => {
      try { const data = await api.getLogs(500); if (current) { setLines(data.lines || []); setError('') } }
      catch (caught) { if (current) setError(caught instanceof Error ? caught.message : 'Could not load logs') }
      finally { if (current) { setLoading(false); timer = window.setTimeout(load, 3000) } }
    }
    void load()
    return () => { current = false; window.clearTimeout(timer) }
  }, [active, retry])
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/
  const output: string[] = []; let previousKept = false
  for (const line of lines) {
    if (!timestamp.test(line)) { if (previousKept) output.push(line); continue }
    const keep = filter === 'all' || (filter === 'error' ? line.includes('[ERROR]') : line.includes('[WARNING]') || line.includes('[ERROR]'))
    previousKept = keep
    if (keep) output.push(line)
  }
  // The source may roll over at 500 lines without changing its length.
  useLayoutEffect(() => {
    if (following && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, filter, following])

  return <section className="log-view flex min-h-0 flex-1 flex-col">
    <header className="app-page-header mb-6 flex shrink-0 flex-wrap items-end justify-between gap-4">
      <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Server log</h1><p className="mt-2 mb-0 text-sm text-muted">Live backend activity, scan events, and integration errors</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-xl border border-line bg-panel p-1">{[['all','All'],['warn','Warnings'],['error','Errors']].map(([value,label]) => <button key={value} type="button" aria-pressed={filter === value} className={cx('touch-target cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold transition-colors', filter === value ? 'bg-accent/12 text-ink' : 'text-muted hover:text-ink')} onClick={() => setFilter(value)}>{label}</button>)}</div>
        <button type="button" aria-pressed={following} className={cx(buttonBase, 'touch-target border-line bg-panel text-xs', following ? 'text-accent-bright' : 'text-ink')} onClick={() => setFollowing(value => !value)}><Icon name={following ? 'pause' : 'play'} size={15}/>Follow live output</button>
      </div>
    </header>
    {error && <div role="alert" className="mb-4 shrink-0 rounded-xl border border-bad/30 bg-bad/8 p-4 text-sm text-bad wrap-anywhere">Could not update logs: {error}. <button type="button" className="touch-target cursor-pointer rounded-md px-2 underline" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-canvas-soft">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-panel/60 px-4 py-3">
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted"><span className={cx('size-2 rounded-full', error ? 'bg-bad' : 'bg-good')}/>{error ? 'Connection interrupted' : following ? 'Live output' : 'Following paused'}</span>
        <span className="text-xs text-muted-dim">{output.length} entries · refreshes every 3s</span>
      </div>
      <div className="log-scrollbar min-h-0 flex-1 overflow-y-auto p-4" ref={boxRef} tabIndex={0} role="region" aria-label="Server log output" onScroll={event => {
        const box = event.currentTarget
        setFollowing(box.scrollHeight - box.clientHeight - box.scrollTop <= 32)
      }}>
        {loading ? <div className="space-y-2">{Array.from({length:8},(_,index)=><div key={index} className="skeleton h-4 rounded" style={{width:`${60+(index%4)*10}%`}}/>)}</div> : output.length === 0 ? <div className="grid h-full place-items-center text-center"><div><Icon name="logs" size={28} className="mx-auto mb-3 text-muted-dim"/><p className="m-0 text-sm text-muted">No matching log entries</p></div></div> : <pre className="m-0 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-[1.7] text-muted">{output.join('\n')}</pre>}
      </div>
    </div>
  </section>
}
