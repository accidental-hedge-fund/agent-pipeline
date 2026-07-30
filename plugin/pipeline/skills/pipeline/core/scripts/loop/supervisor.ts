// The Agent Pipeline-owned durable loop supervisor (#512, capability
// `durable-loop-supervisor`). Drives an already-compiled, locked run
// cycle-by-cycle to a terminal condition through the existing engine
// primitives (reconcile, recovery, pause, the loop store) — never a second
// ledger/lock/store, never a pipeline stage-label write, never a merge.
//
// See openspec/changes/in-repo-loop-supervisor/design.md for the decisions
// this module implements. Every mutating operation goes through the injected
// SupervisorDeps seam — no real filesystem, process, network, or subprocess
// access in unit tests.

import { readFile as defaultReadFile } from "node:fs/promises";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  outstandingReadyItemIds,
  type LoopContract,
  type LoopEngineName,
  type LoopItemLedgerEntry,
  type LoopLedger,
  type LoopPreconditionExclusion,
  type LoopStopRecord,
  type LoopSupervisorProcess,
} from "./types.ts";
import {
  acquireLock,
  appendActionEvidence,
  appendEvent,
  classifyStaleness,
  getStatus,
  readActionEvidence,
  readContract,
  readLedger,
  readLock,
  readSupervisorProcess,
  recoverLock,
  releaseLock,
  runDir,
  runEventsPath,
  writeLedger,
  writeSupervisorProcess,
  type LoopStatus,
  type LoopStoreDeps,
} from "./store.ts";
import type { LoopRunReadyContext } from "./handoff.ts";
import { reconcile, transitionItem, type ReconcileObserveDeps } from "./reconcile.ts";
import { blockItem } from "./recovery.ts";
import { waitItem } from "./pause.ts";
import { computeExternalDependencyStatuses, detectDependencyDeadlock, propagateSkips } from "./dependencies.ts";
import { detectChangedFileOverlap, selectSchedulableSet } from "./schedule.ts";
import { buildPreconditionExclusion, classifyPreconditionExclusions, excludeContractItems, hasNewLabelEvent, isBlockedInLabels, isPrePipelineStage, pipelineStageFromLabels } from "./precondition.ts";
import {
  LOOP_EXECUTION_CONTRACT_SCHEMA,
  normalizeLoopOutcome,
  type LoopExecutionRequest,
  type LoopExecutionResponse,
  type LoopTerminalOutcome,
} from "../loop-execution-contract.ts";
import {
  armProgressMirror,
  LOOP_ITEM_PROGRESS,
  type LoopItemProgressPayload,
  type ProgressMirrorDeps,
} from "./pre-merge-progress.ts";
import {
  applyAdvanceEventsToStageProgress,
  buildStageProgressTable,
  reconcileTerminalStageProgress,
  type AdvanceStageEvent,
  type StageProgressTableRow,
} from "./stage-progress.ts";

/** Optional hooks the production dispatch seam (or a test fake) may invoke
 *  during a whole-item hand-off. `onAdvanceLinked` fires when the advance
 *  run-store id is known — before or at the start of the child wait — so the
 *  supervisor can record durable start linkage mid-flight (#667). */
export interface DispatchItemHooks {
  onAdvanceLinked?(linkage: {
    item_id: string;
    pipeline_run_id: string;
    events: string;
  }): void | Promise<void>;
}

/** Loop event kinds for durable advance-run join keys (#667). Kept as
 *  module-local constants so harness consumers have stable strings without
 *  depending on pipeline.ts. */
export const LOOP_ITEM_ADVANCE_LINKED = "loop_item_advance_linked";
export const LOOP_ITEM_ADVANCE_FINISHED = "loop_item_advance_finished";
/** Shared progress kind for pre-merge gate sub-steps (#682) and future stage
 *  progress (#611). Re-exported from the mirror module for a single name. */
export { LOOP_ITEM_PROGRESS };

/** Terminal linkage payload from a successful contract response. Prefer the
 *  real evidence ids; never invent an events path when the response omitted one. */
export function buildTerminalLinkageFromResponse(
  itemId: string,
  outcome: LoopTerminalOutcome,
  response: LoopExecutionResponse,
): {
  item_id: string;
  pipeline_run_id: string;
  outcome: LoopTerminalOutcome;
  events?: string;
} {
  const payload: {
    item_id: string;
    pipeline_run_id: string;
    outcome: LoopTerminalOutcome;
    events?: string;
  } = {
    item_id: itemId,
    pipeline_run_id: response.evidence.pipeline_run_id,
    outcome,
  };
  if (response.evidence.events_path) {
    payload.events = response.evidence.events_path;
  }
  return payload;
}

/** The default run-level cycle watchdog bound (design.md decision 2),
 *  applied when a contract predates this capability or omits the field. */
export const DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT = 5;

/** Absolute backstop distinct from the no-progress watchdog — guards against
 *  a defect that always reports "progress" (e.g. a broken clock) from
 *  spinning the process forever. Real runs stop far short of this via the
 *  watchdog or a terminal condition. */
const MAX_CYCLES_SAFETY = 10_000;

// ---------------------------------------------------------------------------
// Injected seam.
// ---------------------------------------------------------------------------

/** Composes the store, live reconciliation, and the `pipeline/loop-execution@1`
 *  dispatch seam — no direct network/git/subprocess access. `dispatchItem` is
 *  the ONLY way the supervisor hands off an item; there is deliberately no
 *  per-stage verb on this interface. */
export interface SupervisorDeps {
  store: LoopStoreDeps;
  observe: ReconcileObserveDeps;
  /**
   * Whole-item hand-off only — never a per-stage verb. The optional second
   * `hooks` argument lets the production dispatch seam announce a pinned
   * advance run-store id before/at the child wait so the supervisor can append
   * start-linkage on the loop run trail (#667). Existing fakes may ignore it.
   */
  dispatchItem(request: LoopExecutionRequest, hooks?: DispatchItemHooks): Promise<LoopExecutionResponse>;
  /** The live changed-file-overlap seam (#530, capability
   *  `durable-run-independent-scheduler`): returns the paths an item's managed worktree actually
   *  changed versus base. Consulted only when more than one item is dispatched in the same cycle
   *  (i.e. concurrency is actually in effect) — absent by default, so the serialized default never
   *  requires it. */
  getChangedFiles?(itemId: string): Promise<string[]>;
  /** Best-effort hook invoked once `driveSupervisor` reaches a terminal stop
   *  or full completion — never on an outstanding pause/hold, since the run
   *  is not yet done there (capability `durable-run-blocker-auto-file`, #538).
   *  Any error this hook throws is caught and swallowed: it can never alter
   *  the drive result, the released lock, or the run's outcome. Absent by
   *  default — this module stays config/gh-free; the caller (e.g. `pipeline.ts`)
   *  supplies the actual auto-file behavior. */
  onDriveEnd?(result: DriveSupervisorResult): Promise<void>;
  /**
   * Optional pre-merge progress mirror seams (#682). When absent, production
   * uses `fs.readFile` for the advance events path and a short poll interval.
   * Unit tests inject a fake reader / short sleep without real FS or timers.
   */
  readAdvanceEventsFile?(eventsPath: string): Promise<string>;
  progressMirrorPollMs?: number;
  /** Override sleep used by the progress mirror (tests inject a no-op or immediate). */
  progressMirrorSleep?(ms: number): Promise<void>;
  /**
   * Full override of the progress-mirror arm (tests that feed sequenced advance
   * events without a background poll). When set, replaces `armProgressMirror`.
   */
  armProgressMirror?(
    linkage: { item_id: string; pipeline_run_id: string; events?: string },
    deps: ProgressMirrorDeps,
  ): { stop: () => Promise<void> };
  /**
   * Read advance run-store events for stage-progress observation (#611).
   * Injected so unit tests never touch the real FS or a live child process.
   * When absent, mid-wait stage projection is not updated (terminal reconcile
   * still runs when a real advance_run_id is known from linkage).
   */
  readAdvanceEvents?(eventsPath: string): Promise<AdvanceStageEvent[]>;
  /** Poll interval (ms) while observing advance stage events during dispatch wait. */
  stageProgressPollMs?: number;
  /** Injectable sleep for stage-progress polling (tests inject a no-op / immediate). */
  sleep?(ms: number): Promise<void>;
}

/** Default poll interval while observing a linked advance events.jsonl mid-wait. */
export const DEFAULT_STAGE_PROGRESS_POLL_MS = 250;

// ---------------------------------------------------------------------------
// Internal ledger mutations not already exposed by recovery.ts/pause.ts —
// pending -> in_progress (item selection) and in_progress -> abandoned (a
// direct `abandoned` execution outcome, distinct from abandonHold's
// paused/waiting precondition). Neither is a pipeline stage-label write or a
// merge — both are the durable-loop-engine's own item state, a different
// state machine entirely from the per-item advance loop's GitHub labels.
// ---------------------------------------------------------------------------

async function startItem(
  store: LoopStoreDeps,
  input: { runId: string; token: string; itemId: string; engine: LoopEngineName },
): Promise<LoopLedger> {
  const ledger = await readLedger(store, input.runId);
  const item = ledger.items[input.itemId];
  if (!item || item.state !== "pending") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot start from state "${item?.state}" — only a pending item may start`,
    );
  }
  const time = store.now().toISOString();
  const updated: LoopItemLedgerEntry = {
    ...item,
    state: "in_progress",
    history: [...item.history, { time, from: item.state, to: "in_progress", engine: input.engine }],
  };
  const newLedger: LoopLedger = { ...ledger, items: { ...ledger.items, [input.itemId]: updated } };
  await writeLedger(store, newLedger, input.token);
  await appendEvent(store, input.runId, input.token, "loop_item_started", { item_id: input.itemId });
  return newLedger;
}

async function abandonInProgressItem(
  store: LoopStoreDeps,
  runId: string,
  token: string,
  itemId: string,
  engine: LoopEngineName,
): Promise<LoopLedger> {
  const ledger = await readLedger(store, runId);
  const item = ledger.items[itemId];
  if (!item || item.state !== "in_progress") {
    throw new LoopError(
      "validation",
      `item "${itemId}" cannot abandon from state "${item?.state}" — only an in_progress item may be abandoned this way`,
    );
  }
  const time = store.now().toISOString();
  const updated: LoopItemLedgerEntry = {
    ...item,
    state: "abandoned",
    history: [...item.history, { time, from: "in_progress", to: "abandoned", engine, note: "pipeline/loop-execution@1 reported abandoned" }],
  };
  const newLedger: LoopLedger = { ...ledger, items: { ...ledger.items, [itemId]: updated } };
  await writeLedger(store, newLedger, token);
  await appendEvent(store, runId, token, "loop_item_abandoned", { item_id: itemId, from: "in_progress" });
  return newLedger;
}

/** Reverts a dispatched item that turned out to still be pre-pipeline back to `pending`, instead
 *  of the terminal `abandoned`/`blocked` families — the dispatch-outcome safety net (#568,
 *  capability `loop-precondition-stage-gate`, design.md decision 3). Deliberately skips the
 *  "already stopped" guard `transitionItem`/`blockItem` enforce (mirroring `startItem`/
 *  `abandonInProgressItem` above): Pass 2 must still durably classify every dispatched item even
 *  after an earlier sibling in the same pass recorded a genuine-defect run stop. */
async function excludeInProgressItem(
  store: LoopStoreDeps,
  input: { runId: string; token: string; itemId: string; engine: LoopEngineName; exclusion: LoopPreconditionExclusion },
): Promise<LoopLedger> {
  const ledger = await readLedger(store, input.runId);
  const item = ledger.items[input.itemId];
  if (!item || item.state !== "in_progress") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot be precondition-excluded from state "${item?.state}" — only an in_progress item may revert this way`,
    );
  }
  const time = store.now().toISOString();
  const updated: LoopItemLedgerEntry = {
    ...item,
    state: "pending",
    history: [
      ...item.history,
      {
        time,
        from: "in_progress",
        to: "pending",
        engine: input.engine,
        note: `precondition exclusion: required ${input.exclusion.required_stage}, observed ${input.exclusion.observed_stage}`,
      },
    ],
  };
  const newLedger: LoopLedger = { ...ledger, items: { ...ledger.items, [input.itemId]: updated } };
  await writeLedger(store, newLedger, input.token);
  await appendEvent(store, input.runId, input.token, "loop_item_precondition_excluded", input.exclusion);
  return newLedger;
}

/**
 * Revert a pure worktree-capacity dispatch (#718) from `in_progress` back to
 * `pending` without a product needs-human hold. The item stays schedulable once
 * capacity frees (park-release of siblings or active work completing).
 */
async function revertCapacityWaitItem(
  store: LoopStoreDeps,
  input: { runId: string; token: string; itemId: string; engine: LoopEngineName },
): Promise<LoopLedger> {
  const ledger = await readLedger(store, input.runId);
  const item = ledger.items[input.itemId];
  if (!item || item.state !== "in_progress") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot capacity-revert from state "${item?.state}" — only an in_progress item may revert this way`,
    );
  }
  const time = store.now().toISOString();
  const updated: LoopItemLedgerEntry = {
    ...item,
    state: "pending",
    history: [
      ...item.history,
      {
        time,
        from: "in_progress",
        to: "pending",
        engine: input.engine,
        note: "worktree capacity admission wait — reverted to pending (no product needs-human hold)",
      },
    ],
  };
  const newLedger: LoopLedger = { ...ledger, items: { ...ledger.items, [input.itemId]: updated } };
  await writeLedger(store, newLedger, input.token);
  await appendEvent(store, input.runId, input.token, "loop_item_capacity_wait", {
    item_id: input.itemId,
  });
  return newLedger;
}

const DONE_OR_ABANDONED = new Set(["ready", "merged", "released", "deployed", "abandoned", "skipped"]);

/** Every item currently held (`paused`/`waiting`) in `ledger`, sorted for deterministic
 *  reporting (#581, capability `loop-blocked-item-hold-continuation`). */
function heldItemIdsFromLedger(ledger: LoopLedger): string[] {
  return Object.values(ledger.items)
    .filter((i) => i.state === "paused" || i.state === "waiting")
    .map((i) => i.id)
    .sort();
}

/** Renders a {@link LoopPreconditionExclusion} into the reason string carried on the terminal
 *  summary — the same `precondition:required=<stage>,observed=<stage>` form the action-evidence
 *  entry already records (capability `loop-terminal-exclusion-disclosure`, #614). */
function formatExclusionReason(exclusion: LoopPreconditionExclusion): string {
  return `precondition:required=${exclusion.required_stage},observed=${exclusion.observed_stage}`;
}

/** The exclusion reason recorded for the greatest number of `exclusions`, ties broken
 *  lexicographically by the reason string (design.md decision 3, #614) — a pure function of the
 *  exclusion set so identical run state always renders an identical summary. Null when
 *  `exclusions` is empty. */
export function dominantExclusionReason(exclusions: readonly LoopPreconditionExclusion[]): string | null {
  if (exclusions.length === 0) return null;
  const counts = new Map<string, number>();
  for (const exclusion of exclusions) {
    const reason = formatExclusionReason(exclusion);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const reason of [...counts.keys()].sort()) {
    const count = counts.get(reason)!;
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/** True when at least one `pending` item remains in `schedulableContract` — the post-precondition
 *  eligible frontier scheduling itself already consults — i.e. there is still work a future cycle
 *  could pick up. Used to tell "an item just entered a hold, but siblings are still queued" apart
 *  from "nothing is left to try but a hold" (#581). `schedulableContract` has precondition-excluded
 *  items already carved out, so such a sibling — still `pending` in the raw ledger but unreachable
 *  by the scheduler — correctly does not suppress the terminal hold (review 2, finding b38ac1b0566a5373).
 *  A `pending` item permanently excluded by a dependency on a non-run-fatal blocked item is
 *  intentionally still counted here — that dependency deadlock is the pre-existing no-progress
 *  watchdog's concern, not this check's. */
function hasSchedulableWorkRemaining(schedulableContract: LoopContract, ledger: LoopLedger): boolean {
  return schedulableContract.items.some((item) => ledger.items[item.id]?.state === "pending");
}

/** Reconciliation-driven re-admission for a cleared pipeline-blocked hold (#581 review 2, finding
 *  016d467e9d176c6f). A held (`paused`/`waiting`) item whose hold was entered for the
 *  `pipeline_blocked_label` disposition (see `LoopHumanInputRequest.source`) is checked against a
 *  fresh live-label read every cycle; once `pipeline:blocked` is no longer present the item
 *  transitions back to `pending` and rejoins the executable frontier this same cycle. A hold
 *  entered for any other reason (no discriminator) is left untouched — only a human resume can
 *  clear it. */
async function reopenClearedBlockedHolds(
  deps: SupervisorDeps,
  runId: string,
  token: string,
  engine: LoopEngineName,
  ledger: LoopLedger,
): Promise<LoopLedger> {
  const candidates = Object.values(ledger.items).filter(
    (i) => (i.state === "waiting" || i.state === "paused") && i.hold_request?.source === "pipeline_blocked_label",
  );
  for (const item of candidates) {
    let labels: string[];
    try {
      const issue = await deps.observe.getIssueStateAndLabels(Number(item.id));
      labels = issue?.labels ?? [];
    } catch {
      // The live observation failed — leave the hold in place rather than guessing it cleared.
      continue;
    }
    if (isBlockedInLabels(labels)) continue;

    const current = ledger.items[item.id];
    if (!current || (current.state !== "waiting" && current.state !== "paused")) continue;
    const time = deps.store.now().toISOString();
    const updated: LoopItemLedgerEntry = {
      ...current,
      state: "pending",
      hold_request: undefined,
      history: [
        ...current.history,
        {
          time,
          from: current.state,
          to: "pending",
          engine,
          note: "pipeline:blocked label cleared — hold re-admitted to the executable frontier (capability loop-blocked-item-hold-continuation)",
        },
      ],
    };
    ledger = { ...ledger, items: { ...ledger.items, [item.id]: updated } };
    await writeLedger(deps.store, ledger, token);
    await appendEvent(deps.store, runId, token, "loop_item_hold_cleared", { item_id: item.id });
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// One drive cycle.
// ---------------------------------------------------------------------------

export interface SupervisorCycleResult {
  progress: boolean;
  /** Set when this cycle recorded a terminal stop (including the watchdog's
   *  own — that is charged by the caller, driveSupervisor, not here). */
  stop: LoopStopRecord | null;
  holdOutstanding: boolean;
  allDone: boolean;
  /** Every item currently held (`paused`/`waiting`) this cycle — populated whenever at least one
   *  item is held, regardless of whether `holdOutstanding` is the terminal condition this cycle
   *  (capability `loop-blocked-item-hold-continuation`, #581). Empty when no item is held. */
  heldItemIds: string[];
}

/** Runs exactly one supervisor cycle: reconcile -> select at most one
 *  dependency-ready active item (respecting `max_active_items: 1`) ->
 *  dispatch via `pipeline/loop-execution@1` -> record the outcome through the
 *  engine's transition/recovery paths. Appends exactly one action-evidence
 *  entry. Never sets a pipeline stage label and never merges. */
export async function runSupervisorCycle(
  deps: SupervisorDeps,
  runId: string,
  token: string,
  engine: LoopEngineName,
): Promise<SupervisorCycleResult> {
  const contract = await readContract(deps.store, runId);
  let ledger = await readLedger(deps.store, runId);

  if (ledger.stop) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "stop",
      outcome: ledger.stop.reason,
      next_action: null,
      progress: "no_progress",
    });
    return { progress: false, stop: ledger.stop, holdOutstanding: false, allDone: false, heldItemIds: heldItemIdsFromLedger(ledger) };
  }

  let drifted = false;
  try {
    const reconciliation = await reconcile(deps.store, deps.observe, { runId, token, engine });
    drifted = reconciliation.drift.length > 0;
  } catch (err) {
    if (err instanceof LoopError && err.loopFailureClass === "stop") {
      ledger = await readLedger(deps.store, runId);
      await appendActionEvidence(deps.store, runId, token, {
        item_id: null,
        action: "stop",
        outcome: ledger.stop?.reason ?? "stop",
        next_action: null,
        progress: "no_progress",
      });
      return { progress: false, stop: ledger.stop, holdOutstanding: false, allDone: false, heldItemIds: heldItemIdsFromLedger(ledger) };
    }
    throw err;
  }

  ledger = await readLedger(deps.store, runId);
  if (ledger.stop) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "stop",
      outcome: ledger.stop.reason,
      next_action: null,
      progress: "progress",
    });
    return { progress: true, stop: ledger.stop, holdOutstanding: false, allDone: false, heldItemIds: heldItemIdsFromLedger(ledger) };
  }

  // Dependency integrity (#513, capability `durable-run-dependency-integrity`): verify every
  // external dependency against live truth, then propagate a terminal `skipped` to the
  // transitive dependents of any dependency (in-run or external) that just terminated
  // non-successfully — before the allDone/eligibility checks below, so a fully-resolved run
  // completes and a skip is never mistaken for a stalled `pending` item.
  const externalStatuses = await computeExternalDependencyStatuses(deps.observe, contract);
  const propagation = propagateSkips(contract, ledger, externalStatuses, () => deps.store.now().toISOString(), engine);
  if (propagation.skippedItemIds.length > 0) {
    ledger = propagation.ledger;
    await writeLedger(deps.store, ledger, token);
    for (const itemId of propagation.skippedItemIds) {
      await appendEvent(deps.store, runId, token, "loop_item_skipped", { item_id: itemId });
    }
  }
  const propagated = propagation.skippedItemIds.length > 0;

  // Precondition stage gate (#568, capability `loop-precondition-stage-gate`): a pending item
  // not yet at the `pipeline:ready` precondition (still `pipeline:backlog`, or no `pipeline:*`
  // label) is excluded from the executable frontier every cycle, re-evaluated against the fresh
  // reconciliation observation above — never frozen, never a `blocked` transition, never
  // run-fatal. See loop/precondition.ts.
  const preconditionExclusions = classifyPreconditionExclusions(contract, ledger);
  const preconditionExcludedIds = new Set(preconditionExclusions.map((e) => e.item_id));
  for (const exclusion of preconditionExclusions) {
    await appendEvent(deps.store, runId, token, "loop_item_precondition_excluded", exclusion);
    await appendActionEvidence(deps.store, runId, token, {
      item_id: exclusion.item_id,
      action: "exclude_item",
      outcome: `precondition:required=${exclusion.required_stage},observed=${exclusion.observed_stage}`,
      next_action: ledger.last_reconciliation?.next_actions[exclusion.item_id] ?? null,
      progress: "no_progress",
    });
  }
  // The scheduling-input view every eligibility/dependency computation below consults instead of
  // `contract` — a precondition-excluded item is never admitted to the frontier and never
  // considered a dependency-deadlock participant in its own right (ledger reads for *other*
  // items' `depends_on` edges are unaffected: they read `ledger.items`, not `contract.items`).
  const schedulableContract = excludeContractItems(contract, preconditionExcludedIds);

  // Needs-human hold continuation (#581, capability `loop-blocked-item-hold-continuation`): a
  // pipeline-blocked hold (`hold_request.source === "pipeline_blocked_label"`) is re-admitted to
  // `pending` here, against this cycle's fresh live-label read, the moment the `pipeline:blocked`
  // label is no longer present — so a hold a human clears out-of-band between cycles rejoins the
  // frontier instead of remaining excluded forever (review 2, finding 016d467e9d176c6f). A hold
  // entered for any other reason is left untouched and stays outside the `pending` frontier
  // `eligibleIndependentItems` already applies (a paused/waiting item is never `pending`), never
  // carved out of `contract`/`schedulableContract`, and never itself a terminal condition while
  // another item can still make progress.
  ledger = await reopenClearedBlockedHolds(deps, runId, token, engine, ledger);
  const heldItemIds = heldItemIdsFromLedger(ledger);

  // A run is fully resolved once every item is done/abandoned OR precondition-excluded — an
  // all-backlog (or all-excluded) work list completes with an all-excluded report instead of
  // spinning toward the no-progress watchdog (design.md decision 1's stated trade-off).
  const allDone = contract.items.every((i) => {
    const state = ledger.items[i.id]?.state ?? "";
    return DONE_OR_ABANDONED.has(state) || preconditionExcludedIds.has(i.id);
  });
  if (allDone) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "noop",
      outcome: preconditionExcludedIds.size > 0 ? "all_items_done_or_excluded" : "all_items_done",
      next_action: null,
      progress: drifted || propagated ? "progress" : "no_progress",
    });
    return { progress: drifted || propagated, stop: null, holdOutstanding: false, allDone: true, heldItemIds };
  }

  let activeItemIds = Object.values(ledger.items).filter((i) => i.state === "in_progress").map((i) => i.id);

  if (activeItemIds.length === 0) {
    // The independent-set scheduler (#530, capability `durable-run-independent-scheduler`)
    // replaces the prior bare `eligible[0]` pick. Absent a `concurrency` run policy (or a budget
    // of one) it still ever admits at most one item — the same item `eligible[0]` would have
    // picked pre-#530 — so the serialized default's observable selection is unchanged; it
    // additionally now records a durable allow/deny rationale for every eligible candidate.
    const decision = selectSchedulableSet({ contract: schedulableContract, ledger, externalStatuses });
    if (decision.rationale.length > 0) {
      // This durable event is the sole source the run-scoped parallelization decision ledger
      // (#528, loop/parallelization-ledger.ts) accumulates from — it adds no second write path;
      // see openspec/changes/conflict-aware-parallel-execution/design.md.
      await appendEvent(deps.store, runId, token, "loop_schedule_evaluated", decision);
    }
    for (const itemId of decision.selected) {
      ledger = await startItem(deps.store, { runId, token, itemId, engine });
    }
    activeItemIds = decision.selected;
  }

  if (activeItemIds.length === 0) {
    const deadlockChain = detectDependencyDeadlock(schedulableContract, ledger, externalStatuses);
    if (deadlockChain) {
      const time = deps.store.now().toISOString();
      const stop: LoopStopRecord = {
        reason: "dependency_deadlock",
        time,
        deadlock_chain: deadlockChain,
        outstanding_ready: outstandingReadyItemIds(ledger),
      };
      const newLedger: LoopLedger = { ...ledger, stop };
      await writeLedger(deps.store, newLedger, token);
      await appendEvent(deps.store, runId, token, "loop_run_stopped", { reason: "dependency_deadlock", deadlock_chain: deadlockChain });
      await appendActionEvidence(deps.store, runId, token, {
        item_id: null,
        action: "stop",
        outcome: "dependency_deadlock",
        next_action: null,
        progress: "progress",
      });
      return { progress: true, stop, holdOutstanding: false, allDone: false, heldItemIds };
    }

    // Terminal outstanding-hold condition (#581, capability `loop-blocked-item-hold-continuation`):
    // reached only once the scheduler above already found nothing dispatchable this cycle (no
    // `pending` item is currently eligible — dependency-blocked pending items fall through to the
    // `no_eligible_item` no-op below unaffected) AND at least one item is held. A hold never halts
    // the run on its own while a sibling is still schedulable — that case dispatches below instead
    // of reaching this branch at all.
    if (heldItemIds.length > 0) {
      await appendActionEvidence(deps.store, runId, token, {
        item_id: null,
        action: "noop",
        outcome: `hold_outstanding:${heldItemIds.join(",")}`,
        next_action: "hold-for-human",
        progress: "no_progress",
      });
      return { progress: drifted || propagated, stop: null, holdOutstanding: true, allDone: false, heldItemIds };
    }

    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "noop",
      outcome: "no_eligible_item",
      next_action: null,
      progress: drifted || propagated ? "progress" : "no_progress",
    });
    return { progress: drifted || propagated, stop: null, holdOutstanding: false, allDone: false, heldItemIds };
  }

  // Dispatch every admitted item concurrently through the unchanged, per-item
  // `pipeline/loop-execution@1` contract — each item is driven against its own managed worktree
  // by that seam exactly as it already is today. `Promise.allSettled` (not `Promise.all`) is
  // deliberate (#530 review 1 finding 01db9f2b): a rejected dispatch must never discard a
  // concurrently-completed sibling's response, so every item's outcome — success or rejection —
  // is classified below rather than the whole cycle throwing on the first rejection.
  const buildRequest = (itemId: string): LoopExecutionRequest => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: itemId,
    repo: contract.repo,
    engine,
    worktree_policy: contract.worktree_policy,
    done_definition: contract.done_definition,
    run_id: runId,
  });
  // Captured before dispatch so the zero-transition safety net below (#568 review 2 finding
  // 8bb189a0) can diff the issue's GitHub-authored label-add history across the dispatch window,
  // rather than inferring "zero transitions" from equal before/after stage snapshots — a
  // round-trip (e.g. backlog -> ready -> backlog) defeats snapshot equality. A failed fetch here
  // leaves this item with no baseline; the safety net below then cannot prove a no-op and falls
  // through to genuine-defect classification rather than risk masking a real dispatch (#568
  // review 1 finding f09d500c: comparing GitHub-authored event times against the supervisor
  // host's local clock is unsound under clock skew, so both snapshots here are GitHub-authored —
  // never compared against `deps.observe.now()`).
  const labelEventsBeforeDispatchByItem = new Map<string, { label: string; createdAt: string }[]>();
  await Promise.allSettled(
    activeItemIds.map(async (itemId) => {
      const events = await deps.observe.getLabelEvents(Number(itemId));
      labelEventsBeforeDispatchByItem.set(itemId, events);
    }),
  );
  // Per-item dispatch with durable advance-run linkage (#667), mid-wait
  // stage-progress observation (#611), and optional pre-merge progress mirror
  // (#682): start linkage via `onAdvanceLinked`, poll advance events for stage
  // changes, mirror material pre-merge gate outcomes as `loop_item_progress`,
  // terminal linkage after the response (or rejection) settles.
  const settled = await Promise.allSettled(
    activeItemIds.map(async (itemId) => {
      let startLinkage: { item_id: string; pipeline_run_id: string; events: string } | null = null;
      let progressMirror: { stop: () => Promise<void> } | null = null;
      const stopMirror = async (): Promise<void> => {
        if (!progressMirror) return;
        const m = progressMirror;
        progressMirror = null;
        try {
          await m.stop();
        } catch {
          // best-effort — never fail the advance child for mirror I/O
        }
      };
      let stopObserve = false;
      let observePromise: Promise<void> = Promise.resolve();
      let eventOffset = 0;

      const drainAdvanceEvents = async () => {
        if (!startLinkage || !deps.readAdvanceEvents) return;
        try {
          const events = await deps.readAdvanceEvents(startLinkage.events);
          if (events.length <= eventOffset) return;
          const result = await applyAdvanceEventsToStageProgress(deps.store, {
            runId,
            token,
            itemId,
            advance_run_id: startLinkage.pipeline_run_id,
            events,
            fromIndex: eventOffset,
          });
          eventOffset = result.nextIndex;
        } catch {
          // Observation is best-effort: a read/parse failure must never fail the dispatch.
        }
      };

      const startObserver = () => {
        if (!deps.readAdvanceEvents || !startLinkage) return;
        const pollMs = deps.stageProgressPollMs ?? DEFAULT_STAGE_PROGRESS_POLL_MS;
        const sleepFn =
          deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        observePromise = (async () => {
          // Immediate drain, then poll until the child wait ends.
          await drainAdvanceEvents();
          while (!stopObserve) {
            await sleepFn(pollMs);
            if (stopObserve) break;
            await drainAdvanceEvents();
          }
          // Final drain after stop so events that landed at exit are not lost.
          await drainAdvanceEvents();
        })();
      };

      try {
        const response = await deps.dispatchItem(buildRequest(itemId), {
          onAdvanceLinked: async (linkage) => {
            startLinkage = linkage;
            await appendEvent(deps.store, runId, token, LOOP_ITEM_ADVANCE_LINKED, {
              item_id: linkage.item_id,
              pipeline_run_id: linkage.pipeline_run_id,
              events: linkage.events,
            });
            // Arm pre-merge progress mirror against the absolute advance events
            // path. Append failures are non-fatal (same spirit as appendEvent).
            if (linkage.events) {
              const appendProgress = async (payload: LoopItemProgressPayload): Promise<void> => {
                try {
                  await appendEvent(deps.store, runId, token, LOOP_ITEM_PROGRESS, payload);
                } catch {
                  // non-fatal
                }
              };
              const mirrorDeps: ProgressMirrorDeps = {
                readAdvanceEventsFile:
                  deps.readAdvanceEventsFile ??
                  (async (eventsPath: string) => {
                    try {
                      return await defaultReadFile(eventsPath, "utf8");
                    } catch (err) {
                      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
                      throw err;
                    }
                  }),
                appendProgress,
                sleep:
                  deps.progressMirrorSleep ??
                  ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
                pollIntervalMs: deps.progressMirrorPollMs,
              };
              const arm = deps.armProgressMirror ?? armProgressMirror;
              progressMirror = arm(
                {
                  item_id: linkage.item_id,
                  pipeline_run_id: linkage.pipeline_run_id,
                  events: linkage.events,
                },
                mirrorDeps,
              );
            }
            // Observe stage progress only after the real advance store is confirmed.
            startObserver();
          },
        });
        await stopMirror();
        stopObserve = true;
        await observePromise.catch(() => {});
        const outcome = normalizeLoopOutcome(response.outcome);
        await appendEvent(deps.store, runId, token, LOOP_ITEM_ADVANCE_FINISHED, buildTerminalLinkageFromResponse(itemId, outcome, response));
        // Terminal stage presentation reconcilable with coarse state mapping.
        const advanceRunId =
          response.evidence.pipeline_run_id &&
          !String(response.evidence.pipeline_run_id).startsWith("pipeline-loop-")
            ? response.evidence.pipeline_run_id
            : startLinkage?.pipeline_run_id;
        await reconcileTerminalStageProgress(deps.store, {
          runId,
          token,
          itemId,
          outcome,
          ...(advanceRunId ? { advance_run_id: advanceRunId } : {}),
        }).catch(() => {});
        return response;
      } catch (err) {
        await stopMirror();
        stopObserve = true;
        await observePromise.catch(() => {});
        // Rejection path: still record terminal failure linkage. When start
        // linkage fired, echo the same ids; otherwise omit events/path so we
        // never invent a live join to a non-existent store.
        const terminal: {
          item_id: string;
          outcome: LoopTerminalOutcome;
          pipeline_run_id?: string;
          events?: string;
        } = {
          item_id: itemId,
          outcome: "failed",
        };
        if (startLinkage) {
          terminal.pipeline_run_id = startLinkage.pipeline_run_id;
          terminal.events = startLinkage.events;
        }
        await appendEvent(deps.store, runId, token, LOOP_ITEM_ADVANCE_FINISHED, terminal);
        await reconcileTerminalStageProgress(deps.store, {
          runId,
          token,
          itemId,
          outcome: "failed",
          ...(startLinkage ? { advance_run_id: startLinkage.pipeline_run_id } : {}),
        }).catch(() => {});
        throw err;
      }
    }),
  );

  // With exactly one active item — the serialized default — a rejection is rethrown synchronously
  // rather than durably reclassified "failed": the durable-run-independent-scheduler spec requires
  // the serialized default's observable behavior to be byte-identical to the pre-#530 behavior
  // (`Promise.all` on a single-element array propagates its rejection the same way), which existing
  // crash-recovery callers already depend on. Reclassification below exists only to protect a
  // sibling's outcome when concurrency is actually in effect — there is no sibling to protect here.
  if (activeItemIds.length === 1 && settled[0].status === "rejected") {
    throw settled[0].reason;
  }

  const rawOutcomeByItem = new Map<string, unknown>();
  const outcomeByItem = new Map<string, ReturnType<typeof normalizeLoopOutcome>>();
  const dispatchErrorByItem = new Map<string, string>();
  const worktreeRootByItem = new Map<string, string | null>();
  activeItemIds.forEach((itemId, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      rawOutcomeByItem.set(itemId, result.value.outcome);
      outcomeByItem.set(itemId, normalizeLoopOutcome(result.value.outcome));
      worktreeRootByItem.set(itemId, result.value.evidence.worktree_root ?? null);
    } else {
      dispatchErrorByItem.set(itemId, result.reason instanceof Error ? result.reason.message : String(result.reason));
      outcomeByItem.set(itemId, "failed");
    }
  });

  // Changed-file-overlap parking (#530 task 4): a post-run safety net over declared ownership,
  // meaningful only when more than one item actually ran concurrently this cycle and the caller
  // supplies the live changed-files seam. Parking never merges, pushes, or deletes a
  // branch/worktree — it reuses the existing "workflow-state" blocked class so a parked item
  // recovers through the already-tested block/recover machinery instead of inventing a new state.
  // `Promise.allSettled` (not sequential awaits) is deliberate (#530 review 2 finding 0526bc5f): a
  // rejected worktree/git observation for one item must never abort classification for the whole
  // cycle, which would otherwise leave every dispatched item — including already-`ready_to_deploy`
  // siblings — stranded `in_progress` and eligible for duplicate redispatch. An item whose
  // observation itself fails cannot be proven non-overlapping, so it is conservatively parked
  // alongside any item found to actually overlap.
  let parkedItemIds = new Set<string>();
  const unobservedItemIds = new Set<string>();
  if (activeItemIds.length > 1 && deps.getChangedFiles) {
    const getChangedFiles = deps.getChangedFiles;
    const settledObservations = await Promise.allSettled(activeItemIds.map((itemId) => getChangedFiles(itemId)));
    const actualChangedFiles: Record<string, readonly string[]> = {};
    settledObservations.forEach((result, i) => {
      const itemId = activeItemIds[i];
      if (result.status === "fulfilled") {
        actualChangedFiles[itemId] = result.value;
      } else {
        unobservedItemIds.add(itemId);
      }
    });
    const overlap = detectChangedFileOverlap(actualChangedFiles);
    const affectedItemIds = new Set([...overlap.affected_item_ids, ...unobservedItemIds]);
    if (affectedItemIds.size > 0) {
      parkedItemIds = affectedItemIds;
      const reasonParts: string[] = [];
      if (unobservedItemIds.size > 0) {
        reasonParts.push(`changed-file observation failed for item(s) ${[...unobservedItemIds].join(", ")} — conservatively parked as unproven`);
      }
      if (overlap.overlapping_paths.length > 0) {
        reasonParts.push(`observed changed-file overlap not predicted by declared ownership: ${overlap.overlapping_paths.join(", ")}`);
      }
      await appendEvent(deps.store, runId, token, "loop_replan_requested", {
        time: deps.store.now().toISOString(),
        affected_item_ids: [...affectedItemIds].sort(),
        overlapping_paths: overlap.overlapping_paths,
        reason: reasonParts.join("; "),
      });
    }
  }

  // Pass 1 — persist every outcome that can never itself set a terminal run stop
  // (ready_to_deploy, abandoned) for EVERY dispatched item first. transitionItem and
  // abandonInProgressItem never write `ledger.stop`, so this pass always completes in full
  // regardless of what pass 2 below does — a sibling's already-completed independent result is
  // never stranded unpersisted behind another item's block-induced stop (#530 review 1 findings
  // 01db9f2b, 507013f5).
  for (const itemId of activeItemIds) {
    if (parkedItemIds.has(itemId)) continue;
    const outcome = outcomeByItem.get(itemId)!;
    if (outcome !== "ready_to_deploy" && outcome !== "abandoned") continue;
    const nextAction = ledger.last_reconciliation?.next_actions[itemId] ?? null;

    if (outcome === "ready_to_deploy") {
      ledger = await transitionItem(deps.store, deps.observe, contract, {
        runId,
        token,
        itemId,
        engine,
        to: "ready",
        note: "pipeline/loop-execution@1 reported ready_to_deploy",
      });
    } else {
      ledger = await abandonInProgressItem(deps.store, runId, token, itemId, engine);
    }

    await appendActionEvidence(deps.store, runId, token, {
      item_id: itemId,
      action: "dispatch_item",
      outcome,
      next_action: nextAction,
      progress: "progress",
      worktree_root: worktreeRootByItem.get(itemId) ?? null,
    });
  }

  // Pass 2 — items requiring a block-family mutation (parked, blocked_needs_human, capacity_wait,
  // failed), which may record a terminal run stop. A prior item in this pass may already have
  // recorded one; every subsequent block/classify call below passes `allowAlreadyStopped: true`
  // (#530 review 2 finding a7abc98c) so it still durably classifies its own item — preserving the
  // first-cause stop record rather than overwriting it — instead of being refused and left
  // `in_progress` (which would make it eligible for duplicate dispatch on a later recovery/resume).
  // A stopped run never dispatches again once this cycle returns, so classifying every sibling
  // here causes no duplicate work.
  const capacityWaitItemIds: string[] = [];
  for (const itemId of activeItemIds) {
    const outcome = outcomeByItem.get(itemId)!;
    if (!parkedItemIds.has(itemId) && (outcome === "ready_to_deploy" || outcome === "abandoned")) continue;

    const nextAction = ledger.last_reconciliation?.next_actions[itemId] ?? null;
    let evidenceOutcome: string = parkedItemIds.has(itemId) ? "parked_for_replan" : outcome;

    if (parkedItemIds.has(itemId)) {
      ledger = await blockItem(deps.store, contract, {
        runId,
        token,
        itemId,
        engine,
        blockerClass: "workflow-state",
        evidence: unobservedItemIds.has(itemId)
          ? "parked for replan: changed-file observation failed for this item, so independence could not be proven"
          : "parked for replan: observed changed-file overlap with a concurrently-run item",
        allowAlreadyStopped: true,
      });
    } else if (outcome === "capacity_wait") {
      // Pure worktree capacity (#718): ops admission, not product needs-human.
      // Revert the item to pending and (after this pass) stop admission with
      // worktree_capacity so remaining pending items are not cascade-labeled.
      ledger = await revertCapacityWaitItem(deps.store, { runId, token, itemId, engine });
      capacityWaitItemIds.push(itemId);
      evidenceOutcome = "capacity_wait";
    } else if (outcome === "blocked_needs_human") {
      // A needs-human pipeline blocker (#570, capability `loop-needs-human-blocker-disposition`):
      // the standard operator remediation is a one-line unblock + re-run, not an engine defect.
      // Routed to the non-terminal paused/waiting hold — never `missing-authority` /
      // `workflow-engine-defect` — so the run pauses with `hold_outstanding=true` and every
      // sibling item's state (including one already `ready`) is preserved.
      //
      // `source: "pipeline_blocked_label"` is only set once a live-label read confirms
      // `pipeline:blocked` is actually present — that discriminator is what
      // `reopenClearedBlockedHolds` uses to auto-reopen the hold once the label clears. A generic
      // `blocked_needs_human` outcome (a plan/user-input blocker with no live blocked label) must
      // NOT carry that discriminator, or the very next cycle would read "no blocked label" and
      // re-admit it to `pending` for redispatch instead of leaving it held for a human (#581 review
      // 1, finding fcb03bcd04fc9b04).
      let liveBlockedLabel = false;
      try {
        const issue = await deps.observe.getIssueStateAndLabels(Number(itemId));
        liveBlockedLabel = isBlockedInLabels(issue?.labels ?? []);
      } catch {
        // Live observation failed — leave `liveBlockedLabel` false so the hold stays
        // human-resume-only rather than guessing the label is present.
      }
      ledger = await waitItem(deps.store, {
        runId,
        token,
        itemId,
        engine,
        request: {
          kind: "answer",
          prompt: `pipeline/loop-execution@1 reported blocked_needs_human for item ${itemId} — needs a human answer/unblock before this item can resume`,
          ...(liveBlockedLabel ? { source: "pipeline_blocked_label" as const } : {}),
        },
        note: "needs-human pipeline blocker (capability loop-needs-human-blocker-disposition)",
      });
    } else {
      // "failed" — either reported directly, a rejected dispatch, or normalized from an outcome
      // outside the defined terminal set (LOOP_TERMINAL_OUTCOMES). Before classifying this as a
      // genuine engine defect, check two dispatch-outcome safety nets — the precondition no-op net
      // (#568, capability `loop-precondition-stage-gate`, design.md decision 3) and the
      // needs-human blocker-disposition net (#570, capability
      // `loop-needs-human-blocker-disposition`): the frontier gate above is the primary defense
      // for the former, but a pre-pipeline item could in principle still reach dispatch (e.g. a
      // race where an operator flips the label back), and a plan-review/format blocker can report
      // `failed` instead of `blocked_needs_human` depending on how the dispatch seam surfaces it.
      // A rejected/crashed dispatch never has a live issue response to check, so it always remains
      // a genuine defect below.
      const dispatchError = dispatchErrorByItem.get(itemId);
      let preconditionNoOp = false;
      let needsHumanBlockerNoOp = false;
      if (!dispatchError) {
        try {
          const issue = await deps.observe.getIssueStateAndLabels(Number(itemId));
          const observedStage = pipelineStageFromLabels(issue?.labels ?? []);
          // Zero-transition check (#568 review 2, finding 8bb189a0; review 1 finding f09d500c): a
          // pre-pipeline outcome is only a genuine no-op when the dispatch made zero stage
          // transitions. Comparing only the before/after stage snapshots is insufficient — a
          // dispatch that round-trips (e.g. backlog -> ready -> backlog) before failing would show
          // equal endpoints despite a real transition occurring. Diff the issue's authoritative
          // label-add history against the pre-dispatch snapshot captured above instead of a local
          // clock cutoff — both sides of the comparison are GitHub-authored, so host/GitHub clock
          // skew cannot misclassify a real round-trip as a no-op. A missing pre-dispatch baseline
          // (that fetch failed) can never prove zero transitions, so it falls through below.
          const labelEventsBefore = labelEventsBeforeDispatchByItem.get(itemId);
          const labelEventsAfter = await deps.observe.getLabelEvents(Number(itemId));
          const zeroTransitions = labelEventsBefore !== undefined && !hasNewLabelEvent(labelEventsBefore, labelEventsAfter);
          if (isPrePipelineStage(observedStage) && zeroTransitions) {
            preconditionNoOp = true;
            const exclusion = buildPreconditionExclusion(itemId, observedStage);
            ledger = await excludeInProgressItem(deps.store, { runId, token, itemId, engine, exclusion });
            await appendActionEvidence(deps.store, runId, token, {
              item_id: itemId,
              action: "exclude_item",
              outcome: `precondition:required=${exclusion.required_stage},observed=${exclusion.observed_stage}`,
              next_action: nextAction,
              progress: "progress",
              worktree_root: worktreeRootByItem.get(itemId) ?? null,
            });
          } else if (isBlockedInLabels(issue?.labels ?? [])) {
            // A `failed` outcome whose live issue nonetheless carries `pipeline:blocked` is a
            // recoverable, human-unblockable pipeline blocker — not a genuine dispatch crash or
            // rejection — so it is routed to the same needs-human hold as a direct
            // `blocked_needs_human` outcome, never `workflow-engine-defect`. Detected by the
            // label's presence, not by `observedStage` (the single `pipeline:*` stage-winner
            // `pipelineStageFromLabels` derives) — a `pipeline:blocked` label co-present with
            // another `pipeline:*` stage label must still be caught here (#581, capability
            // `loop-blocked-item-hold-continuation`).
            needsHumanBlockerNoOp = true;
            ledger = await waitItem(deps.store, {
              runId,
              token,
              itemId,
              engine,
              request: {
                kind: "answer",
                prompt: `pipeline/loop-execution@1 reported outcome "${String(rawOutcomeByItem.get(itemId))}" for item ${itemId}, and the live issue carries the blocked label — needs a human answer/unblock before this item can resume`,
                source: "pipeline_blocked_label",
              },
              note: "needs-human pipeline blocker safety net (capability loop-needs-human-blocker-disposition)",
            });
            evidenceOutcome = "blocked_needs_human";
          }
        } catch {
          // The live observation itself failed — fall through to the genuine-defect
          // classification below rather than silently swallowing a real dispatch failure.
        }
      }
      if (preconditionNoOp) continue;

      if (!needsHumanBlockerNoOp) {
        // A genuine engine defect: recorded as a blocked item under the workflow-engine-defect
        // class so it is never silently re-dispatched — that class's default policy is run_fatal,
        // stopping the run immediately.
        ledger = await blockItem(deps.store, contract, {
          runId,
          token,
          itemId,
          engine,
          blockerClass: "workflow-engine-defect",
          evidence: dispatchError
            ? `pipeline/loop-execution@1 dispatch rejected for item ${itemId}: ${dispatchError}`
            : `pipeline/loop-execution@1 reported outcome "${String(rawOutcomeByItem.get(itemId))}" for item ${itemId}, normalized to failed`,
          allowAlreadyStopped: true,
        });
      }
    }

    await appendActionEvidence(deps.store, runId, token, {
      item_id: itemId,
      action: "dispatch_item",
      outcome: evidenceOutcome,
      next_action: nextAction,
      progress: "progress",
      worktree_root: worktreeRootByItem.get(itemId) ?? null,
    });
  }

  // Residual worktree capacity (#718): one or more dispatches hit pure capacity.
  // Items were reverted to pending (no product needs-human holds). Stop admitting
  // further starts with a run-level capacity reason so the loop does not cascade
  // N sequential capacity human-blocks on every remaining pending item.
  if (!ledger.stop && capacityWaitItemIds.length > 0) {
    const time = deps.store.now().toISOString();
    const stop: LoopStopRecord = {
      reason: "worktree_capacity",
      time,
      item_id: capacityWaitItemIds[0],
      outstanding_ready: outstandingReadyItemIds(ledger),
    };
    ledger = { ...ledger, stop };
    await writeLedger(deps.store, ledger, token);
    await appendEvent(deps.store, runId, token, "loop_run_stopped", {
      reason: "worktree_capacity",
      capacity_wait_item_ids: capacityWaitItemIds,
    });
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "stop",
      outcome: "worktree_capacity",
      next_action: null,
      progress: "progress",
    });
    return {
      progress: true,
      stop,
      holdOutstanding: false,
      allDone: false,
      heldItemIds: heldItemIdsFromLedger(ledger),
    };
  }

  // A hold entered this pass (or still outstanding from an earlier cycle) only becomes the run's
  // terminal outstanding-hold condition once nothing else remains schedulable — while any sibling
  // is still `pending`, a fresh dispatch this cycle already counts as progress, and the next cycle
  // re-evaluates the frontier rather than halting here (#581, capability
  // `loop-blocked-item-hold-continuation`).
  // A hold only becomes the run's terminal outstanding-hold condition when nothing else can make
  // progress. The cycle-start `schedulableContract` is a pre-dispatch snapshot: between precondition
  // classification and here, a precondition-excluded sibling (e.g. `pipeline:backlog`) may have become
  // `pipeline:ready` while a dispatched item turned into a hold. Concluding a terminal hold on that
  // stale snapshot would stop a run that can still make progress (pre-merge finding 20713d3b). So when
  // the stale frontier looks empty, re-observe live labels for the precondition-excluded *pending*
  // items (a read only — no reconcile, no state transition, so a hold is never disturbed): if any has
  // advanced out of the pre-pipeline stage and is not blocked, it is schedulable next cycle and this is
  // not a terminal hold.
  let terminalHold = !ledger.stop && heldItemIdsFromLedger(ledger).length > 0 && !hasSchedulableWorkRemaining(schedulableContract, ledger);
  if (terminalHold && preconditionExcludedIds.size > 0) {
    for (const item of contract.items) {
      if (!preconditionExcludedIds.has(item.id) || ledger.items[item.id]?.state !== "pending") continue;
      let observed: Awaited<ReturnType<typeof deps.observe.getIssueStateAndLabels>> = null;
      try {
        observed = await deps.observe.getIssueStateAndLabels(Number(item.id));
      } catch {
        continue; // a transient observation failure keeps the conservative (stale-snapshot) verdict
      }
      if (observed && observed.state === "open" && !isPrePipelineStage(pipelineStageFromLabels(observed.labels)) && !isBlockedInLabels(observed.labels)) {
        terminalHold = false; // now at `pipeline:ready` (or a live stage) — schedulable next cycle
        break;
      }
    }
  }
  const finalHeldItemIds = heldItemIdsFromLedger(ledger);
  if (terminalHold) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "noop",
      outcome: `hold_outstanding:${finalHeldItemIds.join(",")}`,
      next_action: "hold-for-human",
      progress: "progress",
    });
  }
  return { progress: true, stop: ledger.stop, holdOutstanding: terminalHold, allDone: false, heldItemIds: finalHeldItemIds };
}

// ---------------------------------------------------------------------------
// Attach — acquire, or recover-and-acquire on a provably dead holder.
// ---------------------------------------------------------------------------

export interface SupervisorAttachInput {
  runId: string;
  engine: LoopEngineName;
  /** True when the caller invoked `--resume` — required to take over a run
   *  whose lock is already held by anyone (even a provably dead holder). */
  resume?: boolean;
}

export interface SupervisorAttachResult {
  token: string;
  record: LoopSupervisorProcess;
  resumed: boolean;
}

/** Attaches a supervisor to `input.runId`: refuses (LoopError "validation")
 *  before any write when the run's contract/ledger schema id is outside the
 *  supported set (task 4.3); acquires the lock directly when it is free;
 *  otherwise (only under `--resume`) recovers a same-host dead-pid lock
 *  through the store's provably-dead path and refuses — with zero writes —
 *  a live same-host or cross-host-unverifiable holder. Writes the initial
 *  `supervisor.json` record on success. */
export async function attachSupervisor(deps: SupervisorDeps, input: SupervisorAttachInput): Promise<SupervisorAttachResult> {
  const { runId, engine } = input;
  const contract = await readContract(deps.store, runId);
  const ledger = await readLedger(deps.store, runId);
  if (contract.schema !== LOOP_CONTRACT_SCHEMA || ledger.schema !== LOOP_LEDGER_SCHEMA) {
    throw new LoopError(
      "validation",
      `loop run "${runId}" carries schema ${contract.schema}/${ledger.schema}, outside the store's supported set — refusing takeover`,
    );
  }

  const existingLock = await readLock(deps.store, runId);
  let resumed = false;

  if (!existingLock) {
    resumed = !!input.resume;
  } else if (!input.resume) {
    throw new LoopError(
      "lock",
      `loop run "${runId}" is already locked by ${existingLock.engine} pid ${existingLock.pid} on ${existingLock.hostname} — use --resume to take over a provably-dead holder`,
    );
  } else {
    const staleness = await classifyStaleness(deps.store, existingLock);
    if (staleness !== "stale_same_host_dead_pid") {
      throw new LoopError(
        "lock",
        `loop run "${runId}" lock is held by ${existingLock.engine} pid ${existingLock.pid} on ${existingLock.hostname} and is not verifiably dead (${staleness}) — refusing takeover`,
      );
    }
    await recoverLock(deps.store, runId, "supervisor resume: prior holder provably dead");
    resumed = true;
  }

  const acquired = await acquireLock(deps.store, runId, engine);
  const now = deps.store.now().toISOString();
  const record: LoopSupervisorProcess = {
    run_id: runId,
    engine,
    pid: deps.store.pid(),
    hostname: deps.store.hostname(),
    boot_id: deps.store.uuid(),
    started_at: now,
    heartbeat_at: now,
    token: acquired.token,
    consecutive_no_progress: 0,
  };
  await writeSupervisorProcess(deps.store, record, acquired.token);
  return { token: acquired.token, record, resumed };
}

// ---------------------------------------------------------------------------
// Drive — repeats cycles until a terminal condition.
// ---------------------------------------------------------------------------

export interface DriveSupervisorInput {
  runId: string;
  engine: LoopEngineName;
  resume?: boolean;
  /** Override for tests; production reads `contract.consecutive_no_progress_limit`
   *  falling back to {@link DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT}. */
  consecutiveNoProgressLimit?: number;
  /** Override for tests; production uses {@link MAX_CYCLES_SAFETY}. */
  maxCyclesSafety?: number;
  /** Optional pause: stop after driving at most this many cycles and return
   *  with no terminal condition recorded (unlike `maxCyclesSafety`, reaching
   *  this cap is not itself a stop — it releases the lock and returns so a
   *  caller can resume later through the real `driveSupervisor({ resume:
   *  true })` entry point, e.g. to inspect intermediate state between two
   *  live cycles). */
  maxCycles?: number;
  /**
   * Early run-ready hook (#665): fired once after exclusive lock acquisition
   * and before any `dispatchItem` call of this process. Used by the CLI to
   * emit a machine-readable handoff (`run_id` + absolute events path). Not
   * invoked on attach/lock failure. Selector is left for the caller to attach
   * — the supervisor only knows run identity.
   */
  onRunReady?(ctx: LoopRunReadyContext): void | Promise<void>;
}

/** Names which of the three resolved shapes a run ended in (capability
 *  `loop-terminal-exclusion-disclosure`, #614, design.md decision 1) — `null` for a non-resolved
 *  terminal condition (a recorded stop or an outstanding hold), which keeps its own `stop` /
 *  `holdOutstanding` disclosure instead. */
export type LoopCompletion = "all_done" | "partial_excluded" | "none_dispatchable" | null;

export interface DriveSupervisorResult {
  runId: string;
  cycles: number;
  stop: LoopStopRecord | null;
  holdOutstanding: boolean;
  /** True only when every work-list item reached a terminal-successful (done/abandoned) state
   *  with zero items precondition-excluded (#614) — narrower than "the run resolved," which also
   *  includes a resolution where every item was merely excluded. */
  allDone: boolean;
  resumed: boolean;
  /** Every item held (`paused`/`waiting`) as of the last cycle driven — populated whenever
   *  `holdOutstanding` is the terminal condition, so an operator sees exactly which items await a
   *  human (capability `loop-blocked-item-hold-continuation`, #581). Empty when the run stopped or
   *  completed with no outstanding hold. */
  heldItemIds: string[];
  /** Count of contract items in a terminal-successful (done/abandoned) ledger state as of
   *  resolution — derived from the ledger rather than an in-process counter, so a resumed run
   *  reports the whole run's accounting (#614, design.md decision 2). */
  dispatched: number;
  /** Item ids precondition-excluded per the ledger's last reconciliation as of resolution — a
   *  function of live truth, not an accumulator across cycles, so an item excluded early and later
   *  triaged into the frontier is reported as dispatched, not excluded (#614, design.md decision 2). */
  excludedItemIds: string[];
  /** The exclusion reason recorded for the greatest number of `excludedItemIds`, ties broken
   *  lexicographically (#614, design.md decision 3); null when no item was excluded. */
  exclusionReason: string | null;
  /** `null` for a recorded stop or an outstanding hold; otherwise names the resolved shape
   *  (#614, design.md decision 1). */
  completion: LoopCompletion;
}

/** Attaches (or resumes) and drives a run to a terminal condition: every item
 *  done/abandoned, a recorded stop, an outstanding paused/waiting hold, or the
 *  run-level watchdog stop. On resume, runs a reconciliation pass before
 *  continuing and appends a resume marker to the action-evidence trail (task
 *  4.2) before entering the cycle loop. The lock is held only while actively
 *  driving: it is released in a `finally` once the run reaches a terminal
 *  condition (or the drive throws), so a released-lock resume can proceed on
 *  another host/process without a takeover. `supervisor.json` (the process
 *  identity record) is left in place as the last-process record — releasing
 *  the lock does not touch it. */
export async function driveSupervisor(deps: SupervisorDeps, input: DriveSupervisorInput): Promise<DriveSupervisorResult> {
  const attach = await attachSupervisor(deps, { runId: input.runId, engine: input.engine, resume: input.resume });
  const token = attach.token;
  let record = attach.record;
  const contract = await readContract(deps.store, input.runId);
  const limit = input.consecutiveNoProgressLimit ?? contract.consecutive_no_progress_limit ?? DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT;
  const cyclesSafetyCap = input.maxCyclesSafety ?? MAX_CYCLES_SAFETY;

  try {
    // Advertise identity after exclusive lock, before any dispatch can block (#665).
    // Inside try so a handoff write failure still releases the exclusive lock.
    if (input.onRunReady) {
      await input.onRunReady({
        runId: input.runId,
        runDir: runDir(deps.store, input.runId),
        events: runEventsPath(deps.store, input.runId),
        engine: input.engine,
        resumed: attach.resumed,
      });
    }

    if (attach.resumed) {
      try {
        await reconcile(deps.store, deps.observe, { runId: input.runId, token, engine: input.engine });
      } catch (err) {
        if (!(err instanceof LoopError && err.loopFailureClass === "stop")) throw err;
      }
      await appendActionEvidence(deps.store, input.runId, token, {
        item_id: null,
        action: "resume",
        outcome: "resumed",
        next_action: null,
        progress: "progress",
      });
    }

    let cycles = 0;
    let stop: LoopStopRecord | null = null;
    let holdOutstanding = false;
    let resolved = false;
    let heldItemIds: string[] = [];

    while (cycles < cyclesSafetyCap) {
      cycles++;
      const result = await runSupervisorCycle(deps, input.runId, token, input.engine);

      record = {
        ...record,
        heartbeat_at: deps.store.now().toISOString(),
        consecutive_no_progress: result.progress ? 0 : record.consecutive_no_progress + 1,
      };
      await writeSupervisorProcess(deps.store, record, token);

      if (result.stop) {
        stop = result.stop;
        break;
      }
      if (result.holdOutstanding) {
        holdOutstanding = true;
        heldItemIds = result.heldItemIds;
        break;
      }
      if (result.allDone) {
        resolved = true;
        break;
      }

      if (input.maxCycles !== undefined && cycles >= input.maxCycles) {
        break;
      }

      if (record.consecutive_no_progress >= limit) {
        const time = deps.store.now().toISOString();
        const ledger = await readLedger(deps.store, input.runId);
        const newLedger: LoopLedger = {
          ...ledger,
          stop: { reason: "supervisor_no_progress", time, outstanding_ready: outstandingReadyItemIds(ledger) },
        };
        await writeLedger(deps.store, newLedger, token);
        await appendEvent(deps.store, input.runId, token, "loop_run_stopped", { reason: "supervisor_no_progress" });
        await appendActionEvidence(deps.store, input.runId, token, {
          item_id: null,
          action: "stop",
          outcome: "supervisor_no_progress",
          next_action: null,
          progress: "no_progress",
        });
        stop = newLedger.stop;
        break;
      }
    }

    if (!stop && !holdOutstanding && !resolved && cycles >= cyclesSafetyCap) {
      const time = deps.store.now().toISOString();
      const ledger = await readLedger(deps.store, input.runId);
      const newLedger: LoopLedger = {
        ...ledger,
        stop: { reason: "supervisor_cycle_cap", time, limit: cyclesSafetyCap, outstanding_ready: outstandingReadyItemIds(ledger) },
      };
      await writeLedger(deps.store, newLedger, token);
      await appendEvent(deps.store, input.runId, token, "loop_run_stopped", { reason: "supervisor_cycle_cap" });
      await appendActionEvidence(deps.store, input.runId, token, {
        item_id: null,
        action: "stop",
        outcome: "supervisor_cycle_cap",
        next_action: null,
        progress: "progress",
      });
      stop = newLedger.stop;
    }

    // Accounting derived from the final ledger, not an in-process counter, so a resumed run
    // reports the whole run's dispatch/exclusion picture (#614, design.md decision 2) — including
    // for a stop or an outstanding hold, whose summary stays as informative as before (design.md
    // edge cases).
    const finalLedger = await readLedger(deps.store, input.runId);
    const finalExclusions = classifyPreconditionExclusions(contract, finalLedger);
    const excludedItemIds = finalExclusions.map((e) => e.item_id).sort();
    const exclusionReason = dominantExclusionReason(finalExclusions);
    const dispatched = contract.items.filter((i) => DONE_OR_ABANDONED.has(finalLedger.items[i.id]?.state ?? "")).length;
    const completion: LoopCompletion =
      stop || holdOutstanding
        ? null
        : excludedItemIds.length === 0
          ? "all_done"
          : dispatched === 0
            ? "none_dispatchable"
            : "partial_excluded";
    const allDone = completion === "all_done";

    const result: DriveSupervisorResult = {
      runId: input.runId,
      cycles,
      stop,
      holdOutstanding,
      allDone,
      resumed: attach.resumed,
      heldItemIds,
      dispatched,
      excludedItemIds,
      exclusionReason,
      completion,
    };
    if ((stop || resolved) && deps.onDriveEnd) {
      try {
        await deps.onDriveEnd(result);
      } catch {
        // best-effort (#538) — must never alter the drive result
      }
    }
    return result;
  } finally {
    await releaseLock(deps.store, input.runId, token);
  }
}

// ---------------------------------------------------------------------------
// Audit — a pure, read-only projection over persisted artifacts.
// ---------------------------------------------------------------------------

export interface SupervisorAuditReport {
  run_id: string;
  process: LoopSupervisorProcess | null;
  action_evidence: LoopStatus["action_evidence"];
  consecutive_no_progress: number;
  stop: LoopStopRecord | null;
  status: LoopStatus;
  /**
   * Per-item stage-progress table (#611) — derived from durable ledger
   * projections (and coarse state when projection is absent). Never invents a
   * live advance run-id for queued items.
   */
  stage_progress: StageProgressTableRow[];
}

/** Renders the process identity, the action-evidence timeline, the watchdog
 *  state, the per-item stage-progress table (#611), and the run's current
 *  position — zero durable writes: no ledger write, no lock acquisition, no
 *  `supervisor.json` write, no GitHub mutation. A run with no `supervisor.json`
 *  yet audits with the process identity reported absent. */
export async function auditSupervisor(store: LoopStoreDeps, runId: string): Promise<SupervisorAuditReport> {
  const status = await getStatus(store, runId);
  const process = await readSupervisorProcess(store, runId);
  const action_evidence = await readActionEvidence(store, runId);
  const ledger = await readLedger(store, runId);
  return {
    run_id: runId,
    process,
    action_evidence,
    consecutive_no_progress: process?.consecutive_no_progress ?? 0,
    stop: status.stop,
    status,
    stage_progress: buildStageProgressTable(ledger),
  };
}
