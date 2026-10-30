import { createHash } from 'node:crypto';

export interface Rng {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [lo, hi], inclusive. */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  /** Multiples of 1/den in [lo, hi]: exactly representable in binary when den is a power of two. */
  dyadic(lo: number, hi: number, den?: number): number;
  /** In-place Fisher-Yates shuffle returning the same array. */
  shuffle<T>(items: T[]): T[];
}

/** A seeded generator (SFC32). Output depends only on the seed string; there is no ambient randomness. */
export function makeRng(seed: string): Rng {
  const h = createHash('sha256').update(`kensho-fixture/${seed}`).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  const rng: Rng = {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    dyadic: (lo, hi, den = 64) => rng.int(Math.ceil(lo * den), Math.floor(hi * den)) / den,
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j] as never, items[i] as never];
      }
      return items;
    },
  };
  return rng;
}
