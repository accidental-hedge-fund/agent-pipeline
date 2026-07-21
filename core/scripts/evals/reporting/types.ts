// Comparative-reporting types (eval-comparative-reporting). `summary.json`'s
// shape — additive over grades.jsonl/runs.jsonl/failures.jsonl/plan.json,
// never mutating them (report.ts).

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

export interface TreatmentSummary {
  treatment_id: string;
  reliability: ReliabilityRates;
  /** `null` for the baseline treatment itself. */
  quality_delta_vs_baseline: Effect | null;
  excluded_fixtures: string[];
  mean_duration_sec: number | null;
  cost: CostSummary | null;
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

export interface Summary {
  schema_version: number;
  experiment_id: string;
  baseline_treatment_id: string;
  interval_method: IntervalMethod;
  underpowered_threshold: number;
  treatments: TreatmentSummary[];
  pareto: ParetoFrontiers;
  groups: Partial<Record<GroupDimension, GroupEntry[]>>;
}

export const SUMMARY_SCHEMA_VERSION = 1;
