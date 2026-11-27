import assert from 'node:assert/strict'
import { assessSeason as assess } from '../../server/assessment.js'
import { listingViolations } from './listing-invariants.js'

/** `assessSeason` for tests: every result it returns must keep the listing rules of `listingViolations`. */
export function assessSeason(...args: Parameters<typeof assess>): ReturnType<typeof assess> {
  const result = assess(...args)
  assert.deepEqual(listingViolations(result), [], `${result.title} season ${result.season} breaks a listing rule`)
  return result
}
