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
