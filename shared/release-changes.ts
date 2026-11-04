import type { Release, ReleaseChange, ResultItem } from './contracts.js'

export type ReleaseChangeDescription = Omit<ReleaseChange, 'id' | 'detected_at'>
export const RELEASE_CHANGE_LABELS: Record<ReleaseChange['kind'], string> = {
  best: 'New best release', alternative: 'New alternative', updated: 'Release updated', removed: 'Release removed',
}

export function releaseResultIdentity(result: ResultItem): string {
  return JSON.stringify([result.library_key || `${result.arr}:${result.group_id ?? result.anilist_id ?? result.title}`, result.season || 0])
}

const clean = (value: string | undefined | null) => (value || '').trim().replace(/\s+/g, ' ')
const normalized = (value: string | undefined | null) => clean(value).toLowerCase()
const values = (items: string[] = []) => [...new Set(items.map(normalized).filter(Boolean))].sort().join(', ')
const slot = (release: Release) => JSON.stringify([normalized(release.part), normalized(release.releaseGroup), normalized(release.tracker)])
const name = (release: Release) => `${clean(release.releaseGroup) || 'Unknown group'}${release.tracker ? ` (${clean(release.tracker)})` : ''}`

/** Compare catalog facts only: ownership, selected files, and download state are local. */
export function describeReleaseChanges(previous: ResultItem, current: ResultItem): ReleaseChangeDescription[] {
  const changes: ReleaseChangeDescription[] = []
  const before = new Map((previous.releases || []).map(release => [slot(release), release]))
  const after = new Map((current.releases || []).map(release => [slot(release), release]))
  const changedBestParts = new Set<string>()
  const parts = new Set([...(previous.releases || []), ...(current.releases || [])].map(release => clean(release.part)))
  for (const part of parts) {
    const best = (result: ResultItem) => [...new Set((result.releases || []).filter(release => release.kind === 'best' && clean(release.part) === part).map(release => clean(release.releaseGroup)))].sort()
    const oldBest = best(previous), newBest = best(current)
    if (values(oldBest) === values(newBest)) continue
    changedBestParts.add(part)
    changes.push({ kind: newBest.length ? 'best' : 'removed', part,
      description: !newBest.length ? `Best release removed: ${oldBest.join(', ')}` : oldBest.length
        ? `Best release changed: ${oldBest.join(', ')} → ${newBest.join(', ')}` : `New best release: ${newBest.join(', ')}` })
  }
  for (const [key, release] of after) {
    const old = before.get(key), part = clean(release.part)
    if (!old) {
      if (release.kind !== 'best' || !changedBestParts.has(part)) changes.push({ kind: release.kind === 'best' ? 'best' : 'alternative', part,
        description: `New ${release.kind === 'best' ? 'best release' : 'alternative'}: ${name(release)}${release.quality ? ` · ${clean(release.quality)}` : ''}` })
      continue
    }
    if (old.kind === 'best' && release.kind === 'alt') changes.push({ kind: 'alternative', part, description: `Now an alternative: ${name(release)}` })
    const edits: string[] = []
    if (normalized(old.quality) !== normalized(release.quality)) edits.push(`Quality: ${clean(old.quality) || 'Unknown'} → ${clean(release.quality) || 'Unknown'}`)
    if (values(old.info_hashes) !== values(release.info_hashes)) edits.push('Torrent changed')
    if (values(old.tags) !== values(release.tags)) edits.push(`Tags: ${values(old.tags) || 'None'} → ${values(release.tags) || 'None'}`)
    if (Boolean(old.dual_audio) !== Boolean(release.dual_audio)) edits.push(`Dual audio: ${release.dual_audio ? 'Yes' : 'No'}`)
    if (old.size !== release.size) edits.push('Release size changed')
    if (edits.length) changes.push({ kind: 'updated', part, description: `${name(release)} · ${edits.join('; ')}` })
  }
  for (const [key, release] of before) if (!after.has(key) && !(release.kind === 'best' && changedBestParts.has(clean(release.part)))) {
    changes.push({ kind: 'removed', part: clean(release.part), description: `${release.kind === 'best' ? 'Best release' : 'Alternative'} removed: ${name(release)}` })
  }
  const notes = (result: ResultItem) => JSON.stringify([clean(result.notes), Object.entries(result.notes_by_part || {}).map(([part, note]) => [clean(part), clean(note)]).sort()])
  if (notes(previous) !== notes(current)) changes.push({ kind: 'updated', description: 'SeaDex recommendation notes updated' })
  const unavailable = (result: ResultItem) => new Set((result.unavailable_parts || []).map(part => part.label))
  const oldUnavailable = unavailable(previous), newUnavailable = unavailable(current)
  for (const part of oldUnavailable) if (!newUnavailable.has(part)) changes.push({ kind: 'updated', part, description: `${part} now covered` })
  for (const part of newUnavailable) if (!oldUnavailable.has(part)) changes.push({ kind: 'removed', part, description: `${part} no longer available on SeaDex` })
  return changes
}
