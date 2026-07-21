// Shared types for the stage eval runner (core/scripts/evals/).
//
// This module never imports the production stage files — the eval runner is
// an experiment harness, not a participant in the label-driven state machine
// (openspec/changes/stage-eval-runner/design.md).

/** The six independently-invocable stage entry points, plus the end-to-end mode. */
export const EVAL_STAGE_NAMES = [
  "planning",
  "plan-review",
  "implementing",
  "review",
  "fix",
  "shipcheck",
] as const;
export type EvalStageName = (typeof EVAL_STAGE_NAMES)[number];

export type EvalMode = EvalStageName | "end-to-end";

export type FixtureProvenance = "synthetic" | "harvested";

/** One frozen task. Self-contained: entering any stage it supports requires
 *  no data beyond the fixture and the repository at base_commit. */
export interface Fixture {
  fixture_id: string;
  schema_version: number;
  /** Full, immutable 40-char commit SHA. */
  base_commit: string;
  /** The issue/spec text under evaluation. */
  task_input: string;
  /** Frozen inputs keyed by the stage they let the runner enter directly. */
  stage_entry_artifacts: Partial<Record<EvalStageName, unknown>>;
  public_checks: string[];
  grader_refs: string[];
  category: string;
  risk: string;
  provenance: FixtureProvenance;
}

export const SUPPORTED_FIXTURE_SCHEMA_VERSIONS = [1] as const;
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = [1] as const;

/** One value on the treatment matrix. Every axis is optional — a manifest may
 *  vary only harness, only effort, etc. */
export interface TreatmentAxes {
  harness?: string[];
  provider?: string[];
  model?: string[];
  effort?: string[];
}

/** One concrete point in the treatment matrix, after expansion. */
export interface Treatment {
  harness?: string;
  provider?: string;
  model?: string;
  effort?: string;
}

export interface ExperimentManifest {
  schema_version: number;
  experiment_id: string;
  fixture_ids: string[];
  mode: EvalMode;
  treatments: TreatmentAxes;
  replicates: number;
  seed: number;
  concurrency: number;
  /** Per-cell timeout, in seconds. */
  timeout: number;
  output_dir: string;
}

export type CellResultClass = "completed" | "infra_error" | "auth_error" | "timeout";

/** One fixture x treatment x replicate coordinate, before execution. */
export interface Cell {
  cell_id: string;
  experiment_id: string;
  fixture_id: string;
  treatment_id: string;
  treatment: Treatment;
  replicate: number;
  mode: EvalMode;
  base_sha: string;
}

/** The persisted run plan — output of expandPlan(), written before execution. */
export interface RunPlan {
  schema_version: number;
  experiment_id: string;
  seed: number;
  cells: Cell[];
}

/** One executed cell's outcome, before the join keys/result_class are attached. */
export interface CellOutcome {
  result_class: CellResultClass;
  /** Present for `completed` — the treatment's raw outcome, success or failure. */
  detail?: Record<string, unknown>;
  /** Present for infra_error / auth_error / timeout. */
  error?: string;
}

/** One line of runs.jsonl or failures.jsonl. */
export interface CellRecord {
  cell_id: string;
  experiment_id: string;
  fixture_id: string;
  treatment_id: string;
  replicate: number;
  prompt_hash: string;
  config_hash: string;
  base_sha: string;
  result_class: CellResultClass;
  detail?: Record<string, unknown>;
  error?: string;
}
