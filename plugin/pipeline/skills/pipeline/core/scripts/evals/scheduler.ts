// Seeded, harness-interleaved, resumable scheduling (openspec/changes/stage-eval-runner).

import type { Cell, CellRecord } from "./types.ts";

/** mulberry32 — a small, fast, deterministic PRNG. Same seed always produces
 *  the same sequence, which is what makes scheduling reproducible. */
export function makeSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], random: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Derive the execution order for a plan's cells from the manifest seed, then
 *  interleave across harnesses so consecutive cells rotate harnesses rather
 *  than running every cell of one harness before starting another
 *  (design.md decision 5). Deterministic: the same cells and seed always
 *  produce the same order. */
export function scheduleCells(cells: Cell[], seed: number): Cell[] {
  const random = makeSeededRandom(seed);
  const shuffled = seededShuffle(cells, random);

  const bucketOrder: string[] = [];
  const buckets = new Map<string, Cell[]>();
  for (const cell of shuffled) {
    const key = cell.treatment.harness ?? "_no-harness-axis";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      bucketOrder.push(key);
    }
    buckets.get(key)!.push(cell);
  }

  if (bucketOrder.length <= 1) {
    return shuffled;
  }

  const result: Cell[] = [];
  let remaining = shuffled.length;
  const cursors = new Map(bucketOrder.map((k) => [k, 0]));
  while (remaining > 0) {
    for (const key of bucketOrder) {
      const cursor = cursors.get(key)!;
      const bucket = buckets.get(key)!;
      if (cursor < bucket.length) {
        result.push(bucket[cursor]);
        cursors.set(key, cursor + 1);
        remaining--;
      }
    }
  }
  return result;
}

/** Resume support: drop cells whose cell_id already has a completed
 *  (runs.jsonl) or failed (failures.jsonl) record, so a re-invocation never
 *  re-executes a finished cell. */
export function cellsRemaining(scheduled: Cell[], existingRecords: CellRecord[]): Cell[] {
  const done = new Set(existingRecords.map((r) => r.cell_id));
  return scheduled.filter((c) => !done.has(c.cell_id));
}
