// Grade record types (openspec/changes/eval-graders-and-comparative-reporting,
// eval-graders). Every grade is additive output over an immutable experiment
// (design.md decision 1) — these types describe what grading.ts writes to
// grades.jsonl, never what the runner writes.

import type { ArtifactDescriptor } from "../trajectory/types.ts";

/** The identity a grade record shares with its source CellRecord — the join
 *  key back to runs.jsonl, plan.json, and manifest.json. */
export interface CellIdentity {
  cell_id: string;
  experiment_id: string;
  fixture_id: string;
  treatment_id: string;
  replicate: number;
}

/** Grader id + version that produced a grade. A grade whose grader versions
 *  are not recorded is never written (eval-graders). */
export interface GraderVersion {
  grader: string;
  version: string;
}

export interface AcceptanceCriterionResult {
  id: string;
  satisfied: boolean;
}

/** Implementation/fix grade (eval-graders, requirement "Implementation and fix
 *  cells SHALL be graded on hidden tests, acceptance criteria, regressions,
 *  and out-of-scope changes"). */
export interface ImplementationFixGrade {
  hidden_tests: { passed: number; total: number };
  acceptance: { criteria: AcceptanceCriterionResult[]; completed: number; total: number };
  /** A check that passed at base_commit and fails on the candidate. */
  regressions: number;
  /** A check that fails at both base_commit and on the candidate. */
  pre_existing_failures: number;
  /** `null` when the fixture declares no `allowed_change_paths` boundary —
   *  absence of a declared boundary is absence of evidence, never zero. */
  out_of_scope_changes: number | null;
}

/** Signed (reported − expected) severity rank difference for one matched
 *  seeded defect. Never collapsed into a mean (design.md decision 4). */
export type SeverityDelta = number;

/** Review grade (eval-graders, requirement "Review cells SHALL be graded
 *  against seeded-defect ground truth"). */
export interface ReviewGrade {
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  /** `null` when the denominator (tp+fp or tp+fn) is zero. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  severity_calibration: SeverityDelta[];
}

/** Planning grade (eval-graders, requirement "Planning cells SHALL be graded
 *  against a versioned rubric that never consumes a treatment self-score"). */
export interface PlanningGrade {
  rubric_version: string;
  requirement_coverage: { covered: number; total: number };
  unsupported_assumptions: number;
  actionability: { step_count: number; score: number };
  downstream_compatibility: { matched_signals: number; total_signals: number; score: number };
}

/** One sub-grade contributed to a composite cell — a cell whose mode (e.g.
 *  `end-to-end`) has no single applicable grader but whose executor captured
 *  output from an underlying review or planning stage (eval-graders review 2
 *  finding b493406e: a composite cell's captured stage output must not be
 *  discarded just because the cell's mode itself has no direct grader). */
export type CompositeSubGradePayload =
  | { kind: "review"; grade: ReviewGrade }
  | { kind: "planning"; grade: PlanningGrade; self_assessment_observed?: unknown };

export type StageGradePayload =
  | { kind: "implementation-fix"; grade: ImplementationFixGrade }
  | { kind: "review"; grade: ReviewGrade }
  | { kind: "planning"; grade: PlanningGrade; self_assessment_observed?: unknown }
  | { kind: "composite"; grades: CompositeSubGradePayload[] };

/** One line of grades.jsonl. */
export interface GradeRecord extends CellIdentity {
  graders: GraderVersion[];
  payload: StageGradePayload;
  /** Descriptor for this grade's verifier evidence artifact (#536), when
   *  emission succeeded. Independently addressable from the cell's treatment
   *  trajectory artifact — never a reference into it. Populated only for a
   *  single-grader `payload.kind` (`implementation-fix`, `review`,
   *  `planning`); a `composite` grade uses `verifier_artifacts` instead. */
  verifier_artifact?: ArtifactDescriptor;
  /** Per-sub-grader verifier evidence artifact descriptors for a `composite`
   *  grade (#536) — one entry per deterministic grader folded into the
   *  composite, each independently addressable, so evidence from one
   *  sub-grader is never conflated with another's (review 1 finding
   *  c7218eb4). Populated only when `payload.kind === "composite"`. */
  verifier_artifacts?: Array<{ grader: string; version: string; artifact: ArtifactDescriptor }>;
  /** Durable record of why `verifier_artifact` is absent for a single-grader
   *  `payload.kind` (#536, review 1 finding 5ae0fa6e) — a build, collision,
   *  or write failure. Never affects the grade itself. */
  verifier_artifact_error?: string;
  /** Durable per-sub-grader record of why that grader's entry is missing
   *  from `verifier_artifacts` for a `composite` grade — same failure
   *  reasons as `verifier_artifact_error`, one per grader. */
  verifier_artifact_errors?: Array<{ grader: string; version: string; error: string }>;
}

/** A reason a completed cell produced no grade record — never silent, always
 *  surfaced so "no grade" is distinguishable from "cell not read". */
export interface SkippedCell extends CellIdentity {
  reason: string;
}

/** Optional model-judge result — a separate record, never an input to any
 *  deterministic grade field (eval-graders). */
export interface JudgeRecord extends CellIdentity {
  judge_harness: string;
  judge_model: string;
  judge_prompt_version: string;
  verdict: unknown;
  /** Descriptor for this judge invocation's verifier evidence artifact
   *  (#536) — separate from the deterministic grader's own artifact. */
  verifier_artifact?: ArtifactDescriptor;
  /** Durable record of why `verifier_artifact` is absent (#536, review 1
   *  finding 5ae0fa6e) — a build, collision, or write failure. */
  verifier_artifact_error?: string;
}

/** A recorded disagreement between a judge verdict and the deterministic
 *  grade for the same cell. Recording this never mutates the grade. */
export interface JudgeDisagreementRecord extends CellIdentity {
  judge_prompt_version: string;
  note: string;
  /** The judge's verifier evidence artifact for this disagreement (#536) —
   *  lets a maintainer inspect the judge side without conflating it with the
   *  deterministic grader's artifact. */
  verifier_artifact?: ArtifactDescriptor;
  /** Durable record of why `verifier_artifact` is absent (#536, review 1
   *  finding 5ae0fa6e) — a build, collision, or write failure. */
  verifier_artifact_error?: string;
}

/** A blinded human adjudication record. `opaque_key` is derived from
 *  `cell_id` alone — the record form carries no harness/provider/model/effort
 *  string (eval-graders). */
export interface AdjudicationRecord {
  opaque_key: string;
  verdict: string;
  rationale: string;
}
