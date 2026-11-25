import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { HttpError } from '../server/http-error.js'
import { activeFile, bundleDir, failureFile, readActiveBundle, updatesDir } from '../server/launcher.js'
import { DATA_DIR } from '../server/paths.js'
import {
  UPDATE_MANIFEST_ASSET,
  bundleAssetName,
  runtimeDifferences,
  type RuntimeIdentity,
} from '../server/runtime-identity.js'
import { packTarGz, unpackTarGz } from '../server/tar.js'
import { APP_VERSION, checkForUpdates, installPlan, installUpdate, resetUpdateCheck } from '../server/updates.js'

const runtime: RuntimeIdentity = {
  format: 1,
  node: '24',
  image: 'a'.repeat(64),
  launcher: 'b'.repeat(64),
  dependencies: { '@node-rs/argon2': '2.2.2', '@node-rs/argon2-linux-x64-musl': '2.2.2', 'fast-xml-parser': '5.12.1' },
}

/** Rewrites the first entry's name inside a packed archive, bypassing the writer's checks. */
function withFirstName(archive: Buffer, name: string, type = '0'): Buffer {
  const tar = gunzipSync(archive)
  tar.fill(0, 0, 100)
  tar.write(name, 0)
  tar[156] = type.charCodeAt(0)
  tar.fill(' ', 148, 156)
  let sum = 0
  for (let index = 0; index < 512; index++) sum += tar[index]
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(tar)
}

describe('update bundle archives', () => {
  test('round-trip regular files, including long nested paths', () => {
    const long = `static/assets/${'x'.repeat(120)}/chunk.js`
    const entries = [
      { path: 'package.json', data: Buffer.from('{"version":"1.2.3"}') },
      { path: long, data: Buffer.alloc(1500, 7) },
      { path: 'dist/server/empty.js', data: Buffer.alloc(0) },
    ]
    assert.deepEqual(unpackTarGz(packTarGz(entries)), entries)
  })

  test('refuse paths outside the bundle and non-file entries', () => {
    const archive = packTarGz([{ path: 'aaaaaaa', data: Buffer.from('x') }])
    for (const name of ['../escape', '/etc/passwd', 'dist/../../escape', 'C:/windows']) {
      assert.throws(() => unpackTarGz(withFirstName(archive, name)), /Unsafe archive path/, name)
    }
    assert.throws(() => unpackTarGz(withFirstName(archive, 'link', '2')), /Unsupported archive entry/)
    assert.throws(() => packTarGz([{ path: '../escape', data: Buffer.alloc(0) }]), /Unsafe archive path/)
  })
})

describe('deciding how a release installs', () => {
  test('explains each container change that needs a new image', () => {
    assert.deepEqual(runtimeDifferences(runtime, runtime), [])
    assert.deepEqual(runtimeDifferences(runtime, { ...runtime, node: '26', image: 'c'.repeat(64) }), [
      'Node.js changes from version 24 to 26.',
    ])
    assert.deepEqual(runtimeDifferences(runtime, { ...runtime, image: 'c'.repeat(64) }), [
      'The container base system or startup script changes.',
    ])
    assert.deepEqual(
      runtimeDifferences(runtime, {
        ...runtime,
        dependencies: {
          '@node-rs/argon2': '2.3.0',
          '@node-rs/argon2-linux-x64-musl': '2.3.0',
          'fast-xml-parser': '5.12.1',
          'new-package': '1.0.0',
        },
      }),
      ['Server dependencies change: @node-rs/argon2 2.2.2 → 2.3.0, new-package 1.0.0 (new).'],
    )
    assert.deepEqual(
      runtimeDifferences(runtime, {
        ...runtime,
        dependencies: { ...runtime.dependencies, '@node-rs/argon2-linux-x64-musl': '2.2.3' },
      }),
      ['Native server components change.'],
    )
    assert.deepEqual(runtimeDifferences(runtime, { format: 2 }), [
      'This release describes its container requirements in a newer format.',
    ])
  })

  test('chooses in-app, image, or unavailable', () => {
    const manifest = {
      format: 1,
      version: '9.9.9',
      bundle: { name: bundleAssetName('9.9.9'), size: 10, sha256: 'f'.repeat(64) },
      runtime,
    }
    const base = { latest: '9.9.9', managed: true, manifest, runtime }
    assert.deepEqual(installPlan(base), { mode: 'in_app', reasons: [] })
    assert.equal(installPlan({ ...base, managed: false }).mode, 'unavailable')
    assert.deepEqual(installPlan({ ...base, manifest: null }), {
      mode: 'image_required',
      reasons: ['This release does not include an in-app update package.'],
    })
    assert.equal(installPlan({ ...base, manifestError: 'HTTP 503' }).mode, 'unavailable')
    assert.equal(installPlan({ ...base, latest: '9.9.8' }).mode, 'unavailable', 'Manifest must describe the release')
    assert.equal(installPlan({ ...base, runtime: null }).mode, 'image_required')
    assert.deepEqual(installPlan({ ...base, runtime: { ...runtime, node: '22' } }), {
      mode: 'image_required',
      reasons: ['Node.js changes from version 22 to 24.'],
    })
  })
})

describe('installing an update from a release', () => {
  const imageRoot = mkdtempSync(join(tmpdir(), 'seadex-image-'))
  const originalFetch = globalThis.fetch
  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const env = { launcher: process.env.SEADEX_LAUNCHER, imageRoot: process.env.SEADEX_IMAGE_ROOT }

  function release(options: { runtime?: RuntimeIdentity; corrupt?: boolean; withManifest?: boolean } = {}) {
    const version = '9.9.9'
    const bundleRuntime = options.runtime ?? runtime
    const archive = packTarGz([
      { path: 'package.json', data: Buffer.from(JSON.stringify({ version, type: 'module' })) },
      { path: 'runtime.json', data: Buffer.from(JSON.stringify(bundleRuntime)) },
      { path: 'dist/server/index.js', data: Buffer.from('// server\n') },
      { path: 'static/index.html', data: Buffer.from('<!doctype html>') },
    ])
    const manifest = {
      format: 1,
      version,
      bundle: {
        name: bundleAssetName(version),
        size: archive.length,
        sha256: createHash('sha256')
          .update(options.corrupt ? 'tampered' : archive)
          .digest('hex'),
      },
      runtime: bundleRuntime,
    }
    const assets = [{ name: bundleAssetName(version), browser_download_url: 'https://github.com/download/bundle' }]
    if (options.withManifest !== false)
      assets.push({ name: UPDATE_MANIFEST_ASSET, browser_download_url: 'https://github.com/download/manifest' })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      const body = url.endsWith('/latest')
        ? JSON.stringify({ tag_name: `v${version}`, html_url: 'https://github.com/release', assets })
        : url.endsWith('/manifest')
          ? JSON.stringify(manifest)
          : url.endsWith('/bundle')
            ? new Uint8Array(archive)
            : null
      if (body === null) return new Response('missing', { status: 404 })
      const response = new Response(body, { status: 200 })
      Object.defineProperty(response, 'url', { value: url })
      return response
    }) as typeof fetch
  }

  beforeEach(() => {
    writeFileSync(join(imageRoot, 'package.json'), JSON.stringify({ version: APP_VERSION }))
    writeFileSync(join(imageRoot, 'runtime.json'), JSON.stringify(runtime))
    process.env.SEADEX_LAUNCHER = '1'
    process.env.SEADEX_IMAGE_ROOT = imageRoot
    rmSync(updatesDir(DATA_DIR), { recursive: true, force: true })
    resetUpdateCheck()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv('SEADEX_LAUNCHER', env.launcher)
    restoreEnv('SEADEX_IMAGE_ROOT', env.imageRoot)
    rmSync(updatesDir(DATA_DIR), { recursive: true, force: true })
    resetUpdateCheck()
  })

  test('stages a verified bundle and points the launcher at it', async () => {
    release()
    const info = await checkForUpdates()
    assert.equal(info.latest, '9.9.9')
    assert.deepEqual(info.install, { mode: 'in_app', reasons: [] })
    assert.equal(info.managed, true)
    assert.deepEqual(await installUpdate(), { version: '9.9.9' })
    const active = readActiveBundle(DATA_DIR)
    assert.equal(active?.version, '9.9.9')
    assert.equal(active?.pending, true)
    assert.equal(active?.previous, null, 'The image app is the fallback')
    assert.equal(readFileSync(join(bundleDir(DATA_DIR, '9.9.9'), 'dist', 'server', 'index.js'), 'utf8'), '// server\n')
  })

  test('refuses a bundle whose checksum does not match, leaving nothing behind', async () => {
    release({ corrupt: true })
    await assert.rejects(installUpdate(), (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 502)
      assert.match(error.message, /checksum/)
      return true
    })
    assert.equal(existsSync(activeFile(DATA_DIR)), false)
    assert.equal(existsSync(bundleDir(DATA_DIR, '9.9.9')), false)
  })

  test('requires a new image when the release needs a different runtime', async () => {
    release({ runtime: { ...runtime, node: '26', image: 'c'.repeat(64) } })
    const info = await checkForUpdates()
    assert.deepEqual(info.install, { mode: 'image_required', reasons: ['Node.js changes from version 24 to 26.'] })
    await assert.rejects(installUpdate(), (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 409)
      assert.equal(error.message, 'Node.js changes from version 24 to 26.')
      return true
    })
    assert.equal(existsSync(activeFile(DATA_DIR)), false)
  })

  test('requires a new image when a release has no update package', async () => {
    release({ withManifest: false })
    assert.equal((await checkForUpdates()).install?.mode, 'image_required')
  })

  test('cannot install outside the Docker launcher', async () => {
    delete process.env.SEADEX_LAUNCHER
    release()
    assert.equal((await checkForUpdates()).install?.mode, 'unavailable')
    await assert.rejects(installUpdate(), /Docker image/)
  })
})

describe('launcher', () => {
  const compiledLauncher = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'launcher.js')
  // Each app copy appends its version to runs.log, then performs the next scripted action.
  const stub = `
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const data = process.env.DATA_DIR
const log = join(data, 'runs.log')
let runs = []
try { runs = readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean) } catch {}
appendFileSync(log, version + '\\n')
const script = JSON.parse(readFileSync(join(data, 'script.json'), 'utf8'))
const action = script[version][runs.filter(run => run === version).length]
if (process.env.SEADEX_LAUNCHER !== '1') process.exit(9)
if (action === 'crash') process.exit(1)
if (action === 'install') {
  const bundle = join(data, 'app-updates', '2.0.0')
  mkdirSync(join(bundle, 'dist', 'server'), { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ version: '2.0.0', type: 'module' }))
  copyFileSync(join(root, 'runtime.json'), join(bundle, 'runtime.json'))
  copyFileSync(fileURLToPath(import.meta.url), join(bundle, 'dist', 'server', 'index.js'))
  writeFileSync(join(data, 'app-updates', 'active.json'), JSON.stringify({ version: '2.0.0', previous: null, pending: true, installed_at: '' }))
  process.exit(75)
}
process.send({ type: 'seadex:ready' })
setTimeout(() => process.exit(0), 50)
`

  function app(root: string, version: string) {
    mkdirSync(join(root, 'dist', 'server'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version, type: 'module' }))
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(runtime))
    writeFileSync(join(root, 'dist', 'server', 'index.js'), stub)
  }

  function setup(script: Record<string, string[]>) {
    const imageRoot = mkdtempSync(join(tmpdir(), 'seadex-launcher-image-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'seadex-launcher-data-'))
    app(imageRoot, '1.0.0')
    mkdirSync(join(imageRoot, 'node_modules'))
    copyFileSync(compiledLauncher, join(imageRoot, 'dist', 'server', 'launcher.js'))
    app(bundleDir(dataDir, '2.0.0'), '2.0.0')
    writeFileSync(join(dataDir, 'script.json'), JSON.stringify(script))
    const run = () =>
      new Promise<{ code: number | null; runs: string[] }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(imageRoot, 'dist', 'server', 'launcher.js')], {
          env: { ...process.env, DATA_DIR: dataDir },
          stdio: ['ignore', 'pipe', 'inherit'],
          windowsHide: true,
        })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Launcher did not exit'))
        }, 20_000)
        child.stdout.resume()
        child.once('error', reject)
        child.once('exit', code => {
          clearTimeout(timer)
          resolve({ code, runs: readFileSync(join(dataDir, 'runs.log'), 'utf8').trim().split('\n') })
        })
      })
    const cleanup = () => {
      rmSync(imageRoot, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
    return { dataDir, run, cleanup }
  }

  test('restarts into an installed update and keeps it once it is ready', async () => {
    const { dataDir, run, cleanup } = setup({ '1.0.0': ['install'], '2.0.0': ['ready'] })
    try {
      rmSync(updatesDir(dataDir), { recursive: true, force: true })
      const result = await run()
      assert.equal(result.code, 0)
      assert.deepEqual(result.runs, ['1.0.0', '2.0.0'])
      assert.equal(readActiveBundle(dataDir)?.pending, false)
      assert.ok(existsSync(join(bundleDir(dataDir, '2.0.0'), 'node_modules')), 'The bundle resolves image packages')
    } finally {
      cleanup()
    }
  })

  test('returns to the image app when a new update stops before it is ready', async () => {
    const { dataDir, run, cleanup } = setup({ '1.0.0': ['ready'], '2.0.0': ['crash'] })
    try {
      writeFileSync(activeFile(dataDir), JSON.stringify({ version: '2.0.0', previous: null, pending: true }))
      const result = await run()
      assert.equal(result.code, 0)
      assert.deepEqual(result.runs, ['2.0.0', '1.0.0'])
      assert.equal(existsSync(activeFile(dataDir)), false)
      assert.equal(existsSync(bundleDir(dataDir, '2.0.0')), false)
      const failure = JSON.parse(readFileSync(failureFile(dataDir), 'utf8'))
      assert.equal(failure.version, '2.0.0')
      assert.equal(failure.restored, '1.0.0')
      assert.match(failure.reason, /before it finished starting/)
    } finally {
      cleanup()
    }
  })

  test('ignores and removes an update that is not newer than the image', async () => {
    const { dataDir, run, cleanup } = setup({ '1.0.0': ['ready'], '2.0.0': ['ready'] })
    try {
      // For example, the user pulled image 1.0.0 after installing 0.9.0 in-app.
      app(bundleDir(dataDir, '0.9.0'), '0.9.0')
      writeFileSync(activeFile(dataDir), JSON.stringify({ version: '0.9.0', previous: null, pending: false }))
      const result = await run()
      assert.deepEqual(result.runs, ['1.0.0'])
      assert.equal(existsSync(activeFile(dataDir)), false)
      assert.equal(existsSync(bundleDir(dataDir, '0.9.0')), false)
      assert.equal(existsSync(bundleDir(dataDir, '2.0.0')), false, 'Unreferenced bundles are removed')
    } finally {
      cleanup()
    }
  })
})
