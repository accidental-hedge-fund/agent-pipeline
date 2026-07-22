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
  | "deployed";

export type LoopAuthorityGate = "push_pr" | "merge" | "release" | "deploy";

export interface LoopRecoveryBudgets {
  default: number;
  [theme: string]: number;
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
  blocked_theme?: string;
  recovery_budgets_remaining: LoopRecoveryBudgets;
}

export interface LoopMergeBarrier {
  item_id: string;
  merged_sha: string;
  set_at: string;
}

export interface LoopStopRecord {
  reason: "recovery_exhausted" | "consecutive_blocked";
  time: string;
  item_id?: string;
  theme?: string;
  limit?: number;
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
