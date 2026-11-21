import type { Config } from './types.js'
import { sabnzbdApiUrl } from './config.js'
import { sabEndpointId } from './sabnzbd.js'

/** Credential-free endpoint identities. Jobs bind to these; controls never follow a re-pointed URL. */
export function qbEndpointId(config: Config): string {
  const raw = String(config.qbittorrent_url || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase().slice(0, -1)}://${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
  } catch { return raw.replace(/\/+$/, '') }
}

export function sabEndpoint(config: Config): { apiUrl: string; endpointId: string } {
  const apiUrl = sabnzbdApiUrl(config)
  if (!apiUrl) return { apiUrl: '', endpointId: '' }
  try { return { apiUrl, endpointId: sabEndpointId(apiUrl) } } catch { return { apiUrl, endpointId: '' } }
}
