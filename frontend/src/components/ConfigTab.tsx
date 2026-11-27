import { findArrInstance, libraryConnected } from '../../../shared/arr-instances.js'
import { errorMessage } from '../../../shared/errors.js'
import type {
  ArrKind,
  ConfigUpdate,
  LibraryScope,
  PublicArrInstance,
  ReleasePreferences,
  SecretConfigKey,
} from '../../../shared/contracts'
import type { DownloadMode } from '../../../shared/download-contracts'
import {
  ARR_TAG_KEYS,
  ARR_TAG_PATTERN,
  DEFAULT_ARR_TAGS,
  DEFAULT_RELEASE_PREFERENCES,
  DEFAULT_TRACKER_MODE,
  EMPTY_LIBRARY_SCOPE,
  type ArrTagKey,
} from '../../../shared/settings'
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
  InputField,
  LimitField,
  ToggleRow,
  IntegrationCard,
  CopyRow,
  ConfigSkeleton,
} from './config/parts'
import { ScheduleEditor, scheduleErrors } from './config/ScheduleEditor'
import ChangePasswordForm from './config/ChangePasswordForm'
import { SettingsPanel, SettingsTabs, type SettingsTabId } from './config/SettingsTabs'
import LibraryScopeEditor from './LibraryScopeEditor'
import ReleasePreferencesEditor from './ReleasePreferencesEditor'
import { useConnectionTests } from '../useConnectionTests'
import { useProwlarrSearchStatus } from '../useProwlarrCoverage'
import { expectedSearchesText, PROWLARR_FETCH_LIMIT, PROWLARR_SEARCH_LIMIT, sweepSummaryLines } from '../usenet-review'
import {
  instanceConfigured,
  instanceService,
  isSecretKey,
  KIND_NAMES,
  serviceOfField,
  SERVICE_IDS,
  SERVICES,
  withoutSavedFlags,
  type ConfigDraft,
  type IntegrationService,
  type Service,
} from '../config-services'

/** The status tags in the order a person reads them, with what each one means on a title. */
const TAG_FIELDS: [ArrTagKey, string, string][] = [
  ['arr_tag_best', 'Best release owned', 'Every season is on its best release'],
  ['arr_tag_upgrade', 'Upgrade available', 'At least one season can be upgraded'],
  ['arr_tag_unlisted', 'Not on SeaDex', 'SeaDex lists no season of the title'],
  ['arr_tag_review', 'Match needs review', 'The AniList match is not confirmed yet'],
]

/** The settings a scan judges the library under. When they change, the saved results describe the earlier settings. */
const scanSettings = (config: Config) =>
  JSON.stringify([
    config.release_preferences,
    config.tracker_mode,
    config.verify_release_files,
    config.sonarr_url,
    config.radarr_url,
    config.sonarr_scope,
    config.radarr_scope,
    (config.arr_instances || []).map(instance => [instance.id, instance.url, instance.scope, instance.key_configured]),
  ])

interface Props {
  active: boolean
  scanDisabled: boolean
  footerTarget: HTMLElement | null
  loadError: string
  onRetry: () => void
  config: Config | null
  status: Status
  username: string
  knownTrackers: string[]
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
  knownTrackers,
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
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('library')
  const tabsAnchor = useRef<HTMLDivElement>(null)
  const [tabsStuck, setTabsStuck] = useState(false)
  const invalidSeen = useRef(false)
  const [clearedSecrets, setClearedSecrets] = useState<Set<SecretConfigKey>>(new Set())
  const dirty = Boolean(
    config && Object.keys(form).length && (JSON.stringify(form) !== savedForm.current || clearedSecrets.size),
  )
  const [pendingClear, setPendingClear] = useState<SecretConfigKey | null>(null)
  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [clearingData, setClearingData] = useState(false)
  const [scannedData, setScannedData] = useState<ScannedDataInfo | null>(null)
  const [removeTagsOpen, setRemoveTagsOpen] = useState(false)
  const [removingTags, setRemovingTags] = useState(false)
  const toast = useToast()
  const tests = useConnectionTests(form, clearedSecrets)
  const { connection, testingAll, test, failed } = tests
  // Read again after a scan and after a background search, which both change what is left to search.
  const searchStatus = useProwlarrSearchStatus(
    config,
    active && settingsTab === 'downloads',
    JSON.stringify([status.last_run, Boolean(status.usenet_prefetch?.running)]),
  )

  useEffect(() => {
    if (!config) return
    if (!setupInitialized.current) {
      setupInitialized.current = true
      setGuidedSetup(!libraryConnected(config))
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

  // The tab strip gains a backdrop only once content scrolls beneath it; at rest it sits on the page itself.
  const configLoaded = config !== null
  useEffect(() => {
    const anchor = tabsAnchor.current
    const pane = anchor?.closest('.app-scroll-pane')
    if (!anchor || !pane) return
    const observer = new IntersectionObserver(([entry]) => setTabsStuck(!entry.isIntersecting && active), {
      root: pane,
    })
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [active, configLoaded])

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
      setRemoveTagsOpen(false)
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
  const instances: PublicArrInstance[] = form.arr_instances || []
  const setInstances = (next: PublicArrInstance[]) => setForm(current => ({ ...current, arr_instances: next }))
  const updateInstance = (id: string, changes: Partial<PublicArrInstance>) => {
    setInstances(instances.map(instance => (instance.id === id ? { ...instance, ...changes } : instance)))
    if ('url' in changes || 'key' in changes) tests.invalidate(`arr:${id}`)
  }
  const addInstance = (kind: ArrKind) => {
    const taken = new Set(['sonarr', 'radarr', ...instances.map(instance => instance.name.trim().toLowerCase())])
    let number = 2
    while (taken.has(`${kind} ${number}`)) number += 1
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    setInstances([
      ...instances,
      {
        id,
        kind,
        name: `${KIND_NAMES[kind]} ${number}`,
        url: '',
        key: '',
        key_configured: false,
        category: `${kind}-anime`,
        sabnzbd_category: `${kind}-anime`,
        scope: EMPTY_LIBRARY_SCOPE,
      },
    ])
    window.requestAnimationFrame(() =>
      document.getElementById(`instance-${id}`)?.querySelector<HTMLInputElement>('input')?.focus(),
    )
  }
  const removeInstance = (instance: PublicArrInstance) => {
    const index = instances.indexOf(instance)
    setInstances(instances.filter(other => other.id !== instance.id))
    toast.show(`${instance.name} removed. Save the configuration to apply it.`, 'info', 12000, {
      label: 'Undo',
      onClick: () =>
        setForm(current => {
          const list = current.arr_instances || []
          return list.some(other => other.id === instance.id)
            ? current
            : { ...current, arr_instances: [...list.slice(0, index), instance, ...list.slice(index)] }
        }),
    })
  }
  const loadScopeOptions = (service: IntegrationService) => () =>
    api.getArrOptions(service, { ...form, clear_secrets: [...clearedSecrets] })
  const scopeOf = (name: 'sonarr_scope' | 'radarr_scope'): LibraryScope => form[name] || EMPTY_LIBRARY_SCOPE
  const preferences: ReleasePreferences = form.release_preferences || DEFAULT_RELEASE_PREFERENCES
  const tagProblem = (key: ArrTagKey) => {
    const label = String(form[key] ?? '').trim()
    return label && !ARR_TAG_PATTERN.test(label.toLowerCase()) ? 'Use lowercase letters, digits, and hyphens only' : ''
  }

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
  // Prowlarr serves both download methods, so it is summarized here once it is switched on.
  const shownDownloadServices = SERVICE_IDS.filter(
    service => (SERVICES[service].protocol || (service === 'prowlarr' && form.prowlarr_enabled)) && isRelevant(service),
  )

  const selectTab = (tab: SettingsTabId) => {
    setSettingsTab(tab)
    // A section scrolled far down must not leave the next one starting off-screen: return to the top of the strip.
    const anchor = tabsAnchor.current
    const pane = anchor?.closest('.app-scroll-pane')
    if (!anchor || !pane) return
    const top = anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
    if (pane.scrollTop > top) pane.scrollTop = top
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const schedule = form.scan_schedule
    if (!schedule) return
    if (scheduleErrors(schedule).length) {
      selectTab('automation')
      toast.show('Fix the automatic scan schedule before saving', 'error')
      return
    }
    if (ARR_TAG_KEYS.some(key => tagProblem(key))) {
      selectTab('automation')
      toast.show('Fix the status tag names before saving', 'error')
      return
    }
    setSaving(true)
    const data: ConfigUpdate = { ...withoutSavedFlags(form), clear_secrets: [...clearedSecrets] }
    try {
      const saved = await api.saveConfig(data)
      // Results are judged under the settings of their scan; say so when those settings changed.
      const rescan = config !== null && scanSettings(config) !== scanSettings(saved)
      setClearedSecrets(new Set())
      onSaved(saved)
      toast.show(
        rescan
          ? 'Configuration saved. Scan the library to apply the new scope and preferences.'
          : 'Configuration saved',
        'success',
        rescan ? 12000 : undefined,
        rescan && !scanDisabled ? { label: 'Scan now', onClick: onRunScan } : undefined,
      )
    } catch (error) {
      toast.show('Could not save configuration: ' + errorMessage(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const removeTags = async () => {
    setRemovingTags(true)
    try {
      const result = await api.removeArrTags()
      toast.show(
        result.removed
          ? `Removed status tags from ${result.removed} title${result.removed === 1 ? '' : 's'}`
          : 'No title carried a status tag',
        'success',
      )
    } catch (error) {
      toast.show('Could not remove the status tags: ' + errorMessage(error), 'error')
      throw error
    } finally {
      setRemovingTags(false)
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

  const configuredServices: IntegrationService[] = [
    ...SERVICE_IDS.filter(service => configured[service] && isRelevant(service)),
    ...instances.filter(instanceConfigured).map(instanceService),
  ]
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
  const selectedInstanceSaved = Boolean(findArrInstance(config, librarySource)?.configured)
  const schedule = form.scan_schedule ?? config.scan_schedule
  const formatCandidate = form.datetime_format ?? config.datetime_format ?? DEFAULT_DATETIME_FORMAT
  const previewDateTime = formatDateTime(
    parseTimestamp(status.last_run) ?? new Date(),
    isValidDateTimeFormat(formatCandidate) ? formatCandidate : DEFAULT_DATETIME_FORMAT,
  )
  const usenetIndexerReady = configured.animetosho || configured.amenzb
  const cacheInvalid = Boolean(scannedData && (!scannedData.cache_valid || !scannedData.results_valid))
  const showSonarr = !guidedSetup || librarySource === 'sonarr'
  const showRadarr = !guidedSetup || librarySource === 'radarr'
  const tabAttention: Partial<Record<SettingsTabId, boolean>> = {
    library: failed(['sonarr', 'radarr', ...instances.map(instanceService)]),
    downloads: failed(shownDownloadServices),
    notifications: failed(['discord']),
    automation: scheduleErrors(schedule).length > 0 || ARR_TAG_KEYS.some(key => tagProblem(key)),
    maintenance: cacheInvalid,
  }

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
              onClick={() => {
                setGuidedSetup(true)
                selectTab('library')
              }}
            >
              Connection checklist
            </button>
          )}
        </div>
      </header>
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
                {connection(librarySource).phase === 'success'
                  ? 'Connection tested'
                  : 'Enter a URL and API key, then test'}
              </span>
            </li>
            <li>
              <strong className="block text-ink">2. Save connection</strong>
              <span className="text-muted">
                {selectedInstanceSaved && !dirty ? 'Connection saved' : 'Use Save configuration below'}
              </span>
            </li>
            <li className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="block text-ink">3. Scan library</strong>
                <span className="text-muted">{status.running ? 'Scan in progress' : 'Find your first upgrades'}</span>
              </div>
              <button
                type="button"
                className={cx(buttonBase, 'border-accent/35 bg-accent/10 text-accent-bright')}
                disabled={!selectedInstanceSaved || dirty || scanDisabled}
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
      <div ref={tabsAnchor} aria-hidden="true" />
      <div className="configuration-tabs border-b border-line" data-stuck={tabsStuck ? '' : undefined}>
        <SettingsTabs base={formId} active={settingsTab} attention={tabAttention} onSelect={selectTab} />
      </div>
      <form
        id={formId}
        onSubmit={event => void submit(event)}
        onInvalidCapture={event => {
          if (event.target instanceof HTMLElement) {
            // The first invalid field decides the section to show. Reveal its panel at once so the browser can
            // focus the field and explain the problem; the state change then keeps that section selected.
            const panel = event.target.closest<HTMLElement>('[data-settings-tab]')
            if (!invalidSeen.current) {
              invalidSeen.current = true
              window.setTimeout(() => {
                invalidSeen.current = false
              })
              if (panel?.hidden) {
                panel.parentElement?.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach(other => {
                  other.hidden = other !== panel
                })
                selectTab(panel.dataset.settingsTab as SettingsTabId)
              }
            }
            let disclosure = event.target.closest('details')
            while (disclosure) {
              disclosure.open = true
              disclosure = disclosure.parentElement?.closest('details') || null
            }
          }
        }}
      >
        <fieldset disabled={saving} className="configuration-disclosures m-0 min-w-0 border-0 p-0">
          <SettingsPanel base={formId} tab="library" active={settingsTab === 'library'}>
            <div>
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
              <div className={cx('grid gap-4', !guidedSetup && 'grid-cols-2 max-[1100px]:grid-cols-1')}>
                {showSonarr && (
                  <IntegrationCard
                    brand="sonarr"
                    title="Sonarr"
                    description="Series library and season metadata"
                    configured={configured.sonarr}
                    connection={connection('sonarr')}
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
                    <LibraryScopeEditor
                      kind="sonarr"
                      appName="Sonarr"
                      scope={scopeOf('sonarr_scope')}
                      onChange={scope => set('sonarr_scope', scope)}
                      canLoad={configured.sonarr}
                      loadOptions={loadScopeOptions('sonarr')}
                    />
                  </IntegrationCard>
                )}
                {showRadarr && (
                  <IntegrationCard
                    brand="radarr"
                    title="Radarr"
                    description="Movie library and release metadata"
                    configured={configured.radarr}
                    connection={connection('radarr')}
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
                    <LibraryScopeEditor
                      kind="radarr"
                      appName="Radarr"
                      scope={scopeOf('radarr_scope')}
                      onChange={scope => set('radarr_scope', scope)}
                      canLoad={configured.radarr}
                      loadOptions={loadScopeOptions('radarr')}
                    />
                  </IntegrationCard>
                )}
              </div>
              {!guidedSetup && instances.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
                  {instances.map(instance => {
                    const app = KIND_NAMES[instance.kind]
                    const name = instance.name.trim() || `New ${app} instance`
                    return (
                      <div key={instance.id} id={`instance-${instance.id}`} className="contents">
                        <IntegrationCard
                          brand={instance.kind}
                          title={name}
                          description={
                            instance.kind === 'sonarr'
                              ? 'Additional Sonarr series library'
                              : 'Additional Radarr movie library'
                          }
                          configured={instanceConfigured(instance)}
                          connection={connection(instanceService(instance))}
                          onTest={() => void test(instanceService(instance))}
                          footerAction={
                            <button
                              type="button"
                              className={cx(
                                buttonBase,
                                'justify-center border-line bg-canvas-soft text-bad hover:border-bad/40 hover:bg-bad/10',
                              )}
                              aria-label={`Remove ${name}`}
                              onClick={() => removeInstance(instance)}
                            >
                              <Icon name="trash" size={15} />
                              Remove
                            </button>
                          }
                        >
                          <InputField
                            label="Name"
                            hint="Shown on library cards, in the source filter, and in scan messages"
                            placeholder={`${app} 4K`}
                            required
                            value={instance.name}
                            onChange={value => updateInstance(instance.id, { name: value })}
                          />
                          <InputField
                            type="url"
                            label="Server URL"
                            hint="The /api/v3 path is added automatically"
                            placeholder={`https://${instance.kind}-4k.example.com`}
                            required
                            value={instance.url}
                            onChange={value => updateInstance(instance.id, { url: value })}
                          />
                          <InputField
                            type="password"
                            label="API key"
                            placeholder={`Enter the ${app} API key`}
                            required={!instance.key_configured}
                            configured={instance.key_configured && !instance.key}
                            value={instance.key}
                            onChange={value => updateInstance(instance.id, { key: value })}
                          />
                          {torrentShown && (
                            <InputField
                              label="qBittorrent category"
                              hint={`Must match the category configured in ${name}`}
                              placeholder={`${instance.kind}-4k`}
                              value={instance.category}
                              onChange={value => updateInstance(instance.id, { category: value })}
                            />
                          )}
                          {usenetShown && (
                            <InputField
                              label="SABnzbd category"
                              hint={`Must match the category configured in ${name}`}
                              placeholder={`${instance.kind}-4k`}
                              value={instance.sabnzbd_category}
                              onChange={value => updateInstance(instance.id, { sabnzbd_category: value })}
                            />
                          )}
                          <LibraryScopeEditor
                            kind={instance.kind}
                            appName={name}
                            scope={instance.scope || EMPTY_LIBRARY_SCOPE}
                            onChange={scope => updateInstance(instance.id, { scope })}
                            canLoad={instanceConfigured(instance)}
                            loadOptions={loadScopeOptions(instanceService(instance))}
                          />
                        </IntegrationCard>
                      </div>
                    )
                  })}
                </div>
              )}
              {!guidedSetup && (
                <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                  {(['sonarr', 'radarr'] as const).map(kind => (
                    <button
                      key={kind}
                      type="button"
                      className={cx(buttonBase, 'border-line bg-panel text-ink hover:bg-panel-raised')}
                      disabled={instances.length >= 10}
                      onClick={() => addInstance(kind)}
                    >
                      <Icon name="plus" size={16} />
                      Add {KIND_NAMES[kind]} instance
                    </button>
                  ))}
                  <span className="min-w-0 flex-1 basis-56 text-xs text-muted">
                    {instances.length >= 10
                      ? 'Ten additional instances is the limit.'
                      : 'For a second library, such as a 4K or anime-only instance. Each one is scanned and shown separately.'}
                  </span>
                </div>
              )}
            </div>
          </SettingsPanel>

          <SettingsPanel base={formId} tab="downloads" active={settingsTab === 'downloads'}>
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
                  connection={connection('qbittorrent')}
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
                  connection={connection('sabnzbd')}
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
                    connection={connection('animetosho')}
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
                    connection={connection('amenzb')}
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
            <div>
              <h3 className={subheading}>Private-tracker releases</h3>
              <p className="mt-1 mb-3 max-w-[72ch] text-xs text-muted">
                Prowlarr finds releases SeaDex lists on private trackers, through the indexers you set up in Prowlarr. A
                torrent is only sent when its files match the ones SeaDex lists, byte for byte. An NZB is sent when it
                names every file with a matching size; a match without exact sizes in the post is labelled near-exact.
              </p>
              <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
                <IntegrationCard
                  icon={<Icon name="search" size={22} />}
                  title="Prowlarr"
                  description="Searches your private trackers and Usenet indexers; requires the Prowlarr API key"
                  configured={configured.prowlarr}
                  disabled={!form.prowlarr_enabled}
                  connection={connection('prowlarr')}
                  onTest={() => void test('prowlarr')}
                >
                  <ToggleRow
                    label="Find private-tracker releases through Prowlarr"
                    checked={!!form.prowlarr_enabled}
                    onChange={checked => set('prowlarr_enabled', checked)}
                  />
                  <Field
                    name="prowlarr_url"
                    type="url"
                    label="Server URL"
                    hint="Include any URL base, such as /prowlarr"
                    placeholder="http://192.168.1.10:9696"
                    form={form}
                    set={set}
                  />
                  <Field
                    name="prowlarr_key"
                    type="password"
                    label="API key"
                    hint="Prowlarr → Settings → General → API Key"
                    placeholder="Enter the Prowlarr API key"
                    configured={!!form.prowlarr_key_configured}
                    onClear={() => setPendingClear('prowlarr_key')}
                    form={form}
                    set={set}
                  />
                  {form.prowlarr_enabled && (form.tracker_mode || DEFAULT_TRACKER_MODE) === 'public' && (
                    <p className="m-0 flex items-start gap-1.5 text-xs text-warn" role="note">
                      <Icon name="info" size={14} className="mt-0.5 shrink-0" />
                      <span>
                        Release preferences use public trackers only, so Prowlarr is not used until you include private
                        trackers there.
                      </span>
                    </p>
                  )}
                  {usenetShown && (
                    <div className="flex flex-col gap-4 border-t border-line pt-4">
                      <ToggleRow
                        label="Search Usenet indexers in the background"
                        hint={`After each scan, Prowlarr's Usenet indexers are searched for private-tracker releases and for releases AnimeTosho and AmeNZB do not have, so results are ready when you download. No NZB is fetched.${
                          searchStatus ? ` ${expectedSearchesText(searchStatus)}` : ''
                        }`}
                        checked={!!form.prowlarr_background_search}
                        onChange={checked => set('prowlarr_background_search', checked)}
                      />
                      <div className="grid grid-cols-2 items-start gap-4 max-[600px]:grid-cols-1">
                        <LimitField
                          name="prowlarr_search_limit"
                          label="Daily searches per indexer"
                          hint="Background searches only, up to 10,000. 0 means no limit from SeaDex Companion; Prowlarr's own limits still apply."
                          max={PROWLARR_SEARCH_LIMIT.max}
                          value={form.prowlarr_search_limit ?? PROWLARR_SEARCH_LIMIT.fallback}
                          onChange={value => set('prowlarr_search_limit', value)}
                        />
                        <LimitField
                          name="prowlarr_fetch_limit"
                          label="Daily NZB checks per indexer"
                          hint="Up to 1,000. Each check fetches one NZB, which the indexer counts as a download. 0 means no limit from SeaDex Companion."
                          max={PROWLARR_FETCH_LIMIT.max}
                          value={form.prowlarr_fetch_limit ?? PROWLARR_FETCH_LIMIT.fallback}
                          onChange={value => set('prowlarr_fetch_limit', value)}
                        />
                      </div>
                      {searchStatus?.summary && (
                        <div className="text-xs text-muted">
                          <p className="m-0 font-semibold text-ink">
                            Latest background search, finished{' '}
                            <time dateTime={searchStatus.summary.finished_at}>
                              {displayDateTime(searchStatus.summary.finished_at)}
                            </time>
                          </p>
                          <ul className="mt-1 mb-0 list-none space-y-0.5 p-0 tabular-nums wrap-anywhere">
                            {sweepSummaryLines(searchStatus.summary).map(line => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </IntegrationCard>
              </div>
            </div>
          </SettingsPanel>

          <SettingsPanel base={formId} tab="preferences" active={settingsTab === 'preferences'}>
            <ReleasePreferencesEditor
              preferences={preferences}
              verify={form.verify_release_files !== false}
              trackerMode={form.tracker_mode || DEFAULT_TRACKER_MODE}
              knownTrackers={knownTrackers}
              onChange={next => set('release_preferences', next)}
              onVerifyChange={checked => set('verify_release_files', checked)}
              onTrackerModeChange={mode => set('tracker_mode', mode)}
            />
          </SettingsPanel>

          <SettingsPanel base={formId} tab="notifications" active={settingsTab === 'notifications'}>
            <IntegrationCard
              brand="discord"
              title="Discord"
              description="Notify a channel about upgrades and problems"
              configured={configured.discord}
              connection={connection('discord')}
              onTest={() => void test('discord')}
              testLabel="Send test message"
            >
              <ToggleRow
                label="Discord notifications"
                hint="Send newly discovered upgrades, and seasons that lose their best release because their files changed"
                checked={!!form.notify_enabled}
                onChange={checked => set('notify_enabled', checked)}
              />
              {!!form.notify_enabled && (
                <ToggleRow
                  label="Import problems"
                  hint="Also notify when Sonarr or Radarr does not import a finished download"
                  checked={form.notify_import_problems !== false}
                  onChange={checked => set('notify_import_problems', checked)}
                />
              )}
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
          </SettingsPanel>

          <SettingsPanel base={formId} tab="automation" active={settingsTab === 'automation'}>
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
              <ToggleRow
                id="arr-status-tags"
                label="Status tags in Sonarr and Radarr"
                hint="After every scan, tag each series and movie with its SeaDex status, so you can filter by it there. Only the tags named here are ever added or removed."
                checked={!!form.arr_tags_enabled}
                onChange={checked => set('arr_tags_enabled', checked)}
              />
              {!!form.arr_tags_enabled && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {TAG_FIELDS.map(([key, label, meaning]) => (
                    <div key={key}>
                      <Field
                        name={key}
                        type="text"
                        label={label}
                        hint={`${meaning}. Leave empty to skip this tag.`}
                        placeholder={DEFAULT_ARR_TAGS[key]}
                        form={form}
                        set={set}
                      />
                      {tagProblem(key) && (
                        <p className="mt-1.5 mb-0 text-xs text-bad" role="alert">
                          {tagProblem(key)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  type="button"
                  className={cx(buttonBase, 'border-line bg-panel text-ink hover:bg-panel-raised')}
                  disabled={removingTags || dirty}
                  onClick={() => setRemoveTagsOpen(true)}
                >
                  {removingTags ? (
                    <span className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none" />
                  ) : (
                    <Icon name="trash" size={15} />
                  )}
                  {removingTags ? 'Removing tags…' : 'Remove these tags from all titles'}
                </button>
                <span className="min-w-0 flex-1 basis-56 text-xs text-muted">
                  {dirty
                    ? 'Save your changes before removing tags.'
                    : 'Turning the tags off leaves existing tags in place until you remove them.'}
                </span>
              </div>
            </div>
            <div className="border-t border-line pt-6">
              <h3 className={subheading}>Incoming webhooks</h3>
              <p className="mt-1 mb-4 text-xs text-muted">
                Add each URL as a Webhook connection in its app. Enable the event for added series or movies to scan new
                titles right away, and the import and upgrade events to refresh a title as soon as its files change.
                Scheduled scans still refresh everything else.
              </p>
              <div className="space-y-3">
                <CopyRow label="Sonarr" value={`${location.origin}/api/webhooks/sonarr`} />
                <CopyRow label="Radarr" value={`${location.origin}/api/webhooks/radarr`} />
                {instances.map(instance => (
                  <CopyRow
                    key={instance.id}
                    label={instance.name.trim() || KIND_NAMES[instance.kind]}
                    value={`${location.origin}/api/webhooks/${instance.kind}/${instance.id}`}
                  />
                ))}
              </div>
              <p className="mt-3 mb-0 text-xs text-muted">
                Configure HTTP Basic Authentication in Sonarr or Radarr using your SeaDex username and password. Events
                are grouped for 10 seconds before scanning.
              </p>
              {status.webhook_scan.queued && (
                <p className="mt-2 mb-0 text-xs text-accent-bright">
                  {status.webhook_scan.sources.length
                    ? `A ${status.webhook_scan.sources.join(' + ')} scan is queued.`
                    : 'A library check for a finished download is queued.'}
                </p>
              )}
            </div>
          </SettingsPanel>

          <SettingsPanel base={formId} tab="general" active={settingsTab === 'general'}>
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
          </SettingsPanel>

          <SettingsPanel base={formId} tab="maintenance" active={settingsTab === 'maintenance'}>
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
          </SettingsPanel>
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
        open={removeTagsOpen}
        title="Remove status tags?"
        description={`The tags ${
          ARR_TAG_KEYS.map(key => config[key])
            .filter(Boolean)
            .join(', ') || 'named in the settings'
        } are removed from every series and movie in Sonarr and Radarr. Nothing else changes there. They return with the next scan while status tags stay enabled.`}
        confirmLabel="Remove tags"
        dangerous
        onConfirm={removeTags}
        onClose={() => setRemoveTagsOpen(false)}
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
