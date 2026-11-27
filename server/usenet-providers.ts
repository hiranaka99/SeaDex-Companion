import type { Config } from './types.js'
import { HASH_INDEXER_CONFIG_KEYS, type UsenetProvider } from '../shared/usenet-contracts.js'
import { ANIMETOSHO_ENTRY_PATTERN, fetchAnimeToshoNzb, lookupAnimeTosho, testAnimeTosho } from './animetosho.js'
import { AMENZB_ENTRY_PATTERN, fetchAmeNZBNzb, lookupAmeNZB, testAmeNZB } from './amenzb.js'
import type { ProviderLookup, ProviderSettings, UsenetMatch } from './usenet-provider-types.js'

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
  lookup(settings: ProviderSettings, hash: string, fetchImpl: typeof fetch): Promise<ProviderLookup>
  fetchNzb(settings: ProviderSettings, match: UsenetMatch, fetchImpl: typeof fetch): Promise<Uint8Array>
  test(settings: ProviderSettings, fetchImpl: typeof fetch): Promise<void>
}

/** Lookup order: providers are asked in this order and the first usable match wins. */
export const USENET_PROVIDERS: Record<UsenetProvider, UsenetProviderDefinition> = {
  animetosho: {
    label: 'AnimeTosho',
    configKeys: HASH_INDEXER_CONFIG_KEYS.animetosho,
    entryPattern: ANIMETOSHO_ENTRY_PATTERN,
    connection: config => ({ baseUrl: config.animetosho_url }),
    usable: config => Boolean(config.animetosho_enabled && config.animetosho_url),
    lookup: (settings, hash, fetchImpl) => lookupAnimeTosho(settings, hash, fetchImpl),
    fetchNzb: (settings, match, fetchImpl) => fetchAnimeToshoNzb(settings, match, fetchImpl),
    test: (settings, fetchImpl) => testAnimeTosho(settings, fetchImpl),
  },
  amenzb: {
    label: 'AmeNZB',
    configKeys: HASH_INDEXER_CONFIG_KEYS.amenzb,
    entryPattern: AMENZB_ENTRY_PATTERN,
    connection: config => ({ baseUrl: config.amenzb_url, apiKey: config.amenzb_key }),
    usable: config => Boolean(config.amenzb_enabled && config.amenzb_url && config.amenzb_key),
    lookup: (settings, hash, fetchImpl) => lookupAmeNZB(settings, hash, fetchImpl),
    fetchNzb: (settings, match, fetchImpl) => fetchAmeNZBNzb(settings, match, fetchImpl),
    test: (settings, fetchImpl) => testAmeNZB(settings, fetchImpl),
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
