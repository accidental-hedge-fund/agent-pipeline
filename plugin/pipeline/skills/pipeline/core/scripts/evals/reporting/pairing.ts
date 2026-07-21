// Paired per-fixture comparison against a declared baseline treatment
// (eval-comparative-reporting, design.md decision 8). Replicates are reduced
// to a single value per (treatment, fixture) before pairing, so a treatment
// with more replicates never gains weight in the aggregate.

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Reduce `values` — every graded replicate's quality score for one
 *  (treatment, fixture) pair — to a single number via their mean. */
export function reduceReplicates(values: number[]): number {
  return mean(values);
}

export interface PairingResult {
  /** One delta (treatment − baseline) per fixture where both have a
   *  reduced value. */
  deltas: number[];
  /** Fixtures excluded because the treatment or the baseline lacked a
   *  completed, graded cell for it — named, never silently dropped. */
  excludedFixtures: string[];
}

/** `perFixtureValues` maps fixture_id -> replicate quality scores, already
 *  scoped to one treatment. Reduces replicates, then pairs against the same
 *  structure for the baseline. */
export function pairAgainstBaseline(
  treatmentValues: Map<string, number[]>,
  baselineValues: Map<string, number[]>,
): PairingResult {
  const deltas: number[] = [];
  const excludedFixtures: string[] = [];
  const allFixtures = new Set([...treatmentValues.keys(), ...baselineValues.keys()]);
  for (const fixtureId of allFixtures) {
    const t = treatmentValues.get(fixtureId);
    const b = baselineValues.get(fixtureId);
    if (t === undefined || b === undefined || t.length === 0 || b.length === 0) {
      excludedFixtures.push(fixtureId);
      continue;
    }
    deltas.push(reduceReplicates(t) - reduceReplicates(b));
  }
  return { deltas, excludedFixtures: excludedFixtures.sort() };
}
