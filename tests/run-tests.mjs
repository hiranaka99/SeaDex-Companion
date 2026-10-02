import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Persistence and scheduling tests must never read or clear the user's live data.
const dataDir = mkdtempSync(join(tmpdir(), 'seadex-tests-'))
try {
  const files = readdirSync('dist/tests').filter(file => file.endsWith('.test.js')).map(file => join('dist', 'tests', file))
  const child = spawn(process.execPath, ['--test', '--experimental-test-isolation=none', ...files], {
    env: { ...process.env, DATA_DIR: dataDir }, stdio: 'inherit', windowsHide: true,
  })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} finally { rmSync(dataDir, { recursive: true, force: true }) }
