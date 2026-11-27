// Builds the in-app update assets for a release, or the runtime description baked
// into the Docker image. Run after `npm run build` from the repository root:
//
//   node scripts/release-bundle.mjs runtime runtime.json
//   node scripts/release-bundle.mjs bundle release-assets
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  RUNTIME_IDENTITY_FILE,
  UPDATE_MANIFEST_ASSET,
  bundleAssetName,
  computeRuntimeIdentity,
} from '../dist/server/runtime-identity.js'
import { packTarGz } from '../dist/server/tar.js'

const root = process.cwd()
const [command, target] = process.argv.slice(2)

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    if (!entry.isFile()) throw new Error(`Refusing to package ${path}: only regular files are bundled`)
    return [path]
  })
}

if (command === 'runtime' && target) {
  writeFileSync(target, JSON.stringify(computeRuntimeIdentity(root), null, 2) + '\n')
} else if (command === 'bundle' && target) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const frontend = JSON.parse(readFileSync(join(root, 'frontend', 'package.json'), 'utf8'))
  if (frontend.version !== pkg.version) throw new Error('package.json and frontend/package.json versions differ')
  const runtime = computeRuntimeIdentity(root)
  for (const required of ['dist/server/index.js', 'static/index.html'])
    if (!statSync(join(root, required), { throwIfNoEntry: false })?.isFile())
      throw new Error(`${required} is missing; run npm run build first`)
  const sources = [join(root, 'dist', 'server'), join(root, 'dist', 'shared'), join(root, 'static')]
  const entries = [
    { path: 'package.json', data: readFileSync(join(root, 'package.json')) },
    { path: RUNTIME_IDENTITY_FILE, data: Buffer.from(JSON.stringify(runtime, null, 2) + '\n') },
    ...sources
      .flatMap(files)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map(path => ({ path: relative(root, path).split(sep).join('/'), data: readFileSync(path) })),
  ]
  const archive = packTarGz(entries)
  const name = bundleAssetName(pkg.version)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, name), archive)
  const manifest = {
    format: 1,
    version: pkg.version,
    bundle: { name, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') },
    runtime,
  }
  writeFileSync(join(target, UPDATE_MANIFEST_ASSET), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Wrote ${name} (${entries.length} files, ${archive.length} bytes) and ${UPDATE_MANIFEST_ASSET}`)
} else {
  console.error('Usage: node scripts/release-bundle.mjs runtime <file> | bundle <directory>')
  process.exit(2)
}
