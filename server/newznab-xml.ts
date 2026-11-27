// Newznab and NZB XML, read only through the parser: well-formedness, declarations, error documents, NZB
// validation and the field readers each client reads its items with.

import { isRecord } from '../shared/guards.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { LOOKUP_MAX_BYTES, decodeText } from './provider-http.js'

/** Provider XML rejects declarations; NZBs allow only the public standard DTD. */
const DECLARATION_PATTERN = /<!DOCTYPE|<!ENTITY/i
const STANDARD_NZB_DOCTYPE =
  /<!DOCTYPE\s+nzb\s+PUBLIC\s+(["'])-\/\/newzBin\/\/DTD NZB 1\.1\/\/EN\1\s+(["'])https?:\/\/www\.newzbin\.com\/DTD\/nzb\/nzb-1\.1\.dtd\2\s*>/
/** Newznab XML is only ever inspected through the parser, never with regexes. */
const XML_PARSER_OPTIONS = { ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }
const xmlParser = new XMLParser(XML_PARSER_OPTIONS)

/** Body was not XML the provider could have meant (malformed, empty, DTD). */
export class ProviderProtocolError extends Error {}

export interface NewznabError {
  code: number
}

export function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

/** Trimmed non-empty provider string, or undefined when the field is absent/blank. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Provider-reported byte count only when it is a safe non-negative integer. */
export function safeByteSize(value: unknown): number | undefined {
  const size = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

/** Element body, also when attributes pushed the value under `#text`. */
export function elementText(value: unknown): string | undefined {
  return isRecord(value) ? text(value['#text']) : text(value)
}

/**
 * Every value of each `newznab:attr` of a feed item, by lower-case name and in document order. An item
 * repeats an attribute to list several values, as it does for `category`.
 */
export function newznabAttributeValues(item: Record<string, unknown>): Map<string, string[]> {
  const attributes = new Map<string, string[]>()
  for (const raw of listOf(item['newznab:attr'])) {
    if (!isRecord(raw)) continue
    const name = text(raw['@_name'])?.toLowerCase()
    const value = text(raw['@_value'])
    if (!name || value === undefined) continue
    const values = attributes.get(name)
    if (values) values.push(value)
    else attributes.set(name, [value])
  }
  return attributes
}

/** The first value of each `newznab:attr` of a feed item, by lower-case name. */
export function newznabAttributes(item: Record<string, unknown>): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const [name, values] of newznabAttributeValues(item)) attributes.set(name, values[0])
  return attributes
}

/**
 * `XMLParser` repairs unclosed and mismatched elements, so malformed markup is
 * checked with the same dependency's validator before it is trusted.
 */
function assertWellFormedXml(value: string): void {
  if (XMLValidator.validate(value) !== true) throw new ProviderProtocolError('provider response was not valid XML')
}

export function parseProviderXml(text: string): unknown {
  if (!text.trim()) throw new ProviderProtocolError('provider response was empty')
  if (DECLARATION_PATTERN.test(text)) throw new ProviderProtocolError('provider response declared a DTD or entity')
  assertWellFormedXml(text)
  try {
    return xmlParser.parse(text)
  } catch {
    throw new ProviderProtocolError('provider response was not valid XML')
  }
}

function newznabErrorFrom(value: unknown): NewznabError | null {
  if (!isRecord(value)) return null
  const code = Number(value['@_code'])
  if (!Number.isSafeInteger(code) || code <= 0) return null
  return { code }
}

function scanForError(node: unknown, depth: number): NewznabError | null {
  if (depth > 8) return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = scanForError(entry, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isRecord(node)) return null
  const direct = newznabErrorFrom(node.error)
  if (direct) return direct
  for (const key of Object.keys(node)) {
    if (key === 'error') continue
    const found = scanForError(node[key], depth + 1)
    if (found) return found
  }
  return null
}

/** Newznab sends `<error code description="...">` with HTTP 200; it is never "no match". */
export function findNewznabError(document: unknown): NewznabError | null {
  return scanForError(document, 0)
}

/** Cheap guard for NZB bodies that are really a Newznab error document. */
export function detectXmlError(bytes: Uint8Array): NewznabError | null {
  if (bytes.length === 0 || bytes.length > LOOKUP_MAX_BYTES || bytes[0] !== 0x3c) return null
  let document: unknown
  try {
    document = parseProviderXml(decodeText(bytes))
  } catch {
    return null
  }
  return findNewznabError(document)
}

/** Accept the standard public DTD without passing it to the XML parser. */
export function validateNzbBytes(bytes: Uint8Array): void {
  const value = decodeText(bytes)
  if (!value.trim()) throw new Error('NZB response was empty')
  const declaration = value.match(STANDARD_NZB_DOCTYPE)
  if (declaration && !/^(?:\s|<\?xml\s[^?]*\?>|<!--[\s\S]*?-->)*$/.test(value.slice(0, declaration.index))) {
    throw new Error('NZB response was not valid XML')
  }
  const xml = value.replace(STANDARD_NZB_DOCTYPE, '')
  if (DECLARATION_PATTERN.test(xml)) throw new Error('NZB response declared an unsupported DTD or entity')
  assertWellFormedXml(xml)
  let document: unknown
  try {
    document = xmlParser.parse(xml)
  } catch {
    throw new Error('NZB response was not valid XML')
  }
  const roots = isRecord(document) ? Object.keys(document).filter(key => !key.startsWith('?')) : []
  const nzb = isRecord(document) ? document.nzb : undefined
  if (roots.length !== 1 || roots[0] !== 'nzb' || !isRecord(nzb))
    throw new Error('NZB response had the wrong root element')
  const files = listOf(nzb.file)
  if (!files.length) throw new Error('NZB response contained no segments')
  for (const file of files) {
    const container = isRecord(file) && isRecord(file.segments) ? file.segments : undefined
    const segments = listOf(container?.segment)
    if (!segments.length) throw new Error('NZB response contained no segments')
    for (const segment of segments) {
      if (
        !isRecord(segment) ||
        !text(segment['#text']) ||
        safeByteSize(segment['@_bytes']) === undefined ||
        !Number.isSafeInteger(Number(segment['@_number'])) ||
        Number(segment['@_number']) <= 0
      ) {
        throw new Error('NZB response contained an invalid segment')
      }
    }
  }
}
