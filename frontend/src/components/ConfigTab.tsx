import { useEffect, useState, FormEvent } from 'react'
import { Config } from '../types'
import * as api from '../api'
import { buttonPrimary, cx, panelCard, subtitle, tabHeader } from '../styles'

interface Props {
  config: Config | null
  onSaved: () => void
}

interface FieldProps {
  name: string
  type: string
  label: string
  small?: string
  placeholder?: string
  required?: boolean
  configured?: boolean
  onClear?: () => void
  form: Record<string, any>
  set: (name: string, value: any) => void
}

function Field({ name, type, label, small, placeholder, required, configured, onClear, form, set }: FieldProps) {
  return (
    <label className="mb-3.5 flex flex-col gap-[7px] last:mb-0">
      <span className="text-[13px] font-semibold text-muted">
        {label} {small && <small className="font-medium text-muted-dim">{small}</small>}
      </span>
      <input
        className="w-full rounded-control border border-line bg-canvas-soft px-[13px] py-[11px] text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_rgba(79,140,255,0.15)]"
        type={type}
        name={name}
        placeholder={configured ? '••••••••  (configured)' : placeholder}
        required={required}
        value={form[name] ?? ''}
        onChange={(e) => set(name, e.target.value)}
      />
      {configured && (
        <span className="flex items-center justify-between gap-3 text-xs text-good">
          <span>Configured securely — leave blank to keep the current value.</span>
          <button className="cursor-pointer rounded-md border border-bad/35 bg-bad/10 px-2 py-1 font-semibold text-bad hover:bg-bad/20" type="button" onClick={onClear}>
            Clear
          </button>
        </span>
      )}
    </label>
  )
}

export default function ConfigTab({ config, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, any>>({})
  const [flash, setFlash] = useState(false)
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (config) {
      const f: Record<string, any> = {}
      for (const k of Object.keys(config)) {
        if (k === 'hidden') continue
        f[k] = (config as any)[k]
      }
      setForm(f)
      setClearedSecrets(new Set())
    }
  }, [config])

  const set = (name: string, value: any) => {
    setForm((f) => ({ ...f, [name]: value }))
    if (value && name in secretConfiguredFields) {
      setClearedSecrets((current) => {
        const next = new Set(current)
        next.delete(name)
        return next
      })
    }
  }
  const secretConfiguredFields: Record<string, string> = {
    sonarr_key: 'sonarr_key_configured',
    radarr_key: 'radarr_key_configured',
    qbittorrent_pass: 'qbittorrent_pass_configured',
    webhook: 'webhook_configured',
  }
  const clearSecret = (name: string) => {
    const configuredField = secretConfiguredFields[name]
    setForm((current) => ({ ...current, [name]: '', [configuredField]: false }))
    setClearedSecrets((current) => new Set(current).add(name))
  }
  const sonarrConfigured = Boolean(String(form.sonarr_url || '').trim() || String(form.sonarr_key || '').trim() || form.sonarr_key_configured)
  const radarrConfigured = Boolean(String(form.radarr_url || '').trim() || String(form.radarr_key || '').trim() || form.radarr_key_configured)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const data: Record<string, any> = {}
    for (const k of Object.keys(form)) {
      if (k.endsWith('_configured')) continue
      if (k === 'notify_enabled') data[k] = !!form[k]
      else if (k === 'autocheck_minutes') data[k] = form[k] === '' ? 0 : Number(form[k])
      else data[k] = form[k] || ''
    }
    data.clear_secrets = [...clearedSecrets]
    try {
      await api.saveConfig(data)
      setFlash(true)
      setTimeout(() => setFlash(false), 1800)
      onSaved()
    } catch (err: any) {
      alert('Failed to save config: ' + err.message)
    }
  }

  return (
    <section>
      <header className={tabHeader}>
        <div>
          <h2>Configuration</h2>
          <p className={subtitle}>
            Settings are stored locally; credentials are encrypted at rest
          </p>
        </div>
      </header>

      <form className="flex max-w-[760px] flex-col gap-[18px]" onSubmit={submit}>
        <div className={cx(panelCard, '[&_h3]:mb-4 [&_h3]:text-base [&_h3]:font-extrabold')}>
          <h3>📺 Sonarr</h3>
          <Field name="sonarr_url" type="url" label="Base URL" small="(API path added automatically)" placeholder="https://sonarr.example.com" required={sonarrConfigured} form={form} set={set} />
          <Field name="sonarr_key" type="password" label="API Key" placeholder="Sonarr API key" required={sonarrConfigured && !form.sonarr_key_configured} configured={!!form.sonarr_key_configured} onClear={() => clearSecret('sonarr_key')} form={form} set={set} />
          <Field name="sonarr_category" type="text" label="qBittorrent category" small="(must match Sonarr's download-client category)" placeholder="sonarr-anime" form={form} set={set} />
        </div>

        <div className={cx(panelCard, '[&_h3]:mb-4 [&_h3]:text-base [&_h3]:font-extrabold')}>
          <h3>🎬 Radarr</h3>
          <Field name="radarr_url" type="url" label="Base URL" small="(API path added automatically)" placeholder="https://radarr.example.com" required={radarrConfigured} form={form} set={set} />
          <Field name="radarr_key" type="password" label="API Key" placeholder="Radarr API key" required={radarrConfigured && !form.radarr_key_configured} configured={!!form.radarr_key_configured} onClear={() => clearSecret('radarr_key')} form={form} set={set} />
          <Field name="radarr_category" type="text" label="qBittorrent category" small="(must match Radarr's download-client category)" placeholder="radarr-anime" form={form} set={set} />
        </div>

        <div className={cx(panelCard, '[&_h3]:mb-4 [&_h3]:text-base [&_h3]:font-extrabold')}>
          <h3>⬇️ qBittorrent</h3>
          <Field name="qbittorrent_url" type="url" label="Web API URL" small="(e.g. http://host:8080)" placeholder="http://192.168.1.10:8080" form={form} set={set} />
          <Field name="qbittorrent_user" type="text" label="Username" placeholder="qBittorrent username" form={form} set={set} />
          <Field name="qbittorrent_pass" type="password" label="Password" placeholder="qBittorrent password" configured={!!form.qbittorrent_pass_configured} onClear={() => clearSecret('qbittorrent_pass')} form={form} set={set} />
          <p className="mt-2.5 mb-0 text-[12.5px] text-muted-dim">
            Used by the ⬇ button on each season to send the best release to qBittorrent, under the matching Sonarr/Radarr category (no tags).
            Public releases only (Nyaa / AnimeTosho) — private-tracker releases (AnimeBytes) have no magnet and show a disabled button.
          </p>
        </div>

        <div className={cx(panelCard, '[&_h3]:mb-4 [&_h3]:text-base [&_h3]:font-extrabold')}>
          <h3>📣 Discord</h3>
          <Field name="webhook" type="url" label="Webhook URL" placeholder="https://discord.com/api/webhooks/…" configured={!!form.webhook_configured} onClear={() => clearSecret('webhook')} form={form} set={set} />
          <p className="mt-2.5 mb-0 text-[12.5px] text-muted-dim">New upgrades found after a scan are posted here automatically.</p>
        </div>

        <div className={cx(panelCard, '[&_h3]:mb-4 [&_h3]:text-base [&_h3]:font-extrabold')}>
          <h3>🔔 Notifications</h3>
          <label className="mb-3.5 flex items-center justify-between gap-[7px]">
            <span className="text-[13px] font-semibold text-muted">Enable Discord notifications</span>
            <input className="size-5 shrink-0 cursor-pointer accent-accent" type="checkbox" checked={!!form.notify_enabled} onChange={(e) => set('notify_enabled', e.target.checked)} />
          </label>
          <Field name="autocheck_minutes" type="number" label="Auto-check interval (minutes)" small="(0 = off)" placeholder="60" form={form} set={set} />
          <p className="mt-2.5 mb-0 text-[12.5px] text-muted-dim">
            When enabled, new upgrades found after each scan are posted to Discord automatically.
            Hidden cards only affect the current library view and do not change scan notifications.
          </p>
        </div>

        <div className="flex items-center gap-3.5">
          <button type="submit" className={buttonPrimary}>💾 Save Configuration</button>
          {flash && <span className="text-sm font-bold text-good">✓ Saved</span>}
        </div>
      </form>
    </section>
  )
}
