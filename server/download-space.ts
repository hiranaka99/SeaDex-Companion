import { configuredArrInstances, instanceCategory } from '../shared/arr-instances.js'
import type { DownloadClients, DownloadSpaceLocation } from './download-client-types.js'
import { modeAllowsProtocol } from '../shared/download-contracts.js'
import type { Config } from './types.js'

export type { DownloadSpaceLocation }

/**
 * Free space for every destination the library can download to: qBittorrent's save path for each
 * configured category, and SABnzbd's completed folder. Nothing is read for a client the download
 * mode does not use. Failures are reported per destination rather than thrown.
 */
export async function downloadSpace(config: Config, clients: DownloadClients): Promise<DownloadSpaceLocation[]> {
  const instances = configuredArrInstances(config)
  const locations: DownloadSpaceLocation[] = []
  for (const client of Object.values(clients)) {
    if (!modeAllowsProtocol(config.download_mode, client.protocol)) continue
    const categories = [...new Set(instances.map(instance => instanceCategory(instance, client.protocol)))]
    locations.push(...(await client.freeSpace(categories)))
  }
  return locations
}
