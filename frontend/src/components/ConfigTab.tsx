import { errorMessage } from '../../../shared/errors.js'
import type { ConfigUpdate, SecretConfigKey } from '../../../shared/contracts'
import type { DownloadMode } from '../../../shared/download-contracts'
import { useEffect, useRef, useState, useId, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Config, ScanSchedule, ScannedDataInfo, Status } from '../types'
import * as api from '../api'
import Icon from './Icons'
import ConfirmDialog from './ConfirmDialog'
import {
  DEFAULT_DATETIME_FORMAT,
  formatDateTime,
  isValidDateTimeFormat,
  parseTimestamp,
} from '../../../shared/datetime-format'
import { useToast } from './Toast'
import { buttonBase, buttonPrimary, control, cx } from '../styles'
import { displayDateTime } from '../datetime'
import {
  downloadModes,
  subheading,
  Field,
  ToggleRow,
  StatusChip,
  Section,
  IntegrationCard,
  CopyRow,
  ConfigSkeleton,
} from './config/parts'
import { ScheduleEditor, scheduleErrors } from './config/ScheduleEditor'
import ChangePasswordForm from './config/ChangePasswordForm'
import { useConnectionTests } from '../useConnectionTests'
import {
  isSecretKey,
  serviceOfField,
  SERVICE_IDS,
  SERVICES,
  withoutSavedFlags,
  type ConfigDraft,
  type Service,
} from '../config-services'

interface Props {
  active: boolean
  scanDisabled: boolean
  footerTarget: HTMLElement | null
  loadError: string
  onRetry: () => void
  config: Config | null
  status: Status
  username: string
  onRunScan: () => void
  onAccountUpdated: (username: string) => void
  onSaved: (config: Config) => void
  onScannedDataCleared: () => void
}
export default function ConfigTab({
  active,
  scanDisabled,
  footerTarget,
  loadError,
  onRetry,
  config,
  status,
  username,
  onRunScan,
  onAccountUpdated,
  onSaved,
  onScannedDataCleared,
}: Props) {
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
  const dirty = Boolean(
    config && Object.keys(form).length && (JSON.stringify(form) !== savedForm.current || clearedSecrets.size),
  )
  const [pendingClear, setPendingClear] = useState<SecretConfigKey | null>(null)
  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearingData, setClearingData] = useState(false)
  const [scannedData, setScannedData] = useState<ScannedDataInfo | null>(null)
  const toast = useToast()
  const tests = useConnectionTests(form, clearedSecrets)
  const { connections, testingAll, test, describe, failed } = tests

  useEffect(() => {
    if (!config) return
    if (!setupInitialized.current) {
      setupInitialized.current = true
      setGuidedSetup(
        !((config.sonarr_url && config.sonarr_key_configured) || (config.radarr_url && config.radarr_key_configured)),
      )
      if (config.radarr_url && !config.sonarr_url) setLibrarySource('radarr')
    }
    const { hidden: _hidden, ...next } = config
    next.scan_schedule = {
      ...config.scan_schedule,
      times: [...config.scan_schedule.times],
      weekdays: [...config.scan_schedule.weekdays],
    }
    // Hidden-title updates from scans must preserve an unsaved settings draft.
    if (savedForm.current === JSON.stringify(next)) return
    savedForm.current = JSON.stringify(next)
    setForm(next)
    setClearedSecrets(new Set())
  }, [config])

  useEffect(() => {
    if (!active) return
    const load = () => {
      void api
        .getScannedDataInfo()
        .then(setScannedData)
        .catch(() => setScannedData(null))
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  useEffect(() => {
    if (!active) {
      setPendingClear(null)
      setClearDataOpen(false)
    }
  }, [active])

  const set = <K extends keyof ConfigDraft>(name: K, value: ConfigDraft[K]) => {
    setForm(current => ({ ...current, [name]: value }))
    const key = String(name)
    const service = serviceOfField(key)
    if (service) tests.invalidate(service)
    // Typing a secret again takes back an earlier request to clear it.
    if (value && isSecretKey(key))
      setClearedSecrets(current => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
  }
  const setSchedule = (changes: Partial<ScanSchedule>) =>
    setForm(current =>
      current.scan_schedule ? { ...current, scan_schedule: { ...current.scan_schedule, ...changes } } : current,
    )
  const clearSecret = (name: SecretConfigKey) => {
    set(name, '')
    setForm(current => ({ ...current, [`${name}_configured`]: false }))
    setClearedSecrets(current => new Set(current).add(name))
    setPendingClear(null)
  }
  const configured = Object.fromEntries(
    SERVICE_IDS.map(service => [service, SERVICES[service].configured(form)]),
  ) as Record<Service, boolean>

  const downloadMode: DownloadMode = form.download_mode ?? 'torrent_only'
  const torrentShown = downloadMode !== 'usenet_only'
  const usenetShown = downloadMode !== 'torrent_only'
  // Services the selected download method does not use are left out, so "Test all" matches what the page shows.
  const isRelevant = (service: Service) => {
    const { protocol } = SERVICES[service]
    return protocol === 'torrent' ? torrentShown : protocol === 'usenet' ? usenetShown : true
  }
  const chip = (service: Service) => (
    <StatusChip key={service} label={SERVICES[service].label} status={describe(service)} />
  )
  const shownDownloadServices = SERVICE_IDS.filter(service => SERVICES[service].protocol && isRelevant(service))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const schedule = form.scan_schedule
    if (!schedule) return
    if (scheduleErrors(schedule).length) {
      if (automationRef.current) automationRef.current.open = true
      toast.show('Fix the automatic scan schedule before saving', 'error')
      return
    }
    setSaving(true)
    const data: ConfigUpdate = { ...withoutSavedFlags(form), clear_secrets: [...clearedSecrets] }
    try {
      const saved = await api.saveConfig(data)
      setClearedSecrets(new Set())
      onSaved(saved)
      toast.show('Configuration saved', 'success')
    } catch (error) {
      toast.show('Could not save configuration: ' + errorMessage(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const clearData = async () => {
    setClearingData(true)
    try {
      const result = await api.clearScannedData()
      onScannedDataCleared()
      setScannedData({ cache_entries: 0, results: 0, last_run: null, cache_valid: true, results_valid: true })
      toast.show(
        `Cleared ${result.cleared.results} saved result${result.cleared.results === 1 ? '' : 's'} and ${result.cleared.cacheEntries} cache entr${result.cleared.cacheEntries === 1 ? 'y' : 'ies'}`,
        'success',
      )
    } catch (error) {
      toast.show('Could not clear scanned data: ' + errorMessage(error), 'error')
      throw error
    } finally {
      setClearingData(false)
    }
  }

  const configuredServices = SERVICE_IDS.filter(service => configured[service] && isRelevant(service))
  const testAll = () => tests.testAll(configuredServices)

  if (!config)
    return (
      <section>
        <header className="app-page-header mb-6">
          <h1 className="m-0 text-3xl font-extrabold tracking-tight">Configuration</h1>
        </header>
        {loadError ? (
          <div role="alert" className="rounded-xl border border-bad/30 bg-bad/8 p-4 text-sm text-bad">
            Could not load configuration: {loadError}
            <button type="button" className="ml-3 cursor-pointer font-bold text-accent-bright" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : (
          <ConfigSkeleton />
        )}
      </section>
    )
  const savedSelectedSource =
    librarySource === 'sonarr'
      ? Boolean(config.sonarr_url && config.sonarr_key_configured)
      : Boolean(config.radarr_url && config.radarr_key_configured)
  const schedule = (form.scan_schedule as ScanSchedule | undefined) ?? config.scan_schedule
  const formatCandidate = form.datetime_format ?? config.datetime_format ?? DEFAULT_DATETIME_FORMAT
  const previewDateTime = formatDateTime(
    parseTimestamp(status.last_run) ?? new Date(),
    isValidDateTimeFormat(formatCandidate) ? formatCandidate : DEFAULT_DATETIME_FORMAT,
  )
  const usenetIndexerReady = configured.animetosho || configured.amenzb
  const cacheInvalid = Boolean(scannedData && (!scannedData.cache_valid || !scannedData.results_valid))
  const showSonarr = !guidedSetup || librarySource === 'sonarr'
  const showRadarr = !guidedSetup || librarySource === 'radarr'

  const saveControls = (
    <div className="configuration-save-controls flex flex-wrap items-center justify-between gap-3 max-[600px]:gap-2">
      <p className="relative m-0 text-xs text-muted" role="status">
        <Icon name="hard-drive" size={15} className="mr-1.5 inline" />
        {dirty ? (
          <>
            <span>Unsaved changes</span>
            <span className="max-[600px]:hidden"> · your draft is kept when switching tabs</span>
          </>
        ) : (
          <>
            <span className="max-[600px]:sr-only">All configuration changes saved</span>
            <span aria-hidden="true" className="hidden max-[600px]:inline">
              Saved
            </span>
          </>
        )}
      </p>
      <button type="submit" form={formId} className={cx(buttonPrimary, 'justify-center')} disabled={saving || !dirty}>
        {saving ? (
          <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />
        ) : (
          <Icon name="check" size={17} />
        )}{' '}
        {saving ? 'Saving…' : 'Save configuration'}
      </button>
    </div>
  )

  return (
    <section>
      <header className="app-page-header mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="m-0 text-3xl font-extrabold tracking-tight max-[600px]:text-2xl">Configuration</h1>
          <p className="mt-2 mb-0 text-sm text-muted">
            Connect your services. Credentials are encrypted locally and never returned to the browser.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright hover:bg-accent/18')}
            onClick={() => void testAll()}
            disabled={testingAll || configuredServices.length === 0}
          >
            {testingAll ? (
              <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            ) : (
              <Icon name="refresh" size={15} />
            )}{' '}
            {testingAll ? 'Testing connections…' : 'Test connections'}
          </button>
          {!guidedSetup && (
            <button
              type="button"
              className={cx(buttonBase, 'border-line bg-panel text-ink')}
              onClick={() => setGuidedSetup(true)}
            >
              Connection checklist
            </button>
          )}
        </div>
      </header>
      <form
        id={formId}
        onSubmit={submit}
        onInvalidCapture={event => {
          if (event.target instanceof HTMLElement) {
            let disclosure = event.target.closest('details')
            while (disclosure) {
              disclosure.open = true
              disclosure = disclosure.parentElement?.closest('details') || null
            }
          }
        }}
      >
        <fieldset disabled={saving} className="configuration-disclosures m-0 min-w-0 border-0 p-0">
          {guidedSetup && (
            <section
              className="mb-4 rounded-card border border-accent/25 bg-accent/6 p-4"
              aria-label="Connection checklist"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="m-0 text-base font-bold">Connect your library</h2>
                <button
                  type="button"
                  className="touch-target cursor-pointer rounded-lg px-2 text-xs font-semibold text-accent-bright hover:bg-accent/10"
                  onClick={() => setGuidedSetup(false)}
                >
                  Show all settings
                </button>
              </div>
              <ol className="m-0 grid list-none gap-2 p-0 text-xs sm:grid-cols-3">
                <li>
                  <strong className="block text-ink">1. Connect & test</strong>
                  <span className="text-muted">
                    {connections[librarySource].phase === 'success'
                      ? 'Connection tested'
                      : 'Enter a URL and API key, then test'}
                  </span>
                </li>
                <li>
                  <strong className="block text-ink">2. Save connection</strong>
                  <span className="text-muted">
                    {savedSelectedSource && !dirty ? 'Connection saved' : 'Use Save configuration below'}
                  </span>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <strong className="block text-ink">3. Scan library</strong>
                    <span className="text-muted">
                      {status.running ? 'Scan in progress' : 'Find your first upgrades'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')}
                    disabled={!savedSelectedSource || dirty || scanDisabled}
                    onClick={() => {
                      onRunScan()
                      setGuidedSetup(false)
                    }}
                  >
                    Scan library
                  </button>
                </li>
              </ol>
            </section>
          )}
          {guidedSetup && (
            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Choose library source">
              {(['sonarr', 'radarr'] as const).map(service => (
                <button
                  key={service}
                  type="button"
                  aria-pressed={librarySource === service}
                  className={cx(
                    buttonBase,
                    librarySource === service
                      ? 'border-accent bg-accent/12 text-ink'
                      : 'border-line bg-panel text-muted',
                  )}
                  onClick={() => setLibrarySource(service)}
                >
                  {service === 'sonarr' ? 'Sonarr · series' : 'Radarr · movies'}
                </button>
              ))}
            </div>
          )}

          <section className="pb-3" aria-labelledby={`${formId}-library`}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pb-4">
              <h2 id={`${formId}-library`} className="m-0 text-lg font-extrabold tracking-tight">
                Library
              </h2>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                {showSonarr && chip('sonarr')}
                {showRadarr && chip('radarr')}
              </span>
            </div>
            <div className={cx('grid gap-4', !guidedSetup && 'grid-cols-2 max-[1100px]:grid-cols-1')}>
              {showSonarr && (
                <IntegrationCard
                  brand="sonarr"
                  title="Sonarr"
                  description="Series library and season metadata"
                  configured={configured.sonarr}
                  connection={connections.sonarr}
                  onTest={() => void test('sonarr')}
                >
                  <Field
                    name="sonarr_url"
                    type="url"
                    label="Server URL"
                    hint="The /api/v3 path is added automatically"
                    placeholder="https://sonarr.example.com"
                    required={configured.sonarr}
                    form={form}
                    set={set}
                  />
                  <Field
                    name="sonarr_key"
                    type="password"
                    label="API key"
                    placeholder="Enter the Sonarr API key"
                    required={configured.sonarr && !form.sonarr_key_configured}
                    configured={!!form.sonarr_key_configured}
                    onClear={() => setPendingClear('sonarr_key')}
                    form={form}
                    set={set}
                  />
                  <Field
                    name="sonarr_category"
                    type="text"
                    label="qBittorrent category"
                    hint="Must match the category configured in Sonarr"
                    placeholder="sonarr-anime"
                    form={form}
                    set={set}
                  />
                </IntegrationCard>
              )}
              {showRadarr && (
                <IntegrationCard
                  brand="radarr"
                  title="Radarr"
                  description="Movie library and release metadata"
                  configured={configured.radarr}
                  connection={connections.radarr}
                  onTest={() => void test('radarr')}
                >
                  <Field
                    name="radarr_url"
                    type="url"
                    label="Server URL"
                    hint="The /api/v3 path is added automatically"
                    placeholder="https://radarr.example.com"
                    required={configured.radarr}
                    form={form}
                    set={set}
                  />
                  <Field
                    name="radarr_key"
                    type="password"
                    label="API key"
                    placeholder="Enter the Radarr API key"
                    required={configured.radarr && !form.radarr_key_configured}
                    configured={!!form.radarr_key_configured}
                    onClear={() => setPendingClear('radarr_key')}
                    form={form}
                    set={set}
                  />
                  <Field
                    name="radarr_category"
                    type="text"
                    label="qBittorrent category"
                    hint="Must match the category configured in Radarr"
                    placeholder="radarr-anime"
                    form={form}
                    set={set}
                  />
                </IntegrationCard>
              )}
            </div>
          </section>

          <Section
            title="Downloads"
            attention={failed(shownDownloadServices)}
            expand={!guidedSetup && (configured.qbittorrent || configured.sabnzbd)}
            summary={shownDownloadServices.map(chip)}
          >
            <div>
              <h3 id={methodId} className={subheading}>
                Download method
              </h3>
              <p className="mt-1 mb-3 text-xs text-muted">Only the services this method uses are shown below.</p>
              <div role="radiogroup" aria-labelledby={methodId} className="grid gap-2 md:grid-cols-3">
                {downloadModes.map(([mode, label]) => (
                  <label
                    key={mode}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-canvas-soft p-4 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                  >
                    <input
                      type="radio"
                      name="download_mode"
                      className="size-4 shrink-0 accent-accent"
                      checked={downloadMode === mode}
                      onChange={() => set('download_mode', mode)}
                    />
                    <span className="font-semibold text-ink">{label}</span>
                  </label>
                ))}
              </div>
              {downloadMode === 'usenet_only' && (!configured.sabnzbd || !usenetIndexerReady) && (
                <p
                  role="status"
                  className="mt-3 mb-0 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/8 p-3 text-xs text-warn"
                >
                  <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Usenet-only mode needs{' '}
                    {!configured.sabnzbd && !usenetIndexerReady
                      ? 'a working SABnzbd connection and an enabled indexer (AnimeTosho or AmeNZB)'
                      : !configured.sabnzbd
                        ? 'a working SABnzbd connection'
                        : 'an enabled indexer (AnimeTosho or AmeNZB) to find NZBs'}
                    .
                  </span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
              {torrentShown && (
                <IntegrationCard
                  brand="qbittorrent"
                  title="qBittorrent"
                  description="Sends public torrent releases directly to your client"
                  configured={configured.qbittorrent}
                  connection={connections.qbittorrent}
                  onTest={() => void test('qbittorrent')}
                >
                  <Field
                    name="qbittorrent_url"
                    type="url"
                    label="Web API URL"
                    placeholder="http://192.168.1.10:8080"
                    form={form}
                    set={set}
                  />
                  <Field
                    name="qbittorrent_user"
                    type="text"
                    label="Username"
                    placeholder="qBittorrent username"
                    form={form}
                    set={set}
                  />
                  <Field
                    name="qbittorrent_pass"
                    type="password"
                    label="Password"
                    placeholder="qBittorrent password"
                    configured={!!form.qbittorrent_pass_configured}
                    onClear={() => setPendingClear('qbittorrent_pass')}
                    form={form}
                    set={set}
                  />
                </IntegrationCard>
              )}
              {usenetShown && (
                <IntegrationCard
                  brand="sabnzbd"
                  title="SABnzbd"
                  description="Usenet downloader, required for Usenet downloads"
                  configured={configured.sabnzbd}
                  connection={connections.sabnzbd}
                  onTest={() => void test('sabnzbd')}
                >
                  <Field
                    name="sabnzbd_url"
                    type="url"
                    label="Server URL"
                    placeholder="http://192.168.1.10:8080"
                    form={form}
                    set={set}
                  />
                  <Field
                    name="sabnzbd_key"
                    type="password"
                    label="API key"
                    placeholder="Enter the SABnzbd API key"
                    configured={!!form.sabnzbd_key_configured}
                    onClear={() => setPendingClear('sabnzbd_key')}
                    form={form}
                    set={set}
                  />
                  <Field
                    name="sabnzbd_sonarr_category"
                    type="text"
                    label="Sonarr category"
                    hint="Must match the category configured in Sonarr"
                    placeholder="sonarr-anime"
                    form={form}
                    set={set}
                  />
                  <Field
                    name="sabnzbd_radarr_category"
                    type="text"
                    label="Radarr category"
                    hint="Must match the category configured in Radarr"
                    placeholder="radarr-anime"
                    form={form}
                    set={set}
                  />
                </IntegrationCard>
              )}
            </div>
            {usenetShown && (
              <div>
                <h3 className={subheading}>Usenet indexers</h3>
                <p className="mt-1 mb-3 text-xs text-muted">
                  Indexers find the NZBs that SABnzbd downloads. Enable at least one.
                </p>
                <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
                  <IntegrationCard
                    brand="animetosho"
                    title="AnimeTosho"
                    description="Usenet anime index; no API key needed"
                    configured={configured.animetosho}
                    disabled={!form.animetosho_enabled}
                    connection={connections.animetosho}
                    onTest={() => void test('animetosho')}
                  >
                    <ToggleRow
                      label="Search AnimeTosho for NZBs"
                      checked={!!form.animetosho_enabled}
                      onChange={checked => set('animetosho_enabled', checked)}
                    />
                    <details className="text-xs">
                      <summary className="touch-target flex cursor-pointer items-center font-semibold text-muted hover:text-ink">
                        Advanced: feed URL
                      </summary>
                      <div className="pt-2">
                        <Field
                          name="animetosho_url"
                          type="url"
                          label="Feed URL"
                          hint="Used for NZB discovery; no key required"
                          placeholder="https://feed.animetosho.net"
                          form={form}
                          set={set}
                        />
                      </div>
                    </details>
                  </IntegrationCard>
                  <IntegrationCard
                    brand="amenzb"
                    title="AmeNZB"
                    description="Hash-linked Usenet index; requires your account API key"
                    configured={configured.amenzb}
                    disabled={!form.amenzb_enabled}
                    connection={connections.amenzb}
                    onTest={() => void test('amenzb')}
                  >
                    <ToggleRow
                      label="Search AmeNZB for NZBs"
                      checked={!!form.amenzb_enabled}
                      onChange={checked => set('amenzb_enabled', checked)}
                    />
                    <Field
                      name="amenzb_url"
                      type="url"
                      label="Server URL"
                      placeholder="https://amenzb.moe"
                      form={form}
                      set={set}
                    />
                    <Field
                      name="amenzb_key"
                      type="password"
                      label="API key"
                      hint="Required; find your key on amenzb.moe"
                      placeholder="Enter the AmeNZB API key"
                      configured={!!form.amenzb_key_configured}
                      onClear={() => setPendingClear('amenzb_key')}
                      form={form}
                      set={set}
                    />
                  </IntegrationCard>
                </div>
              </div>
            )}
          </Section>

          <Section title="Notifications" attention={failed(['discord'])} summary={chip('discord')}>
            <IntegrationCard
              brand="discord"
              title="Discord"
              description="Notify a channel when new upgrades are found"
              configured={configured.discord}
              connection={connections.discord}
              onTest={() => void test('discord')}
            >
              <ToggleRow
                label="Discord notifications"
                hint="Send newly discovered upgrades"
                checked={!!form.notify_enabled}
                onChange={checked => set('notify_enabled', checked)}
              />
              <Field
                name="webhook"
                type="url"
                label="Webhook URL"
                placeholder="https://discord.com/api/webhooks/…"
                configured={!!form.webhook_configured}
                onClear={() => setPendingClear('webhook')}
                form={form}
                set={set}
              />
              <div className="text-xs leading-relaxed text-muted">
                <Icon name="bell" size={15} className="mr-2 inline text-accent-bright" />
                The test button sends one visible test message to the configured channel.
              </div>
            </IntegrationCard>
          </Section>

          <Section title="Automation" detailsRef={automationRef}>
            <ScheduleEditor
              schedule={schedule}
              nextCheck={status.next_check}
              onChange={setSchedule}
              onRunNow={onRunScan}
              disabled={scanDisabled}
            />
            <ToggleRow
              id="unhide-on-new-best"
              className="border-t border-line pt-6"
              label="Unhide anime with new best releases"
              hint="Automatically restore hidden anime when a scan finds a new best release on SeaDex. Alternative releases do not trigger this."
              checked={!!form.unhide_on_new_best}
              onChange={checked => set('unhide_on_new_best', checked)}
            />
            <div className="border-t border-line pt-6">
              <h3 className={subheading}>Incoming webhooks</h3>
              <p className="mt-1 mb-4 text-xs text-muted">
                Add these URLs to Sonarr and Radarr to scan right after a new series or movie is added. Scheduled scans
                still refresh existing titles.
              </p>
              <div className="space-y-3">
                <CopyRow label="Sonarr" value={`${location.origin}/api/webhooks/sonarr`} />
                <CopyRow label="Radarr" value={`${location.origin}/api/webhooks/radarr`} />
              </div>
              <p className="mt-3 mb-0 text-xs text-muted">
                Configure HTTP Basic Authentication in Sonarr or Radarr using your SeaDex username and password.
                New-entry events are grouped for 10 seconds before scanning.
              </p>
              {status.webhook_scan.queued && (
                <p className="mt-2 mb-0 text-xs text-accent-bright">
                  A {status.webhook_scan.sources.join(' + ')} scan is queued.
                </p>
              )}
            </div>
          </Section>

          <Section title="General">
            <div>
              <label htmlFor="datetime-format-input" className={cx(subheading, 'block')}>
                Date &amp; time format
              </label>
              <p className="mt-1 mb-3 text-xs text-muted">
                Used for scan times, history, and detected changes. Tokens:{' '}
                <code className="rounded bg-canvas-soft px-1 py-0.5 text-ink">YYYY YY MM M DD D HH H mm m ss s</code>;
                other characters are kept literally.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="datetime-format-input"
                  className={cx(control, 'w-full max-w-64 bg-canvas-soft font-mono')}
                  type="text"
                  name="datetime_format"
                  placeholder={DEFAULT_DATETIME_FORMAT}
                  value={form.datetime_format ?? ''}
                  onChange={event => set('datetime_format', event.target.value)}
                  aria-describedby="datetime-format-preview"
                />
                <span id="datetime-format-preview" className="text-xs text-muted" role="status">
                  Preview: <span className="font-semibold text-ink">{previewDateTime}</span>
                </span>
              </div>
              {form.datetime_format && !isValidDateTimeFormat(form.datetime_format) && (
                <p className="mt-2 mb-0 text-xs text-bad">
                  Use only the tokens above with punctuation such as <code className="text-ink">. - / : , space</code>{' '}
                  between them.
                </p>
              )}
            </div>
            <ChangePasswordForm username={username} onAccountUpdated={onAccountUpdated} />
          </Section>

          <Section
            title="Maintenance"
            attention={cacheInvalid}
            summary={
              scannedData &&
              (cacheInvalid ? (
                <span className="font-bold text-bad">Invalid cached data detected</span>
              ) : (
                <span>
                  {scannedData.results} saved result{scannedData.results === 1 ? '' : 's'}
                </span>
              ))
            }
          >
            <section className="rounded-2xl border border-bad/30 bg-bad/5 p-5">
              <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 max-[600px]:grid-cols-[auto_minmax(0,1fr)]">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/10 text-bad">
                  <Icon name="trash" size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className={subheading}>Scanned data</h3>
                  <p className="mt-1 mb-0 text-xs text-muted">
                    Clear saved scan results and the AniList lookup cache if cached data becomes stale or corrupted.
                    Configuration and download tracking are preserved.
                  </p>
                  {scannedData && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">
                        {scannedData.results} saved result{scannedData.results === 1 ? '' : 's'}
                      </span>
                      <span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">
                        {scannedData.cache_entries} AniList cache entr{scannedData.cache_entries === 1 ? 'y' : 'ies'}
                      </span>
                      <span className="rounded-full border border-line bg-canvas-soft px-2 py-1 text-muted">
                        {scannedData.last_run
                          ? `Last scan ${displayDateTime(scannedData.last_run)}`
                          : 'No completed scan'}
                      </span>
                      {cacheInvalid && (
                        <span className="rounded-full border border-bad/35 bg-bad/8 px-2 py-1 font-bold text-bad">
                          Invalid cached data detected
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={cx(
                    buttonBase,
                    'justify-center border-bad/35 bg-bad/10 text-bad hover:bg-bad/18 max-[600px]:col-span-2',
                  )}
                  onClick={() => setClearDataOpen(true)}
                  disabled={clearingData}
                >
                  {clearingData ? (
                    <span className="size-4 animate-spin rounded-full border-2 border-bad/35 border-t-bad" />
                  ) : (
                    <Icon name="trash" size={16} />
                  )}{' '}
                  {clearingData ? 'Clearing…' : 'Clear scanned data'}
                </button>
              </header>
            </section>
          </Section>
        </fieldset>
      </form>
      {active && (footerTarget ? createPortal(saveControls, footerTarget) : saveControls)}
      <ConfirmDialog
        open={pendingClear !== null}
        title="Clear stored credential?"
        description="The credential will be removed when you save the configuration. You can enter a replacement before saving."
        confirmLabel="Clear credential"
        dangerous
        onConfirm={() => {
          if (pendingClear) clearSecret(pendingClear)
        }}
        onClose={() => setPendingClear(null)}
      />
      <ConfirmDialog
        open={clearDataOpen}
        title="Clear scanned data?"
        description="This removes all saved scan results and AniList cache entries. Your configuration, hidden-title list, notification history, and torrent ownership records will remain. Run a new scan to rebuild the data."
        confirmLabel="Clear scanned data"
        dangerous
        onConfirm={clearData}
        onClose={() => setClearDataOpen(false)}
      />
    </section>
  )
}
