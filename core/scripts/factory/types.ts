// Factory macro-controller types (#890, capability `factory-macro-controller`).
//
// Immutable execution-contract revisions, coarse factory phases, control
// identities, and coarse-action claims. The macro-controller owns coarse phase
// and next action only; item stage transitions remain with loop/advance.

export const FACTORY_CONTRACT_SCHEMA = "pipeline/factory-execution-contract@1";
export const FACTORY_CLAIM_SCHEMA = "pipeline/factory-action-claim@1";
export const FACTORY_CURRENT_SCHEMA = "pipeline/factory-current@1";
export const FACTORY_LOCK_SCHEMA = "pipeline/factory-lock@1";
export const FACTORY_PHASE_EVIDENCE_SCHEMA = "pipeline/factory-phase-evidence@1";

/** Service controller identity for this implementation revision. */
export const FACTORY_SERVICE_CONTROLLER_ID = "factory-macro@1";

/** Host-local factory lock path: /tmp/pipeline-factory-{domain}-{runId}.lock */
export function factoryRunLockPath(domain: string, factoryRunId: string): string {
  if (!domain || typeof domain !== "string") {
    throw new Error("factoryRunLockPath: domain must be a non-empty string");
  }
  if (!factoryRunId || typeof factoryRunId !== "string") {
    throw new Error("factoryRunLockPath: factoryRunId must be a non-empty string");
  }
  return `/tmp/pipeline-factory-${domain}-${factoryRunId}.lock`;
}

// ---------------------------------------------------------------------------
// Coarse phases + next actions (closed enums)
// ---------------------------------------------------------------------------

export const FACTORY_COARSE_PHASES = [
  "intake",
  "adopted",
  "executing",
  "items_complete",
  "merge_prepare",
  "release_prepare",
  "engine_observe",
  "factory_complete",
  "factory_stopped",
] as const;

export type FactoryCoarsePhase = (typeof FACTORY_COARSE_PHASES)[number];

export function isFactoryCoarsePhase(v: unknown): v is FactoryCoarsePhase {
  return typeof v === "string" && (FACTORY_COARSE_PHASES as readonly string[]).includes(v);
}

export const FACTORY_NEXT_ACTIONS = [
  "await_adoption",
  "start_loop",
  "resume_loop",
  "observe_loop",
  "start_advance",
  "resume_advance",
  "observe_advance",
  "operator_merge",
  "operator_release",
  "observe_engine_pin",
  "replan_required",
  "factory_idle",
  "none",
] as const;

export type FactoryNextAction = (typeof FACTORY_NEXT_ACTIONS)[number];

export function isFactoryNextAction(v: unknown): v is FactoryNextAction {
  return typeof v === "string" && (FACTORY_NEXT_ACTIONS as readonly string[]).includes(v);
}

export const FACTORY_COMPLETION_POLICIES = [
  "all_items_ready_to_deploy",
  "all_items_terminal",
  "operator_stop",
] as const;

export type FactoryCompletionPolicy = (typeof FACTORY_COMPLETION_POLICIES)[number];

// ---------------------------------------------------------------------------
// Control identities (five distinct slots)
// ---------------------------------------------------------------------------

/**
 * Five-way identity model. Fields are independent: outer host ≠ service
 * controller ≠ stage treatments ≠ privileged mutation actor. Validators refuse
 * missing slots (when factory mode is enabled) and silent remaps (including
 * recording a non-Claude controller as Codex).
 */
export interface FactoryControlIdentities {
  /** Macro-controller implementation id (e.g. factory-macro@1) — never a stage adapter. */
  service_controller: string;
  /** Session host from outer-host registry (#784). */
  outer_host: string;
  /** Implementer treatment / stage adapter id. */
  implementer_treatment: string;
  /** Reviewer treatment / stage adapter id. */
  reviewer_treatment: string;
  /** Operator-bound actor for privileged mutations. */
  privileged_mutation_actor: string;
}

// ---------------------------------------------------------------------------
// Execution-contract revision (immutable accepted body)
// ---------------------------------------------------------------------------

export interface FactoryRepoIdentity {
  name: string;
  base_branch: string;
  /** Observed base SHA at adoption/replan (live truth). */
  observed_base_sha: string;
}

export interface FactorySelector {
  type: "milestone" | "label" | "range" | "issues" | "explicit";
  value: string;
}

export interface FactoryDependencyEdge {
  from: string;
  to: string;
}

export interface FactoryLinkedRuns {
  /** Native durable loop run id under the loop store (sole item-ledger authority). */
  loop_run_id?: string | null;
  /** Loop contract canonical hash when known. */
  loop_contract_hash?: string | null;
  /** Optional whole-issue advance run id (single-item factory runs). */
  advance_run_id?: string | null;
  /**
   * Legacy/import mapping only — read/map. NEVER a second write authority for
   * item ledger transitions.
   */
  legacy_run_identity?: string | null;
}

export interface FactoryFingerprints {
  authority_policy: string;
  engine_pin: string;
  configuration: string;
  treatment: string;
}

/**
 * Hashed body fields — every accepted revision's canonical hash is computed
 * over these (plus schema, revision number, and prior link). Pointer metadata
 * outside this document is not part of the hash.
 */
export interface FactoryExecutionContractBody {
  readonly schema: typeof FACTORY_CONTRACT_SCHEMA;
  factory_run_id: string;
  revision: number;
  repo: FactoryRepoIdentity;
  selector: FactorySelector;
  issue_ids: string[];
  pr_ids: string[];
  milestones: string[];
  dependency_edges: FactoryDependencyEdge[];
  linked_runs: FactoryLinkedRuns;
  identities: FactoryControlIdentities;
  fingerprints: FactoryFingerprints;
  coarse_phase: FactoryCoarsePhase;
  completion_policy: FactoryCompletionPolicy;
  next_action: FactoryNextAction;
  /** Prior accepted revision number when this is a replan; null for first adopt. */
  prior_revision: number | null;
  prior_canonical_hash: string | null;
  /** Required on replan; optional on first adopt. */
  live_state_reason: string | null;
  accepted_at: string;
}

export interface FactoryExecutionContractRevision extends FactoryExecutionContractBody {
  /** sha256 hex of the canonical hashed body. */
  canonical_hash: string;
}

export interface FactoryCurrentPointer {
  readonly schema: typeof FACTORY_CURRENT_SCHEMA;
  factory_run_id: string;
  revision: number;
  canonical_hash: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Coarse-action claims
// ---------------------------------------------------------------------------

export const FACTORY_CLAIM_STATES = [
  "claimed",
  "started",
  "completed",
  "failed",
  "ambiguous_reconcile",
] as const;

export type FactoryClaimState = (typeof FACTORY_CLAIM_STATES)[number];

export interface FactoryActionClaim {
  readonly schema: typeof FACTORY_CLAIM_SCHEMA;
  factory_run_id: string;
  revision: number;
  action_id: string;
  action: FactoryNextAction;
  state: FactoryClaimState;
  service_controller: string;
  claimed_at: string;
  updated_at: string;
  /** Child loop/advance run id when the claim dispatched a whole-run child. */
  child_run_id?: string | null;
  outcome_detail?: string | null;
  /** Terminal evidence attribution. */
  completed_at?: string | null;
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export interface FactoryLockRecord {
  readonly schema: typeof FACTORY_LOCK_SCHEMA;
  factory_run_id: string;
  token: string;
  holder_pid: number;
  hostname: string;
  acquired_at: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FactoryErrorKind =
  | "validation"
  | "conflict"
  | "lock"
  | "not_found"
  | "disabled"
  | "identity";

export class FactoryError extends Error {
  readonly kind: FactoryErrorKind;
  constructor(kind: FactoryErrorKind, message: string) {
    super(message);
    this.name = "FactoryError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Phase evidence (durable, reconstructible for read-only status)
// ---------------------------------------------------------------------------

/**
 * Last reconciled coarse phase / next action for a factory run, written by
 * tick after derivation (including child completion dispositions and replan
 * posture). Read-only status uses this without mutation or live observation.
 */
export interface FactoryPhaseEvidence {
  readonly schema: typeof FACTORY_PHASE_EVIDENCE_SCHEMA;
  factory_run_id: string;
  revision: number;
  coarse_phase: FactoryCoarsePhase;
  next_action: FactoryNextAction;
  reason: string;
  service_controller: string;
  recorded_at: string;
  /** Child completion disposition when the evidence came from a terminal child. */
  child_disposition?: {
    kind: "loop" | "advance";
    run_id: string;
    state: "completed" | "failed" | "running" | "ambiguous" | "not_found";
    all_items_terminal?: boolean;
    all_ready_to_deploy?: boolean;
    detail?: string;
  } | null;
  /** Live-identity mismatch detail when next_action is replan_required. */
  replan_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Status projection (read-only)
// ---------------------------------------------------------------------------

export interface FactoryStatus {
  factory_run_id: string;
  revision: number;
  canonical_hash: string;
  coarse_phase: FactoryCoarsePhase;
  next_action: FactoryNextAction;
  completion_policy: FactoryCompletionPolicy;
  identities: FactoryControlIdentities;
  linked_runs: FactoryLinkedRuns;
  claims: FactoryActionClaim[];
  lock: FactoryLockRecord | null;
  /** Durable phase evidence when present (reconstructs post-tick posture). */
  phase_evidence?: FactoryPhaseEvidence | null;
}

export interface FactoryEvidenceEvent {
  seq: number;
  time: string;
  kind: string;
  data: unknown;
}
