/** Tiny deterministic PRNG so every reload produces the same warehouse. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  int(minInclusive: number, maxInclusive: number): number
  float(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  /** Weighted pick; `weights` need not be normalised. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T
  bool(probability: number): boolean
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed)
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items, weights) => {
      const total = weights.reduce((a, b) => a + b, 0)
      let r = next() * total
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]
        if (r <= 0) return items[i]
      }
      return items[items.length - 1]
    },
    bool: (p) => next() < p,
  }
}
