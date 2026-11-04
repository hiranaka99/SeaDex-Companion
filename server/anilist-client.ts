import { ANILIST, sleep, fetchWithTimeout, scanRequests } from './http.js'
import { log, errorMessage } from './logging.js'
import type { JsonObject } from './types.js'

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void previous.then(() => { signal.removeEventListener('abort', abort); resolve() })
  })
}

export function createAniListClient(dependencies: {
  fetch?: typeof fetchWithTimeout
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
} = {}) {
  const transport = dependencies.fetch || fetchWithTimeout
  const pause = dependencies.sleep || sleep
  const now = dependencies.now || Date.now
  let lastCompleted: number | null = null
  let tail = Promise.resolve()

  async function perform(payload: JsonObject, search: boolean): Promise<any> {
    let lastError = 'unknown error'
    for (let attempt = 0; attempt < 6; attempt++) {
      scanRequests.getStore()?.throwIfAborted()
      const wait = lastCompleted === null ? 0 : 2100 - (now() - lastCompleted)
      if (wait > 0) await pause(wait)
      let response: Response
      try {
        response = await transport(ANILIST, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        }, 30_000)
      } catch (error) {
        lastCompleted = now()
        scanRequests.getStore()?.throwIfAborted()
        lastError = errorMessage(error)
        log('WARNING', `AniList ${search ? 'search ' : ''}network error, retrying: ${lastError}`)
        await pause(3000)
        continue
      }
      lastCompleted = now()
      if (response.status === 429) {
        lastError = 'HTTP 429 (rate limited)'
        const retryAfter = Number(response.headers.get('Retry-After') || 0)
        const backoff = retryAfter > 0 ? (retryAfter + 1) * 1000 : Math.min(3000 * 2 ** attempt, 60_000)
        log('WARNING', `AniList ${search ? 'search ' : ''}rate limit (HTTP 429), backing off ${Math.round(backoff / 1000)}s`)
        await pause(backoff)
        continue
      }
      if (response.status === 404) {
        log('WARNING', `AniList ${search ? 'search ' : ''}returned HTTP 404 (not found / non-anime ID), skipping`)
        return search ? [] : {}
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160)
        lastError = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        log('WARNING', `AniList ${search ? 'search ' : ''}request failed (${lastError}), retrying`)
        await pause(3000)
        continue
      }
      let body: JsonObject
      try { body = await response.json() }
      catch (error) {
        lastError = `invalid JSON: ${errorMessage(error)}`
        log('WARNING', `AniList ${search ? 'search ' : ''}response was invalid, retrying: ${lastError}`)
        await pause(3000)
        continue
      }
      if (Array.isArray(body?.errors) && body.errors.length) {
        if (body.errors.every((error: JsonObject) => error?.status === 404 || error?.message === 'Not Found.')) {
          log('WARNING', `AniList ${search ? 'search ' : ''}returned GraphQL 404 Not Found, skipping`)
          return search ? [] : {}
        }
        lastError = body.errors.map((error: JsonObject) => error?.message || 'GraphQL error').join('; ')
        log('WARNING', `AniList ${search ? 'search ' : ''}GraphQL error, retrying: ${lastError}`)
        await pause(3000)
        continue
      }
      return search ? (body?.data?.Page?.media || []) : (body?.data?.Media || {})
    }
    throw new Error(`AniList ${search ? 'search ' : ''}request failed after 6 attempts: ${lastError}`)
  }

  async function request(payload: JsonObject, search: boolean): Promise<any> {
    const previous = tail
    let unlock!: () => void
    const current = new Promise<void>(resolve => { unlock = resolve })
    tail = previous.then(() => current)
    try {
      // Searches and scans share one rate limit. Cancelled queued scans may
      // leave promptly without allowing later requests to overtake the queue.
      await waitForTurn(previous, scanRequests.getStore())
      return await perform(payload, search)
    } finally { unlock() }
  }

  return {
    media: (query: string, variables: JsonObject): Promise<JsonObject> => request({ query, variables }, false),
    search: (query: string, variables: JsonObject): Promise<JsonObject[]> => request({ query, variables }, true),
  }
}

const client = createAniListClient()
export const alMedia = client.media
export const alSearch = client.search
