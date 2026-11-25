// Minimal bencode reader for .torrent files fetched through Prowlarr. It reads only what the
// private-tracker match needs: the v1 info hash (SHA-1 of the raw info dictionary) and the file list.

import { createHash } from 'node:crypto'

export interface TorrentFileEntry {
  /** Path inside the torrent, joined with `/`, including the torrent's top-level folder for multi-file torrents. */
  name: string
  length: number
}

export interface ParsedTorrent {
  info_hash: string
  name: string
  files: TorrentFileEntry[]
  /** The torrent carries the private flag, so only its own tracker serves peers. */
  private: boolean
}

/** A .torrent file is never larger than this; private trackers cap them well below. */
export const TORRENT_FILE_MAX_BYTES = 4 * 1024 * 1024
const MAX_DEPTH = 64

type Value = number | Uint8Array | Value[] | Map<string, Value>

class Reader {
  offset = 0
  /** Byte range of the top-level `info` value, for the info hash. */
  info: [number, number] | null = null
  private readonly decoder = new TextDecoder('utf-8')

  constructor(private readonly bytes: Uint8Array) {}

  private fail(message: string): never {
    throw new Error(`Not a valid torrent file: ${message}`)
  }

  private digits(end: number): string {
    const start = this.offset
    while (this.offset < this.bytes.length && this.bytes[this.offset] !== end) this.offset++
    if (this.offset >= this.bytes.length) this.fail('unterminated number')
    const text = this.decoder.decode(this.bytes.subarray(start, this.offset))
    this.offset++
    return text
  }

  value(depth = 0, topLevel = false): Value {
    if (depth > MAX_DEPTH) this.fail('nested too deeply')
    const byte = this.bytes[this.offset]
    if (byte === undefined) this.fail('unexpected end')
    if (byte === 0x69) {
      // i<number>e
      this.offset++
      const text = this.digits(0x65)
      if (!/^-?\d+$/.test(text)) this.fail('invalid integer')
      const number = Number(text)
      if (!Number.isSafeInteger(number)) this.fail('integer out of range')
      return number
    }
    if (byte === 0x6c) {
      this.offset++
      const list: Value[] = []
      while (this.bytes[this.offset] !== 0x65) {
        if (this.offset >= this.bytes.length) this.fail('unterminated list')
        list.push(this.value(depth + 1))
      }
      this.offset++
      return list
    }
    if (byte === 0x64) {
      this.offset++
      const map = new Map<string, Value>()
      while (this.bytes[this.offset] !== 0x65) {
        if (this.offset >= this.bytes.length) this.fail('unterminated dictionary')
        const key = this.string()
        const name = this.decoder.decode(key)
        const start = this.offset
        const value = this.value(depth + 1)
        if (topLevel && name === 'info') this.info = [start, this.offset]
        map.set(name, value)
      }
      this.offset++
      return map
    }
    if (byte >= 0x30 && byte <= 0x39) return this.string()
    this.fail('unexpected token')
  }

  string(): Uint8Array {
    const text = this.digits(0x3a)
    if (!/^\d+$/.test(text)) this.fail('invalid string length')
    const length = Number(text)
    if (!Number.isSafeInteger(length) || this.offset + length > this.bytes.length) this.fail('string out of range')
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  text(value: Value | undefined): string {
    return value instanceof Uint8Array ? this.decoder.decode(value) : ''
  }
}

const lengthOf = (value: Value | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Reads a .torrent file. Throws when it is not a well-formed v1 (or hybrid) torrent. */
export function parseTorrentFile(bytes: Uint8Array): ParsedTorrent {
  if (bytes.length > TORRENT_FILE_MAX_BYTES) throw new Error('Not a valid torrent file: too large')
  const reader = new Reader(bytes)
  const root = reader.value(0, true)
  if (!(root instanceof Map) || reader.offset !== bytes.length) throw new Error('Not a valid torrent file')
  const info = root.get('info')
  if (!(info instanceof Map) || !reader.info) throw new Error('Not a valid torrent file: no info dictionary')
  const name = reader.text(info.get('name.utf-8') ?? info.get('name'))
  if (!name) throw new Error('Not a valid torrent file: no name')
  const files: TorrentFileEntry[] = []
  const list = info.get('files')
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!(entry instanceof Map)) throw new Error('Not a valid torrent file: invalid file entry')
      const parts = entry.get('path.utf-8') ?? entry.get('path')
      const length = lengthOf(entry.get('length'))
      if (!Array.isArray(parts) || !parts.length || length === null)
        throw new Error('Not a valid torrent file: invalid file entry')
      // BEP 47 padding files are not part of the payload.
      const attributes = reader.text(entry.get('attr'))
      if (attributes.includes('p')) continue
      files.push({ name: [name, ...parts.map(part => reader.text(part))].join('/'), length })
    }
  } else {
    const length = lengthOf(info.get('length'))
    if (length === null) throw new Error('Not a valid torrent file: no length (v2-only torrents are not supported)')
    files.push({ name, length })
  }
  const [start, end] = reader.info
  return {
    info_hash: createHash('sha1').update(bytes.subarray(start, end)).digest('hex'),
    name,
    files,
    private: info.get('private') === 1,
  }
}
