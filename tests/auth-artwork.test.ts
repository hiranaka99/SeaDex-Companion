import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthArtworkCache } from '../server/auth-artwork.js'

const covers = [1, 2, 3].map(id => `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/${id}.jpg`)
const response = () => Response.json({ data: { Page: { media: covers.map(extraLarge => ({ coverImage: { extraLarge, large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/low-resolution.jpg' } })) } } })

test('public artwork shares refreshes, persists cache, and expires daily', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-art-'))
  try {
    let time = 1_000_000
    let calls = 0
    const fetcher: typeof fetch = async (_url, opts) => {
      calls++
      assert.match(String(opts?.body), /TRENDING_DESC/)
      assert.match(String(opts?.body), /extraLarge/)
      assert.match(String(opts?.body), /isAdult: false/)
      return response()
    }
    const file = join(dir, 'cache.json')
    // Older metadata must refresh immediately to pick up higher-resolution URLs.
    writeFileSync(file, JSON.stringify({ updatedAt: time, covers: ['https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/old.jpg'] }))
    const cache = createAuthArtworkCache(file, { fetch: fetcher, now: () => time })
    assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), [covers, covers, covers])
    assert.equal(calls, 1)
    const restarted = createAuthArtworkCache(file, { fetch: fetcher, now: () => time })
    assert.deepEqual(await restarted.get(), covers)
    assert.equal(calls, 1)
    time += 24 * 60 * 60 * 1000
    await restarted.get()
    assert.equal(calls, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('offline and unavailable AniList return bundled-art signal with retry backoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-art-'))
  try {
    let time = 1_000_000
    let calls = 0
    let online = false
    const cache = createAuthArtworkCache(join(dir, 'cache.json'), {
      now: () => time,
      fetch: async () => { calls++; if (!online) throw new Error('Offline'); return response() },
    })
    assert.deepEqual(await cache.get(), [])
    assert.deepEqual(await cache.get(), [])
    assert.equal(calls, 1)
    time += 30 * 60 * 1000
    online = true
    assert.deepEqual(await cache.get(), covers)
    time += 24 * 60 * 60 * 1000
    online = false
    assert.deepEqual(await cache.get(), [])
    assert.equal(calls, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bad cache, GraphQL errors, unavailable status and untrusted artwork never break sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seadex-art-'))
  try {
    const file = join(dir, 'cache.json')
    writeFileSync(file, 'bad json')
    for (const result of [new Response('', { status: 429 }), Response.json({ errors: [{ message: 'Unavailable' }] }), Response.json({ data: { Page: { media: [null, { coverImage: { large: 'https://evil.example/a.jpg' } }] } } })]) {
      const cache = createAuthArtworkCache(file, { fetch: async () => result })
      assert.deepEqual(await cache.get(), [])
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
