import { searchAniListTitles } from './anilist.js'
import { loadConfig } from './config.js'
import { resultsForRequest } from './downloads.js'
import { setCardHidden } from './hidden.js'
import { loadScanHistory } from './history.js'
import { HttpError } from './http-error.js'
import { readJson, sendJson } from './http-response.js'
import { log } from './logging.js'
import { isReleaseChange, restoreReleaseChanges, reviewReleaseChanges, withReleaseChanges } from './release-changes.js'
import { clearScannedData, loadLastResults, scannedDataInfo } from './results.js'
import { route, type Route } from './router.js'
import { getState } from './scan-state.js'
import {
  applyUserRulesToResults,
  setExclusion,
  setSeasonMapping,
  setTitleMapping,
  validSeasonMappingIds,
} from './user-rules.js'
import { stopUsenetPrefetch } from './usenet-prefetch.js'
import { cardKey } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import type { ReleaseChange } from '../shared/contracts.js'

/** Matches feed the running scan, so they only change between scans. */
function requireIdleScan(): void {
  if (getState().running) throw new HttpError(409, 'Wait for the current scan to finish before changing a match')
}

export const libraryRoutes: Route[] = [
  route('GET', '/api/results', ({ response }) => {
    const state = getState()
    const payload =
      state.running || state.results.length
        ? { results: state.results, last_run: state.last_run }
        : loadLastResults() || { results: [], last_run: null }
    sendJson(response, 200, {
      ...payload,
      results: applyUserRulesToResults(withReleaseChanges(payload.results)),
      hidden: loadConfig().hidden,
    })
  }),
  route('GET', '/api/history', ({ response }) => sendJson(response, 200, { scans: loadScanHistory() })),
  route('GET', '/api/anilist/search', async ({ response, url }) => {
    const query = String(url.searchParams.get('q') || '').trim()
    if (query.length < 2) throw new HttpError(400, 'Enter at least two characters')
    sendJson(response, 200, { results: await searchAniListTitles(query) })
  }),
  route('POST', '/api/mapping-overrides', async ({ request, response }) => {
    requireIdleScan()
    const data = await readJson(request)
    requireIdleScan()
    const libraryKey = String(data.library_key || '').trim()
    const results = resultsForRequest().filter(result => result.library_key === libraryKey)
    if (!libraryKey || !results.length) throw new HttpError(404, 'Library title not found — run a scan first')
    if (data.season !== undefined) {
      const season = data.season
      if (!Number.isSafeInteger(season) || season <= 0)
        throw new HttpError(400, 'A positive Sonarr season number is required')
      if (!results.some(result => result.arr === 'Sonarr' && result.season === season))
        throw new HttpError(404, 'Season not found — run a scan first')
      const ids = data.anilist_ids
      if (ids !== null && !validSeasonMappingIds(ids))
        throw new HttpError(
          400,
          'Choose 1–20 distinct AniList IDs in episode order, or null to restore automatic matching',
        )
      setSeasonMapping(libraryKey, season, ids)
      log(
        'INFO',
        `${ids === null ? 'Removed season AniList match' : `Set season AniList match to ${ids.join(', ')}`} for ${libraryKey} season ${season}`,
      )
      return sendJson(response, 200, { ok: true, season, anilist_ids: ids })
    }
    const anilistId = data.anilist_id == null ? null : Number(data.anilist_id)
    if (anilistId !== null && (!Number.isInteger(anilistId) || anilistId <= 0))
      throw new HttpError(400, 'A valid AniList ID is required')
    setTitleMapping(libraryKey, anilistId)
    log(
      'INFO',
      `${anilistId === null ? 'Removed manual AniList match' : `Set manual AniList match to ${anilistId}`} for ${libraryKey}`,
    )
    sendJson(response, 200, { ok: true, anilist_id: anilistId })
  }),
  route('POST', '/api/exclusions', async ({ request, response }) => {
    const data = await readJson(request)
    const libraryKey = String(data.library_key || '').trim()
    const season = Number(data.season || 0)
    const part = String(data.part || '').trim()
    const excluded = Boolean(data.excluded)
    if (
      !libraryKey ||
      !Number.isInteger(season) ||
      season < 0 ||
      !resultsForRequest().some(result => result.library_key === libraryKey && (result.season || 0) === season)
    ) {
      throw new HttpError(404, 'Season not found — run a scan first')
    }
    setExclusion(libraryKey, season, part, excluded)
    log(
      'INFO',
      `${excluded ? 'Ignored' : 'Restored'} ${libraryKey} season ${season || 'Movie'}${part ? ` ${part}` : ''} for bulk downloads and notifications`,
    )
    sendJson(response, 200, { ok: true, excluded })
  }),
  route('POST', '/api/hidden', async ({ request, response }) => {
    const data = await readJson(request)
    const key = String(data.key || '').trim()
    if (!key) throw new HttpError(400, 'No key provided', { ok: false })
    const hidden = setCardHidden(key, Boolean(data.hidden))
    const title = resultsForRequest().find(result => cardKey(result) === key)?.title || key
    log(
      'INFO',
      `${data.hidden ? 'Hidden' : 'Restored'} library title: ${title} (key: ${key}; hidden total: ${hidden.length})`,
    )
    sendJson(response, 200, { ok: true, hidden })
  }),
  route('POST', '/api/release-changes/review', async ({ request, response }) => {
    const { ids } = await readJson(request)
    if (
      !Array.isArray(ids) ||
      !ids.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ) {
      throw new HttpError(400, 'Provide the change IDs to mark reviewed')
    }
    sendJson(response, 200, { ok: true, reviewed: reviewReleaseChanges(ids) })
  }),
  route('POST', '/api/release-changes/restore', async ({ request, response }) => {
    const { changes } = await readJson(request)
    if (
      !Array.isArray(changes) ||
      changes.length > 10_000 ||
      !changes.every(
        (entry: unknown) =>
          isRecord(entry) &&
          typeof entry.key === 'string' &&
          entry.key.length > 0 &&
          entry.key.length <= 2_000 &&
          isReleaseChange(entry.change),
      )
    ) {
      throw new HttpError(400, 'Provide the reviewed changes to restore')
    }
    sendJson(response, 200, {
      ok: true,
      restored: restoreReleaseChanges(changes as { key: string; change: ReleaseChange }[]),
    })
  }),
  route('GET', '/api/scanned-data', ({ response }) => sendJson(response, 200, { ok: true, ...scannedDataInfo() })),
  route('DELETE', '/api/scanned-data', ({ response }) => {
    if (getState().running)
      throw new HttpError(409, 'Wait for the current scan to finish before clearing scanned data', { ok: false })
    const cleared = clearScannedData()
    stopUsenetPrefetch()
    log(
      'INFO',
      `Scanned data cleared (saved results: ${cleared.results}; AniList cache entries: ${cleared.cacheEntries})`,
    )
    sendJson(response, 200, { ok: true, cleared })
  }),
]
