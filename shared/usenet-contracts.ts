// Public Usenet availability contract. These types never carry provider
// credentials or authenticated URLs; the server resolves everything from its
// own validated configuration and owned records.

export type UsenetProvider = 'animetosho' | 'amenzb'
/**
 * Where an NZB came from: a hash-linked provider, or a Prowlarr search whose NZB file list matched the
 * private-tracker release byte for byte.
 */
export type UsenetSource = UsenetProvider | 'prowlarr'

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
  'network' | 'timeout' | 'invalid_response' | 'unauthorized' | 'rate_limited' | 'server' | 'invalid_config'

/**
 * An NZB a Prowlarr search found for a private-tracker release but could not prove to be it. It is shown so
 * the user can judge it on the indexer's page and still choose to download it.
 */
export interface UsenetCandidate {
  /** Opaque ID to choose this NZB with; never a URL. */
  entry_id: string
  title: string
  indexer: string
  /** Size the indexer reports for the post. */
  size?: number
  /** The post's page on its indexer, when one is known and safe to link. */
  info_url?: string
  /** Video files of the release whose name and exact size appear in the NZB. */
  files_matched: number
  /** Video files of the release whose name appears in the NZB, whatever its size. */
  names_matched: number
  files_expected: number
  /** The NZB's subjects state file sizes at all; obfuscated or size-less posts cannot be compared. */
  sizes_known: boolean
  /** The NZB could not be fetched to check it, so it cannot be downloaded from here. */
  unavailable?: string
}

export interface UsenetHashAvailability {
  hash: string
  state: UsenetUnitState
  provider?: UsenetSource
  entry_id?: string
  title?: string
  /** Provider-reported whole-source payload bytes when known. */
  total_bytes?: number
  /** True when file_names is a complete validated source manifest; bounded public projections clear it when names are omitted. */
  files_known?: boolean
  file_count?: number
  /** Complete names for internal planning; the public availability endpoint limits this list and preserves the total file_count. */
  file_names?: string[]
  error_code?: UsenetFailureCode
  /** NZBs a Prowlarr search checked without proving them, for the user to judge. */
  candidates?: UsenetCandidate[]
  /** Bounded safe text for failed lookups; never provider markup. */
  error?: string
  /** Providers that answered for this source, whatever they found; empty when none was asked. */
  providers_checked?: UsenetSource[]
  /** Enabled providers whose lookup could not be resolved. */
  providers_failed?: UsenetSource[]
  /** Time of the provider observation, not the time the cache was read. */
  checked_at?: string
  /** Cached information is older than its refresh interval but remains usable as last-known data. */
  stale?: boolean
  /** A missing or stale observation is being refreshed. */
  refreshing?: boolean
  /** A refresh failed; the previous observation was retained. */
  refresh_error?: string
}

export interface UsenetAvailabilityResult {
  key: string
  release: number
  identity: string
  /** One entry per normalized source hash required by the release. */
  hashes: UsenetHashAvailability[]
  /** 'available' only when every required source hash matched a usable NZB. */
  aggregate: UsenetUnitState
  /**
   * The release is on a private tracker and is found by searching Prowlarr. Searches only run when asked
   * for, because fetching an NZB to check its files counts against the indexer's download limit.
   */
  search?: 'prowlarr'
  /**
   * The hash indexers have no NZB for this public release, and Prowlarr can be searched for a copy whose files
   * match the torrent's. Absent once a Prowlarr result exists; `search` is set then.
   */
  fallback?: 'prowlarr'
  /** Oldest provider observation used by this result; empty when no provider has checked it. */
  checked_at: string
  stale: boolean
  refreshing: boolean
  refresh_error?: string
}

export interface UsenetAvailabilityRequest {
  selections: { key: string; release: number; identity?: string }[]
  /** Explicit Retry bypasses cached lookups for the requested hashes. */
  refresh?: boolean
  /** Rows to search Prowlarr for now. Every checked NZB counts toward an indexer's download limit. */
  search?: { key: string; release: number }[]
}

export interface UsenetAvailabilityResponse {
  ok: boolean
  /** Invalidates cached availability when provider/SABnzbd configuration changed. */
  config_generation: number
  providers_enabled: Record<UsenetProvider, boolean>
  /** Prowlarr is set up to search for private-tracker releases. */
  prowlarr_configured: boolean
  sabnzbd_configured: boolean
  results: UsenetAvailabilityResult[]
  error?: string
}
