// Run-scoped parallelization decision ledger (#528, capability
// `conflict-aware-parallel-execution`). Unit tests for the pure accumulation
// loop/parallelization-ledger.ts implements over the independent-set scheduler's (#530) already-
// emitted per-pass planning records — see
// openspec/changes/conflict-aware-parallel-execution/design.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateParallelizationLedger,
  parallelizationLedgerFromEvents,
  scheduleDecisionsFromEvents,
} from "../scripts/loop/parallelization-ledger.ts";
import { isScheduleDisposition, SCHEDULE_DISPOSITIONS, type LoopEvent, type ScheduleDecision } from "../scripts/loop/types.ts";

function event(seq: number, kind: string, data: unknown): LoopEvent {
  return { seq, time: `2026-07-23T00:00:${String(seq).padStart(2, "0")}.000Z`, kind, data };
}

test("accumulateParallelizationLedger: two admitted items yield one parallelized/admitted entry", () => {
  const decision: ScheduleDecision = {
    selected: ["A", "B"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "B", disposition: "admitted" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.deepEqual(entries, [{ a_item_id: "A", b_item_id: "B", disposition: "parallelized", reason: "admitted" }]);
});

test("accumulateParallelizationLedger: a mixed frontier yields one entry per evaluated pair with a reason each", () => {
  // A proven-disjoint pair (A, B, both admitted), an unknown-ownership pair (A, C), and a
  // conflicting pair (A, E) — the epic's acceptance-criterion shape (proposal.md).
  const decision: ScheduleDecision = {
    selected: ["A", "B"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "B", disposition: "admitted" },
      { item_id: "C", disposition: "unknown_ownership", counterpart_item_id: "A", detail: "C carries no ownership declaration" },
      { item_id: "E", disposition: "conflict_edge", counterpart_item_id: "A", detail: "explicit conflicts_with edge" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.equal(entries.length, 3, "exactly one entry per evaluated pair — (A,B), (A,C), (A,E)");
  const byPair = new Map(entries.map((e) => [`${e.a_item_id}:${e.b_item_id}`, e]));
  assert.deepEqual(byPair.get("A:B"), { a_item_id: "A", b_item_id: "B", disposition: "parallelized", reason: "admitted" });
  assert.deepEqual(byPair.get("A:C"), {
    a_item_id: "A",
    b_item_id: "C",
    disposition: "serialized",
    reason: "unknown_ownership",
    detail: "C carries no ownership declaration",
  });
  assert.deepEqual(byPair.get("A:E"), {
    a_item_id: "A",
    b_item_id: "E",
    disposition: "serialized",
    reason: "conflict_edge",
    detail: "explicit conflicts_with edge",
  });
});

test("accumulateParallelizationLedger: a serialized pair names its structured reason (conflict-edge surface)", () => {
  const decision: ScheduleDecision = {
    selected: ["A"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "E", disposition: "conflict_edge", counterpart_item_id: "A", detail: "shared_config:release.yml" },
    ],
  };
  const [entry] = accumulateParallelizationLedger([decision]);
  assert.equal(entry.disposition, "serialized");
  assert.equal(entry.reason, "conflict_edge");
  assert.equal(entry.detail, "shared_config:release.yml", "the conflict-edge reason's naming detail must survive into the ledger entry");
  assert.deepEqual([entry.a_item_id, entry.b_item_id].sort(), ["A", "E"]);
});

test("accumulateParallelizationLedger: a pair is recorded exactly once regardless of item order", () => {
  const decision: ScheduleDecision = {
    selected: ["B", "A"],
    rationale: [
      { item_id: "B", disposition: "admitted" },
      { item_id: "A", disposition: "admitted" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].a_item_id, "A", "the pair is recorded in canonical (lexically-sorted) order");
  assert.equal(entries[0].b_item_id, "B");
});

test("accumulateParallelizationLedger: a no-counterpart denial (merge_barrier) serializes against every other evaluated candidate", () => {
  const decision: ScheduleDecision = {
    selected: [],
    rationale: [
      { item_id: "A", disposition: "merge_barrier" },
      { item_id: "B", disposition: "merge_barrier" },
      { item_id: "C", disposition: "merge_barrier" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.equal(entries.length, 3, "3 candidates denied for a uniform no-counterpart reason yield the 3 pairwise combinations");
  for (const entry of entries) {
    assert.equal(entry.disposition, "serialized");
    assert.equal(entry.reason, "merge_barrier");
  }
});

test("accumulateParallelizationLedger: budget_truncation is recorded against the admitted item(s) it lost budget to", () => {
  const decision: ScheduleDecision = {
    selected: ["A"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "B", disposition: "budget_truncation" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.deepEqual(entries, [{ a_item_id: "A", b_item_id: "B", disposition: "serialized", reason: "budget_truncation" }]);
});

test("accumulateParallelizationLedger: is append-only across passes — the same pair evaluated in two passes yields two entries", () => {
  const passOne: ScheduleDecision = {
    selected: [],
    rationale: [
      { item_id: "A", disposition: "unresolved_drift" },
      { item_id: "B", disposition: "unresolved_drift" },
    ],
  };
  const passTwo: ScheduleDecision = {
    selected: ["A", "B"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "B", disposition: "admitted" },
    ],
  };
  const entries = accumulateParallelizationLedger([passOne, passTwo]);
  assert.equal(entries.length, 2, "the ledger is append-only: it never re-decides or collapses a pair's earlier recorded history");
  assert.equal(entries[0].reason, "unresolved_drift");
  assert.equal(entries[1].reason, "admitted");
});

test("accumulateParallelizationLedger: a single admitted candidate with no peer yields no entries", () => {
  const decision: ScheduleDecision = { selected: ["A"], rationale: [{ item_id: "A", disposition: "admitted" }] };
  assert.deepEqual(accumulateParallelizationLedger([decision]), []);
});

// ---------------------------------------------------------------------------
// Reconstruction from durable events (design.md Decision 2).
// ---------------------------------------------------------------------------

test("parallelizationLedgerFromEvents: reconstructs the ledger from the durable event log alone, ignoring unrelated events", () => {
  const decision: ScheduleDecision = {
    selected: ["A", "B"],
    rationale: [
      { item_id: "A", disposition: "admitted" },
      { item_id: "B", disposition: "admitted" },
    ],
  };
  const events: LoopEvent[] = [
    event(1, "loop_ownership_evaluated", { items: [], pairs: [] }),
    event(2, "loop_schedule_evaluated", decision),
    event(3, "loop_replan_requested", { affected_item_ids: [], overlapping_paths: [], reason: "" }),
  ];
  assert.equal(scheduleDecisionsFromEvents(events).length, 1);
  const entries = parallelizationLedgerFromEvents(events);
  assert.deepEqual(entries, [{ a_item_id: "A", b_item_id: "B", disposition: "parallelized", reason: "admitted" }]);
});

// ---------------------------------------------------------------------------
// 2.4 — drift-guard: every ledger reason is a member of the scheduler's closed reason set.
// ---------------------------------------------------------------------------

test("drift-guard: every ledger reason produced from a decision carrying every closed scheduler disposition stays within that closed set", () => {
  const decision: ScheduleDecision = {
    selected: ["ADMIT_1", "ADMIT_2"],
    rationale: [
      { item_id: "ADMIT_1", disposition: "admitted" },
      { item_id: "ADMIT_2", disposition: "admitted" },
      { item_id: "DEP", disposition: "dependency_path", counterpart_item_id: "ADMIT_1" },
      { item_id: "CONF", disposition: "conflict_edge", counterpart_item_id: "ADMIT_1" },
      { item_id: "UNK", disposition: "unknown_ownership", counterpart_item_id: "ADMIT_1" },
      { item_id: "BARRIER_1", disposition: "merge_barrier" },
      { item_id: "BARRIER_2", disposition: "merge_barrier" },
      { item_id: "DRIFT_1", disposition: "unresolved_drift" },
      { item_id: "DRIFT_2", disposition: "unresolved_drift" },
      { item_id: "BUDGET_1", disposition: "budget_truncation" },
      { item_id: "BUDGET_2", disposition: "budget_truncation" },
    ],
  };
  const entries = accumulateParallelizationLedger([decision]);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(
      isScheduleDisposition(entry.reason),
      `ledger reason "${entry.reason}" must be a member of the scheduler's closed reason set`,
    );
  }
  // Every closed-set disposition actually reachable as a ledger reason — proving no scheduler
  // disposition silently bypasses the ledger.
  const reasonsSeen = new Set(entries.map((e) => e.reason));
  for (const disposition of SCHEDULE_DISPOSITIONS) {
    assert.ok(reasonsSeen.has(disposition), `disposition "${disposition}" must be reachable as a ledger reason`);
  }
});

test("bite check: an out-of-closed-set reason would be caught by the drift guard", () => {
  // Proves the drift-guard assertion actually bites rather than trivially passing.
  const forged = { a_item_id: "A", b_item_id: "B", disposition: "serialized" as const, reason: "not_a_real_reason" as never };
  assert.equal(isScheduleDisposition(forged.reason), false, "a reason outside the closed set must fail the membership check");
});
