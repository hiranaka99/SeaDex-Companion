export type LogFilter = 'all' | 'warn' | 'error'

export interface LogEntry {
  /** Stable across polls even while older entries roll off the top. */
  key: string
  timestamp: string
  /** Upper-case level such as INFO, WARNING or ERROR; empty when the line has none. */
  level: string
  message: string
  /** Lines that belong to the entry, such as stack frames. */
  continuation: string[]
  /** The entry exactly as the server wrote it. */
  raw: string[]
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*(?:\[([A-Za-z]+)\])?\s?(.*)$/

/** Groups raw server lines into entries. Lines without a timestamp continue the previous entry. */
export function parseLogEntries(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = []
  const seen = new Map<string, number>()
  // A stored line may carry its own line breaks (stack traces, CRLF); each one becomes a line of its own.
  for (const line of lines.flatMap(text => text.split(/\r?\n/))) {
    const match = TIMESTAMP.exec(line)
    const previous = entries[entries.length - 1]
    if (!match) {
      if (previous) {
        previous.continuation.push(line)
        previous.raw.push(line)
        continue
      }
      // The window can start mid-entry; keep the orphaned lines readable.
      entries.push({ key: 'orphan', timestamp: '', level: '', message: line, continuation: [], raw: [line] })
      continue
    }
    const occurrence = (seen.get(line) ?? 0) + 1
    seen.set(line, occurrence)
    entries.push({
      key: `${line}#${occurrence}`,
      timestamp: match[1],
      level: (match[2] || '').toUpperCase(),
      message: match[3],
      continuation: [],
      raw: [line],
    })
  }
  return entries
}

export const isWarning = (entry: LogEntry) => entry.level === 'WARNING' || entry.level === 'WARN'
export const isError = (entry: LogEntry) =>
  entry.level === 'ERROR' || entry.level === 'CRITICAL' || entry.level === 'FATAL'

export function entryMatches(entry: LogEntry, filter: LogFilter, search: string): boolean {
  if (filter === 'error' && !isError(entry)) return false
  if (filter === 'warn' && !isWarning(entry) && !isError(entry)) return false
  const needle = search.trim().toLowerCase()
  return !needle || entry.raw.some(line => line.toLowerCase().includes(needle))
}

export function countLevels(entries: LogEntry[]) {
  let errors = 0
  let warnings = 0
  for (const entry of entries) {
    if (isError(entry)) errors++
    else if (isWarning(entry)) warnings++
  }
  return { all: entries.length, errors, warn: warnings + errors }
}

/** How many entries arrived after the one the reader last saw; null when that entry rolled out of the window. */
export function entriesSince(entries: LogEntry[], seenKey: string | null): number | null {
  if (seenKey === null) return 0
  const index = entries.findIndex(entry => entry.key === seenKey)
  return index < 0 ? null : entries.length - 1 - index
}

export function splitMatches(text: string, search: string): Array<{ text: string; match: boolean }> {
  const needle = search.trim().toLowerCase()
  if (!needle || !text) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: Array<{ text: string; match: boolean }> = []
  let cursor = 0
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, cursor)) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false })
    parts.push({ text: text.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}
