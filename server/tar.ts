import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * A deliberately small ustar reader and writer for app update bundles. It handles
 * regular files only: links, devices, and extended headers are refused, and every
 * path must stay inside the extraction directory.
 */
export interface TarEntry {
  path: string
  data: Buffer
}

const BLOCK = 512
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 20_000

export function isSafeArchivePath(path: string): boolean {
  if (!path || path.length > 255 || path.includes('\\') || path.includes('\0')) return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function writeString(header: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`Archive field too long: ${value}`)
  bytes.copy(header, offset)
}

const writeOctal = (header: Buffer, value: number, offset: number, length: number) =>
  writeString(header, value.toString(8).padStart(length - 1, '0') + '\0', offset, length)

function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`Archive path too long: ${path}`)
}

export function packTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) throw new Error(`Unsafe archive path: ${entry.path}`)
    const header = Buffer.alloc(BLOCK)
    const { name, prefix } = splitPath(entry.path)
    writeString(header, name, 0, 100)
    writeOctal(header, 0o644, 100, 8)
    writeOctal(header, 0, 108, 8)
    writeOctal(header, 0, 116, 8)
    writeOctal(header, entry.data.length, 124, 12)
    // A fixed timestamp keeps bundles reproducible from the same build output.
    writeOctal(header, 0, 136, 12)
    header.fill(' ', 148, 156)
    header[156] = '0'.charCodeAt(0)
    writeString(header, 'ustar\0', 257, 6)
    writeString(header, '00', 263, 2)
    writeString(header, prefix, 345, 155)
    let sum = 0
    for (const byte of header) sum += byte
    writeString(header, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, entry.data)
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

const readString = (block: Buffer, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('utf8')
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error('Corrupt archive header')
  return text ? Number.parseInt(text, 8) : 0
}

export function unpackTarGz(archive: Buffer): TarEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES })
  const entries: TarEntry[] = []
  const seen = new Set<string>()
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) return entries
    let sum = 0
    for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : header[index]
    if (sum !== readOctal(header, 148, 8)) throw new Error('Corrupt archive header checksum')
    const prefix = readString(header, 345, 155)
    const name = readString(header, 0, 100)
    const path = (prefix ? `${prefix}/${name}` : name).replace(/\/+$/, '')
    const type = String.fromCharCode(header[156] || 48)
    const size = readOctal(header, 124, 12)
    offset += BLOCK
    if (type === '5') continue
    if (type !== '0') throw new Error(`Unsupported archive entry type "${type}" for ${path}`)
    if (!isSafeArchivePath(path)) throw new Error(`Unsafe archive path: ${path}`)
    if (seen.has(path)) throw new Error(`Duplicate archive path: ${path}`)
    if (offset + size > tar.length) throw new Error('Archive is truncated')
    seen.add(path)
    entries.push({ path, data: Buffer.from(tar.subarray(offset, offset + size)) })
    if (entries.length > MAX_ENTRIES) throw new Error('Archive has too many entries')
    offset += Math.ceil(size / BLOCK) * BLOCK
  }
  throw new Error('Archive is truncated')
}
