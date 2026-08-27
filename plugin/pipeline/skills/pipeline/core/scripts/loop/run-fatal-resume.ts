// Operator `--resume` of a terminal `run_fatal` stop (#1258, capability
// `durable-loop-supervisor`): classify live outstanding items, supersede the
// stop under the run lock when at least one item is still valid, or format a
// distinct refusal. Live-drive `run_fatal` policy is unchanged.

import { isPrePipelineStage } from "./precondition.ts";
import { observeExternalIdentity, type ReconcileObserveDeps } from "./reconcile.ts";
import { HUMAN_AUTHORITY_CLASSES } from "./recovery.ts";
import { appendEvent, readContract, readLedger, writeLedger, type LoopStoreDeps } from "./store.ts";
import {
  LoopError,
  type LoopContract,
  type LoopExternalIdentity,
  type LoopItemLedgerEntry,
  type LoopLedger,
  type LoopStopRecord,
} from "./types.ts";

/** Append-only event kind written when operator `--resume` clears a `run_fatal`
 *  stop. Tests lock this string. The original `loop_run_stopped` line stays. */
export const LOOP_RUN_FATAL_SUPERSEDED = "loop_run_fatal_superseded";

/** Ledger states that are not outstanding work for a `run_fatal` re-drive. */
const NOT_OUTSTANDING = new Set(["ready", "merged", "released", "deployed", "abandoned", "skipped"]);

export type OutstandingInvalidReason =
  | "not_on_contract"
  | "done"
  | "abandoned"
  | "skipped"
  | "human_authority_hold"
  | "precondition_excluded"
  | "unusable_identity";

export type OutstandingClassification =
  | { valid: true; reason: "admitted" }
  | { valid: false; reason: OutstandingInvalidReason };

/** True when the item is under a current human-authority hold: `paused` /
 *  `waiting` except the auto-reopen `pipeline_blocked_label` source, or
 *  `blocked` under a human-authority class. */
export function isCurrentHumanAuthorityHold(item: LoopItemLedgerEntry): boolean {
  if (item.state === "paused" || item.state === "waiting") {
    return item.hold_request?.source !== "pipeline_blocked_label";
  }
  if (item.state === "blocked" && item.blocked_theme) {
    return (HUMAN_AUTHORITY_CLASSES as readonly string[]).includes(item.blocked_theme);
  }
  return false;
}

function isUsableIdentity(identity: LoopExternalIdentity | null | undefined): identity is LoopExternalIdentity {
  return identity != null && typeof identity === "object" && "pipeline_stage" in identity;
}

/** Pure classifier: one contract item plus its observed identity. No I/O. */
export function classifyOutstandingItem(
  itemId: string,
  contract: LoopContract,
  ledger: LoopLedger,
  identity: LoopExternalIdentity | null | undefined,
): OutstandingClassification {
  if (!contract.items.some((item) => item.id === itemId)) {
    return { valid: false, reason: "not_on_contract" };
  }
  const entry = ledger.items[itemId];
  if (!entry) return { valid: false, reason: "not_on_contract" };
  if (entry.state === "abandoned") return { valid: false, reason: "abandoned" };
  if (entry.state === "skipped") return { valid: false, reason: "skipped" };
  if (NOT_OUTSTANDING.has(entry.state)) return { valid: false, reason: "done" };
  if (isCurrentHumanAuthorityHold(entry)) return { valid: false, reason: "human_authority_hold" };
  if (!isUsableIdentity(identity)) return { valid: false, reason: "unusable_identity" };
  if (isPrePipelineStage(identity.pipeline_stage)) return { valid: false, reason: "precondition_excluded" };
  return { valid: true, reason: "admitted" };
}

export interface RunFatalResumeClassification {
  eligible: boolean;
  validOutstandingItemIds: string[];
}

/** Pure classifier over every contract item. Missing identities fail closed
 *  (that item is not valid-outstanding). */
export function classifyRunFatalResumeEligibility(
  contract: LoopContract,
  ledger: LoopLedger,
  identities: Readonly<Record<string, LoopExternalIdentity | null | undefined>>,
): RunFatalResumeClassification {
  const validOutstandingItemIds: string[] = [];
  for (const item of contract.items) {
    const result = classifyOutstandingItem(item.id, contract, ledger, identities[item.id]);
    if (result.valid) validOutstandingItemIds.push(item.id);
  }
  return { eligible: validOutstandingItemIds.length > 0, validOutstandingItemIds };
}

export type RunFatalResumeDecision =
  | { eligible: true; validOutstandingItemIds: string[]; stop: LoopStopRecord }
  | { eligible: false; stop: LoopStopRecord; observeError?: string };

/** Observe live identities then classify. Observation failure fail-closes
 *  (not eligible) without treating any item as valid-outstanding. */
export async function evaluateRunFatalResumeEligibility(
  store: LoopStoreDeps,
  observe: ReconcileObserveDeps,
  runId: string,
): Promise<RunFatalResumeDecision> {
  const contract = await readContract(store, runId);
  const ledger = await readLedger(store, runId);
  const stop = ledger.stop;
  if (!stop || stop.reason !== "run_fatal") {
    throw new LoopError(
      "validation",
      `loop run "${runId}" has no run_fatal stop to evaluate` +
        (stop ? ` (stop.reason=${stop.reason})` : ""),
    );
  }
  const identities: Record<string, LoopExternalIdentity> = {};
  try {
    for (const item of contract.items) {
      identities[item.id] = await observeExternalIdentity(observe, item.id);
    }
  } catch (err) {
    return { eligible: false, stop, observeError: (err as Error).message };
  }
  const classified = classifyRunFatalResumeEligibility(contract, ledger, identities);
  if (!classified.eligible) return { eligible: false, stop };
  return {
    eligible: true,
    validOutstandingItemIds: classified.validOutstandingItemIds,
    stop,
  };
}

/** Distinct non-success message for an ineligible `run_fatal` resume. */
export function formatRunFatalResumeRefusal(
  runId: string,
  stop: LoopStopRecord,
  observeError?: string,
): string {
  const details: string[] = [];
  if (stop.theme) details.push(`theme=${stop.theme}`);
  if (stop.item_id) details.push(`item_id=${stop.item_id}`);
  const detailSuffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  const why = observeError
    ? `live observation failed (${observeError}); refusing to re-drive`
    : "no valid outstanding item remains";
  return (
    `loop run "${runId}" is stopped with run_fatal at ${stop.time}${detailSuffix}; ${why}. ` +
    `Inspect with \`pipeline loop --resume ${runId} --audit\`. ` +
    `Start a replacement with \`pipeline loop --new-run\` for the same selector.`
  );
}

/** Clears `ledger.stop` under the lock and appends one supersede event that
 *  copies the prior stop record. Does not rewrite the original stop event.
 *  Refuses when the current stop is missing or not `run_fatal`. */
export async function supersedeRunFatalStop(
  deps: LoopStoreDeps,
  runId: string,
  token: string,
): Promise<LoopStopRecord> {
  const ledger = await readLedger(deps, runId);
  if (!ledger.stop || ledger.stop.reason !== "run_fatal") {
    throw new LoopError(
      "validation",
      `loop run "${runId}" has no run_fatal stop to supersede` +
        (ledger.stop ? ` (stop.reason=${ledger.stop.reason})` : ""),
    );
  }
  const prior = ledger.stop;
  const next: LoopLedger = { ...ledger, stop: null };
  await writeLedger(deps, next, token);
  await appendEvent(deps, runId, token, LOOP_RUN_FATAL_SUPERSEDED, {
    reason: prior.reason,
    time: prior.time,
    theme: prior.theme ?? null,
    item_id: prior.item_id ?? null,
    outstanding_ready: prior.outstanding_ready,
  });
  return prior;
}
