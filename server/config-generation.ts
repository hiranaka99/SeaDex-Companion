/** Server-wide invalidation counter. Configuration saves bump it; caches and plans key on it. */
let generation = 0

export function currentGeneration(): number {
  return generation
}
export function bumpGeneration(): number {
  return ++generation
}
