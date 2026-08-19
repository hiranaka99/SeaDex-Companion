import { useEffect, useState, FormEvent, ReactNode } from 'react'
import { Config } from '../types'
import * as api from '../api'
import Icon from './Icons'
import BrandLogo, { BrandName } from './BrandLogo'
import ConfirmDialog from './ConfirmDialog'
import { useToast } from './Toast'
import { buttonBase, buttonPrimary, control, cx } from '../styles'

interface Props { config: Config | null; onSaved: () => void }
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

export default function ConfigTab({ config, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(new Set())
  const [pendingClear, setPendingClear] = useState<string | null>(null)
  const [connections, setConnections] = useState<Record<Service, ConnectionState>>({ sonarr: { phase: 'idle' }, radarr: { phase: 'idle' }, qbittorrent: { phase: 'idle' }, discord: { phase: 'idle' } })
  const toast = useToast()
  const secretConfiguredFields: Record<string, string> = { sonarr_key: 'sonarr_key_configured', radarr_key: 'radarr_key_configured', qbittorrent_pass: 'qbittorrent_pass_configured', webhook: 'webhook_configured' }

  useEffect(() => {
    if (!config) return
    const next: Record<string, any> = {}
    for (const key of Object.keys(config)) if (key !== 'hidden') next[key] = (config as any)[key]
    setForm(next); setClearedSecrets(new Set())
  }, [config])

  const set = (name: string, value: any) => {
    setForm((current) => ({ ...current, [name]: value }))
    const service: Service | undefined = name.startsWith('sonarr') ? 'sonarr' : name.startsWith('radarr') ? 'radarr' : name.startsWith('qbittorrent') ? 'qbittorrent' : name === 'webhook' ? 'discord' : undefined
    if (service) setConnections((current) => ({ ...current, [service]: { phase: 'idle' } }))
    if (value && name in secretConfiguredFields) setClearedSecrets((current) => { const next = new Set(current); next.delete(name); return next })
  }
  const clearSecret = (name: string) => { const configuredField = secretConfiguredFields[name]; setForm((current) => ({ ...current, [name]: '', [configuredField]: false })); setClearedSecrets((current) => new Set(current).add(name)); setPendingClear(null) }
  const sonarrConfigured = Boolean(String(form.sonarr_url || '').trim() && (String(form.sonarr_key || '').trim() || form.sonarr_key_configured))
  const radarrConfigured = Boolean(String(form.radarr_url || '').trim() && (String(form.radarr_key || '').trim() || form.radarr_key_configured))
  const qbConfigured = Boolean(String(form.qbittorrent_url || '').trim() && String(form.qbittorrent_user || '').trim() && (String(form.qbittorrent_pass || '').trim() || form.qbittorrent_pass_configured))
  const discordConfigured = Boolean(String(form.webhook || '').trim() || form.webhook_configured)

  const test = async (service: Service) => {
    setConnections((current) => ({ ...current, [service]: { phase: 'testing' } }))
    try { const result = await api.testConnection(service, form); setConnections((current) => ({ ...current, [service]: { phase: 'success', message: result.message } })); toast.show(result.message, 'success') }
    catch (error: any) { setConnections((current) => ({ ...current, [service]: { phase: 'error', message: error.message } })); toast.show(`${service === 'qbittorrent' ? 'qBittorrent' : service[0].toUpperCase() + service.slice(1)}: ${error.message}`, 'error') }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    const data: Record<string, any> = {}
    for (const key of Object.keys(form)) { if (key.endsWith('_configured')) continue; if (key === 'notify_enabled') data[key] = !!form[key]; else if (key === 'autocheck_minutes') data[key] = form[key] === '' ? 0 : Number(form[key]); else data[key] = form[key] || '' }
    data.clear_secrets = [...clearedSecrets]
    try { await api.saveConfig(data); setClearedSecrets(new Set()); onSaved(); toast.show('Configuration saved', 'success') }
    catch (error: any) { toast.show('Could not save configuration: ' + error.message, 'error') }
    finally { setSaving(false) }
  }

  if (!config) return <section><header className="mb-6"><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Settings</p><h1 className="m-0 text-3xl font-extrabold tracking-tight">Configuration</h1></header><ConfigSkeleton/></section>

  return <section><header className="mb-6"><p className="mb-1 text-xs font-bold tracking-[.14em] text-accent-bright uppercase">Settings</p><h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Configuration</h1><p className="mt-2 mb-0 text-sm text-muted">Connect your services. Credentials are encrypted locally and never returned to the browser.</p></header><form onSubmit={submit} className="space-y-4"><div className="grid grid-cols-2 items-start gap-4 max-[1100px]:grid-cols-1">
    <IntegrationCard brand="sonarr" title="Sonarr" description="Series library and season metadata" configured={sonarrConfigured} connection={connections.sonarr} onTest={() => void test('sonarr')}><Field name="sonarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://sonarr.example.com" required={sonarrConfigured} form={form} set={set}/><Field name="sonarr_key" type="password" label="API key" placeholder="Enter the Sonarr API key" required={sonarrConfigured && !form.sonarr_key_configured} configured={!!form.sonarr_key_configured} onClear={() => setPendingClear('sonarr_key')} form={form} set={set}/><Field name="sonarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Sonarr" placeholder="sonarr-anime" form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="radarr" title="Radarr" description="Movie library and release metadata" configured={radarrConfigured} connection={connections.radarr} onTest={() => void test('radarr')}><Field name="radarr_url" type="url" label="Server URL" hint="The /api/v3 path is added automatically" placeholder="https://radarr.example.com" required={radarrConfigured} form={form} set={set}/><Field name="radarr_key" type="password" label="API key" placeholder="Enter the Radarr API key" required={radarrConfigured && !form.radarr_key_configured} configured={!!form.radarr_key_configured} onClear={() => setPendingClear('radarr_key')} form={form} set={set}/><Field name="radarr_category" type="text" label="qBittorrent category" hint="Must match the category configured in Radarr" placeholder="radarr-anime" form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="qbittorrent" title="qBittorrent" description="Send public releases directly to your client" configured={qbConfigured} connection={connections.qbittorrent} onTest={() => void test('qbittorrent')}><Field name="qbittorrent_url" type="url" label="Web API URL" placeholder="http://192.168.1.10:8080" form={form} set={set}/><Field name="qbittorrent_user" type="text" label="Username" placeholder="qBittorrent username" form={form} set={set}/><Field name="qbittorrent_pass" type="password" label="Password" placeholder="qBittorrent password" configured={!!form.qbittorrent_pass_configured} onClear={() => setPendingClear('qbittorrent_pass')} form={form} set={set}/></IntegrationCard>
    <IntegrationCard brand="discord" title="Discord" description="Notify a channel when new upgrades are found" configured={discordConfigured} connection={connections.discord} onTest={() => void test('discord')}><Field name="webhook" type="url" label="Webhook URL" placeholder="https://discord.com/api/webhooks/…" configured={!!form.webhook_configured} onClear={() => setPendingClear('webhook')} form={form} set={set}/><div className="rounded-xl border border-line bg-canvas-soft p-3 text-xs leading-relaxed text-muted"><Icon name="bell" size={15} className="mr-2 inline text-accent-bright"/>The test button sends one visible test message to the configured channel.</div></IntegrationCard>
  </div>
  <section className="rounded-2xl border border-line bg-panel p-5"><header className="mb-5 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-canvas-soft text-accent-bright"><Icon name="clock" size={19}/></span><div><h2 className="m-0 text-base font-extrabold">Automation</h2><p className="mt-1 mb-0 text-xs text-muted">Schedule scans and Discord notifications</p></div></header><div className="grid grid-cols-2 items-end gap-5 max-[700px]:grid-cols-1"><label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-canvas-soft p-4"><span><span className="block text-sm font-bold">Discord notifications</span><span className="mt-1 block text-xs text-muted">Send newly discovered upgrades</span></span><button type="button" role="switch" aria-checked={!!form.notify_enabled} className={cx('relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors', form.notify_enabled ? 'bg-accent' : 'bg-line-strong')} onClick={() => set('notify_enabled', !form.notify_enabled)}><span className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform', form.notify_enabled && 'translate-x-5')}/></button></label><Field name="autocheck_minutes" type="number" label="Automatic scan interval (minutes)" hint="Set to 0 to disable automatic scans" placeholder="60" form={form} set={set}/></div></section>
  <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-panel-raised/95 px-4 py-3 shadow-card backdrop-blur-xl"><p className="m-0 text-xs text-muted"><Icon name="hard-drive" size={15} className="mr-1.5 inline"/>Stored in the persistent application data directory</p><button type="submit" className={buttonPrimary} disabled={saving}>{saving ? <span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"/> : <Icon name="check" size={17}/>} {saving ? 'Saving…' : 'Save configuration'}</button></div>
  </form><ConfirmDialog open={pendingClear !== null} title="Clear stored credential?" description="The credential will be removed when you save the configuration. You can enter a replacement before saving." confirmLabel="Clear credential" dangerous onConfirm={() => pendingClear && clearSecret(pendingClear)} onClose={() => setPendingClear(null)}/></section>
}