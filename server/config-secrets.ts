import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ENCRYPTED_SECRETS_FILE, SECRETS_KEY_FILE } from './paths.js'
import { readJson } from './persistence.js'
import { log } from './logging.js'
import { SECRET_CONFIG_KEYS, type SecretConfigKey } from '../shared/contracts.js'
import type { JsonObject } from './types.js'

// Credentials are stored AES-256-GCM encrypted under a key file kept next to the data.

export interface EncryptedSecretsPayload {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

const SECRETS_AAD = Buffer.from('seadex-companion:secrets:v1', 'utf8')

export function loadSecretKey(createIfMissing = false): Buffer {
  if (!existsSync(SECRETS_KEY_FILE)) {
    if (!createIfMissing) {
      throw new Error(
        `Encryption key file not found: ${SECRETS_KEY_FILE}. Restore the key used to encrypt the existing credentials.`,
      )
    }
    mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true })
    try {
      writeFileSync(SECRETS_KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 })
      log('INFO', `Generated credential encryption key: ${SECRETS_KEY_FILE}`)
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  const raw = readFileSync(SECRETS_KEY_FILE)
  const text = raw.toString('utf8').trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64')
    if (decoded.length === 32) return decoded
  }
  if (raw.length === 32) return raw
  throw new Error(
    `Invalid encryption key in ${SECRETS_KEY_FILE}: expected 32 raw bytes, 64 hex characters, or base64 for 32 bytes`,
  )
}

export function encryptSecretValues(
  secrets: Partial<Record<SecretConfigKey, string>>,
  key: Buffer,
): EncryptedSecretsPayload {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte encryption key')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(SECRETS_AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSecretValues(
  payload: EncryptedSecretsPayload,
  key: Buffer,
): Partial<Record<SecretConfigKey, string>> {
  if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm')
    throw new Error('Unsupported encrypted secrets format')
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte encryption key')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
    decipher.setAAD(SECRETS_AAD)
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(plaintext) as JsonObject
    const secrets: Partial<Record<SecretConfigKey, string>> = {}
    for (const keyName of SECRET_CONFIG_KEYS)
      if (typeof parsed[keyName] === 'string') secrets[keyName] = parsed[keyName]
    return secrets
  } catch {
    throw new Error('Could not decrypt secrets: the key is incorrect or the encrypted file is damaged')
  }
}

/** Credentials from the separate file older versions wrote; read only until the configuration is migrated. */
export function loadEncryptedSecrets(): Partial<Record<SecretConfigKey, string>> {
  if (!existsSync(ENCRYPTED_SECRETS_FILE)) return {}
  const payload = readJson<EncryptedSecretsPayload | null>(ENCRYPTED_SECRETS_FILE, null)
  if (!payload) throw new Error(`Could not read encrypted secrets file: ${ENCRYPTED_SECRETS_FILE}`)
  return decryptSecretValues(payload, loadSecretKey())
}
