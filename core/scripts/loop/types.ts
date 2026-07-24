// Shared types and schema-id constants for the in-repo durable loop engine
// (#508 — absorbing the standalone goal-loop core into Agent Pipeline).
//
// These are the Pipeline-native replacements for goal-loop's `contract@2` /
// `ledger@2` documents. Field names are chosen to match goal-loop's shape
// closely (snake_case, same concepts) so the import module (goal-loop-run
// import) can translate without lossy remapping — see loop/import.ts.

export const LOOP_CONTRACT_SCHEMA = "pipeline/loop-contract@1";
export const LOOP_LEDGER_SCHEMA = "pipeline/loop-ledger@1";

export type LoopEngineName = "claude" | "codex";

export type LoopItemState =
  | "pending"
  | "in_progress"
  | "blocked"
  | "abandoned"
  | "implemented"
  | "pr_opened"
  | "ready"
  | "merged"
  | "released"
  | "deployed"
  /** Durable, non-failure operator hold — see capability `durable-pause-and-authority`. */
  | "paused"
  /** Durable, non-failure hold carrying an outstanding {@link LoopHumanInputRequest} — see
   *  capability `durable-pause-and-authority`. */
  | "waiting"
  /** Terminal, dependency-propagated state — see capability
   *  `durable-run-dependency-integrity`. Reachable only from `pending` or `blocked`, and only
   *  via propagation (`propagateSkips`, loop/dependencies.ts) — never a caller-requested
   *  transition. Counts as terminal for run completion, exactly as `abandoned` does. */
  | "skipped";

export const LOOP_AUTHORITY_GATES = ["push_pr", "merge", "release", "deploy"] as const;

export type LoopAuthorityGate = (typeof LOOP_AUTHORITY_GATES)[number];

export function isLoopAuthorityGate(value: unknown): value is LoopAuthorityGate {
  return typeof value === "string" && (LOOP_AUTHORITY_GATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Durable paused/waiting holds & audited authority amendments (#510,
// capability `durable-pause-and-authority`). See loop/pause.ts.
// ---------------------------------------------------------------------------

export const LOOP_HUMAN_INPUT_REQUEST_KINDS = ["decision", "answer", "authority-grant"] as const;

export type LoopHumanInputRequestKind = (typeof LOOP_HUMAN_INPUT_REQUEST_KINDS)[number];

export function isLoopHumanInputRequestKind(value: unknown): value is LoopHumanInputRequestKind {
  return typeof value === "string" && (LOOP_HUMAN_INPUT_REQUEST_KINDS as readonly string[]).includes(value);
}

/** A precise human-input request attached to a `waiting` transition — the durable record a
 *  resume must satisfy. Persisted on the item so it survives a process restart. */
export interface LoopHumanInputRequest {
  request_id: string;
  item_id: string;
  kind: LoopHumanInputRequestKind;
  prompt: string;
  /** A closed set of permitted response values. When present, a resume's response value MUST
   *  be a member; when absent, any response value is accepted (subject to the request_id
   *  matching). Never an empty array — that is refused as validation at request-build time. */
  permitted_responses?: string[];
  requested_by_engine: LoopEngineName;
  requested_at: string;
}

/** A scoped, audited widening of exactly one authority gate, narrowed to exactly one item — a
 *  broad/un-scoped grant is refused. Recorded via the decision log (`appendDecision`); never
 *  widens any other gate or item. */
export interface LoopAuthorityAmendment {
  gate: LoopAuthorityGate;
  scope_item_id: string;
  actor: string;
  reason: string;
  time: string;
}

/** Evidence that the Pipeline preflight passed — the pipeline-mandate evidence a resume into
 *  `in_progress` must still satisfy, composed with (never bypassed by) the audited resume. */
export interface LoopPipelinePreflightEvidence {
  passed: boolean;
  checked_at: string;
}

/** The audited cross-engine handoff decision shape — the `data` payload recorded via
 *  `appendDecision` when a paused/waiting run is handed from one engine to the other. */
export interface LoopHandoff {
  from_engine: LoopEngineName;
  to_engine: LoopEngineName;
  reason: string;
  time: string;
}

export interface LoopRecoveryBudgets {
  default: number;
  [theme: string]: number;
}

// ---------------------------------------------------------------------------
// Typed durable-run blocker classification & recovery policy (#509).
//
// The recorded `blocked_theme` (LoopHistoryEntry.theme / LoopItemLedgerEntry
// .blocked_theme) is redefined to be exactly one of these class names — see
// openspec/changes/durable-run-blocker-classification/design.md decision
// "Blocker class is the budget key; theme becomes the class name". A theme
// string outside this set is no longer a legal blocked_theme.
// ---------------------------------------------------------------------------

export const DURABLE_BLOCKER_CLASSES = [
  "transient-rate-limit",
  "workflow-state",
  "implementation-ci",
  "environment-auth",
  "specification-decision",
  "missing-authority",
  "upstream-dependency",
  "workflow-engine-defect",
] as const;

export type DurableBlockerClass = (typeof DURABLE_BLOCKER_CLASSES)[number];

export function isDurableBlockerClass(value: unknown): value is DurableBlockerClass {
  return typeof value === "string" && (DURABLE_BLOCKER_CLASSES as readonly string[]).includes(value);
}

/** A recovery recipe never performs a merge, release, credential, or deploy
 *  action (#509 acceptance criterion) — this is the closed catalogue every
 *  policy entry's `recipes` must draw from. */
export const RECOVERY_RECIPES = [
  "wait_and_retry",
  "reauthenticate",
  "rerun_ci",
  "resync_workflow_state",
  "retry_upstream_check",
  "restart_workflow_engine",
] as const;

export type RecoveryRecipe = (typeof RECOVERY_RECIPES)[number];

export function isRecoveryRecipe(value: unknown): value is RecoveryRecipe {
  return typeof value === "string" && (RECOVERY_RECIPES as readonly string[]).includes(value);
}

/** `human_authority` classes never retry automatically — see the
 *  `missing-authority` / `specification-decision` requirement. */
export type RecoveryTerminalOutcome = "retry" | "human_authority";

export interface RecoveryBackoff {
  initial_seconds: number;
  multiplier: number;
  max_seconds: number;
}

export interface RecoveryPolicyEntry {
  recipes: RecoveryRecipe[];
  retry_budget: number;
  backoff: RecoveryBackoff;
  terminal_outcome: RecoveryTerminalOutcome;
  /** When true, this class's block stops the whole run rather than allowing
   *  dependency-independent items to continue. */
  run_fatal: boolean;
  /** Consecutive identical-evidence-fingerprint repeats permitted on the same
   *  item before the run stops terminally for repeated no-progress. */
  repeated_evidence_limit: number;
}

/** A machine-readable, validated recovery policy covering every
 *  {@link DurableBlockerClass} — compiled into {@link LoopContract} at init.
 *  Never partially populated: {@link compileRecoveryPolicy} (loop/recovery.ts)
 *  refuses a policy missing any class as a validation failure. */
export type RecoveryPolicy = Record<DurableBlockerClass, RecoveryPolicyEntry>;

/** The outcome of one recovery attempt on a blocked item. `failed` records a
 *  recovery action that was actually attempted but did not succeed — the item
 *  stays `blocked` and no budget is charged (#509 review round 2 finding
 *  2794f4b6: a caller-reported failure must never be persisted as a
 *  successful resume). */
export type RecoveryAttemptOutcome =
  | "recovered"
  | "exhausted"
  | "repeated_no_progress"
  | "needs_human"
  | "human_authority"
  | "failed";

/** A single persisted recovery attempt — the ledger.recovery_attempts entry
 *  the durable-blocker-classification capability requires to survive a
 *  resume (#509 requirement "Classification, actions, evidence, and outcome
 *  SHALL be persisted and emitted"). */
export interface LoopRecoveryAttempt {
  seq: number;
  time: string;
  item_id: string;
  class: DurableBlockerClass;
  actions: RecoveryRecipe[];
  evidence_fingerprint: string;
  outcome: RecoveryAttemptOutcome;
}

// ---------------------------------------------------------------------------
// Durable-run ownership + conflict declarations (#529, capability
// `durable-run-ownership-conflicts`). A pure planning-input model: what
// surfaces an item owns, and which surfaces conflict by default. See
// loop/ownership.ts and openspec/changes/durable-run-ownership-conflicts/
// design.md for the normalization and evaluation semantics this implements.
// ---------------------------------------------------------------------------

/** The closed catalogue of shared-by-default surface classes — a shared surface has no disjoint
 *  sub-region, so two items that own the *same* one conflict unless a reviewed exception names
 *  it (design.md "Two surface classes, one asymmetry"). */
export const OWNERSHIP_SHARED_SURFACE_KINDS = [
  "schema_state",
  "generated_artifact",
  "shared_config",
  "public_api",
  "ci_workflow",
  "package_version",
] as const;

export type OwnershipSharedSurfaceKind = (typeof OWNERSHIP_SHARED_SURFACE_KINDS)[number];

export function isOwnershipSharedSurfaceKind(value: unknown): value is OwnershipSharedSurfaceKind {
  return typeof value === "string" && (OWNERSHIP_SHARED_SURFACE_KINDS as readonly string[]).includes(value);
}

/** The kind of a normalized surface entry: `"source"` for an exclusive-ownership path/module
 *  glob, or one of the shared-by-default classes. */
export type OwnershipSurfaceKind = "source" | OwnershipSharedSurfaceKind;

/** A reviewed exception suppressing the auto-derived shared-surface conflict it names, for the
 *  pair it is declared on — nothing else (design.md "Reviewed exceptions suppress only
 *  auto-derived shared conflicts"). Never suppresses an explicit {@link OwnershipDeclaration.conflicts_with}
 *  edge or an unknown-ownership conflict. */
export interface OwnershipException {
  surface: { kind: OwnershipSharedSurfaceKind; pattern: string };
  /** The other item id this exception is reviewed for — the exception suppresses a shared-surface
   *  conflict only for the pair naming this counterpart, never for the declaring item's surface
   *  against any other item. */
  counterpart_item_id: string;
  justification: string;
  review_ref: string;
}

/** A per-item ownership + conflict declaration — additive and optional on {@link LoopContractItem}.
 *  Absent or empty (no `exclusive`/`shared` surfaces declared) denotes **unknown ownership**,
 *  which evaluates as a conflict against every other item (never `disjoint`), the conservative
 *  default required by capability `durable-run-ownership-conflicts`. */
export interface OwnershipDeclaration {
  /** Exclusive-ownership source path/module globs — conflict with another item's exclusive
   *  globs only when they overlap. */
  exclusive?: string[];
  /** Shared-by-default surfaces, keyed by class — conflict with another item that owns the
   *  identical pattern under the same class, unless a valid {@link OwnershipException} applies. */
  shared?: Partial<Record<OwnershipSharedSurfaceKind, string[]>>;
  /** Explicit manual conflict edges naming other item ids — always conflict, never
   *  suppressible by any exception. */
  conflicts_with?: string[];
  /** Reviewed exceptions suppressing specific auto-derived shared-surface conflicts. */
  exceptions?: OwnershipException[];
}

/** One canonicalized entry in an item's normalized surface set — the unit of comparison for
 *  pairwise evaluation and the artifact recorded as planning evidence. */
export interface NormalizedOwnershipSurface {
  kind: OwnershipSurfaceKind;
  pattern: string;
  class: "exclusive" | "shared";
}

/** The structured cause of a `conflict` verdict — exactly one of an overlapping surface (naming
 *  it), an explicit `conflicts_with` edge, or unknown ownership. */
export type OwnershipConflictReason =
  | { kind: "overlapping_surface"; surface: NormalizedOwnershipSurface }
  | { kind: "explicit_edge" }
  | { kind: "unknown_ownership"; detail: string };

/** The typed outcome of a pairwise ownership evaluation — `reason` is `null` iff `verdict ===
 *  "disjoint"`. */
export interface OwnershipConflictVerdict {
  verdict: "disjoint" | "conflict";
  reason: OwnershipConflictReason | null;
}

/** One item's contribution to durable planning evidence — its normalized surface set. */
export interface OwnershipEvidenceItem {
  item_id: string;
  surfaces: NormalizedOwnershipSurface[];
}

/** One evaluated pair's contribution to durable planning evidence. */
export interface OwnershipEvidencePair {
  a_item_id: string;
  b_item_id: string;
  verdict: "disjoint" | "conflict";
  reason: OwnershipConflictReason | null;
}

/** The durable planning-evidence record for one ownership evaluation pass — a record only; it
 *  schedules nothing and grants no merge or review bypass (design.md "Planning-input-only
 *  guarantee"). */
export interface OwnershipEvaluationEvidence {
  items: OwnershipEvidenceItem[];
  pairs: OwnershipEvidencePair[];
}

export interface LoopContractItem {
  id: string;
  /** In-snapshot dependency ids only — order-constraining and cycle-checked. An id declared by
   *  the source input but not present in the snapshot is partitioned into
   *  {@link LoopContractItem.external_depends_on} instead (capability
   *  `durable-run-dependency-integrity`), never dropped. */
  depends_on: string[];
  /** Out-of-snapshot dependency ids — prerequisite work the run cannot itself schedule.
   *  Preserved but never order-constraining and never part of cycle detection; verified against
   *  live truth before a dependent item may start (capability `durable-run-dependency-integrity`,
   *  see loop/dependencies.ts). Empty for a contract compiled with no external dependencies. */
  external_depends_on: string[];
  /** Optional ownership + conflict declaration (capability `durable-run-ownership-conflicts`).
   *  Absent/empty ⇒ unknown ownership ⇒ conflict with every other item — see
   *  {@link OwnershipDeclaration}. A planning input only; never schedules, merges, or bypasses
   *  review. */
  ownership?: OwnershipDeclaration;
}

export interface LoopContract {
  readonly schema: typeof LOOP_CONTRACT_SCHEMA;
  run_id: string;
  engine: LoopEngineName;
  repo: {
    name: string;
    base_branch: string;
  };
  selector: unknown;
  objective: string;
  worktree_policy: string;
  done_definition: "pipeline:ready-to-deploy";
  authority_grants: LoopAuthorityGate[];
  recovery_budgets: LoopRecoveryBudgets;
  /** Compiled at init by `compileRecoveryPolicy` (loop/recovery.ts); covers
   *  every {@link DurableBlockerClass}. */
  recovery_policy: RecoveryPolicy;
  consecutive_blocked_limit: number;
  verification: unknown;
  report_format: string;
  /** Fixed orchestration invariants — never caller-settable (design.md decision). */
  ordering: "dependency_sequential";
  max_active_items: 1;
  concurrency_model: "exclusive_lock_single_engine";
  items: LoopContractItem[];
  canonical_hash: string;
  /** The run-level cycle watchdog bound (#512, capability
   *  `durable-loop-supervisor`) — consecutive no-progress cycles permitted
   *  before the supervisor stops the run with `supervisor_no_progress`.
   *  Optional so a pre-#512 contract resumes; see
   *  `DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT` (loop/supervisor.ts) for the
   *  default applied when absent. */
  consecutive_no_progress_limit?: number;
  /** Present only when this contract was produced by importing a legacy
   *  goal-loop run — names the schema id the run originated from. Absent for
   *  natively-compiled contracts. */
  imported_from_schema?: string;
  /** Present only when this run was created via `pipeline loop --new-run` to supersede a
   *  terminally-stopped canonical run for the same selector (#568, capability
   *  `loop-run-supersession`) — names the retired run id. Absent for every other run. */
  supersedes?: string;
  /** Additive, optional run policy governing the scheduler's concurrency budget (#530, capability
   *  `durable-run-independent-scheduler`). Absent, or `max_concurrent: 1`, keeps the run's
   *  observable behavior identical to the pre-#530 serialized single-active-item invariant —
   *  concurrency above one is admitted only when {@link selectSchedulableSet} (loop/schedule.ts)
   *  can additionally prove the extra items independent. */
  concurrency?: LoopConcurrencyPolicy;
}

// ---------------------------------------------------------------------------
// Durable-run independent-set scheduler (#530, capability
// `durable-run-independent-scheduler`). Consumes dependency (loop/dependencies.ts), ownership
// (loop/ownership.ts), reconciliation drift, and merge-barrier state to select a
// concurrency-bounded, provably-independent set of items — see loop/schedule.ts and
// openspec/changes/durable-run-independent-scheduler/design.md.
// ---------------------------------------------------------------------------

export interface LoopConcurrencyPolicy {
  /** A positive-integer concurrency budget. `1` (or the field's absence) is fully serialized —
   *  identical to today's single-active-item behavior. */
  max_concurrent: number;
}

/** The closed set of scheduling dispositions — every eligible candidate is recorded as exactly
 *  one of these (design.md Decision 3's fixed reason precedence). */
export const SCHEDULE_DISPOSITIONS = [
  "admitted",
  "dependency_path",
  "conflict_edge",
  "unknown_ownership",
  "merge_barrier",
  "unresolved_drift",
  "budget_truncation",
] as const;

export type ScheduleDisposition = (typeof SCHEDULE_DISPOSITIONS)[number];

export function isScheduleDisposition(value: unknown): value is ScheduleDisposition {
  return typeof value === "string" && (SCHEDULE_DISPOSITIONS as readonly string[]).includes(value);
}

/** One eligible candidate's recorded scheduling rationale — exactly one structured disposition.
 *  `counterpart_item_id` names the other item the disposition was decided against, when the
 *  disposition is inherently pairwise (`dependency_path`, `conflict_edge`, `unknown_ownership`);
 *  absent for `admitted`, `merge_barrier`, `unresolved_drift`, and `budget_truncation`, which carry
 *  no counterpart. `detail` is an optional human-readable elaboration (e.g. the overlapping
 *  surface). */
export interface ScheduleRationale {
  item_id: string;
  disposition: ScheduleDisposition;
  counterpart_item_id?: string;
  detail?: string;
}

/** The scheduler's deterministic output for one planning pass — a pure decision that itself
 *  starts, merges, or serializes nothing (design.md Goals). `selected` is ordered by the same
 *  documented total order the rationale entries are evaluated in. */
export interface ScheduleDecision {
  selected: string[];
  rationale: ScheduleRationale[];
}

// ---------------------------------------------------------------------------
// Run-scoped parallelization decision ledger (#528, capability
// `conflict-aware-parallel-execution`). A pure accumulation of the
// independent-set scheduler's already-emitted per-pass `loop_schedule_evaluated`
// planning records into one durable, run-lifetime, per-pair view — see
// loop/parallelization-ledger.ts and
// openspec/changes/conflict-aware-parallel-execution/design.md. It re-decides
// nothing and adds no external write path.
// ---------------------------------------------------------------------------

export const LOOP_PARALLELIZATION_DISPOSITIONS = ["parallelized", "serialized"] as const;

export type LoopParallelizationDisposition = (typeof LOOP_PARALLELIZATION_DISPOSITIONS)[number];

export function isLoopParallelizationDisposition(value: unknown): value is LoopParallelizationDisposition {
  return typeof value === "string" && (LOOP_PARALLELIZATION_DISPOSITIONS as readonly string[]).includes(value);
}

/** One run-scoped ledger entry — an unordered item pair (`a_item_id` < `b_item_id`,
 *  lexically sorted, so a pair's ordering is deterministic regardless of which item's rationale
 *  named the other), its disposition, and exactly one reason drawn from the scheduler's own
 *  closed {@link ScheduleDisposition} set — no new reason vocabulary (design.md "A run-scoped
 *  ledger that accumulates, not a second decision path"). */
export interface LoopParallelizationLedgerEntry {
  a_item_id: string;
  b_item_id: string;
  disposition: LoopParallelizationDisposition;
  reason: ScheduleDisposition;
  /** The scheduler rationale's optional `detail` carried through verbatim (e.g. the conflicting
   *  surface, `"shared_config:release.yml"`) — preserves the auditable detail behind `reason`
   *  instead of collapsing it to the bare disposition. */
  detail?: string;
}

/** The durable replan-request record for changed-file-overlap parking (design.md Decision 5) — an
 *  audit/hold artifact only; producing it never merges, pushes, or deletes a branch/worktree. */
export interface LoopReplanRequest {
  time: string;
  affected_item_ids: string[];
  overlapping_paths: string[];
  reason: string;
}

export interface LoopHistoryEntry {
  time: string;
  from: LoopItemState;
  to: LoopItemState;
  engine: LoopEngineName;
  theme?: string;
  evidence?: string;
  note?: string;
}

export interface LoopItemLedgerEntry {
  id: string;
  state: LoopItemState;
  history: LoopHistoryEntry[];
  /** The item's current {@link DurableBlockerClass} name when `state ===
   *  "blocked"` — this is also the key into `recovery_budgets_remaining`. */
  blocked_theme?: string;
  recovery_budgets_remaining: LoopRecoveryBudgets;
  /** The pure fingerprint (`fingerprintEvidence`, loop/recovery.ts) of the
   *  most recent blocked evidence recorded for this item. */
  evidence_fingerprint?: string;
  /** Consecutive prior blocks whose fingerprint equals `evidence_fingerprint`
   *  — 0 on first occurrence, reset to 0 whenever the fingerprint changes. */
  repeated_evidence_count?: number;
  /** Present only while `state === "waiting"` — the outstanding human-input request a resume
   *  must satisfy. Cleared on a successful resume or abandon. */
  hold_request?: LoopHumanInputRequest;
  /** The most recent {@link LoopExternalIdentity} verified to actually support this item's
   *  current state — set on a proven remote-proving transition and refreshed on every aligned
   *  or repaired-forward reconciliation pass. The anchor a later reconciliation compares a fresh
   *  observation against to detect `identity-mismatch` drift (e.g. the bound PR/head SHA changed
   *  out from under an already-proven state). Absent for an item that has never been verified. */
  last_verified_identity?: LoopExternalIdentity;
}

export interface LoopMergeBarrier {
  item_id: string;
  merged_sha: string;
  set_at: string;
}

export interface LoopStopRecord {
  reason:
    | "recovery_exhausted"
    | "consecutive_blocked"
    | "needs_human_classification"
    | "repeated_no_progress"
    | "human_authority"
    /** A block whose class's policy is `run_fatal` — the run stops
     *  immediately at block time (#509 review round 2 finding 6ced9fe0), even
     *  for a retry-capable class, since a run-fatal class's whole point is
     *  that the run cannot safely continue automatically. */
    | "run_fatal"
    /** The run-level cycle watchdog (#512, capability `durable-loop-supervisor`)
     *  stopped the run after `consecutive_no_progress_limit` cycles produced
     *  no durable delta — distinct from the item-level `repeated_no_progress`
     *  bound above; see loop/supervisor.ts. */
    | "supervisor_no_progress"
    /** The absolute cycle safety backstop (`MAX_CYCLES_SAFETY`, #512 review
     *  round 2) was exhausted while every cycle still reported progress — a
     *  durable terminal stop so a run can never fall through the cap silently
     *  nonterminal and unheld; see loop/supervisor.ts. */
    | "supervisor_cycle_cap"
    /** The run's frontier is structurally unrunnable: no item is `in_progress`, none is
     *  eligible to start, and at least one non-terminal item remains gated on a pending or
     *  unsatisfiable dependency — reported instead of spinning into `supervisor_no_progress`
     *  (capability `durable-run-dependency-integrity`, see loop/dependencies.ts). */
    | "dependency_deadlock";
  time: string;
  item_id?: string;
  theme?: string;
  limit?: number;
  /** Set when `reason === "repeated_no_progress"` — the evidence fingerprint
   *  that repeated past the class's `repeated_evidence_limit`. */
  fingerprint?: string;
  /** Set when `reason === "dependency_deadlock"` — for each stuck item, the dependency (in-run
   *  or external) it waits on and that dependency's observed state. */
  deadlock_chain?: LoopDeadlockChainEntry[];
  /** Every item id in the `ready` state (`pipeline:ready-to-deploy`, awaiting the human merge
   *  the pipeline never performs) at the moment this stop was recorded — capability
   *  `loop-needs-human-blocker-disposition`. Additive disclosure only: it never alters the stop
   *  `reason` or which items are considered done. Always present (empty when no item is
   *  `ready`) on a stop recorded after this capability landed; see
   *  {@link outstandingReadyItemIds}. */
  outstanding_ready: string[];
}

/** Pure projection of every `ready` item id in `ledger` — the disclosure a terminal stop
 *  carries via {@link LoopStopRecord.outstanding_ready} (capability
 *  `loop-needs-human-blocker-disposition`) so an operator is never left unaware that a
 *  ready-to-deploy PR is stranded when a run stops. Sorted for a deterministic stop record. */
export function outstandingReadyItemIds(ledger: LoopLedger): string[] {
  return Object.values(ledger.items)
    .filter((item) => item.state === "ready")
    .map((item) => item.id)
    .sort();
}

/** One stuck item's entry in a {@link LoopStopRecord.deadlock_chain} — capability
 *  `durable-run-dependency-integrity`. */
export interface LoopDeadlockChainEntry {
  item_id: string;
  waiting_on: string;
  kind: "in_run" | "external";
  observed_state: string;
}

/** The three-valued classification of an external dependency's live-observed satisfaction —
 *  capability `durable-run-dependency-integrity`. Never resolved from a caller claim; see
 *  `externalDependencyStatus` (loop/dependencies.ts). */
export type ExternalDependencyStatus = "satisfied" | "unsatisfiable" | "pending";

export interface LoopNativeGoalCheck {
  engine: LoopEngineName;
  run_id: string;
  status: string;
  checked_at: string;
}

// ---------------------------------------------------------------------------
// Verified live reconciliation (#511, capability `durable-run-reconciliation`).
// Structured external identities, typed drift classification, and the closed
// next-action set — see core/scripts/loop/reconcile.ts and
// openspec/changes/durable-run-reconciliation/design.md.
// ---------------------------------------------------------------------------

/** A structured binding of one item to the concrete live external objects
 *  that can prove its state — replaces the free-form `observed: unknown`
 *  reconciliation used to carry. Produced only by an engine-owned live
 *  observation seam (see `ReconcileObserveDeps`), never by a caller claim. */
export interface LoopExternalIdentity {
  issue_number: number;
  issue_open: boolean;
  ready_label_present: boolean;
  pr_number: number | null;
  pr_state: "open" | "closed" | "merged" | null;
  head_branch: string;
  head_sha: string;
  merge_commit_sha: string | null;
  checks_conclusion: "success" | "failure" | "pending" | "none";
  /** The issue's current `pipeline:*` stage label, minus the prefix (e.g. `"backlog"`,
   *  `"ready"`, `"review-1"`) — `null` when the issue carries no `pipeline:*` label at all.
   *  Feeds the precondition stage gate (#568, capability `loop-precondition-stage-gate`); see
   *  loop/precondition.ts. When more than one `pipeline:*` label is present (not expected in
   *  normal operation), the first one observed is recorded. */
  pipeline_stage: string | null;
  observed_at: string;
}

export const LOOP_DRIFT_CLASSES = [
  "ledger-behind",
  "ledger-ahead",
  "external-absent",
  "identity-mismatch",
  "checks-regressed",
] as const;

export type LoopDriftClass = (typeof LOOP_DRIFT_CLASSES)[number];

export function isLoopDriftClass(value: unknown): value is LoopDriftClass {
  return typeof value === "string" && (LOOP_DRIFT_CLASSES as readonly string[]).includes(value);
}

export const LOOP_NEXT_ACTIONS = [
  "advance",
  "await-checks",
  "repair-forward",
  "clear-merge-barrier",
  "hold-for-human",
  "noop",
] as const;

export type LoopNextAction = (typeof LOOP_NEXT_ACTIONS)[number];

export function isLoopNextAction(value: unknown): value is LoopNextAction {
  return typeof value === "string" && (LOOP_NEXT_ACTIONS as readonly string[]).includes(value);
}

/** One item's drift record — always carries exactly one {@link LoopDriftClass};
 *  there is deliberately no way to construct a drift record without a valid
 *  class (see `isLoopDriftClass` / `classifyDrift` in reconcile.ts). */
export interface LoopDrift {
  item_id: string;
  ledger_state: LoopItemState;
  observed_state: string;
  class: LoopDriftClass;
}

// ---------------------------------------------------------------------------
// Precondition stage gate (#568, capability `loop-precondition-stage-gate`).
// See loop/precondition.ts.
// ---------------------------------------------------------------------------

/** A durable, non-fatal record excluding one work-list item from the executable frontier this
 *  cycle because it has not yet reached the `pipeline:ready` precondition — still carrying
 *  `pipeline:backlog`, or no `pipeline:*` label at all. Never a `blocked` transition, never
 *  counted toward recovery budget, never a run stop. Re-evaluated against live truth every
 *  reconciliation pass — see {@link classifyPreconditionExclusions} in loop/precondition.ts. */
export interface LoopPreconditionExclusion {
  item_id: string;
  /** The pipeline stage label required for admission — always `"pipeline:ready"`. */
  required_stage: string;
  /** The observed pre-pipeline stage label, or `"none"` when the item carries no `pipeline:*`
   *  label at all. */
  observed_stage: string;
}

export interface LoopReconciliation {
  sequence: number;
  time: string;
  /** Every item's verified live identity as of this reconciliation pass. */
  observed: Record<string, LoopExternalIdentity>;
  drift: LoopDrift[];
  /** Every active item's deterministically computed next action. */
  next_actions: Record<string, LoopNextAction>;
}

export interface LoopLedger {
  readonly schema: typeof LOOP_LEDGER_SCHEMA;
  run_id: string;
  items: Record<string, LoopItemLedgerEntry>;
  consecutive_blocked: number;
  merge_barrier: LoopMergeBarrier | null;
  stop: LoopStopRecord | null;
  last_native_goal_check: LoopNativeGoalCheck | null;
  last_reconciliation: LoopReconciliation | null;
  reconciliation_sequence: number;
  /** Append-only record of every recovery attempt across every item in this
   *  run — persisted here (not just in the events log) so a resuming engine
   *  can read per-item recovery history directly off the ledger. */
  recovery_attempts: LoopRecoveryAttempt[];
  /** Every audited scoped authority amendment recorded on this run — durable so a later gated
   *  transition (on this or a resumed process) can check it. A pre-#510 ledger has no such
   *  field; see {@link upgradeLedgerForPauseAuthority} in loop/pause.ts. */
  authority_amendments: LoopAuthorityAmendment[];
  /** Present only once this terminally-stopped run has been superseded via `pipeline loop
   *  --new-run` (#568, capability `loop-run-supersession`) — names the fresh run that replaced
   *  it. Set by a narrow, token-free administrative write ({@link markRunSuperseded},
   *  loop/store.ts) since a terminally-stopped run holds no lock. Absent otherwise. */
  superseded_by?: string;
}

export interface LoopLockRecord {
  engine: LoopEngineName;
  pid: number;
  hostname: string;
  acquired_at: string;
  token: string;
  run_id: string;
}

export interface LoopEvent {
  seq: number;
  time: string;
  kind: string;
  data: unknown;
}

export interface LoopDecision {
  seq: number;
  time: string;
  kind: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Failure taxonomy — every engine refusal is exactly one of these classes.
// ---------------------------------------------------------------------------

export type LoopFailureClass =
  | "validation"
  | "lock"
  | "authority"
  | "stop"
  | "conflict"
  | "pipeline_mandate"
  | "native_goal_mandate";

export class LoopError extends Error {
  readonly loopFailureClass: LoopFailureClass;
  constructor(loopFailureClass: LoopFailureClass, message: string) {
    super(message);
    this.loopFailureClass = loopFailureClass;
    this.name = "LoopError";
  }
}

// ---------------------------------------------------------------------------
// Durable loop supervisor (#512, capability `durable-loop-supervisor`) —
// process identity + heartbeat and the append-only action-evidence trail. See
// loop/supervisor.ts and openspec/changes/in-repo-loop-supervisor/design.md.
// ---------------------------------------------------------------------------

/** A durable process-identity record — distinct from {@link LoopLockRecord}
 *  (design.md decision 1): the lock answers "who may write"; this record
 *  answers "who is driving right now and is it still alive and progressing."
 *  Written at attach and refreshed every cycle through the store's injected
 *  seam. */
export interface LoopSupervisorProcess {
  run_id: string;
  engine: LoopEngineName;
  pid: number;
  hostname: string;
  /** A per-boot identifier, distinguishing successive processes that might
   *  reuse the same pid across restarts. */
  boot_id: string;
  started_at: string;
  heartbeat_at: string;
  /** The lock token this process currently holds. */
  token: string;
  /** The run-level watchdog's current consecutive-no-progress count — reset
   *  to 0 on any progress cycle (design.md decision 2/3). */
  consecutive_no_progress: number;
}

export const LOOP_SUPERVISOR_ACTIONS = [
  "reconcile",
  "start_item",
  "dispatch_item",
  "block_item",
  "abandon_item",
  "resume",
  "stop",
  "noop",
  /** A pending item was excluded from the executable frontier this cycle because it has not yet
   *  reached the `pipeline:ready` precondition (#568, capability `loop-precondition-stage-gate`)
   *  — never a `blocked` transition, never run-fatal. See loop/precondition.ts. */
  "exclude_item",
] as const;

export type LoopSupervisorAction = (typeof LOOP_SUPERVISOR_ACTIONS)[number];

export function isLoopSupervisorAction(value: unknown): value is LoopSupervisorAction {
  return typeof value === "string" && (LOOP_SUPERVISOR_ACTIONS as readonly string[]).includes(value);
}

/** One append-only action-evidence entry (design.md decision 3) — a durable
 *  record of exactly what the supervisor decided and did on one cycle, so a
 *  resuming process or an auditor can reconstruct the run's history. */
export interface LoopActionEvidence {
  seq: number;
  time: string;
  item_id: string | null;
  action: LoopSupervisorAction;
  outcome: string;
  next_action: LoopNextAction | null;
  progress: "progress" | "no_progress";
  /** The managed worktree root a `dispatch_item` action ran in, when the dispatch response
   *  reported one (`pipeline/loop-execution@1`'s `LoopEvidencePointer.worktree_root`). Absent
   *  for every other action. */
  worktree_root?: string | null;
}
