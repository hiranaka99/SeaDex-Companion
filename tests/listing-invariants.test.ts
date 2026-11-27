import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Release } from '../shared/contracts.js'
import { listingViolations } from './support/listing-invariants.js'
import { resultItem } from './support/results.js'

const HASH = 'a'.repeat(40)
const episode = (number: number) => `[sam] Show - ${String(number).padStart(2, '0')} [BD 1080p].mkv`
const batch = Array.from({ length: 4 }, (_, index) => ({ name: episode(index + 1), length: 1000 + index }))

function release(part: string, fields: Partial<Release>): Release {
  return {
    kind: 'best',
    part,
    releaseGroup: 'sam',
    tracker: 'Nyaa',
    quality: '1080p',
    tags: [],
    size: 0,
    info_hashes: [HASH],
    torrent_available: true,
    torrent_files: [{ hash: HASH, files: batch }],
    ...fields,
  }
}

const cour = (part: string, numbers: number[]) =>
  release(part, { selected_files: numbers.map(number => episode(number)) })
const privateCopy = (part: string, numbers: number[]) =>
  release(part, {
    tracker: 'AB',
    info_hashes: [],
    torrent_available: false,
    torrent_files: undefined,
    private_sources: [{ id: `files:${part}`, files: batch.filter((_, index) => numbers.includes(index + 1)) }],
  })

test('a batch split across cours, each cour listing its own copy once, breaks no listing rule', () => {
  const result = resultItem({ releases: [cour('Cour 1', [1, 2]), cour('Cour 2', [3, 4])] })
  assert.deepEqual(listingViolations(result), [])
})

test('a torrent file selected for two cours is a listing violation', () => {
  const result = resultItem({ releases: [cour('Cour 1', [1, 2]), cour('Cour 2', [2, 3])] })
  assert.deepEqual(listingViolations(result), [`sam (Nyaa) selects "${episode(2)}" in both Cour 1 and Cour 2`])
})

test('the same release listed twice in one cour is a listing violation', () => {
  const result = resultItem({ releases: [cour('Cour 1', [1, 2]), privateCopy('Cour 1', [1, 2])] })
  assert.deepEqual(listingViolations(result), ['Cour 1 lists sam (Nyaa) and sam (AB), which are the same release'])
})

test('a private copy of another cour is a different release', () => {
  const result = resultItem({ releases: [cour('Cour 1', [1, 2]), privateCopy('Cour 1', [3, 4])] })
  assert.deepEqual(listingViolations(result), [])
})

test('a file selected in two cours is found when one cour also lists a patch torrent of the release', () => {
  const PATCH = 'b'.repeat(40)
  const patched = release('Cour 1', {
    info_hashes: [HASH, PATCH],
    torrent_files: [
      { hash: HASH, files: batch },
      { hash: PATCH, files: [{ name: 'patch.mkv', length: 1 }] },
    ],
    selected_files: [episode(1), episode(2)],
  })
  const result = resultItem({ releases: [patched, cour('Cour 2', [2, 3])] })
  assert.deepEqual(listingViolations(result), [`sam (Nyaa) selects "${episode(2)}" in both Cour 1 and Cour 2`])
})

test('releases without a torrent hash or file list are never taken for one torrent', () => {
  const unidentified = (part: string, numbers: number[]) =>
    release(part, {
      tracker: 'AB',
      info_hashes: [],
      torrent_available: false,
      torrent_files: undefined,
      selected_files: numbers.map(number => episode(number)),
    })
  const result = resultItem({ releases: [unidentified('Cour 1', [1, 2]), unidentified('Cour 2', [2, 3])] })
  assert.deepEqual(listingViolations(result), [])
})

test('an unscoped batch listed in two parts is a listing violation', () => {
  const result = resultItem({ releases: [release('Cour 1', {}), release('Cour 2', {})] })
  assert.deepEqual(
    listingViolations(result),
    batch.map(file => `sam (Nyaa) selects "${file.name}" in both Cour 1 and Cour 2`),
  )
})

test('a batch scoped in one part and left unscoped in another is a listing violation', () => {
  const result = resultItem({ releases: [cour('Cour 1', [1, 2]), release('Cour 2', {})] })
  assert.deepEqual(listingViolations(result), [
    `sam (Nyaa) selects "${episode(1)}" in both Cour 1 and Cour 2`,
    `sam (Nyaa) selects "${episode(2)}" in both Cour 1 and Cour 2`,
  ])
})
