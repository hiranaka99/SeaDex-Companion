/**
 * Supervisor that the Docker image starts instead of the server. It runs either the
 * app built into the image or a newer app bundle installed in-app under
 * DATA_DIR/app-updates, restarts the server when it asks to, and returns to the
 * previous copy when a newly installed bundle fails before it finishes starting.
 *
 * This file is part of the container runtime: it must import only Node built-ins,
 * because the release fingerprint hashes it alone (see runtime-identity.ts).
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Exit code the server uses to ask for a relaunch (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75
export const LAUNCHER_ENV = 'SEADEX_LAUNCHER'
export const IMAGE_ROOT_ENV = 'SEADEX_IMAGE_ROOT'
export const READY_MESSAGE = 'seadex:ready'
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/

export interface ActiveBundle {
  version: string
  /** Bundle to return to if this one fails to start; null means the image's own app. */
  previous: string | null
  /** True until the bundle has started successfully once. */
  pending: boolean
  installed_at: string
}

export interface BundleFailure {
  version: string
  restored: string
  reason: string
  at: string
}

export const updatesDir = (dataDir: string) => join(dataDir, 'app-updates')
export const bundleDir = (dataDir: string, version: string) => join(updatesDir(dataDir), version)
export const activeFile = (dataDir: string) => join(updatesDir(dataDir), 'active.json')
export const failureFile = (dataDir: string) => join(updatesDir(dataDir), 'last-failure.json')

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(part => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n')
  renameSync(temporary, path)
}

export function readActiveBundle(dataDir: string): ActiveBundle | null {
  const value = readJsonFile(activeFile(dataDir)) as Partial<ActiveBundle> | null
  if (!value || typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) return null
  const previous = typeof value.previous === 'string' && VERSION_PATTERN.test(value.previous) ? value.previous : null
  return {
    version: value.version,
    previous,
    pending: value.pending === true,
    installed_at: String(value.installed_at || ''),
  }
}

export const packageVersion = (root: string) =>
  String((readJsonFile(join(root, 'package.json')) as { version?: unknown } | null)?.version || '0.0.0')

const runtimeOf = (root: string) => {
  const value = readJsonFile(join(root, 'runtime.json'))
  return value ? JSON.stringify(value) : null
}

/** Why a bundle cannot run on this image, or null when it can. */
export function bundleProblem(imageRoot: string, dataDir: string, version: string): string | null {
  const dir = bundleDir(dataDir, version)
  if (!existsSync(join(dir, 'dist', 'server', 'index.js'))) return 'its files are missing'
  if (packageVersion(dir) !== version) return 'its files belong to another version'
  if (compareVersions(version, packageVersion(imageRoot)) <= 0)
    return 'the Docker image is already this version or newer'
  const image = runtimeOf(imageRoot)
  if (!image) return 'this image does not describe its runtime'
  if (runtimeOf(dir) !== image) return 'it was built for a different Docker image'
  return null
}

interface AppChoice {
  version: string
  root: string
  bundle: ActiveBundle | null
}

const say = (level: 'INFO' | 'WARNING' | 'ERROR', message: string) =>
  process.stdout.write(`${new Date().toISOString()} [${level}] launcher: ${message}\n`)

/** Removes bundles nothing points to, and the active pointer when it cannot run here. */
function chooseApp(imageRoot: string, dataDir: string): AppChoice {
  const image: AppChoice = { version: packageVersion(imageRoot), root: imageRoot, bundle: null }
  const active = readActiveBundle(dataDir)
  let choice = image
  if (active) {
    const problem = bundleProblem(imageRoot, dataDir, active.version)
    if (problem) {
      say(
        'INFO',
        `Not using installed update v${active.version}: ${problem}. Starting v${image.version} from the image.`,
      )
      rmSync(activeFile(dataDir), { force: true })
    } else choice = { version: active.version, root: bundleDir(dataDir, active.version), bundle: active }
  }
  const keep = new Set(choice.bundle ? [choice.bundle.version, choice.bundle.previous] : [])
  try {
    for (const entry of readdirSync(updatesDir(dataDir), { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name))
        rmSync(join(updatesDir(dataDir), entry.name), { recursive: true, force: true })
    }
  } catch {
    /* No updates have been installed. */
  }
  if (choice.bundle) {
    // Bundles carry no dependencies; they resolve the image's packages through this link.
    const modules = join(choice.root, 'node_modules')
    if (!existsSync(modules)) symlinkSync(join(imageRoot, 'node_modules'), modules, 'junction')
  }
  return choice
}

function rollBack(dataDir: string, imageRoot: string, failed: ActiveBundle, reason: string): void {
  const previous = failed.previous && !bundleProblem(imageRoot, dataDir, failed.previous) ? failed.previous : null
  const restored = previous || packageVersion(imageRoot)
  if (previous)
    writeJsonAtomic(activeFile(dataDir), {
      version: previous,
      previous: null,
      pending: false,
      installed_at: new Date().toISOString(),
    } satisfies ActiveBundle)
  else rmSync(activeFile(dataDir), { force: true })
  rmSync(bundleDir(dataDir, failed.version), { recursive: true, force: true })
  writeJsonAtomic(failureFile(dataDir), {
    version: failed.version,
    restored,
    reason,
    at: new Date().toISOString(),
  } satisfies BundleFailure)
  say('ERROR', `Update v${failed.version} ${reason}. Returning to v${restored}.`)
}

async function main(): Promise<void> {
  const imageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const dataDir = resolve(process.env.DATA_DIR || imageRoot)
  let stopping = false
  let child: ReturnType<typeof spawn> | null = null
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopping = true
      if (child && child.exitCode === null) child.kill(signal)
      else process.exit(0)
    })
  }
  const restarts: number[] = []
  for (;;) {
    const choice = chooseApp(imageRoot, dataDir)
    say('INFO', `Starting SeaDex Companion v${choice.version}${choice.bundle ? ' (installed update)' : ''}`)
    let ready = false
    const started = spawn(process.execPath, [join(choice.root, 'dist', 'server', 'index.js')], {
      cwd: choice.root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        [LAUNCHER_ENV]: '1',
        [IMAGE_ROOT_ENV]: imageRoot,
        ...(choice.bundle ? { STATIC_DIR: join(choice.root, 'static') } : {}),
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      // Its own process group: a terminal Ctrl+C reaches the server once, through the forwarder above.
      detached: process.platform !== 'win32',
    })
    child = started
    started.on('message', message => {
      if ((message as { type?: unknown } | null)?.type !== READY_MESSAGE || ready) return
      ready = true
      const active = readActiveBundle(dataDir)
      if (choice.bundle?.pending && active?.version === choice.version)
        writeJsonAtomic(activeFile(dataDir), { ...active, pending: false })
    })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
      started.once('error', error => {
        say('ERROR', `Could not start the server: ${error.message}`)
        done({ code: 1, signal: null })
      })
      started.once('exit', (code, signal) => done({ code, signal }))
    })
    child = null
    const code = exit.code ?? (exit.signal ? 128 + (constants.signals[exit.signal] ?? 0) : 1)
    if (stopping) process.exit(exit.signal === 'SIGTERM' || exit.signal === 'SIGINT' ? 0 : code)
    if (code === RESTART_EXIT_CODE) {
      const now = Date.now()
      restarts.push(now)
      while (restarts.length && now - restarts[0] > 60_000) restarts.shift()
      if (restarts.length <= 5) continue
      say('ERROR', 'The server asked to restart too often; stopping.')
      process.exit(1)
    }
    if (choice.bundle?.pending && !ready) {
      rollBack(dataDir, imageRoot, choice.bundle, `stopped before it finished starting (exit code ${code})`)
      continue
    }
    process.exit(code)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main()
