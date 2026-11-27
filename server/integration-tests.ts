import type { Config, JsonObject } from './types.js'
import type { ArrScopeOptions } from '../shared/contracts.js'
import { arrApiUrl } from './arr-urls.js'
import { sabnzbdCategories } from './config.js'
import { sabSettings } from './client-identity.js'
import { USENET_PROVIDERS } from './usenet-providers.js'
import { api, fetchWithTimeout } from './http.js'
import { ARR_NAMES, findArrInstance, type ArrInstance } from '../shared/arr-instances.js'
import { arrApiBase } from './library.js'
import { qbTestConnection } from './qbittorrent.js'
import { sabMissingCategories, sabTestConnection } from './sabnzbd.js'
import { testProwlarr } from './prowlarr.js'
import { usenetParts } from './usenet-runtime.js'

/** `sonarr`, `radarr`, or `arr:<id>` for an additional instance. */
export function isArrService(service: string): boolean {
  return service === 'sonarr' || service === 'radarr' || service.startsWith('arr:')
}

function arrInstanceFor(config: Config, service: string): ArrInstance {
  const instance = findArrInstance(config, service.startsWith('arr:') ? service.slice(4) : service)
  if (!instance) throw new Error('Unknown Sonarr or Radarr instance')
  if (!arrApiUrl(instance.url) || !instance.key) throw new Error(`${instance.name} URL and API key are required`)
  return instance
}

/** Tags and root folders an instance offers, for choosing a library scope. Read-only. */
export async function arrScopeOptions(config: Config, service: string): Promise<ArrScopeOptions> {
  const instance = arrInstanceFor(config, service)
  const base = await arrApiBase(instance)
  const followRedirects = instance.kind === 'sonarr'
  const [tags, folders] = await Promise.all([
    api(`${base}/tag`, instance.key, {}, followRedirects) as Promise<JsonObject[]>,
    api(`${base}/rootfolder`, instance.key, {}, followRedirects) as Promise<JsonObject[]>,
  ])
  const texts = (items: unknown, field: string) => [
    ...new Set((Array.isArray(items) ? items : []).map(item => String(item?.[field] || '').trim()).filter(Boolean)),
  ]
  return {
    tags: texts(tags, 'label')
      .map(label => label.toLowerCase())
      .sort((left, right) => left.localeCompare(right)),
    root_folders: texts(folders, 'path').sort((left, right) => left.localeCompare(right)),
  }
}

/** Connection previews for configured integrations. Every check is read-only or a declared single test message; nothing is ever enqueued. */
export async function testIntegration(config: Config, service: string): Promise<string> {
  if (isArrService(service)) {
    const instance = arrInstanceFor(config, service)
    const base = await arrApiBase(instance)
    const status = (await api(`${base}/system/status`, instance.key, {}, instance.kind === 'sonarr')) as {
      appName?: unknown
      instanceName?: unknown
      version?: unknown
    } | null
    const name = String(status?.appName || status?.instanceName || ARR_NAMES[instance.kind])
    const version = status?.version ? ` ${String(status.version)}` : ''
    return `Connected to ${name}${version}`
  }
  if (service === 'qbittorrent') {
    await qbTestConnection(config)
    return 'Connected to qBittorrent'
  }
  if (service === 'sabnzbd') {
    const settings = sabSettings(config)
    if (!settings) throw new Error('SABnzbd URL and full API key are required')
    const { version } = await sabTestConnection(settings)
    // SABnzbd silently files NZBs with an unknown category under its default one, where Sonarr/Radarr never import them.
    const missing = await sabMissingCategories(settings, sabnzbdCategories(config))
    if (missing === null)
      throw new Error(
        `Connected to SABnzbd ${version}, but its category list could not be read to check the configured categories`,
      )
    if (missing.length)
      throw new Error(
        `Connected to SABnzbd ${version}, but it has no ${missing.length === 1 ? 'category' : 'categories'} named ${missing.map(name => `"${name}"`).join(' and ')}. Create ${missing.length === 1 ? 'it' : 'them'} in SABnzbd under Config → Categories, or enter the categories Sonarr and Radarr use.`,
      )
    return `Connected to SABnzbd ${version}`
  }
  if (service === 'animetosho') {
    if (!config.animetosho_url) throw new Error('AnimeTosho NEW API URL is required')
    await USENET_PROVIDERS.animetosho.test(USENET_PROVIDERS.animetosho.connection(config), usenetParts().fetch)
    return 'Connected to AnimeTosho NEW'
  }
  if (service === 'amenzb') {
    if (!config.amenzb_url || !config.amenzb_key) throw new Error('AmeNZB URL and API key are required')
    await USENET_PROVIDERS.amenzb.test(USENET_PROVIDERS.amenzb.connection(config), usenetParts().fetch)
    return 'AmeNZB accepted the API key'
  }
  if (service === 'prowlarr') {
    if (!config.prowlarr_url || !config.prowlarr_key) throw new Error('Prowlarr URL and API key are required')
    return await testProwlarr({ baseUrl: config.prowlarr_url, apiKey: config.prowlarr_key }, usenetParts().fetch)
  }
  if (service === 'discord') {
    if (!config.webhook) throw new Error('Discord webhook URL is required')
    const response = await fetchWithTimeout(
      config.webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title: 'Connection test successful',
              description: 'Your SeaDex Companion Discord webhook is configured correctly.',
              color: 0x57f287,
              footer: { text: 'SeaDex Companion' },
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
      30_000,
    )
    if (!response.ok) throw new Error(`Discord rejected the test message (HTTP ${response.status})`)
    return 'Test message sent to Discord'
  }
  throw new Error('Unknown integration')
}
