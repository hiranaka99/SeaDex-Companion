import { useEffect, useState, FormEvent } from 'react'
import { Config } from '../types'
import * as api from '../api'

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
  form: Record<string, any>
  set: (name: string, value: any) => void
}

function Field({ name, type, label, small, placeholder, required, form, set }: FieldProps) {
  return (
    <label className="field">
      <span>
        {label} {small && <small>{small}</small>}
      </span>
      <input
        type={type}
        name={name}
        placeholder={placeholder}
        required={required}
        value={form[name] ?? ''}
        onChange={(e) => set(name, e.target.value)}
      />
    </label>
  )
}

export default function ConfigTab({ config, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, any>>({})
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (config) {
      const f: Record<string, any> = {}
      for (const k of Object.keys(config)) {
        if (k === 'hidden') continue
        f[k] = (config as any)[k]
      }
      setForm(f)
    }
  }, [config])

  const set = (name: string, value: any) => setForm((f) => ({ ...f, [name]: value }))
  const sonarrConfigured = Boolean(String(form.sonarr_url || '').trim() || String(form.sonarr_key || '').trim())
  const radarrConfigured = Boolean(String(form.radarr_url || '').trim() || String(form.radarr_key || '').trim())

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const data: Record<string, any> = {}
    for (const k of Object.keys(form)) {
      if (k === 'notify_enabled') data[k] = !!form[k]
      else if (k === 'autocheck_minutes') data[k] = form[k] === '' ? 0 : Number(form[k])
      else data[k] = form[k] || ''
    }
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
    <section className="tab">
      <header className="tab-header">
        <div>
          <h2>Configuration</h2>
          <p className="subtitle">
            Stored in <code>config.json</code> — used for every scan
          </p>
        </div>
      </header>

      <form className="config-form" onSubmit={submit}>
        <div className="config-card">
          <h3>📺 Sonarr</h3>
          <Field name="sonarr_url" type="url" label="Base URL" small="(with /api/v3, optional)" placeholder="https://sonarr.example.com/api/v3" required={sonarrConfigured} form={form} set={set} />
          <Field name="sonarr_key" type="password" label="API Key" placeholder="Sonarr API key" required={sonarrConfigured} form={form} set={set} />
          <Field name="sonarr_category" type="text" label="qBittorrent category" small="(must match Sonarr's download-client category)" placeholder="sonarr-anime" form={form} set={set} />
        </div>

        <div className="config-card">
          <h3>🎬 Radarr</h3>
          <Field name="radarr_url" type="url" label="Base URL" small="(with /api/v3, optional)" placeholder="https://radarr.example.com/api/v3" required={radarrConfigured} form={form} set={set} />
          <Field name="radarr_key" type="password" label="API Key" placeholder="Radarr API key" required={radarrConfigured} form={form} set={set} />
          <Field name="radarr_category" type="text" label="qBittorrent category" small="(must match Radarr's download-client category)" placeholder="radarr-anime" form={form} set={set} />
        </div>

        <div className="config-card">
          <h3>⬇️ qBittorrent</h3>
          <Field name="qbittorrent_url" type="url" label="Web API URL" small="(e.g. http://host:8080)" placeholder="http://192.168.1.10:8080" form={form} set={set} />
          <Field name="qbittorrent_user" type="text" label="Username" placeholder="qBittorrent username" form={form} set={set} />
          <Field name="qbittorrent_pass" type="password" label="Password" placeholder="qBittorrent password" form={form} set={set} />
          <p className="hint">
            Used by the ⬇ button on each season to send the best release to qBittorrent, under the matching Sonarr/Radarr category (no tags).
            Public releases only (Nyaa / AnimeTosho) — private-tracker releases (AnimeBytes) have no magnet and show a disabled button.
          </p>
        </div>

        <div className="config-card">
          <h3>📣 Discord</h3>
          <Field name="webhook" type="url" label="Webhook URL" placeholder="https://discord.com/api/webhooks/…" form={form} set={set} />
          <p className="hint">New upgrades found after a scan are posted here automatically.</p>
        </div>

        <div className="config-card">
          <h3>🔔 Notifications</h3>
          <label className="field toggle-field">
            <span>Enable Discord notifications</span>
            <input type="checkbox" checked={!!form.notify_enabled} onChange={(e) => set('notify_enabled', e.target.checked)} />
          </label>
          <Field name="autocheck_minutes" type="number" label="Auto-check interval (minutes)" small="(0 = off)" placeholder="60" form={form} set={set} />
          <p className="hint">
            When enabled, new upgrades found after each scan are posted to Discord automatically.
            Hidden cards only affect the current library view and do not change scan notifications.
          </p>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary">💾 Save Configuration</button>
          {flash && <span className="save-flash">✓ Saved</span>}
        </div>
      </form>
    </section>
  )
}
