// Search terms and candidate ranking of the Prowlarr file-list search. Everything here is pure. A source's
// own file names decide which titles are searched first and which results could be the release; a result's
// title and size only choose candidates, and the NZB of a candidate decides (`gradeNzb`).

import { createHash } from 'node:crypto'
import { VIDEO_FILE } from '../shared/releases.js'
import { cleanSearchTitle } from './search-titles.js'
import type { SourceFile } from './source-files.js'

/** One query of the ladder. Sizes are bytes and bound the size the indexer reports. */
export interface SearchQuery {
  q: string
  minSize?: number
  maxSize?: number
}

/** What a source's search is built from. `titles` is every title it may be posted under, in any order. */
export interface SearchTerms {
  titles: readonly string[]
  releaseGroup: string
}

/** What a search result says about itself. The file and grab counts are the indexer's own figures. */
export interface Listing {
  title: string
  size: number | null
  files?: number
  grabs?: number
}

/** What a source's listings are compared with. */
export interface SourceFacts {
  /** The release group as SeaDex names it. */
  group: string
  /** Tokens every main video file name carries: the title, the group and the release tags. */
  common: string[]
  /** Listed size of every file, in bytes. */
  total: number
  fileCount: number
}

/** Queries one indexer gets for one source, at most. */
export const QUERY_LIMIT = 4
/** Candidates kept per source. */
export const CANDIDATE_LIMIT = 20
/** Indexers report the posted size, which adds yEnc and PAR2 overhead to the listed files. */
export const PLAUSIBLE_SIZE = [0.97, 1.35] as const
/** A size this close is what a complete post of the listed files looks like. */
export const STRONG_SIZE = [1.0, 1.25] as const
/** The usual posted size of a release, as a multiple of its listed size. */
export const IDEAL_SIZE = 1.08
/** Share of the common tokens a title has to carry when it does not name the group. */
export const MIN_COVERAGE = 0.6

/** Marks `cleanSearchTitle` deletes inside a word, so "Hero's" is one word in a title and in a file name. */
const WORD_MARKS = /['`´‘’]/g
/** A folder with one of these words in its name holds extras and not the release's main files. */
const EXTRAS_FOLDER = /^(?:extras?|specials?|sps?|ncs?|ncop|nced|bonus|menus?|samples?|scans?|cds?\d*|ost)$/

/**
 * The words of a name: lower case, without diacritics, split at every character that is neither a letter
 * nor a digit. `&` reads "and" and apostrophes vanish, as in `cleanSearchTitle`, so a cleaned title and the
 * file names it came from give the same words.
 */
export function searchTokens(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(WORD_MARKS, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * The tokens every video file name of a source carries, without those of files in folders named like extras
 * ("Extras", "NC", "Specials"). Episode numbers and checksums differ from file to file and drop out; the
 * title, the group and the release tags stay. Empty when the source lists no video file.
 */
export function commonTokens(files: readonly SourceFile[]): string[] {
  const videos = files
    .map(file => file.name.replace(/\\/g, '/').split('/'))
    .filter(path => VIDEO_FILE.test(path.at(-1)!))
  const extras = (folder: string) => searchTokens(folder).some(token => EXTRAS_FOLDER.test(token))
  const main = videos.filter(path => !path.slice(0, -1).some(extras))
  // A release that sits in such a folder as a whole is searched by all its files.
  const names = (main.length ? main : videos).map(path => searchTokens(path.at(-1)!.replace(VIDEO_FILE, '')))
  if (!names.length) return []
  const others = names.slice(1).map(tokens => new Set(tokens))
  return [...new Set(names[0])].filter(token => others.every(tokens => tokens.has(token)))
}

/**
 * Every title, cleaned and listed once, with the titles the file names spell out first: a title fits when
 * all its words are common tokens. Within each half the given order stays.
 */
export function orderTitles(titles: readonly string[], common: readonly string[]): string[] {
  const known = new Set(common)
  const seen = new Set<string>()
  const fitting: string[] = []
  const others: string[] = []
  for (const title of titles) {
    const clean = cleanSearchTitle(title)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    const tokens = searchTokens(clean)
    if (tokens.length && tokens.every(token => known.has(token))) fitting.push(clean)
    else others.push(clean)
  }
  return [...fitting, ...others]
}

const totalBytes = (files: readonly SourceFile[]): number => files.reduce((sum, file) => sum + file.length, 0)

/** What the listings of a source are judged and ranked against. */
export function sourceFacts(files: readonly SourceFile[], releaseGroup: string): SourceFacts {
  return { group: releaseGroup, common: commonTokens(files), total: totalBytes(files), fileCount: files.length }
}

/**
 * The queries of one source, in the order they are sent; the search stops after the first that finds a
 * strong candidate. No query names a category, because Prowlarr drops every result outside it.
 *
 * - A: the group and the first title. First when the file names carry the group.
 * - B: the first title alone, within the size a post of the listed files can have. First when the file
 *   names do not carry the group, because such a post is never found by the group.
 * - C: the group and the second title, then the third.
 *
 * Without a group every query is a title within the size window, and without a title the group is.
 */
export function queryLadder(files: readonly SourceFile[], terms: SearchTerms): SearchQuery[] {
  const facts = sourceFacts(files, terms.releaseGroup)
  const titles = orderTitles(terms.titles, facts.common)
  const group = cleanSearchTitle(terms.releaseGroup)
  const sized = (q: string): SearchQuery =>
    facts.total > 0 ? { q, minSize: facts.total * PLAUSIBLE_SIZE[0], maxSize: facts.total * PLAUSIBLE_SIZE[1] } : { q }
  let queries: SearchQuery[]
  if (!titles.length) queries = group ? [sized(group)] : []
  else if (!group) queries = titles.slice(0, QUERY_LIMIT - 1).map(sized)
  else {
    const byGroup = { q: `${group} ${titles[0]}` }
    const byTitle = sized(titles[0])
    const groupTokens = searchTokens(terms.releaseGroup)
    const carried = groupTokens.length > 0 && groupTokens.every(token => facts.common.includes(token))
    queries = [
      ...(carried ? [byGroup, byTitle] : [byTitle, byGroup]),
      ...titles.slice(1, QUERY_LIMIT - 1).map(title => ({ q: `${group} ${title}` })),
    ]
  }
  const seen = new Set<string>()
  return queries.filter(query => {
    const key = query.q.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Whether a title names the release group as whole words: the group's tokens in a row, or the group
 * without its punctuation as one token or as up to three adjacent tokens joined. `-ZR-` is in `[ZR] Show`
 * and in `Show.Remux-ZR`; `ZR` is not in "Dragon Ball Z Remastered" and `sam` is not in "Samurai".
 */
export function groupMatches(group: string, title: string): boolean {
  const wanted = searchTokens(group)
  if (!wanted.length) return false
  const joined = wanted.join('')
  const tokens = searchTokens(title)
  for (let start = 0; start < tokens.length; start++) {
    if (wanted.every((token, offset) => tokens[start + offset] === token)) return true
    let run = ''
    for (const token of tokens.slice(start, start + 3)) {
      run += token
      if (run === joined) return true
    }
  }
  return false
}

/** Share of the source's common tokens found among the words of a title; 0 when the source has none. */
export function nameCoverage(common: readonly string[], title: string): number {
  if (!common.length) return 0
  const tokens = new Set(searchTokens(title))
  return common.filter(token => tokens.has(token)).length / common.length
}

/** Reported size over listed size; null when either is unknown. */
function sizeRatio(listing: Listing, facts: SourceFacts): number | null {
  return listing.size !== null && facts.total > 0 ? listing.size / facts.total : null
}

const within = (value: number, [low, high]: readonly [number, number]): boolean => value >= low && value <= high

/**
 * Whether a result could be the release: its size is unknown or one a post of the listed files can have,
 * and its title names the group or most of what the file names have in common.
 */
export function isPlausible(listing: Listing, facts: SourceFacts): boolean {
  const ratio = sizeRatio(listing, facts)
  if (ratio !== null && !within(ratio, PLAUSIBLE_SIZE)) return false
  return groupMatches(facts.group, listing.title) || nameCoverage(facts.common, listing.title) >= MIN_COVERAGE
}

/** A plausible result whose known size is that of a complete post. Finding one ends the search. */
export function isStrong(listing: Listing, facts: SourceFacts): boolean {
  const ratio = sizeRatio(listing, facts)
  return ratio !== null && within(ratio, STRONG_SIZE) && isPlausible(listing, facts)
}

/**
 * The listings, most likely first: those naming the group, then by name coverage, then by how close the
 * size is to the usual one. A file count that can hold every listed file and a post that was grabbed
 * before break ties. The file count never rules a listing out, because packed posts report unrelated counts.
 */
export function rankCandidates<T extends Listing>(listings: readonly T[], facts: SourceFacts): T[] {
  const ranked = listings.map(listing => {
    const ratio = sizeRatio(listing, facts)
    return {
      listing,
      group: Number(groupMatches(facts.group, listing.title)),
      coverage: nameCoverage(facts.common, listing.title),
      distance: ratio === null ? Number.POSITIVE_INFINITY : Math.abs(ratio - IDEAL_SIZE),
      files: Number(listing.files !== undefined && listing.files >= facts.fileCount),
      grabbed: Number((listing.grabs ?? 0) > 0),
    }
  })
  ranked.sort(
    (left, right) =>
      right.group - left.group ||
      right.coverage - left.coverage ||
      (left.distance === right.distance ? 0 : left.distance - right.distance) ||
      right.files - left.files ||
      right.grabbed - left.grabbed,
  )
  return ranked.map(entry => entry.listing)
}

/** The opaque ID a candidate is chosen by: the indexer ID and 20 hex characters of the SHA-1 of the result GUID. */
export function candidateEntryId(indexerId: number, guid: string): string {
  return `${indexerId}-${createHash('sha1').update(guid).digest('hex').slice(0, 20)}`
}
