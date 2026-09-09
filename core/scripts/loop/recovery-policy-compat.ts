import {
  DURABLE_BLOCKER_CLASSES,
  isDurableBlockerClass,
  isRecoveryRecipe,
  LoopError,
  type DurableBlockerClass,
  type RecoveryPolicy,
  type RecoveryPolicyEntry,
  type RecoveryRecipe,
} from "./types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const HUMAN_AUTHORITY_CLASSES: readonly DurableBlockerClass[] = ["missing-authority", "specification-decision"];

/** Compile and validate a complete recovery policy without depending on recovery/store orchestration. */
export function compileRecoveryPolicy(policy: unknown): RecoveryPolicy {
  if (!isPlainObject(policy)) {
    throw new LoopError("validation", "recovery policy must be an object mapping every DurableBlockerClass to a policy entry");
  }
  const unknownClasses = Object.keys(policy).filter((key) => !isDurableBlockerClass(key));
  if (unknownClasses.length > 0) {
    throw new LoopError("validation", `recovery policy names unknown blocker class(es): ${unknownClasses.join(", ")}`);
  }
  const compiled = {} as RecoveryPolicy;
  for (const cls of DURABLE_BLOCKER_CLASSES) {
    const entry = policy[cls];
    if (!isPlainObject(entry)) {
      throw new LoopError("validation", `recovery policy is missing an entry for blocker class "${cls}"`);
    }
    compiled[cls] = compileEntry(cls, entry);
  }
  return compiled;
}

function compileEntry(cls: DurableBlockerClass, entry: Record<string, unknown>): RecoveryPolicyEntry {
  const recipes = entry.recipes;
  if (!Array.isArray(recipes) || recipes.some((recipe) => !isRecoveryRecipe(recipe))) {
    throw new LoopError("validation", `recovery policy for "${cls}" names a recipe outside the permitted recovery-recipe catalogue`);
  }
  if (typeof entry.retry_budget !== "number" || !Number.isFinite(entry.retry_budget) || entry.retry_budget < 0) {
    throw new LoopError("validation", `recovery policy for "${cls}" is missing a valid retry_budget`);
  }
  const backoff = entry.backoff;
  if (
    !isPlainObject(backoff) ||
    typeof backoff.initial_seconds !== "number" ||
    typeof backoff.multiplier !== "number" ||
    typeof backoff.max_seconds !== "number"
  ) {
    throw new LoopError("validation", `recovery policy for "${cls}" is missing a valid backoff schedule`);
  }
  if (entry.terminal_outcome !== "retry" && entry.terminal_outcome !== "human_authority") {
    throw new LoopError("validation", `recovery policy for "${cls}" is missing a valid terminal_outcome`);
  }
  if (typeof entry.run_fatal !== "boolean") {
    throw new LoopError("validation", `recovery policy for "${cls}" is missing a valid run_fatal flag`);
  }
  if (
    typeof entry.repeated_evidence_limit !== "number" ||
    !Number.isFinite(entry.repeated_evidence_limit) ||
    entry.repeated_evidence_limit < 1
  ) {
    throw new LoopError("validation", `recovery policy for "${cls}" is missing a valid repeated_evidence_limit`);
  }
  if (HUMAN_AUTHORITY_CLASSES.includes(cls) && (entry.terminal_outcome !== "human_authority" || recipes.length > 0)) {
    throw new LoopError(
      "validation",
      `recovery policy for "${cls}" must route to a terminal human-authority outcome with no automated recipe`,
    );
  }
  const compiled: RecoveryPolicyEntry = {
    recipes: recipes as RecoveryRecipe[],
    retry_budget: entry.retry_budget,
    backoff: { initial_seconds: backoff.initial_seconds, multiplier: backoff.multiplier, max_seconds: backoff.max_seconds },
    terminal_outcome: entry.terminal_outcome,
    run_fatal: entry.run_fatal,
    repeated_evidence_limit: entry.repeated_evidence_limit,
  };
  if (typeof entry.per_strategy_bound === "number" && Number.isFinite(entry.per_strategy_bound) && entry.per_strategy_bound >= 0) {
    compiled.per_strategy_bound = entry.per_strategy_bound;
  }
  return compiled;
}

/** Current defaults as raw policy input, kept below the store/recovery dependency seam. */
export const DEFAULT_RECOVERY_POLICY_INPUT = {
  "transient-rate-limit": {
    recipes: ["wait_and_retry"], retry_budget: 5,
    backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 900 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 3,
  },
  "workflow-state": {
    recipes: ["resync_workflow_state", "repair_pipeline_item"], retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
  },
  "implementation-ci": {
    recipes: ["verify_head_goal", "rerun_ci", "repair_pipeline_item"], retry_budget: 3,
    backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 600 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
  },
  "review-findings": {
    recipes: ["unlink_engine_scratch", "repair_pipeline_item"], retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
  },
  "environment-auth": {
    recipes: ["verify_authentication"], retry_budget: 2,
    backoff: { initial_seconds: 10, multiplier: 2, max_seconds: 120 },
    terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
  },
  "specification-decision": {
    recipes: [], retry_budget: 0,
    backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 },
    terminal_outcome: "human_authority", run_fatal: true, repeated_evidence_limit: 1,
  },
  "missing-authority": {
    recipes: [], retry_budget: 0,
    backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 },
    terminal_outcome: "human_authority", run_fatal: true, repeated_evidence_limit: 1,
  },
  "upstream-dependency": {
    recipes: ["retry_upstream_check"], retry_budget: 3,
    backoff: { initial_seconds: 60, multiplier: 2, max_seconds: 1800 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 3,
  },
  "workflow-engine-defect": {
    recipes: [
      "unlink_engine_scratch",
      "checkpoint_owned_harness_dirt",
      "publish_unpublished_stage_commit",
      "rebind_tester_evidence_after_pr",
      "restart_workflow_engine",
      "repair_pipeline_item",
    ],
    retry_budget: 2,
    backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
    terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
  },
} satisfies Record<DurableBlockerClass, Record<string, unknown>>;

const STALE_DEFAULT_POLICY_ENTRIES: Partial<Record<DurableBlockerClass, readonly Record<string, unknown>[]>> = {
  "workflow-state": [{
    recipes: ["resync_workflow_state"], retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
  }],
  "implementation-ci": [
    {
      recipes: ["rerun_ci"], retry_budget: 3,
      backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 600 },
      terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
    },
    {
      recipes: ["rerun_ci", "repair_pipeline_item"], retry_budget: 3,
      backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 600 },
      terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
    },
  ],
  "environment-auth": [{
    recipes: ["reauthenticate"], retry_budget: 2,
    backoff: { initial_seconds: 10, multiplier: 2, max_seconds: 120 },
    terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
  }],
  "workflow-engine-defect": [
    {
      recipes: ["restart_workflow_engine"], retry_budget: 1,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 1,
    },
    {
      recipes: ["restart_workflow_engine", "repair_pipeline_item"], retry_budget: 1,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 1,
    },
    {
      recipes: ["restart_workflow_engine", "repair_pipeline_item"], retry_budget: 2,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
    },
    {
      recipes: ["unlink_engine_scratch", "restart_workflow_engine", "repair_pipeline_item"], retry_budget: 2,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
    },
    {
      recipes: ["unlink_engine_scratch", "checkpoint_owned_harness_dirt", "restart_workflow_engine", "repair_pipeline_item"],
      retry_budget: 2,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
    },
    {
      recipes: ["unlink_engine_scratch", "checkpoint_owned_harness_dirt", "publish_unpublished_stage_commit", "restart_workflow_engine", "repair_pipeline_item"],
      retry_budget: 2,
      backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
      terminal_outcome: "retry", run_fatal: true, repeated_evidence_limit: 2,
    },
  ],
  "review-findings": [{
    recipes: ["repair_pipeline_item"], retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry", run_fatal: false, repeated_evidence_limit: 2,
  }],
};

function samePolicyEntry(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => samePolicyEntry(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && samePolicyEntry(left[key], right[key]));
}

/** Pure compatibility normalization shared by recovery selection and ledger validation. */
export function normalizeRecoveryPolicyCompatibility(policy: unknown): unknown {
  if (policy === undefined) return DEFAULT_RECOVERY_POLICY_INPUT;
  if (!isPlainObject(policy)) return policy;
  let changed = false;
  const migrated = { ...policy };
  for (const cls of DURABLE_BLOCKER_CLASSES) {
    const entry = migrated[cls];
    if (entry === undefined) {
      migrated[cls] = DEFAULT_RECOVERY_POLICY_INPUT[cls];
      changed = true;
      continue;
    }
    if ((STALE_DEFAULT_POLICY_ENTRIES[cls] ?? []).some((stale) => samePolicyEntry(entry, stale))) {
      migrated[cls] = DEFAULT_RECOVERY_POLICY_INPUT[cls];
      changed = true;
      continue;
    }
    if (isPlainObject(entry) && Array.isArray(entry.recipes) && entry.recipes.includes("reauthenticate")) {
      migrated[cls] = {
        ...entry,
        recipes: entry.recipes.map((recipe) => recipe === "reauthenticate" ? "verify_authentication" : recipe),
      };
      changed = true;
    }
  }
  return changed ? migrated : policy;
}

export function effectiveRecoveryPolicyForLedgerValidation(policy: unknown): RecoveryPolicy | undefined {
  try {
    return compileRecoveryPolicy(normalizeRecoveryPolicyCompatibility(policy));
  } catch {
    return undefined;
  }
}
