export interface Schedule {
  enabled: boolean
  mode: 'interval' | 'daily' | 'weekly'
  interval_minutes: number
  times: string[]
  weekdays: number[]
  timezone: string
}

/** Return the first occurrence of a local time; skip nonexistent DST times. */
export function nextScanTime(schedule: Schedule, after: number): number | null {
  if (!schedule.enabled) return null
  if (schedule.mode === 'interval') return after + Math.max(1, schedule.interval_minutes) * 60_000
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const localEpoch = (instant: number) => {
    const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
    return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute))
  }
  const localNow = new Date(localEpoch(after))
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate())
  const times = schedule.times.filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  let next = Infinity
  for (let day = 0; day <= 8; day++) {
    const date = today + day * 86_400_000
    if (schedule.mode === 'weekly' && !schedule.weekdays.includes(new Date(date).getUTCDay())) continue
    // Sample both sides of each local day to cover offset changes and fractional timezones.
    const offsets = new Set<number>()
    for (const hours of [-12, 0, 12, 24, 36]) {
      const sample = date + hours * 3_600_000
      offsets.add(localEpoch(sample) - sample)
    }
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number)
      const target = date + hour * 3_600_000 + minute * 60_000
      const occurrences = [...offsets].map(offset => target - offset).filter(candidate => localEpoch(candidate) === target)
      const first = Math.min(...occurrences)
      if (first > after) next = Math.min(next, first)
    }
  }
  return Number.isFinite(next) ? next : null
}
