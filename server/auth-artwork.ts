import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DAY = 24 * 60 * 60 * 1000
const RETRY_DELAY = 30 * 60 * 1000
const QUERY = 'query { Page(perPage: 18) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { coverImage { extraLarge large } } } }'
const CACHE_VERSION = 2

function validCovers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => {
    if (typeof item !== 'string' || item.length > 2048) return false
    try {
      const url = new URL(item)
      return url.protocol === 'https:' && url.hostname === 's4.anilist.co' && !url.username && !url.password && !url.port && url.pathname.startsWith('/file/anilistcdn/media/anime/cover/')
    } catch { return false }
  }))].slice(0, 18)
}

/** Fixed public query independent of library data; concurrent page loads share
 * one refresh, and upstream failure has a cooldown. */
export function createAuthArtworkCache(cacheFile: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let covers: string[] = []
  let updatedAt = 0
  let retryAt = 0
  let pending: Promise<string[]> | undefined
  try {
    if (existsSync(cacheFile)) {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (saved.version === CACHE_VERSION && typeof saved.updatedAt === 'number' && saved.updatedAt <= now()) {
        covers = validCovers(saved.covers)
        updatedAt = saved.updatedAt
      }
    }
  } catch { /* Cache is optional. */ }

  async function refresh(): Promise<string[]> {
    try {
      const response = await request('https://graphql.anilist.co', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY }), signal: AbortSignal.timeout(6000),
      })
      if (!response.ok) throw new Error('AniList unavailable')
      const payload = await response.json()
      if (payload.errors?.length) throw new Error('AniList query failed')
      const next = validCovers(payload.data?.Page?.media?.map((media: { coverImage?: { extraLarge?: string; large?: string } }) => media?.coverImage?.extraLarge || media?.coverImage?.large))
      if (next.length < 3) throw new Error('Not enough artwork')
      covers = next
      updatedAt = now()
      retryAt = 0
      try {
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile + '.tmp', JSON.stringify({ version: CACHE_VERSION, updatedAt, covers }), 'utf8')
        renameSync(cacheFile + '.tmp', cacheFile)
      } catch { /* Read-only persistence must not affect sign-in. */ }
      return covers
    } catch {
      retryAt = now() + RETRY_DELAY
      return []
    }
  }

  return {
    get(): Promise<string[]> {
      if (now() < retryAt) return Promise.resolve([])
      if (covers.length && now() - updatedAt < DAY) return Promise.resolve(covers)
      if (!pending) pending = refresh().finally(() => { pending = undefined })
      return pending
    },
  }
}
