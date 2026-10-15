import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { log, errorMessage } from './logging.js'

export const SEADEX = 'https://seadex.moe/api'
export const ANILIST = 'https://graphql.anilist.co'
export const scanRequests = new AsyncLocalStorage<AbortSignal>()
export const sleep = (milliseconds: number) => delay(milliseconds, undefined, { signal: scanRequests.getStore() })

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 60_000): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeout)
  const signals = [timeoutSignal, scanRequests.getStore(), init.signal].filter((signal): signal is AbortSignal => Boolean(signal))
  const signal = AbortSignal.any(signals)
  return fetch(url, { ...init, redirect: 'manual', signal })
}

export async function api(url: string, key?: string, init: RequestInit = {}, followSameOriginRedirects = false): Promise<any> {
  try {
    const headers = new Headers(init.headers)
    if (key) headers.set('X-Api-Key', key)
    const request = { ...init, headers }
    let response = await fetchWithTimeout(url, request)
    if (followSameOriginRedirects && (!init.method || init.method.toUpperCase() === 'GET')) {
      const origin = new URL(url).origin
      for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(response.status); hop++) {
        const location = response.headers.get('Location')
        if (!location) break
        const target = new URL(location, url)
        // Never forward an API key to another origin or URL-supplied credentials.
        if (target.origin !== origin || target.username || target.password) break
        await response.body?.cancel()
        url = target.href
        response = await fetchWithTimeout(url, request)
      }
    }
    if (!response.ok) {
      log('ERROR', `API ${url} → HTTP ${response.status}`)
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    log('ERROR', `API request to ${url} failed: ${errorMessage(error)}`)
    throw error
  }
}
