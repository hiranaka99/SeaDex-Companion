import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { LOG_DIR, LOG_FILE } from './paths.js'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function rotateLog(): void {
  try {
    if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size < 5 * 1024 * 1024) return
    for (let index = 3; index >= 1; index -= 1) {
      const source = index === 1 ? LOG_FILE : `${LOG_FILE}.${index - 1}`
      const target = `${LOG_FILE}.${index}`
      if (existsSync(source)) renameSync(source, target)
    }
  } catch {
    // Logging must never stop the application.
  }
}

export function log(level: 'INFO' | 'WARNING' | 'ERROR', message: string): void {
  const line = `${timestamp()} [${level}] ${message}`
  rotateLog()
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_FILE, `${line}\n`, 'utf8') } catch { /* stdout is still available */ }
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARNING') console.warn(line)
  else console.log(line)
}

/**
 * Reads only the tail of the log file (bounded by `limit` bytes) instead of the
 * whole file on every poll. Because the window is anchored to the end of the
 * current file, log rotation (which swaps in a fresh, smaller file) and external
 * truncation are handled automatically without any offset/inode bookkeeping.
 * A partial line at the head of the window is dropped so callers only ever see
 * complete lines.
 */
export function readLogTail(limit = 256 * 1024): string[] {
  try {
    if (!existsSync(LOG_FILE)) return []
    const size = statSync(LOG_FILE).size
    if (!size) return []
    const fd = openSync(LOG_FILE, 'r')
    try {
      const length = Math.min(limit, size)
      const buffer = Buffer.alloc(length)
      const offset = size - length
      const read = readSync(fd, buffer, 0, length, offset)
      const text = buffer.subarray(0, read).toString('utf8')
      if (!text) return []
      const lines = text.split('\n')
      // A partial line can only appear at the head (we always stop at EOF).
      if (offset > 0) {
        const previous = Buffer.alloc(1)
        if (readSync(fd, previous, 0, 1, offset - 1) !== 1 || previous[0] !== 10) lines.shift()
      }
      if (lines.at(-1) === '') lines.pop()
      return lines
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}
