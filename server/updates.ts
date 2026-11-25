import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from './http-error.js'
import { api } from './http.js'
import {
  IMAGE_ROOT_ENV,
  LAUNCHER_ENV,
  VERSION_PATTERN,
  activeFile,
  bundleDir,
  compareVersions,
  failureFile,
  packageVersion,
  readActiveBundle,
  readJsonFile,
  updatesDir,
  writeJsonAtomic,
  type ActiveBundle,
  type BundleFailure,
} from './launcher.js'
import { log } from './logging.js'
import { BASE_DIR, DATA_DIR } from './paths.js'
import {
  RUNTIME_IDENTITY_FILE,
  UPDATE_MANIFEST_ASSET,
  bundleAssetName,
  isRuntimeIdentity,
  runtimeDifferences,
  type RuntimeIdentity,
} from './runtime-identity.js'
import { unpackTarGz } from './tar.js'
import { errorMessage } from '../shared/errors.js'
import type { UpdateInfo, UpdateInstallMode, UpdateStatus } from '../shared/update-contracts.js'

export { compareVersions }

export const APP_VERSION = packageVersion(BASE_DIR)

const RELEASES_URL = 'https://github.com/hiranaka99/SeaDex-Companion/releases'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/hiranaka99/SeaDex-Companion/releases/latest'
const UPDATE_CHECK_TTL = 60 * 60 * 1000
const UPDATE_CHECK_RETRY_TTL = 5 * 60 * 1000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

/** Release asset that describes the in-app update package and the image it needs. */
export interface UpdateManifest {
  format: 1
  version: string
  bundle: { name: string; size: number; sha256: string }
  runtime: RuntimeIdentity
}

type InstallMode = UpdateInstallMode

interface ReleaseAsset {
  name: string
  url: string
}

interface ReleaseCheck {
  latest: string | null
  url: string | null
  install: UpdateInfo['install']
  manifest: UpdateManifest | null
  assets: ReleaseAsset[]
}

const managed = () => process.env[LAUNCHER_ENV] === '1'
const imageRoot = () => process.env[IMAGE_ROOT_ENV] || BASE_DIR

function imageRuntime(): RuntimeIdentity | null {
  const value = readJsonFile(join(imageRoot(), RUNTIME_IDENTITY_FILE))
  return isRuntimeIdentity(value) ? value : null
}

export function isUpdateManifest(value: unknown): value is UpdateManifest {
  const record = value as Partial<UpdateManifest> | null
  return Boolean(
    record &&
    record.format === 1 &&
    typeof record.version === 'string' &&
    VERSION_PATTERN.test(record.version) &&
    record.bundle &&
    record.bundle.name === bundleAssetName(record.version) &&
    Number.isSafeInteger(record.bundle.size) &&
    record.bundle.size > 0 &&
    record.bundle.size <= MAX_BUNDLE_BYTES &&
    /^[0-9a-f]{64}$/.test(String(record.bundle.sha256)) &&
    isRuntimeIdentity(record.runtime),
  )
}

/** Decides how a newer release can be installed here. Pure, so the rules are testable. */
export function installPlan(input: {
  latest: string
  managed: boolean
  manifest: unknown
  manifestError?: string | null
  runtime: RuntimeIdentity | null
}): { mode: InstallMode; reasons: string[] } {
  if (!input.managed)
    return {
      mode: 'unavailable',
      reasons: [
        'This copy was not started from the SeaDex Companion Docker image, so it cannot replace its own files.',
      ],
    }
  if (input.manifestError)
    return { mode: 'unavailable', reasons: [`Could not read the update package: ${input.manifestError}`] }
  if (input.manifest === null)
    return { mode: 'image_required', reasons: ['This release does not include an in-app update package.'] }
  if (!isUpdateManifest(input.manifest) || input.manifest.version !== input.latest)
    return { mode: 'unavailable', reasons: ['The update package description for this release is invalid.'] }
  if (!input.runtime)
    return { mode: 'image_required', reasons: ['The running Docker image does not describe its runtime.'] }
  const reasons = runtimeDifferences(input.runtime, input.manifest.runtime)
  return reasons.length ? { mode: 'image_required', reasons } : { mode: 'in_app', reasons: [] }
}

async function download(url: string, maxBytes: number, timeout: number): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new Error('Release asset URL must use HTTPS')
  // Asset links redirect to GitHub's download host; no credentials are sent anywhere.
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (!response.url.startsWith('https://')) throw new Error('Release asset was redirected away from HTTPS')
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('Release asset is too large')
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body?.getReader()
  for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
    total += read.value.length
    if (total > maxBytes) {
      await reader?.cancel()
      throw new Error('Release asset is too large')
    }
    chunks.push(Buffer.from(read.value))
  }
  return Buffer.concat(chunks)
}

async function checkRelease(): Promise<{ check: ReleaseCheck; ttl: number }> {
  const none: ReleaseCheck = { latest: null, url: null, install: null, manifest: null, assets: [] }
  let release: any
  try {
    release = await api(GITHUB_RELEASES_URL)
  } catch {
    /* GitHub unreachable or rate limited; keep reporting up to date. */
    return { check: none, ttl: UPDATE_CHECK_RETRY_TTL }
  }
  const tag = String(release?.tag_name || '').replace(/^v/, '')
  if (!tag || !VERSION_PATTERN.test(tag) || compareVersions(tag, APP_VERSION) <= 0)
    return { check: none, ttl: UPDATE_CHECK_TTL }
  const assets: ReleaseAsset[] = (Array.isArray(release.assets) ? release.assets : [])
    .map((asset: any) => ({ name: String(asset?.name || ''), url: String(asset?.browser_download_url || '') }))
    .filter((asset: ReleaseAsset) => asset.name && asset.url)
  const manifestAsset = assets.find(asset => asset.name === UPDATE_MANIFEST_ASSET)
  let manifest: unknown = null
  let manifestError: string | null = null
  if (managed() && manifestAsset) {
    try {
      manifest = JSON.parse((await download(manifestAsset.url, MAX_MANIFEST_BYTES, 30_000)).toString('utf8'))
    } catch (error) {
      manifestError = errorMessage(error)
    }
  }
  const install = installPlan({ latest: tag, managed: managed(), manifest, manifestError, runtime: imageRuntime() })
  return {
    check: {
      latest: tag,
      url: String(release.html_url || RELEASES_URL),
      install,
      manifest: install.mode === 'in_app' ? (manifest as UpdateManifest) : null,
      assets,
    },
    // Recheck soon when the package is missing or unreadable: release assets upload after publication.
    ttl: install.mode === 'in_app' || !managed() ? UPDATE_CHECK_TTL : UPDATE_CHECK_RETRY_TTL,
  }
}

let updateCheck: { check: ReleaseCheck; at: number; ttl: number } | null = null
let updateCheckInFlight: Promise<ReleaseCheck> | null = null

export function resetUpdateCheck(): void {
  updateCheck = null
  updateCheckInFlight = null
}

async function cachedRelease(fresh = false): Promise<ReleaseCheck> {
  if (!fresh && updateCheck && Date.now() - updateCheck.at < updateCheck.ttl) return updateCheck.check
  if (!updateCheckInFlight) {
    updateCheckInFlight = checkRelease()
      .then(({ check, ttl }) => {
        updateCheck = { check, at: Date.now(), ttl }
        return check
      })
      .finally(() => {
        updateCheckInFlight = null
      })
  }
  return updateCheckInFlight
}

/** The last failed install, while it still explains why the app is older than the release. */
function lastFailure(): BundleFailure | null {
  const value = readJsonFile(failureFile(DATA_DIR)) as Partial<BundleFailure> | null
  if (!value || typeof value.version !== 'string' || compareVersions(value.version, APP_VERSION) <= 0) return null
  return {
    version: value.version,
    restored: String(value.restored || ''),
    reason: String(value.reason || ''),
    at: String(value.at || ''),
  }
}

export function updateStatus(): UpdateStatus {
  return {
    current: APP_VERSION,
    image: packageVersion(imageRoot()),
    managed: managed(),
    last_failure: lastFailure(),
  }
}

/**
 * Checks the GitHub releases API for a newer version and how it can be installed.
 * Results are cached for an hour (five minutes after a failure) so the endpoint stays
 * cheap under UI polling; a GitHub outage never surfaces as an error, it just reports
 * no update.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const check = await cachedRelease()
  return { ...updateStatus(), latest: check.latest, url: check.url, install: check.install }
}

/** Lays out a verified bundle beside the active one; the launcher switches on restart. */
function stageBundle(manifest: UpdateManifest, archive: Buffer): void {
  const entries = unpackTarGz(archive)
  const files = new Map(entries.map(entry => [entry.path, entry.data]))
  for (const entry of entries) {
    const top = entry.path.split('/')[0]
    if (!['package.json', RUNTIME_IDENTITY_FILE, 'dist', 'static'].includes(top))
      throw new Error(`Unexpected file in update package: ${entry.path}`)
  }
  const pkg = JSON.parse(files.get('package.json')?.toString('utf8') || '{}')
  if (pkg.version !== manifest.version) throw new Error('Update package version does not match the release')
  if (!files.has('dist/server/index.js') || !files.has('static/index.html'))
    throw new Error('Update package is incomplete')
  const runtime = JSON.parse(files.get(RUNTIME_IDENTITY_FILE)?.toString('utf8') || 'null')
  if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime))
    throw new Error('Update package runtime does not match its description')
  const target = bundleDir(DATA_DIR, manifest.version)
  const staging = join(updatesDir(DATA_DIR), `.staging-${manifest.version}-${randomBytes(4).toString('hex')}`)
  try {
    for (const entry of entries) {
      const path = join(staging, ...entry.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, entry.data)
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

let installing = false

/**
 * Downloads, verifies, and stages the latest release, then points the launcher at it.
 * The caller restarts the server once the response is sent.
 */
export async function installUpdate(): Promise<{ version: string }> {
  if (!managed())
    throw new HttpError(409, 'In-app updates are available only when SeaDex Companion runs from its Docker image')
  if (installing) throw new HttpError(409, 'An update is already being installed')
  installing = true
  try {
    const check = await cachedRelease(true)
    if (!check.latest) throw new HttpError(409, 'SeaDex Companion is already up to date')
    if (check.install?.mode !== 'in_app' || !check.manifest)
      throw new HttpError(409, check.install?.reasons[0] || 'This release cannot be installed in-app', {
        install: check.install,
      })
    const manifest = check.manifest
    const asset = check.assets.find(item => item.name === manifest.bundle.name)
    if (!asset) throw new HttpError(409, 'This release does not include its update package')
    log('INFO', `Downloading update v${manifest.version} (${manifest.bundle.size} bytes)`)
    let archive: Buffer
    try {
      archive = await download(asset.url, MAX_BUNDLE_BYTES, 5 * 60_000)
    } catch (error) {
      throw new HttpError(502, `Could not download the update: ${errorMessage(error)}`)
    }
    if (
      archive.length !== manifest.bundle.size ||
      createHash('sha256').update(archive).digest('hex') !== manifest.bundle.sha256
    )
      throw new HttpError(502, 'The downloaded update did not match its checksum; nothing was changed')
    try {
      stageBundle(manifest, archive)
    } catch (error) {
      throw new HttpError(502, `Could not install the update: ${errorMessage(error)}`)
    }
    const running = readActiveBundle(DATA_DIR)
    writeJsonAtomic(activeFile(DATA_DIR), {
      version: manifest.version,
      previous: running?.version === APP_VERSION ? APP_VERSION : null,
      pending: true,
      installed_at: new Date().toISOString(),
    } satisfies ActiveBundle)
    rmSync(failureFile(DATA_DIR), { force: true })
    log('INFO', `Update v${manifest.version} installed; restarting to apply it`)
    return { version: manifest.version }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    log('WARNING', `In-app update refused: ${error.message}`)
    throw error
  } finally {
    installing = false
  }
}

/** Logs which copy is running and any rollback, so the Server log explains a version change. */
export function reportUpdateState(): void {
  if (!managed()) return
  const status = updateStatus()
  if (status.current !== status.image)
    log('INFO', `Running in-app update v${status.current} on Docker image v${status.image}`)
  const failure = status.last_failure
  if (failure && failure.restored === APP_VERSION)
    log('WARNING', `Update v${failure.version} ${failure.reason}; SeaDex Companion returned to v${failure.restored}`)
}
