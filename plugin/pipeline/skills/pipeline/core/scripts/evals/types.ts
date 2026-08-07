// Shared types for the stage eval runner (core/scripts/evals/).
//
// This module never imports the production stage files — the eval runner is
// an experiment harness, not a participant in the label-driven state machine
// (openspec/changes/stage-eval-runner/design.md).

import type { ModelEndpointParams } from "../types.ts";
import type { ExternalSandboxMode } from "../harness-adapters/types.ts";
import type { ArtifactDescriptor } from "./trajectory/types.ts";
import type { GhRefusalRecord } from "./gh-eval-surface.ts";

/** The eval runner's declared execution sandbox mode — re-exported from
 *  harness-adapters/types.ts (single-sourced there) so the manifest and cell
 *  record never define their own, possibly-drifting, copy of the supported
 *  values (#607). */
export type SandboxMode = ExternalSandboxMode;
export { EXTERNAL_SANDBOX_MODES as SANDBOX_MODES } from "../harness-adapters/types.ts";

/** One command denied at the process boundary of an eval cell's harness
 *  child process (#607 — eval-agent-isolation-boundary). */
export interface BoundaryDenial {
  command: string;
  argv: string[];
  category: string;
  at: string;
}

/** Durable isolation-boundary evidence for a cell: every process-level
 *  denial plus every mutating-GitHub-operation refusal recorded by the
 *  eval-mode `gh` surface. Classified apart from `result_class`/correctness —
 *  no grader reads this field (#607). */
export interface BoundaryEvidence {
  denials: BoundaryDenial[];
  gh_refusals: GhRefusalRecord[];
  /** Present only when restoring the eval instruction contract failed —
   *  never fatal to the cell's primary outcome. */
  restore_failures?: string[];
}

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

/** Multi-role pair modes (#601): ordered primary→reviewer graphs with live
 *  handoffs. Mutually exclusive with single-role Cartesian modes. */
export const PAIRED_EVAL_MODES = ["implementing-paired", "pipeline-paired"] as const;
export type PairedEvalMode = (typeof PAIRED_EVAL_MODES)[number];

export type EvalMode = EvalStageName | "end-to-end" | PairedEvalMode;

/** True when `mode` is a multi-role pair graph (not a single Cartesian stage). */
export function isPairedEvalMode(mode: EvalMode): mode is PairedEvalMode {
  return (PAIRED_EVAL_MODES as readonly string[]).includes(mode);
}

export type FixtureProvenance = "synthetic" | "harvested";

/** The three permitted environment-fidelity modes for an external dependency
 *  (eval-fixture-contract, eval-fixture-harvest #535). `live` is never a
 *  default — see fixture.ts's default-mode rule and harvest.ts's explicit
 *  maintainer-selection requirement. */
export const ENVIRONMENT_DEPENDENCY_MODES = ["live", "simulated", "forbidden"] as const;
export type EnvironmentDependencyMode = (typeof ENVIRONMENT_DEPENDENCY_MODES)[number];

/** One external tool/service/data dependency a fixture's task may touch
 *  (eval-fixture-contract #535). `version` is a mode identifier, not a
 *  semver — it only needs to change when the simulation/mode itself changes,
 *  so a mode change is detectable via `env_surface_hash`. */
export interface EnvironmentDependency {
  name: string;
  mode: EnvironmentDependencyMode;
  version: string;
  required_permissions: string[];
  initial_state: unknown;
  expected: { outputs?: unknown; errors?: unknown };
  setup: string;
  teardown: string;
}

/** A resolved snapshot of the agent surface a candidate exercises
 *  (eval-fixture-harvest #535) — not a free-text guess. Embedded on a
 *  harvested fixture so `env_surface_hash` can be derived deterministically
 *  from the fixture alone, without re-resolving live repo/git state. */
export interface CapabilitySurfaceInventory {
  stage: string;
  materialized_prompts: string[];
  harness_config: Record<string, unknown>;
  tools_hooks: string[];
  repo_paths: string[];
  services_data: string[];
}

/** A seeded, ground-truth defect on a review fixture (eval-fixture-contract). */
export interface SeededDefect {
  /** Stable, unique-within-fixture identifier. */
  defect_id: string;
  /** Repository-relative path the defect lives on. */
  path: string;
  line_start: number;
  line_end: number;
  expected_severity: string;
  /**
   * Runnable command that MUST fail (non-zero exit) at the fixture pin with no
   * treatment applied — proves the declared defect still bites (#637). Deep
   * preflight executes this probe and rejects the fixture when it passes
   * (already fixed / non-biting). For review fixtures whose ground truth is a
   * frozen stage-entry diff, preflight materializes that diff and sets
   * `EVAL_PREFLIGHT_REVIEW_DIFF` so probes can inspect it.
   */
  biting_probe: string;
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

/** Fixture form discriminator (#577 multi-change maintainability). Absent or
 *  `"single_task"` is the legacy single-task shape; `"multi_change"` requires
 *  a non-empty ordered `checkpoints` list. */
export type FixtureKind = "single_task" | "multi_change";

/** One deterministic held-out verifier on a multi-change checkpoint (#577).
 *  Never exposed to the treatment; run only by the runner/grader. */
export interface MultiChangeHeldOutVerifier {
  /** Stable id for defect accounting across the lineage. Unique within the
   *  fixture's full verifier closure. */
  verifier_id: string;
  /** Shell command; exit 0 = pass. Bodies must not appear in task_input. */
  check: string;
}

/** Optional weaker/cheaper model override applied only at a portability-probe
 *  checkpoint (#577). Coordinates the runner can honor for that step alone. */
export interface PortabilityModelOverride {
  model: string;
  harness?: string;
  effort?: string;
}

/** One ordered step in a multi-change maintainability fixture (#577). */
export interface MultiChangeCheckpoint {
  /** Stable id unique within the fixture. */
  checkpoint_id: string;
  /** Requirement disclosed only at this step (incremental disclosure). */
  task_input: string;
  /** Held-out verifiers for newly requested behavior at this step. */
  held_out_verifiers: MultiChangeHeldOutVerifier[];
  /** Optional stage-entry artifacts for this step only. When absent, the
   *  fixture-level `stage_entry_artifacts` are used. */
  stage_entry_artifacts?: Partial<Record<EvalStageName, unknown>>;
  /** Optional public checks the treatment may run itself (never held-out). */
  public_checks?: string[];
  /** When true, this checkpoint is designed so a test-passing shortcut can
   *  raise later inherited-verifier or amplification cost. */
  introduces_shortcut_debt?: boolean;
  /** Portability probe: apply a weaker/cheaper model only at this step. */
  portability?: PortabilityModelOverride;
}

/** Optional corpus/role metadata on a multi-change fixture (#577). Not
 *  required for validation. */
export interface MultiChangeRoles {
  /** Fixture demonstrates early test-passing shortcut debt. */
  shortcut_debt?: boolean;
  /** Curated external canary packaging mark. */
  external_canary?: boolean;
  /** Provenance/label for an external canary (e.g. "slopcodebench-curated"). */
  external_canary_provenance?: string;
}

/**
 * Controlled multi-change treatment profiles (#577). Same checkpoint prompts
 * and verifiers; only the harness graph / feedback path differs. `#575`
 * design-dossier is optional and never required for bare-vs-pipeline.
 */
export const MULTI_CHANGE_TREATMENT_PROFILES = [
  "bare",
  "just-solve",
  "pipeline-current",
  "adversarial-review",
  "quality-feedback",
  "design-dossier",
] as const;
export type MultiChangeTreatmentProfile = (typeof MULTI_CHANGE_TREATMENT_PROFILES)[number];

/** True when a treatment profile is the minimal bare / just-solve path. */
export function isBareMultiChangeProfile(profile: string | undefined): boolean {
  return profile === undefined || profile === "bare" || profile === "just-solve";
}

/** One frozen task. Self-contained: entering any stage it supports requires
 *  no data beyond the fixture and the repository at base_commit. */
export interface Fixture {
  fixture_id: string;
  schema_version: number;
  /**
   * Fixture form (#577). Absent means single-task (backward compatible).
   * `"multi_change"` requires a non-empty ordered `checkpoints` array.
   */
  kind?: FixtureKind;
  /** Full, immutable 40-char commit SHA. */
  base_commit: string;
  /** The issue/spec text under evaluation. For multi-change fixtures this is
   *  a sequence synopsis only — treatments receive per-checkpoint task_input. */
  task_input: string;
  /** Frozen inputs keyed by the stage they let the runner enter directly. */
  stage_entry_artifacts: Partial<Record<EvalStageName, unknown>>;
  /** Checks visible to the treatment (it may run them itself). */
  public_checks: string[];
  /** Checks resolvable only by the grading layer — never exposed to a
   *  treatment. Disjoint from `public_checks` by construction (fixture.ts). */
  hidden_checks?: string[];
  /** Ordered multi-change checkpoints (#577). Present iff kind is multi_change. */
  checkpoints?: MultiChangeCheckpoint[];
  /** Optional multi-change role metadata (#577). */
  roles?: MultiChangeRoles;
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
  /** Explicit smoke-only mark (#637). Required when `grader_refs` is empty;
   *  forbidden when `grader_refs` is non-empty. Smoke fixtures are eligible for
   *  harness/isolation smoke but never enter graded quality aggregates. */
  smoke_only: boolean;
  category: string;
  risk: string;
  provenance: FixtureProvenance;
  /** Optional external tool/service/data dependencies (eval-fixture-contract
   *  #535). Absent/empty stays valid — the common `synthetic` case. */
  environment?: EnvironmentDependency[];
  /** Optional resolved capability-surface snapshot (eval-fixture-harvest
   *  #535), embedded by the harvest workflow. */
  capability_surface?: CapabilitySurfaceInventory;
  /** Provenance hash over the resolved `environment` + `capability_surface`
   *  (eval-fixture-contract #535) — always computed at fixture-load time,
   *  even for a fixture declaring neither (a stable baseline hash). */
  env_surface_hash: string;
  /** Optional explicit bootstrap that materializes `base_commit` when the
   *  object is not present in a default clone (#637). When present, preflight
   *  runs this procedure before cells. Absent + missing object fails preflight. */
  base_commit_bootstrap?: string;
}

/** True when the fixture is a multi-change maintainability sequence (#577). */
export function isMultiChangeFixture(fixture: Fixture): boolean {
  return fixture.kind === "multi_change";
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
  /** Multi-change maintainability grader: new + inherited held-out verifiers
   *  and defect-state accounting (#577). */
  "multi-change": ["1"],
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
  /** Each entry is a JSON-encoded `ModelEndpointParams` object (manifest axis
   *  values are uniformly string[]; manifest.ts parses and validates each
   *  entry against the same allowlist a committed executor's `params:` uses). */
  params?: string[];
  /**
   * Multi-change treatment profile axis (#577): `bare` / `just-solve` vs
   * `pipeline-current` and optional controlled variants. Same checkpoint
   * prompts and verifiers; only the execution graph differs. Ignored for
   * single-task fixtures.
   */
  profile?: string[];
}

/** One concrete point in the treatment matrix, after expansion.
 *  Cartesian cells carry single-role axis values. Named-pair cells carry
 *  `id` + `primary` + `reviewer` role coordinates (#601). */
export interface Treatment {
  harness?: string;
  provider?: string;
  model?: string;
  effort?: string;
  executor?: string;
  /** Parsed from the manifest's JSON-encoded `params` axis value (#434 task 6.1). */
  params?: ModelEndpointParams;
  /**
   * Multi-change treatment profile (#577). When set on a multi-change cell,
   * selects bare vs pipeline-current (or an optional controlled variant).
   */
  profile?: string;
  /** Named-pair treatment id (equals the pair's declared `id`). */
  id?: string;
  /** Primary (implementer) role coordinates for a named-pair treatment. */
  primary?: RoleCoordinate;
  /** Reviewer role coordinates for a named-pair treatment. */
  reviewer?: RoleCoordinate;
}

/**
 * Allowlisted fields on a named-pair role coordinate (#601).
 *
 * `provider`, `executor`, and `params` are intentionally NOT allowlisted:
 * paired-loop execution only dispatches local CLI harnesses with harness /
 * model / effort. Accepting API-executor or provider coordinates would
 * advertise a treatment the pair loop cannot execute (review 2 f7df46b5).
 * Re-add only when paired phases share Cartesian's model-endpoint path.
 */
export const ROLE_COORDINATE_FIELDS = [
  "harness",
  "model",
  "effort",
] as const;

/** One role's coordinates in a named ordered primary/reviewer pair. */
export interface RoleCoordinate {
  harness: string;
  model?: string;
  effort?: string;
}

/** One named ordered primary→reviewer pair treatment. */
export interface NamedPair {
  id: string;
  primary: RoleCoordinate;
  reviewer: RoleCoordinate;
}

/** Discriminated named-pairs treatment form on the manifest `treatments` field.
 *  Mutually exclusive with Cartesian axis form (eval-paired-treatments #601). */
export interface NamedPairsTreatments {
  form: "named-pairs";
  pairs: NamedPair[];
}

/** True when `treatments` is the named-pairs form rather than Cartesian axes. */
export function isNamedPairsTreatments(
  treatments: TreatmentAxes | NamedPairsTreatments,
): treatments is NamedPairsTreatments {
  return (treatments as NamedPairsTreatments).form === "named-pairs";
}

/** Execution/auth class recorded on a cell (#434 api-executor-response-provenance
 *  requirement "cell records SHALL distinguish API endpoint treatments from CLI
 *  harness treatments"). Mirrors the `provider_auth_class` value model-endpoint
 *  invocations write onto the underlying stage accounting record. */
export type CellExecutionClass = "api-key" | "local-cli";

/** Role that failed preflight/auth in a paired cell (#601). */
export type FailedRole = "primary" | "reviewer";

export interface ExperimentManifest {
  schema_version: number;
  experiment_id: string;
  fixture_ids: string[];
  mode: EvalMode;
  /** Exactly one of Cartesian axes or named-pairs form — never both (#601). */
  treatments: TreatmentAxes | NamedPairsTreatments;
  replicates: number;
  seed: number;
  concurrency: number;
  /** Per-cell timeout, in seconds. */
  timeout: number;
  output_dir: string;
  /** The execution sandbox mode every cell in this experiment runs under
   *  (#607). Always resolved by manifest.ts's validation — defaults to
   *  `"managed"` when the raw manifest omits the field, so an existing
   *  manifest stays valid and unchanged in behavior. */
  sandbox_mode: SandboxMode;
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

/** Distinguishes how a `review`-stage treatment's stdout was parsed into
 *  `detail.findings` (#606): `strict` satisfied the full production verdict
 *  contract (`parseStrictVerdict`); `tolerant` recovered a verdict that was
 *  parsed from JSON but did not satisfy the full contract (e.g. a finding
 *  missing an optional field); `unparseable` means no verdict JSON could be
 *  found — prose or empty output, `detail.findings` is absent. */
export type ReviewVerdictParseProvenance = "strict" | "tolerant" | "unparseable";

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
 *      harness's review-verdict JSON output via the production verdict
 *      parsers, present only when a verdict was parsed.
 *    - `review_verdict_parse`: review-mode only — a `ReviewVerdictParseProvenance`
 *      disclosing whether the treatment satisfied the structured verdict
 *      contract, was tolerantly recovered, or was unparseable.
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
  /** Carried from the fixture's `env_surface_hash` (eval-fixture-contract
   *  #535) — detects an environment/agent-surface difference between
   *  experiment populations, alongside prompt_hash/config_hash/base_sha. */
  env_surface_hash: string;
  /** The resolved execution sandbox mode this cell ran under (#607) — carried
   *  from the manifest so two cells differing only by sandbox mode are never
   *  pooled as identically configured (also folded into `config_hash`). */
  sandbox_mode: SandboxMode;
  result_class: CellResultClass;
  detail?: Record<string, unknown>;
  error?: string;
  /** Descriptor for this cell's treatment trajectory artifact (#536), when
   *  collection succeeded. Absent when collection failed or produced no
   *  artifact — never a stand-in for an empty trajectory. */
  trajectory_artifact?: ArtifactDescriptor;
  /** Durable record of why `trajectory_artifact` is absent despite the cell
   *  having run (#536, review 1 finding 5ae0fa6e) — a build failure, a
   *  content-address collision, or a write failure. Absent when collection
   *  succeeded. Never affects `result_class`: collection is diagnostic-only. */
  trajectory_artifact_error?: string;
  /** Isolation-boundary evidence for this cell (#607) — present only when at
   *  least one process-level denial, `gh`-surface refusal, or contract
   *  restore failure occurred. Absent means no denial occurred, never "not
   *  collected" (see `boundary_evidence_error`). Never read by a grader and
   *  never changes `result_class`. */
  boundary_evidence?: BoundaryEvidence;
  /** Present only when collecting boundary evidence itself failed —
   *  distinguishable from "no denials occurred" (absent `boundary_evidence`),
   *  mirroring `trajectory_artifact_error`. */
  boundary_evidence_error?: string;
}
