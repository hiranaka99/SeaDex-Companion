import { useEffect, useRef, useState } from 'react'
import * as api from '../api'

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
    <section className="tab">
      <header className="tab-header">
        <div>
          <h2>Server Log</h2>
          <p className="subtitle">Live activity from the backend — scans, API errors, notifications</p>
        </div>
        <div className="actions">
          <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All entries</option>
            <option value="warn">Warnings +</option>
            <option value="error">Errors only</option>
          </select>
          <span className="count-badge">{out.length}</span>
        </div>
      </header>

      <div className="log-box" ref={boxRef}>
        {out.length === 0 && <div className="log-empty">No log entries yet.</div>}
        <pre className="log-lines">{out.join('\n')}</pre>
      </div>
    </section>
  )
}