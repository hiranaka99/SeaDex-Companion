import { OWNED_TORRENTS_FILE, DOWNLOAD_RECORDS_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import type { BulkCancelInfo, ResultReleaseIndex } from './downloads.js'
import type { JsonObject } from './types.js'

const normalizeInfoHash = (value: unknown): string | null => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null

type Ledger = Record<string, BulkCancelInfo | null>
let ledger: Ledger | null = null

function decodeInfo(info: unknown): BulkCancelInfo | null {
  if (!info || typeof info !== 'object' || !('title' in info) || typeof info.title !== 'string') return null
  const value = info as Partial<BulkCancelInfo>
  return {
    key: typeof value.key === 'string' ? value.key : '', release: Number.isInteger(value.release) && value.release! >= 0 ? value.release! : 0,
    title: info.title, season: Number.isInteger(value.season) && value.season! >= 0 ? value.season! : null,
    part: typeof value.part === 'string' ? value.part : '', releaseGroup: typeof value.releaseGroup === 'string' ? value.releaseGroup : '',
    tracker: typeof value.tracker === 'string' ? value.tracker : '', size: Number(value.size) || 0,
    ...(typeof value.library_key === 'string' ? { library_key: value.library_key } : {}),
    ...(Array.isArray(value.associations) ? { associations: value.associations.filter(item => item && typeof item.key === 'string' && (item.season === null || Number.isInteger(item.season))) } : {}),
  }
}

function decodeRecords(value: unknown): Record<string, BulkCancelInfo> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([hash, raw]) => {
    const normalized = normalizeInfoHash(hash), info = decodeInfo(raw)
    return normalized && info ? [[normalized, { ...info, key: info.key || `torrent:${normalized}` }]] : []
  }))
}

function currentLedger(): Ledger {
  if (ledger) return ledger
  const stored = readJson<unknown>(OWNED_TORRENTS_FILE, {}, 'Could not read torrent ownership ledger')
  if (Array.isArray(stored)) {
    // Legacy arrays and separate details are read together, then migrated on the next commit.
    const details = decodeRecords(readJson<unknown>(DOWNLOAD_RECORDS_FILE, {}))
    ledger = Object.fromEntries(stored.flatMap(value => { const hash = normalizeInfoHash(value); return hash ? [[hash, details[hash] || null]] : [] }))
  } else {
    const data = stored && typeof stored === 'object' && 'version' in stored && stored.version === 1 && 'torrents' in stored ? stored.torrents : {}
    ledger = data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).flatMap(([hash, info]) => {
      const normalized = normalizeInfoHash(hash)
      return normalized ? [[normalized, decodeInfo(info)]] : []
    })) : {}
  }
  return ledger
}

function commit(next: Ledger): void {
  writeJsonAtomic(OWNED_TORRENTS_FILE, { version: 1, torrents: next })
  ledger = next
}

export function loadDownloadRecords(file = DOWNLOAD_RECORDS_FILE): Record<string, BulkCancelInfo> {
  return file === DOWNLOAD_RECORDS_FILE ? decodeRecords(currentLedger()) : decodeRecords(readJson<unknown>(file, {}))
}

/** Ownership and its library association become visible in the same atomic rename. */
export function recordOwnedDownload(hash: string, info: BulkCancelInfo): void {
  const normalized = normalizeInfoHash(hash)
  if (!normalized) throw new Error('Invalid download hash')
  commit({ ...currentLedger(), [normalized]: info })
}

export function recordDownloadDetails(hash: string, info: BulkCancelInfo, file = DOWNLOAD_RECORDS_FILE): void {
  const normalized = normalizeInfoHash(hash)
  if (!normalized) throw new Error('Invalid download hash')
  if (file === DOWNLOAD_RECORDS_FILE) recordOwnedDownload(normalized, info)
  else writeJsonAtomic(file, { ...loadDownloadRecords(file), [normalized]: info })
}

export function trackedDownloadInfo(torrent: JsonObject, records: Record<string, BulkCancelInfo>, index: ResultReleaseIndex): BulkCancelInfo {
  const hash = String(torrent.hash || '').toLowerCase()
  return records[hash] || index.byHash.get(hash) || {
    key: `torrent:${hash}`, release: 0, title: String(torrent.name || hash), season: null,
    part: '', releaseGroup: '', tracker: '', size: Number(torrent.size || torrent.total_size || 0),
  }
}

export function saveOwnedTorrents(): void { commit(currentLedger()) }
export function recordOwnedTorrents(hashes: string[]): void {
  const next = { ...currentLedger() }
  for (const value of hashes) { const hash = normalizeInfoHash(value); if (hash && !(hash in next)) next[hash] = null }
  commit(next)
}
export function forgetOwnedTorrents(hashes: string[]): void {
  const next = { ...currentLedger() }
  for (const value of hashes) { const hash = normalizeInfoHash(value); if (hash) delete next[hash] }
  commit(next)
}
export function ownedTorrentsSnapshot(): string[] { return Object.keys(currentLedger()).sort() }
export function resetOwnedRuntime(): void { ledger = {} }
