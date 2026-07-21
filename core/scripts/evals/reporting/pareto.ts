// Quality-versus-duration / quality-versus-cost Pareto frontiers
// (eval-comparative-reporting). Lists non-dominated treatments; never
// collapses the two axes into one weighted score.

export interface ParetoPoint {
  treatment_id: string;
  quality: number;
  /** The "other" axis — duration or cost. Lower is better. */
  cost: number;
}

/** `a` dominates `b` when `a` is at least as good on quality and at least as
 *  good (lower or equal) on the other axis, with a strict improvement on at
 *  least one of the two. */
function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const atLeastAsGood = a.quality >= b.quality && a.cost <= b.cost;
  const strictlyBetter = a.quality > b.quality || a.cost < b.cost;
  return atLeastAsGood && strictlyBetter;
}

/** Returns the treatment_ids of the non-dominated points, sorted for
 *  deterministic output. A point missing its cost/duration axis (e.g. no
 *  cost telemetry at all) is excluded from that frontier — it cannot be
 *  meaningfully compared. */
export function paretoFrontier(points: ParetoPoint[]): string[] {
  const nonDominated = points.filter((p) => !points.some((other) => other !== p && dominates(other, p)));
  return nonDominated.map((p) => p.treatment_id).sort();
}
