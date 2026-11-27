import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { usenetCacheJournalFile } from '../../server/usenet-cache.js'
import type { Config, ResultItem } from '../../server/types.js'
import {
  createUsenetRuntime,
  readLedger,
  usenetRuntime,
  type UsenetRuntime,
  type UsenetRuntimeOptions,
} from '../../server/usenet-runtime.js'

export interface TestUsenetRuntime {
  /** The runtime in use: the one created first, or the one the last `restart` created. */
  readonly runtime: UsenetRuntime
  /** Where this runtime keeps the hash-indexer cache, the search store and the stored NZBs. */
  readonly paths: { cache: string; search: string; nzbs: string }
  /**
   * A new process on the same data paths: what was not written to disk is lost, and what was is read again.
   * `overrides` replace options of the first runtime, such as its fetch or pacing.
   */
  restart(overrides?: UsenetRuntimeOptions): UsenetRuntime
  /** A new process on empty data paths: nothing looked up, searched or stored before is known. */
  fresh(overrides?: UsenetRuntimeOptions): UsenetRuntime
  /** Puts the default runtime back and removes the data paths. Called after the test when given one. */
  close(): void
}

/**
 * A fresh Usenet runtime on its own data paths with unpaced schedulers, unless `options` says otherwise. The
 * default runtime is put back when `t` ends, or when `close` is called.
 */
export function testUsenetRuntime(
  t: { after(fn: () => void): void } | undefined,
  options: UsenetRuntimeOptions = {},
): TestUsenetRuntime {
  const dir = fs.mkdtempSync(join(tmpdir(), 'usenet-runtime-'))
  const paths = {
    cache: join(dir, 'usenet_cache.json'),
    search: join(dir, 'usenet_search.json'),
    nzbs: join(dir, 'nzbs'),
  }
  let settings = options
  const build = () =>
    createUsenetRuntime({
      ...settings,
      paths: { ...paths, ...settings.paths },
      pacing: {
        hashes: { minIntervalMs: 0, ...settings.pacing?.hashes },
        search: { minIntervalMs: 0, ...settings.pacing?.search },
      },
    })
  let runtime = build()
  let closed = false
  const handle: TestUsenetRuntime = {
    get runtime() {
      return runtime
    },
    get paths() {
      return { ...paths, ...settings.paths }
    },
    restart(overrides = {}) {
      settings = {
        ...settings,
        ...overrides,
        paths: { ...settings.paths, ...overrides.paths },
        pacing: { ...settings.pacing, ...overrides.pacing },
      }
      runtime = build()
      return runtime
    },
    fresh(overrides = {}) {
      const { cache, search, nzbs } = handle.paths
      for (const file of [cache, usenetCacheJournalFile(cache), search, nzbs])
        fs.rmSync(file, { recursive: true, force: true })
      return handle.restart(overrides)
    },
    close() {
      if (closed) return
      closed = true
      createUsenetRuntime()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
  t?.after(handle.close)
  return handle
}

/** New results, as after a scan: the runtime in use prunes its stores by the ledger and sweeps `results`. */
export function sweepResults(config: Config, results: ResultItem[], reason: string): void {
  usenetRuntime().resultsChanged(config, results, readLedger(), reason)
}
