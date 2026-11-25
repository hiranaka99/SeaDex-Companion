import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import {
  AuthError,
  authState,
  expiredSessionCookie,
  login,
  logout,
  sessionCookie,
  setupAccount,
  updateAccount,
  verifyLoginCredentials,
} from './auth.js'
import { createAuthArtworkCache } from './auth-artwork.js'
import { clientAddress, readJson, sendJson } from './http-response.js'
import { log } from './logging.js'
import { DATA_DIR } from './paths.js'
import { route, type Route, type RouteContext } from './router.js'

const authArtwork = createAuthArtworkCache(resolve(DATA_DIR, 'auth-artwork.json'))

/** Webhook senders authenticate with the administrator's credentials over HTTP Basic. */
export async function authenticateBasic(request: IncomingMessage): Promise<void> {
  const authorization = String(request.headers.authorization || '')
  const decoded = authorization.startsWith('Basic ')
    ? Buffer.from(authorization.slice(6), 'base64').toString('utf8')
    : ''
  const separator = decoded.indexOf(':')
  if (separator < 0) throw new AuthError(401, 'SeaDex login credentials required')
  await verifyLoginCredentials(request, decoded.slice(0, separator), decoded.slice(separator + 1))
}

/** Answers with the signed-in state and the session cookie that goes with it. */
function sendSession(
  { request, response }: RouteContext,
  status: number,
  session: { username: string; token: string },
): void {
  sendJson(
    response,
    status,
    { setup_required: false, authenticated: true, username: session.username },
    { 'Set-Cookie': sessionCookie(request, session.token) },
  )
}

export const authRoutes: Route[] = [
  route('GET', '/api/auth/status', ({ request, response }) => sendJson(response, 200, authState(request)), 'public'),
  route(
    'GET',
    '/api/auth/artwork',
    async ({ response }) => sendJson(response, 200, { covers: await authArtwork.get() }),
    'public',
  ),
  route(
    'POST',
    '/api/auth/setup',
    async context => {
      const data = await readJson(context.request)
      const session = await setupAccount(context.request, data.username, data.password)
      log('INFO', `Administrator account created: ${session.username} (client: ${clientAddress(context.request)})`)
      sendSession(context, 201, session)
    },
    'public',
  ),
  route(
    'POST',
    '/api/auth/login',
    async context => {
      const data = await readJson(context.request)
      const session = await login(context.request, data.username, data.password)
      log('INFO', `Login successful: ${session.username} (client: ${clientAddress(context.request)})`)
      sendSession(context, 200, session)
    },
    'public',
  ),
  route(
    'POST',
    '/api/auth/logout',
    ({ request, response }) => {
      const username = authState(request).username
      logout(request)
      log('INFO', `Logout${username ? `: ${username}` : ''} (client: ${clientAddress(request)})`)
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': expiredSessionCookie(request) })
    },
    'public',
  ),
  route('POST', '/api/auth/account', async context => {
    const data = await readJson(context.request)
    const session = await updateAccount(context.request, data.current_password, data.username, data.new_password)
    log(
      'INFO',
      `Administrator account updated: ${session.username}; all other sessions revoked (client: ${clientAddress(context.request)})`,
    )
    sendSession(context, 200, session)
  }),
]
