import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything an app bundle needs from the Docker image it runs in. An in-app update
 * replaces the compiled server and frontend only; when any of these differ between
 * the running image and a release, that release needs a new image instead.
 */
export interface RuntimeIdentity {
  format: 1
  /** Node.js major version of the base image, for messages; `image` covers the exact setup. */
  node: string
  /** Dockerfile and entrypoint: base image, system packages, users, and startup. */
  image: string
  /** The supervisor that runs installed bundles; it lives in the image. */
  launcher: string
  /** Production packages installed into the image's node_modules, by name. */
  dependencies: Record<string, string>
}

export const RUNTIME_IDENTITY_FILE = 'runtime.json'

/** Release assets published by the release workflow (scripts/release-bundle.mjs). */
export const UPDATE_MANIFEST_ASSET = 'seadex-companion-update.json'
export const bundleAssetName = (version: string) => `seadex-companion-app-${version}.tar.gz`

const sha256 = (...parts: string[]) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part.replace(/\r\n/g, '\n')).update('\0')
  return hash.digest('hex')
}

/** Reads the identity from a source checkout (or a build stage holding the same files). */
export function computeRuntimeIdentity(root: string): RuntimeIdentity {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const dockerfile = read('Dockerfile')
  const lock = JSON.parse(read('package-lock.json')) as {
    packages?: Record<string, { version?: string; dev?: boolean }>
  }
  const dependencies: Record<string, string> = {}
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (!path.startsWith('node_modules/') || entry.dev) continue
    dependencies[path.slice('node_modules/'.length)] = String(entry.version || '')
  }
  return {
    format: 1,
    node: dockerfile.match(/^FROM\s+node:(\d+)/im)?.[1] || 'unknown',
    image: sha256(dockerfile, read('docker-entrypoint.sh')),
    launcher: sha256(read(join('server', 'launcher.ts'))),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  }
}

export function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  const record = value as Partial<RuntimeIdentity> | null
  return Boolean(
    record &&
    record.format === 1 &&
    typeof record.node === 'string' &&
    typeof record.image === 'string' &&
    typeof record.launcher === 'string' &&
    record.dependencies &&
    typeof record.dependencies === 'object',
  )
}

/** Explains, in user terms, why `required` cannot run on `installed`. Empty when compatible. */
export function runtimeDifferences(installed: RuntimeIdentity, required: unknown): string[] {
  if (!isRuntimeIdentity(required)) return ['This release describes its container requirements in a newer format.']
  const reasons: string[] = []
  if (installed.node !== required.node)
    reasons.push(`Node.js changes from version ${installed.node} to ${required.node}.`)
  else if (installed.image !== required.image) reasons.push('The container base system or startup script changes.')
  if (installed.launcher !== required.launcher) reasons.push('The built-in update launcher changes.')
  const names = new Set([...Object.keys(installed.dependencies), ...Object.keys(required.dependencies)])
  const changed: string[] = []
  let nativeChanged = false
  for (const name of [...names].sort()) {
    const before = installed.dependencies[name]
    const after = required.dependencies[name]
    if (before === after) continue
    // Platform binaries of a native package move with their parent package; don't list each one.
    if (/-(linux|darwin|win32|android|freebsd|wasm32)(-|$)/.test(name)) {
      nativeChanged = true
      continue
    }
    changed.push(
      before && after ? `${name} ${before} → ${after}` : after ? `${name} ${after} (new)` : `${name} (removed)`,
    )
  }
  if (changed.length)
    reasons.push(
      `Server dependencies change: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? `, and ${changed.length - 4} more` : ''}.`,
    )
  else if (nativeChanged) reasons.push('Native server components change.')
  return reasons
}
