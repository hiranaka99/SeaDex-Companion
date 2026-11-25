/**
 * User-configurable date & time display format.
 *
 * Stored timestamps stay canonical ("YYYY-MM-DD HH:mm:ss" server-local, ISO
 * elsewhere); only rendering is customized. Supported tokens:
 * YYYY YY MM M DD D HH H mm m ss s — any other characters are literal text.
 */

export const DEFAULT_DATETIME_FORMAT = 'YYYY-MM-DD HH:mm:ss'

const TOKEN_PATTERN = /YYYY|MM|DD|HH|mm|ss|YY|Y|M|D|H|m|s/g

export function isValidDateTimeFormat(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string') return false
  const trimmed = pattern.trim()
  if (!trimmed || trimmed.length > 32) return false
  const withoutTokens = trimmed.replace(TOKEN_PATTERN, '')
  return trimmed !== withoutTokens && /^[\s.,:/\-–—_·()[\]]*$/.test(withoutTokens)
}

export function formatDateTime(date: Date, pattern: string): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const parts: Record<string, string> = {
    YYYY: pad(date.getFullYear(), 4),
    YY: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
  }
  return pattern.replace(TOKEN_PATTERN, token => parts[token] ?? token)
}

/**
 * Parses the timestamps the app renders: server-local "YYYY-MM-DD HH:mm:ss"
 * (scan times, history) and ISO 8601 (change detection). Returns null for
 * values that are not timestamps so callers can fall back to raw text.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? new Date(value.replace(' ', 'T')) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
