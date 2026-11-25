// File-list identity and comparison for private-tracker releases. SeaDex lists their files with exact
// sizes even though it withholds the info hash; that list is what a copy found elsewhere is checked against.

import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { VIDEO_FILE } from '../shared/releases.js'
import { normalizeTorrentPath } from '../shared/download-plan.js'
import { isRecord } from '../shared/guards.js'
import { listOf, safeByteSize, validateNzbBytes } from './usenet-provider-types.js'

export interface SourceFile {
  name: string
  length: number
}

const baseName = (name: string): string => normalizeTorrentPath(name).split('/').pop() || ''
const fileKey = (name: string, length: number): string => `${baseName(name)}\u0000${length}`

/** `files:<sha1>` of a file list; independent of order and of the folder the files sit in. */
export function filesSourceId(files: SourceFile[]): string {
  const lines = files.map(file => fileKey(file.name, file.length)).sort()
  return `files:${createHash('sha1').update(lines.join('\n')).digest('hex')}`
}

function counts(keys: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const key of keys) map.set(key, (map.get(key) || 0) + 1)
  return map
}

/** Whether a torrent holds exactly the listed files: every name and size, nothing more and nothing less. */
export function sameFiles(actual: SourceFile[], expected: SourceFile[]): boolean {
  if (!expected.length || actual.length !== expected.length) return false
  const wanted = counts(expected.map(file => fileKey(file.name, file.length)))
  for (const [key, count] of counts(actual.map(file => fileKey(file.name, file.length))))
    if (wanted.get(key) !== count) return false
  return true
}

export interface NzbFile {
  name: string
  /** Decoded size from the subject line; null when the poster did not include it. */
  size: number | null
}

const nzbParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false })

/**
 * Posting tools such as Nyuu and ngPost write subjects like
 * `[3/24] - "Show - 01.mkv" yEnc (1/812) 1234567890`; the trailing number is the decoded file size.
 */
const QUOTED_SUBJECT = /"([^"]+)"\s*yEnc\s*\(\d+\/\d+\)\s*(\d+)?\s*$/i
const BARE_SUBJECT = /^(?:\[\d+\/\d+\]\s*-?\s*)?(.+?)\s+yEnc\s*\(\d+\/\d+\)\s*(\d+)?\s*$/i

/** Numeric character references the XML parser leaves in attribute values, such as `&#039;` in subjects. */
function decodeCharacterReferences(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (reference, code: string) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : reference
  })
}

/** File names and sizes an NZB discloses in its subjects. Obfuscated posts disclose nothing usable. */
export function nzbFiles(bytes: Uint8Array): NzbFile[] {
  validateNzbBytes(bytes)
  const xml = new TextDecoder('utf-8').decode(bytes).replace(/<!DOCTYPE[^>]*>/i, '')
  const document = nzbParser.parse(xml)
  const nzb = isRecord(document) && isRecord(document.nzb) ? document.nzb : undefined
  const files: NzbFile[] = []
  for (const file of listOf(nzb?.file)) {
    if (!isRecord(file) || typeof file['@_subject'] !== 'string') continue
    const subject = file['@_subject'].trim()
    const match = subject.match(QUOTED_SUBJECT) || subject.match(BARE_SUBJECT)
    if (!match) continue
    const size = match[2] === undefined ? null : (safeByteSize(match[2]) ?? null)
    files.push({ name: decodeCharacterReferences(match[1].trim()), size })
  }
  return files
}

/**
 * Whether an NZB carries every video file of the release, byte for byte by its subject sizes. Extra files
 * such as PAR2 sets are allowed; a renamed, repacked or size-less post never matches.
 */
export function nzbHasFiles(files: NzbFile[], expected: SourceFile[]): boolean {
  const videos = expected.filter(file => VIDEO_FILE.test(file.name))
  if (!videos.length) return false
  const available = counts(files.filter(file => file.size !== null).map(file => fileKey(file.name, file.size!)))
  for (const [key, count] of counts(videos.map(file => fileKey(file.name, file.length))))
    if ((available.get(key) || 0) < count) return false
  return true
}

/** How close an unproven NZB came: video files present with name and exact size, and whether it states sizes. */
export function nzbFileMatches(
  files: NzbFile[],
  expected: SourceFile[],
): { files_matched: number; names_matched: number; files_expected: number; sizes_known: boolean } {
  const videos = expected.filter(file => VIDEO_FILE.test(file.name))
  const available = counts(files.filter(file => file.size !== null).map(file => fileKey(file.name, file.size!)))
  let matched = 0
  for (const file of videos) {
    const key = fileKey(file.name, file.length)
    const left = available.get(key) || 0
    if (left > 0) {
      matched++
      available.set(key, left - 1)
    }
  }
  const names = counts(files.map(file => baseName(file.name)))
  let named = 0
  for (const file of videos) {
    const left = names.get(baseName(file.name)) || 0
    if (left > 0) {
      named++
      names.set(baseName(file.name), left - 1)
    }
  }
  return {
    files_matched: matched,
    names_matched: named,
    files_expected: videos.length,
    sizes_known: files.some(file => file.size !== null),
  }
}
