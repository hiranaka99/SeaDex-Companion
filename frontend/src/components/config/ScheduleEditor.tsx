import { useMemo } from 'react'
import { ScanSchedule } from '../../types'
import Icon from '../Icons'
import { nextScanTime } from '../../../../shared/scan-schedule'
import { buttonBase, control, cx } from '../../styles'

import { WEEKDAYS } from '../../schedule-text'
import { ToggleRow, subheading } from './parts'

export function scheduleErrors(schedule: ScanSchedule): string[] {
  const errors: string[] = []
  if (!schedule.enabled) return errors
  if (schedule.mode === 'interval' && schedule.interval_minutes < 5) errors.push('Interval must be at least 5 minutes')
  if (schedule.mode !== 'interval' && schedule.times.length === 0) errors.push('Add at least one time')
  if (schedule.mode !== 'interval' && new Set(schedule.times).size !== schedule.times.length)
    errors.push('Scheduled times must be unique')
  if (schedule.mode === 'weekly' && schedule.weekdays.length === 0) errors.push('Select at least one weekday')
  if (schedule.mode !== 'interval')
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: schedule.timezone }).format()
    } catch {
      errors.push('Enter a valid IANA timezone')
    }
  return errors
}

export function previewNextSchedule(schedule: ScanSchedule): string | null {
  try {
    const next = nextScanTime(schedule, Date.now())
    return next === null
      ? null
      : new Date(next).toLocaleString(undefined, {
          dateStyle: 'full',
          timeStyle: 'short',
          timeZone: schedule.mode === 'interval' ? undefined : schedule.timezone,
        })
  } catch {
    return null
  }
}

export function ScheduleEditor({
  schedule,
  nextCheck,
  onChange,
  onRunNow,
  disabled,
}: {
  schedule: ScanSchedule
  nextCheck: number | null
  onChange: (changes: Partial<ScanSchedule>) => void
  onRunNow: () => void
  disabled: boolean
}) {
  const errors = scheduleErrors(schedule)
  const nextScan = useMemo(() => (scheduleErrors(schedule).length ? null : previewNextSchedule(schedule)), [schedule])
  const toggleWeekday = (day: number) => {
    const weekdays = schedule.weekdays.includes(day)
      ? schedule.weekdays.filter(value => value !== day)
      : [...schedule.weekdays, day].sort()
    onChange({ weekdays })
  }
  const updateTime = (index: number, value: string) =>
    onChange({ times: schedule.times.map((time, timeIndex) => (timeIndex === index ? value : time)) })
  const removeTime = (index: number) =>
    onChange({ times: schedule.times.filter((_time, timeIndex) => timeIndex !== index) })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className={subheading}>Scheduled scans</h3>
          <p className="mt-1 mb-0 text-xs text-muted">Choose exactly when library scans run</p>
        </div>
        <button
          type="button"
          className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')}
          onClick={onRunNow}
          disabled={disabled}
        >
          Run now
        </button>
      </div>
      <ToggleRow
        label="Automatic scans"
        hint="Manual scans remain available at any time"
        checked={schedule.enabled}
        onChange={enabled => onChange({ enabled })}
      />
      {schedule.enabled && (
        <div className="grid gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink">Schedule</span>
            <select
              className={cx(control, 'w-full bg-canvas-soft')}
              value={schedule.mode}
              onChange={event =>
                onChange({
                  mode: event.target.value as ScanSchedule['mode'],
                  timezone:
                    schedule.mode === 'interval' ? Intl.DateTimeFormat().resolvedOptions().timeZone : schedule.timezone,
                })
              }
            >
              <option value="interval">At a regular interval</option>
              <option value="daily">Daily at selected times</option>
              <option value="weekly">On selected weekdays</option>
            </select>
          </label>
          {schedule.mode === 'interval' ? (
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-2 p-0 text-xs font-semibold text-ink">Run every</legend>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2">
                  <input
                    className={cx(control, 'no-spinner w-20 bg-canvas-soft')}
                    type="number"
                    min="0"
                    value={Math.floor(schedule.interval_minutes / 60)}
                    onChange={event =>
                      onChange({ interval_minutes: Number(event.target.value) * 60 + (schedule.interval_minutes % 60) })
                    }
                  />
                  <span className="text-xs font-semibold text-ink">hours</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    className={cx(control, 'no-spinner w-20 bg-canvas-soft')}
                    type="number"
                    min="0"
                    max="59"
                    value={schedule.interval_minutes % 60}
                    onChange={event =>
                      onChange({
                        interval_minutes: Math.floor(schedule.interval_minutes / 60) * 60 + Number(event.target.value),
                      })
                    }
                  />
                  <span className="text-xs font-semibold text-ink">minutes</span>
                </label>
              </div>
            </fieldset>
          ) : (
            <>
              <fieldset className="m-0 min-w-0 border-0 p-0">
                <legend className="mb-2 p-0 text-xs font-semibold text-ink">Run at</legend>
                <div className="space-y-2">
                  {schedule.times.map((time, index) => (
                    <div className="flex gap-2" key={`${index}:${time}`}>
                      <input
                        aria-label="Scan time"
                        className={cx(control, 'flex-1 bg-canvas-soft')}
                        type="time"
                        value={time}
                        onChange={event => updateTime(index, event.target.value)}
                      />
                      {schedule.times.length > 1 && (
                        <button
                          type="button"
                          className={cx(buttonBase, 'border-line px-3 text-muted')}
                          aria-label={`Remove ${time}`}
                          onClick={() => removeTime(index)}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className={cx(buttonBase, 'border-line bg-panel text-ink')}
                    onClick={() => onChange({ times: [...schedule.times, '12:00'] })}
                  >
                    Add time
                  </button>
                </div>
              </fieldset>
              {schedule.mode === 'weekly' && (
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className="mb-2 p-0 text-xs font-semibold text-ink">Weekdays</legend>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((label, day) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={schedule.weekdays.includes(day)}
                        className={cx(
                          buttonBase,
                          'px-3 py-2',
                          schedule.weekdays.includes(day)
                            ? 'border-accent bg-accent/15 text-accent-bright'
                            : 'border-line bg-panel text-ink',
                        )}
                        onClick={() => toggleWeekday(day)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink">Timezone</span>
                <input
                  className={cx(control, 'w-full bg-canvas-soft')}
                  value={schedule.timezone}
                  onChange={event => onChange({ timezone: event.target.value })}
                  placeholder="America/New_York"
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink">If a scan was missed while offline</span>
            <select
              className={cx(control, 'w-full bg-canvas-soft')}
              value={schedule.missed_run}
              onChange={event => onChange({ missed_run: event.target.value as ScanSchedule['missed_run'] })}
            >
              <option value="run_once">Run once after startup</option>
              <option value="skip">Skip it</option>
            </select>
          </label>
          {errors.map(error => (
            <p key={error} className="m-0 text-xs font-bold text-bad">
              {error}
            </p>
          ))}
          {nextScan && (
            <p className="m-0 rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-xs text-accent-bright">
              <strong>Next scan preview:</strong> {nextScan}
            </p>
          )}
          {nextCheck && (
            <p className="m-0 text-xs text-muted">Saved schedule: {new Date(nextCheck * 1000).toLocaleString()}</p>
          )}
        </div>
      )}
    </div>
  )
}
