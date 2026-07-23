// Durable-run dependency integrity (#513, capability `durable-run-dependency-integrity`).
//
// Ports goal-loop#5's dependency machinery onto the integrated durable engine (#508): external
// dependencies are preserved (not dropped) at compile time and verified against live truth
// before a dependent item starts; a terminal `skipped` state propagates to the dependents of an
// abandoned/skipped/unsatisfiable dependency; a structurally unrunnable frontier is reported as
// a typed `dependency_deadlock` instead of spinning into the generic no-progress watchdog; and
// dependency-independent items continue to run to completion regardless of the fate of items
// they do not depend on.
//
// See openspec/changes/durable-run-dependency-integrity/design.md for the decisions this module
// implements. Every live read goes through the engine-owned `ReconcileObserveDeps` seam (never a
// caller claim) — unit tests inject a fake and perform no real network, git, or subprocess call.

import {
  LoopError,
  type ExternalDependencyStatus,
  type LoopContract,
  type LoopContractItem,
  type LoopDeadlockChainEntry,
  type LoopEngineName,
  type LoopItemLedgerEntry,
  type LoopItemState,
  type LoopLedger,
} from "./types.ts";
import type { ReconcileObserveDeps } from "./reconcile.ts";
import { eligibleIndependentItems } from "./recovery.ts";

// ---------------------------------------------------------------------------
// Contract compilation — partition declared dependencies, order deterministically.
// ---------------------------------------------------------------------------

/** A raw, uncompiled item declaration — the shape a discovery/import source provides before
 *  compilation partitions its dependencies. */
export interface RawContractItem {
  id: string;
  depends_on?: readonly string[];
}

/** Compiles raw item declarations into ordered {@link LoopContractItem}s: partitions each item's
 *  declared dependencies into in-snapshot (`depends_on`, order-constraining, cycle-checked) and
 *  out-of-snapshot (`external_depends_on`, preserved but non-order-constraining) by membership in
 *  the item-id set, then topologically orders items so every item follows its in-snapshot
 *  dependencies — ties broken by original input order, so repeated compilations of the same input
 *  produce an identical sequence. Refuses (LoopError "validation") a duplicate item id or a
 *  dependency cycle among in-snapshot items. Replaces the prior "out-of-snapshot dependency is
 *  dropped" behavior (durable-loop-engine requirement "Dependency ordering ..."). */
export function compileContractItems(rawItems: readonly RawContractItem[]): LoopContractItem[] {
  const seen = new Set<string>();
  for (const item of rawItems) {
    if (seen.has(item.id)) {
      throw new LoopError("validation", `duplicate item id "${item.id}" in snapshot`);
    }
    seen.add(item.id);
  }
  const idSet = seen;

  const partitioned = new Map<string, LoopContractItem>();
  for (const item of rawItems) {
    const declared = item.depends_on ?? [];
    const depends_on = declared.filter((d) => idSet.has(d));
    const external_depends_on = declared.filter((d) => !idSet.has(d));
    partitioned.set(item.id, { id: item.id, depends_on, external_depends_on });
  }

  const ordered: LoopContractItem[] = [];
  const permanent = new Set<string>();
  const inStack = new Set<string>();

  function visit(id: string, path: readonly string[]): void {
    if (permanent.has(id)) return;
    if (inStack.has(id)) {
      throw new LoopError("validation", `dependency cycle detected: ${[...path, id].join(" -> ")}`);
    }
    inStack.add(id);
    for (const dep of partitioned.get(id)?.depends_on ?? []) {
      visit(dep, [...path, id]);
    }
    inStack.delete(id);
    permanent.add(id);
    ordered.push(partitioned.get(id)!);
  }

  for (const item of rawItems) {
    visit(item.id, []);
  }

  return ordered;
}

/** Installs an empty `external_depends_on` on every item that predates this capability (a
 *  pre-#513 contract has no such field at all) — mirrors `upgradeContractForRecovery`
 *  (loop/recovery.ts). A no-op for an already-compiled contract. */
export function upgradeContractForDependencyIntegrity(contract: LoopContract): LoopContract {
  const complete = contract.items.every((i) => Array.isArray(i.external_depends_on));
  if (complete) return contract;
  return { ...contract, items: contract.items.map((i) => ({ ...i, external_depends_on: i.external_depends_on ?? [] })) };
}

// ---------------------------------------------------------------------------
// External-dependency verification — live truth, three-valued.
// ---------------------------------------------------------------------------

/** Classifies one external dependency's live-observed state into exactly one
 *  {@link ExternalDependencyStatus}: **satisfied** when the issue is observed closed-as-completed
 *  or its linked PR is observed merged; **unsatisfiable** when the issue is observed
 *  closed-as-not-planned; **pending** when the issue is observed open, or cannot be observed at
 *  all (fails closed toward "not yet proven", never toward "satisfied"). Pure — takes the seam's
 *  observations, never calls the seam itself. */
export function externalDependencyStatus(
  issueState: { state: "open" | "closed"; stateReason: "completed" | "not_planned" | "reopened" | null } | null,
  linkedPrMerged: boolean,
): ExternalDependencyStatus {
  if (linkedPrMerged) return "satisfied";
  if (!issueState) return "pending";
  if (issueState.state === "open") return "pending";
  if (issueState.stateReason === "completed") return "satisfied";
  if (issueState.stateReason === "not_planned") return "unsatisfiable";
  return "pending";
}

/** Every distinct external dependency id declared across `contract.items`. */
function collectExternalDependencyIds(contract: LoopContract): string[] {
  const ids = new Set<string>();
  for (const item of contract.items) {
    for (const id of item.external_depends_on ?? []) ids.add(id);
  }
  return [...ids];
}

/** Verifies every external dependency declared anywhere in `contract` against live truth through
 *  the injected {@link ReconcileObserveDeps} seam, never a caller claim. Performs zero seam calls
 *  (and zero real network/git/subprocess calls under test) when no item declares an external
 *  dependency. */
export async function computeExternalDependencyStatuses(
  observeDeps: ReconcileObserveDeps,
  contract: LoopContract,
): Promise<Record<string, ExternalDependencyStatus>> {
  const ids = collectExternalDependencyIds(contract);
  const statuses: Record<string, ExternalDependencyStatus> = {};
  for (const id of ids) {
    const issueNumber = Number(id);
    const issueState = Number.isInteger(issueNumber) && issueNumber > 0 ? await observeDeps.getExternalDependencyIssueState(issueNumber) : null;
    const prNumber = Number.isInteger(issueNumber) && issueNumber > 0 ? await observeDeps.findPrForIssue(issueNumber) : null;
    const prDetail = prNumber !== null ? await observeDeps.getPrDetail(prNumber) : null;
    statuses[id] = externalDependencyStatus(issueState, prDetail?.state === "merged");
  }
  return statuses;
}

/** True when every id in `item.external_depends_on` is `satisfied`. An item with no external
 *  dependencies is trivially satisfied. */
export function allExternalDependenciesSatisfied(
  item: Pick<LoopContractItem, "external_depends_on">,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>>,
): boolean {
  return (item.external_depends_on ?? []).every((id) => externalStatuses[id] === "satisfied");
}

// ---------------------------------------------------------------------------
// Skip propagation — terminal, dependency-triggered.
// ---------------------------------------------------------------------------

const SKIPPABLE_FROM_STATES: ReadonlySet<LoopItemState> = new Set(["pending", "blocked"]);

interface SkipCause {
  causingId: string;
  kind: "in_run" | "external";
}

function findSkipCause(
  item: LoopContractItem,
  items: Readonly<Record<string, LoopItemLedgerEntry>>,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>>,
): SkipCause | null {
  for (const depId of item.depends_on) {
    const depState = items[depId]?.state;
    if (depState === "abandoned" || depState === "skipped") {
      return { causingId: depId, kind: "in_run" };
    }
  }
  for (const extId of item.external_depends_on ?? []) {
    if (externalStatuses[extId] === "unsatisfiable") {
      return { causingId: extId, kind: "external" };
    }
  }
  return null;
}

export interface PropagateSkipsResult {
  ledger: LoopLedger;
  /** Ids of every item this pass transitioned to `skipped`, in the order propagated. Empty when
   *  propagation made no change. */
  skippedItemIds: string[];
}

/** Propagates a transition to `skipped` to the transitive `pending`/`blocked` dependents of any
 *  dependency that reaches a terminal non-success state — an in-snapshot dependency that is
 *  `abandoned` or `skipped`, or an external dependency observed `unsatisfiable` — because those
 *  dependents can never satisfy their declared prerequisites. Runs to a fixpoint within one call
 *  so a multi-hop chain (A abandoned -> B skipped -> C skipped) resolves in a single pass. An item
 *  with no dependency in a terminal non-success state is never skipped, regardless of any
 *  unrelated item's fate elsewhere in the run. Pure — the caller persists `result.ledger` and
 *  emits events for `result.skippedItemIds`. */
export function propagateSkips(
  contract: LoopContract,
  ledger: LoopLedger,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>>,
  now: () => string,
  engine: LoopEngineName,
): PropagateSkipsResult {
  const items: Record<string, LoopItemLedgerEntry> = { ...ledger.items };
  const skippedItemIds: string[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const item of contract.items) {
      const entry = items[item.id];
      if (!entry || !SKIPPABLE_FROM_STATES.has(entry.state)) continue;
      const cause = findSkipCause(item, items, externalStatuses);
      if (!cause) continue;

      const time = now();
      items[item.id] = {
        ...entry,
        state: "skipped",
        history: [
          ...entry.history,
          {
            time,
            from: entry.state,
            to: "skipped",
            engine,
            note: `skipped: ${cause.kind} dependency "${cause.causingId}" will never be satisfied`,
          },
        ],
      };
      skippedItemIds.push(item.id);
      changed = true;
    }
  }

  return { ledger: { ...ledger, items }, skippedItemIds };
}

// ---------------------------------------------------------------------------
// Dependency-deadlock detection — after propagation, before the generic watchdog.
// ---------------------------------------------------------------------------

/** Terminal item states — done, abandoned, or skipped — excluded from deadlock consideration. */
const TERMINAL_ITEM_STATES: ReadonlySet<LoopItemState> = new Set([
  "ready",
  "merged",
  "released",
  "deployed",
  "abandoned",
  "skipped",
]);

/** Detects a structurally unrunnable frontier: no item is `in_progress`, no item is eligible to
 *  start (accounting for external gating), and at least one non-terminal item remains gated on a
 *  pending or unsatisfiable dependency. Returns the deadlock chain naming each stuck item and the
 *  dependency (in-run or external) it waits on, or `null` when the run is not deadlocked. MUST
 *  run after {@link propagateSkips} has been applied, so a purely in-run abandon/skip chain has
 *  already resolved to `skipped` and no longer counts as non-terminal.
 *
 *  An in-run dependency counts as "gating" only when it is itself `pending` (never started, and —
 *  given no eligible item anywhere — structurally never going to start) or missing from the
 *  ledger entirely (a dangling reference). A `blocked`/`implemented`/`pr_opened`/`paused`/
 *  `waiting` in-run dependency has its own resolution path (recovery, reconciliation, resume) and
 *  is deliberately NOT reported as a dependency deadlock — the existing block-recovery machinery
 *  and the generic `supervisor_no_progress` watchdog remain the terminal signal for those. Pure. */
export function detectDependencyDeadlock(
  contract: LoopContract,
  ledger: LoopLedger,
  externalStatuses: Readonly<Record<string, ExternalDependencyStatus>>,
): LoopDeadlockChainEntry[] | null {
  if (Object.values(ledger.items).some((i) => i.state === "in_progress")) return null;
  if (eligibleIndependentItems(contract, ledger, externalStatuses).length > 0) return null;

  const chain: LoopDeadlockChainEntry[] = [];
  for (const item of contract.items) {
    const entry = ledger.items[item.id];
    if (!entry || TERMINAL_ITEM_STATES.has(entry.state)) continue;

    for (const depId of item.depends_on) {
      const depState = ledger.items[depId]?.state;
      if (depState === undefined) {
        chain.push({ item_id: item.id, waiting_on: depId, kind: "in_run", observed_state: "missing" });
      } else if (depState === "pending") {
        chain.push({ item_id: item.id, waiting_on: depId, kind: "in_run", observed_state: depState });
      }
    }
    for (const extId of item.external_depends_on ?? []) {
      const status = externalStatuses[extId] ?? "pending";
      if (status !== "satisfied") {
        chain.push({ item_id: item.id, waiting_on: extId, kind: "external", observed_state: status });
      }
    }
  }

  return chain.length > 0 ? chain : null;
}
