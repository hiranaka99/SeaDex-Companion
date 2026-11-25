import type { Config, JsonObject } from './types.js'

export const DEFAULT_SCAN_SCHEDULE: Config['scan_schedule'] = {
  enabled: true,
  mode: 'interval',
  interval_minutes: 1440,
  times: ['03:00'],
  weekdays: [0],
  timezone: 'UTC',
  missed_run: 'run_once',
}

/** Validates a submitted or stored schedule; `legacyMinutes` is the single interval older versions saved. */
export function normalizeScanSchedule(value: unknown, legacyMinutes?: number): Config['scan_schedule'] {
  const source = value && typeof value === 'object' ? (value as JsonObject) : {}
  const mode = source.mode === 'daily' || source.mode === 'weekly' ? source.mode : 'interval'
  const requestedEnabled =
    source.enabled === undefined
      ? legacyMinutes === undefined
        ? DEFAULT_SCAN_SCHEDULE.enabled
        : Number(legacyMinutes) > 0
      : source.enabled === true
  const rawInterval = Number(source.interval_minutes ?? legacyMinutes ?? 1440)
  const intervalMinutes = !requestedEnabled && rawInterval === 0 ? DEFAULT_SCAN_SCHEDULE.interval_minutes : rawInterval
  if (
    requestedEnabled &&
    mode === 'interval' &&
    (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 525_600)
  )
    throw new Error('scan_schedule.interval_minutes must be between 5 and 525600')
  const rawTimes = Array.isArray(source.times) ? source.times : ['03:00']
  const times = rawTimes
    .filter((time): time is string => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    .sort()
  if (requestedEnabled && mode !== 'interval' && times.length !== rawTimes.length)
    throw new Error('scan_schedule.times must contain valid HH:MM times')
  if (requestedEnabled && mode !== 'interval' && new Set(times).size !== times.length)
    throw new Error('scan_schedule.times must not contain duplicates')
  const rawWeekdays = Array.isArray(source.weekdays) ? source.weekdays : [0]
  const weekdays = rawWeekdays
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort()
  if (
    requestedEnabled &&
    mode === 'weekly' &&
    (weekdays.length !== rawWeekdays.length || new Set(weekdays).size !== weekdays.length)
  )
    throw new Error('scan_schedule.weekdays must contain unique days from 0 to 6')
  const timezone = typeof source.timezone === 'string' && source.timezone ? source.timezone : 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    if (requestedEnabled && mode !== 'interval') throw new Error('scan_schedule.timezone must be a valid IANA timezone')
  }
  if (requestedEnabled && mode !== 'interval' && !times.length)
    throw new Error('scan_schedule.times must contain at least one HH:MM time')
  if (requestedEnabled && mode === 'weekly' && !weekdays.length)
    throw new Error('scan_schedule.weekdays must contain at least one day')
  return {
    enabled: requestedEnabled,
    mode,
    interval_minutes: intervalMinutes,
    times,
    weekdays,
    timezone,
    missed_run: source.missed_run === 'skip' ? 'skip' : 'run_once',
  }
}
