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

import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopEngineName,
  type LoopItemLedgerEntry,
  type LoopLedger,
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
  writeLedger,
  writeSupervisorProcess,
  type LoopStatus,
  type LoopStoreDeps,
} from "./store.ts";
import { reconcile, transitionItem, type ReconcileObserveDeps } from "./reconcile.ts";
import { blockItem, classifyAndBlockItem, eligibleIndependentItems } from "./recovery.ts";
import { computeExternalDependencyStatuses, detectDependencyDeadlock, propagateSkips } from "./dependencies.ts";
import {
  LOOP_EXECUTION_CONTRACT_SCHEMA,
  normalizeLoopOutcome,
  type LoopExecutionRequest,
  type LoopExecutionResponse,
} from "../loop-execution-contract.ts";

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
  dispatchItem(request: LoopExecutionRequest): Promise<LoopExecutionResponse>;
}

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

const DONE_OR_ABANDONED = new Set(["ready", "merged", "released", "deployed", "abandoned", "skipped"]);

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
    return { progress: false, stop: ledger.stop, holdOutstanding: false, allDone: false };
  }

  const held = Object.values(ledger.items).find((i) => i.state === "paused" || i.state === "waiting");
  if (held) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: held.id,
      action: "noop",
      outcome: `hold:${held.state}`,
      next_action: "hold-for-human",
      progress: "no_progress",
    });
    return { progress: false, stop: null, holdOutstanding: true, allDone: false };
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
      return { progress: false, stop: ledger.stop, holdOutstanding: false, allDone: false };
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
    return { progress: true, stop: ledger.stop, holdOutstanding: false, allDone: false };
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

  const allDone = contract.items.every((i) => DONE_OR_ABANDONED.has(ledger.items[i.id]?.state ?? ""));
  if (allDone) {
    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "noop",
      outcome: "all_items_done",
      next_action: null,
      progress: drifted || propagated ? "progress" : "no_progress",
    });
    return { progress: drifted || propagated, stop: null, holdOutstanding: false, allDone: true };
  }

  let activeItemId = Object.values(ledger.items).find((i) => i.state === "in_progress")?.id ?? null;
  if (!activeItemId) {
    const eligible = eligibleIndependentItems(contract, ledger, externalStatuses);
    if (eligible.length > 0) {
      activeItemId = eligible[0];
      ledger = await startItem(deps.store, { runId, token, itemId: activeItemId, engine });
    }
  }

  if (!activeItemId) {
    const deadlockChain = detectDependencyDeadlock(contract, ledger, externalStatuses);
    if (deadlockChain) {
      const time = deps.store.now().toISOString();
      const stop: LoopStopRecord = { reason: "dependency_deadlock", time, deadlock_chain: deadlockChain };
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
      return { progress: true, stop, holdOutstanding: false, allDone: false };
    }

    await appendActionEvidence(deps.store, runId, token, {
      item_id: null,
      action: "noop",
      outcome: "no_eligible_item",
      next_action: null,
      progress: drifted || propagated ? "progress" : "no_progress",
    });
    return { progress: drifted || propagated, stop: null, holdOutstanding: false, allDone: false };
  }

  const request: LoopExecutionRequest = {
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: activeItemId,
    repo: contract.repo,
    engine,
    worktree_policy: contract.worktree_policy,
    done_definition: contract.done_definition,
    run_id: runId,
  };
  const response = await deps.dispatchItem(request);
  const outcome = normalizeLoopOutcome(response.outcome);
  const reconciliationAfter = ledger.last_reconciliation;
  const nextAction = reconciliationAfter?.next_actions[activeItemId] ?? null;

  if (outcome === "ready_to_deploy") {
    ledger = await transitionItem(deps.store, deps.observe, contract, {
      runId,
      token,
      itemId: activeItemId,
      engine,
      to: "ready",
      note: "pipeline/loop-execution@1 reported ready_to_deploy",
    });
  } else if (outcome === "abandoned") {
    ledger = await abandonInProgressItem(deps.store, runId, token, activeItemId, engine);
  } else if (outcome === "blocked_needs_human") {
    ledger = (
      await classifyAndBlockItem(deps.store, contract, {
        runId,
        token,
        itemId: activeItemId,
        engine,
        candidateClasses: ["missing-authority"],
        evidence: `pipeline/loop-execution@1 reported blocked_needs_human for item ${activeItemId}`,
      })
    );
  } else {
    // "failed" — either reported directly or normalized from an outcome
    // outside the defined terminal set (LOOP_TERMINAL_OUTCOMES). Recorded as
    // a blocked item under the workflow-engine-defect class so it is never
    // silently re-dispatched: that class's default policy is run_fatal,
    // stopping the run immediately.
    ledger = await blockItem(deps.store, contract, {
      runId,
      token,
      itemId: activeItemId,
      engine,
      blockerClass: "workflow-engine-defect",
      evidence: `pipeline/loop-execution@1 reported outcome "${String(response.outcome)}" for item ${activeItemId}, normalized to failed`,
    });
  }

  await appendActionEvidence(deps.store, runId, token, {
    item_id: activeItemId,
    action: "dispatch_item",
    outcome,
    next_action: nextAction,
    progress: "progress",
  });

  return { progress: true, stop: ledger.stop, holdOutstanding: false, allDone: false };
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
}

export interface DriveSupervisorResult {
  runId: string;
  cycles: number;
  stop: LoopStopRecord | null;
  holdOutstanding: boolean;
  allDone: boolean;
  resumed: boolean;
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
    let allDone = false;

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
        break;
      }
      if (result.allDone) {
        allDone = true;
        break;
      }

      if (record.consecutive_no_progress >= limit) {
        const time = deps.store.now().toISOString();
        const ledger = await readLedger(deps.store, input.runId);
        const newLedger: LoopLedger = { ...ledger, stop: { reason: "supervisor_no_progress", time } };
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

    if (!stop && !holdOutstanding && !allDone && cycles >= cyclesSafetyCap) {
      const time = deps.store.now().toISOString();
      const ledger = await readLedger(deps.store, input.runId);
      const newLedger: LoopLedger = { ...ledger, stop: { reason: "supervisor_cycle_cap", time, limit: cyclesSafetyCap } };
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

    return { runId: input.runId, cycles, stop, holdOutstanding, allDone, resumed: attach.resumed };
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
}

/** Renders the process identity, the action-evidence timeline, the watchdog
 *  state, and the run's current position — zero durable writes: no ledger
 *  write, no lock acquisition, no `supervisor.json` write, no GitHub
 *  mutation. A run with no `supervisor.json` yet audits with the process
 *  identity reported absent. */
export async function auditSupervisor(store: LoopStoreDeps, runId: string): Promise<SupervisorAuditReport> {
  const status = await getStatus(store, runId);
  const process = await readSupervisorProcess(store, runId);
  const action_evidence = await readActionEvidence(store, runId);
  return {
    run_id: runId,
    process,
    action_evidence,
    consecutive_no_progress: process?.consecutive_no_progress ?? 0,
    stop: status.stop,
    status,
  };
}
