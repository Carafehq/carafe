/** Small deterministic PRNG helpers used by MomentsBench. */
export type Random = () => number;

export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rng: Random, min: number, max: number): number {
  if (max < min) throw new Error(`invalid random range: ${min}..${max}`);
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Random, values: readonly T[]): T {
  if (!values.length) throw new Error("cannot pick from an empty list");
  return values[int(rng, 0, values.length - 1)]!;
}

export function chance(rng: Random, probability: number): boolean {
  return rng() < probability;
}

export function shuffle<T>(rng: Random, values: readonly T[]): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
