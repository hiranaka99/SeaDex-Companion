import { useEffect, useMemo, useState } from 'react'
import * as api from './api'
import type { Config, ResultItem } from './types'

/** Prowlarr is switched on and has a URL and key; whether its indexers can find anything is asked separately. */
export const prowlarrConfigured = (config: Config | null | undefined): boolean =>
  Boolean(config?.prowlarr_enabled && config.prowlarr_url && config.prowlarr_key_configured)

/**
 * The configuration with what Prowlarr's indexers cover, for the trackers the results list private releases on.
 * Until Prowlarr answers (or when it cannot be reached) nothing is covered, so no download is offered that
 * would only fail.
 */
export function useProwlarrCoverage(config: Config | null, results: ResultItem[]): Config | null {
  const trackers = useMemo(
    () =>
      [
        ...new Set(
          results.flatMap(result =>
            result.releases
              .filter(release => !release.torrent_available && release.private_sources?.length)
              .map(release => release.tracker.trim())
              .filter(Boolean),
          ),
        ),
      ].sort(),
    [results],
  )
  const enabled = prowlarrConfigured(config)
  const scope = JSON.stringify([enabled, config?.prowlarr_url, config?.prowlarr_key_configured, trackers])
  const [coverage, setCoverage] = useState<{ scope: string; value: Config['prowlarr_coverage'] } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let current = true
    api
      .getProwlarrCoverage(trackers)
      .then(value => {
        if (current) setCoverage({ scope, value })
      })
      .catch(() => {
        if (current) setCoverage({ scope, value: { trackers: [], usenet: false } })
      })
    return () => {
      current = false
    }
  }, [scope])

  return useMemo(
    () => (config && enabled && coverage?.scope === scope ? { ...config, prowlarr_coverage: coverage.value } : config),
    [config, enabled, coverage, scope],
  )
}
