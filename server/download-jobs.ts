import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './paths.js'
import { readJson, writeJsonAtomic } from './persistence.js'
import { errorMessage, log } from './logging.js'
import { planTorrents } from '../shared/download-plan.js'
import { jobResult, type DownloadJob, type DownloadSelection } from '../shared/download-jobs.js'
import { downloadCategory } from './config.js'
import { indexResultReleases, type BulkDownloadTarget } from './downloads.js'
import { qbGetTorrents, qbBulkAddTorrents } from './qbittorrent.js'
import { forgetOwnedTorrents, recordOwnedDownload } from './download-store.js'
import type { Config, JsonObject } from './types.js'

export class DownloadJobConflict extends Error {}

export function createDownloadJobStore(storage: { read: () => unknown; write: (jobs: DownloadJob[]) => void }) {
  let jobs: DownloadJob[] = []
  let restored = false
  const save = (next: DownloadJob[]) => { storage.write(structuredClone(next)); jobs = next }
  const update = (id: string, mutate: (job: DownloadJob) => void): DownloadJob => {
    const next = structuredClone(jobs)
    const job = next.find(job => job.id === id)
    if (!job) throw new Error('Download job not found')
    mutate(job); save(next); return structuredClone(job)
  }
  const validJob = (value: unknown): value is DownloadJob => {
    if (!value || typeof value !== 'object') return false
    const job = value as Record<string, unknown>
    const hashes = (items: unknown): boolean => Array.isArray(items) && items.every(hash => typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash))
    return typeof job.id === 'string' && typeof job.finished === 'boolean' && hashes(job.pending) && hashes(job.added) && hashes(job.existing)
      && Array.isArray(job.targets) && job.targets.every(target => target && typeof target.key === 'string' && Number.isInteger(target.release) && target.release >= 0)
      && Array.isArray(job.failures) && job.failures.every(failure => failure && typeof failure.hash === 'string' && typeof failure.label === 'string' && typeof failure.error === 'string')
  }
  return {
    restore() {
      if (restored) return
      restored = true
      const saved = storage.read()
      if (!Array.isArray(saved)) return
      const next = structuredClone(saved.filter(validJob).slice(-20))
      let interrupted = false
      for (const job of next) if (!job.finished) {
        interrupted = true
        job.failures.push(...job.pending.map(hash => ({ hash, label: hash, error: 'Server restarted before this torrent settled. Check qBittorrent before retrying.' })))
        job.pending = []; job.finished = true
      }
      if (interrupted) save(next); else jobs = next
    },
    get(id?: string): DownloadJob | null { const job = id ? jobs.find(job => job.id === id) : jobs.at(-1); return job ? structuredClone(job) : null },
    active(): boolean { return jobs.some(job => !job.finished) },
    begin(targets: DownloadSelection[], hashes: string[]): DownloadJob {
      restored = true
      if (jobs.some(job => !job.finished)) throw new DownloadJobConflict('Another bulk operation is already running')
      const job: DownloadJob = { id: randomUUID(), finished: false, pending: [...new Set(hashes)], added: [], failures: [], existing: [], targets: structuredClone(targets) }
      save([...jobs.slice(-19), job]); return structuredClone(job)
    },
    existing(id: string, hashes: string[]) {
      return update(id, job => { job.existing = hashes; job.pending = job.pending.filter(hash => !hashes.includes(hash)) })
    },
    settle(id: string, hash: string, label: string, error: string | null) {
      return update(id, job => {
        if (!job.pending.includes(hash)) return
        job.pending = job.pending.filter(value => value !== hash)
        if (error) job.failures.push({ hash, label, error }); else job.added.push(hash)
      })
    },
    finish(id: string, error = 'Torrent did not settle; check qBittorrent before retrying.') {
      return update(id, job => {
        job.failures.push(...job.pending.map(hash => ({ hash, label: hash, error })))
        job.pending = []; job.finished = true
      })
    },
  }
}

const JOBS_FILE = join(DATA_DIR, 'download_jobs.json')
export const downloadJobs = createDownloadJobStore({ read: () => readJson<unknown>(JOBS_FILE, []), write: jobs => writeJsonAtomic(JOBS_FILE, jobs) })

/** Captures the complete plan and its associations before starting external work. */
export function submitDownloadJob(config: Config, targets: BulkDownloadTarget[], results: JsonObject[]) {
  results = structuredClone(results)
  const plan = planTorrents(targets.map(target => {
    const result = results.find(result => result.key === target.key)!
    return { release: result.releases[target.release], category: downloadCategory(config, target.arr), label: `${result.title || target.key}${target.part ? ` · ${target.part}` : ''}` }
  }))
  const index = indexResultReleases(results, targets)
  const job = downloadJobs.begin(targets.map(({ key, release }) => ({ key, release })), plan.map(torrent => torrent.hash))
  const completion = (async () => {
    try {
      if (!plan.length) return jobResult(downloadJobs.finish(job.id))
      const existing = new Set((await qbGetTorrents(config)).map(torrent => String(torrent.hash).toLowerCase()))
      downloadJobs.existing(job.id, plan.filter(torrent => existing.has(torrent.hash)).map(torrent => torrent.hash))
      await qbBulkAddTorrents(config, plan.filter(torrent => !existing.has(torrent.hash)).map(torrent => ({ ...torrent, label: torrent.labels.join(' / ') || torrent.hash })), {
        onSettle: (hash, error) => downloadJobs.settle(job.id, hash, plan.find(torrent => torrent.hash === hash)!.labels.join(' / '), error),
        ownership: {
          record: hash => recordOwnedDownload(hash, index.byHash.get(hash)!),
          forget: hash => forgetOwnedTorrents([hash]),
        },
      })
      return jobResult(downloadJobs.finish(job.id))
    } catch (error) {
      const message = errorMessage(error)
      log('ERROR', `Download job ${job.id} failed: ${message}`)
      return jobResult(downloadJobs.finish(job.id, message))
    }
  })()
  // HTTP clients may disconnect after acceptance; completion belongs to the service.
  void completion.catch(error => log('ERROR', `Could not persist download job ${job.id}: ${errorMessage(error)}`))
  return { job, completion }
}
