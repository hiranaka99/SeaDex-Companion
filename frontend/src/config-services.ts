import { SECRET_CONFIG_KEYS, type SecretConfigKey } from '../../shared/contracts.js'
import type { DownloadProtocol } from '../../shared/download-contracts.js'
import type { Config } from './types'

export type Service = 'sonarr' | 'radarr' | 'qbittorrent' | 'sabnzbd' | 'animetosho' | 'amenzb' | 'discord'

/** The settings form: the saved configuration without hidden titles, edited in place. */
export type ConfigDraft = Partial<Omit<Config, 'hidden'>>

interface ServiceDefinition {
  label: string
  /** Settings named after this prefix belong to the service; changing one voids its last connection test. */
  fieldPrefix: string
  /** The download method that uses this service; services without one are always relevant. */
  protocol?: DownloadProtocol
  /** The switch that turns an optional service off. */
  enabledBy?: 'animetosho_enabled' | 'amenzb_enabled'
  /** Enough is filled in to attempt a connection. */
  configured(form: ConfigDraft): boolean
}

const filled = (form: ConfigDraft, key: keyof ConfigDraft): boolean => Boolean(String(form[key] || '').trim())
/** A secret counts when it was typed now or is already saved on the server. */
const hasSecret = (form: ConfigDraft, key: SecretConfigKey): boolean =>
  filled(form, key) || Boolean(form[`${key}_configured`])

/** Every integration the configuration page offers, in the order they are tested and listed. */
export const SERVICES: Record<Service, ServiceDefinition> = {
  sonarr: {
    label: 'Sonarr',
    fieldPrefix: 'sonarr',
    configured: form => filled(form, 'sonarr_url') && hasSecret(form, 'sonarr_key'),
  },
  radarr: {
    label: 'Radarr',
    fieldPrefix: 'radarr',
    configured: form => filled(form, 'radarr_url') && hasSecret(form, 'radarr_key'),
  },
  qbittorrent: {
    label: 'qBittorrent',
    fieldPrefix: 'qbittorrent',
    protocol: 'torrent',
    // A password may consist of spaces, so it is not trimmed.
    configured: form =>
      filled(form, 'qbittorrent_url') &&
      filled(form, 'qbittorrent_user') &&
      Boolean(String(form.qbittorrent_pass || '') || form.qbittorrent_pass_configured),
  },
  sabnzbd: {
    label: 'SABnzbd',
    fieldPrefix: 'sabnzbd',
    protocol: 'usenet',
    configured: form => filled(form, 'sabnzbd_url') && hasSecret(form, 'sabnzbd_key'),
  },
  animetosho: {
    label: 'AnimeTosho',
    fieldPrefix: 'animetosho',
    protocol: 'usenet',
    enabledBy: 'animetosho_enabled',
    configured: form => Boolean(form.animetosho_enabled) && filled(form, 'animetosho_url'),
  },
  amenzb: {
    label: 'AmeNZB',
    fieldPrefix: 'amenzb',
    protocol: 'usenet',
    enabledBy: 'amenzb_enabled',
    configured: form => Boolean(form.amenzb_enabled) && filled(form, 'amenzb_url') && hasSecret(form, 'amenzb_key'),
  },
  discord: { label: 'Discord', fieldPrefix: 'webhook', configured: form => hasSecret(form, 'webhook') },
}

export const SERVICE_IDS = Object.keys(SERVICES) as Service[]

/** The service a setting belongs to, if any. */
export function serviceOfField(name: string): Service | undefined {
  return SERVICE_IDS.find(
    service => name === SERVICES[service].fieldPrefix || name.startsWith(`${SERVICES[service].fieldPrefix}_`),
  )
}

export const isSecretKey = (name: string): name is SecretConfigKey => SECRET_CONFIG_KEYS.some(key => key === name)

/** The draft as the server accepts it: the read-only "secret is saved" flags are not settings. */
export function withoutSavedFlags(form: ConfigDraft): ConfigDraft {
  const fields = { ...form }
  for (const key of SECRET_CONFIG_KEYS) delete fields[`${key}_configured`]
  return fields
}
