import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './app.js'

export const AUTH_FILE = join(DATA_DIR, 'auth.json')

const SESSION_COOKIE = 'seadex_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_ATTEMPTS_PER_WINDOW = 5

interface AuthRecord {
  version: 1
  username: string
  salt: string
  password_hash: string
}

interface Session {
  username: string
  expiresAt: number
}

interface LoginLimit {
  attempts: number
  resetAt: number
}

export interface AuthState {
  setup_required: boolean
  authenticated: boolean
  username: string | null
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const sessions = new Map<string, Session>()
const loginLimits = new Map<string, LoginLimit>()

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function validateCredentials(usernameValue: unknown, passwordValue: unknown): { username: string; password: string } {
  const username = String(usernameValue ?? '').trim()
  const password = String(passwordValue ?? '')
  if (username.length < 3 || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new AuthError(400, 'Username must be between 3 and 64 characters')
  }
  if (password.length < 10) throw new AuthError(400, 'Password must contain at least 10 characters')
  if (password.length > 1024) throw new AuthError(400, 'Password is too long')
  return { username, password }
}

function loadAuthRecord(): AuthRecord {
  let parsed: Partial<AuthRecord>
  try {
    parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Partial<AuthRecord>
  } catch {
    throw new AuthError(500, 'Could not read the authentication file')
  }
  if (parsed.version !== 1 || typeof parsed.username !== 'string' || typeof parsed.salt !== 'string' || typeof parsed.password_hash !== 'string') {
    throw new AuthError(500, 'The authentication file is invalid')
  }
  return parsed as AuthRecord
}

function requestToken(request: IncomingMessage): string | null {
  const header = request.headers.cookie || ''
  for (const part of header.split(';')) {
    const [name, ...valueParts] = part.trim().split('=')
    if (name !== SESSION_COOKIE) continue
    try { return decodeURIComponent(valueParts.join('=')) }
    catch { return null }
  }
  return null
}

function authenticatedUsername(request: IncomingMessage): string | null {
  if (!existsSync(AUTH_FILE)) return null
  const token = requestToken(request)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  session.expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  return session.username
}

function createSession(username: string): string {
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 })
  return token
}

function requestAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown'
}

function checkLoginLimit(address: string): void {
  const now = Date.now()
  const limit = loginLimits.get(address)
  if (!limit || limit.resetAt <= now) {
    loginLimits.delete(address)
    return
  }
  if (limit.attempts >= LOGIN_ATTEMPTS_PER_WINDOW) {
    const minutes = Math.max(1, Math.ceil((limit.resetAt - now) / 60_000))
    throw new AuthError(429, `Too many login attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
  }
}

function recordFailedLogin(address: string): void {
  const now = Date.now()
  const current = loginLimits.get(address)
  if (!current || current.resetAt <= now) {
    loginLimits.set(address, { attempts: 1, resetAt: now + LOGIN_WINDOW_MS })
  } else {
    current.attempts += 1
  }
}

export function authState(request: IncomingMessage): AuthState {
  const setupRequired = !existsSync(AUTH_FILE)
  const username = setupRequired ? null : authenticatedUsername(request)
  return { setup_required: setupRequired, authenticated: username !== null, username }
}

export function isAuthenticated(request: IncomingMessage): boolean {
  return authenticatedUsername(request) !== null
}

export async function setupAccount(usernameValue: unknown, passwordValue: unknown): Promise<{ token: string; username: string }> {
  if (existsSync(AUTH_FILE)) throw new AuthError(409, 'An administrator account already exists')
  const { username, password } = validateCredentials(usernameValue, passwordValue)
  const salt = randomBytes(16)
  const passwordHash = await derivePassword(password, salt)
  const record: AuthRecord = {
    version: 1,
    username,
    salt: salt.toString('base64'),
    password_hash: passwordHash.toString('base64'),
  }
  mkdirSync(dirname(AUTH_FILE), { recursive: true })
  try {
    writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new AuthError(409, 'An administrator account already exists')
    throw error
  }
  return { token: createSession(username), username }
}

export async function login(request: IncomingMessage, usernameValue: unknown, passwordValue: unknown): Promise<{ token: string; username: string }> {
  if (!existsSync(AUTH_FILE)) throw new AuthError(409, 'Create the administrator account first')
  const address = requestAddress(request)
  checkLoginLimit(address)
  const username = String(usernameValue ?? '').trim()
  const password = String(passwordValue ?? '')
  const record = loadAuthRecord()
  const actualHash = await derivePassword(password, Buffer.from(record.salt, 'base64'))
  const expectedHash = Buffer.from(record.password_hash, 'base64')
  const validHash = actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash)
  if (username !== record.username || !validHash) {
    recordFailedLogin(address)
    throw new AuthError(401, 'Invalid username or password')
  }
  loginLimits.delete(address)
  return { token: createSession(record.username), username: record.username }
}

export async function updateAccount(request: IncomingMessage, currentPasswordValue: unknown, usernameValue: unknown, newPasswordValue: unknown): Promise<{ token: string; username: string }> {
  const activeUsername = authenticatedUsername(request)
  if (!activeUsername) throw new AuthError(401, 'Authentication required')
  const currentPassword = String(currentPasswordValue ?? '')
  if (!currentPassword) throw new AuthError(400, 'Current password is required')
  const current = loadAuthRecord()
  const actualHash = await derivePassword(currentPassword, Buffer.from(current.salt, 'base64'))
  const expectedHash = Buffer.from(current.password_hash, 'base64')
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new AuthError(401, 'Current password is incorrect')
  }
  const requestedPassword = String(newPasswordValue ?? '')
  const { username, password } = validateCredentials(usernameValue, requestedPassword || currentPassword)
  const salt = randomBytes(16)
  const passwordHash = await derivePassword(password, salt)
  const record: AuthRecord = {
    version: 1,
    username,
    salt: salt.toString('base64'),
    password_hash: passwordHash.toString('base64'),
  }
  const temporary = `${AUTH_FILE}.tmp`
  writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, AUTH_FILE)
  chmodSync(AUTH_FILE, 0o600)
  sessions.clear()
  return { token: createSession(username), username }
}

export function logout(request: IncomingMessage): void {
  const token = requestToken(request)
  if (token) sessions.delete(token)
}

function requestIsSecure(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return protocol?.split(',')[0]?.trim().toLowerCase() === 'https' || Boolean((request.socket as any).encrypted)
}

export function sessionCookie(request: IncomingMessage, token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${requestIsSecure(request) ? '; Secure' : ''}`
}

export function expiredSessionCookie(request: IncomingMessage): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${requestIsSecure(request) ? '; Secure' : ''}`
}
