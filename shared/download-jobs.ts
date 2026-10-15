export interface DownloadSelection { key: string; release: number; identity?: string }
export interface DownloadFailure { hash: string; label: string; error: string }
export interface DownloadJob {
  id: string
  finished: boolean
  pending: string[]
  added: string[]
  failures: DownloadFailure[]
  existing: string[]
  targets: DownloadSelection[]
}

export function jobResult(job: DownloadJob) {
  return { ok: job.added.length > 0, count: job.added.length, targets: job.targets, existing: job.existing, failures: job.failures }
}
