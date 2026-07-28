// Comparative-reporting types (eval-comparative-reporting). `summary.json`'s
// shape — additive over grades.jsonl/runs.jsonl/failures.jsonl/plan.json,
// never mutating them (report.ts).

import type { ArtifactDescriptor } from "../trajectory/types.ts";

export interface IntervalMethod {
  name: "bootstrap-percentile";
  resamples: number;
  seed: number;
  confidence: number;
}

/** A paired-delta aggregate effect. Always carries an interval and the
 *  sample size it was computed from (eval-comparative-reporting). */
export interface Effect {
  mean: number;
  ci_low: number;
  ci_high: number;
  n: number;
  underpowered: boolean;
}

export interface ReliabilityRates {
  completion_rate: number;
  planned: number;
  completed: number;
  infra_error_rate: number;
  auth_error_rate: number;
  timeout_rate: number;
}

export interface CostSummary {
  coverage: number;
  actual_fraction: number;
  estimated_fraction: number;
  mean_cost_usd: number | null;
  n_with_cost: number;
}

/** Outcome of the primary -> reviewer -> (optional) primary-fix handoff for
 *  an explicit paired treatment. Counts, rather than rates, preserve the
 *  evidence needed to compare small experimental populations. */
export interface PairedConvergenceSummary {
  primary: { harness: string; model?: string; effort?: string };
  reviewer: { harness: string; model?: string; effort?: string };
  completed_cells: number;
  fix_invoked_cells: number;
  initial_blocking_findings: number;
  final_blocking_findings: number;
  resolved_blocking_findings: number;
  malformed_initial_reviews: number;
  malformed_final_reviews: number;
}

export interface TreatmentSummary {
  treatment_id: string;
  reliability: ReliabilityRates;
  /** `null` for the baseline treatment itself. */
  quality_delta_vs_baseline: Effect | null;
  excluded_fixtures: string[];
  mean_duration_sec: number | null;
  cost: CostSummary | null;
  /** Present only for a named paired treatment; keeps the ordered primary /
   *  reviewer identity and review-convergence evidence in summary.json. */
  paired?: PairedConvergenceSummary;
}

export interface ParetoFrontiers {
  quality_vs_duration: string[];
  quality_vs_cost: string[];
}

export interface GroupEntry {
  value: string;
  n: number;
  mean_quality: number;
  completion_rate: number;
}

export type GroupDimension = "stage" | "harness" | "provider" | "model" | "effort" | "category" | "risk";

/** One flagged cell's linked artifact references (#536 task 6.1) — opt-in,
 *  additive only. `reasons` names every reason the cell was flagged
 *  (deterministically sorted); `verifier_artifacts` is deduplicated by
 *  content hash and sorted the same way. */
export interface LinkedArtifactEntry {
  cell_id: string;
  reasons: string[];
  treatment_artifact?: ArtifactDescriptor;
  verifier_artifacts: ArtifactDescriptor[];
}

export interface Summary {
  schema_version: number;
  experiment_id: string;
  baseline_treatment_id: string;
  interval_method: IntervalMethod;
  underpowered_threshold: number;
  treatments: TreatmentSummary[];
  pareto: ParetoFrontiers;
  groups: Partial<Record<GroupDimension, GroupEntry[]>>;
  /** Present only when trajectory linking is opted in (report.ts
   *  `linkArtifacts`); absent — never an empty array — by default, so the
   *  default summary is byte-identical to the pre-#536 output. */
  linked_artifacts?: LinkedArtifactEntry[];
}

export const SUMMARY_SCHEMA_VERSION = 1;
