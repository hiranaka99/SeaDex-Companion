import type { ArrInstanceConfig, ArrKind, Config, LibraryScope } from '../shared/contracts.js'
import { EMPTY_LIBRARY_SCOPE } from '../shared/settings.js'

/** One Sonarr or Radarr connection, whether it is the first of its kind or an additional instance. */
export interface ArrInstance {
  /** `sonarr` or `radarr` for the first instance of each kind, otherwise the saved identifier. */
  id: string
  kind: ArrKind
  /** Application name carried by results. */
  arr: 'Sonarr' | 'Radarr'
  /** Unique display name; also the key of scan errors for this source. */
  name: string
  primary: boolean
  url: string
  key: string
  category: string
  sabnzbd_category: string
  scope: LibraryScope
}

export const ARR_NAMES: Record<ArrKind, 'Sonarr' | 'Radarr'> = { sonarr: 'Sonarr', radarr: 'Radarr' }
export const PRIMARY_INSTANCE_IDS: readonly string[] = ['sonarr', 'radarr']
type InstanceSource = Partial<
  Pick<
    Config,
    | 'sonarr_url'
    | 'sonarr_key'
    | 'sonarr_category'
    | 'sabnzbd_sonarr_category'
    | 'sonarr_scope'
    | 'radarr_url'
    | 'radarr_key'
    | 'radarr_category'
    | 'sabnzbd_radarr_category'
    | 'radarr_scope'
    | 'arr_instances'
  >
>

function extraInstance(instance: ArrInstanceConfig): ArrInstance {
  return {
    id: instance.id,
    kind: instance.kind,
    arr: ARR_NAMES[instance.kind],
    name: instance.name,
    primary: false,
    url: instance.url,
    key: instance.key,
    category: instance.category,
    sabnzbd_category: instance.sabnzbd_category,
    scope: instance.scope || EMPTY_LIBRARY_SCOPE,
  }
}

/** Every saved instance in display order: Sonarr, Radarr, then additional instances. */
export function arrInstances(config: InstanceSource): ArrInstance[] {
  return [
    {
      id: 'sonarr',
      kind: 'sonarr',
      arr: 'Sonarr',
      name: 'Sonarr',
      primary: true,
      url: config.sonarr_url || '',
      key: config.sonarr_key || '',
      category: config.sonarr_category || '',
      sabnzbd_category: config.sabnzbd_sonarr_category || '',
      scope: config.sonarr_scope || EMPTY_LIBRARY_SCOPE,
    },
    {
      id: 'radarr',
      kind: 'radarr',
      arr: 'Radarr',
      name: 'Radarr',
      primary: true,
      url: config.radarr_url || '',
      key: config.radarr_key || '',
      category: config.radarr_category || '',
      sabnzbd_category: config.sabnzbd_radarr_category || '',
      scope: config.radarr_scope || EMPTY_LIBRARY_SCOPE,
    },
    ...(config.arr_instances || []).map(extraInstance),
  ]
}

/** Instances that can be scanned: both a URL and an API key are saved. */
export function configuredArrInstances(config: InstanceSource): ArrInstance[] {
  return arrInstances(config).filter(instance => Boolean(instance.url && instance.key))
}

export function findArrInstance(config: InstanceSource, id: string): ArrInstance | undefined {
  return arrInstances(config).find(instance => instance.id === id)
}

/** Prefix of result and library keys. The first instance of each kind keeps the bare application name. */
export function instanceSourceKey(instance: Pick<ArrInstance, 'arr' | 'id' | 'primary'>): string {
  return instance.primary ? instance.arr : `${instance.arr}@${instance.id}`
}

interface SourceRef {
  arr?: unknown
  instance?: unknown
  instance_name?: unknown
}

/** The same prefix derived from a library item or scan result. */
export function sourceKeyOf(ref: SourceRef): string {
  const arr = String(ref.arr || 'Unknown')
  return typeof ref.instance === 'string' && ref.instance ? `${arr}@${ref.instance}` : arr
}

/** Display name of the instance a library item or scan result came from. */
export function sourceNameOf(ref: SourceRef): string {
  return typeof ref.instance_name === 'string' && ref.instance_name ? ref.instance_name : String(ref.arr || 'Unknown')
}

export function instanceOf(config: InstanceSource, ref: SourceRef): ArrInstance | undefined {
  const id =
    typeof ref.instance === 'string' && ref.instance
      ? ref.instance
      : ref.arr === 'Sonarr'
        ? 'sonarr'
        : ref.arr === 'Radarr'
          ? 'radarr'
          : ''
  return id ? findArrInstance(config, id) : undefined
}

/** Fields an item or result carries so its instance stays identifiable after a rescan. */
export function instanceFields(instance: Pick<ArrInstance, 'id' | 'name' | 'primary'>): {
  instance?: string
  instance_name?: string
} {
  return instance.primary ? {} : { instance: instance.id, instance_name: instance.name }
}

/** Reads the instance and item ID back out of a library key such as `Sonarr:item10` or `Sonarr@4k:item10`. */
export function parseLibraryKey(
  libraryKey: string,
): { instanceId: string; arr: 'Sonarr' | 'Radarr'; itemId: number } | null {
  const match = /^(Sonarr|Radarr)(?:@([a-z0-9]+))?:item(\d+)$/.exec(libraryKey)
  if (!match) return null
  const arr = match[1] as 'Sonarr' | 'Radarr'
  return { instanceId: match[2] || arr.toLowerCase(), arr, itemId: Number(match[3]) }
}
