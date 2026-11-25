import type { Config } from './types.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'
import { fetchAnimeToshoNzb, lookupAnimeTosho, testAnimeTosho } from './animetosho.js'
import { fetchAmeNZBNzb, lookupAmeNZB, testAmeNZB } from './amenzb.js'
import {
  AMENZB_ENTRY_PATTERN,
  ANIMETOSHO_ENTRY_PATTERN,
  type ProviderLookup,
  type ProviderSettings,
  type UsenetMatch,
} from './usenet-provider-types.js'

/** Everything the resolver, cache and settings need to know about one Usenet indexer. */
export interface UsenetProviderDefinition {
  label: string
  /** Settings whose change means a different provider answers lookups. */
  configKeys: readonly (keyof Config)[]
  /** Shape of this provider's entry IDs. */
  entryPattern: RegExp
  /** Connection settings as saved, whether or not the provider is enabled. */
  connection(config: Config): ProviderSettings
  /** Enabled and complete enough to query. */
  usable(config: Config): boolean
  lookup(settings: ProviderSettings, hash: string): Promise<ProviderLookup>
  fetchNzb(settings: ProviderSettings, match: UsenetMatch): Promise<Uint8Array>
  test(settings: ProviderSettings): Promise<void>
}

/** Lookup order: providers are asked in this order and the first usable match wins. */
export const USENET_PROVIDERS: Record<UsenetProvider, UsenetProviderDefinition> = {
  animetosho: {
    label: 'AnimeTosho',
    configKeys: ['animetosho_enabled', 'animetosho_url'],
    entryPattern: ANIMETOSHO_ENTRY_PATTERN,
    connection: config => ({ baseUrl: config.animetosho_url }),
    usable: config => Boolean(config.animetosho_enabled && config.animetosho_url),
    lookup: (settings, hash) => lookupAnimeTosho(settings, hash),
    fetchNzb: (settings, match) => fetchAnimeToshoNzb(settings, match),
    test: settings => testAnimeTosho(settings),
  },
  amenzb: {
    label: 'AmeNZB',
    configKeys: ['amenzb_enabled', 'amenzb_url', 'amenzb_key'],
    entryPattern: AMENZB_ENTRY_PATTERN,
    connection: config => ({ baseUrl: config.amenzb_url, apiKey: config.amenzb_key }),
    usable: config => Boolean(config.amenzb_enabled && config.amenzb_url && config.amenzb_key),
    lookup: (settings, hash) => lookupAmeNZB(settings, hash),
    fetchNzb: (settings, match) => fetchAmeNZBNzb(settings, match),
    test: settings => testAmeNZB(settings),
  },
}

export const USENET_PROVIDER_IDS = Object.keys(USENET_PROVIDERS) as UsenetProvider[]

export const isUsenetProvider = (value: unknown): value is UsenetProvider =>
  typeof value === 'string' && Object.hasOwn(USENET_PROVIDERS, value)

/** Connection settings of a provider that can be queried now, or null when it is disabled or incomplete. */
export function providerSettings(config: Config, provider: UsenetProvider): ProviderSettings | null {
  const definition = USENET_PROVIDERS[provider]
  return definition.usable(config) ? definition.connection(config) : null
}
