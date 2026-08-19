import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { actions, control, countBadge, cx, subtitle, tabHeader } from '../styles'

interface Props {
  active: boolean
}

export default function LogTab({ active }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('all')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    let timer = 0
    const load = async () => {
      try {
        const data = await api.getLogs(500)
        setLines(data.lines || [])
      } catch (e) {
        console.error('Failed to load logs:', e)
      }
    }
    load()
    timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [active])

  const tsRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/
  const out: string[] = []
  let prevKept = false
  for (const ln of lines) {
    if (!tsRe.test(ln)) {
      if (prevKept) out.push(ln)
      continue
    }
    let keep: boolean
    if (filter === 'all') keep = true
    else if (filter === 'error') keep = ln.includes('[ERROR]')
    else keep = ln.includes('[WARNING]') || ln.includes('[ERROR]')
    prevKept = keep
    if (keep) out.push(ln)
  }

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [out.length, filter])

  return (
    <section>
      <header className={tabHeader}>
        <div>
          <h2>Server Log</h2>
          <p className={subtitle}>Live activity from the backend — scans, API errors, notifications</p>
        </div>
        <div className={actions}>
          <select className={cx(control, 'cursor-pointer')} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All entries</option>
            <option value="warn">Warnings +</option>
            <option value="error">Errors only</option>
          </select>
          <span className={countBadge}>{out.length}</span>
        </div>
      </header>

      <div className="log-scrollbar max-h-[calc(100vh-210px)] overflow-y-auto rounded-card border border-line bg-[#05070c] px-[18px] py-4 shadow-[inset_0_0_40px_rgba(0,0,0,0.4)]" ref={boxRef}>
        {out.length === 0 && <div className="px-0 py-[30px] text-center text-sm text-muted-dim">No log entries yet.</div>}
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.6] text-[#b9c4d6]">{out.join('\n')}</pre>
      </div>
    </section>
  )
}
