// Seeded bootstrap confidence intervals over paired deltas
// (eval-comparative-reporting: "no randomness used in interval computation
// SHALL be unseeded"). mulberry32 is a small, deterministic PRNG — no
// dependency on Math.random, so the same seed always reproduces the same
// interval.

import type { Effect, IntervalMethod } from "./types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_RESAMPLES = 2000;
export const DEFAULT_CONFIDENCE = 0.95;
export const DEFAULT_UNDERPOWERED_THRESHOLD = 5;

export function defaultIntervalMethod(seed: number): IntervalMethod {
  return { name: "bootstrap-percentile", resamples: DEFAULT_RESAMPLES, seed, confidence: DEFAULT_CONFIDENCE };
}

/** Bootstrap a confidence interval over `deltas` using `method`'s seed and
 *  resample count. Deterministic: the same deltas + method always produce
 *  the same interval. Marks the effect `underpowered` when `n` is below
 *  `underpoweredThreshold`, but still computes and returns it. */
export function bootstrapEffect(deltas: number[], method: IntervalMethod, underpoweredThreshold: number): Effect {
  const n = deltas.length;
  if (n === 0) {
    return { mean: 0, ci_low: 0, ci_high: 0, n: 0, underpowered: true };
  }
  const rand = mulberry32(method.seed);
  const resampleMeans: number[] = [];
  for (let i = 0; i < method.resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += deltas[Math.floor(rand() * n)];
    }
    resampleMeans.push(sum / n);
  }
  resampleMeans.sort((a, b) => a - b);
  const alpha = (1 - method.confidence) / 2;
  const lowIdx = Math.max(0, Math.floor(alpha * resampleMeans.length));
  const highIdx = Math.min(resampleMeans.length - 1, Math.ceil((1 - alpha) * resampleMeans.length) - 1);
  return {
    mean: deltas.reduce((a, b) => a + b, 0) / n,
    ci_low: resampleMeans[lowIdx],
    ci_high: resampleMeans[highIdx],
    n,
    underpowered: n < underpoweredThreshold,
  };
}
