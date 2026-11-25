import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import Icon from './Icons'
import { buttonBase, control, cx } from '../styles'
import {
  countLevels,
  entriesSince,
  entryMatches,
  isError,
  isWarning,
  parseLogEntries,
  splitMatches,
  type LogEntry,
  type LogFilter,
} from '../log-entries'

interface Props {
  active: boolean
}

const LOG_LIMIT = 500
const FILTERS: Array<[LogFilter, string]> = [
  ['all', 'All'],
  ['warn', 'Warnings & errors'],
  ['error', 'Errors'],
]

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line === b[index])

function Highlight({ text, search }: { text: string; search: string }) {
  return (
    <>
      {splitMatches(text, search).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </>
  )
}

function LogRow({ entry, search }: { entry: LogEntry; search: string }) {
  if (!entry.timestamp)
    return (
      <span className="log-continuation">
        <Highlight text={entry.message} search={search} />
      </span>
    )
  const tone = isError(entry) ? 'error' : isWarning(entry) ? 'warn' : 'info'
  return (
    <span className="log-entry" data-level={tone}>
      <span className="log-time">{entry.timestamp.slice(11)}</span>{' '}
      {entry.level ? (
        <>
          <span className="log-level">[{entry.level}]</span>{' '}
        </>
      ) : (
        <span className="log-level" data-empty="true" />
      )}
      <span className="log-message">
        <Highlight text={entry.message} search={search} />
      </span>
      {entry.continuation.map((line, index) => (
        <span key={index} className="log-continuation">
          <Highlight text={line} search={search} />
        </span>
      ))}
    </span>
  )
}

/** The Clipboard API needs a secure context; self-hosted installs are often plain HTTP on a LAN address. */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy was blocked')
  } finally {
    document.body.removeChild(field)
  }
}

function downloadText(text: string) {
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `seadex-companion-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function LogTab({ active }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState<LogFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [following, setFollowing] = useState(true)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const boxRef = useRef<HTMLDivElement>(null)
  const seenKey = useRef<string | null>(null)
  const lastTop = useRef(0)
  const followingRef = useRef(true)
  const copyTimer = useRef(0)
  // Pinning to the bottom fires a scroll event of its own; record the position so the handler reads the app's move, not the reader's.
  const autoScroll = () => {
    const box = boxRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    lastTop.current = box.scrollTop
  }

  useEffect(() => {
    if (!active) return
    let timer = 0
    let current = true
    const load = async () => {
      try {
        const data = await api.getLogs(LOG_LIMIT)
        if (current) {
          const next = data.lines || []
          setLines(previous => (sameLines(previous, next) ? previous : next))
          setError('')
        }
      } catch (caught) {
        if (current) setError(caught instanceof Error ? caught.message : 'Could not load logs')
      } finally {
        if (current) {
          setLoading(false)
          timer = window.setTimeout(load, 3000)
        }
      }
    }
    void load()
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [active, retry])
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const entries = useMemo(() => parseLogEntries(lines), [lines])
  const counts = useMemo(() => countLevels(entries), [entries])
  const levelCount: Record<LogFilter, number> = { all: counts.all, warn: counts.warn, error: counts.errors }
  const visible = useMemo(() => entries.filter(entry => entryMatches(entry, filter, search)), [entries, filter, search])
  const unseen = following ? 0 : entriesSince(entries, seenKey.current)
  const searching = search.trim().length > 0

  // The source may roll over at 500 lines without changing its length.
  useLayoutEffect(() => {
    if (!following) return
    seenKey.current = entries.length ? entries[entries.length - 1].key : null
    autoScroll()
  }, [entries, filter, search, following])
  // Reflow (rotation, a collapsing sidebar) changes the height without the reader scrolling.
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followingRef.current) autoScroll()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const visibleText = () => visible.flatMap(entry => entry.raw).join('\n')
  const remember = (state: 'copied' | 'failed') => {
    setCopyState(state)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2500)
  }
  const onCopy = async () => {
    try {
      await copyText(visibleText())
      remember('copied')
    } catch {
      remember('failed')
    }
  }
  const shown = `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'} shown`

  const empty = () => {
    const clear = (label: string, action: () => void) => (
      <button
        type="button"
        className="touch-target mt-3 cursor-pointer rounded-md px-3 text-sm font-semibold text-accent-bright underline underline-offset-4"
        onClick={action}
      >
        {label}
      </button>
    )
    if (entries.length === 0)
      return { title: 'Nothing logged yet', hint: 'Entries appear here as scans and integrations run.', action: null }
    if (searching)
      return {
        title: `No entries match “${search.trim()}”`,
        hint:
          filter === 'all'
            ? 'Search covers every line of the latest entries, including stack traces.'
            : 'The level filter is also narrowing this search.',
        action: clear('Clear search', () => setSearch('')),
      }
    return filter === 'error'
      ? {
          title: `No errors in the latest ${lines.length} lines`,
          hint: 'The server has not reported a failure recently.',
          action: clear('Show all entries', () => setFilter('all')),
        }
      : {
          title: `No warnings or errors in the latest ${lines.length} lines`,
          hint: 'Nothing needs attention right now.',
          action: clear('Show all entries', () => setFilter('all')),
        }
  }

  return (
    <section className="log-view flex min-h-0 flex-1 flex-col">
      <header className="app-page-header mb-6 flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Server log</h1>
          <p className="log-subtitle mt-2 mb-0 max-w-prose text-sm text-muted">
            Live backend activity, scan events, and integration errors. Copy or download it when reporting a problem.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cx(buttonBase, 'border-line bg-panel text-xs text-ink hover:border-accent')}
            disabled={visible.length === 0}
            aria-label={`Copy ${shown}`}
            onClick={() => void onCopy()}
          >
            <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={15} />
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
          <button
            type="button"
            className={cx(buttonBase, 'border-line bg-panel text-xs text-ink hover:border-accent')}
            disabled={visible.length === 0}
            aria-label={`Download ${shown}`}
            onClick={() => downloadText(visibleText())}
          >
            <Icon name="download" size={15} />
            Download
          </button>
          <span role="status" className="sr-only">
            {copyState === 'copied'
              ? `Copied ${shown}`
              : copyState === 'failed'
                ? 'Could not copy the log. Use Download instead.'
                : ''}
          </span>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="mb-4 shrink-0 rounded-xl border border-bad/30 bg-bad/8 p-4 text-sm text-bad wrap-anywhere"
        >
          Could not update logs: {error}.{lines.length > 0 && ' Showing the last successful update.'}{' '}
          <button
            type="button"
            className="touch-target cursor-pointer rounded-md px-2 underline"
            onClick={() => setRetry(value => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-canvas-soft">
        <div className="log-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-panel/60 px-4 py-3">
          <div
            role="group"
            aria-label="Filter by level"
            className="flex flex-wrap rounded-xl border border-line bg-panel p-1"
          >
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                className={cx(
                  'touch-target inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
                  filter === value ? 'bg-accent/12 text-ink' : 'text-muted hover:text-ink',
                )}
                onClick={() => setFilter(value)}
              >
                {label}
                <span
                  className={cx(
                    'tabular-nums',
                    value === 'error' && counts.errors > 0
                      ? 'text-bad'
                      : value === 'warn' && counts.warn > counts.errors
                        ? 'text-warn'
                        : 'text-muted-dim',
                  )}
                >
                  {levelCount[value]}
                </span>
              </button>
            ))}
          </div>
          <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-dim"
            />
            <input
              type="search"
              name="log-search"
              aria-label="Search log"
              placeholder="Search log"
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape' && search) {
                  event.stopPropagation()
                  setSearch('')
                }
              }}
              className={cx(control, 'log-search w-full py-2 pr-10 pl-9 text-sm')}
            />
            {searching && (
              <button
                type="button"
                aria-label="Clear search"
                className="touch-target absolute top-1/2 right-1 grid -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted hover:text-ink"
                onClick={() => setSearch('')}
              >
                <Icon name="close" size={15} />
              </button>
            )}
          </div>
        </div>
        <div
          className="log-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
          ref={boxRef}
          tabIndex={0}
          role="region"
          aria-label="Server log output"
          onScroll={event => {
            const box = event.currentTarget
            const atBottom = box.scrollHeight - box.clientHeight - box.scrollTop <= 32
            // Only a reader moving upward pauses following; reflow alone never does. The ref flips immediately so a ResizeObserver reflow in the same frame cannot pin the reader back down.
            if (atBottom) {
              followingRef.current = true
              setFollowing(true)
            } else if (box.scrollTop < lastTop.current) {
              followingRef.current = false
              setFollowing(false)
            }
            lastTop.current = box.scrollTop
          }}
        >
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="skeleton h-4 rounded" style={{ width: `${60 + (index % 4) * 10}%` }} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            (() => {
              const state = empty()
              return (
                <div className="grid h-full place-items-center text-center">
                  <div className="max-w-sm">
                    <Icon name="logs" size={28} className="mx-auto mb-3 text-muted-dim" />
                    <p className="m-0 text-sm font-semibold text-ink">{state.title}</p>
                    <p className="mt-1 mb-0 text-sm text-muted">{state.hint}</p>
                    {state.action}
                  </div>
                </div>
              )
            })()
          ) : (
            <pre className="log-output m-0 whitespace-pre-wrap wrap-anywhere font-mono">
              {visible.map((entry, index) => {
                const day = entry.timestamp.slice(0, 10)
                const divider = day !== '' && day !== (visible[index - 1]?.timestamp.slice(0, 10) ?? null)
                return (
                  <Fragment key={entry.key}>
                    {divider && <span className="log-date">{day}</span>}
                    <LogRow entry={entry} search={search} />
                  </Fragment>
                )
              })}
            </pre>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-panel/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={following}
              className={cx(
                'touch-target inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors',
                following
                  ? 'border-accent/50 bg-accent/12 text-ink'
                  : 'border-line-strong bg-panel text-ink hover:border-accent',
              )}
              onClick={() => {
                const next = !following
                followingRef.current = next
                setFollowing(next)
              }}
            >
              <Icon name="chevron-down" size={15} />
              Follow latest
            </button>
            {unseen !== 0 && (
              <span
                role="status"
                className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold tabular-nums text-on-accent"
              >
                {unseen === null ? `${LOG_LIMIT}+` : unseen} new
              </span>
            )}
          </div>
          <span className="log-meta inline-flex flex-wrap items-center gap-x-2 text-xs text-muted-dim">
            <span aria-hidden="true" className={cx('size-2 rounded-full', error ? 'bg-bad' : 'bg-good')} />
            {error ? 'Connection interrupted' : 'Connected'}
            <span aria-hidden="true">·</span>
            {visible.length === entries.length
              ? `${entries.length} entries`
              : `${visible.length} of ${entries.length} entries`}
            <span aria-hidden="true">·</span>Latest {LOG_LIMIT} lines, refreshed every 3s
          </span>
        </div>
      </div>
    </section>
  )
}
