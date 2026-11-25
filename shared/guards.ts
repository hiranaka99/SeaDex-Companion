/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as a plain object, or an empty one when it is anything else. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
