import {
  spaceVerdict,
  unitSizing,
  type ClientPresence,
  type ClientSnapshot,
  type DownloadClientAdapter,
  type DownloadClients,
  type DownloadSpaceLocation,
  type LiveJob,
  type SubmissionOwnership,
  type SubmissionUnit,
} from '../../server/download-client-types.js'
import type { OwnedDownloadRecord } from '../../server/download-store.js'
import type { DiskSpaceCheck, DownloadClient, DownloadProtocol } from '../../shared/download-contracts.js'

export interface MemoryClientOptions {
  endpointId?: string
  jobs?: Map<string, LiveJob>
  presenceComplete?: boolean
  readComplete?: boolean
  freeBytes?: number | null
  missingCategories?: string[] | null
  spaceLocations?: DownloadSpaceLocation[]
  submit?: (unit: SubmissionUnit, ownership: SubmissionOwnership) => Promise<string> | string
  ambiguity?: (error: unknown) => string | null
  diskChecks?: (units: SubmissionUnit[]) => Promise<DiskSpaceCheck[]> | DiskSpaceCheck[]
  freeSpace?: (categories: string[]) => Promise<DownloadSpaceLocation[]> | DownloadSpaceLocation[]
  control?: (nativeId: string, action: 'pause' | 'resume') => Promise<void> | void
  remove?: (nativeId: string, removeFiles: boolean, job: LiveJob | undefined) => Promise<void> | void
  adoptUnconfirmed?: (records: OwnedDownloadRecord[]) => Promise<boolean> | boolean
  forgotten?: (recordId: string) => void
}

export interface MemoryClientState {
  adapter: DownloadClientAdapter
  jobs: Map<string, LiveJob>
  submitted: SubmissionUnit[]
  controls: { nativeId: string; action: 'pause' | 'resume' }[]
  removed: { nativeId: string; removeFiles: boolean }[]
  freeSpaceCalls: string[][]
  forgotten: string[]
  presenceComplete: boolean
  readComplete: boolean
  freeBytes: number | null
  missingCategories: string[] | null
  spaceLocations?: DownloadSpaceLocation[]
}

const CLIENT_DEFAULTS: Record<
  DownloadProtocol,
  {
    client: DownloadClient
    label: string
    jobNoun: string
    endpointId: string
    nativeIdIsSourceHash: boolean
    notControllable: string
  }
> = {
  torrent: {
    client: 'qbittorrent',
    label: 'qBittorrent',
    jobNoun: 'torrent',
    endpointId: 'memory://qbittorrent',
    nativeIdIsSourceHash: true,
    notControllable: 'This torrent is no longer in qBittorrent.',
  },
  usenet: {
    client: 'sabnzbd',
    label: 'SABnzbd',
    jobNoun: 'job',
    endpointId: 'memory://sabnzbd',
    nativeIdIsSourceHash: false,
    notControllable: 'This job is not in the SABnzbd queue anymore.',
  },
}

function createMemoryClient(protocol: DownloadProtocol, options: MemoryClientOptions = {}): MemoryClientState {
  const meta = CLIENT_DEFAULTS[protocol]
  let nextId = 0
  const state: MemoryClientState = {
    adapter: undefined as unknown as DownloadClientAdapter,
    jobs: options.jobs ? new Map(options.jobs) : new Map(),
    submitted: [],
    controls: [],
    removed: [],
    freeSpaceCalls: [],
    forgotten: [],
    presenceComplete: options.presenceComplete ?? true,
    readComplete: options.readComplete ?? true,
    freeBytes: options.freeBytes === undefined ? 500_000_000_000 : options.freeBytes,
    missingCategories: options.missingCategories === undefined ? [] : options.missingCategories,
    ...(options.spaceLocations ? { spaceLocations: options.spaceLocations } : {}),
  }

  state.adapter = {
    protocol,
    client: meta.client,
    label: meta.label,
    jobNoun: meta.jobNoun,
    endpointId: options.endpointId ?? meta.endpointId,
    nativeIdIsSourceHash: meta.nativeIdIsSourceHash,
    notControllable: meta.notControllable,
    async read(): Promise<ClientSnapshot> {
      return { jobs: new Map(state.jobs), complete: state.readComplete }
    },
    async presence(): Promise<ClientPresence> {
      return { ids: new Set(state.jobs.keys()), complete: state.presenceComplete }
    },
    async submit(unit, ownership) {
      state.submitted.push(unit)
      if (options.submit) return await options.submit(unit, ownership)
      const nativeId = protocol === 'torrent' ? unit.source_hash : `nzo-${++nextId}`
      ownership.accepted([nativeId])
      state.jobs.set(nativeId, {
        phase: 'downloading',
        state: 'downloading',
        progress: 0.1,
        downloaded: 100,
        total_size: unit.size_bytes ?? 1000,
        speed: 100,
        capabilities: { pause: true, resume: false, remove: true, remove_files: true },
        active: true,
      })
      return nativeId
    },
    ambiguity: error => (options.ambiguity ? options.ambiguity(error) : null),
    async control(nativeId, action) {
      state.controls.push({ nativeId, action })
      if (options.control) {
        await options.control(nativeId, action)
        return
      }
      const existing = state.jobs.get(nativeId)
      if (existing) {
        state.jobs.set(nativeId, {
          ...existing,
          phase: action === 'pause' ? 'paused' : 'downloading',
          state: action === 'pause' ? 'paused' : 'downloading',
          capabilities: { ...existing.capabilities, pause: action !== 'pause', resume: action === 'pause' },
        })
      }
    },
    async remove(nativeId, removeFiles, job) {
      state.removed.push({ nativeId, removeFiles })
      if (options.remove) {
        await options.remove(nativeId, removeFiles, job)
        return
      }
      state.jobs.delete(nativeId)
    },
    async diskChecks(units) {
      if (options.diskChecks) return await options.diskChecks(units)
      const { required, uncertain, unsized } = unitSizing(units)
      return [
        {
          client: meta.client,
          path: null,
          label: `${meta.label} storage`,
          categories: [...new Set(units.map(unit => unit.category))],
          required_bytes: required,
          unknown_units: uncertain,
          free_bytes: state.freeBytes,
          sufficient: spaceVerdict(state.freeBytes, required, uncertain - unsized, unsized),
        },
      ]
    },
    async freeSpace(categories) {
      state.freeSpaceCalls.push(categories)
      if (options.freeSpace) return await options.freeSpace(categories)
      if (!state.adapter.endpointId) return []
      if (state.spaceLocations) return state.spaceLocations
      return [{ client: meta.client, label: `${meta.label} storage`, free_bytes: state.freeBytes }]
    },
    async unknownCategories(categories) {
      if (state.missingCategories === null) return null
      const missing = new Set(state.missingCategories)
      return [...new Set(categories.map(category => category.trim()).filter(category => missing.has(category)))]
    },
    ...(options.adoptUnconfirmed
      ? { adoptUnconfirmed: (records: OwnedDownloadRecord[]) => Promise.resolve(options.adoptUnconfirmed!(records)) }
      : {}),
    forgotten: recordId => {
      state.forgotten.push(recordId)
      options.forgotten?.(recordId)
    },
  }

  return state
}

/** Builds in-memory download client adapters and spy state so tests can exercise flows without HTTP. */
export function memoryDownloadClients(options: { torrent?: MemoryClientOptions; usenet?: MemoryClientOptions } = {}): {
  clients: DownloadClients
  torrent: MemoryClientState
  usenet: MemoryClientState
} {
  const torrent = createMemoryClient('torrent', options.torrent)
  const usenet = createMemoryClient('usenet', options.usenet)
  return {
    clients: { torrent: torrent.adapter, usenet: usenet.adapter },
    torrent,
    usenet,
  }
}
