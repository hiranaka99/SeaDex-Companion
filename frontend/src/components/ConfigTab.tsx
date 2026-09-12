import { useEffect, useRef, useState, FormEvent, ReactNode } from 'react'
import { Config, ScanSchedule, ScannedDataInfo, Status } from '../types'
import * as api from '../api'
import Icon from './Icons'
import BrandLogo, { BrandName } from './BrandLogo'
import ConfirmDialog from './ConfirmDialog'
import { useToast } from './Toast'
import { buttonBase, buttonPrimary, control, cx } from '../styles'

interface Props { config: Config | null; status: Status; username: string; onRunScan: () => void; onAccountUpdated: (username: string) => void; onSaved: () => void; onScannedDataCleared: () => void }
interface FieldProps {
  name: string; type: string; label: string; hint?: string; placeholder?: string; required?: boolean
  configured?: boolean; onClear?: () => void; form: Record<string, any>; set: (name: string, value: any) => void
}
type Service = 'sonarr' | 'radarr' | 'qbittorrent' | 'discord'
type ConnectionState = { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string }

function Field({ name, type, label, hint, placeholder, required, configured, onClear, form, set }: FieldProps) {
  return <label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">{label}</span><input className={cx(control, 'w-full bg-canvas-soft')} type={type} name={name} placeholder={configured ? '••••••••  Configured' : placeholder} required={required} value={form[name] ?? ''} onChange={(event) => set(name, event.target.value)}/>{configured ? <span className="flex items-center justify-between gap-3 text-[11px] text-good"><span className="inline-flex items-center gap-1"><Icon name="check" size={12}/>Stored securely; blank keeps the current value</span>{onClear && <button className="cursor-pointer font-bold text-bad hover:underline" type="button" onClick={onClear}>Clear</button>}</span> : hint ? <span className="text-[11px] text-muted-dim">{hint}</span> : null}</label>
}

function IntegrationCard({ brand, title, description, configured, connection, onTest, children }: { brand: BrandName; title: string; description: string; configured: boolean; connection: ConnectionState; onTest: () => void; children: ReactNode }) {
  const badge = connection.phase === 'success' ? ['bg-good/10 text-good border-good/25', connection.message || 'Connected'] : connection.phase === 'error' ? ['bg-bad/10 text-bad border-bad/25', 'Connection failed'] : configured ? ['bg-accent/10 text-accent-bright border-accent/25', 'Configured'] : ['bg-panel-raised text-muted border-line', 'Not configured']
  return <section className="flex flex-col rounded-2xl border border-line bg-panel p-5 shadow-[0_10px_28px_rgba(0,0,0,.12)]"><header className="mb-5 flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-canvas-soft"><BrandLogo name={brand} size={22}/></span><div className="min-w-0 flex-1"><h2 className="m-0 text-base font-extrabold">{title}</h2><p className="mt-1 mb-0 text-xs leading-relaxed text-muted">{description}</p></div><span className={cx('max-w-36 truncate rounded-full border px-2.5 py-1 text-[10px] font-extrabold', badge[0])} title={badge[1]}>{badge[1]}</span></header><div className="flex flex-1 flex-col gap-4">{children}</div><div className="mt-5 border-t border-line pt-4"><button type="button" className={cx(buttonBase, 'w-full justify-center border-line bg-canvas-soft py-2.5 text-xs text-muted hover:border-line-strong hover:text-ink')} onClick={onTest} disabled={connection.phase === 'testing'}>{connection.phase === 'testing' ? <span className="size-3.5 animate-spin rounded-full border-2 border-muted/30 border-t-accent"/> : <Icon name="refresh" size={15}/>} {connection.phase === 'testing' ? 'Testing connection…' : title === 'Discord' ? 'Send test message' : 'Test connection'}</button>{connection.phase === 'error' && <p className="mt-2 mb-0 text-center text-[11px] text-bad">{connection.message}</p>}</div></section>
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
  if (!schedule.enabled) return null
  if (schedule.mode === 'interval') return new Date(Date.now() + schedule.interval_minutes * 60_000).toLocaleString()
  try {
    const now = Date.now()
    for (let offset = 60_000; offset <= 8 * 86_400_000; offset += 60_000) {
      const candidate = new Date(now + offset)
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(candidate)
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
      const day = WEEKDAYS.indexOf(values.weekday)
      if (schedule.times.includes(`${values.hour}:${values.minute}`) && (schedule.mode === 'daily' || schedule.weekdays.includes(day))) return candidate.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: schedule.timezone })
    }
  } catch { return null }
  return null
}

function ScheduleEditor({ schedule, nextCheck, onChange, onRunNow }: { schedule: ScanSchedule; nextCheck: number | null; onChange: (changes: Partial<ScanSchedule>) => void; onRunNow: () => void }) {
  const errors = scheduleErrors(schedule)
  const nextScan = errors.length ? null : previewNextSchedule(schedule)
  const toggleWeekday = (day: number) => {
    const weekdays = schedule.weekdays.includes(day) ? schedule.weekdays.filter((value) => value !== day) : [...schedule.weekdays, day].sort()
    onChange({ weekdays })
  }
  const updateTime = (index: number, value: string) => onChange({ times: schedule.times.map((time, timeIndex) => timeIndex === index ? value : time) })
  const removeTime = (index: number) => onChange({ times: schedule.times.filter((_time, timeIndex) => timeIndex !== index) })
  return <section className="rounded-2xl border border-line bg-panel p-5"><header className="mb-5 flex flex-wrap items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-canvas-soft text-accent-bright"><Icon name="clock" size={19}/></span><div className="min-w-0 flex-1"><h2 className="m-0 text-base font-extrabold">Automation</h2><p className="mt-1 mb-0 text-xs text-muted">Choose exactly when library scans run</p></div><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')} onClick={onRunNow}>Run now</button></header><div className="space-y-4"><label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-canvas-soft p-4"><span><span className="block text-sm font-bold">Automatic scans</span><span className="mt-1 block text-xs text-muted">Manual scans remain available at any time</span></span><button type="button" role="switch" aria-checked={schedule.enabled} className={cx('relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors', schedule.enabled ? 'bg-accent' : 'bg-line-strong')} onClick={() => onChange({ enabled: !schedule.enabled })}><span className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform', schedule.enabled && 'translate-x-5')}/></button></label>{schedule.enabled && <div className="grid gap-4 rounded-xl border border-line bg-canvas-soft p-4"><label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">Schedule</span><select className={cx(control, 'w-full bg-canvas-soft')} value={schedule.mode} onChange={(event) => onChange({ mode: event.target.value as ScanSchedule['mode'], timezone: schedule.mode === 'interval' ? Intl.DateTimeFormat().resolvedOptions().timeZone : schedule.timezone })}><option value="interval">At a regular interval</option><option value="daily">Daily at selected times</option><option value="weekly">On selected weekdays</option></select></label>{schedule.mode === 'interval' ? <label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">Run every</span><div className="flex items-center gap-2"><input className={cx(control, 'no-spinner w-28 bg-canvas-soft')} type="number" min="0" value={Math.floor(schedule.interval_minutes / 60)} onChange={(event) => onChange({ interval_minutes: Number(event.target.value) * 60 + schedule.interval_minutes % 60 })}/><span className="text-xs font-bold text-muted">hours</span><input className={cx(control, 'no-spinner w-24 bg-canvas-soft')} type="number" min="0" max="59" value={schedule.interval_minutes % 60} onChange={(event) => onChange({ interval_minutes: Math.floor(schedule.interval_minutes / 60) * 60 + Number(event.target.value) })}/><span className="text-xs font-bold text-muted">minutes</span></div></label> : <><fieldset><legend className="mb-2 text-xs font-bold text-muted">Run at</legend><div className="space-y-2">{schedule.times.map((time, index) => <div className="flex gap-2" key={`${index}:${time}`}><input className={cx(control, 'flex-1 bg-canvas-soft')} type="time" value={time} onChange={(event) => updateTime(index, event.target.value)}/>{schedule.times.length > 1 && <button type="button" className={cx(buttonBase, 'border-line px-3 text-muted')} aria-label={`Remove ${time}`} onClick={() => removeTime(index)}><Icon name="close" size={15}/></button>}</div>)}<button type="button" className={cx(buttonBase, 'border-line bg-panel text-muted')} onClick={() => onChange({ times: [...schedule.times, '12:00'] })}>Add time</button></div></fieldset>{schedule.mode === 'weekly' && <fieldset><legend className="mb-2 text-xs font-bold text-muted">Weekdays</legend><div className="flex flex-wrap gap-2">{WEEKDAYS.map((label, day) => <button key={label} type="button" aria-pressed={schedule.weekdays.includes(day)} className={cx(buttonBase, 'px-3 py-2', schedule.weekdays.includes(day) ? 'border-accent bg-accent/15 text-accent-bright' : 'border-line bg-panel text-muted')} onClick={() => toggleWeekday(day)}>{label}</button>)}</div></fieldset>}<label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">Timezone</span><input className={cx(control, 'w-full bg-canvas-soft')} value={schedule.timezone} onChange={(event) => onChange({ timezone: event.target.value })} placeholder="America/New_York"/></label></>}<label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">If a scan was missed while offline</span><select className={cx(control, 'w-full bg-canvas-soft')} value={schedule.missed_run} onChange={(event) => onChange({ missed_run: event.target.value as ScanSchedule['missed_run'] })}><option value="run_once">Run once after startup</option><option value="skip">Skip it</option></select></label>{errors.map((error) => <p key={error} className="m-0 text-xs font-bold text-bad">{error}</p>)}{nextScan && <p className="m-0 rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-xs text-accent-bright"><strong>Next scan preview:</strong> {nextScan}</p>}{nextCheck && <p className="m-0 text-[11px] text-muted">Saved schedule: {new Date(nextCheck * 1000).toLocaleString()}</p>}</div>}</div></section>
}

export default function ConfigTab({ config, status, username, onRunScan, onAccountUpdated, onSaved, onScannedDataCleared }: Props) {
  const [form, setForm] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(new Set())
  const [pendingClear, setPendingClear] = useState<string | null>(null)
  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearingData, setClearingData] = useState(false)
  const [scannedData, setScannedData] = useState<ScannedDataInfo | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [account, setAccount] = useState({ username, currentPassword: '', newPassword: '', confirmPassword: '' })
  const [savingAccount, setSavingAccount] = useState(false)
  const [connections, setConnections] = useState<Record<Service, ConnectionState>>({ sonarr: { phase: 'idle' }, radarr: { phase: 'idle' }, qbittorrent: { phase: 'idle' }, discord: { phase: 'idle' } })
  const toast = useToast()
  const secretConfiguredFields: Record<string, string> = { sonarr_key: 'sonarr_key_configured', radarr_key: 'radarr_key_configured', qbittorrent_pass: 'qbittorrent_pass_configured', webhook: 'webhook_configured' }
  const testGeneration = useRef<Record<Service, number>>({ sonarr: 0, radarr: 0, qbittorrent: 0, discord: 0 })

  useEffect(() => {
    if (!config) return
    const next: Record<string, any> = {}
    for (const key of Object.keys(config)) if (key !== 'hidden') next[key] = (config as any)[key]
    next.scan_schedule = { ...config.scan_schedule, times: [...config.scan_schedule.times], weekdays: [...config.scan_schedule.weekdays] }
    setForm(next); setClearedSecrets(new Set())
  }, [config])

  useEffect(() => { setAccount((current) => ({ ...current, username })) }, [username])

  useEffect(() => {
    const load = () => { void api.getScannedDataInfo().then(setScannedData).catch(() => setScannedData(null)) }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const set = (name: string, value: unknown) => {
    setForm((current) => ({ ...current, [name]: value }))
    const service: Service | undefined = name.startsWith('sonarr') ? 'sonarr' : name.startsWith('radarr') ? 'radarr' : name.startsWith('qbittorrent') ? 'qbittorrent' : name === 'webhook' ? 'discord' : undefined
    if (service) {
      testGeneration.current[service] += 1
      setConnections((current) => ({ ...current, [service]: { phase: 'idle' } }))
    }
    if (value && name in secretConfiguredFields) setClearedSecrets((current) => { const next = new Set(current); next.delete(name); return next })
  }
  const setSchedule = (changes: Partial<ScanSchedule>) => setForm((current) => ({ ...current, scan_schedule: { ...current.scan_schedule, ...changes } }))
  const clearSecret = (name: string) => { const configuredField = secretConfiguredFields[name]; set(name, ''); setForm((current) => ({ ...current, [configuredField]: false })); setClearedSecrets((current) => new Set(current).add(name)); setPendingClear(null) }
  const sonarrConfigured = Boolean(String(form.sonarr_url || '').trim() && (String(form.sonarr_key || '').trim() || form.sonarr_key_configured))
  const radarrConfigured = Boolean(String(form.radarr_url || '').trim() && (String(form.radarr_key || '').trim() || form.radarr_key_configured))
  const qbConfigured = Boolean(String(form.qbittorrent_url || '').trim() && String(form.qbittorrent_user || '').trim() && (String(form.qbittorrent_pass || '').trim() || form.qbittorrent_pass_configured))
  const discordConfigured = Boolean(String(form.webhook || '').trim() || form.webhook_configured)

  const test = async (service: Service, quiet = false): Promise<boolean> => {
    const generation = ++testGeneration.current[service]
    const submitted = { ...form }
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
      if (!quiet) toast.show(`${service === 'qbittorrent' ? 'qBittorrent' : service[0].toUpperCase() + service.slice(1)}: ${message}`, 'error')
      return false
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const schedule = form.scan_schedule as ScanSchedule
    if (scheduleErrors(schedule).length) { toast.show('Fix the automatic scan schedule before saving', 'error'); return }
    setSaving(true)
    const data: Record<string, any> = {}
    for (const key of Object.keys(form)) { if (key.endsWith('_configured')) continue; if (key === 'notify_enabled') data[key] = !!form[key]; else data[key] = form[key] || '' }
    data.clear_secrets = [...clearedSecrets]
    try { await api.saveConfig(data); setClearedSecrets(new Set()); onSaved(); toast.show('Configuration saved', 'success') }
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

  const configuredServices: Service[] = [
    ...(sonarrConfigured ? ['sonarr' as const] : []),
    ...(radarrConfigured ? ['radarr' as const] : []),
    ...(qbConfigured ? ['qbittorrent' as const] : []),
    ...(discordConfigured ? ['discord' as const] : []),
  ]
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


  if (!config) return <section><header className="mb-6"><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Settings</p><h1 className="m-0 text-3xl font-extrabold tracking-tight">Configuration</h1></header><ConfigSkeleton/></section>
  const schedule = (form.scan_schedule as ScanSchedule | undefined) ?? config.scan_schedule


  return <section><header className="mb-6"><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Settings</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Configuration</h1><p className="mt-2 mb-0 text-sm text-muted">Connect your services. Credentials are encrypted locally and never returned to the browser.</p></header><form onSubmit={submit} className="space-y-4"><section className="rounded-2xl border border-line bg-panel p-5"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h2 className="m-0 text-base font-extrabold">Integration health</h2><p className="mt-1 mb-0 text-xs text-muted">Live connection status for configured services</p></div><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')} onClick={() => void testAll()} disabled={testingAll || configuredServices.length === 0}>{testingAll ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name="refresh" size={15}/>} {testingAll ? 'Testing all…' : 'Test all configured'}</button></div><div className="mt-4 grid grid-cols-4 gap-2 max-[900px]:grid-cols-2 max-[500px]:grid-cols-1">{(['sonarr', 'radarr', 'qbittorrent', 'discord'] as Service[]).map((service) => { const configured = service === 'sonarr' ? sonarrConfigured : service === 'radarr' ? radarrConfigured : service === 'qbittorrent' ? qbConfigured : discordConfigured; const state = connections[service]; const label = service === 'qbittorrent' ? 'qBittorrent' : service[0].toUpperCase() + service.slice(1); const tone = state.phase === 'success' ? 'border-good/35 bg-good/8 text-good' : state.phase === 'error' ? 'border-bad/35 bg-bad/8 text-bad' : state.phase === 'testing' ? 'border-accent/35 bg-accent/8 text-accent-bright' : configured ? 'border-line-strong bg-canvas-soft text-muted' : 'border-line bg-canvas-soft text-muted-dim'; return <div key={service} className={cx('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs', tone)}><span className={cx('size-2 rounded-full', state.phase === 'success' ? 'bg-good' : state.phase === 'error' ? 'bg-bad' : state.phase === 'testing' ? 'animate-pulse bg-accent' : configured ? 'bg-muted' : 'bg-line-strong')}/><span className="font-bold">{label}</span><span className="ml-auto truncate text-[10px]">{state.phase === 'success' ? 'Connected' : state.phase === 'error' ? 'Failed' : state.phase === 'testing' ? 'Testing…' : configured ? 'Not tested' : 'Not configured'}</span></div> })}</div></section><div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
    <IntegrationCard brand="sonarr" title="Sonarr" description="Series library and season metadata" configured={sonarrConfigured} connection={connections.sonarr} onTest={() => void test('sonarr')}><Field name="sonarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://sonarr.example.com" required={sonarrConfigured} form={form} set={set}/><Field name="sonarr_key" type="password" label="API key" placeholder="Enter the Sonarr API key" required={sonarrConfigured && !form.sonarr_key_configured} configured={!!form.sonarr_key_configured} onClear={() => setPendingClear('sonarr_key')} form={form} set={set}/><Field name="sonarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Sonarr" placeholder="sonarr-anime" form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="radarr" title="Radarr" description="Movie library and release metadata" configured={radarrConfigured} connection={connections.radarr} onTest={() => void test('radarr')}><Field name="radarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://radarr.example.com" required={radarrConfigured} form={form} set={set}/><Field name="radarr_key" type="password" label="API key" placeholder="Enter the Radarr API key" required={radarrConfigured && !form.radarr_key_configured} configured={!!form.radarr_key_configured} onClear={() => setPendingClear('radarr_key')} form={form} set={set}/><Field name="radarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Radarr" placeholder="radarr-anime" form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="qbittorrent" title="qBittorrent" description="Send public releases directly to your client" configured={qbConfigured} connection={connections.qbittorrent} onTest={() => void test('qbittorrent')}><Field name="qbittorrent_url" type="url" label="Web API URL" placeholder="http://192.168.1.10:8080" form={form} set={set}/><Field name="qbittorrent_user" type="text" label="Username" placeholder="qBittorrent username" form={form} set={set}/><Field name="qbittorrent_pass" type="password" label="Password" placeholder="qBittorrent password" configured={!!form.qbittorrent_pass_configured} onClear={() => setPendingClear('qbittorrent_pass')} form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="discord" title="Discord" description="Notify a channel when new upgrades are found" configured={discordConfigured} connection={connections.discord} onTest={() => void test('discord')}><Field name="webhook" type="url" label="Webhook URL" placeholder="https://discord.com/api/webhooks/…" configured={!!form.webhook_configured} onClear={() => setPendingClear('webhook')} form={form} set={set}/><div className="rounded-xl border border-line bg-canvas-soft p-3 text-xs leading-relaxed text-muted"><Icon name="bell" size={15} className="mr-2 inline text-accent-bright"/>The test button sends one visible test message to the configured channel.</div></IntegrationCard>
  </div>
  <ScheduleEditor schedule={schedule} nextCheck={status.next_check} onChange={setSchedule} onRunNow={onRunScan}/>
  <section className="rounded-2xl border border-line bg-panel p-5"><header className="mb-4 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-canvas-soft text-accent-bright"><Icon name="webhook" size={19}/></span><div><h2 className="m-0 text-base font-extrabold">Library webhooks</h2><p className="mt-1 mb-0 text-xs text-muted">Scan after a new series or movie is added; scheduled scans still refresh existing titles</p></div></header><div className="space-y-3 rounded-xl border border-line bg-canvas-soft p-4 text-xs text-muted"><p className="m-0"><strong className="text-ink">Sonarr URL:</strong> {location.origin}/api/webhooks/sonarr</p><p className="mt-2 mb-0"><strong className="text-ink">Radarr URL:</strong> {location.origin}/api/webhooks/radarr</p><p className="mt-2 mb-0">Configure HTTP Basic Authentication in Sonarr or Radarr using your SeaDex username and password. New-entry events are grouped for 10 seconds before scanning.</p>{status.webhook_scan.queued && <p className="mt-2 mb-0 text-accent-bright">A {status.webhook_scan.sources.join(' + ')} scan is queued.</p>}</div></section>
  <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel p-5"><span><span className="block text-sm font-bold">Discord notifications</span><span className="mt-1 block text-xs text-muted">Send newly discovered upgrades</span></span><button type="button" role="switch" aria-checked={!!form.notify_enabled} className={cx('relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors', form.notify_enabled ? 'bg-accent' : 'bg-line-strong')} onClick={() => set('notify_enabled', !form.notify_enabled)}><span className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform', form.notify_enabled && 'translate-x-5')}/></button></label>
  <section className="rounded-2xl border border-line bg-panel p-5"><header className="mb-5 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-canvas-soft text-accent-bright"><Icon name="user" size={19}/></span><div><h2 className="m-0 text-base font-extrabold">Change password</h2><p className="mt-1 mb-0 text-xs text-muted">Changing the password signs out other sessions and updates the credentials used by Sonarr and Radarr webhooks.</p></div></header><div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1"><label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">Current password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.currentPassword} autoComplete="current-password" onChange={(event) => setAccount((current) => ({ ...current, currentPassword: event.target.value }))}/></label><label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">New password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.newPassword} autoComplete="new-password" placeholder="At least 10 characters" onChange={(event) => setAccount((current) => ({ ...current, newPassword: event.target.value }))}/></label><label className="flex flex-col gap-1.5"><span className="text-xs font-bold text-muted">Confirm new password</span><input className={cx(control, 'w-full bg-canvas-soft')} type="password" value={account.confirmPassword} autoComplete="new-password" onChange={(event) => setAccount((current) => ({ ...current, confirmPassword: event.target.value }))}/></label></div><div className="mt-4 flex justify-end"><button type="button" className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')} onClick={() => void saveAccount()} disabled={savingAccount || !account.currentPassword || !account.newPassword || !account.confirmPassword}>{savingAccount ? <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent"/> : <Icon name="check" size={16}/>} {savingAccount ? 'Changing password…' : 'Change password'}</button></div></section>
  <section className="rounded-2xl border border-line bg-panel p-5"><header className="flex flex-wrap items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/10 text-bad"><Icon name="trash" size={19}/></span><div className="min-w-0 flex-1"><h2 className="m-0 text-base font-extrabold">Scanned data</h2><p className="mt-1 mb-0 text-xs text-muted">Clear saved scan results and the AniList lookup cache if cached data becomes stale or corrupted. Configuration and download tracking are preserved.</p>{scannedData && <div className="mt-2 flex flex-wrap gap-2 text-[11px]"><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.results} saved result{scannedData.results === 1 ? '' : 's'}</span><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.cache_entries} AniList cache entr{scannedData.cache_entries === 1 ? 'y' : 'ies'}</span><span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">{scannedData.last_run ? `Last scan ${scannedData.last_run}` : 'No completed scan'}</span>{(!scannedData.cache_valid || !scannedData.results_valid) && <span className="rounded-full border border-bad/35 bg-bad/8 px-2 py-1 font-bold text-bad">Invalid cached data detected</span>}</div>}</div><button type="button" className={cx(buttonBase, 'border-bad/35 bg-bad/10 text-bad hover:bg-bad/18')} onClick={() => setClearDataOpen(true)} disabled={clearingData}>{clearingData ? <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad"/> : <Icon name="trash" size={16}/>} {clearingData ? 'Clearing…' : 'Clear scanned data'}</button></header></section>
  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"><p className="m-0 text-xs text-muted"><Icon name="hard-drive" size={15} className="mr-1.5 inline"/>Stored in the persistent application data directory</p><button type="submit" className={buttonPrimary} disabled={saving}>{saving ? <span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"/> : <Icon name="check" size={17}/>} {saving ? 'Saving…' : 'Save configuration'}</button></div>
  </form><ConfirmDialog open={pendingClear !== null} title="Clear stored credential?" description="The credential will be removed when you save the configuration. You can enter a replacement before saving." confirmLabel="Clear credential" dangerous onConfirm={() => { if (pendingClear) clearSecret(pendingClear) }} onClose={() => setPendingClear(null)}/><ConfirmDialog open={clearDataOpen} title="Clear scanned data?" description="This removes all saved scan results and AniList cache entries. Your configuration, hidden-title list, notification history, and torrent ownership records will remain. Run a new scan to rebuild the data." confirmLabel="Clear scanned data" dangerous onConfirm={clearData} onClose={() => setClearDataOpen(false)}/></section>
}
