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
    recipes: ["resync_workflow_state"],
    retry_budget: 3,
    backoff: { initial_seconds: 15, multiplier: 2, max_seconds: 300 },
    terminal_outcome: "retry",
    run_fatal: false,
    repeated_evidence_limit: 2,
  },
  "implementation-ci": {
    recipes: ["rerun_ci"],
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
    recipes: ["restart_workflow_engine"],
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
  if (!itemsChanged && ledger.recovery_attempts) return ledger;
  return { ...ledger, items, recovery_attempts: ledger.recovery_attempts ?? [] };
}

// ---------------------------------------------------------------------------
// Fail-closed classification.
// ---------------------------------------------------------------------------

/** Resolves a blocker to exactly one {@link DurableBlockerClass}. Pure and
 *  unit-testable: no ledger or store access. Refuses (LoopError "stop") when
 *  zero or more than one candidate names a known class — the caller MUST NOT
 *  guess in either case; see {@link recordNeedsHumanClassificationStop}. */
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

/** Records the terminal needs-human stop for a blocker that failed
 *  classification. Consumes no recovery budget and attempts no recipe. */
export async function recordNeedsHumanClassificationStop(
  deps: LoopStoreDeps,
  runId: string,
  token: string,
  itemId: string,
  detail: string,
): Promise<LoopLedger> {
  const ledger = upgradeLedgerForRecovery(await readLedger(deps, runId));
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${runId}" is already stopped: ${ledger.stop.reason}`);
  }
  if (!ledger.items[itemId]) {
    throw new LoopError("validation", `item "${itemId}" not found in run "${runId}"`);
  }
  ledger.stop = { reason: "needs_human_classification", time: deps.now().toISOString(), item_id: itemId };
  await writeLedger(deps, ledger, token);
  await appendEvent(deps, runId, token, "loop_run_stopped", { reason: ledger.stop.reason, item_id: itemId, detail });
  return ledger;
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
 *  When the class's policy routes to `human_authority`, or is `run_fatal`,
 *  immediately records a terminal run stop (`human_authority` / `run_fatal`
 *  respectively, #509 review round 2 finding 6ced9fe0 for the latter) — every
 *  subsequent transition on the run is refused, including a recovery attempt
 *  on this same item. Otherwise, fingerprints the evidence and, when it
 *  repeats the item's immediately preceding fingerprint past the class's
 *  `repeated_evidence_limit`, records a terminal `repeated_no_progress` run
 *  stop — independent of the class recovery budget, which this transition
 *  never charges (budget is charged only on recovery — see
 *  {@link recoverItem}). */
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
      ledger.stop = { reason: "human_authority", time, item_id: input.itemId, theme: blockerClass };
    } else if (repeatedCount >= policyEntry.repeated_evidence_limit) {
      ledger.stop = {
        reason: "repeated_no_progress",
        time,
        item_id: input.itemId,
        theme: blockerClass,
        fingerprint,
      };
    } else if (policyEntry.run_fatal) {
      ledger.stop = { reason: "run_fatal", time, item_id: input.itemId, theme: blockerClass };
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

/** Composes {@link classifyBlocker} and {@link blockItem}: the realistic
 *  single call site for reporting a blocker whose class an outer agent has
 *  not yet resolved. On ambiguous/unknown classification, records the
 *  needs-human stop and rethrows rather than guessing a class. */
export async function classifyAndBlockItem(
  deps: LoopStoreDeps,
  contract: LoopContract,
  input: Omit<BlockItemInput, "blockerClass"> & { candidateClasses: readonly string[] },
): Promise<LoopLedger> {
  let blockerClass: DurableBlockerClass;
  try {
    blockerClass = classifyBlocker(input.candidateClasses);
  } catch (err) {
    await recordNeedsHumanClassificationStop(deps, input.runId, input.token, input.itemId, (err as Error).message);
    throw err;
  }
  const { candidateClasses: _candidateClasses, ...rest } = input;
  return blockItem(deps, contract, { ...rest, blockerClass });
}

// ---------------------------------------------------------------------------
// Recovery — budget charging keyed by classification, same-item resume.
// ---------------------------------------------------------------------------

export interface RecoverItemInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  /** The recipe(s) actually attempted — each must be permitted by the item's
   *  blocked class's policy entry. */
  actions: RecoveryRecipe[];
  /** Whether the attempted `actions` actually succeeded, as observed by the
   *  caller (#509 review round 2 finding 2794f4b6: the caller — not this
   *  function — executes the recipe, so it is the only party that knows the
   *  real result; this call must never assume success). A `false` result is
   *  persisted as a `failed` attempt: the item stays `blocked` and no budget
   *  is charged. Ignored when the class routes to `human_authority`, which
   *  has no automated recipe to succeed or fail. */
  succeeded: boolean;
}

export interface RecoverItemResult {
  ledger: LoopLedger;
  attempt: LoopRecoveryAttempt;
}

/** Attempts to recover a blocked item. Charges the recovery budget keyed by
 *  the item's typed blocker classification (falling back to the class's
 *  compiled `retry_budget` from the policy, not the ledger's unrelated
 *  `default`, when the item has no class-specific ledger entry yet), and only
 *  when `input.succeeded` is true resumes the SAME item `blocked` ->
 *  `in_progress`, retaining its history, class, and evidence records. A
 *  `false` `input.succeeded` records a `failed` attempt without moving the
 *  item out of `blocked` and without charging any budget. Refuses (LoopError
 *  "validation") a retry-capable recovery attempted with an empty action
 *  list — at least one permitted recipe must actually have been attempted,
 *  regardless of whether it succeeded. Refuses (LoopError "stop") when the
 *  run already carries a terminal stop (including the `human_authority` /
 *  `run_fatal` stops {@link blockItem} records immediately for those
 *  classes), or when the class budget is already exhausted (recording a
 *  terminal `recovery_exhausted` stop) — budget exhaustion is checked before
 *  `input.succeeded`, since a caller cannot spend budget that is already
 *  gone regardless of this attempt's outcome. */
export async function recoverItem(deps: LoopStoreDeps, contractInput: LoopContract, input: RecoverItemInput): Promise<RecoverItemResult> {
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

  const invalidAction = input.actions.find((a) => !policyEntry.recipes.includes(a));
  if (invalidAction) {
    throw new LoopError("validation", `recipe "${invalidAction}" is not permitted for blocker class "${blockerClass}"`);
  }
  if (policyEntry.terminal_outcome !== "human_authority" && input.actions.length === 0) {
    throw new LoopError(
      "validation",
      `recovery for blocker class "${blockerClass}" requires at least one permitted recovery action — none was attempted`,
    );
  }

  const time = deps.now().toISOString();
  let outcome: RecoveryAttemptOutcome;

  if (policyEntry.terminal_outcome === "human_authority") {
    outcome = "human_authority";
  } else {
    const remaining = item.recovery_budgets_remaining[blockerClass] ?? policyEntry.retry_budget;
    if (remaining <= 0) {
      outcome = "exhausted";
      ledger.stop = { reason: "recovery_exhausted", time, item_id: input.itemId, theme: blockerClass };
    } else if (!input.succeeded) {
      outcome = "failed";
    } else {
      outcome = "recovered";
      item.recovery_budgets_remaining[blockerClass] = remaining - 1;
      item.state = "in_progress";
      item.history.push({
        time,
        from: "blocked",
        to: "in_progress",
        engine: input.engine,
        theme: blockerClass,
        note: `recovery charged (${remaining - 1} of class "${blockerClass}" remaining)`,
      });
    }
  }

  const attempt: LoopRecoveryAttempt = {
    seq: ledger.recovery_attempts.length,
    time,
    item_id: input.itemId,
    class: blockerClass,
    actions: input.actions,
    evidence_fingerprint: item.evidence_fingerprint ?? "",
    outcome,
  };
  ledger.recovery_attempts.push(attempt);

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_recovery_attempt", { ...attempt });
  if (ledger.stop) {
    await appendEvent(deps, input.runId, input.token, "loop_run_stopped", { reason: ledger.stop.reason, item_id: input.itemId, theme: blockerClass });
  }
  return { ledger, attempt };
}

// ---------------------------------------------------------------------------
// Independent-item continuation — gated by the blocking class's run_fatal flag.
// ---------------------------------------------------------------------------

/** True when any currently-blocked item's class is `run_fatal` — in which
 *  case the whole run stops and no further item may be started. Since
 *  {@link blockItem} now records a terminal `run_fatal` stop at block time
 *  (#509 review round 2 finding 6ced9fe0), `ledger.stop` is the primary
 *  signal for callers; this predicate remains for direct class-level
 *  inspection of an already-loaded ledger. */
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
 *  is already `in_progress`) and to the class-level `run_fatal` gate (returns none when any block
 *  is run-fatal). `externalStatuses` defaults to `{}` (no external dependencies) so existing
 *  callers with no external gating are unaffected. Preserves the merge-barrier invariant by never
 *  bypassing it — it is enforced elsewhere, unaffected by this selection. */
export function eligibleIndependentItems(
  contractInput: LoopContract,
  ledgerInput: LoopLedger,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>> = {},
): string[] {
  const contract = upgradeContractForRecovery(contractInput);
  const ledger = upgradeLedgerForRecovery(ledgerInput);
  if (ledger.stop) return [];
  if (isRunFatalBlocked(contract, ledger)) return [];
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
