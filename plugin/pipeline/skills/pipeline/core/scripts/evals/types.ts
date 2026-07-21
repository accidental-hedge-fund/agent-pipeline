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

/** A seeded, ground-truth defect on a review fixture (eval-fixture-contract). */
export interface SeededDefect {
  /** Stable, unique-within-fixture identifier. */
  defect_id: string;
  /** Repository-relative path the defect lives on. */
  path: string;
  line_start: number;
  line_end: number;
  expected_severity: string;
}

/** One checkable statement a correct result must satisfy (eval-fixture-contract).
 *  Optional deterministic hooks let a grader decide it without a model call:
 *  `check_names` (implementation/fix — satisfied iff every named check passes)
 *  and `keywords` (planning — satisfied iff every keyword phrase appears in the
 *  treatment's output text). A criterion with neither is reported as a stable
 *  identifier only; graders that cannot decide it deterministically report it
 *  unsatisfied rather than guessing. */
export interface AcceptanceCriterion {
  id: string;
  statement: string;
  check_names?: string[];
  keywords?: string[];
}

/** A versioned reference to one of the graders in `core/scripts/evals/grading/`. */
export interface GraderRef {
  grader: string;
  version: string;
}

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
  /** Checks visible to the treatment (it may run them itself). */
  public_checks: string[];
  /** Checks resolvable only by the grading layer — never exposed to a
   *  treatment. Disjoint from `public_checks` by construction (fixture.ts). */
  hidden_checks?: string[];
  /** Ground truth for review grading. */
  seeded_defects?: SeededDefect[];
  /** Checkable statements a correct implementation/fix or planning result
   *  must satisfy. */
  acceptance_criteria?: AcceptanceCriterion[];
  /** Repository paths a correct implementation/fix result may modify. A
   *  changed path outside this boundary is out of scope. Absent (not empty)
   *  means "no boundary declared" — out-of-scope is then reported unknown. */
  allowed_change_paths?: string[];
  grader_refs: GraderRef[];
  category: string;
  risk: string;
  provenance: FixtureProvenance;
}

export const SUPPORTED_FIXTURE_SCHEMA_VERSIONS = [1] as const;
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = [1] as const;

/** Graders the grading layer knows how to run, and the versions of each it
 *  supports. A fixture's `grader_refs` must name one of these grader ids and
 *  one of its supported versions (fixture.ts) — an unrecognized grader or an
 *  unsupported version fails fixture validation rather than being graded on
 *  a best-effort basis (eval-fixture-contract). */
export const SUPPORTED_GRADER_VERSIONS: Record<string, readonly string[]> = {
  "implementation-fix": ["1"],
  review: ["1"],
  planning: ["1"],
};

/** One value on the treatment matrix. Every axis is optional — a manifest may
 *  vary only harness, only effort, etc. `executor` (#434) binds the cell to a
 *  named `model-endpoint` executor from `.github/pipeline.yml` instead of a
 *  local CLI harness — mutually exclusive with `harness` in practice, since a
 *  cell is executed through exactly one or the other (executor.ts task 6). */
export interface TreatmentAxes {
  harness?: string[];
  provider?: string[];
  model?: string[];
  effort?: string[];
  executor?: string[];
}

/** One concrete point in the treatment matrix, after expansion. */
export interface Treatment {
  harness?: string;
  provider?: string;
  model?: string;
  effort?: string;
  executor?: string;
}

/** Execution/auth class recorded on a cell (#434 api-executor-response-provenance
 *  requirement "cell records SHALL distinguish API endpoint treatments from CLI
 *  harness treatments"). Mirrors the `provider_auth_class` value model-endpoint
 *  invocations write onto the underlying stage accounting record. */
export type CellExecutionClass = "api-key" | "local-cli";

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

/** One executed cell's outcome, before the join keys/result_class are attached.
 *
 *  `detail` is an opaque blob to the runner, but for a `completed` cell the
 *  grading layer (core/scripts/evals/grading/) reads these conventional keys
 *  when present, all populated by executor.ts before the cell's worktree is
 *  torn down (they do not survive it, so they must be captured here):
 *    - `stages`: per-stage invocation outcome (always present).
 *    - `checks`: `Record<string, boolean>` — pass/fail for every check named
 *      in the fixture's `public_checks` + `hidden_checks`, run in the cell's
 *      worktree. Present only when the fixture declares at least one check.
 *    - `changed_paths`: `string[]` — repository-relative paths that differ
 *      from `base_sha` in the cell's worktree. Present only when the fixture
 *      declares `allowed_change_paths` (out-of-scope detection needs it).
 *    - `findings`: review-mode only — `ReviewFinding[]` parsed from the
 *      harness's review-verdict JSON output, best-effort.
 *    - `output_text`: planning-mode only — the harness's raw stdout, used by
 *      the planning rubric's deterministic keyword coverage check.
 *    - `self_assessment`: planning-mode only — a self-score/confidence value
 *      the treatment emitted, if any. Recorded as an observation; the
 *      planning grader never reads it as a grade input. */
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
