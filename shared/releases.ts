/** Identity includes file scope so a refreshed recommendation cannot silently change a selection. */
export function releaseIdentity(release: { part?: string; releaseGroup?: string; tracker?: string; info_hashes?: string[]; selected_files?: string[] }): string {
  return JSON.stringify([
    release.part || '', release.releaseGroup || '', release.tracker || '',
    [...(release.info_hashes || [])].map(hash => hash.toLowerCase()).sort(),
    [...(release.selected_files || [])].sort(),
  ])
}
