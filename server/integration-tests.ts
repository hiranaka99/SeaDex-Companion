import type { Config } from './types.js'
import { arrApiUrl, sabnzbdApiUrl, sonarrApiUrl } from './config.js'
import { api, fetchWithTimeout } from './http.js'
import { qbTestConnection } from './qbittorrent.js'
import { testAnimeTosho } from './animetosho.js'
import { testAmeNZB } from './amenzb.js'
import { sabMissingCategories, sabTestConnection } from './sabnzbd.js'

/** Connection previews for configured integrations. Every check is read-only or a declared single test message; nothing is ever enqueued. */
export async function testIntegration(config: Config, service: string): Promise<string> {
  if (service === 'sonarr' || service === 'radarr') {
    const url = config[`${service}_url`]
    let base = arrApiUrl(url)
    const key = String(config[`${service}_key`] || '')
    if (!base || !key) throw new Error(`${service === 'sonarr' ? 'Sonarr' : 'Radarr'} URL and API key are required`)
    if (service === 'sonarr') base = await sonarrApiUrl(url, key)
    const status = await api(`${base}/system/status`, key, {}, service === 'sonarr')
    const name = String(status.appName || status.instanceName || (service === 'sonarr' ? 'Sonarr' : 'Radarr'))
    const version = status.version ? ` ${status.version}` : ''
    return `Connected to ${name}${version}`
  }
  if (service === 'qbittorrent') {
    await qbTestConnection(config)
    return 'Connected to qBittorrent'
  }
  if (service === 'sabnzbd') {
    const apiUrl = sabnzbdApiUrl(config)
    if (!apiUrl || !config.sabnzbd_key) throw new Error('SABnzbd URL and full API key are required')
    const settings = { apiUrl, apiKey: config.sabnzbd_key }
    const { version } = await sabTestConnection(settings, globalThis.fetch)
    // SABnzbd silently files NZBs with an unknown category under its default one, where Sonarr/Radarr never import them.
    const missing = await sabMissingCategories(settings, [config.sabnzbd_sonarr_category, config.sabnzbd_radarr_category], globalThis.fetch)
    if (missing === null) throw new Error(`Connected to SABnzbd ${version}, but its category list could not be read to check the configured categories`)
    if (missing.length) throw new Error(`Connected to SABnzbd ${version}, but it has no ${missing.length === 1 ? 'category' : 'categories'} named ${missing.map(name => `"${name}"`).join(' and ')}. Create ${missing.length === 1 ? 'it' : 'them'} in SABnzbd under Config → Categories, or enter the categories Sonarr and Radarr use.`)
    return `Connected to SABnzbd ${version}`
  }
  if (service === 'animetosho') {
    if (!config.animetosho_url) throw new Error('AnimeTosho NEW API URL is required')
    await testAnimeTosho({ baseUrl: config.animetosho_url }, globalThis.fetch)
    return 'Connected to AnimeTosho NEW'
  }
  if (service === 'amenzb') {
    if (!config.amenzb_url || !config.amenzb_key) throw new Error('AmeNZB URL and API key are required')
    await testAmeNZB({ baseUrl: config.amenzb_url, apiKey: config.amenzb_key }, globalThis.fetch)
    return 'AmeNZB accepted the API key'
  }
  if (service === 'discord') {
    if (!config.webhook) throw new Error('Discord webhook URL is required')
    const response = await fetchWithTimeout(config.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Connection test successful',
          description: 'Your SeaDex Companion Discord webhook is configured correctly.',
          color: 0x57f287,
          footer: { text: 'SeaDex Companion' },
          timestamp: new Date().toISOString(),
        }],
      }),
    }, 30_000)
    if (!response.ok) throw new Error(`Discord rejected the test message (HTTP ${response.status})`)
    return 'Test message sent to Discord'
  }
  throw new Error('Unknown integration')
}
