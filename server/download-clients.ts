import type { Config } from './types.js'
import type { DownloadClient, DownloadProtocol } from '../shared/download-contracts.js'
import type { DownloadClientAdapter } from './download-client-types.js'
import { qbittorrentAdapter } from './qbittorrent-adapter.js'
import { sabnzbdAdapter } from './sabnzbd-adapter.js'

export const CLIENT_FOR_PROTOCOL: Record<DownloadProtocol, DownloadClient> = {
  torrent: 'qbittorrent',
  usenet: 'sabnzbd',
}

/** The client that carries each protocol, bound to the given configuration. Torrents come first wherever both are walked. */
export function downloadClients(config: Config): Record<DownloadProtocol, DownloadClientAdapter> {
  return { torrent: qbittorrentAdapter(config), usenet: sabnzbdAdapter(config) }
}
