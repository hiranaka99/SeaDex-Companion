import type { ConfigUpdate, SecretConfigKey } from '../../../shared/contracts'
import type { DownloadMode } from '../../../shared/download-contracts'
import { useEffect, useMemo, useRef, useState, useId, FormEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Config, ScanSchedule, ScannedDataInfo, Status } from '../types'
import * as api from '../api'
import Icon from './Icons'
import BrandLogo, { BrandName } from './BrandLogo'
import ConfirmDialog from './ConfirmDialog'
import { nextScanTime } from '../../../shared/scan-schedule'
import { DEFAULT_DATETIME_FORMAT, formatDateTime, isValidDateTimeFormat, parseTimestamp } from '../../../shared/datetime-format'
import { useToast } from './Toast'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import { displayDateTime } from '../datetime'

interface Props { active: boolean; scanDisabled: boolean; footerTarget: HTMLElement | null; loadError: string; onRetry: () => void; config: Config | null; status: Status; username: string; onRunScan: () => void; onAccountUpdated: (username: string) => void; onSaved: (config: Config) => void; onScannedDataCleared: () => void }
type ConfigDraft = Partial<Omit<Config, 'hidden'>>
type StringField = 'sonarr_url' | 'sonarr_key' | 'radarr_url' | 'radarr_key' | 'sonarr_category' | 'radarr_category' | 'qbittorrent_url' | 'qbittorrent_user' | 'qbittorrent_pass' | 'sabnzbd_url' | 'sabnzbd_key' | 'sabnzbd_sonarr_category' | 'sabnzbd_radarr_category' | 'animetosho_url' | 'amenzb_url' | 'amenzb_key' | 'webhook'
interface FieldProps {
  name: StringField; type: string; label: string; hint?: string; placeholder?: string; required?: boolean
  configured?: boolean; onClear?: () => void; form: ConfigDraft; set: (name: StringField, value: string) => void
}
type Service = 'sonarr' | 'radarr' | 'qbittorrent' | 'sabnzbd' | 'animetosho' | 'amenzb' | 'discord'
type ConnectionState = { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string }
type StatusTone = 'good' | 'bad' | 'busy' | 'muted' | 'dim'
interface ServiceStatus { word: string; tone: StatusTone }
const serviceLabels: Record<Service, string> = { sonarr: 'Sonarr', radarr: 'Radarr', qbittorrent: 'qBittorrent', sabnzbd: 'SABnzbd', animetosho: 'AnimeTosho', amenzb: 'AmeNZB', discord: 'Discord' }
const statusDot: Record<StatusTone, string> = { good: 'bg-good', bad: 'bg-bad', busy: 'animate-pulse bg-accent', muted: 'bg-muted', dim: 'bg-line-strong' }
const statusText: Record<StatusTone, string> = { good: 'text-good', bad: 'text-bad', busy: 'text-accent-bright', muted: 'text-muted', dim: 'text-muted-dim' }
const downloadModes: [DownloadMode, string][] = [['torrent_only', 'Torrents only (qBittorrent)'], ['usenet_only', 'Usenet only (SABnzbd)'], ['choose', 'Choose per release']]
const subheading = 'm-0 text-base font-bold'

function Field({ name, type, label, hint, placeholder, required, configured, onClear, form, set }: FieldProps) {
  const fieldId = useId()
  const hintId = fieldId + '-hint'
  return <div className="flex flex-col gap-1.5">
    <label htmlFor={fieldId} className="text-xs font-semibold text-ink">{label}</label>
    <input id={fieldId} aria-describedby={configured || hint ? hintId : undefined} className={cx(control, 'w-full bg-canvas-soft')} type={type} name={name} placeholder={configured ? '••••••••  Configured' : placeholder} required={required} value={form[name] ?? ''} onChange={(event) => set(name, event.target.value)}/>
    {configured ? <div id={hintId} className="flex items-center justify-between gap-3 text-xs text-muted"><span className="inline-flex items-start gap-1"><Icon name="check" size={12} className="mt-0.5 shrink-0 text-good"/>Stored securely; blank keeps the current value</span>{onClear && <button className="touch-target shrink-0 cursor-pointer rounded-lg px-2 py-1 font-bold text-bad hover:bg-bad/10 hover:underline" type="button" aria-label={`Clear stored ${name.replace(/_/g, ' ')}`} onClick={onClear}>Clear</button>}</div> : hint ? <span id={hintId} className="text-xs text-muted-dim">{hint}</span> : null}
  </div>
}

/** A flat labelled switch. The whole row is the click target, not only the 48x28 track. */
function ToggleRow({ id, label, hint, checked, onChange, className }: { id?: string; label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void; className?: string }) {
  const generatedId = useId()
  const labelId = id ? `${id}-label` : generatedId
  const hintId = labelId + '-hint'
  return <label className={cx('flex min-h-11 cursor-pointer items-center justify-between gap-4', className)}>
    <span className="min-w-0"><span id={labelId} className="block text-sm font-bold">{label}</span>{hint && <span id={hintId} className="mt-1 block text-xs text-muted">{hint}</span>}</span>
    <button type="button" role="switch" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined} aria-checked={checked} className={cx('relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')} onClick={() => onChange(!checked)}><span className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')}/></button>
  </label>
}

/** One service and its state in words as well as colour, so a collapsed section still reports what is wrong. */
function StatusChip({ label, status }: { label: string; status: ServiceStatus }) {
  return <span className="inline-flex items-center gap-1.5 text-xs"><span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', statusDot[status.tone])}/><span className="font-semibold text-ink">{label}</span><span className={statusText[status.tone]}>{status.word}</span></span>
}

/** A collapsible settings group. Its title is a real heading, and it reopens itself when something inside needs attention. */
function Section({ title, summary, attention, expand, detailsRef, children }: { title: string; summary?: ReactNode; attention?: boolean; expand?: boolean; detailsRef?: RefObject<HTMLDetailsElement | null>; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (attention || expand) setOpen(true) }, [attention, expand])
  return <details ref={detailsRef} open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group mt-3">
    <summary className="touch-target flex cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-line bg-panel px-4 py-3 transition-colors hover:border-line-strong hover:bg-panel-raised group-open:border-line-strong group-open:bg-panel-raised [&::-webkit-details-marker]:hidden">
      <h2 className="m-0 text-lg font-extrabold tracking-tight">{title}</h2>
      {summary && <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">{summary}</span>}
      <span aria-hidden="true" className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-canvas-soft text-ink"><Icon name="chevron-down" size={17} className="transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"/></span>
    </summary>
    <div className="space-y-6 px-1 pt-5 pb-3">{children}</div>
  </details>
}

function IntegrationCard({ brand, icon, title, description, configured, disabled, connection, onTest, children }: { brand?: BrandName; icon?: ReactNode; title: string; description: string; configured: boolean; disabled?: boolean; connection: ConnectionState; onTest: () => void; children: ReactNode }) {
  const badge = connection.phase === 'success' ? ['bg-good/10 text-ink border-good/25', connection.message || 'Connected'] : connection.phase === 'error' ? ['bg-bad/10 text-ink border-bad/25', 'Connection failed'] : disabled ? ['bg-panel-raised text-muted border-line', 'Disabled'] : configured ? ['bg-accent/10 text-ink border-accent/25', 'Configured'] : ['bg-panel-raised text-ink border-line', 'Not configured']
  return <section className="flex flex-col rounded-2xl border border-line bg-panel p-5 shadow-[0_10px_28px_rgba(0,0,0,.12)]"><header className="mb-5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 max-[600px]:grid-cols-[auto_minmax(0,1fr)]"><span className="grid size-10 shrink-0 place-items-center text-accent-bright">{brand ? <BrandLogo name={brand} size={22} tile/> : icon}</span><div className="min-w-0 flex-1"><h3 className={subheading}>{title}</h3><p className="mt-1 mb-0 text-xs leading-relaxed text-muted">{description}</p></div><span className={cx('max-w-full rounded-full border max-[600px]:col-start-2 max-[600px]:w-fit px-2.5 py-1 text-xs font-semibold', badge[0])} title={badge[1]}>{badge[1]}</span></header><div className="flex flex-1 flex-col gap-4">{children}</div><div className="mt-5 border-t border-line pt-4"><button type="button" className={cx(buttonBase, 'w-full justify-center border-line bg-canvas-soft text-ink hover:border-line-strong hover:text-white')} onClick={onTest} disabled={connection.phase === 'testing'}>{connection.phase === 'testing' ? <span className="size-3.5 animate-spin rounded-full border-2 border-muted/30 border-t-accent"/> : <Icon name="refresh" size={15}/>} {connection.phase === 'testing' ? 'Testing connection…' : title === 'Discord' ? 'Send test message' : 'Test connection'}</button>{connection.phase === 'error' && <p className="mt-2 mb-0 text-center text-xs text-bad">{connection.message}</p>}</div></section>
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  const inputId = useId()
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast.show(`${label} webhook URL copied`, 'success') }
    catch { toast.show('Could not copy automatically; select the URL and copy it manually', 'error') }
  }
  return <div className="flex flex-wrap items-center gap-2">
    <label htmlFor={inputId} className="w-16 shrink-0 text-xs font-semibold text-ink max-[600px]:w-full">{label}</label>
    <input id={inputId} readOnly value={value} onFocus={(event) => event.currentTarget.select()} className={cx(control, 'min-w-0 flex-1 bg-canvas-soft font-mono text-xs')}/>
    <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} aria-label={`Copy ${label} webhook URL`} onClick={() => void copy()}><Icon name="copy" size={15}/> Copy</button>
  </div>
}

function ConfigSkeleton() {
  return <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">{Array.from({ length: 4 }, (_, index) => <div key={index} className="rounded-2xl border border-line bg-panel p-5"><div className="mb-5 flex gap-3"><div className="skeleton size-10 rounded-xl"/><div className="flex-1 space-y-2"><div className="skeleton h-4 w-1/3 rounded"/><div className="skeleton h-3 w-2/3 rounded"/></div></div><div className="space-y-4"><div className="skeleton h-14 rounded-lg"/><div className="skeleton h-14 rounded-lg"/><div className="skeleton h-10 rounded-lg"/></div></div>)}</div>
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function scheduleErrors(schedule: ScanSchedule): string[] {
  const errors: string[] = []
  if (!schedule.enabled) return errors
  if (schedule.mode === 'interval' && schedule.interval_minutes < 5) errors.push('Interval must be at least 5 minutes')
  if (schedule.mode !== 'interval' && schedule.times.length === 0) errors.push('Add at least one time')
  if (schedule.mode !== 'interval' && new Set(schedule.times).size !== schedule.times.length) errors.push('Scheduled times must be unique')
  if (schedule.mode === 'weekly' && schedule.weekdays.length === 0) errors.push('Select at least one weekday')
  if (schedule.mode !== 'interval') try { new Intl.DateTimeFormat(undefined, { timeZone: schedule.timezone }).format() } catch { errors.push('Enter a valid IANA timezone') }
  return errors
}

function previewNextSchedule(schedule: ScanSchedule): string | null {
  try {
    const next = nextScanTime(schedule, Date.now())
    return next === null ? null : new Date(next).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: schedule.mode === 'interval' ? undefined : schedule.timezone })
  } catch { return null }
}

function ScheduleEditor({ schedule, nextCheck, onChange, onRunNow, disabled }: { schedule: ScanSchedule; nextCheck: number | null; onChange: (changes: Partial<ScanSchedule>) => void; onRunNow: () => void; disabled: boolean }) {
  const errors = scheduleErrors(schedule)
  const nextScan = useMemo(() => scheduleErrors(schedule).length ? null : previewNextSchedule(schedule), [schedule])
  const toggleWeekday = (day: number) => {
    const weekdays = schedule.weekdays.includes(day) ? schedule.weekdays.filter((value) => value !== day) : [...schedule.weekdays, day].sort()
    onChange({ weekdays })
  }
  const updateTime = (index: number, value: string) => onChange({ times: schedule.times.map((time, timeIndex) => timeIndex === index ? value : time) })
  const removeTime = (index: number) => onChange({ times: schedule.times.filter((_time, timeIndex) => timeIndex !== index) })
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className={subheading}>Scheduled scans</h3><p className="mt-1 mb-0 text-xs text-muted">Choose exactly when library scans run</p></div><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')} onClick={onRunNow} disabled={disabled}>Run now</button></div>
    <ToggleRow label="Automatic scans" hint="Manual scans remain available at any time" checked={schedule.enabled} onChange={(enabled) => onChange({ enabled })}/>
    {schedule.enabled && <div className="grid gap-4">
      <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">Schedule</span><select className={cx(control, 'w-full bg-canvas-soft')} value={schedule.mode} onChange={(event) => onChange({ mode: event.target.value as ScanSchedule['mode'], timezone: schedule.mode === 'interval' ? Intl.DateTimeFormat().resolvedOptions().timeZone : schedule.timezone })}><option value="interval">At a regular interval</option><option value="daily">Daily at selected times</option><option value="weekly">On selected weekdays</option></select></label>
      {schedule.mode === 'interval' ? <fieldset className="m-0 min-w-0 border-0 p-0"><legend className="mb-2 p-0 text-xs font-semibold text-ink">Run every</legend><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2"><input className={cx(control, 'no-spinner w-20 bg-canvas-soft')} type="number" min="0" value={Math.floor(schedule.interval_minutes / 60)} onChange={(event) => onChange({ interval_minutes: Number(event.target.value) * 60 + schedule.interval_minutes % 60 })}/><span className="text-xs font-semibold text-ink">hours</span></label><label className="flex items-center gap-2"><input className={cx(control, 'no-spinner w-20 bg-canvas-soft')} type="number" min="0" max="59" value={schedule.interval_minutes % 60} onChange={(event) => onChange({ interval_minutes: Math.floor(schedule.interval_minutes / 60) * 60 + Number(event.target.value) })}/><span className="text-xs font-semibold text-ink">minutes</span></label></div></fieldset> : <>
        <fieldset className="m-0 min-w-0 border-0 p-0"><legend className="mb-2 p-0 text-xs font-semibold text-ink">Run at</legend><div className="space-y-2">{schedule.times.map((time, index) => <div className="flex gap-2" key={`${index}:${time}`}><input aria-label="Scan time" className={cx(control, 'flex-1 bg-canvas-soft')} type="time" value={time} onChange={(event) => updateTime(index, event.target.value)}/>{schedule.times.length > 1 && <button type="button" className={cx(buttonBase, 'border-line px-3 text-muted')} aria-label={`Remove ${time}`} onClick={() => removeTime(index)}><Icon name="close" size={15}/></button>}</div>)}<button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => onChange({ times: [...schedule.times, '12:00'] })}>Add time</button></div></fieldset>
        {schedule.mode === 'weekly' && <fieldset className="m-0 min-w-0 border-0 p-0"><legend className="mb-2 p-0 text-xs font-semibold text-ink">Weekdays</legend><div className="flex flex-wrap gap-2">{WEEKDAYS.map((label, day) => <button key={label} type="button" aria-pressed={schedule.weekdays.includes(day)} className={cx(buttonBase, 'px-3 py-2', schedule.weekdays.includes(day) ? 'border-accent bg-accent/15 text-accent-bright' : 'border-line bg-panel text-ink')} onClick={() => toggleWeekday(day)}>{label}</button>)}</div></fieldset>}
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">Timezone</span><input className={cx(control, 'w-full bg-canvas-soft')} value={schedule.timezone} onChange={(event) => onChange({ timezone: event.target.value })} placeholder="America/New_York"/></label>
      </>}
      <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">If a scan was missed while offline</span><select className={cx(control, 'w-full bg-canvas-soft')} value={schedule.missed_run} onChange={(event) => onChange({ missed_run: event.target.value as ScanSchedule['missed_run'] })}><option value="run_once">Run once after startup</option><option value="skip">Skip it</option></select></label>
      {errors.map((error) => <p key={error} className="m-0 text-xs font-bold text-bad">{error}</p>)}
      {nextScan && <p className="m-0 rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-xs text-accent-bright"><strong>Next scan preview:</strong> {nextScan}</p>}
      {nextCheck && <p className="m-0 text-xs text-muted">Saved schedule: {new Date(nextCheck * 1000).toLocaleString()}</p>}
    </div>}
  </div>
}

export default function ConfigTab({ active, scanDisabled, footerTarget, loadError, onRetry, config, status, username, onRunScan, onAccountUpdated, onSaved, onScannedDataCleared }: Props) {
  const formId = useId()
  const methodId = useId()
  const [form, setForm] = useState<ConfigDraft>({})
  const savedForm = useRef('')
  const [saving, setSaving] = useState(false)
  const [guidedSetup, setGuidedSetup] = useState(false)
  const [librarySource, setLibrarySource] = useState<'sonarr' | 'radarr'>('sonarr')
  const setupInitialized = useRef(false)
  const automationRef = useRef<HTMLDetailsElement>(null)
  const [clearedSecrets, setClearedSecrets] = useState<Set<SecretConfigKey>>(new Set())
  const dirty = Boolean(config && Object.keys(form).length && (JSON.stringify(form) !== savedForm.current || clearedSecrets.size))
  const [pendingClear, setPendingClear] = useState<SecretConfigKey | null>(null)
  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearingData, setClearingData] = useState(false)
  const [scannedData, setScannedData] = useState<ScannedDataInfo | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [account, setAccount] = useState({ username, currentPassword: '', newPassword: '', confirmPassword: '' })
  const [savingAccount, setSavingAccount] = useState(false)
  const [connections, setConnections] = useState<Record<Service, ConnectionState>>({ sonarr: { phase: 'idle' }, radarr: { phase: 'idle' }, qbittorrent: { phase: 'idle' }, sabnzbd: { phase: 'idle' }, animetosho: { phase: 'idle' }, amenzb: { phase: 'idle' }, discord: { phase: 'idle' } })
  const toast = useToast()
  const secretConfiguredFields: Record<SecretConfigKey, 'sonarr_key_configured' | 'radarr_key_configured' | 'qbittorrent_pass_configured' | 'sabnzbd_key_configured' | 'amenzb_key_configured' | 'webhook_configured'> = { sonarr_key: 'sonarr_key_configured', radarr_key: 'radarr_key_configured', qbittorrent_pass: 'qbittorrent_pass_configured', sabnzbd_key: 'sabnzbd_key_configured', amenzb_key: 'amenzb_key_configured', webhook: 'webhook_configured' }
  const testGeneration = useRef<Record<Service, number>>({ sonarr: 0, radarr: 0, qbittorrent: 0, sabnzbd: 0, animetosho: 0, amenzb: 0, discord: 0 })

  useEffect(() => {
    if (!config) return
    if (!setupInitialized.current) {
      setupInitialized.current = true
      setGuidedSetup(!((config.sonarr_url && config.sonarr_key_configured) || (config.radarr_url && config.radarr_key_configured)))
      if (config.radarr_url && !config.sonarr_url) setLibrarySource('radarr')
    }
    const { hidden: _hidden, ...next } = config
    next.scan_schedule = { ...config.scan_schedule, times: [...config.scan_schedule.times], weekdays: [...config.scan_schedule.weekdays] }
    // Hidden-title updates from scans must preserve an unsaved settings draft.
    if (savedForm.current === JSON.stringify(next)) return
    savedForm.current = JSON.stringify(next)
    setForm(next); setClearedSecrets(new Set())
  }, [config])

  useEffect(() => { setAccount((current) => ({ ...current, username })) }, [username])

  useEffect(() => {
    if (!active) return
    const load = () => { void api.getScannedDataInfo().then(setScannedData).catch(() => setScannedData(null)) }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  useEffect(() => { if (!active) { setPendingClear(null); setClearDataOpen(false) } }, [active])

  const set = <K extends keyof ConfigDraft,>(name: K, value: ConfigDraft[K]) => {
    setForm((current) => ({ ...current, [name]: value }))
    const service: Service | undefined = name.startsWith('sonarr') ? 'sonarr' : name.startsWith('radarr') ? 'radarr' : name.startsWith('qbittorrent') ? 'qbittorrent' : name.startsWith('sabnzbd') ? 'sabnzbd' : name.startsWith('animetosho') ? 'animetosho' : name.startsWith('amenzb') ? 'amenzb' : name === 'webhook' ? 'discord' : undefined
    if (service) {
      testGeneration.current[service] += 1
      setConnections((current) => ({ ...current, [service]: { phase: 'idle' } }))
    }
    if (value && name in secretConfiguredFields) setClearedSecrets((current) => { const next = new Set(current); next.delete(name as SecretConfigKey); return next })
  }
  const setSchedule = (changes: Partial<ScanSchedule>) => setForm(current => current.scan_schedule ? { ...current, scan_schedule: { ...current.scan_schedule, ...changes } } : current)
  const clearSecret = (name: SecretConfigKey) => { const configuredField = secretConfiguredFields[name]; set(name, ''); setForm((current) => ({ ...current, [configuredField]: false })); setClearedSecrets((current) => new Set(current).add(name)); setPendingClear(null) }
  const sonarrConfigured = Boolean(String(form.sonarr_url || '').trim() && (String(form.sonarr_key || '').trim() || form.sonarr_key_configured))
  const radarrConfigured = Boolean(String(form.radarr_url || '').trim() && (String(form.radarr_key || '').trim() || form.radarr_key_configured))
  const qbConfigured = Boolean(String(form.qbittorrent_url || '').trim() && String(form.qbittorrent_user || '').trim() && (String(form.qbittorrent_pass || '') || form.qbittorrent_pass_configured))
  const sabConfigured = Boolean(String(form.sabnzbd_url || '').trim() && (String(form.sabnzbd_key || '').trim() || form.sabnzbd_key_configured))
  const animetoshoConfigured = Boolean(form.animetosho_enabled && String(form.animetosho_url || '').trim())
  const amenzbConfigured = Boolean(form.amenzb_enabled && String(form.amenzb_url || '').trim() && (String(form.amenzb_key || '').trim() || form.amenzb_key_configured))
  const discordConfigured = Boolean(String(form.webhook || '').trim() || form.webhook_configured)

  const downloadMode: DownloadMode = form.download_mode ?? 'torrent_only'
  const torrentShown = downloadMode !== 'usenet_only'
  const usenetShown = downloadMode !== 'torrent_only'
  const configuredByService: Record<Service, boolean> = { sonarr: sonarrConfigured, radarr: radarrConfigured, qbittorrent: qbConfigured, sabnzbd: sabConfigured, animetosho: animetoshoConfigured, amenzb: amenzbConfigured, discord: discordConfigured }
  const disabledByService: Partial<Record<Service, boolean>> = { animetosho: !form.animetosho_enabled, amenzb: !form.amenzb_enabled }
  const describe = (service: Service): ServiceStatus => {
    const state = connections[service]
    if (state.phase === 'success') return { word: 'Connected', tone: 'good' }
    if (state.phase === 'error') return { word: 'Failed', tone: 'bad' }
    if (state.phase === 'testing') return { word: 'Testing…', tone: 'busy' }
    if (disabledByService[service]) return { word: 'Disabled', tone: 'dim' }
    return configuredByService[service] ? { word: 'Not tested', tone: 'muted' } : { word: 'Not configured', tone: 'dim' }
  }
  const chip = (service: Service) => <StatusChip key={service} label={serviceLabels[service]} status={describe(service)}/>
  const failed = (services: Service[]) => services.some((service) => connections[service].phase === 'error')
  const shownDownloadServices: Service[] = [...(torrentShown ? ['qbittorrent' as const] : []), ...(usenetShown ? ['sabnzbd' as const, 'animetosho' as const, 'amenzb' as const] : [])]

  const test = async (service: Service, quiet = false): Promise<boolean> => {
    const generation = ++testGeneration.current[service]
    const submitted = { ...form, clear_secrets: [...clearedSecrets] }
    setConnections((current) => ({ ...current, [service]: { phase: 'testing' } }))
    try {
      const result = await api.testConnection(service, submitted)
      if (generation !== testGeneration.current[service]) return false
      setConnections((current) => ({ ...current, [service]: { phase: 'success', message: result.message } }))
      if (!quiet) toast.show(result.message, 'success')
      return true
    } catch (error: unknown) {
      if (generation !== testGeneration.current[service]) return false
      const message = error instanceof Error ? error.message : String(error)
      setConnections((current) => ({ ...current, [service]: { phase: 'error', message } }))
      if (!quiet) toast.show(`${serviceLabels[service]}: ${message}`, 'error')
      return false
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const schedule = form.scan_schedule
    if (!schedule) return
    if (scheduleErrors(schedule).length) { if (automationRef.current) automationRef.current.open = true; toast.show('Fix the automatic scan schedule before saving', 'error'); return }
    setSaving(true)
    const { sonarr_key_configured: _sonarr, radarr_key_configured: _radarr, qbittorrent_pass_configured: _qb, sabnzbd_key_configured: _sab, amenzb_key_configured: _amenzb, webhook_configured: _webhook, ...fields } = form
    const data: ConfigUpdate = { ...fields, clear_secrets: [...clearedSecrets] }
    try { const saved = await api.saveConfig(data); setClearedSecrets(new Set()); onSaved(saved); toast.show('Configuration saved', 'success') }
    catch (error: any) { toast.show('Could not save configuration: ' + error.message, 'error') }
    finally { setSaving(false) }
  }

  const clearData = async () => {
    setClearingData(true)
    try {
      const result = await api.clearScannedData()
      onScannedDataCleared()
      setScannedData({ cache_entries: 0, results: 0, last_run: null, cache_valid: true, results_valid: true })
      toast.show(`Cleared ${result.cleared.results} saved result${result.cleared.results === 1 ? '' : 's'} and ${result.cleared.cacheEntries} cache entr${result.cleared.cacheEntries === 1 ? 'y' : 'ies'}`, 'success')
    } catch (error: any) {
      toast.show('Could not clear scanned data: ' + error.message, 'error')
      throw error
    } finally {
      setClearingData(false)
    }
  }

  // Services the selected download method does not use are left out, so "Test all" matches what the page shows.
  const isRelevant = (service: Service) => service === 'qbittorrent' ? torrentShown : service === 'sabnzbd' || service === 'animetosho' || service === 'amenzb' ? usenetShown : true
  const configuredServices = (Object.keys(configuredByService) as Service[]).filter((service) => configuredByService[service] && isRelevant(service))
  const testAll = async () => {
    if (!configuredServices.length) { toast.show('Configure at least one integration before testing connections', 'info'); return }
    setTestingAll(true)
    const outcomes = await Promise.all(configuredServices.map((service) => test(service, true)))
    const passed = outcomes.filter(Boolean).length
    toast.show(`${passed}/${outcomes.length} configured integration${outcomes.length === 1 ? '' : 's'} connected`, passed === outcomes.length ? 'success' : 'error')
    setTestingAll(false)
  }

  const saveAccount = async () => {
    if (account.username.trim().length < 3) { toast.show('Username must contain at least 3 characters', 'error'); return }
    if (!account.currentPassword) { toast.show('Enter your current password', 'error'); return }
    if (account.newPassword && account.newPassword.length < 10) { toast.show('The new password must contain at least 10 characters', 'error'); return }
    if (account.newPassword !== account.confirmPassword) { toast.show('The new passwords do not match', 'error'); return }
    setSavingAccount(true)
    try {
      const updated = await api.updateAccount(account.username.trim(), account.currentPassword, account.newPassword)
      onAccountUpdated(updated.username || account.username.trim())
      setAccount((current) => ({ ...current, username: updated.username || current.username, currentPassword: '', newPassword: '', confirmPassword: '' }))
      toast.show('Administrator account updated; other sessions were signed out', 'success')
    } catch (error: any) { toast.show('Could not update account: ' + error.message, 'error') }
    finally { setSavingAccount(false) }
  }


  if (!config) return <section><header className="app-page-header mb-6"><h1 className="m-0 text-3xl font-extrabold tracking-tight">Configuration</h1></header>{loadError ? <div role="alert" className="rounded-xl border border-bad/30 bg-bad/8 p-4 text-sm text-bad">Could not load configuration: {loadError}<button type="button" className="ml-3 cursor-pointer font-bold text-accent-bright" onClick={onRetry}>Retry</button></div> : <ConfigSkeleton/>}</section>
  const savedSelectedSource = librarySource === 'sonarr' ? Boolean(config.sonarr_url && config.sonarr_key_configured) : Boolean(config.radarr_url && config.radarr_key_configured)
  const schedule = (form.scan_schedule as ScanSchedule | undefined) ?? config.scan_schedule
  const formatCandidate = form.datetime_format ?? config.datetime_format ?? DEFAULT_DATETIME_FORMAT
  const previewDateTime = formatDateTime(parseTimestamp(status.last_run) ?? new Date(), isValidDateTimeFormat(formatCandidate) ? formatCandidate : DEFAULT_DATETIME_FORMAT)
  const usenetIndexerReady = animetoshoConfigured || amenzbConfigured
  const cacheInvalid = Boolean(scannedData && (!scannedData.cache_valid || !scannedData.results_valid))
  const showSonarr = !guidedSetup || librarySource === 'sonarr'
  const showRadarr = !guidedSetup || librarySource === 'radarr'

  const saveControls = <div className="configuration-save-controls flex flex-wrap items-center justify-between gap-3 max-[600px]:gap-2">
    <p className="relative m-0 text-xs text-muted" role="status"><Icon name="hard-drive" size={15} className="mr-1.5 inline"/>{dirty ? <><span>Unsaved changes</span><span className="max-[600px]:hidden"> · your draft is kept when switching tabs</span></> : <><span className="max-[600px]:sr-only">All configuration changes saved</span><span aria-hidden="true" className="hidden max-[600px]:inline">Saved</span></>}</p>
    <button type="submit" form={formId} className={cx(buttonPrimary, 'justify-center')} disabled={saving || !dirty}>{saving ? <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"/> : <Icon name="check" size={17}/>} {saving ? 'Saving…' : 'Save configuration'}</button>
  </div>

  return <section>
    <header className="app-page-header mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Configuration</h1><p className="mt-2 mb-0 text-sm text-muted">Connect your services. Credentials are encrypted locally and never returned to the browser.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')} onClick={() => void testAll()} disabled={testingAll || configuredServices.length === 0}>{testingAll ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name="refresh" size={15}/>} {testingAll ? 'Testing connections…' : 'Test connections'}</button>
        {!guidedSetup && <button type="button" className={cx(buttonBase, 'border-line bg-panel text-ink')} onClick={() => setGuidedSetup(true)}>Connection checklist</button>}
      </div>
    </header>
    <form id={formId} onSubmit={submit} onInvalidCapture={event => { if (event.target instanceof HTMLElement) { let disclosure = event.target.closest('details'); while (disclosure) { disclosure.open = true; disclosure = disclosure.parentElement?.closest('details') || null } } }}><fieldset disabled={saving} className="configuration-disclosures m-0 min-w-0 border-0 p-0">
      {guidedSetup && <section className="mb-4 rounded-card border border-accent/25 bg-accent/6 p-4" aria-label="Connection checklist">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base font-bold">Connect your library</h2><button type="button" className="touch-target cursor-pointer rounded-lg px-2 text-xs font-semibold text-accent-bright hover:bg-accent/10" onClick={() => setGuidedSetup(false)}>Show all settings</button></div>
        <ol className="m-0 grid list-none gap-2 p-0 text-xs sm:grid-cols-3">
          <li><strong className="block text-ink">1. Connect & test</strong><span className="text-muted">{connections[librarySource].phase === 'success' ? 'Connection tested' : 'Enter a URL and API key, then test'}</span></li>
          <li><strong className="block text-ink">2. Save connection</strong><span className="text-muted">{savedSelectedSource && !dirty ? 'Connection saved' : 'Use Save configuration below'}</span></li>
          <li className="flex flex-wrap items-center justify-between gap-2"><div><strong className="block text-ink">3. Scan library</strong><span className="text-muted">{status.running ? 'Scan in progress' : 'Find your first upgrades'}</span></div><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')} disabled={!savedSelectedSource || dirty || scanDisabled} onClick={() => { onRunScan(); setGuidedSetup(false) }}>Scan library</button></li>
        </ol>
      </section>}
      {guidedSetup && <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Choose library source">{(['sonarr', 'radarr'] as const).map(service => <button key={service} type="button" aria-pressed={librarySource === service} className={cx(buttonBase, librarySource === service ? 'border-accent bg-accent/12 text-ink' : 'border-line bg-panel text-muted')} onClick={() => setLibrarySource(service)}>{service === 'sonarr' ? 'Sonarr · series' : 'Radarr · movies'}</button>)}</div>}

      <section className="pb-3" aria-labelledby={`${formId}-library`}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pb-4"><h2 id={`${formId}-library`} className="m-0 text-lg font-extrabold tracking-tight">Library</h2><span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">{showSonarr && chip('sonarr')}{showRadarr && chip('radarr')}</span></div>
        <div className={cx('grid gap-4', !guidedSetup && 'grid-cols-2 max-[1100px]:grid-cols-1')}>
          {showSonarr && <IntegrationCard brand="sonarr" title="Sonarr" description="Series library and season metadata" configured={sonarrConfigured} connection={connections.sonarr} onTest={() => void test('sonarr')}><Field name="sonarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://sonarr.example.com" required={sonarrConfigured} form={form} set={set}/><Field name="sonarr_key" type="password" label="API key" placeholder="Enter the Sonarr API key" required={sonarrConfigured && !form.sonarr_key_configured} configured={!!form.sonarr_key_configured} onClear={() => setPendingClear('sonarr_key')} form={form} set={set}/><Field name="sonarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Sonarr" placeholder="sonarr-anime" form={form} set={set}/></IntegrationCard>}
          {showRadarr && <IntegrationCard brand="radarr" title="Radarr" description="Movie library and release metadata" configured={radarrConfigured} connection={connections.radarr} onTest={() => void test('radarr')}><Field name="radarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://radarr.example.com" required={radarrConfigured} form={form} set={set}/><Field name="radarr_key" type="password" label="API key" placeholder="Enter the Radarr API key" required={radarrConfigured && !form.radarr_key_configured} configured={!!form.radarr_key_configured} onClear={() => setPendingClear('radarr_key')} form={form} set={set}/><Field name="radarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Radarr" placeholder="radarr-anime" form={form} set={set}/></IntegrationCard>}
        </div>
      </section>

      <Section title="Downloads" attention={failed(shownDownloadServices)} expand={!guidedSetup && (qbConfigured || sabConfigured)} summary={shownDownloadServices.map(chip)}>
        <div>
          <h3 id={methodId} className={subheading}>Download method</h3>
          <p className="mt-1 mb-3 text-xs text-muted">Only the services this method uses are shown below.</p>
          <div role="radiogroup" aria-labelledby={methodId} className="grid gap-2 md:grid-cols-3">{downloadModes.map(([mode, label]) => <label key={mode} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-canvas-soft p-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"><input type="radio" name="download_mode" className="size-4 shrink-0 accent-accent" checked={downloadMode === mode} onChange={() => set('download_mode', mode)}/><span className="font-semibold text-ink">{label}</span></label>)}</div>
          {downloadMode === 'usenet_only' && (!sabConfigured || !usenetIndexerReady) && <p role="status" className="mt-3 mb-0 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/8 p-3 text-xs text-warn"><Icon name="alert" size={14} className="mt-0.5 shrink-0"/><span>Usenet-only mode needs {!sabConfigured && !usenetIndexerReady ? 'a working SABnzbd connection and an enabled indexer (AnimeTosho or AmeNZB)' : !sabConfigured ? 'a working SABnzbd connection' : 'an enabled indexer (AnimeTosho or AmeNZB) to find NZBs'}.</span></p>}
        </div>
        <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
          {torrentShown && <IntegrationCard brand="qbittorrent" title="qBittorrent" description="Sends public torrent releases directly to your client" configured={qbConfigured} connection={connections.qbittorrent} onTest={() => void test('qbittorrent')}><Field name="qbittorrent_url" type="url" label="Web API URL" placeholder="http://192.168.1.10:8080" form={form} set={set}/><Field name="qbittorrent_user" type="text" label="Username" placeholder="qBittorrent username" form={form} set={set}/><Field name="qbittorrent_pass" type="password" label="Password" placeholder="qBittorrent password" configured={!!form.qbittorrent_pass_configured} onClear={() => setPendingClear('qbittorrent_pass')} form={form} set={set}/></IntegrationCard>}
          {usenetShown && <IntegrationCard brand="sabnzbd" title="SABnzbd" description="Usenet downloader, required for Usenet downloads" configured={sabConfigured} connection={connections.sabnzbd} onTest={() => void test('sabnzbd')}><Field name="sabnzbd_url" type="url" label="Server URL" placeholder="http://192.168.1.10:8080" form={form} set={set}/><Field name="sabnzbd_key" type="password" label="API key" placeholder="Enter the SABnzbd API key" configured={!!form.sabnzbd_key_configured} onClear={() => setPendingClear('sabnzbd_key')} form={form} set={set}/><Field name="sabnzbd_sonarr_category" type="text" label="Sonarr category" hint="Must match the category configured in Sonarr" placeholder="sonarr-anime" form={form} set={set}/><Field name="sabnzbd_radarr_category" type="text" label="Radarr category" hint="Must match the category configured in Radarr" placeholder="radarr-anime" form={form} set={set}/></IntegrationCard>}
        </div>
        {usenetShown && <div>
          <h3 className={subheading}>Usenet indexers</h3>
          <p className="mt-1 mb-3 text-xs text-muted">Indexers find the NZBs that SABnzbd downloads. Enable at least one.</p>
          <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
            <IntegrationCard brand="animetosho" title="AnimeTosho" description="Usenet anime index; no API key needed" configured={animetoshoConfigured} disabled={!form.animetosho_enabled} connection={connections.animetosho} onTest={() => void test('animetosho')}>
              <ToggleRow label="Search AnimeTosho for NZBs" checked={!!form.animetosho_enabled} onChange={(checked) => set('animetosho_enabled', checked)}/>
              <details className="text-xs"><summary className="touch-target flex cursor-pointer items-center font-semibold text-muted hover:text-ink">Advanced: feed URL</summary><div className="pt-2"><Field name="animetosho_url" type="url" label="Feed URL" hint="Used for NZB discovery; no key required" placeholder="https://feed.animetosho.net" form={form} set={set}/></div></details>
            </IntegrationCard>
            <IntegrationCard brand="amenzb" title="AmeNZB" description="Hash-linked Usenet index; requires your account API key" configured={amenzbConfigured} disabled={!form.amenzb_enabled} connection={connections.amenzb} onTest={() => void test('amenzb')}>
              <ToggleRow label="Search AmeNZB for NZBs" checked={!!form.amenzb_enabled} onChange={(checked) => set('amenzb_enabled', checked)}/>
              <Field name="amenzb_url" type="url" label="Server URL" placeholder="https://amenzb.moe" form={form} set={set}/>
              <Field name="amenzb_key" type="password" label="API key" hint="Required; find your key on amenzb.moe" placeholder="Enter the AmeNZB API key" configured={!!form.amenzb_key_configured} onClear={() => setPendingClear('amenzb_key')} form={form} set={set}/>
            </IntegrationCard>
          </div>
        </div>}
      </Section>

      <Section title="Notifications" attention={failed(['discord'])} summary={chip('discord')}>
        <IntegrationCard brand="discord" title="Discord" description="Notify a channel when new upgrades are found" configured={discordConfigured} connection={connections.discord} onTest={() => void test('discord')}>
          <ToggleRow label="Discord notifications" hint="Send newly discovered upgrades" checked={!!form.notify_enabled} onChange={(checked) => set('notify_enabled', checked)}/>
          <Field name="webhook" type="url" label="Webhook URL" placeholder="https://discord.com/api/webhooks/…" configured={!!form.webhook_configured} onClear={() => setPendingClear('webhook')} form={form} set={set}/>
          <div className="text-xs leading-relaxed text-muted"><Icon name="bell" size={15} className="mr-2 inline text-accent-bright"/>The test button sends one visible test message to the configured channel.</div>
        </IntegrationCard>
      </Section>

      <Section title="Automation" detailsRef={automationRef}>
        <ScheduleEditor schedule={schedule} nextCheck={status.next_check} onChange={setSchedule} onRunNow={onRunScan} disabled={scanDisabled}/>
        <ToggleRow id="unhide-on-new-best" className="border-t border-line pt-6" label="Unhide anime with new best releases" hint="Automatically restore hidden anime when a scan finds a new best release on SeaDex. Alternative releases do not trigger this." checked={!!form.unhide_on_new_best} onChange={(checked) => set('unhide_on_new_best', checked)}/>
        <div className="border-t border-line pt-6">
          <h3 className={subheading}>Incoming webhooks</h3>
          <p className="mt-1 mb-4 text-xs text-muted">Add these URLs to Sonarr and Radarr to scan right after a new series or movie is added. Scheduled scans still refresh existing titles.</p>
          <div className="space-y-3"><CopyRow label="Sonarr" value={`${location.origin}/api/webhooks/sonarr`}/><CopyRow label="Radarr" value={`${location.origin}/api/webhooks/radarr`}/></div>
          <p className="mt-3 mb-0 text-xs text-muted">Configure HTTP Basic Authentication in Sonarr or Radarr using your SeaDex username and password. New-entry events are grouped for 10 seconds before scanning.</p>
          {status.webhook_scan.queued && <p className="mt-2 mb-0 text-xs text-accent-bright">A {status.webhook_scan.sources.join(' + ')} scan is queued.</p>}
        </div>
      </Section>

      <Section title="General">
        <div>
          <label htmlFor="datetime-format-input" className={cx(subheading, 'block')}>Date &amp; time format</label>
          <p className="mt-1 mb-3 text-xs text-muted">Used for scan times, history, and detected changes. Tokens: <code className="rounded bg-canvas-soft px-1 py-0.5 text-ink">YYYY YY MM M DD D HH H mm m ss s</code>; other characters are kept literally.</p>
          <div className="flex flex-wrap items-center gap-3"><input id="datetime-format-input" className={cx(control, 'w-full max-w-64 bg-canvas-soft font-mono')} type="text" name="datetime_format" placeholder={DEFAULT_DATETIME_FORMAT} value={form.datetime_format ?? ''} onChange={(event) => set('datetime_format', event.target.value)} aria-describedby="datetime-format-preview"/><span id="datetime-format-preview" className="text-xs text-muted" role="status">Preview: <span className="font-semibold text-ink">{previewDateTime}</span></span></div>
          {form.datetime_format && !isValidDateTimeFormat(form.datetime_format) && <p className="mt-2 mb-0 text-xs text-bad">Use only the tokens above with punctuation such as <code className="text-ink">. - / : , space</code> between them.</p>}
        </div>
        <div className="border-t border-line pt-6">
          <h3 className={subheading}>Change password</h3>
          <p className="mt-1 mb-4 text-xs text-muted">Changing the password signs out other sessions and updates the credentials used by Sonarr and Radarr webhooks.</p>
          <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1"><label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">Current password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.currentPassword} autoComplete="current-password" onChange={(event) => setAccount((current) => ({ ...current, currentPassword: event.target.value }))}/></label><label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">New password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.newPassword} autoComplete="new-password" placeholder="At least 10 characters" onChange={(event) => setAccount((current) => ({ ...current, newPassword: event.target.value }))}/></label><label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-ink">Confirm new password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.confirmPassword} autoComplete="new-password" onChange={(event) => setAccount((current) => ({ ...current, confirmPassword: event.target.value }))}/></label></div>
          <div className="mt-4 flex justify-end"><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')} onClick={() => void saveAccount()} disabled={savingAccount || !account.currentPassword || !account.newPassword || !account.confirmPassword}>{savingAccount ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name="check" size={16}/>} {savingAccount ? 'Changing password…' : 'Change password'}</button></div>
        </div>
      </Section>

      <Section title="Maintenance" attention={cacheInvalid} summary={scannedData && (cacheInvalid ? <span className="font-bold text-bad">Invalid cached data detected</span> : <span>{scannedData.results} saved result{scannedData.results === 1 ? '' : 's'}</span>)}>
        <section className="rounded-2xl border border-bad/30 bg-bad/5 p-5"><header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 max-[600px]:grid-cols-[auto_minmax(0,1fr)]"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/10 text-bad"><Icon name="trash" size={19}/></span><div className="min-w-0 flex-1"><h3 className={subheading}>Scanned data</h3><p className="mt-1 mb-0 text-xs text-muted">Clear saved scan results and the AniList lookup cache if cached data becomes stale or corrupted. Configuration and download tracking are preserved.</p>{scannedData && <div className="mt-2 flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.results} saved result{scannedData.results === 1 ? '' : 's'}</span><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.cache_entries} AniList cache entr{scannedData.cache_entries === 1 ? 'y' : 'ies'}</span><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.last_run ? `Last scan ${displayDateTime(scannedData.last_run)}` : 'No completed scan'}</span>{cacheInvalid && <span className="rounded-full border border-bad/35 bg-bad/8 px-2 py-1 font-bold text-bad">Invalid cached data detected</span>}</div>}</div><button type="button" className={cx(buttonBase, 'justify-center border-bad/35 bg-bad/10 text-bad hover:bg-bad/18 max-[600px]:col-span-2')} onClick={() => setClearDataOpen(true)} disabled={clearingData}>{clearingData ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={16}/>} {clearingData ? 'Clearing…' : 'Clear scanned data'}</button></header></section>
      </Section>
    </fieldset></form>{active && (footerTarget ? createPortal(saveControls, footerTarget) : saveControls)}<ConfirmDialog open={pendingClear !== null} title="Clear stored credential?" description="The credential will be removed when you save the configuration. You can enter a replacement before saving." confirmLabel="Clear credential" dangerous onConfirm={() => { if (pendingClear) clearSecret(pendingClear) }} onClose={() => setPendingClear(null)}/><ConfirmDialog open={clearDataOpen} title="Clear scanned data?" description="This removes all saved scan results and AniList cache entries. Your configuration, hidden-title list, notification history, and torrent ownership records will remain. Run a new scan to rebuild the data." confirmLabel="Clear scanned data" dangerous onConfirm={clearData} onClose={() => setClearDataOpen(false)}/></section>
}
