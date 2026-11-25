import {
  DEFAULT_DATETIME_FORMAT,
  formatDateTime,
  isValidDateTimeFormat,
  parseTimestamp,
} from '../../shared/datetime-format.js'

/**
 * App-wide display format for timestamps. Seeded from the saved configuration
 * when it loads and refreshed on every save; components call displayDateTime()
 * instead of formatting raw server strings.
 */
let activeFormat = DEFAULT_DATETIME_FORMAT

export function setDateTimeFormat(format: string | undefined | null): void {
  activeFormat = format && isValidDateTimeFormat(format) ? format : DEFAULT_DATETIME_FORMAT
}

export function currentDateTimeFormat(): string {
  return activeFormat
}

/** Renders stored timestamps in the configured format; non-timestamp text passes through. */
export function displayDateTime(value: string | null | undefined): string {
  const date = parseTimestamp(value)
  return date ? formatDateTime(date, activeFormat) : (value ?? '')
}

/** The configured format without seconds, for timestamps where minute precision is all a person needs. */
export function displayDateTimeMinutes(value: string | null | undefined): string {
  const date = parseTimestamp(value)
  if (!date) return value ?? ''
  const format = activeFormat.replace(/[:.]?s{1,2}/g, '')
  return formatDateTime(date, format || activeFormat)
}

/** "5 min ago", "3 h ago", "2 days ago"; falls back to the configured format beyond a week. */
export function displayTimeAgo(value: string | null | undefined, now = Date.now()): string {
  const date = parseTimestamp(value)
  if (!date) return value ?? ''
  const minutes = Math.round((now - date.getTime()) / 60_000)
  if (minutes < 0) return displayDateTimeMinutes(value)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return displayDateTimeMinutes(value)
}
