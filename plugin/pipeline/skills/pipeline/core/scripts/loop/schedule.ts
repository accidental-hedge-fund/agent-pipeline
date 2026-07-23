// Durable-run independent-set scheduler (#530, capability
// `durable-run-independent-scheduler`). The third and final child of epic #528: consumes the
// already-verified planning inputs its two siblings supply — dependency integrity (#513,
// loop/dependencies.ts's `eligibleIndependentItems`), ownership + conflict evaluation (#529,
// loop/ownership.ts's `evaluateConflict`), and verified live reconciliation drift (#511,
// loop/reconcile.ts) — plus the durable-loop-engine merge barrier, to select a
// concurrency-bounded, provably-independent set of items to start. It never re-verifies any of
// those inputs and never merges, dispatches, or bypasses review — see
// openspec/changes/durable-run-independent-scheduler/design.md for the decisions this module
// implements. Every function here is pure (no gh, git, fs, clock, or store access).

import { evaluateConflict, normalizeOwnership } from "./ownership.ts";
import { eligibleIndependentItems } from "./recovery.ts";
import {
  type ExternalDependencyStatus,
  type LoopContract,
  type LoopContractItem,
  type LoopLedger,
  type LoopReplanRequest,
  type ScheduleDecision,
  type ScheduleRationale,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Independent-set selection.
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  contract: LoopContract;
  ledger: LoopLedger;
  /** Live-verified external-dependency statuses (capability `durable-run-dependency-integrity`);
   *  defaults to `{}` (no external dependencies), mirroring `eligibleIndependentItems`. */
  externalStatuses?: Readonly<Record<string, ExternalDependencyStatus>>;
}

/** True iff `from` transitively depends (in-snapshot `depends_on` only — the sole edge kind that
 *  can name another item in the same contract) on `to`. Defense-in-depth alongside
 *  {@link eligibleIndependentItems}'s own filtering: a `pending` frontier candidate can never
 *  actually be a transitive dependency of another `pending` frontier candidate (its dependent
 *  could not otherwise have entered the frontier), but this check guards the invariant directly
 *  rather than relying on that being true by construction elsewhere. */
function dependsTransitively(itemsById: ReadonlyMap<string, LoopContractItem>, from: string, to: string): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const dep of itemsById.get(current)?.depends_on ?? []) {
      if (dep === to) return true;
      if (!visited.has(dep)) {
        visited.add(dep);
        stack.push(dep);
      }
    }
  }
  return false;
}

function hasDependencyPath(itemsById: ReadonlyMap<string, LoopContractItem>, a: string, b: string): boolean {
  return dependsTransitively(itemsById, a, b) || dependsTransitively(itemsById, b, a);
}

/** Selects a deterministic, concurrency-bounded, provably-independent set of items to admit into
 *  `in_progress` from the eligible-item frontier. Absent a `concurrency` policy, or a budget of
 *  one, this ever admits at most one item — the same item {@link eligibleIndependentItems} would
 *  have picked as `eligible[0]` pre-#530, so the serialized default's observable selection is
 *  unchanged. A merge barrier admits nothing at all (design.md Decision 4): every frontier
 *  candidate is recorded `merge_barrier` and `selected` is empty. Otherwise walks the frontier in
 *  its documented order, admitting each candidate only when it is independent — by the fixed
 *  precedence dependency-path, then conflict-edge/unknown-ownership (ownership.ts's own internal
 *  precedence decides between those two), then unresolved reconciliation drift, then the budget —
 *  of every already-admitted item. Every candidate receives exactly one {@link ScheduleRationale}
 *  entry; this function itself starts, merges, or serializes nothing. */
export function selectSchedulableSet(input: ScheduleInput): ScheduleDecision {
  const { contract, ledger } = input;
  const externalStatuses = input.externalStatuses ?? {};

  const frontier = eligibleIndependentItems(contract, ledger, externalStatuses);
  if (frontier.length === 0) {
    return { selected: [], rationale: [] };
  }

  if (ledger.merge_barrier) {
    return {
      selected: [],
      rationale: frontier.map((itemId) => ({ item_id: itemId, disposition: "merge_barrier" as const })),
    };
  }

  const budgetRaw = contract.concurrency?.max_concurrent ?? 1;
  const budget = Number.isFinite(budgetRaw) && budgetRaw >= 1 ? Math.floor(budgetRaw) : 1;

  const itemsById = new Map(contract.items.map((item) => [item.id, item] as const));
  const evalInputsById = new Map(
    contract.items.map(
      (item) => [item.id, { id: item.id, decl: item.ownership, normalized: normalizeOwnership(item.ownership) }] as const,
    ),
  );
  const unresolvedDriftIds = new Set((ledger.last_reconciliation?.drift ?? []).map((d) => d.item_id));

  const selected: string[] = [];
  const rationale: ScheduleRationale[] = [];

  for (const candidateId of frontier) {
    let denied: ScheduleRationale | null = null;

    for (const admittedId of selected) {
      if (hasDependencyPath(itemsById, candidateId, admittedId)) {
        denied = { item_id: candidateId, disposition: "dependency_path", counterpart_item_id: admittedId };
        break;
      }
    }

    if (!denied) {
      for (const admittedId of selected) {
        const verdict = evaluateConflict(evalInputsById.get(candidateId)!, evalInputsById.get(admittedId)!);
        if (verdict.verdict !== "conflict") continue;
        if (verdict.reason?.kind === "unknown_ownership") {
          denied = {
            item_id: candidateId,
            disposition: "unknown_ownership",
            counterpart_item_id: admittedId,
            detail: verdict.reason.detail,
          };
        } else {
          denied = {
            item_id: candidateId,
            disposition: "conflict_edge",
            counterpart_item_id: admittedId,
            detail: verdict.reason?.kind === "overlapping_surface" ? `${verdict.reason.surface.kind}:${verdict.reason.surface.pattern}` : undefined,
          };
        }
        break;
      }
    }

    if (!denied && unresolvedDriftIds.has(candidateId)) {
      denied = { item_id: candidateId, disposition: "unresolved_drift" };
    }

    if (!denied && selected.length >= budget) {
      denied = { item_id: candidateId, disposition: "budget_truncation" };
    }

    if (denied) {
      rationale.push(denied);
      continue;
    }

    selected.push(candidateId);
    rationale.push({ item_id: candidateId, disposition: "admitted" });
  }

  return { selected, rationale };
}

// ---------------------------------------------------------------------------
// Changed-file-overlap parking — a post-run safety net, not a pre-run gate (design.md Decision 5).
// ---------------------------------------------------------------------------

export interface ChangedFileOverlapResult {
  /** Ids of every item whose actually-changed files overlapped another concurrently-run item's,
   *  sorted for determinism. Empty when no overlap was observed. */
  affected_item_ids: string[];
  /** Every overlapping path, sorted and de-duplicated. */
  overlapping_paths: string[];
}

/** Compares the actual, observed changed-file sets of concurrently-run items and returns the
 *  items and paths where real overlap occurred that the declared ownership did not predict — the
 *  backstop closing the gap between a declaration and reality. Pure: `actualChangedFiles` is the
 *  caller's own observation (e.g. a git diff against base per managed worktree); this function
 *  never fetches it. */
export function detectChangedFileOverlap(
  actualChangedFiles: Readonly<Record<string, readonly string[]>>,
): ChangedFileOverlapResult {
  const ids = Object.keys(actualChangedFiles).sort();
  const affected = new Set<string>();
  const overlapping = new Set<string>();

  for (let i = 0; i < ids.length; i++) {
    const filesA = actualChangedFiles[ids[i]] ?? [];
    for (let j = i + 1; j < ids.length; j++) {
      const filesB = new Set(actualChangedFiles[ids[j]] ?? []);
      for (const path of filesA) {
        if (filesB.has(path)) {
          affected.add(ids[i]);
          affected.add(ids[j]);
          overlapping.add(path);
        }
      }
    }
  }

  return { affected_item_ids: [...affected].sort(), overlapping_paths: [...overlapping].sort() };
}

/** Builds the durable replan-request record for a detected overlap, or `null` when no overlap was
 *  found (nothing to park, nothing to record). Pure — the caller persists the result via its own
 *  store seam (mirrors `ownership.ts`'s `evaluate*`/`record*` split). */
export function buildReplanRequest(result: ChangedFileOverlapResult, time: string): LoopReplanRequest | null {
  if (result.affected_item_ids.length === 0) return null;
  return {
    time,
    affected_item_ids: result.affected_item_ids,
    overlapping_paths: result.overlapping_paths,
    reason: `observed changed-file overlap not predicted by declared ownership: ${result.overlapping_paths.join(", ")}`,
  };
}
