// Deterministic randomness: every day's data is a pure function of (seed, profile, date), so re-syncing is idempotent
// and the demo looks the same for everyone with the same seed.

import { createHash } from 'node:crypto'

export function seedOf(...parts: string[]): number {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0)
}

/** mulberry32: small, fast, good enough for fake data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Dice {
  next(): number
  int(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(xs: readonly T[]): T
}

export function dice(seed: number): Dice {
  const r = rng(seed)
  return {
    next: r,
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    chance: (p) => r() < p,
    pick: (xs) => {
      const x = xs[Math.floor(r() * xs.length)]
      if (x === undefined) throw new Error('pick from empty list')
      return x
    },
  }
}
