import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// `npm test -- episode-order release-actions` runs only the test files whose names contain one of the words.
// TEST_REPORTER picks node's test reporter (`dot` prints a dot per test and the failures in full). With a
// reporter set, the application's own log lines are left out of the output; the log file still gets them.
const filters = process.argv.slice(2)
const all = readdirSync('dist/tests').filter(file => file.endsWith('.test.js'))
const chosen = filters.length ? all.filter(file => filters.some(filter => file.includes(filter))) : all
if (!chosen.length) {
  console.error(`No test file name contains ${filters.map(filter => `"${filter}"`).join(' or ')}.`)
  process.exit(2)
}
const reporter = process.env.TEST_REPORTER ? [`--test-reporter=${process.env.TEST_REPORTER}`] : []

// Persistence and scheduling tests must never read or clear the user's live data.
const dataDir = mkdtempSync(join(tmpdir(), 'seadex-tests-'))
try {
  const files = chosen.map(file => join('dist', 'tests', file))
  const quiet = reporter.length > 0
  const child = spawn(process.execPath, ['--test', '--experimental-test-isolation=none', ...reporter, ...files], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: quiet ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  })
  if (quiet) {
    // A line `server/logging.ts` writes ("2026-11-28 12:00:00 [INFO] …"), which can follow the reporter's dots.
    const appLog = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[(?:INFO|WARNING|ERROR)\] .*$/
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      createInterface({ input: from, crlfDelay: Infinity }).on('line', line => {
        const kept = line.replace(appLog, '')
        if (kept || !line) to.write(`${kept}\n`)
      })
  }
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
