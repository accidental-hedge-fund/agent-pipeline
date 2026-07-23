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
  | "waiting";

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

export interface LoopContractItem {
  id: string;
  depends_on: string[];
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
  /** Present only when this contract was produced by importing a legacy
   *  goal-loop run — names the schema id the run originated from. Absent for
   *  natively-compiled contracts. */
  imported_from_schema?: string;
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
    | "run_fatal";
  time: string;
  item_id?: string;
  theme?: string;
  limit?: number;
  /** Set when `reason === "repeated_no_progress"` — the evidence fingerprint
   *  that repeated past the class's `repeated_evidence_limit`. */
  fingerprint?: string;
}

export interface LoopNativeGoalCheck {
  engine: LoopEngineName;
  run_id: string;
  status: string;
  checked_at: string;
}

export interface LoopReconciliation {
  sequence: number;
  time: string;
  observed: unknown;
  drift: Array<{ item_id: string; ledger_state: LoopItemState; observed_state: string }>;
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
