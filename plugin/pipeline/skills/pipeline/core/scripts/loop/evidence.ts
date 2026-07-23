// Durable-run composed evidence bundle (#531, capability
// `durable-run-parallel-conflict-pilot`, design.md Decision 6). A read-only
// projection over a run's already-durable state — the ledger, the events
// log, and the action-evidence trail — locating the five behaviors a
// conflict-aware parallel run exercises: observed concurrency (which items
// were selected together), the pairwise ownership decisions and their
// structured reasons, per-item worktree identity, the changed-file-overlap
// detection and its replan request, and each item's terminal outcome. It
// derives from recorded run state and invents nothing: a caller who wants
// this bundle for a live run reads exactly what this module reads.
//
// Acquires no lock, writes no ledger, appends no event.

import { readActionEvidence, readEvents, readLedger, type LoopStoreDeps } from "./store.ts";
import type { LoopLedger, OwnershipEvidencePair } from "./types.ts";

export interface LoopEvidenceBundle {
  runId: string;
  observedConcurrency: Array<{ selected: string[] }>;
  pairwiseDecisions: OwnershipEvidencePair[];
  worktreeIdentity: Record<string, string>;
  changedFileOverlap: { affected_item_ids: string[]; overlapping_paths: string[]; reason: string } | null;
  mergeBarrierCleared: { item_id: string; merged_sha: string } | null;
  terminalOutcomes: Record<string, string>;
  stop: LoopLedger["stop"];
}

/** Projects a run's durable state into a {@link LoopEvidenceBundle}. */
export async function buildLoopEvidenceBundle(
  deps: LoopStoreDeps,
  runId: string,
): Promise<LoopEvidenceBundle> {
  const ledger = await readLedger(deps, runId);
  const events = await readEvents(deps, runId);
  const actionEvidence = await readActionEvidence(deps, runId);

  // Worktree identity is derived solely from the durable action-evidence trail — each item's
  // first `dispatch_item` entry carries the `worktree_root` the dispatch response reported
  // (`pipeline/loop-execution@1`'s `LoopEvidencePointer.worktree_root`), never from a caller-local
  // map (#531 review 1 finding cfa926e8).
  const worktreeIdentity: Record<string, string> = {};
  for (const entry of actionEvidence) {
    if (entry.action !== "dispatch_item" || !entry.item_id || entry.worktree_root == null) continue;
    if (!(entry.item_id in worktreeIdentity)) worktreeIdentity[entry.item_id] = entry.worktree_root;
  }

  const observedConcurrency = events
    .filter((e) => e.kind === "loop_schedule_evaluated")
    .map((e) => ({ selected: (e.data as { selected: string[] }).selected }));

  const ownershipEvent = events.find((e) => e.kind === "loop_ownership_evaluated");
  const pairwiseDecisions = ownershipEvent
    ? (ownershipEvent.data as { pairs: OwnershipEvidencePair[] }).pairs
    : [];

  const replanEvent = events.find((e) => e.kind === "loop_replan_requested");
  const changedFileOverlap = replanEvent
    ? (replanEvent.data as { affected_item_ids: string[]; overlapping_paths: string[]; reason: string })
    : null;

  const barrierClearedEvent = events.find((e) => e.kind === "loop_merge_barrier_cleared");
  const mergeBarrierCleared = barrierClearedEvent
    ? (barrierClearedEvent.data as { item_id: string; merged_sha: string })
    : null;

  return {
    runId,
    observedConcurrency,
    pairwiseDecisions,
    worktreeIdentity,
    changedFileOverlap,
    mergeBarrierCleared,
    terminalOutcomes: Object.fromEntries(Object.entries(ledger.items).map(([id, i]) => [id, i.state])),
    stop: ledger.stop,
  };
}
