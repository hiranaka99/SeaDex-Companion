import { normalizeInfoHash, rowKey } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR, DOWNLOAD_RECORDS_FILE, OWNED_TORRENTS_FILE } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { log } from './logging.js'
import type { DownloadClient, DownloadPhase, DownloadProtocol, ImportState } from '../shared/download-contracts.js'
import type { UsenetProvider } from '../shared/usenet-contracts.js'

const OWNED_DOWNLOADS_FILE = join(DATA_DIR, 'owned_downloads.json')

const safeText = (value: unknown, max = 300): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
const nullableInteger = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
const nonNegativeNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/**
 * The authoritative app-owned acquisition ledger. One protocol-neutral record per
 * accepted client job; `t:<hash>` records double as legacy torrent ledger entries.
 * Records retain ownership until explicit removal records an audit tombstone.
 */
export interface OwnedDownloadRecord {
  id: string
  protocol: DownloadProtocol
  client: DownloadClient
  /** Normalized client endpoint identity used at submission, without credentials. Empty means unbound. */
  endpoint: string
  /** qBittorrent info hash or SABnzbd nzo_id. Empty only while acceptance is unknown. */
  native_id: string
  state: 'accepted' | 'acceptance_unknown'
  source_hash: string
  category: string
  /** Effective torrent file scope. Undefined means the whole torrent. */
  scope?: string[]
  provider?: UsenetProvider
  entry_id?: string
  nzb_name?: string
  added_at: string
  updated_at: string
  /** Successful explicit removal audit; the record leaves active views but is retained. */
  removed_at?: string
  last_phase?: DownloadPhase
  card?: { title: string; season: number | null; part: string; release_group: string; tracker: string; size: number }
  labels: string[]
  /** Library seasons this download is meant for, kept so its import can be confirmed after rescans. */
  library?: LibraryTarget[]
  /** Import follow-through; absent on records that predate it. */
  import?: ImportTracking
}

export interface LibraryTarget {
  key: string
  season: number | null
  part: string
  group: string
}

export interface ImportTracking {
  state: ImportState
  /** When the current state was entered. */
  since: string
  completed_at?: string
  /** Library rescans requested to look for the imported files. */
  rescans?: number
  rescan_at?: string
  message?: string
  /** A problem notification was sent for this download. */
  notified?: boolean
}

interface CardSnapshot {
  title: string
  season: number | null
  part: string
  release_group: string
  tracker: string
  size: number
}
interface AssociationRow {
  key: string
  release: number
}
interface LegacyTorrentAssociation extends AssociationRow {
  library_key?: string
  season: number | null
}
interface LegacyTorrentCard extends CardSnapshot {
  key: string
  release: number
  associations?: LegacyTorrentAssociation[]
}

interface RecordFile {
  version: 2
  records: OwnedDownloadRecord[]
  rows: Record<string, AssociationRow[]>
}

let ledger: RecordFile | null = null

const now = () => new Date().toISOString()

function decodeCard(value: unknown): CardSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const card = value as Record<string, unknown>
  if (typeof card.title !== 'string' || !card.title) return undefined
  return {
    title: card.title,
    season: nullableInteger(card.season),
    part: safeText(card.part, 80),
    release_group: safeText(card.release_group, 120),
    tracker: safeText(card.tracker, 120),
    size: nonNegativeNumber(card.size),
  }
}

function decodeRecord(value: unknown): OwnedDownloadRecord | null {
  if (!isRecord(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (raw.protocol !== 'torrent' && raw.protocol !== 'usenet') return null
  if (raw.client !== 'qbittorrent' && raw.client !== 'sabnzbd') return null
  if (raw.state !== 'accepted' && raw.state !== 'acceptance_unknown') return null
  const sourceHash = normalizeInfoHash(raw.source_hash)
  if (!sourceHash) return null
  const nativeId = typeof raw.native_id === 'string' ? raw.native_id.trim() : ''
  if (raw.state === 'accepted' && !nativeId) return null
  const addedAt = typeof raw.added_at === 'string' ? raw.added_at : now()
  return {
    id: raw.id,
    protocol: raw.protocol,
    client: raw.client,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    native_id: raw.protocol === 'torrent' ? normalizeInfoHash(nativeId) || sourceHash : nativeId,
    state: raw.state,
    source_hash: sourceHash,
    category: safeText(raw.category, 80),
    ...(Array.isArray(raw.scope)
      ? { scope: raw.scope.filter((path): path is string => typeof path === 'string' && Boolean(path)) }
      : {}),
    ...(raw.provider === 'animetosho' || raw.provider === 'amenzb' ? { provider: raw.provider } : {}),
    ...(typeof raw.entry_id === 'string' && raw.entry_id ? { entry_id: raw.entry_id.slice(0, 80) } : {}),
    ...(typeof raw.nzb_name === 'string' && raw.nzb_name ? { nzb_name: safeText(raw.nzb_name, 200) } : {}),
    added_at: addedAt,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : addedAt,
    ...(typeof raw.removed_at === 'string' ? { removed_at: raw.removed_at } : {}),
    ...(decodePhase(raw.last_phase) ? { last_phase: raw.last_phase as DownloadPhase } : {}),
    ...(decodeCard(raw.card) ? { card: decodeCard(raw.card) } : {}),
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .filter((label): label is string => typeof label === 'string' && Boolean(label))
          .slice(0, 16)
          .map(label => safeText(label, 200))
      : [],
    ...(decodeLibrary(raw.library).length ? { library: decodeLibrary(raw.library) } : {}),
    ...(decodeImport(raw.import) ? { import: decodeImport(raw.import) } : {}),
  }
}

const IMPORT_STATES: Record<string, true> = {
  waiting: true,
  pending: true,
  blocked: true,
  imported: true,
  not_imported: true,
}

function decodeLibrary(value: unknown): LibraryTarget[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const target = raw as Record<string, unknown>
      return typeof target.key === 'string' && target.key
        ? [
            {
              key: target.key.slice(0, 120),
              season: nullableInteger(target.season),
              part: safeText(target.part, 80),
              group: safeText(target.group, 120),
            },
          ]
        : []
    })
    .slice(0, 32)
}

function decodeImport(value: unknown): ImportTracking | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.state !== 'string' || !IMPORT_STATES[raw.state]) return undefined
  return {
    state: raw.state as ImportState,
    since: typeof raw.since === 'string' ? raw.since : now(),
    ...(typeof raw.completed_at === 'string' ? { completed_at: raw.completed_at } : {}),
    ...(Number.isInteger(raw.rescans) ? { rescans: raw.rescans as number } : {}),
    ...(typeof raw.rescan_at === 'string' ? { rescan_at: raw.rescan_at } : {}),
    ...(typeof raw.message === 'string' && raw.message ? { message: safeText(raw.message, 600) } : {}),
    ...(raw.notified === true ? { notified: true } : {}),
  }
}

const PHASES: Record<string, true> = {
  acceptance_unknown: true,
  queued: true,
  downloading: true,
  paused: true,
  verifying: true,
  repairing: true,
  unpacking: true,
  post_processing: true,
  seeding: true,
  complete: true,
  error: true,
  missing: true,
  unavailable: true,
}
function decodePhase(value: unknown): value is DownloadPhase {
  return typeof value === 'string' && Boolean(PHASES[value])
}

function decodeRows(value: unknown): Record<string, AssociationRow[]> {
  if (!isRecord(value)) return {}
  const rows: Record<string, AssociationRow[]> = {}
  for (const [recordId, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue
    const list = raw.flatMap(row => {
      if (!row || typeof row !== 'object') return []
      const candidate = row as Record<string, unknown>
      return typeof candidate.key === 'string' &&
        candidate.key &&
        Number.isInteger(candidate.release) &&
        (candidate.release as number) >= 0
        ? [{ key: candidate.key, release: candidate.release as number }]
        : []
    })
    if (list.length) rows[recordId] = list
  }
  return rows
}

function decodeFile(value: unknown): RecordFile | null {
  if (!isRecord(value)) return null
  const file = value as Record<string, unknown>
  if (file.version !== 2 || !Array.isArray(file.records)) return null
  const records = file.records.map(decodeRecord).filter((record): record is OwnedDownloadRecord => Boolean(record))
  return { version: 2, records, rows: decodeRows(file.rows) }
}

function legacyCardFrom(raw: unknown, hash: string): LegacyTorrentCard {
  if (!isRecord(raw))
    return {
      title: '',
      season: null,
      part: '',
      release_group: '',
      tracker: '',
      size: 0,
      key: `torrent:${hash}`,
      release: 0,
    }
  const info = raw as Record<string, unknown>
  const title = typeof info.title === 'string' ? info.title : ''
  return {
    title,
    season: nullableInteger(info.season),
    part: safeText(info.part, 80),
    release_group: safeText(info.releaseGroup, 120),
    tracker: safeText(info.tracker, 120),
    size: nonNegativeNumber(info.size),
    key: typeof info.key === 'string' && info.key ? info.key : `torrent:${hash}`,
    release: Number.isInteger(info.release) && (info.release as number) >= 0 ? (info.release as number) : 0,
    ...(Array.isArray(info.associations)
      ? {
          associations: (info.associations as unknown[]).flatMap(association => {
            if (!association || typeof association !== 'object') return []
            const row = association as Record<string, unknown>
            return typeof row.key === 'string' && row.key
              ? [
                  {
                    key: row.key,
                    release: 0,
                    season: row.season === null ? null : nullableInteger(row.season),
                    ...(typeof row.library_key === 'string' && row.library_key ? { library_key: row.library_key } : {}),
                  },
                ]
              : []
          }),
        }
      : {}),
  }
}

function legacyFile(): { cards: Map<string, LegacyTorrentCard>; hashes: string[] } | null {
  const owned = readJson<unknown>(OWNED_TORRENTS_FILE, undefined)
  if (owned === undefined) return null
  const details = readJson<unknown>(DOWNLOAD_RECORDS_FILE, {}, 'Could not read legacy download details')
  const cards = new Map<string, LegacyTorrentCard>()
  const hashes: string[] = []
  if (Array.isArray(owned)) {
    const detailMap = isRecord(details) ? (details as Record<string, unknown>) : {}
    for (const value of owned) {
      const hash = normalizeInfoHash(value)
      if (!hash) continue
      hashes.push(hash)
      cards.set(hash, legacyCardFrom(detailMap[hash], hash))
    }
  } else if (
    owned &&
    typeof owned === 'object' &&
    'version' in owned &&
    (owned as Record<string, unknown>).version === 1 &&
    'torrents' in owned
  ) {
    const torrents = (owned as Record<string, unknown>).torrents
    if (isRecord(torrents))
      for (const [value, raw] of Object.entries(torrents as Record<string, unknown>)) {
        const hash = normalizeInfoHash(value)
        if (!hash) continue
        hashes.push(hash)
        cards.set(hash, legacyCardFrom(raw, hash))
      }
  } else {
    return null
  }
  return { cards, hashes: [...new Set(hashes)] }
}

/**
 * One-time migration from the legacy torrent ledger and detail records into the
 * versioned protocol-neutral file. Idempotent; the durable new record is written
 * before anything is considered migrated, and the legacy files are left in place
 * so a failed cutover can be re-derived.
 */
export function migrateOwnedDownloads(qbEndpoint: string): void {
  if (ledger) return
  const existing = decodeFile(readJson<unknown>(OWNED_DOWNLOADS_FILE, null))
  if (existing) {
    ledger = existing
    return
  }
  const legacy = legacyFile()
  if (!legacy) {
    ledger = { version: 2, records: [], rows: {} }
    return
  }
  const records: OwnedDownloadRecord[] = []
  const rows: Record<string, AssociationRow[]> = {}
  for (const hash of legacy.hashes) {
    const card = legacy.cards.get(hash)!
    const id = `t:${hash}`
    const createdAt = now()
    records.push({
      id,
      protocol: 'torrent',
      client: 'qbittorrent',
      endpoint: qbEndpoint,
      native_id: hash,
      state: 'accepted',
      source_hash: hash,
      category: '',
      added_at: createdAt,
      updated_at: createdAt,
      ...(card.title
        ? {
            card: {
              title: card.title,
              season: card.season,
              part: card.part,
              release_group: card.release_group,
              tracker: card.tracker,
              size: card.size,
            },
          }
        : {}),
      labels: [],
    })
    const associated: AssociationRow[] = [
      { key: card.key, release: card.release },
      ...(card.associations || []).map(({ key, release }) => ({ key, release })),
    ]
    const unique = [...new Map(associated.map(row => [rowKey(row), row])).values()]
    if (unique.length) rows[id] = unique
  }
  commit({ version: 2, records, rows })
  log('INFO', `Migrated ${records.length} owned torrent record(s) to the versioned acquisition ledger`)
}

function current(): RecordFile {
  if (ledger) return ledger
  const stored = decodeFile(readJson<unknown>(OWNED_DOWNLOADS_FILE, null, 'Could not read the acquisition ledger'))
  if (stored) {
    ledger = stored
    return ledger
  }
  ledger = { version: 2, records: [], rows: {} }
  return ledger
}

function commit(next: RecordFile): void {
  writeJsonAtomic(OWNED_DOWNLOADS_FILE, next, true, 0o600)
  ledger = next
}

function mutate(id: string, change: (record: OwnedDownloadRecord) => void): OwnedDownloadRecord | null {
  if (!current().records.some(record => record.id === id)) return null
  const next = structuredClone(current())
  const record = next.records.find(record => record.id === id)!
  change(record)
  record.updated_at = now()
  commit(next)
  return structuredClone(record)
}

export interface NewDownloadRecord {
  protocol: DownloadProtocol
  client: DownloadClient
  endpoint: string
  native_id?: string
  state: OwnedDownloadRecord['state']
  source_hash: string
  category: string
  scope?: string[]
  provider?: UsenetProvider
  entry_id?: string
  nzb_name?: string
  card?: CardSnapshot
  labels?: string[]
  rows?: AssociationRow[]
  library?: LibraryTarget[]
}

/** Creates the durable record. Torrent records reuse `t:<hash>`; Usenet gets `u:<hash>:<uuid>`. */
export function addDownloadRecord(input: NewDownloadRecord): OwnedDownloadRecord {
  const sourceHash = normalizeInfoHash(input.source_hash)
  if (!sourceHash) throw new Error('Invalid source hash')
  const file = structuredClone(current())
  const id = input.protocol === 'torrent' ? `t:${sourceHash}` : `u:${sourceHash.slice(0, 12)}:${randomUUID()}`
  const timestamp = now()
  const record: OwnedDownloadRecord = {
    id,
    protocol: input.protocol,
    client: input.client,
    endpoint: input.endpoint || '',
    native_id: input.protocol === 'torrent' ? sourceHash : input.native_id || '',
    state: input.state,
    source_hash: sourceHash,
    category: input.category || '',
    ...(input.scope?.length ? { scope: [...new Set(input.scope)] } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.entry_id ? { entry_id: input.entry_id.slice(0, 80) } : {}),
    ...(input.nzb_name ? { nzb_name: input.nzb_name } : {}),
    added_at: timestamp,
    updated_at: timestamp,
    ...(input.card ? { card: structuredClone(input.card) } : {}),
    labels: [...new Set(input.labels || [])].slice(0, 16),
    // Import is only followed for downloads whose library seasons are known.
    ...(input.library?.length
      ? { library: structuredClone(input.library), import: { state: 'waiting' as const, since: timestamp } }
      : {}),
  }
  const existing = file.records.find(candidate => candidate.id === id)
  if (existing) Object.assign(record, { added_at: existing.added_at })
  if (existing) file.records[file.records.indexOf(existing)] = record
  else file.records.push(record)
  if (input.rows?.length) {
    const unique = [
      ...new Map(input.rows.map(({ key, release }) => [rowKey({ key, release }), { key, release }])).values(),
    ]
    if (unique.length) file.rows[id] = unique
  }
  commit(file)
  return structuredClone(record)
}

export function findDownloadRecord(id: string): OwnedDownloadRecord | null {
  const record = current().records.find(record => record.id === id)
  return record ? structuredClone(record) : null
}

export function downloadRecords(): OwnedDownloadRecord[] {
  return structuredClone(current().records.filter(record => !record.removed_at))
}

export function allDownloadRecords(): OwnedDownloadRecord[] {
  return structuredClone(current().records)
}

export function setDownloadNative(id: string, nativeIds: string[]): OwnedDownloadRecord | null {
  const accepted = [...new Set(nativeIds.map(value => value.trim()).filter(Boolean))]
  const first = accepted[0]
  if (!first || !current().records.some(record => record.id === id)) return null
  const file = structuredClone(current())
  const parent = file.records.find(record => record.id === id)!
  parent.native_id = parent.protocol === 'torrent' ? parent.source_hash : first
  parent.state = 'accepted'
  parent.updated_at = now()
  // One accepted NZB submission can create several native jobs with the same associations.
  if (parent.protocol === 'usenet')
    for (const nativeId of accepted.slice(1)) {
      if (
        file.records.some(
          record =>
            record.client === parent.client &&
            record.endpoint === parent.endpoint &&
            record.native_id === nativeId &&
            !record.removed_at,
        )
      )
        continue
      const clone = structuredClone({
        ...parent,
        id: `u:${parent.source_hash.slice(0, 12)}:${randomUUID()}`,
        native_id: nativeId,
        added_at: parent.updated_at,
      })
      file.records.push(clone)
      if (file.rows[id]) file.rows[clone.id] = structuredClone(file.rows[id])
    }
  commit(file)
  return structuredClone(parent)
}

export function markDownloadRemoved(id: string): OwnedDownloadRecord | null {
  return mutate(id, record => {
    record.removed_at = now()
  })
}

export function setDownloadPhase(id: string, phase: DownloadPhase): void {
  const record = current().records.find(record => record.id === id)
  if (!record) return
  // The first sight of a finished download starts the wait for Sonarr or Radarr to import it.
  const finished = record.import?.state === 'waiting' && (phase === 'complete' || phase === 'seeding')
  if (record.last_phase === phase && !finished) return
  mutate(id, record => {
    record.last_phase = phase
    if (finished) {
      const at = now()
      record.import = { state: 'pending', since: at, completed_at: at }
    }
  })
}

/** Applies a change to a record's import tracking and persists it; the state's `since` follows state changes. */
export function updateDownloadImport(id: string, change: Partial<ImportTracking>): OwnedDownloadRecord | null {
  const record = current().records.find(record => record.id === id)
  if (!record?.import) return null
  return mutate(id, record => {
    const previous = record.import!
    const next: ImportTracking = { ...previous, ...change }
    if (change.state && change.state !== previous.state) next.since = now()
    for (const key of Object.keys(next) as (keyof ImportTracking)[]) if (next[key] === undefined) delete next[key]
    record.import = next
  })
}

export function downloadRows(id: string): AssociationRow[] {
  return structuredClone(current().rows[id] || [])
}

export function resetOwnedRuntime(): void {
  ledger = null
}
