import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { LibraryFilterRequest, ResultItem, ScanHistoryChange, ScanHistoryEntry } from '../types'
import Icon from './Icons'
import { buttonBase, control, cx } from '../styles'
import { displayDateTime } from '../datetime'
import { sourceName } from '../utils'
import { STATUS_PRESENTATION } from '../status-presentation'
import {
  changeTypeLabel,
  groupChanges,
  historyDetails,
  historyStatus,
  historyStatusKind,
  historyStatusLabel as statusLabel,
  matchesHistoryQuery,
  pluralize,
  scanTimes,
  sectionRows,
  summarizeChanges,
  visitDigest,
  type HistoryRow,
} from '../history'
import ReleaseChangeLine from './ReleaseChangeLine'
import type { CardStatus } from '../types'

interface Props {
  active: boolean
  results: ResultItem[]
  /** True until the library results have loaded once. */
  resultsLoading: boolean
  resultsError: string
  /** A scan or bulk download is already running. */
  scanDisabled: boolean
  onScan: () => void
  onOpenResult: (key: string) => void
  onOpenLibrary: (filter: LibraryFilterRequest) => void
  onOpenLog: () => void
}
type ScanView = 'all' | 'changes' | 'attention'
const SCAN_VIEWS: ScanView[] = ['all', 'changes', 'attention']

const SCAN_PAGE = 10
const ROW_PAGE = 40
const SEEN_KEY = 'seadex-history-seen'
/** One hidden description shared by every title link, so screen readers hear where a title leads. */
const OPEN_HINT_ID = 'history-open-hint'
const summaryTone: Record<string, string> = {
  regression: 'text-bad',
  upgrade: 'text-accent-bright',
  resolved: 'text-good',
  changed: 'text-ink',
  new: 'text-sky',
  removed: 'text-muted',
}
/** Header totals open the library with the matching filter; "uncovered" is counted with "missing" there. */
const totalFilters: Record<string, LibraryFilterRequest> = {
  upgrade: { status: 'upgrade' },
  best: { status: 'best' },
  missing: { status: 'missing' },
  partial: { status: 'partial' },
}
const outcomeLabel: Record<string, string> = { failed: 'Failed', partial: 'Partial', cancelled: 'Cancelled' }
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const needsAttention = (scan: ScanHistoryEntry) =>
  Boolean(scan.error) ||
  (scan.outcome !== undefined && scan.outcome !== 'success') ||
  Object.keys(scan.source_errors || {}).length > 0
/** A scan worth only one line: it finished cleanly and at most updated release details. */
const isQuiet = (scan: ScanHistoryEntry) =>
  !needsAttention(scan) && scan.changes.every(change => change.type === 'changed')
const triggerLabel = (scan: ScanHistoryEntry) =>
  scan.trigger === 'scheduled'
    ? 'Scheduled'
    : scan.trigger === 'import'
      ? 'Import check'
      : scan.trigger === 'sonarr+radarr'
        ? 'Sonarr + Radarr webhook'
        : scan.trigger === 'sonarr' || scan.trigger === 'radarr'
          ? scan.trigger.replace(/^./, letter => letter.toUpperCase()) + ' webhook'
          : 'Manual'
const durationText = (scan: ScanHistoryEntry) =>
  scan.duration_seconds !== undefined && scan.duration_seconds >= 0.1 ? scan.duration_seconds.toFixed(1) + 's' : null

/** The last scan seen here is a convenience: a browser that blocks storage simply summarizes the latest scan. */
function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}
function saveSeen(id: string): void {
  try {
    localStorage.setItem(SEEN_KEY, id)
  } catch {
    // ignore storage errors
  }
}
/** Filters live after "?" in the page hash, so a filtered view survives a reload and can be bookmarked. */
function readHashFilters(): URLSearchParams {
  const [page, query = ''] = window.location.hash.slice(1).split('?')
  return new URLSearchParams(page === 'history' ? query : '')
}

interface ScanEntry {
  scan: ScanHistoryEntry
  changes: ScanHistoryChange[]
}
type CurrentResult = (change: ScanHistoryChange) => ResultItem | undefined
interface Library {
  /** The library results have loaded, so a missing title is really missing. */
  known: boolean
  currentResult: CurrentResult
  sourceOf: (change: ScanHistoryChange) => string
  onOpenResult: (key: string) => void
}

function SeasonTag({ change }: { change: ScanHistoryChange }) {
  return change.season ? (
    <span title={`Season ${change.season}`}>
      <span aria-hidden="true">S{String(change.season).padStart(2, '0')}</span>
      <span className="sr-only">Season {change.season}</span>
    </span>
  ) : (
    <span>Movie</span>
  )
}

function TitleLink({
  change,
  library,
  className,
}: {
  change: ScanHistoryChange
  library: Library
  className?: string
}) {
  const result = change.type === 'removed' ? undefined : library.currentResult(change)
  if (!result) return <span className={cx('wrap-anywhere text-ink', className)}>{change.title}</span>
  return (
    <button
      type="button"
      className={cx(
        'touch-target min-w-0 cursor-pointer text-left text-accent-bright wrap-anywhere underline-offset-2 hover:underline',
        className,
      )}
      title={'Open ' + change.title + ' in the library'}
      aria-describedby={OPEN_HINT_ID}
      onClick={() => library.onOpenResult(result.key)}
    >
      {change.title}
    </button>
  )
}

function StatusMark({ status, label, strong }: { status: string; label: string; strong: boolean }) {
  const glyph = STATUS_PRESENTATION[historyStatusKind(status) as CardStatus]
  return (
    <span className={cx('inline-flex items-center gap-1', strong && 'font-bold', strong ? glyph?.tone : 'text-muted')}>
      {glyph && <Icon name={glyph.icon} size={13} className={cx('shrink-0', !strong && glyph.tone)} />}
      {label}
    </span>
  )
}

function StatusLine({ change }: { change: ScanHistoryChange }) {
  const status = historyStatus(change)
  if (!status) return null
  if (!status.changed)
    return (
      <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        <StatusMark status={status.to} label={status.toLabel} strong={false} />
        <span aria-hidden="true">·</span>
        <span>unchanged</span>
      </p>
    )
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-[13px]">
      {status.from && status.fromLabel && (
        <>
          <span className="text-muted">{status.fromLabel}</span>
          <span className="text-muted-dim" aria-hidden="true">
            →
          </span>
          <span className="sr-only">to</span>
        </>
      )}
      <StatusMark status={status.to} label={status.toLabel} strong />
    </p>
  )
}

function ChangeRow({ change, library }: { change: ScanHistoryChange; library: Library }) {
  const result = change.type === 'removed' ? undefined : library.currentResult(change)
  const details = historyDetails(change)
  return (
    <li
      data-history-row=""
      className="grid min-w-0 gap-x-6 gap-y-1.5 border-t border-line/70 px-4 py-3 first:border-t-0 lg:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <TitleLink change={change} library={library} className="block py-0.5 text-sm font-semibold" />
        <p className="m-0 flex flex-wrap gap-x-1.5 text-[13px] text-muted">
          <SeasonTag change={change} />
          <span aria-hidden="true">·</span>
          <span>{library.sourceOf(change)}</span>
          {library.known && !result && change.type !== 'removed' && (
            <>
              <span aria-hidden="true">·</span>
              <span>No longer in the library</span>
            </>
          )}
        </p>
      </div>
      <div className="min-w-0 space-y-1 lg:pt-0.5">
        <StatusLine change={change} />
        {details.length > 0 && (
          <ul className="m-0 min-w-0 list-none space-y-0.5 p-0">
            {details.map((detail, index) => (
              <li key={index}>
                <ReleaseChangeLine detail={detail} quiet />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function ChangeGroupRow({ row, library }: { row: Extract<HistoryRow, { kind: 'group' }>; library: Library }) {
  return (
    <li data-history-row="" className="border-t border-line/70 px-4 first:border-t-0">
      <details className="group">
        <summary className="touch-target flex w-fit cursor-pointer list-none items-center gap-1.5 py-2 text-[13px] hover:underline [&::-webkit-details-marker]:hidden">
          <Icon name="chevron-right" size={14} className="shrink-0 text-muted group-open:rotate-90" />
          <strong className="font-bold text-ink">
            {pluralize(row.changes.length, 'title')} {row.type === 'new' ? 'added to' : 'removed from'} your library
          </strong>
        </summary>
        <ul className="m-0 mb-3 grid list-none gap-x-5 gap-y-0.5 p-0 pl-5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          {row.changes.map((change, index) => (
            <li key={change.key + ':' + index} className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              <TitleLink change={change} library={library} className="font-semibold" />
              <span className="text-muted">
                <SeasonTag change={change} />
              </span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  )
}

interface ChangeListProps {
  id: string
  entry: ScanEntry
  rows: HistoryRow[]
  limit: number
  narrowed: boolean
  onMore: () => void
  library: Library
}

/** An expanded scan: its changes in sections by type, each introduced by a heading the summary counts jump to. */
function ChangeList({ id, entry, rows, limit, narrowed, onMore, library }: ChangeListProps) {
  const counts = new Map(summarizeChanges(entry.changes).map(item => [item.type, item.count]))
  const remaining = rows.length - limit
  return (
    <div id={id} className="border-t border-line">
      {narrowed && (
        <p className="m-0 border-b border-line px-4 py-2 text-xs text-muted">
          Showing {entry.changes.length.toLocaleString()} of {entry.scan.changes.length.toLocaleString()} changes that
          match your filters.
        </p>
      )}
      {sectionRows(rows.slice(0, limit)).map(section => (
        <section key={section.type} aria-labelledby={`${id}-${section.type}`}>
          <h4
            id={`${id}-${section.type}`}
            tabIndex={-1}
            className="m-0 flex scroll-mt-24 items-center gap-2.5 px-4 pt-3 pb-1 text-xs font-bold text-muted outline-none after:h-px after:flex-1 after:bg-line focus-visible:text-ink"
          >
            {changeTypeLabel[section.type] || section.type}
            <span className="font-semibold tabular-nums text-muted-dim">{counts.get(section.type) ?? 0}</span>
          </h4>
          <ul className="m-0 list-none p-0">
            {section.rows.map((row, index) =>
              row.kind === 'group' ? (
                <ChangeGroupRow key={'group:' + row.type} row={row} library={library} />
              ) : (
                <ChangeRow key={row.change.key + ':' + index} change={row.change} library={library} />
              ),
            )}
          </ul>
        </section>
      ))}
      {remaining > 0 && (
        <div className="border-t border-line px-4 py-2">
          <button
            type="button"
            className="touch-target cursor-pointer text-[13px] font-bold text-accent-bright hover:underline"
            onClick={onMore}
          >
            {remaining <= ROW_PAGE
              ? `Show ${pluralize(remaining, 'more change')}`
              : `Show ${ROW_PAGE} more · ${remaining.toLocaleString()} remaining`}
          </button>
        </div>
      )}
    </div>
  )
}

interface ScanProblemProps {
  scan: ScanHistoryEntry
  outcome: string | null
  latest: boolean
  scanDisabled: boolean
  onScan: () => void
  onOpenLog: () => void
}

/** Says what a failed, cancelled or partial scan means for the library, and what to do next. */
function ScanProblem({ scan, outcome, latest, scanDisabled, onScan, onOpenLog }: ScanProblemProps) {
  const sourceErrors = Object.entries(scan.source_errors || {})
  const cancelled = outcome === 'cancelled'
  if (!scan.error && !sourceErrors.length && !outcome) return null
  const reported = (message: string) => (
    <p className="m-0 text-xs text-pretty text-muted wrap-anywhere">Reported error: {message}</p>
  )
  return (
    <div className="space-y-2 px-4 pb-3.5 pl-12">
      {outcome === 'failed' && (
        <div className="space-y-0.5">
          <p className="m-0 text-[13px] text-pretty text-ink">
            This scan stopped before it finished. Your library results are unchanged from the previous scan.
          </p>
          {scan.error && reported(scan.error)}
        </div>
      )}
      {cancelled && (
        <div className="space-y-0.5">
          <p className="m-0 text-[13px] text-pretty text-muted">
            This scan was cancelled before it finished. Your library results are unchanged.
          </p>
          {scan.error && scan.error !== 'Cancelled by user' && reported(scan.error)}
        </div>
      )}
      {!outcome && scan.error && reported(scan.error)}
      {sourceErrors.map(([source, message]) => (
        <div key={source} className="space-y-0.5">
          <p className="m-0 text-[13px] text-pretty text-ink">
            <strong className="font-bold text-warn">{source}</strong> could not be reached, so its titles kept their
            previous results and were not checked in this scan.
          </p>
          {reported(message)}
        </div>
      ))}
      {((latest && outcome !== null) || !cancelled) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {latest && (
            <button
              type="button"
              className={cx(buttonBase, 'border-line bg-panel-raised px-3 py-1.5 text-[13px] text-ink')}
              onClick={onScan}
              disabled={scanDisabled}
            >
              <Icon name="refresh" size={15} />
              Scan again
            </button>
          )}
          {!cancelled && (
            <button
              type="button"
              className={cx(buttonBase, 'border-line bg-transparent px-3 py-1.5 text-[13px] text-ink')}
              onClick={onOpenLog}
            >
              <Icon name="logs" size={15} />
              Open server log
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface CardProps {
  entry: ScanEntry
  latest: boolean
  open: boolean
  limit: number
  narrowed: boolean
  onToggle: (open: boolean) => void
  onMore: (all?: boolean) => void
  library: Library
  scanDisabled: boolean
  onScan: () => void
  onOpenLog: () => void
}

function ScanCard({
  entry,
  latest,
  open,
  limit,
  narrowed,
  onToggle,
  onMore,
  library,
  scanDisabled,
  onScan,
  onOpenLog,
}: CardProps) {
  const { scan, changes } = entry
  const id = 'scan-' + useId().replace(/:/g, '')
  const times = scanTimes(scan.run_at)
  const outcome = scan.outcome && scan.outcome !== 'success' ? scan.outcome : null
  const interrupted = outcome === 'failed' || outcome === 'cancelled'
  const expandable = !interrupted && changes.length > 0
  const tone =
    outcome === 'failed'
      ? 'text-bad'
      : outcome === 'partial'
        ? 'text-warn'
        : outcome === 'cancelled'
          ? 'text-muted'
          : 'text-accent-bright'
  const summary = summarizeChanges(scan.changes)
  const meta = [times.age, triggerLabel(scan), durationText(scan)].filter(Boolean).join(' · ')
  const rows = useMemo(() => (open && expandable ? groupChanges(changes) : []), [open, expandable, changes])
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  useEffect(() => {
    if (!jumpTo || !open) return
    const heading = document.getElementById(`${id}-body-${jumpTo}`)
    if (heading) {
      heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
      heading.focus({ preventScroll: true })
      setJumpTo(null)
    } else if (rows.length > limit) onMore(true)
    else setJumpTo(null)
  }, [jumpTo, open, rows, limit, id, onMore])
  const jump = (type: string) => {
    if (!open) onToggle(true)
    setJumpTo(type)
  }
  return (
    <article aria-labelledby={`${id}-title`} className="overflow-hidden rounded-2xl border border-line bg-panel">
      <header className={cx('relative flex items-start gap-3 px-4 py-3.5', expandable && 'hover:bg-panel-raised')}>
        {outcome && <Icon name={outcome === 'cancelled' ? 'ban' : 'alert'} className={cx('mt-0.5 shrink-0', tone)} />}
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm">
            {expandable ? (
              <button
                type="button"
                id={`${id}-title`}
                aria-expanded={open}
                aria-controls={`${id}-body`}
                aria-describedby={`${id}-meta`}
                className="flex cursor-pointer flex-wrap items-baseline gap-x-2 text-left after:absolute after:inset-0 after:content-['']"
                onClick={() => onToggle(!open)}
              >
                <ScanTitle scan={scan} time={times.time} latest={latest} outcome={outcome} tone={tone} />
              </button>
            ) : (
              <span id={`${id}-title`} className="flex flex-wrap items-baseline gap-x-2">
                <ScanTitle scan={scan} time={times.time} latest={latest} outcome={outcome} tone={tone} />
              </span>
            )}
          </h3>
          <p id={`${id}-meta`} className="m-0 mt-0.5 text-[13px] text-muted">
            {meta}
          </p>
          {summary.length > 0 ? (
            <p className="relative z-10 m-0 mt-1 flex w-fit flex-wrap gap-x-5 text-[13px] max-[600px]:gap-x-3">
              {summary.map(item =>
                expandable ? (
                  <button
                    key={item.type}
                    type="button"
                    className="touch-target -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 underline-offset-2 hover:underline"
                    onClick={() => jump(item.type)}
                  >
                    <strong className={cx('font-extrabold tabular-nums', summaryTone[item.type])}>
                      {item.count.toLocaleString()}
                    </strong>
                    <span className="text-muted">{item.label}</span>
                  </button>
                ) : (
                  <span key={item.type}>
                    <strong className={cx('font-extrabold tabular-nums', summaryTone[item.type])}>
                      {item.count.toLocaleString()}
                    </strong>{' '}
                    <span className="text-muted">{item.label}</span>
                  </span>
                ),
              )}
            </p>
          ) : (
            !interrupted && <p className="m-0 mt-1 text-[13px] text-muted">No changes from the previous scan.</p>
          )}
        </div>
        {expandable && (
          <Icon
            name="chevron-down"
            size={18}
            className={cx(
              'pointer-events-none mt-0.5 shrink-0 text-muted transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        )}
      </header>
      <ScanProblem
        scan={scan}
        outcome={outcome}
        latest={latest}
        scanDisabled={scanDisabled}
        onScan={onScan}
        onOpenLog={onOpenLog}
      />
      {open && expandable && (
        <ChangeList
          id={`${id}-body`}
          entry={entry}
          rows={rows}
          limit={limit}
          narrowed={narrowed}
          onMore={() => onMore()}
          library={library}
        />
      )}
    </article>
  )
}

function ScanTitle({
  scan,
  time,
  latest,
  outcome,
  tone,
}: {
  scan: ScanHistoryEntry
  time: string
  latest: boolean
  outcome: string | null
  tone: string
}) {
  return (
    <>
      <time
        className="font-extrabold tabular-nums text-ink"
        title={displayDateTime(scan.run_at)}
        dateTime={scan.run_at.replace(' ', 'T')}
      >
        {time}
      </time>
      {latest && <span className="text-xs font-bold text-accent-bright">Latest scan</span>}
      {outcome && <span className={cx('text-xs font-bold', tone)}>{outcomeLabel[outcome]}</span>}
    </>
  )
}

/** A clean scan that at most updated release details, as one line; a run of them shares one frame. */
function QuietScan({
  entry,
  open,
  limit,
  narrowed,
  onToggle,
  onMore,
  library,
}: Pick<CardProps, 'entry' | 'open' | 'limit' | 'narrowed' | 'onMore' | 'library'> & { onToggle: () => void }) {
  const { scan, changes } = entry
  const id = 'scan-' + useId().replace(/:/g, '')
  const times = scanTimes(scan.run_at)
  const expandable = changes.length > 0
  const rows = useMemo(() => (open && expandable ? groupChanges(changes) : []), [open, expandable, changes])
  const meta = [times.age, triggerLabel(scan), durationText(scan)].filter(Boolean).join(' · ')
  const outcomeText = scan.changes.length ? `${pluralize(scan.changes.length, 'title')} updated` : 'No changes'
  const line = (
    <>
      <time
        className="font-bold tabular-nums text-ink"
        title={displayDateTime(scan.run_at)}
        dateTime={scan.run_at.replace(' ', 'T')}
      >
        {times.time}
      </time>
      <span className="min-w-0 flex-1 truncate text-muted">{meta}</span>
      <span className={cx('shrink-0', expandable ? 'text-ink' : 'text-muted')}>{outcomeText}</span>
    </>
  )
  const frame = 'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px]'
  return (
    <li>
      <article aria-labelledby={`${id}-title`}>
        <h3 className="m-0 text-[13px] font-normal">
          {expandable ? (
            <button
              type="button"
              id={`${id}-title`}
              aria-expanded={open}
              aria-controls={`${id}-body`}
              className={cx(frame, 'touch-target cursor-pointer hover:bg-panel-raised')}
              onClick={onToggle}
            >
              {line}
              <Icon
                name="chevron-down"
                size={16}
                className={cx('shrink-0 text-muted transition-transform duration-150', open && 'rotate-180')}
              />
            </button>
          ) : (
            <span id={`${id}-title`} className={frame}>
              {line}
              <span className="w-4 shrink-0" aria-hidden="true" />
            </span>
          )}
        </h3>
        {open && expandable && (
          <ChangeList
            id={`${id}-body`}
            entry={entry}
            rows={rows}
            limit={limit}
            narrowed={narrowed}
            onMore={() => onMore()}
            library={library}
          />
        )}
      </article>
    </li>
  )
}

interface VisitSummaryProps {
  scans: ScanHistoryEntry[]
  seenId: string | null
  library: Library
  results: ResultItem[]
  onShowType: (type: string) => void
  onShowAttention: () => void
  onOpenLibrary: (filter: LibraryFilterRequest) => void
}

/** The page's answer first: what needs doing since the reader last looked, before the scan-by-scan log. */
function VisitSummary({
  scans,
  seenId,
  library,
  results,
  onShowType,
  onShowAttention,
  onOpenLibrary,
}: VisitSummaryProps) {
  const digest = useMemo(() => visitDigest(scans, seenId), [scans, seenId])
  if (!digest) return null
  // Once the library has loaded, keep only what is still true of it.
  const stillIs = (change: ScanHistoryChange, status: string) =>
    !library.known || library.currentResult(change)?.status === status
  const upgrades = digest.upgrades.filter(change => stillIs(change, 'upgrade'))
  const resolved = digest.resolved.filter(change => stillIs(change, 'best'))
  const failed = digest.attention.filter(scan => scan.outcome === 'failed').length
  const incomplete = digest.attention.length - failed
  const newest = digest.scans[0]
  const oldest = digest.scans[digest.scans.length - 1]
  const when = (scan: ScanHistoryEntry) => {
    const times = scanTimes(scan.run_at)
    return times.dayLabel === 'Today' ? times.time : `${times.dayLabel} ${times.time}`
  }
  const scope =
    digest.scope === 'latest'
      ? `${when(newest)} · ${triggerLabel(newest)}`
      : `${pluralize(digest.scans.length, 'scan')} · ${digest.scans.length > 1 ? `${when(oldest)} to ${when(newest)}` : when(newest)}`
  const titles = (changes: ScanHistoryChange[], type: string) => {
    const shown = changes.slice(0, 4)
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
        {shown.map((change, index) => (
          <span key={change.key + ':' + change.season} className="inline-flex min-w-0 items-center gap-1">
            <TitleLink change={change} library={library} className="font-semibold" />
            <span className="text-muted">
              <SeasonTag change={change} />
              {index < shown.length - 1 || changes.length > shown.length ? ',' : ''}
            </span>
          </span>
        ))}
        {changes.length > shown.length && (
          <button
            type="button"
            className="touch-target cursor-pointer font-semibold text-accent-bright underline-offset-2 hover:underline"
            onClick={() => onShowType(type)}
          >
            and {(changes.length - shown.length).toLocaleString()} more
          </button>
        )}
      </span>
    )
  }
  const calm = !upgrades.length && !resolved.length && !digest.attention.length
  const upgradeCount = results.filter(result => result.status === 'upgrade').length
  return (
    <section
      aria-labelledby="history-digest-title"
      className="mb-6 rounded-2xl border border-line-strong bg-canvas-soft px-5 py-4 max-[600px]:px-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 id="history-digest-title" className="m-0 text-base font-extrabold">
          {digest.scope === 'latest' ? 'In the latest scan' : 'Since your last visit'}
        </h2>
        <p className="m-0 text-[13px] text-muted">{scope}</p>
      </div>
      <ul className="m-0 mt-3 list-none space-y-2.5 p-0 text-[13px]">
        {upgrades.length > 0 && (
          <li className="flex items-start gap-2.5">
            <Icon name="arrow-up" size={16} className="mt-0.5 shrink-0 text-accent-bright" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
                <strong className="font-bold text-ink">
                  {pluralize(upgrades.length, 'title')} now {upgrades.length === 1 ? 'has' : 'have'} an upgrade
                  available
                </strong>
                {upgradeCount > 0 && (
                  <button
                    type="button"
                    className="touch-target cursor-pointer font-semibold text-accent-bright underline-offset-2 hover:underline"
                    onClick={() => onOpenLibrary(totalFilters.upgrade)}
                  >
                    Review upgrades in the library
                  </button>
                )}
              </p>
              {titles(upgrades, 'upgrade')}
            </div>
          </li>
        )}
        {resolved.length > 0 && (
          <li className="flex items-start gap-2.5">
            <Icon name="check" size={16} className="mt-0.5 shrink-0 text-good" />
            <div className="min-w-0 flex-1 space-y-1">
              <strong className="block font-bold text-ink">
                {pluralize(resolved.length, 'title')} now {resolved.length === 1 ? 'has' : 'have'} the best release
              </strong>
              {titles(resolved, 'resolved')}
            </div>
          </li>
        )}
        {digest.attention.length > 0 && (
          <li className="flex items-start gap-2.5">
            <Icon name="alert" size={16} className={cx('mt-0.5 shrink-0', failed ? 'text-bad' : 'text-warn')} />
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="font-bold text-ink">
                {[
                  failed ? `${pluralize(failed, 'scan')} failed` : '',
                  incomplete ? `${pluralize(incomplete, 'scan')} could not check every source` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </strong>
              <button
                type="button"
                className="touch-target cursor-pointer font-semibold text-accent-bright underline-offset-2 hover:underline"
                onClick={onShowAttention}
              >
                Show {digest.attention.length === 1 ? 'it' : 'them'}
              </button>
            </p>
          </li>
        )}
        {calm && (
          <li className="flex items-start gap-2.5 text-muted">
            <Icon name="check" size={16} className="mt-0.5 shrink-0 text-muted" />
            <span>Nothing new needs your attention.</span>
          </li>
        )}
      </ul>
      {digest.other.length > 0 && (
        <p className="m-0 mt-3 text-[13px] text-muted">
          Also {digest.other.map(item => `${item.count.toLocaleString()} ${item.label}`).join(' · ')}
        </p>
      )}
    </section>
  )
}

type Block = { kind: 'card'; entry: ScanEntry } | { kind: 'quiet'; entries: ScanEntry[] }

export default function HistoryTab({
  active,
  results,
  resultsLoading,
  resultsError,
  scanDisabled,
  onScan,
  onOpenResult,
  onOpenLibrary,
  onOpenLog,
}: Props) {
  const initialFilters = useMemo(readHashFilters, [])
  const [scans, setScans] = useState<ScanHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState(() => initialFilters.get('q') || '')
  const [changeType, setChangeType] = useState(() => {
    const type = initialFilters.get('type') || ''
    return type in changeTypeLabel ? type : ''
  })
  const [source, setSource] = useState(() => initialFilters.get('source') || '')
  const [scanView, setScanView] = useState<ScanView>(() => {
    const view = initialFilters.get('scans') as ScanView
    return SCAN_VIEWS.includes(view) ? view : 'all'
  })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({})
  const [scanLimit, setScanLimit] = useState(SCAN_PAGE)
  const [seenId] = useState(readSeen)
  const request = useRef(0)
  const loaded = useRef(false)
  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    setAnnouncement('')
    try {
      const response = await api.getScanHistory()
      if (current === request.current) {
        setScans(response.scans || [])
        setError('')
        // The first load is announced by the page itself; a refresh changes nothing visible but the list.
        if (loaded.current) setAnnouncement('Scan history updated')
        loaded.current = true
      }
    } catch (caught) {
      if (current === request.current)
        setError(caught instanceof Error ? caught.message : 'Could not load scan history')
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (active) void load()
    return () => {
      request.current += 1
    }
  }, [active, load])
  useEffect(() => setScanLimit(SCAN_PAGE), [query, changeType, source, scanView])
  useEffect(() => {
    if (active && scans[0]) saveSeen(scans[0].id)
  }, [active, scans])
  useEffect(() => {
    if (!active) return
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (changeType) params.set('type', changeType)
    if (source) params.set('source', source)
    if (scanView !== 'all') params.set('scans', scanView)
    const search = params.toString()
    const next = '#history' + (search ? '?' + search : '')
    if (window.location.hash !== next) window.history.replaceState(window.history.state, '', next)
  }, [active, query, changeType, source, scanView])

  const resultIndex = useMemo(() => {
    const byKey = new Map<string, ResultItem>()
    const byTitle = new Map<string, ResultItem>()
    const byLibrary = new Map<string, ResultItem>()
    for (const result of results) {
      const identity = JSON.stringify([result.arr, result.title, String(result.season)])
      if (result.library_key) byLibrary.set(JSON.stringify([result.library_key, result.season]), result)
      if (!byKey.has(result.key)) byKey.set(result.key, result)
      if (!byTitle.has(identity)) byTitle.set(identity, result)
    }
    return { byKey, byTitle, byLibrary }
  }, [results])
  // Until the results load, no title can be said to be missing from the library.
  const libraryKnown = !resultsLoading && (results.length > 0 || !resultsError)
  const library = useMemo<Library>(() => {
    const currentResult: CurrentResult = change =>
      resultIndex.byKey.get(change.key) ||
      (change.library_key
        ? resultIndex.byLibrary.get(JSON.stringify([change.library_key, change.season]))
        : undefined) ||
      resultIndex.byTitle.get(JSON.stringify([change.arr, change.title, String(change.season)]))
    return {
      known: libraryKnown,
      currentResult,
      sourceOf: change => {
        const result = currentResult(change)
        return result ? sourceName(result) : change.arr
      },
      onOpenResult,
    }
  }, [resultIndex, libraryKnown, onOpenResult])

  const changeFilterActive = Boolean(query.trim() || changeType || source)
  const filterActive = changeFilterActive || scanView !== 'all'
  const sources = useMemo(
    () =>
      [...new Set(scans.flatMap(scan => scan.changes.map(change => library.sourceOf(change))).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [scans, library],
  )
  const filtered = useMemo<ScanEntry[]>(
    () =>
      scans.flatMap(scan => {
        const changes = changeFilterActive
          ? scan.changes.filter(
              change =>
                matchesHistoryQuery(change, query) &&
                (!changeType || change.type === changeType) &&
                (!source || library.sourceOf(change) === source),
            )
          : scan.changes
        if (changeFilterActive && !changes.length) return []
        if (scanView === 'changes' && !scan.changes.length) return []
        if (scanView === 'attention' && !needsAttention(scan)) return []
        return [{ scan, changes }]
      }),
    [scans, query, changeType, source, scanView, changeFilterActive, library],
  )
  const visible = filtered.slice(0, scanLimit)
  const latestId = scans[0]?.id
  const days = useMemo(() => {
    const groups: Array<{ key: string; label: string; blocks: Block[] }> = []
    for (const entry of visible) {
      const day = scanTimes(entry.scan.run_at)
      let group = groups[groups.length - 1]
      if (!group || group.key !== day.dayKey) {
        group = { key: day.dayKey, label: day.dayLabel, blocks: [] }
        groups.push(group)
      }
      const quiet = !changeFilterActive && entry.scan.id !== latestId && isQuiet(entry.scan)
      const last = group.blocks[group.blocks.length - 1]
      if (!quiet) group.blocks.push({ kind: 'card', entry })
      else if (last?.kind === 'quiet') last.entries.push(entry)
      else group.blocks.push({ kind: 'quiet', entries: [entry] })
    }
    return groups
  }, [visible, changeFilterActive, latestId])
  const totals = useMemo(() => {
    const last = scans.find(
      scan =>
        scan.outcome !== 'failed' &&
        scan.outcome !== 'cancelled' &&
        Object.values(scan.counts || {}).some(count => count > 0),
    )
    if (!last) return []
    const merged = new Map<string, number>()
    for (const [status, count] of Object.entries(last.counts)) {
      const kind = historyStatusKind(status)
      if (count > 0) merged.set(kind, (merged.get(kind) || 0) + count)
    }
    return [...merged].map(([status, count]) => ({ status, count, label: lowerFirst(statusLabel[status] || status) }))
  }, [scans])
  const resetFilters = () => {
    setQuery('')
    setChangeType('')
    setSource('')
    setScanView('all')
  }
  const defaultOpenId = scans.find(
    scan => scan.changes.length > 0 && scan.outcome !== 'failed' && scan.outcome !== 'cancelled',
  )?.id
  const isOpen = (id: string) => opened[id] ?? (changeFilterActive || id === defaultOpenId)
  const expandableIds = visible
    .filter(entry => entry.changes.length > 0 && entry.scan.outcome !== 'failed' && entry.scan.outcome !== 'cancelled')
    .map(entry => entry.scan.id)
  const allOpen = expandableIds.length > 0 && expandableIds.every(isOpen)
  const setAllOpen = (open: boolean) =>
    setOpened(current => ({ ...current, ...Object.fromEntries(expandableIds.map(id => [id, open])) }))
  const showMore = (id: string, all = false) =>
    setRowLimits(current => ({ ...current, [id]: all ? Infinity : (current[id] ?? ROW_PAGE) + ROW_PAGE }))
  const activeFilterCount = [changeType, source, scanView !== 'all' ? scanView : ''].filter(Boolean).length
  const remainingScans = filtered.length - visible.length

  return (
    <section>
      <header className="app-page-header mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Scan history</h1>
          <p className="mt-2 mb-0 text-sm text-pretty text-muted">
            See what changed and open a title to review its current releases.
          </p>
          {totals.length > 0 && (
            <p className="mt-1 mb-0 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted">
              <span>As of the last completed scan:</span>
              {totals.map((total, index) => (
                <span key={total.status} className="inline-flex items-center gap-x-1.5">
                  {totalFilters[total.status] ? (
                    <button
                      type="button"
                      className="touch-target cursor-pointer text-ink underline decoration-line-strong underline-offset-2 hover:text-accent-bright hover:decoration-current"
                      aria-label={`${total.count.toLocaleString()} ${total.label}, show in the library`}
                      onClick={() => onOpenLibrary(totalFilters[total.status])}
                    >
                      {total.count.toLocaleString()} {total.label}
                    </button>
                  ) : (
                    <span>
                      {total.count.toLocaleString()} {total.label}
                    </span>
                  )}
                  {index < totals.length - 1 && <span aria-hidden="true">·</span>}
                </span>
              ))}
            </p>
          )}
        </div>
        <button
          type="button"
          className={cx(buttonBase, 'border-line bg-panel text-ink')}
          onClick={() => void load()}
          disabled={loading}
        >
          <Icon name="refresh" size={16} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <span id={OPEN_HINT_ID} hidden>
        Opens in the library
      </span>
      {!loading && !error && !filterActive && (
        <VisitSummary
          scans={scans}
          seenId={seenId}
          library={library}
          results={results}
          onShowType={type => {
            resetFilters()
            setChangeType(type)
          }}
          onShowAttention={() => {
            resetFilters()
            setScanView('attention')
          }}
          onOpenLibrary={onOpenLibrary}
        />
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 basis-48 flex-1">
          <span className="sr-only">Search history by title or season</span>
          <input
            className={cx(control, 'w-full')}
            type="search"
            placeholder="Search titles or season (S02)"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={cx(buttonBase, 'border-line bg-panel text-ink min-[601px]:hidden')}
          aria-expanded={filtersOpen}
          aria-controls="history-filters"
          onClick={() => setFiltersOpen(open => !open)}
        >
          <Icon name="filter" size={16} />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-accent/20 px-1.5 text-xs font-bold tabular-nums text-ink">
              {activeFilterCount}
            </span>
          )}
        </button>
        <div
          id="history-filters"
          className={cx(
            'w-full flex-wrap items-center gap-3 [&>select]:min-w-0 [&>select]:flex-1 min-[601px]:flex min-[601px]:w-auto min-[601px]:[&>select]:flex-none',
            filtersOpen ? 'flex' : 'hidden',
          )}
        >
          <select
            aria-label="Change type"
            className={cx(control, 'max-w-full cursor-pointer')}
            value={changeType}
            onChange={event => setChangeType(event.target.value)}
          >
            <option value="">All changes</option>
            {Object.entries(changeTypeLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {sources.length > 1 && (
            <select
              aria-label="Source"
              className={cx(control, 'max-w-full cursor-pointer')}
              value={source}
              onChange={event => setSource(event.target.value)}
            >
              <option value="">All sources</option>
              {sources.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Scans shown"
            className={cx(control, 'max-w-full cursor-pointer')}
            value={scanView}
            onChange={event => setScanView(event.target.value as ScanView)}
          >
            <option value="all">All scans</option>
            <option value="changes">Scans with changes</option>
            <option value="attention">Failed or incomplete</option>
          </select>
        </div>
        {(filterActive || expandableIds.length > 1) && (
          <div className="flex flex-wrap items-center gap-1">
            {filterActive && (
              <button
                type="button"
                className="touch-target cursor-pointer rounded-control px-2 text-sm font-semibold text-accent-bright hover:underline"
                onClick={resetFilters}
              >
                Reset filters
              </button>
            )}
            {expandableIds.length > 1 && (
              <button
                type="button"
                className="touch-target cursor-pointer rounded-control px-2 text-sm font-semibold text-muted hover:text-ink hover:underline"
                onClick={() => setAllOpen(!allOpen)}
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm text-bad"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            className="touch-target cursor-pointer font-bold underline"
            onClick={() => void load()}
            disabled={loading}
          >
            Try again
          </button>
        </div>
      )}
      {loading && !scans.length && !error && (
        <div role="status" aria-label="Loading scan history" className="space-y-3">
          {[0, 1, 2].map(index => (
            <div key={index} className="skeleton h-[78px] rounded-2xl border border-line" />
          ))}
        </div>
      )}
      {!loading && !error && !filtered.length && (
        <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
          {scans.length ? (
            <>
              No scans match these filters.{' '}
              <button
                type="button"
                className="touch-target cursor-pointer font-bold text-accent-bright hover:underline"
                onClick={resetFilters}
              >
                Reset filters
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="m-0 text-pretty">
                No scans yet. Each scan records what changed in your library and on SeaDex.
              </p>
              <button
                type="button"
                className={cx(buttonBase, 'border-line bg-panel text-ink')}
                onClick={onScan}
                disabled={scanDisabled}
              >
                <Icon name="refresh" size={16} />
                Scan now
              </button>
            </div>
          )}
        </div>
      )}
      <div className="space-y-6">
        {days.map(day => (
          <section key={day.key} aria-label={day.label}>
            <h2 className="mt-0 mb-2 px-1 text-[13px] font-bold text-muted">{day.label}</h2>
            <div className="space-y-3">
              {day.blocks.map(block =>
                block.kind === 'card' ? (
                  <ScanCard
                    key={block.entry.scan.id}
                    entry={block.entry}
                    latest={block.entry.scan.id === latestId}
                    narrowed={changeFilterActive}
                    open={isOpen(block.entry.scan.id)}
                    limit={rowLimits[block.entry.scan.id] ?? ROW_PAGE}
                    onToggle={open => setOpened(current => ({ ...current, [block.entry.scan.id]: open }))}
                    onMore={all => showMore(block.entry.scan.id, all)}
                    library={library}
                    scanDisabled={scanDisabled}
                    onScan={onScan}
                    onOpenLog={onOpenLog}
                  />
                ) : (
                  <ul
                    key={'quiet:' + block.entries[0].scan.id}
                    className="m-0 list-none divide-y divide-line/70 overflow-hidden rounded-2xl border border-line bg-panel/60 p-0"
                  >
                    {block.entries.map(entry => (
                      <QuietScan
                        key={entry.scan.id}
                        entry={entry}
                        narrowed={false}
                        open={isOpen(entry.scan.id)}
                        limit={rowLimits[entry.scan.id] ?? ROW_PAGE}
                        onToggle={() => setOpened(current => ({ ...current, [entry.scan.id]: !isOpen(entry.scan.id) }))}
                        onMore={all => showMore(entry.scan.id, all)}
                        library={library}
                      />
                    ))}
                  </ul>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
      {remainingScans > 0 && (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            className={cx(buttonBase, 'border-line bg-panel text-ink')}
            onClick={() => setScanLimit(limit => limit + SCAN_PAGE)}
          >
            {remainingScans <= SCAN_PAGE
              ? `Show ${pluralize(remainingScans, 'older scan')}`
              : `Show ${SCAN_PAGE} older scans · ${remainingScans.toLocaleString()} remaining`}
          </button>
        </div>
      )}
    </section>
  )
}
