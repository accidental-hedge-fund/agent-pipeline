// Shared infrastructure for benchmark-reliability.test.ts.
// No runtime dependencies outside Node built-ins.

/** Structured result emitted by every benchmark scenario. */
export interface BenchmarkResult {
  scenario: string;
  /** p50 wall time across all samples in this scenario (milliseconds). */
  p50_ms: number;
  /** p95 wall time across all samples in this scenario (milliseconds). */
  p95_ms: number;
  /** Total number of times the fake gh dep was invoked during the scenario. */
  gh_call_count: number;
  /** Total wall time for the entire scenario (all samples) in milliseconds. */
  stage_duration_ms: number;
}

/** Compute p50 and p95 from an array of sample durations. */
export function computePercentiles(samples: number[]): { p50: number; p95: number } {
  if (samples.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const p50idx = Math.floor(sorted.length * 0.5);
  const p95idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return { p50: sorted[p50idx] ?? 0, p95: sorted[p95idx] ?? 0 };
}

/**
 * A gh-call counter that wraps async dep functions so every invocation
 * increments a shared call tally.
 *
 * Usage:
 *   const counter = makeGhCounter();
 *   const fakeDep = counter.track(async () => someValue);
 *   counter.reset();                     // between scenarios
 *   const total = counter.calls;         // after scenario
 */
export interface GhCounter {
  /** Total calls recorded since the last reset() (or construction). */
  readonly calls: number;
  /** Reset the call tally to 0. */
  reset(): void;
  /**
   * Wrap an async function so each call increments the counter.
   * The returned function has the same signature as the input.
   */
  track<T>(fn: (...args: never[]) => Promise<T>): (...args: never[]) => Promise<T>;
}

export function makeGhCounter(): GhCounter {
  let calls = 0;
  return {
    get calls() { return calls; },
    reset() { calls = 0; },
    track<T>(fn: (...args: never[]) => Promise<T>): (...args: never[]) => Promise<T> {
      return (...args: never[]) => {
        calls++;
        return fn(...args);
      };
    },
  };
}
