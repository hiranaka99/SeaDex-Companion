import type { Config } from './types.js'
import type { DownloadClients } from './download-client-types.js'
import { qbittorrentAdapter } from './qbittorrent-adapter.js'
import { sabnzbdAdapter } from './sabnzbd-adapter.js'

/** The client that carries each protocol, bound to the given configuration. Torrents come first wherever both are walked. */
export function downloadClients(config: Config): DownloadClients {
  return { torrent: qbittorrentAdapter(config), usenet: sabnzbdAdapter(config) }
}
