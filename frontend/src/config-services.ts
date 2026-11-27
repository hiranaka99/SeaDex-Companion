import { SECRET_CONFIG_KEYS, type PublicArrInstance, type SecretConfigKey } from '../../shared/contracts.js'
import type { DownloadProtocol } from '../../shared/download-contracts.js'
import type { Config } from './types.js'

export type Service = 'sonarr' | 'radarr' | 'qbittorrent' | 'sabnzbd' | 'animetosho' | 'amenzb' | 'prowlarr' | 'discord'
/** A fixed integration, or `arr:<id>` for an additional Sonarr or Radarr instance. */
export type IntegrationService = Service | `arr:${string}`

/** The settings form: the saved configuration without hidden titles, edited in place. */
export type ConfigDraft = Partial<Omit<Config, 'hidden'>>

interface ServiceDefinition {
  label: string
  /** Settings named after this prefix belong to the service; changing one voids its last connection test. */
  fieldPrefix: string
  /** The download method that uses this service; services without one are always relevant. */
  protocol?: DownloadProtocol
  /** The switch that turns an optional service off. */
  enabledBy?: 'animetosho_enabled' | 'amenzb_enabled' | 'prowlarr_enabled'
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
  // Prowlarr finds private-tracker releases for both download methods.
  prowlarr: {
    label: 'Prowlarr',
    fieldPrefix: 'prowlarr',
    enabledBy: 'prowlarr_enabled',
    configured: form =>
      Boolean(form.prowlarr_enabled) && filled(form, 'prowlarr_url') && hasSecret(form, 'prowlarr_key'),
  },
  discord: { label: 'Discord', fieldPrefix: 'webhook', configured: form => hasSecret(form, 'webhook') },
}

export const SERVICE_IDS = Object.keys(SERVICES) as Service[]

/** Prowlarr settings that say how much is searched, not how Prowlarr is reached. */
const PROWLARR_USAGE_FIELDS = ['prowlarr_background_search', 'prowlarr_search_limit', 'prowlarr_fetch_limit']

/** The service a setting belongs to, if any. */
export function serviceOfField(name: string): Service | undefined {
  // A library scope or a usage limit does not change whether the connection works, so it keeps the last test result.
  if (name.endsWith('_scope') || PROWLARR_USAGE_FIELDS.includes(name)) return undefined
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

export const KIND_NAMES = { sonarr: 'Sonarr', radarr: 'Radarr' } as const

/** The connection-test address of an additional instance. */
export const instanceService = (instance: Pick<PublicArrInstance, 'id'>): IntegrationService => `arr:${instance.id}`

/** Enough of an additional instance is filled in to attempt a connection. */
export const instanceConfigured = (instance: PublicArrInstance): boolean =>
  Boolean(instance.url.trim() && (instance.key.trim() || instance.key_configured))

/** The additional instance a connection-test address names, if it is in the draft. */
export function instanceOfService(form: ConfigDraft, service: IntegrationService): PublicArrInstance | undefined {
  return service.startsWith('arr:')
    ? (form.arr_instances || []).find(instance => instanceService(instance) === service)
    : undefined
}

/** How an integration is named in messages. */
export function serviceLabel(form: ConfigDraft, service: IntegrationService): string {
  if (!service.startsWith('arr:')) return SERVICES[service as Service].label
  const instance = instanceOfService(form, service)
  return instance?.name.trim() || (instance ? KIND_NAMES[instance.kind] : 'Instance')
}
