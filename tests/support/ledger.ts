import { allDownloadRecords, type OwnedDownloadRecord } from '../../server/download-store.js'
import type { DownloadProtocol } from '../../shared/download-contracts.js'

// Ledger lookups the suite asserts with. Production resolves records by ID.
const active = (): OwnedDownloadRecord[] => allDownloadRecords().filter(record => !record.removed_at)

export function findAcquisitionRecord(sourceHash: string, protocol?: DownloadProtocol): OwnedDownloadRecord | null {
  const hash = sourceHash.toLowerCase()
  return active().find(record => record.source_hash === hash && (!protocol || record.protocol === protocol)) ?? null
}

export const findTorrentRecord = (sourceHash: string): OwnedDownloadRecord | null =>
  findAcquisitionRecord(sourceHash, 'torrent')

export function findSabnzbdRecord(nzoId: string): OwnedDownloadRecord | null {
  return active().find(record => record.client === 'sabnzbd' && record.native_id === nzoId) ?? null
}
