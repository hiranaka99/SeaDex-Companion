import type { Release, ResultItem } from '../../shared/contracts.js'
import { normalizeTorrentPath, releaseForbidden } from '../../shared/download-plan.js'
import { normalizeInfoHash } from '../../shared/ids.js'
import { VIDEO_FILE, sameRelease } from '../../shared/releases.js'

const label = (release: Release) => `${release.releaseGroup} (${release.tracker})`
const partOf = (release: Release) => release.part || 'the season'

/**
 * The torrents a selected file can come from: the release's torrents whose file list holds it, else every
 * torrent of the release, by info hash or private-tracker file-list ID. Empty for a release with neither.
 */
function torrentsOf(release: Release, file: string): string[] {
  const holding = (release.torrent_files || [])
    .filter(torrent => torrent.files.some(listed => normalizeTorrentPath(listed.name) === file))
    .flatMap(torrent => normalizeInfoHash(torrent.hash) ?? [])
  if (holding.length) return holding
  const hashes = release.info_hashes.flatMap(hash => normalizeInfoHash(hash) ?? [])
  return hashes.length ? hashes : (release.private_sources || []).map(source => source.id)
}

/** A listed release in the shape `sameRelease` reads, with a private-tracker copy identified by its files. */
const listing = (release: Release) => ({
  releaseGroup: release.releaseGroup,
  info_hashes: release.info_hashes,
  torrent_files: release.torrent_files,
  selected_files: release.selected_files,
  source_files: release.private_sources?.flatMap(source => source.files),
})

/** The files a listing selects: its explicit `selected_files`, or every video file when the whole source is taken. */
function selectedFilesOf(release: Release): string[] {
  if (release.selected_files?.length) return release.selected_files
  const listed = [
    ...(release.torrent_files || []).flatMap(torrent => torrent.files),
    ...(release.private_sources || []).flatMap(source => source.files),
  ]
  return listed.filter(file => VIDEO_FILE.test(file.name)).map(file => file.name)
}

/**
 * Rules every season result's release listing keeps, whatever the catalog and library:
 * - each part selects its own files, so no source file is selected for two parts (whether selected explicitly
 *   or by taking the whole source);
 * - a part lists each release once, so two listings proven to be one release (a shared torrent, or the same
 *   video files byte for byte) never appear in the same part;
 * - a release excluded for its episode order is never the target and never offers a download, so it selects no
 *   files of its own.
 * Returns one sentence per broken rule, empty when the listing keeps them all.
 */
export function listingViolations(result: ResultItem): string[] {
  const violations: string[] = []
  const selectedIn = new Map<string, string>()
  for (const release of result.releases) {
    if (releaseForbidden(release)) {
      const misfit = `although it does not fit the series' episode order`
      if (release.target) violations.push(`${label(release)} is the target of ${partOf(release)}, ${misfit}`)
      if (release.selected_files?.length) violations.push(`${label(release)} selects files to download, ${misfit}`)
      // Never downloaded, so it takes no file from another part.
      continue
    }
    for (const file of new Set(selectedFilesOf(release))) {
      const path = normalizeTorrentPath(file)
      const earlier = new Set<string>()
      for (const torrent of torrentsOf(release, path)) {
        const key = `${torrent}\0${path}`
        const part = selectedIn.get(key)
        if (part === undefined) selectedIn.set(key, partOf(release))
        else if (part !== partOf(release)) earlier.add(part)
      }
      for (const part of earlier)
        violations.push(`${label(release)} selects "${file}" in both ${part} and ${partOf(release)}`)
    }
  }
  result.releases.forEach((release, index) => {
    for (const other of result.releases.slice(index + 1)) {
      if (partOf(other) === partOf(release) && sameRelease(listing(release), listing(other)))
        violations.push(`${partOf(release)} lists ${label(release)} and ${label(other)}, which are the same release`)
    }
  })
  return violations
}
