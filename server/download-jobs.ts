import { isInfoHash } from '../shared/ids.js'
import { isRecord } from '../shared/guards.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './paths.js'
import { HttpError } from './http-error.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import type {
  DownloadJob,
  DownloadProtocol,
  DownloadSelection,
  DownloadUnitEntry,
  DownloadUnitFailure,
} from '../shared/download-contracts.js'

export class DownloadJobConflict extends HttpError {
  constructor(message: string) {
    super(409, message, { ok: false })
  }
}

const RESTART_MESSAGE = 'The server restarted before this download settled. Check the download client before retrying.'

interface UnitSeed {
  unit_id: string
  protocol: DownloadProtocol
  source_hash: string
  label: string
  selections: DownloadUnitEntry['selections']
}

const object = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null)
const validProtocol = (value: unknown): value is DownloadProtocol => value === 'torrent' || value === 'usenet'
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' && value ? value : fallback)

const validEntry = (value: unknown): value is DownloadUnitEntry => {
  const entry = object(value)
  return Boolean(
    entry &&
    typeof entry.unit_id === 'string' &&
    validProtocol(entry.protocol) &&
    typeof entry.source_hash === 'string' &&
    Array.isArray(entry.selections),
  )
}

const validFailure = (value: unknown): value is DownloadUnitFailure => {
  const failure = object(value)
  return Boolean(
    failure &&
    validProtocol(failure.protocol) &&
    typeof failure.label === 'string' &&
    typeof failure.error === 'string' &&
    Array.isArray(failure.selections),
  )
}

const validTargets = (value: unknown): value is DownloadSelection[] =>
  Array.isArray(value) &&
  value.every(raw => {
    const target = object(raw)
    return Boolean(
      target && typeof target.key === 'string' && Number.isInteger(target.release) && (target.release as number) >= 0,
    )
  })

/** One legacy v1 hash entry into a protocol-neutral unit; selections fall back to the job's rows. */
function legacyUnit(
  value: unknown,
  label: string,
  fallbackSelections: { key: string; release: number }[],
): DownloadUnitEntry | null {
  if (!isInfoHash(value)) return null
  const hash = value.toLowerCase()
  return {
    unit_id: `torrent:${hash}`,
    protocol: 'torrent',
    source_hash: hash,
    native_id: hash,
    label: label || hash,
    selections: fallbackSelections,
  }
}

/** Loads the current v2 envelope or migrates a legacy v1 hash-array file without losing outcomes. */
function decodeJobs(value: unknown): DownloadJob[] {
  const container = object(value)
  const rawJobs: unknown[] = Array.isArray(value)
    ? value
    : container && container.version === 2 && Array.isArray(container.jobs)
      ? container.jobs
      : []
  return rawJobs.flatMap(raw => {
    const job = object(raw)
    if (!job || typeof job.id !== 'string' || typeof job.finished !== 'boolean' || !validTargets(job.targets)) return []
    const targets = job.targets
    const rows = targets.map(({ key, release }) => ({ key, release }))
    const labelsByHash = new Map<string, string>()
    if (Array.isArray(job.failures))
      for (const rawFailure of job.failures) {
        const failure = object(rawFailure)
        if (failure && isInfoHash(failure.hash))
          labelsByHash.set(failure.hash.toLowerCase(), text(failure.label, failure.hash.toLowerCase()))
      }
    const mapEntries = (items: unknown): DownloadUnitEntry[] =>
      Array.isArray(items)
        ? items.flatMap(item => {
            if (validEntry(item)) return [item]
            const unit = legacyUnit(item, isInfoHash(item) ? labelsByHash.get(item.toLowerCase()) || '' : '', rows)
            return unit ? [unit] : []
          })
        : []
    const failures: DownloadUnitFailure[] = Array.isArray(job.failures)
      ? job.failures.flatMap(failure => {
          if (validFailure(failure)) return [failure]
          const legacy = object(failure)
          if (legacy && isInfoHash(legacy.hash) && typeof legacy.error === 'string') {
            const hash = legacy.hash.toLowerCase()
            return [
              {
                unit_id: `torrent:${hash}`,
                protocol: 'torrent' as const,
                source_hash: hash,
                label: text(legacy.label, hash),
                code: 'failed',
                error: legacy.error,
                selections: rows,
              },
            ]
          }
          return []
        })
      : []
    return [
      {
        id: job.id,
        finished: job.finished === true,
        pending: mapEntries(job.pending),
        added: mapEntries(job.added),
        existing: mapEntries(job.existing),
        failures,
        targets,
      },
    ]
  })
}

export function createDownloadJobStore(storage: { read: () => unknown; write: (jobs: DownloadJob[]) => void }) {
  let jobs: DownloadJob[] = []
  let restored = false
  const save = (next: DownloadJob[]) => {
    storage.write(structuredClone(next))
    jobs = next
  }
  const update = (id: string, mutate: (job: DownloadJob) => void): DownloadJob => {
    const next = structuredClone(jobs)
    const job = next.find(job => job.id === id)
    if (!job) throw new Error('Download job not found')
    mutate(job)
    save(next)
    return structuredClone(job)
  }
  const mutateUnit = (
    id: string,
    unitId: string,
    settle: (job: DownloadJob, unit: DownloadUnitEntry) => void,
  ): DownloadJob =>
    update(id, job => {
      const unit = job.pending.find(unit => unit.unit_id === unitId)
      if (!unit) return
      job.pending = job.pending.filter(candidate => candidate.unit_id !== unitId)
      settle(job, unit)
    })
  return {
    restore() {
      if (restored) return
      restored = true
      const next = decodeJobs(storage.read()).slice(-20)
      let interrupted = false
      for (const job of next)
        if (!job.finished) {
          interrupted = true
          job.failures.push(...job.pending.map(unit => ({ ...unit, code: 'interrupted', error: RESTART_MESSAGE })))
          job.pending = []
          job.finished = true
        }
      if (interrupted) save(next)
      else jobs = next
    },
    get(id?: string): DownloadJob | null {
      const job = id ? jobs.find(job => job.id === id) : jobs.at(-1)
      return job ? structuredClone(job) : null
    },
    active(): boolean {
      return jobs.some(job => !job.finished)
    },
    begin(
      targets: DownloadSelection[],
      units: UnitSeed[],
      initial?: { existing?: DownloadUnitEntry[]; failures?: DownloadUnitFailure[] },
    ): DownloadJob {
      restored = true
      if (jobs.some(job => !job.finished)) throw new DownloadJobConflict('Another bulk operation is already running')
      const job: DownloadJob = {
        id: randomUUID(),
        finished: false,
        pending: structuredClone(units),
        added: [],
        failures: structuredClone(initial?.failures || []),
        existing: structuredClone(initial?.existing || []),
        targets: structuredClone(targets),
      }
      save([...jobs.slice(-19), job])
      return structuredClone(job)
    },
    added(id: string, unitId: string, extra?: { record_id?: string; native_id?: string }) {
      return mutateUnit(id, unitId, (job, unit) => {
        job.added.push({ ...unit, ...extra })
      })
    },
    failure(id: string, failure: DownloadUnitFailure) {
      return update(id, job => {
        job.pending = job.pending.filter(unit => unit.unit_id !== failure.unit_id)
        job.failures.push(failure)
      })
    },
    finish(id: string, error = 'The download did not settle; check the client before retrying.') {
      return update(id, job => {
        job.failures.push(...job.pending.map(unit => ({ ...unit, code: 'unsettled', error })))
        job.pending = []
        job.finished = true
      })
    },
  }
}

const JOBS_FILE = join(DATA_DIR, 'download_jobs.json')
export const downloadJobs = createDownloadJobStore({
  read: () => readJson<unknown>(JOBS_FILE, []),
  write: jobs => writeJsonAtomic(JOBS_FILE, { version: 2, jobs }),
})
