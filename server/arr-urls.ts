import { api } from './http.js'

// Sonarr and Radarr are configured by base URL; users often paste one that already ends in /api/v3.

export function arrBaseUrl(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v\d+$/i, '')
    .replace(/\/+$/, '')
}

export function arrApiUrl(value: unknown): string {
  const base = arrBaseUrl(value)
  return base ? `${base}/api/v3` : ''
}

export async function sonarrApiUrl(value: unknown, key: string): Promise<string> {
  const base = arrBaseUrl(value)
  const info = await api(`${base}/api`, key, {}, true)
  if (info.current !== 'v3' && info.current !== 'v5')
    throw new Error(`Unsupported Sonarr API version: ${String(info.current)}`)
  return `${base}/api/${info.current}`
}
