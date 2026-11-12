import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DEFAULT_CONFIG } from '../server/config.js'
import { qbAddTorrent, qbControlTorrents, qbGetTorrents, resetQbRuntime } from '../server/qbittorrent.js'

const config = { ...DEFAULT_CONFIG, qbittorrent_url: 'http://qbit.test', qbittorrent_user: 'user', qbittorrent_pass: 'password' }
const hash = 'a'.repeat(40)
const otherHash = 'b'.repeat(40)
const requestCookie = (init?: RequestInit) => new Headers(init?.headers).get('Cookie')

describe('qBittorrent session cookies', () => {
  let originalFetch: typeof fetch
  beforeEach(() => { originalFetch = globalThis.fetch; resetQbRuntime() })
  afterEach(() => { globalThis.fetch = originalFetch; resetQbRuntime() })

  test('whitelisted polling reuses replacement sessions without evicting an idle browser', async () => {
    const sessions = new Set(['SID=browser'])
    let created = 0, logins = 0
    const createSession = () => {
      if (sessions.size >= 15) sessions.delete(sessions.values().next().value!)
      const cookie = `SID=companion-${++created}`
      sessions.add(cookie)
      return cookie
    }
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) {
        logins++
        return new Response('Ok.', { headers: { 'Set-Cookie': `${createSession()}; Path=/; HttpOnly` } })
      }
      const cookie = requestCookie(init) || ''
      const headers = new Headers()
      if (!sessions.has(cookie)) headers.set('Set-Cookie', `${createSession()}; Path=/; HttpOnly`)
      else { sessions.delete(cookie); sessions.add(cookie) }
      return Response.json([{ hash }], { headers })
    }) as typeof fetch

    await qbGetTorrents(config)
    sessions.delete('SID=companion-1') // Expired or evicted while SeaDex kept its cookie.
    for (let poll = 0; poll < 40; poll++) {
      assert.deepEqual(await qbGetTorrents(config, undefined, true), [{ hash }])
    }
    assert.equal(created, 2, 'Only one replacement session should be created')
    assert.equal(logins, 1, 'Successful whitelist recovery should not require another login')
    assert.ok(sessions.has('SID=browser'), 'Polling must not fill the session limit and evict the browser')
  })

  test('preserves multiple cookies, custom session names, and values containing equals signs', async () => {
    let requests = 0
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) {
        const headers = new Headers()
        headers.append('Set-Cookie', 'route=backend; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT')
        headers.append('Set-Cookie', 'CUSTOM_QBT=session==; Path=/; HttpOnly; Secure')
        return new Response('Ok.', { headers })
      }
      requests++
      assert.equal(requestCookie(init), requests === 1 ? 'route=backend; CUSTOM_QBT=session==' : 'route=backend; CUSTOM_QBT=replacement==')
      const headers = new Headers()
      if (requests === 1) {
        headers.append('Set-Cookie', 'CUSTOM_QBT=replacement==; Path=/; HttpOnly')
        headers.append('Set-Cookie', 'route=backend; Path=/')
      }
      return Response.json([{ hash }], { headers })
    }) as typeof fetch

    for (let poll = 0; poll < 3; poll++) await qbGetTorrents(config, undefined, true)
    assert.equal(requests, 3)
  })

  test('accepts a session cookie from a response after a cookie-less 204 login', async () => {
    let requests = 0
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) return new Response(null, { status: 204 })
      requests++
      assert.equal(requestCookie(init), requests === 1 ? null : 'SID=recovered')
      return Response.json([{ hash }], { headers: requests === 1 ? { 'Set-Cookie': 'SID=recovered; Path=/' } : {} })
    }) as typeof fetch

    await qbGetTorrents(config)
    await qbGetTorrents(config, undefined, true)
  })

  test('uses updated cookies throughout selected-file downloads and torrent controls', async () => {
    let expectedCookie = 'SID=login', requests = 0
    const paths: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/auth/login')) return new Response('Ok.', { headers: { 'Set-Cookie': expectedCookie } })
      assert.equal(requestCookie(init), expectedCookie)
      expectedCookie = `SID=rotated-${++requests}`
      const headers = { 'Set-Cookie': `${expectedCookie}; Path=/; HttpOnly` }
      paths.push(url.pathname)
      if (url.pathname.endsWith('/torrents/info')) return Response.json([], { headers })
      if (url.pathname.endsWith('/torrents/files')) return Response.json([{ index: 0, name: 'episode.mkv' }], { headers })
      if (url.pathname.endsWith('/torrents/stop')) return new Response('Not Found', { status: 404, headers })
      return new Response('Ok.', { headers })
    }) as typeof fetch

    await qbAddTorrent(config, `magnet:?xt=urn:btih:${hash}`, 'anime', ['episode.mkv'])
    await qbControlTorrents(config, [hash], 'pause')
    await qbControlTorrents(config, [hash], 'resume')
    await qbControlTorrents(config, [hash], 'remove', false)
    assert.equal(paths.filter(path => path.endsWith('/filePrio')).length, 2)
    assert.equal(paths.filter(path => path.endsWith('/pause')).length, 2, 'Legacy endpoint fallback must also retain replacement cookies')
    assert.equal(paths.at(-1), '/api/v2/torrents/delete')
  })

  test('shares login and one recovery login across concurrent forbidden responses', async () => {
    let logins = 0, forbidden = 0
    let bothForbidden!: () => void
    const ready = new Promise<void>(resolve => { bothForbidden = resolve })
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) {
        return new Response('Ok.', { headers: { 'Set-Cookie': `SID=login-${++logins}` } })
      }
      if (requestCookie(init) === 'SID=login-1') {
        if (++forbidden === 2) bothForbidden()
        await ready
        return new Response('Forbidden', { status: 403 })
      }
      assert.equal(requestCookie(init), 'SID=login-2')
      return new Response('Ok.')
    }) as typeof fetch

    await Promise.all([qbControlTorrents(config, [hash], 'pause'), qbControlTorrents(config, [otherHash], 'resume')])
    assert.equal(logins, 2)
    assert.equal(forbidden, 2)
  })

  test('does not overwrite a newer cookie when an older successful response arrives late', async () => {
    let finishOld!: (response: Response) => void, entered!: () => void
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const cookies: (string | null)[] = []
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=old' } })
      cookies.push(requestCookie(init))
      if (String(input).endsWith('/torrents/stop')) { entered(); return oldResponse }
      if (String(input).endsWith('/torrents/info')) return Response.json([{ hash }], { headers: { 'Set-Cookie': 'SID=new; Path=/' } })
      return new Response('Ok.')
    }) as typeof fetch

    const pending = qbControlTorrents(config, [hash], 'pause')
    try {
      await ready
      await qbGetTorrents(config)
    } finally {
      finishOld(new Response('Ok.', { headers: { 'Set-Cookie': 'SID=obsolete; Path=/' } }))
      await pending
    }
    await qbControlTorrents(config, [hash], 'resume')
    assert.deepEqual(cookies, ['SID=old', 'SID=old', 'SID=new'])
  })

  test('retries with an already refreshed cookie when an older forbidden response arrives late', async () => {
    let finishOld!: (response: Response) => void, entered!: () => void
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    let logins = 0
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/auth/login')) {
        logins++
        return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=old' } })
      }
      if (String(input).endsWith('/torrents/stop') && requestCookie(init) === 'SID=old') { entered(); return oldResponse }
      if (String(input).endsWith('/torrents/info')) return Response.json([{ hash }], { headers: { 'Set-Cookie': 'SID=new' } })
      assert.equal(requestCookie(init), 'SID=new')
      return new Response('Ok.')
    }) as typeof fetch

    const pending = qbControlTorrents(config, [hash], 'pause')
    try {
      await ready
      await qbGetTorrents(config)
    } finally {
      finishOld(new Response('Forbidden', { status: 403 }))
      await pending
    }
    assert.equal(logins, 1)
  })

  test('retries forbidden requests only once and recovers after a failed login', async () => {
    let logins = 0, requests = 0
    globalThis.fetch = (async input => {
      if (String(input).endsWith('/auth/login')) {
        logins++
        return new Response(logins === 1 ? 'Fails.' : 'Ok.', { headers: { 'Set-Cookie': `SID=${logins}` } })
      }
      requests++
      return new Response('Forbidden', { status: 403 })
    }) as typeof fetch

    await assert.rejects(qbGetTorrents(config), /login failed/)
    await assert.rejects(qbGetTorrents(config), /HTTP 403/)
    assert.equal(logins, 3)
    assert.equal(requests, 2, 'An unrecoverable 403 must not cause an unbounded retry loop')
  })
})
