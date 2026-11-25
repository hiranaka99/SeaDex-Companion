import { errorMessage } from '../shared/errors.js'
import { SEADEX, fetchWithTimeout, scanRequests, sleep } from './http.js'
import { log } from './logging.js'
import type { JsonObject } from './types.js'

const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT = 60_000
const MAX_RETRY_DELAY = 60_000
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export function createCatalogClient(
  dependencies: {
    fetch?: typeof fetchWithTimeout
    sleep?: typeof sleep
    now?: () => number
    random?: () => number
  } = {},
) {
  const transport = dependencies.fetch ?? fetchWithTimeout
  const pause = dependencies.sleep ?? sleep
  const now = dependencies.now ?? Date.now
  const random = dependencies.random ?? Math.random

  return async function loadPage(page: number): Promise<JsonObject> {
    const url = `${SEADEX}/collections/entries/records?page=${page}&perPage=500&expand=trs`
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      scanRequests.getStore()?.throwIfAborted()
      let retryable = true
      let retryAfter = 0
      try {
        const response = await transport(url, {}, REQUEST_TIMEOUT)
        if (!response.ok) {
          retryable = RETRY_STATUSES.has(response.status)
          const header = response.headers.get('Retry-After')
          if (header) {
            const seconds = Number(header)
            retryAfter = Number.isFinite(seconds)
              ? Math.max(0, seconds * 1000)
              : Math.max(0, Date.parse(header) - now()) || 0
          }
          // Release the failed response before waiting or requesting again.
          await response.body?.cancel()
          throw new Error(`HTTP ${response.status}`)
        }
        return await response.json()
      } catch (error) {
        // Only the scan signal means user cancellation. A timed-out response
        // body can also throw AbortError and must remain eligible for retry.
        scanRequests.getStore()?.throwIfAborted()
        const detail =
          error instanceof Error && error.name === 'TimeoutError'
            ? `request timed out after ${REQUEST_TIMEOUT / 1000}s`
            : errorMessage(error)
        const context = `SeaDex catalog page ${page}, attempt ${attempt}/${MAX_ATTEMPTS}: ${detail}`
        // Malformed JSON is a response problem, not a transient transport error.
        if (error instanceof SyntaxError || !retryable || attempt === MAX_ATTEMPTS || retryAfter > MAX_RETRY_DELAY) {
          const reason =
            retryAfter > MAX_RETRY_DELAY ? `; Retry-After exceeds the ${MAX_RETRY_DELAY / 1000}s retry wait limit` : ''
          throw new Error(`${context}${reason}`, { cause: error })
        }
        const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(random() * 250)
        const wait = Math.max(backoff, retryAfter)
        log('WARNING', `${context}; retrying in ${(wait / 1000).toFixed(2)}s`)
        await pause(wait)
      }
    }
    throw new Error(`SeaDex catalog page ${page} failed`)
  }
}

export const loadCatalogPage = createCatalogClient()
