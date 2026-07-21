// Cost handling (eval-comparative-reporting: "missing token/cost telemetry
// SHALL be reported as unknown and SHALL NOT be treated as zero"). Follows
// the stage-cost-accounting cost_source contract (#429) verbatim: a
// completed cell's detail may carry `cost_source: "actual" | "estimated" |
// "unknown"` and `cost_usd`; a cell recording neither is treated exactly the
// same as one recording `cost_source: "unknown"`.

import type { StageAccountingCostSource } from "../../types.ts";
import type { CostSummary } from "./types.ts";

export interface CellCost {
  cost_source: StageAccountingCostSource;
  cost_usd: number | null;
}

/** Read a completed cell's cost provenance off its recorded detail. Absent
 *  telemetry reads as `unknown`, never as a zero-cost actual. */
export function costFromDetail(detail: Record<string, unknown> | undefined): CellCost {
  const source = detail?.cost_source;
  if (source === "actual" || source === "estimated") {
    const usd = detail?.cost_usd;
    return { cost_source: source, cost_usd: typeof usd === "number" ? usd : null };
  }
  return { cost_source: "unknown", cost_usd: null };
}

/** Aggregate cost across a treatment's completed cells. Cells with unknown
 *  cost are excluded from `mean_cost_usd` but counted in `coverage`. Never
 *  imputes zero for a missing value. */
export function summarizeCost(costs: CellCost[]): CostSummary {
  const withCost = costs.filter((c) => c.cost_source !== "unknown" && c.cost_usd !== null);
  const actual = costs.filter((c) => c.cost_source === "actual").length;
  const estimated = costs.filter((c) => c.cost_source === "estimated").length;
  return {
    coverage: costs.length === 0 ? 0 : withCost.length / costs.length,
    actual_fraction: costs.length === 0 ? 0 : actual / costs.length,
    estimated_fraction: costs.length === 0 ? 0 : estimated / costs.length,
    mean_cost_usd: withCost.length === 0 ? null : withCost.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0) / withCost.length,
    n_with_cost: withCost.length,
  };
}
