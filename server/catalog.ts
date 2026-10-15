import { SEADEX, api } from './http.js'
import { episodeFromFilename, type ParsedEpisode } from './matching.js'
import type { JsonObject, ReleaseCandidate, SeaDexEntry } from './types.js'

export function guessQuality(filename: string): string {
  const resolution = filename.match(/(2160p|1080p|720p)/i)?.[1] || '?'
  const source = filename.match(/(Blu-ray|Web-DL|WebRip|BD-Remux)/i)?.[1] || ''
  return `${resolution} ${source}`.trim()
}

export function seasonsFromFiles(files: JsonObject[] = []): Set<number> {
  const seasons = new Set<number>()
  for (const file of files) {
    for (const match of String(file.name || '').matchAll(/S(\d{1,3})E(\d{1,3})/gi)) seasons.add(Number(match[1]))
  }
  return seasons
}

/** Episode numbers from the release's video files, preferring explicit episode labels over incidental numbers in extras. */
function candidateEpisodes(candidate: ReleaseCandidate): number[] {
  const parsed = (candidate.source_files || []).map((file) => episodeFromFilename(file.name)).filter((item): item is ParsedEpisode => item !== null)
  const episodes = parsed.some((item) => item.explicit) ? parsed.filter((item) => item.explicit) : parsed
  return episodes.map((item) => item.episode).filter(Number.isInteger).sort((left, right) => left - right)
}

/**
 * Groups upload a season either as one batched torrent or as multiple
 * complementary torrents (per-episode uploads or partial batches). Complementary
 * uploads from the same group and tracker — ones whose episode coverage does not
 * overlap — are merged into a single candidate so downloading the group queues
 * the entire season. Overlapping uploads (re-releases of the same episodes under
 * new hashes) stay separate so pickBest can choose one torrent.
 */
export function mergeComplementaryCandidates(candidates: ReleaseCandidate[]): ReleaseCandidate[] {
  const sets = new Map<string, Array<{ members: ReleaseCandidate[]; coverage: Set<number> }>>()
  for (const candidate of candidates) {
    const key = `${candidate.releaseGroup.trim().toLowerCase()}\0${String(candidate.tracker || '').trim().toLowerCase()}`
    const episodes = candidateEpisodes(candidate)
    const groupSets = sets.get(key) || []
    // Without episode coverage, separate uploads may be alternate full batches.
    let target = episodes.length ? groupSets.find((set) => set.coverage.size > 0 && !episodes.some((episode) => set.coverage.has(episode))) : undefined
    if (!target) { target = { members: [], coverage: new Set<number>() }; groupSets.push(target); sets.set(key, groupSets) }
    target.members.push(candidate)
    for (const episode of episodes) target.coverage.add(episode)
  }
  const merged: ReleaseCandidate[] = []
  for (const groupSets of sets.values()) {
    for (const set of groupSets) {
      if (set.members.length === 1) { merged.push(set.members[0]); continue }
      const members = [...set.members].sort((left, right) =>
        (candidateEpisodes(left)[0] ?? Number.POSITIVE_INFINITY) - (candidateEpisodes(right)[0] ?? Number.POSITIVE_INFINITY))
      merged.push({
        ...members[0],
        size: members.reduce((sum, member) => sum + (member.size || 0), 0),
        file_count: members.reduce((sum, member) => sum + (member.file_count || 0), 0),
        info_hashes: members.flatMap((member) => member.info_hashes),
        source_files: members.flatMap((member) => member.source_files || []),
        torrent_files: members.flatMap((member) => member.torrent_files || []),
        is_best: members.some((member) => member.is_best),
      })
    }
  }
  return merged
}

export async function seadexBest(): Promise<Map<number, SeaDexEntry>> {
  const best = new Map<number, SeaDexEntry>()
  let page = 1
  while (true) {
    const data = await api(`${SEADEX}/collections/entries/records?page=${page}&perPage=500&expand=trs`)
    for (const item of data.items as JsonObject[]) {
      const alid = Number(item.alID)
      const torrents = item.expand?.trs || []
      if (!best.has(alid)) best.set(alid, { url: `https://seadex.moe/${alid}/`, notes: item.notes || '-', seasons: {} })
      const entry = best.get(alid)!
      // Keep filler/placeholder pages even when SeaDex has no torrents. The
      // scanner can then mark the mapped season as uncovered (with its page
      // link) instead of incorrectly claiming that it is not listed at all.
      if (!torrents.length) continue
      const torrentInfos: Array<[JsonObject, JsonObject[], Set<number>]> = []
      const entrySeasons = new Set<number>()
      for (const torrent of torrents) {
        const files = torrent.files || []
        const seasons = seasonsFromFiles(files)
        for (const season of seasons) entrySeasons.add(season)
        torrentInfos.push([torrent, files, seasons])
      }
      for (const [torrent, files, detectedSeasons] of torrentInfos) {
        const seasons = detectedSeasons.size ? detectedSeasons : (entrySeasons.size ? entrySeasons : new Set([0]))
        const quality = guessQuality(files.map((file) => file.name || '').join(' '))
        const sizes = new Map<number, number>()
        const counts = new Map<number, number>()
        for (const file of files) {
          const season = Number(String(file.name || '').match(/S(\d{1,3})E/i)?.[1] || 0)
          sizes.set(season, (sizes.get(season) || 0) + (file.length || 0))
          counts.set(season, (counts.get(season) || 0) + 1)
        }
        for (const season of seasons) {
          entry.seasons[season] ||= { candidates: [] }
          let size = sizes.get(season) || 0
          let count = counts.get(season) || 0
          if (!size && season !== 0) size = sizes.get(0) || 0
          if (!count && season !== 0) count = counts.get(0) || 0
          const seasonFiles = detectedSeasons.size > 1
            ? files.filter((file) => Number(String(file.name || '').match(/S(\d{1,3})E/i)?.[1] || 0) === season)
            : files
          const hash = String(torrent.infoHash || '')
          const release: ReleaseCandidate = {
            releaseGroup: torrent.releaseGroup,
            tracker: torrent.tracker,
            quality,
            tags: torrent.tags || [],
            dual_audio: Boolean(torrent.dualAudio),
            size,
            file_count: count,
            info_hashes: hash ? [hash] : [],
            is_best: Boolean(torrent.isBest),
            source_files: seasonFiles.map((file) => ({ name: String(file.name || ''), length: Number(file.length || 0) })),
            torrent_files: hash ? [{ hash: hash.toLowerCase(), files: files.map((file) => ({ name: String(file.name || ''), length: Number(file.length || 0) })) }] : [],
          }
          ;(entry.seasons[season].candidates as ReleaseCandidate[]).push(release)
        }
      }
    }
    if (page >= data.totalPages) break
    page += 1
  }
  for (const entry of best.values()) {
    for (const slot of Object.values(entry.seasons || {})) {
      const candidates = slot.candidates
      if (Array.isArray(candidates) && candidates.length > 1) slot.candidates = mergeComplementaryCandidates(candidates)
    }
  }
  return best
}
