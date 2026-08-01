// Typed durable-run blocker classification & recovery policy (#509,
// capability `durable-blocker-classification`). Builds on the loop store
// (#508) primitives — readLedger/writeLedger/appendEvent — to add the pieces
// the durable-loop-engine spec left to the outer agent: a closed blocker
// taxonomy, a validated per-class recovery policy compiled into the
// contract, evidence fingerprinting with repeated-no-progress bounding, and
// fail-closed handling of unknown/ambiguous blockers.
//
// See openspec/changes/durable-run-blocker-classification/design.md for the
// decisions this module implements.

import * as crypto from "node:crypto";
import {
  LoopError,
  DURABLE_BLOCKER_CLASSES,
  isDurableBlockerClass,
  isRecoveryRecipe,
  outstandingReadyItemIds,
  type DurableBlockerClass,
  type ExternalDependencyStatus,
  type RecoveryPolicy,
  type RecoveryPolicyEntry,
  type RecoveryRecipe,
  type RecoveryAttemptOutcome,
  type LoopRecoveryAttempt,
  type LoopContract,
  type LoopLedger,
  type LoopEngineName,
} from "./types.ts";
import { initRun, readLedger, writeLedger, appendEvent, type LoopStoreDeps } from "./store.ts";
import { mapLegacyThemeToBlockerClass } from "./import.ts";

// ---------------------------------------------------------------------------
// Recovery policy compilation — fail closed.
// ---------------------------------------------------------------------------

/** Classes that never get an automated recipe — their policy entry's
 *  `terminal_outcome` must be `human_authority` with no recipes, reinforcing
 *  (not bypassing) the engine's merge/release/credential/deploy gates. */
const HUMAN_AUTHORITY_CLASSES: readonly DurableBlockerClass[] = ["missing-authority", "specification-decision"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compiles and validates a recovery policy for {@link LoopContract.recovery_policy}.
 *  Refuses (LoopError "validation") a policy that omits any class, names an
 *  unknown class, names a recipe outside the closed {@link RECOVERY_RECIPES}
 *  catalogue, is otherwise malformed, or gives `missing-authority` /
 *  `specification-decision` anything but a no-recipe human-authority outcome.
 *  There is deliberately no default for a missing class — a gap fails
 *  compilation rather than defaulting to an open retry. */
export function compileRecoveryPolicy(policy: unknown): RecoveryPolicy {
  if (!isPlainObject(policy)) {
    throw new LoopError("validation", "recovery policy must be an object mapping every DurableBlockerClass to a policy entry");
  }

  const unknownClasses = Object.keys(policy).filter((k) => !isDurableBlockerClass(k));
  if (unknownClasses.length > 0) {
    throw new LoopError("validation", `recovery policy names unknown blocker class(es): ${unknownClasses.join(", ")}`);
  }

  const compiled = {} as RecoveryPolicy;
  for (const cls of DURABLE_BLOCKER_CLASSES) {
    const entry = (policy as Record<string, unknown>)[cls];
    if (!isPlainObject(entry)) {
      throw new LoopError("validation", `recovery policy is missing an entry for blocker class "${cls}"`);
    }
    compiled[cls] = compileEntry(cls, entry);
  }
  return compiled;
}

function compileEntry(cls: DurableBlockerClass, entry: Record<string, unknown>): RecoveryPolicyEntry {
  const recipes = entry.recipes;
  if (!Array.isArray(recipes) || recipes.some((r) => !isRecoveryRecipe(r))) {
    throw new LoopError(
      "validation",
      `recovery policy for "${cls}" names a recipe outside the permitted recovery-recipe catalogue`,
    );
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
  return {
    recipes: recipes as RecoveryRecipe[],
    retry_budget: entry.retry_budget,
    backoff: { initial_seconds: backoff.initial_seconds, multiplier: backoff.multiplier, max_seconds: backoff.max_seconds },
    terminal_outcome: entry.terminal_outcome,
    run_fatal: entry.run_fatal,
    repeated_evidence_limit: entry.repeated_evidence_limit,
  };
}

/** A reasonable default policy covering every class — used by `pipeline:loop`
 *  contract compilation when discovery supplies no override, and by tests as
 *  a ready-made fixture. Compiled (not hand-typed) so it is itself proof the
 *  validator accepts a real-shaped policy. */
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = compileRecoveryPolicy({
  "transient-rate-limit": {
    recipes: ["wait_and_retry"],
    retry_budget: 5,
    backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 900 },
    terminal_outcome: "retry",
    run_fatal: false,
    repeated_evidence_limit: 3,
  },
  "workflow-state": {
    recipes: ["repair_pipeline_item", "resync_workflow_state"],
    retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry",
    run_fatal: false,
    repeated_evidence_limit: 2,
  },
  "implementation-ci": {
    recipes: ["repair_pipeline_item", "rerun_ci"],
    retry_budget: 3,
    backoff: { initial_seconds: 30, multiplier: 2, max_seconds: 600 },
    terminal_outcome: "retry",
    run_fatal: false,
    repeated_evidence_limit: 2,
  },
  "environment-auth": {
    recipes: ["reauthenticate"],
    retry_budget: 2,
    backoff: { initial_seconds: 10, multiplier: 2, max_seconds: 120 },
    terminal_outcome: "retry",
    run_fatal: true,
    repeated_evidence_limit: 2,
  },
  "specification-decision": {
    recipes: [],
    retry_budget: 0,
    backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 },
    terminal_outcome: "human_authority",
    run_fatal: true,
    repeated_evidence_limit: 1,
  },
  "missing-authority": {
    recipes: [],
    retry_budget: 0,
    backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 },
    terminal_outcome: "human_authority",
    run_fatal: true,
    repeated_evidence_limit: 1,
  },
  "upstream-dependency": {
    recipes: ["retry_upstream_check"],
    retry_budget: 3,
    backoff: { initial_seconds: 60, multiplier: 2, max_seconds: 1800 },
    terminal_outcome: "retry",
    run_fatal: false,
    repeated_evidence_limit: 3,
  },
  "workflow-engine-defect": {
    recipes: ["repair_pipeline_item", "restart_workflow_engine"],
    retry_budget: 1,
    backoff: { initial_seconds: 5, multiplier: 1, max_seconds: 5 },
    terminal_outcome: "retry",
    run_fatal: true,
    repeated_evidence_limit: 1,
  },
});

/** A run-contract shape accepted at real initialization time: every
 *  {@link LoopContract} field except `recovery_policy`, which is either the
 *  raw (uncompiled) policy to validate or omitted to install
 *  {@link DEFAULT_RECOVERY_POLICY}. */
export type LoopContractInit = Omit<LoopContract, "recovery_policy"> & { recovery_policy?: unknown };

/** The real run-contract initialization entry point: compiles/validates
 *  `contract.recovery_policy` (installing {@link DEFAULT_RECOVERY_POLICY} when
 *  omitted) BEFORE creating the run directory, so a malformed policy fails
 *  closed and no run directory is created (`initRun`/`compileRecoveryPolicy`
 *  never run). This is the only sanctioned way to produce a `LoopContract`
 *  with a usable `recovery_policy` — do not call `initRun` directly with a
 *  hand-built policy. */
export async function initRecoverableRun(
  deps: LoopStoreDeps,
  contract: LoopContractInit,
  ledger: LoopLedger,
): Promise<LoopContract> {
  const recovery_policy =
    contract.recovery_policy === undefined ? DEFAULT_RECOVERY_POLICY : compileRecoveryPolicy(contract.recovery_policy);
  const compiled: LoopContract = { ...contract, recovery_policy } as LoopContract;
  await initRun(deps, compiled, ledger);
  return compiled;
}

// ---------------------------------------------------------------------------
// Pre-#509 durable-state migration (#509 review round 2 finding 9635d6fb): a
// contract/ledger persisted before this capability existed carries no
// `recovery_policy` / `recovery_attempts` field and may carry a legacy
// free-text `blocked_theme`. Every recovery-path entry point below runs its
// contract/ledger through these pure upgraders before use, so a pre-#509 run
// resumes instead of faulting on a missing field or an unrecognized theme.
// The upgraded shape is written back on the next successful mutation.
// ---------------------------------------------------------------------------

/** Installs {@link DEFAULT_RECOVERY_POLICY} when `recovery_policy` is absent
 *  or missing a class (a pre-#509 contract has no such field at all). A
 *  no-op for an already-compiled contract. */
export function upgradeContractForRecovery(contract: LoopContract): LoopContract {
  const policy = contract.recovery_policy;
  const complete = policy && DURABLE_BLOCKER_CLASSES.every((cls) => policy[cls] !== undefined);
  return complete ? contract : { ...contract, recovery_policy: DEFAULT_RECOVERY_POLICY };
}

/** Defaults `recovery_attempts` to `[]` when absent (a pre-#509 ledger has no
 *  such field, so `recoverItem`'s `.length`/`.push` access would otherwise
 *  fault), and maps every item's legacy free-text `blocked_theme` onto its
 *  {@link DurableBlockerClass} via {@link mapLegacyThemeToBlockerClass}. A
 *  legacy theme with no known mapping is left as-is — the item's next
 *  `blockItem`/`recoverItem` call then fails closed on the invalid class
 *  rather than this read silently discarding it. */
export function upgradeLedgerForRecovery(ledger: LoopLedger): LoopLedger {
  let itemsChanged = false;
  const items: LoopLedger["items"] = {};
  for (const [id, item] of Object.entries(ledger.items)) {
    if (item.blocked_theme && !isDurableBlockerClass(item.blocked_theme)) {
      try {
        items[id] = { ...item, blocked_theme: mapLegacyThemeToBlockerClass(item.blocked_theme) };
        itemsChanged = true;
        continue;
      } catch {
        // Unmapped legacy theme — left unchanged; fails closed downstream.
      }
    }
    items[id] = item;
  }
  let attemptsChanged = !ledger.recovery_attempts;
  const recoveryAttempts = (ledger.recovery_attempts ?? []).map((attempt) => {
    if (attempt.attempt_id && attempt.candidate_identity && attempt.action && typeof attempt.budget_remaining === "number") {
      return attempt;
    }
    const action = attempt.action ?? attempt.actions[0];
    if (!action) return attempt;
    const candidateIdentity = attempt.candidate_identity ?? `legacy:${attempt.seq}`;
    attemptsChanged = true;
    return {
      ...attempt,
      attempt_id:
        attempt.attempt_id ??
        recoveryAttemptId({
          itemId: attempt.item_id,
          candidateIdentity,
          evidenceFingerprint: attempt.evidence_fingerprint,
          action,
        }),
      candidate_identity: candidateIdentity,
      action,
      budget_remaining: attempt.budget_remaining ?? 0,
    };
  });
  if (!itemsChanged && !attemptsChanged) return ledger;
  return { ...ledger, items, recovery_attempts: recoveryAttempts as LoopRecoveryAttempt[] };
}

// ---------------------------------------------------------------------------
// Fail-closed classification.
// ---------------------------------------------------------------------------

/** Resolves a blocker to exactly one {@link DurableBlockerClass}. Pure and
 *  unit-testable: no ledger or store access. Refuses (LoopError "stop") when
 *  zero or more than one candidate names a known class — the caller MUST NOT
 *  guess in either case; {@link classifyAndBlockItem} converts that contract
 *  defect into bounded workflow-engine recovery. */
export function classifyBlocker(candidates: readonly string[]): DurableBlockerClass {
  const matches = [...new Set(candidates)].filter(isDurableBlockerClass);
  if (matches.length === 0) {
    throw new LoopError(
      "stop",
      `blocker classification failed: no candidate matched a known DurableBlockerClass (candidates: ${candidates.join(", ") || "none"})`,
    );
  }
  if (matches.length > 1) {
    throw new LoopError("stop", `blocker classification failed: ambiguous — multiple classes matched (${matches.join(", ")})`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Evidence fingerprinting.
// ---------------------------------------------------------------------------

/** Pure function producing a stable fingerprint over normalized evidence —
 *  structurally identical failures fingerprint identically regardless of
 *  incidental formatting (whitespace, case, embedded shas/numbers that vary
 *  run to run), while materially different evidence fingerprints distinctly. */
export function fingerprintEvidence(evidence: string): string {
  const normalized = evidence
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Stable recovery-action idempotency key. Candidate identity distinguishes
 *  a new head/base or a later block occurrence while retaining the evidence
 *  fingerprint as a fail-closed guard against accidental identity reuse. */
export function recoveryAttemptId(input: {
  itemId: string;
  candidateIdentity: string;
  evidenceFingerprint: string;
  action: RecoveryRecipe;
}): string {
  const canonical = [
    "pipeline-recovery-attempt@1",
    input.itemId,
    input.candidateIdentity,
    input.evidenceFingerprint,
    input.action,
  ].join("\0");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Blocking transition — classification + fingerprint + repeat bounding.
// ---------------------------------------------------------------------------

export interface BlockItemInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  blockerClass: DurableBlockerClass | string;
  evidence: string;
  note?: string;
  /** Batch/deferred-stop escape hatch (#530 review 2 finding a7abc98c): when true, this call
   *  still records the item's own block classification even if the ledger already carries a
   *  terminal `stop` from an earlier item processed in the same concurrent batch — the existing
   *  first-cause `stop` record is preserved (not overwritten). Only the supervisor's same-cycle
   *  sibling classification pass sets this; every other caller keeps the default refusal. */
  allowAlreadyStopped?: boolean;
}

/** Transitions an item into `blocked` carrying a validated
 *  {@link DurableBlockerClass}. Refuses (LoopError "validation") a missing or
 *  out-of-enum class, leaving the item unchanged. Only a currently
 *  `in_progress` item may block (LoopError "validation" otherwise) — this is
 *  the valid active-state transition the engine actually produces, and it is
 *  what makes `repeated_evidence_count` mean "consecutive recovery cycles
 *  that reproduced the same evidence" rather than "duplicate block reports on
 *  an item nothing ever tried to resume" (#509 review round 2 finding
 *  49de4f8c): reaching this function again for the same item requires an
 *  intervening successful {@link recoverItem} resume back to `in_progress`.
 *  Human-authority classes still stop immediately. Retry-capable `run_fatal`
 *  classes do not stop until their configured mechanical recovery is actually
 *  exhausted, keeping their recipes reachable without preventing independent
 *  siblings from progressing. Repeated identical evidence remains independently
 *  bounded by `repeated_evidence_limit`: the supervisor enforces the bound
 *  item-locally — at the limit it claims no further recovery attempt for the
 *  item (regardless of remaining class budget) and promotes the bound to a
 *  `repeated_no_progress` run stop only once the scheduler proves no
 *  independent sibling remains schedulable. */
export async function blockItem(deps: LoopStoreDeps, contractInput: LoopContract, input: BlockItemInput): Promise<LoopLedger> {
  if (!input.blockerClass || !isDurableBlockerClass(input.blockerClass)) {
    throw new LoopError("validation", `"${input.blockerClass}" is not a valid DurableBlockerClass`);
  }
  const blockerClass = input.blockerClass;
  const contract = upgradeContractForRecovery(contractInput);

  const ledger = upgradeLedgerForRecovery(await readLedger(deps, input.runId));
  if (ledger.stop && !input.allowAlreadyStopped) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item) {
    throw new LoopError("validation", `item "${input.itemId}" not found in run "${input.runId}"`);
  }
  if (item.state !== "in_progress") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot block from state "${item.state}" — only an in_progress item may transition into blocked (a blocked item must be recovered back to in_progress first)`,
    );
  }

  const policyEntry = contract.recovery_policy[blockerClass];
  const fingerprint = fingerprintEvidence(input.evidence);
  const repeatedCount = item.evidence_fingerprint === fingerprint ? (item.repeated_evidence_count ?? 0) + 1 : 0;

  const time = deps.now().toISOString();
  const fromState = item.state;
  item.state = "blocked";
  item.blocked_theme = blockerClass;
  item.evidence_fingerprint = fingerprint;
  item.repeated_evidence_count = repeatedCount;
  item.history.push({ time, from: fromState, to: "blocked", engine: input.engine, theme: blockerClass, evidence: input.evidence, note: input.note });

  // A batch call that already found `ledger.stop` set never overwrites that first-cause stop
  // record with its own — the run is already terminally stopped for the earlier reason, and this
  // item's own classification is recorded regardless (#530 review 2 finding a7abc98c).
  const stopAlreadyRecorded = !!ledger.stop;
  if (!ledger.stop) {
    if (policyEntry.terminal_outcome === "human_authority") {
      ledger.stop = { reason: "human_authority", time, item_id: input.itemId, theme: blockerClass, outstanding_ready: outstandingReadyItemIds(ledger) };
    }
  }

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_item_blocked", {
    item_id: input.itemId,
    class: blockerClass,
    evidence_fingerprint: fingerprint,
    repeated_evidence_count: repeatedCount,
  });
  if (ledger.stop && !stopAlreadyRecorded) {
    await appendEvent(deps, input.runId, input.token, "loop_run_stopped", {
      reason: ledger.stop.reason,
      item_id: input.itemId,
      fingerprint,
    });
  }
  return ledger;
}

/** Composes {@link classifyBlocker} and {@link blockItem}. Unknown or
 *  ambiguous classification is an engine-contract defect, not evidence that
 *  a human owns a product or authority decision, so it enters the bounded
 *  workflow-engine recovery policy with the original evidence attached. */
export async function classifyAndBlockItem(
  deps: LoopStoreDeps,
  contract: LoopContract,
  input: Omit<BlockItemInput, "blockerClass"> & { candidateClasses: readonly string[] },
): Promise<LoopLedger> {
  let blockerClass: DurableBlockerClass;
  try {
    blockerClass = classifyBlocker(input.candidateClasses);
  } catch (err) {
    const { candidateClasses: _candidateClasses, ...rest } = input;
    return blockItem(deps, contract, {
      ...rest,
      blockerClass: "workflow-engine-defect",
      evidence: `blocker classification defect: ${(err as Error).message}; source evidence: ${input.evidence}`,
      note: "typed blocker classification failed; bounded engine repair required",
    });
  }
  const { candidateClasses: _candidateClasses, ...rest } = input;
  return blockItem(deps, contract, { ...rest, blockerClass });
}

// ---------------------------------------------------------------------------
// Recovery — durable claim, budget charging, same-item resume.
// ---------------------------------------------------------------------------

interface RecoveryActionInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  action: RecoveryRecipe;
  /** Stable identity of the concrete repair candidate. When omitted, the
   *  current evidence fingerprint plus block-occurrence count is used. */
  candidateIdentity?: string;
}

export interface StartRecoveryAttemptInput extends RecoveryActionInput {}

export interface CompleteRecoveryAttemptInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  attemptId: string;
  succeeded: boolean;
  error?: string;
}

export interface RecoverItemInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  /** Compatibility projection. Exactly one selected recipe is allowed so one
   *  durable attempt always maps to one budget unit and one side effect. */
  actions: RecoveryRecipe[];
  candidateIdentity?: string;
  succeeded: boolean;
  error?: string;
}

export interface RecoverItemResult {
  ledger: LoopLedger;
  attempt: LoopRecoveryAttempt;
}

function recoveryCandidateIdentity(
  requested: string | undefined,
  evidenceFingerprint: string,
  repeatedEvidenceCount: number,
): string {
  const explicit = requested?.trim();
  return explicit || `block:${repeatedEvidenceCount}:${evidenceFingerprint}`;
}

/** Durably claims exactly one recovery action before its external side effect.
 *  The claim consumes one class-budget unit whether the later action succeeds,
 *  fails, or the process dies. Replaying the same deterministic identity after
 *  restart returns the existing attempt without another charge. */
export async function startRecoveryAttempt(
  deps: LoopStoreDeps,
  contractInput: LoopContract,
  input: StartRecoveryAttemptInput,
): Promise<RecoverItemResult> {
  const contract = upgradeContractForRecovery(contractInput);
  const ledger = upgradeLedgerForRecovery(await readLedger(deps, input.runId));
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item || item.state !== "blocked" || !item.blocked_theme || !isDurableBlockerClass(item.blocked_theme)) {
    throw new LoopError("validation", `item "${input.itemId}" is not a blocked item with a valid blocker class`);
  }
  const blockerClass = item.blocked_theme;
  const policyEntry = contract.recovery_policy[blockerClass];

  if (policyEntry.terminal_outcome === "human_authority") {
    throw new LoopError("stop", `blocker class "${blockerClass}" requires human authority and permits no recovery action`);
  }
  if (!policyEntry.recipes.includes(input.action)) {
    throw new LoopError("validation", `recipe "${input.action}" is not permitted for blocker class "${blockerClass}"`);
  }

  const time = deps.now().toISOString();
  const evidenceFingerprint = item.evidence_fingerprint ?? "";
  const candidateIdentity = recoveryCandidateIdentity(
    input.candidateIdentity,
    evidenceFingerprint,
    item.repeated_evidence_count ?? 0,
  );
  const attemptId = recoveryAttemptId({
    itemId: input.itemId,
    candidateIdentity,
    evidenceFingerprint,
    action: input.action,
  });
  const existing = ledger.recovery_attempts.find((attempt) => attempt.attempt_id === attemptId);
  if (existing) return { ledger, attempt: existing };

  const remaining = item.recovery_budgets_remaining[blockerClass] ?? policyEntry.retry_budget;
  const outcome: RecoveryAttemptOutcome = remaining <= 0 ? "exhausted" : "started";
  const budgetRemaining = Math.max(0, remaining - (outcome === "started" ? 1 : 0));
  const priorClassAttempts = ledger.recovery_attempts.filter(
    (attempt) =>
      attempt.item_id === input.itemId &&
      attempt.class === blockerClass &&
      attempt.evidence_fingerprint === evidenceFingerprint,
  ).length;
  const backoffSeconds = Math.min(
    policyEntry.backoff.max_seconds,
    policyEntry.backoff.initial_seconds * Math.pow(policyEntry.backoff.multiplier, priorClassAttempts),
  );
  const notBefore = new Date(Date.parse(time) + backoffSeconds * 1000).toISOString();

  const attempt: LoopRecoveryAttempt = {
    attempt_id: attemptId,
    seq: ledger.recovery_attempts.length,
    time,
    ...(outcome === "started" && backoffSeconds > 0 ? { not_before: notBefore } : {}),
    item_id: input.itemId,
    class: blockerClass,
    candidate_identity: candidateIdentity,
    action: input.action,
    actions: [input.action],
    evidence_fingerprint: evidenceFingerprint,
    outcome,
    budget_remaining: budgetRemaining,
    ...(outcome === "exhausted" ? { error: `recovery budget exhausted before action "${input.action}" could start` } : {}),
  };
  ledger.recovery_attempts.push(attempt);
  if (outcome === "started") {
    item.recovery_budgets_remaining[blockerClass] = budgetRemaining;
  }

  await writeLedger(deps, ledger, input.token);
  await appendEvent(
    deps,
    input.runId,
    input.token,
    outcome === "started" ? "loop_recovery_attempt_started" : "loop_recovery_attempt",
    { ...attempt },
  );
  return { ledger, attempt };
}

/** Completes a previously persisted recovery claim. Completion is idempotent:
 *  replaying a completed attempt returns its stored result. A failed final
 *  action records its error but remains item-local; the supervisor may stop
 *  only after proving that no independent sibling is schedulable. A
 *  successful action resumes the same item in place. */
export async function completeRecoveryAttempt(
  deps: LoopStoreDeps,
  contractInput: LoopContract,
  input: CompleteRecoveryAttemptInput,
): Promise<RecoverItemResult> {
  upgradeContractForRecovery(contractInput);
  const ledger = upgradeLedgerForRecovery(await readLedger(deps, input.runId));
  const attempt = ledger.recovery_attempts.find((candidate) => candidate.attempt_id === input.attemptId);
  if (!attempt || attempt.item_id !== input.itemId) {
    throw new LoopError("validation", `recovery attempt "${input.attemptId}" was not started for item "${input.itemId}"`);
  }
  if (attempt.outcome !== "started") return { ledger, attempt };
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }

  const item = ledger.items[input.itemId];
  if (
    !item ||
    item.state !== "blocked" ||
    item.blocked_theme !== attempt.class ||
    (item.evidence_fingerprint ?? "") !== attempt.evidence_fingerprint
  ) {
    throw new LoopError("validation", `recovery attempt "${input.attemptId}" no longer matches the blocked candidate for item "${input.itemId}"`);
  }

  const time = deps.now().toISOString();
  attempt.completed_at = time;
  if (input.succeeded) {
    attempt.outcome = "recovered";
    delete attempt.error;
    item.state = "in_progress";
    item.history.push({
      time,
      from: "blocked",
      to: "in_progress",
      engine: input.engine,
      theme: attempt.class,
      note: `recovery action "${attempt.action}" completed (${attempt.budget_remaining} of class "${attempt.class}" remaining)`,
    });
  } else {
    attempt.outcome = "failed";
    attempt.error = input.error?.trim() || `recovery action "${attempt.action}" failed without error detail`;
  }

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_recovery_attempt", { ...attempt });
  return { ledger, attempt };
}

/** Compatibility wrapper for callers that already have an action result. New
 *  executors must call {@link startRecoveryAttempt} before the side effect and
 *  {@link completeRecoveryAttempt} afterward so a process death is visible. */
export async function recoverItem(
  deps: LoopStoreDeps,
  contractInput: LoopContract,
  input: RecoverItemInput,
): Promise<RecoverItemResult> {
  const current = upgradeLedgerForRecovery(await readLedger(deps, input.runId));
  if (current.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${current.stop.reason}`);
  }
  if (input.actions.length !== 1) {
    throw new LoopError(
      "validation",
      `recovery for item "${input.itemId}" requires exactly one selected recovery action`,
    );
  }
  const started = await startRecoveryAttempt(deps, contractInput, {
    runId: input.runId,
    token: input.token,
    itemId: input.itemId,
    engine: input.engine,
    action: input.actions[0],
    candidateIdentity: input.candidateIdentity,
  });
  if (started.attempt.outcome !== "started") return started;
  return completeRecoveryAttempt(deps, contractInput, {
    runId: input.runId,
    token: input.token,
    itemId: input.itemId,
    engine: input.engine,
    attemptId: started.attempt.attempt_id,
    succeeded: input.succeeded,
    error: input.error,
  });
}

// ---------------------------------------------------------------------------
// Independent-item continuation — gated by the blocking class's run_fatal flag.
// ---------------------------------------------------------------------------

/** Reports the configured severity of a current block. This is diagnostic
 *  only: sibling admission is gated by the durable `ledger.stop`, not by a
 *  recoverable class that has not exhausted its recipe budget. */
export function isRunFatalBlocked(contractInput: LoopContract, ledgerInput: LoopLedger): boolean {
  const contract = upgradeContractForRecovery(contractInput);
  const ledger = upgradeLedgerForRecovery(ledgerInput);
  return Object.values(ledger.items).some((item) => {
    if (item.state !== "blocked" || !item.blocked_theme || !isDurableBlockerClass(item.blocked_theme)) return false;
    return contract.recovery_policy[item.blocked_theme].run_fatal;
  });
}

// This pipeline stops at `pipeline:ready-to-deploy` (`ready`) and never
// merges (CLAUDE.md golden rule #4), so `ready` — not `merged` — is this
// engine's actual completion state; `merged`/`released`/`deployed` are
// retained for engines/imports whose lifecycle continues past that point.
export const DONE_STATES = new Set(["ready", "merged", "released", "deployed"]);

/** Pending items with no dependency on a blocked item, whose declared
 *  dependencies are all done, and whose external dependencies (capability
 *  `durable-run-dependency-integrity`) are all `satisfied` — eligible to start while another item
 *  is blocked, subject to the existing single-active-item invariant (never returns items when one
 *  is already `in_progress`). A configured `run_fatal` class does not suppress independent work
 *  until exhaustion has produced a durable `ledger.stop`. `externalStatuses` defaults to `{}` (no
 *  external dependencies) so existing callers with no external gating are unaffected. Preserves
 *  the merge-barrier invariant by never bypassing it — it is enforced elsewhere, unaffected by
 *  this selection. */
export function eligibleIndependentItems(
  contractInput: LoopContract,
  ledgerInput: LoopLedger,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>> = {},
): string[] {
  const contract = upgradeContractForRecovery(contractInput);
  const ledger = upgradeLedgerForRecovery(ledgerInput);
  if (ledger.stop) return [];
  if (Object.values(ledger.items).some((item) => item.state === "in_progress")) return [];

  const blockedIds = new Set(Object.values(ledger.items).filter((item) => item.state === "blocked").map((item) => item.id));
  const dependsOn = new Map(contract.items.map((i) => [i.id, i.depends_on]));
  const externalDependsOn = new Map(contract.items.map((i) => [i.id, i.external_depends_on ?? []]));

  return contract.items
    .filter((i) => {
      const entry = ledger.items[i.id];
      if (!entry || entry.state !== "pending") return false;
      const deps = dependsOn.get(i.id) ?? [];
      if (deps.some((d) => blockedIds.has(d))) return false;
      const inSnapshotDone = deps.every((d) => {
        const depEntry = ledger.items[d];
        return depEntry !== undefined && DONE_STATES.has(depEntry.state);
      });
      if (!inSnapshotDone) return false;
      const externalDeps = externalDependsOn.get(i.id) ?? [];
      return externalDeps.every((id) => externalStatuses[id] === "satisfied");
    })
    .map((i) => i.id);
}
