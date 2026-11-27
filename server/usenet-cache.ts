import { INFO_HASH_PATTERN } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.js'
import { log } from './logging.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { safeText } from './provider-http.js'
import type { ProviderLookup, ProviderSettings } from './usenet-provider-types.js'
import { isUsenetProvider, USENET_PROVIDERS } from './usenet-providers.js'
import type { UsenetFailureCode, UsenetProvider } from '../shared/usenet-contracts.js'

export const USENET_CACHE_FILE = join(DATA_DIR, 'usenet_cache.json')
/** Safety bound only; normal pruning keeps the hashes of the current results. */
export const USENET_CACHE_LIMIT = 20_000
/** Snapshot compaction delay. Observations are already durable in the journal. */
const COMPACT_DELAY_MS = 30_000
const WRITE_RETRY_MS = 60_000
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const FAILURE_CODES: Record<UsenetFailureCode, true> = {
  network: true,
  timeout: true,
  invalid_response: true,
  unauthorized: true,
  rate_limited: true,
  server: true,
  invalid_config: true,
}
type Observation = Exclude<ProviderLookup, { kind: 'failed' }>
type Failure = Extract<ProviderLookup, { kind: 'failed' }>

export interface UsenetCacheRecord {
  provider: UsenetProvider
  fingerprint: string
  hash: string
  checkedAt: number
  lastAttemptAt: number
  retryAt: number
  lookup?: Observation
  failure?: Failure
  /** Consecutive absent observations (no match or deleted); drives the absence refresh interval. */
  negativeStreak?: number
}

export function usenetCacheJournalFile(file: string): string {
  return `${file.replace(/\.json$/, '')}.journal.jsonl`
}

export function providerFingerprint(provider: UsenetProvider, settings: ProviderSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, settings.baseUrl.replace(/\/+$/, ''), settings.apiKey || '']))
    .digest('hex')
}

export function usenetCacheKey(provider: UsenetProvider, fingerprint: string, hash: string): string {
  return `${provider}:${fingerprint}:${hash}`
}

function safeMetadata(value: string, secrets: string[]): string {
  let result = value.replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
  for (const secret of secrets) if (secret) result = result.split(secret).join('[credential omitted]')
  return safeText(result, 4096)
}

function observation(
  value: unknown,
  provider: UsenetProvider,
  hash: string,
  secrets: string[] = [],
): Observation | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'no_match') return { kind: 'no_match' }
  const { entryPattern } = USENET_PROVIDERS[provider]
  const source = value.kind === 'match' && isRecord(value.match) ? value.match : value
  if (source.provider !== provider || (value.kind !== 'deleted' && source.source_hash !== hash)) return undefined
  if (typeof source.entry_id !== 'string' || !entryPattern.test(source.entry_id)) {
    // Processing and deleted entries can precede a usable provider id.
    if (value.kind === 'processing' || value.kind === 'deleted')
      return value.kind === 'deleted'
        ? { kind: 'deleted', provider, entry_id: '' }
        : { kind: 'processing', provider, entry_id: '', source_hash: hash }
    return undefined
  }
  const entryId = source.entry_id
  if (secrets.some(secret => secret && entryId.includes(secret))) return undefined
  if (value.kind === 'deleted') return { kind: 'deleted', provider, entry_id: source.entry_id }
  const title = typeof source.title === 'string' ? safeMetadata(source.title, secrets) : undefined
  if (source.source_hash !== hash) return undefined
  if (value.kind === 'processing')
    return { kind: 'processing', provider, entry_id: source.entry_id, ...(title ? { title } : {}), source_hash: hash }
  if (value.kind !== 'match' || source.provider !== provider || typeof source.files_complete !== 'boolean')
    return undefined
  const number = (input: unknown): input is number =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
  const files =
    Array.isArray(source.files) &&
    source.files.every(file => {
      if (!isRecord(file) || typeof file.name !== 'string' || file.name.length === 0 || !number(file.size)) return false
      const name = file.name
      return !/https?:\/\//i.test(name) && !secrets.some(secret => secret && name.includes(secret))
    })
      ? source.files.map(file => ({ name: file.name as string, size: file.size as number }))
      : undefined
  const complete =
    source.files_complete && files !== undefined && files.length > 0 && source.file_count === files.length
  return {
    kind: 'match',
    match: {
      provider,
      entry_id: source.entry_id,
      source_hash: hash,
      ...(title ? { title } : {}),
      ...(typeof source.nzb_name === 'string' ? { nzb_name: safeMetadata(source.nzb_name, secrets) } : {}),
      ...(number(source.total_bytes) ? { total_bytes: source.total_bytes } : {}),
      ...(number(source.file_count) ? { file_count: source.file_count } : {}),
      ...(complete ? { files } : {}),
      files_complete: complete,
    },
  }
}

function storedRecord(value: unknown): UsenetCacheRecord | undefined {
  if (
    !isRecord(value) ||
    !isUsenetProvider(value.provider) ||
    typeof value.fingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(value.fingerprint) ||
    typeof value.hash !== 'string' ||
    !INFO_HASH_PATTERN.test(value.hash)
  )
    return undefined
  if (
    ![value.checkedAt, value.lastAttemptAt, value.retryAt].every(
      time => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0,
    )
  )
    return undefined
  const lookup = observation(value.lookup, value.provider, value.hash)
  const failure =
    isRecord(value.failure) &&
    typeof value.failure.code === 'string' &&
    Object.hasOwn(FAILURE_CODES, value.failure.code)
      ? {
          kind: 'failed' as const,
          code: value.failure.code as UsenetFailureCode,
          message: `Provider lookup failed (${value.failure.code})`,
        }
      : undefined
  if ((!lookup && !failure) || (lookup && !value.checkedAt)) return undefined
  const streak =
    typeof value.negativeStreak === 'number' && Number.isSafeInteger(value.negativeStreak) && value.negativeStreak > 0
      ? value.negativeStreak
      : undefined
  return {
    provider: value.provider,
    fingerprint: value.fingerprint,
    hash: value.hash,
    checkedAt: value.checkedAt as number,
    lastAttemptAt: value.lastAttemptAt as number,
    retryAt: value.retryAt as number,
    ...(lookup ? { lookup } : {}),
    ...(failure ? { failure } : {}),
    ...(streak ? { negativeStreak: streak } : {}),
  }
}

/**
 * Provider observations persist as an atomic snapshot plus an append-only
 * journal. Each successful observation is appended synchronously before it is
 * exposed, so it survives a process killed without shutdown hooks; the
 * snapshot is rewritten in batches and on shutdown, which truncates the journal.
 */
export class PersistentUsenetCache {
  private records = new Map<string, UsenetCacheRecord>()
  private persisted = new Map<string, UsenetCacheRecord>()
  private loaded = false
  private dirty = false
  private timer?: NodeJS.Timeout
  private readonly journal: string

  constructor(private readonly file = USENET_CACHE_FILE) {
    this.journal = usenetCacheJournalFile(file)
  }

  private restore(record: UsenetCacheRecord, journaled: boolean): void {
    const key = usenetCacheKey(record.provider, record.fingerprint, record.hash)
    // A journal left behind by an interrupted compaction must not roll back newer snapshot state.
    const existing = this.records.get(key)
    if (journaled && existing && existing.lastAttemptAt > record.lastAttemptAt) return
    this.records.set(key, record)
    this.persisted.set(key, record)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const stored = readJson<unknown>(this.file, undefined, 'Usenet cache could not be restored')
    if (stored !== undefined) {
      if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.records))
        log('WARNING', 'Usenet cache could not be restored (invalid schema)')
      else
        for (const value of stored.records) {
          const record = storedRecord(value)
          if (!record) {
            log('WARNING', 'Usenet cache ignored an invalid record')
            continue
          }
          this.restore(record, false)
        }
    }
    let journaled = 0
    if (existsSync(this.journal)) {
      let lines: string[] = []
      try {
        lines = readFileSync(this.journal, 'utf8').split('\n')
      } catch (error) {
        log(
          'WARNING',
          `Usenet cache journal could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
      for (const line of lines) {
        if (!line.trim()) continue
        // A torn final line from an abrupt exit is expected and skipped.
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        const record = storedRecord(value)
        if (record) {
          this.restore(record, true)
          journaled++
        }
      }
    }
    this.bound()
    if (journaled) this.changed()
  }

  get(key: string): UsenetCacheRecord | undefined {
    this.load()
    return this.records.get(key)
  }

  set(record: UsenetCacheRecord, settings: ProviderSettings): void {
    this.load()
    const key = usenetCacheKey(record.provider, record.fingerprint, record.hash)
    const secrets = [settings.apiKey || '']
    try {
      const url = new URL(settings.baseUrl)
      secrets.push(decodeURIComponent(url.username), decodeURIComponent(url.password), ...url.searchParams.values())
    } catch {
      /* Invalid provider configuration has no credential fields to extract. */
    }
    const persisted: UsenetCacheRecord = {
      provider: record.provider,
      fingerprint: record.fingerprint,
      hash: record.hash,
      checkedAt: record.checkedAt,
      lastAttemptAt: record.lastAttemptAt,
      retryAt: record.retryAt,
      ...(record.lookup ? { lookup: observation(record.lookup, record.provider, record.hash, secrets) } : {}),
      ...(record.failure
        ? {
            failure: {
              kind: 'failed',
              code: record.failure.code,
              message: `Provider lookup failed (${record.failure.code})`,
            },
          }
        : {}),
      ...(record.negativeStreak ? { negativeStreak: record.negativeStreak } : {}),
    }
    this.records.set(key, record)
    this.persisted.set(key, persisted)
    this.bound()
    this.changed()
    if (record.lookup && !record.failure) this.checkpoint(persisted)
  }

  /** Durably record one observation without rewriting the snapshot. */
  private checkpoint(record: UsenetCacheRecord): void {
    try {
      appendFileSync(this.journal, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      log(
        'WARNING',
        `Usenet cache journal could not be written: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
      this.flush()
    }
  }

  retainCompatible(fingerprints: Record<UsenetProvider, string>): void {
    this.prune(record => record.fingerprint === fingerprints[record.provider])
  }

  /** Drop observations for source hashes the current results no longer reference. */
  retainHashes(hashes: ReadonlySet<string>): number {
    return this.prune(record => hashes.has(record.hash))
  }

  private prune(keep: (record: UsenetCacheRecord) => boolean): number {
    this.load()
    let removed = 0
    for (const [key, record] of this.records) {
      if (keep(record)) continue
      this.records.delete(key)
      this.persisted.delete(key)
      removed++
    }
    if (removed) this.changed()
    return removed
  }

  get size(): number {
    this.load()
    return this.records.size
  }

  private bound(): void {
    if (this.records.size <= USENET_CACHE_LIMIT) return
    const oldest = [...this.records.entries()]
      .sort((left, right) => left[1].lastAttemptAt - right[1].lastAttemptAt)
      .slice(0, this.records.size - USENET_CACHE_LIMIT)
    for (const [key] of oldest) {
      this.records.delete(key)
      this.persisted.delete(key)
    }
  }

  private changed(): void {
    this.dirty = true
    this.schedule(COMPACT_DELAY_MS)
  }

  private schedule(delay: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delay)
    this.timer.unref?.()
  }

  /** Rewrite the snapshot and truncate the journal it now contains. */
  flush(): boolean {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return true
    try {
      writeJsonAtomic(this.file, { version: 1, records: [...this.persisted.values()] }, false, 0o600)
      this.dirty = false
    } catch (error) {
      log('ERROR', `Usenet cache could not be persisted: ${error instanceof Error ? error.message : 'unknown error'}`)
      this.schedule(WRITE_RETRY_MS)
      return false
    }
    try {
      rmSync(this.journal, { force: true })
    } catch (error) {
      log(
        'WARNING',
        `Usenet cache journal could not be truncated: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
    return true
  }

  /** Tests can clear RAM without deleting persisted data, or reload it to simulate a restart. */
  reset(restoreFromDisk = false): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.records.clear()
    this.persisted.clear()
    this.loaded = !restoreFromDisk
    this.dirty = false
  }
}
