import * as api from './api.js'
import type { SelectionInput, UsenetAvailabilityResult } from './api.js'

export const availabilityKey = (row: Pick<SelectionInput, 'key' | 'release' | 'identity'>) =>
  `${row.key}\u0000${row.release}\u0000${row.identity || ''}`

export interface AvailabilitySnapshot {
  rows: Record<string, UsenetAvailabilityResult>
  configGeneration: number | null
  sabnzbdConfigured: boolean
  loading: boolean
  error: string | null
}

export function availabilityErrors(rows: UsenetAvailabilityResult[]): string | null {
  const errors = new Set<string>()
  for (const row of rows) {
    if (row.refresh_error) errors.add(row.refresh_error)
    for (const hash of row.hashes) {
      if (hash.refresh_error) errors.add(hash.refresh_error)
      if (hash.state === 'lookup_failed') errors.add(hash.error || 'A provider lookup failed')
    }
  }
  return errors.size ? [...errors].join('; ') : null
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  // The ES2020 browser target requires the Promise constructor; withResolvers is unavailable.
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      window.clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Observe cheap snapshots only while these exact release identities are refreshing. */
export async function observeUsenetAvailability(
  selections: SelectionInput[],
  options: {
    signal: AbortSignal
    refresh?: boolean
    initial?: AvailabilitySnapshot | null
    onSnapshot: (snapshot: AvailabilitySnapshot) => void
  },
): Promise<void> {
  const { signal, onSnapshot } = options
  const expected = new Set(selections.map(availabilityKey))
  let snapshot: AvailabilitySnapshot = {
    rows: Object.fromEntries(Object.entries(options.initial?.rows || {}).filter(([key]) => expected.has(key))),
    configGeneration: options.initial?.configGeneration ?? null,
    sabnzbdConfigured: options.initial?.sabnzbdConfigured ?? false,
    loading: selections.length > 0,
    error: options.initial?.error ?? null,
  }
  let pending = selections
  let first = true
  const publish = () => {
    if (!signal.aborted) onSnapshot(snapshot)
  }
  publish()
  try {
    while (pending.length && !signal.aborted) {
      let restart = false
      for (let offset = 0; offset < pending.length; offset += 200) {
        const batch = pending.slice(offset, offset + 200)
        const response = await api.usenetAvailability(batch, first && options.refresh === true, signal)
        if (signal.aborted) return
        if (!response.ok) throw new Error(response.error || 'Could not check Usenet sources')
        const changed = snapshot.configGeneration !== null && snapshot.configGeneration !== response.config_generation
        const rows: Record<string, UsenetAvailabilityResult> = changed ? {} : { ...snapshot.rows }
        if (changed && (pending.length !== selections.length || offset > 0)) restart = true
        const requested = new Set(batch.map(availabilityKey))
        const received = new Set<string>()
        for (const row of response.results)
          if (requested.has(availabilityKey(row))) {
            rows[availabilityKey(row)] = row
            received.add(availabilityKey(row))
          }
        snapshot = {
          rows,
          configGeneration: response.config_generation,
          sabnzbdConfigured: response.sabnzbd_configured,
          loading: offset + batch.length < pending.length,
          error: availabilityErrors(Object.values(rows)),
        }
        if (received.size !== requested.size) throw new Error('Usenet snapshot did not include the requested release')
        publish()
      }
      first = false
      pending = restart
        ? selections
        : selections.filter(selection => snapshot.rows[availabilityKey(selection)]?.refreshing)
      if (pending.length && !restart) await waitForPoll(signal)
    }
  } catch (error) {
    if (signal.aborted) return
    const message = error instanceof Error ? error.message : 'Could not check Usenet sources'
    const failed = new Set(pending.map(availabilityKey))
    snapshot = {
      ...snapshot,
      loading: false,
      error: message,
      rows: Object.fromEntries(
        Object.entries(snapshot.rows).map(([key, row]) => [
          key,
          failed.has(key) ? { ...row, refreshing: false, refresh_error: message } : row,
        ]),
      ),
    }
    publish()
  }
}
