import { getBulkDownloadStatus, type BulkDownloadStatus } from './api.js'

const subscribers = new Set<(job: BulkDownloadStatus) => void>()
let latest: BulkDownloadStatus | null = null
let timer: number | undefined
let generation = 0
let watching = false
let selectedId: string | undefined

function publish(job: BulkDownloadStatus): void {
  if (JSON.stringify(job) === JSON.stringify(latest)) return
  latest = job
  for (const callback of [...subscribers]) callback(job)
}

async function poll(current = generation): Promise<void> {
  try {
    const job = await getBulkDownloadStatus(selectedId)
    if (current !== generation) return
    publish(job)
    if (job.finished) selectedId = undefined
  } catch { /* Connectivity failures leave the job running; retry from the same ID. */ }
  finally {
    if (current === generation) {
      if (subscribers.size) timer = window.setTimeout(() => void poll(current), latest?.finished ? 10_000 : 700)
      else watching = false
    }
  }
}

/** Submission progress and reload recovery share one observer and one timer. */
export function watchBulkDownloadStatus(callback: (job: BulkDownloadStatus) => void): () => void {
  subscribers.add(callback)
  if (latest) callback(latest)
  if (!watching) { watching = true; void poll() }
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) { window.clearTimeout(timer); generation += 1; watching = false }
  }
}

export function waitForDownloadJob(job: BulkDownloadStatus, onProgress?: (job: BulkDownloadStatus) => void): Promise<BulkDownloadStatus> {
  selectedId = job.id || undefined
  window.clearTimeout(timer); generation += 1
  publish(job)
  return new Promise(resolve => {
    const callback = (status: BulkDownloadStatus) => {
      if (status.id !== job.id) return
      onProgress?.(status)
      if (status.finished) { subscribers.delete(callback); resolve(status) }
    }
    subscribers.add(callback)
    callback(job)
    watching = true
    void poll()
  })
}
