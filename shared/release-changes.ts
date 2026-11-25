import { isInfoHash } from './ids.js'
import type { Release, ReleaseChange, ReleaseChangeDetail, ResultItem } from './contracts.js'

export const RELEASE_CHANGE_LABELS: Record<ReleaseChange['kind'], string> = {
  best: 'New best release',
  alternative: 'New alternative',
  updated: 'Release updated',
  removed: 'Release removed',
}

export function releaseResultIdentity(result: ResultItem): string {
  return JSON.stringify([
    result.library_key || `${result.arr}:${result.group_id ?? result.anilist_id ?? result.title}`,
    result.season || 0,
  ])
}

const clean = (value: string | undefined | null) => (value || '').trim().replace(/\s+/g, ' ')
const normalized = (value: string | undefined | null) => clean(value).toLowerCase()
const values = (items: string[] = []) => [...new Set(items.map(normalized).filter(Boolean))].sort().join(', ')
const slot = (release: Release) =>
  JSON.stringify([normalized(release.part), normalized(release.releaseGroup), normalized(release.tracker)])
const name = (release: Release) =>
  `${clean(release.releaseGroup) || 'Unknown group'}${release.tracker ? ` (${clean(release.tracker)})` : ''}`

function bestReleases(result: ResultItem, part: string): Release[] {
  return (result.releases || []).filter(release => release.kind === 'best' && clean(release.part) === part)
}

function releaseReplacement(previous: Release[], next: Release[]): ReleaseChangeDetail['release_replacement'] {
  const wasBest = new Set(previous.map(release => normalized(release.releaseGroup)))
  const isBest = new Set(next.map(release => normalized(release.releaseGroup)))
  const removed = previous.filter(release => !isBest.has(normalized(release.releaseGroup)))
  const added = next.filter(release => !wasBest.has(normalized(release.releaseGroup)))
  if (removed.length !== 1 || added.length !== 1) return undefined
  const [old] = removed,
    [current] = added
  const hashes = (release: Release) => values(release.info_hashes?.filter(isInfoHash))
  const oldHashes = hashes(old),
    newHashes = hashes(current)
  return {
    previous: name(old),
    next: name(current),
    torrent_changed: Boolean(oldHashes && newHashes && oldHashes !== newHashes),
  }
}

function notesByPart(result: ResultItem): Map<string, string | null> {
  const noteText = (note: string | null | undefined) => (note?.trim() && note.trim() !== '-' ? note : null)
  const notes = new Map(
    Object.entries(result.notes_by_part || {}).map(([part, note]) => [clean(part), noteText(note)] as const),
  )
  if (!notes.size) notes.set('', noteText(result.notes))
  return notes
}

/** Compare catalog facts only: ownership, selected files, and download state are local. */
export function describeReleaseChanges(previous: ResultItem, current: ResultItem): ReleaseChangeDetail[] {
  const changes: ReleaseChangeDetail[] = []
  const before = new Map((previous.releases || []).map(release => [slot(release), release]))
  const after = new Map((current.releases || []).map(release => [slot(release), release]))
  const changedBestParts = new Set<string>()
  const parts = new Set([...(previous.releases || []), ...(current.releases || [])].map(release => clean(release.part)))
  for (const part of parts) {
    const oldReleases = bestReleases(previous, part),
      newReleases = bestReleases(current, part)
    const groups = (releases: Release[]) => [...new Set(releases.map(release => clean(release.releaseGroup)))].sort()
    const oldBest = groups(oldReleases),
      newBest = groups(newReleases)
    if (values(oldBest) === values(newBest)) continue
    changedBestParts.add(part)
    const replacement = releaseReplacement(oldReleases, newReleases)
    changes.push({
      kind: newBest.length ? 'best' : 'removed',
      part,
      ...(replacement ? { release_replacement: replacement } : {}),
      description: !newBest.length
        ? `Best release removed: ${oldBest.join(', ')}`
        : oldBest.length
          ? `Best release changed: ${oldBest.join(', ')} → ${newBest.join(', ')}`
          : `New best release: ${newBest.join(', ')}`,
    })
  }
  for (const [key, release] of after) {
    const old = before.get(key),
      part = clean(release.part)
    if (!old) {
      if (release.kind !== 'best' || !changedBestParts.has(part))
        changes.push({
          kind: release.kind === 'best' ? 'best' : 'alternative',
          part,
          description: `New ${release.kind === 'best' ? 'best release' : 'alternative'}: ${name(release)}${release.quality ? ` · ${clean(release.quality)}` : ''}`,
        })
      continue
    }
    if (old.kind === 'best' && release.kind === 'alt')
      changes.push({ kind: 'alternative', part, description: `Now an alternative: ${name(release)}` })
    const edits: string[] = []
    if (normalized(old.quality) !== normalized(release.quality))
      edits.push(`Quality: ${clean(old.quality) || 'Unknown'} → ${clean(release.quality) || 'Unknown'}`)
    if (values(old.info_hashes) !== values(release.info_hashes)) edits.push('Torrent changed')
    if (values(old.tags) !== values(release.tags))
      edits.push(`Tags: ${values(old.tags) || 'None'} → ${values(release.tags) || 'None'}`)
    if (Boolean(old.dual_audio) !== Boolean(release.dual_audio))
      edits.push(`Dual audio: ${release.dual_audio ? 'Yes' : 'No'}`)
    if (old.size !== release.size) edits.push('Release size changed')
    if (edits.length) changes.push({ kind: 'updated', part, description: `${name(release)} · ${edits.join('; ')}` })
  }
  for (const [key, release] of before)
    if (!after.has(key) && !(release.kind === 'best' && changedBestParts.has(clean(release.part)))) {
      changes.push({
        kind: 'removed',
        part: clean(release.part),
        description: `${release.kind === 'best' ? 'Best release' : 'Alternative'} removed: ${name(release)}`,
      })
    }
  const oldNotes = notesByPart(previous),
    newNotes = notesByPart(current)
  for (const part of new Set([...oldNotes.keys(), ...newNotes.keys()])) {
    const oldNote = oldNotes.get(part) ?? null,
      newNote = newNotes.get(part) ?? null
    if (oldNote?.trim().replace(/\r\n/g, '\n') === newNote?.trim().replace(/\r\n/g, '\n')) continue
    changes.push({
      kind: 'updated',
      description: 'SeaDex recommendation notes updated',
      ...(part ? { part } : {}),
      note_change: { previous: oldNote, next: newNote },
    })
  }
  const unavailable = (result: ResultItem) => new Set((result.unavailable_parts || []).map(part => part.label))
  const oldUnavailable = unavailable(previous),
    newUnavailable = unavailable(current)
  for (const part of oldUnavailable)
    if (!newUnavailable.has(part)) changes.push({ kind: 'updated', part, description: `${part} now covered` })
  for (const part of newUnavailable)
    if (!oldUnavailable.has(part))
      changes.push({ kind: 'removed', part, description: `${part} no longer available on SeaDex` })
  return changes
}
