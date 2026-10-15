import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log, errorMessage } from './logging.js'

export function readJson<T>(file: string, fallback: T, warning?: string): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    if (warning) log('WARNING', `${warning} (${errorMessage(error)}), using defaults`)
    return fallback
  }
}

export function loadStringSet(file: string, warning: string, normalize: (value: unknown) => string | null = (value) => typeof value === 'string' && value ? value : null): Set<string> {
  const stored = readJson<unknown>(file, [], warning)
  if (!Array.isArray(stored)) {
    log('WARNING', `${warning} (expected a JSON array), using defaults`)
    return new Set()
  }
  return new Set(stored.map(normalize).filter((value): value is string => value !== null))
}

export function writeJsonAtomic(file: string, value: unknown, pretty = false, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, pretty ? 2 : undefined), { encoding: 'utf8', mode })
  if (mode !== undefined) chmodSync(temporary, mode)
  renameSync(temporary, file)
}
