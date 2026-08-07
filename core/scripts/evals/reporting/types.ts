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

/** Pair-loop diagnostics for named ordered-pair treatments (#601). */
export interface PairedTreatmentDiagnostics {
  pair_id: string;
  primary?: { harness?: string | null; model?: string | null; effort?: string | null };
  reviewer?: { harness?: string | null; model?: string | null; effort?: string | null };
  completed_cells: number;
  fix_invoked_cells: number;
  blocking_findings_before: number;
  blocking_findings_after: number;
  malformed_review_count: number;
}

export interface TreatmentSummary {
  treatment_id: string;
  reliability: ReliabilityRates;
  /** `null` for the baseline treatment itself. */
  quality_delta_vs_baseline: Effect | null;
  excluded_fixtures: string[];
  mean_duration_sec: number | null;
  cost: CostSummary | null;
  /** Present for named-pair treatments that recorded pair-loop evidence (#601). */
  pair?: PairedTreatmentDiagnostics;
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

/**
 * Multi-change comparative report section (#577). Correctness, effort, growth,
 * and structural telemetry remain separate dimensions. This shape MUST NOT
 * include a synthetic maintainability or "slop" ground-truth score field.
 */
export interface MultiChangeCheckpointTreatmentMetrics {
  treatment_id: string;
  model: string | null;
  portability_probe: boolean;
  strict_pass_rate: number;
  n: number;
  current_step_defects_mean: number;
  inherited_defects_mean: number;
  accumulated_unresolved_mean: number;
  recovered_defects_mean: number;
  mean_duration_sec: number | null;
  cost: CostSummary | null;
  mean_retries: number | null;
  mean_interventions: number | null;
  growth?: {
    mean_files_added: number | null;
    mean_change_amplification: number | null;
  };
  /** Structural telemetry as separate non-ground-truth signals. */
  structural_telemetry?: Record<string, number | null>;
}

export interface MultiChangeCheckpointReport {
  fixture_id: string;
  checkpoint_id: string;
  checkpoint_index: number;
  treatments: MultiChangeCheckpointTreatmentMetrics[];
}

export interface MultiChangeTreatmentLineageSummary {
  treatment_id: string;
  terminal_all_green_rate: number;
  n_lineages: number;
  /** Named baseline treatment this row is compared against (null for baseline). */
  baseline_treatment_id: string | null;
  quality_delta_vs_baseline: Effect | null;
}

export interface MultiChangeReport {
  /** Per fixture × checkpoint index, treatments paired for fair deltas. */
  by_checkpoint: MultiChangeCheckpointReport[];
  /** Lineage-level terminal all-green and baseline deltas. */
  lineages: MultiChangeTreatmentLineageSummary[];
  /** Optional variants requested but not present in the experiment (not zeroed). */
  variants_not_run: string[];
  /**
   * Explicit non-goal marker: structural telemetry and model-judged scores are
   * never collapsed into maintainability ground truth. Presence of this flag
   * documents the contract; there is intentionally no `maintainability_score`
   * or `slop_score` field on this object.
   */
  structural_telemetry_is_not_ground_truth: true;
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
  /** Present only when the experiment graded multi-change fixtures (#577). */
  multi_change?: MultiChangeReport;
}

export const SUMMARY_SCHEMA_VERSION = 1;

/** Fields that MUST never appear on a multi-change summary (regression guard). */
export const FORBIDDEN_MAINTAINABILITY_SCORE_FIELDS = [
  "maintainability_score",
  "slop_score",
  "slop",
  "overall_maintainability",
  "synthetic_maintainability",
] as const;
