import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_DIR } from './paths.js'
import { api } from './http.js'

export const APP_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(BASE_DIR, 'package.json'), 'utf8')).version || '0.0.0') }
  catch { return '0.0.0' }
})()

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/hiranaka99/SeaDex-Companion/releases/latest'
const UPDATE_CHECK_TTL = 60 * 60 * 1000
const UPDATE_CHECK_RETRY_TTL = 5 * 60 * 1000

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

let updateCheck: { result: UpdateInfo; at: number; ttl: number } | null = null
let updateCheckInFlight: Promise<UpdateInfo> | null = null

export function resetUpdateCheck(): void {
  updateCheck = null
  updateCheckInFlight = null
}

/**
 * Checks the GitHub releases API for a newer version. Results are cached for an
 * hour (five minutes after a failure) so the endpoint stays cheap under UI
 * polling; a GitHub outage never surfaces as an error, it just reports no update.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const now = Date.now()
  if (updateCheck && now - updateCheck.at < updateCheck.ttl) return updateCheck.result
  if (!updateCheckInFlight) {
    updateCheckInFlight = (async () => {
      let result: UpdateInfo = { current: APP_VERSION, latest: null, url: null }
      let ok = false
      try {
        const release = await api(GITHUB_RELEASES_URL)
        ok = true
        const tag = String(release?.tag_name || '').replace(/^v/, '')
        if (tag && compareVersions(tag, APP_VERSION) > 0) {
          result = { current: APP_VERSION, latest: tag, url: String(release.html_url || 'https://github.com/hiranaka99/SeaDex-Companion/releases') }
        }
      } catch { /* GitHub unreachable or rate limited; keep reporting up to date. */ }
      updateCheck = { result, at: Date.now(), ttl: ok ? UPDATE_CHECK_TTL : UPDATE_CHECK_RETRY_TTL }
      return result
    })().finally(() => { updateCheckInFlight = null })
  }
  return updateCheckInFlight
}
