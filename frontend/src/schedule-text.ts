import type { ScanSchedule } from './types'

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `1h 30m`-style duration for a whole number of minutes. */
function duration(totalMinutes: number, minuteUnit: string): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!hours) return `${minutes}${minuteUnit}`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

/** When the automatic scan runs, in a few words; null when it is switched off. */
export function describeSchedule(schedule: ScanSchedule | undefined): string | null {
  if (!schedule?.enabled) return null
  if (schedule.mode === 'interval') return `Every ${duration(schedule.interval_minutes, 'm')}`
  const days = schedule.mode === 'daily' ? 'Daily' : schedule.weekdays.map(day => WEEKDAYS[day]).join(', ')
  return `${days} at ${schedule.times.join(', ')} ${schedule.timezone}`
}

/** Time left until the next automatic scan (a Unix time in seconds); null when none is planned. */
export function timeUntilCheck(nextCheck: number | null): string | null {
  if (!nextCheck) return null
  return duration(Math.max(0, Math.round((nextCheck - Date.now() / 1000) / 60)), ' min')
}
