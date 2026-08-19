import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import Icon from './Icons'
import { cx } from '../styles'

interface Props { active: boolean }

export default function LogTab({ active }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    let timer = 0
    const load = async () => { try { const data = await api.getLogs(500); setLines(data.lines || []) } catch (error) { console.error('Failed to load logs:', error) } finally { setLoading(false) } }
    void load(); timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [active])
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/
  const output: string[] = []; let previousKept = false
  for (const line of lines) { if (!timestamp.test(line)) { if (previousKept) output.push(line); continue } const keep = filter === 'all' || filter === 'error' ? filter === 'all' || line.includes('[ERROR]') : line.includes('[WARNING]') || line.includes('[ERROR]'); previousKept = keep; if (keep) output.push(line) }
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight }, [output.length, filter])
  return <section><header className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Diagnostics</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Server log</h1><p className="mt-2 mb-0 text-sm text-muted">Live backend activity, scan events, and integration errors</p></div><div className="flex rounded-xl border border-line bg-panel p-1">{[['all','All'],['warn','Warnings'],['error','Errors']].map(([value,label]) => <button key={value} type="button" className={cx('cursor-pointer rounded-lg px-3 py-2 text-xs font-bold transition-colors', filter === value ? 'bg-accent/12 text-accent-bright' : 'text-muted hover:text-ink')} onClick={() => setFilter(value)}>{label}</button>)}</div></header><div className="overflow-hidden rounded-2xl border border-line bg-[#080b11] shadow-card"><div className="flex items-center justify-between border-b border-line bg-panel/60 px-4 py-3"><span className="inline-flex items-center gap-2 text-xs font-bold text-muted"><span className="size-2 rounded-full bg-good"/>Live output</span><span className="text-[11px] text-muted-dim">{output.length} entries · refreshes every 3s</span></div><div className="log-scrollbar h-[calc(100dvh-235px)] min-h-[360px] overflow-y-auto p-4" ref={boxRef}>{loading ? <div className="space-y-2">{Array.from({length:8},(_,index)=><div key={index} className="skeleton h-4 rounded" style={{width:`${60+(index%4)*10}%`}}/>)}</div> : output.length === 0 ? <div className="grid h-full place-items-center text-center"><div><Icon name="logs" size={28} className="mx-auto mb-3 text-muted-dim"/><p className="m-0 text-sm text-muted">No matching log entries</p></div></div> : <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.7] text-[#b9c4d6]">{output.join('\n')}</pre>}</div></div></section>
}