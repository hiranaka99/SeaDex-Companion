import { applyConfigUpdate, integrationConfig, loadConfig, saveConfig } from './config.js'
import { bumpGeneration } from './config-generation.js'
import { invalidatePlans } from './download-plans.js'
import { HttpError } from './http-error.js'
import { testIntegration } from './integration-tests.js'
import { log } from './logging.js'
import { invalidateQbSnapshots } from './qbittorrent.js'
import { refreshAutocheckSchedule } from './scheduler.js'
import { usenetRuntime } from './usenet-runtime.js'
import { SECRET_CONFIG_KEYS } from '../shared/contracts.js'
import { errorMessage } from '../shared/errors.js'
import { asRecord } from '../shared/guards.js'
import type { Config, JsonObject } from './types.js'

/** A rejected settings change is the caller's mistake, not a server failure. */
function validated<Result>(build: () => Result): Result {
  try {
    return build()
  } catch (error) {
    throw new HttpError(400, errorMessage(error))
  }
}

function describeSave(config: Config, data: JsonObject): string {
  const state = (configured: unknown) => (configured ? 'configured' : 'incomplete')
  const integrations = [
    `Sonarr=${state(config.sonarr_url && config.sonarr_key)}`,
    `Radarr=${state(config.radarr_url && config.radarr_key)}`,
    `qBittorrent=${state(config.qbittorrent_url && config.qbittorrent_user && config.qbittorrent_pass)}`,
    `Discord=${state(config.webhook)}`,
    ...config.arr_instances.map(instance => `${instance.name}=${state(instance.url && instance.key)}`),
  ].join(', ')
  const cleared: unknown[] = Array.isArray(data.clear_secrets) ? data.clear_secrets : []
  const credentials = [
    ...SECRET_CONFIG_KEYS.filter(key => key in data && Boolean(String(data[key] || '').trim())).map(
      key => `${key} updated`,
    ),
    ...SECRET_CONFIG_KEYS.filter(key => cleared.includes(key)).map(key => `${key} cleared`),
  ]
  return `${integrations}; auto-check: ${config.scan_schedule.enabled ? config.scan_schedule.mode : 'disabled'}; notifications: ${config.notify_enabled ? 'enabled' : 'disabled'}${credentials.length ? `; credentials: ${credentials.join(', ')}` : ''}`
}

/** Applies a settings change and brings everything derived from the old settings up to date. */
export function saveSettings(data: JsonObject): Config {
  const previous = loadConfig()
  const config = validated(() => applyConfigUpdate(previous, data))
  saveConfig(config)
  invalidateQbSnapshots()
  bumpGeneration()
  usenetRuntime().configChanged(previous, config)
  invalidatePlans()
  refreshAutocheckSchedule(config)
  log('INFO', `Configuration saved (${describeSave(config, data)})`)
  return config
}

/** Tests one integration with the submitted, not yet saved, settings. Rejects with the failure text. */
export async function testSubmittedIntegration(service: string, submitted: unknown): Promise<string> {
  const config = validated(() => integrationConfig(loadConfig(), service, asRecord(submitted)))
  const started = Date.now()
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
  log('INFO', `Integration test started: ${service}`)
  try {
    const message = await testIntegration(config, service)
    log('INFO', `Integration test passed: ${service} in ${elapsed()} (${message})`)
    return message
  } catch (error) {
    log('ERROR', `Integration test failed: ${service} after ${elapsed()} (${errorMessage(error)})`)
    throw new HttpError(502, errorMessage(error), { ok: false })
  }
}
