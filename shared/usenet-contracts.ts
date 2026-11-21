// Public Usenet availability contract. These types never carry provider
// credentials or authenticated URLs; the server resolves everything from its
// own validated configuration and owned records.

export type UsenetProvider = 'animetosho' | 'amenzb'

/** Per-source-hash lookup state. Frontend "checking" is separate from a provider's "processing". */
export type UsenetUnitState =
  | 'not_checked'
  | 'available'
  | 'no_match'
  | 'processing'
  | 'incomplete'
  | 'unsupported_hash'
  | 'not_configured'
  | 'lookup_failed'

export type UsenetFailureCode =
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'unauthorized'
  | 'rate_limited'
  | 'server'
  | 'invalid_config'

export interface UsenetHashAvailability {
  hash: string
  state: UsenetUnitState
  provider?: UsenetProvider
  entry_id?: string
  title?: string
  /** Provider-reported whole-source payload bytes when known. */
  total_bytes?: number
  /** True when the provider supplied the complete source file manifest. */
  files_known?: boolean
  file_count?: number
  /** Bounded manifest names (when complete) so review can list known extras. */
  file_names?: string[]
  error_code?: UsenetFailureCode
  /** Bounded safe text for failed lookups; never provider markup. */
  error?: string
  /** Enabled providers whose lookup could not be resolved. */
  providers_failed?: UsenetProvider[]
}

export interface UsenetAvailabilityResult {
  key: string
  release: number
  identity?: string
  /** One entry per normalized source hash required by the release. */
  hashes: UsenetHashAvailability[]
  /** 'available' only when every required source hash matched a usable NZB. */
  aggregate: UsenetUnitState
  checked_at: string
}

export interface UsenetAvailabilityRequest {
  selections: { key: string; release: number; identity?: string }[]
  /** Explicit Retry bypasses cached lookups for the requested hashes. */
  refresh?: boolean
}

export interface UsenetAvailabilityResponse {
  ok: boolean
  /** Invalidates cached availability when provider/SABnzbd configuration changed. */
  config_generation: number
  providers_enabled: Record<UsenetProvider, boolean>
  sabnzbd_configured: boolean
  results: UsenetAvailabilityResult[]
  error?: string
}
