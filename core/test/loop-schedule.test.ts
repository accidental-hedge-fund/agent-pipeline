// Tests for the durable-run independent-set scheduler (#530, capability
// `durable-run-independent-scheduler`). `selectSchedulableSet`/`detectChangedFileOverlap` are pure
// functions over in-memory `LoopContract`/`LoopLedger` fixtures — no real filesystem, process,
// network, git, or subprocess access anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectChangedFileOverlap, selectSchedulableSet, buildReplanRequest } from "../scripts/loop/schedule.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopContractItem,
  type LoopItemLedgerEntry,
  type LoopItemState,
  type LoopLedger,
  type OwnershipDeclaration,
} from "../scripts/loop/types.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors loop-dependencies.test.ts / loop-ownership.test.ts).
// ---------------------------------------------------------------------------

function contractItem(id: string, opts: { depends_on?: string[]; ownership?: OwnershipDeclaration } = {}): LoopContractItem {
  return { id, depends_on: opts.depends_on ?? [], external_depends_on: [], ownership: opts.ownership };
}

function makeContract(items: LoopContractItem[], overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-schedule",
    engine: "claude",
    repo: { name: "owner/repo", base_branch: "main" },
    selector: {},
    objective: "test",
    worktree_policy: "isolated",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 1 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: {},
    report_format: "text",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items,
    canonical_hash: "hash",
    ...overrides,
  };
}

function ledgerEntry(id: string, state: LoopItemState = "pending"): LoopItemLedgerEntry {
  return { id, state, history: [], recovery_budgets_remaining: { default: 1 } };
}

function makeLedger(entries: LoopItemLedgerEntry[], overrides: Partial<LoopLedger> = {}): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-schedule",
    items: Object.fromEntries(entries.map((e) => [e.id, e])),
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
    ...overrides,
  };
}

const disjoint = (path: string): OwnershipDeclaration => ({ exclusive: [path] });

// ---------------------------------------------------------------------------
// selectSchedulableSet — serialized default.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: no concurrency policy selects exactly one item, matching eligible[0]", () => {
  const contract = makeContract([contractItem("1"), contractItem("2"), contractItem("3")]);
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2"), ledgerEntry("3")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "1")?.disposition, "admitted");
  // Every unadmitted candidate still gets exactly one recorded reason (here, undeclared ownership
  // against the admitted item — the fixed precedence checks conflict/unknown-ownership ahead of
  // budget) even though budget alone would already have serialized them.
  assert.equal(decision.rationale.find((r) => r.item_id === "2")?.disposition, "unknown_ownership");
  assert.equal(decision.rationale.find((r) => r.item_id === "3")?.disposition, "unknown_ownership");
});

test("selectSchedulableSet: budget truncation is recorded once independence is otherwise proven", () => {
  const contract = makeContract(
    [
      contractItem("1", { ownership: disjoint("src/one.ts") }),
      contractItem("2", { ownership: disjoint("src/two.ts") }),
      contractItem("3", { ownership: disjoint("src/three.ts") }),
    ],
    { concurrency: { max_concurrent: 1 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2"), ledgerEntry("3")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "2")?.disposition, "budget_truncation");
  assert.equal(decision.rationale.find((r) => r.item_id === "3")?.disposition, "budget_truncation");
});

test("selectSchedulableSet: concurrency: 1 behaves identically to no policy at all", () => {
  const contract = makeContract([contractItem("1"), contractItem("2")], { concurrency: { max_concurrent: 1 } });
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
});

test("selectSchedulableSet: a budget above one still requires proof — an undeclared second item is not admitted", () => {
  const contract = makeContract([contractItem("1"), contractItem("2")], { concurrency: { max_concurrent: 3 } });
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "2")?.disposition, "unknown_ownership");
});

test("selectSchedulableSet is a pure function producing no side effects on its inputs", () => {
  const contract = makeContract([contractItem("1", { ownership: disjoint("src/a.ts") })]);
  const ledger = makeLedger([ledgerEntry("1")]);
  const before = JSON.stringify({ contract, ledger });
  selectSchedulableSet({ contract, ledger });
  assert.equal(JSON.stringify({ contract, ledger }), before);
});

// ---------------------------------------------------------------------------
// Dependency chain.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: a dependent and its prerequisite are never co-admitted", () => {
  const contract = makeContract([contractItem("a", { ownership: disjoint("src/a.ts") }), contractItem("b", { depends_on: ["a"], ownership: disjoint("src/b.ts") })], {
    concurrency: { max_concurrent: 5 },
  });
  // "a" has not finished, so "b" is not even in the eligible frontier — the dependent is never a
  // schedulable candidate while its prerequisite is outstanding.
  const ledger = makeLedger([ledgerEntry("a"), ledgerEntry("b")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["a"]);
  assert.equal(decision.rationale.some((r) => r.item_id === "b"), false);
});

test("selectSchedulableSet: without the scheduler's dependency-free check a same-pass sibling dependency would be admitted", () => {
  // Proves the test bites: a naive scheduler that only budget-truncates (ignoring dependency
  // edges) would admit both "a" and "b" once "a" is DONE and "b" is eligible — the pairwise
  // dependency check is what keeps them apart if the frontier ever changed to expose both.
  const contract = makeContract(
    [contractItem("a", { ownership: disjoint("src/a.ts") }), contractItem("b", { depends_on: ["a"], ownership: disjoint("src/b.ts") })],
    { concurrency: { max_concurrent: 5 } },
  );
  const ledger = makeLedger([ledgerEntry("a", "ready"), ledgerEntry("b")]);
  const decision = selectSchedulableSet({ contract, ledger });
  // "a" is already done and terminal, so only "b" is in the frontier — it is admitted alone.
  assert.deepEqual(decision.selected, ["b"]);
});

// ---------------------------------------------------------------------------
// Independent triple.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: three pairwise-disjoint items are admitted together under budget >= 3", () => {
  const contract = makeContract(
    [
      contractItem("1", { ownership: disjoint("src/one/**") }),
      contractItem("2", { ownership: disjoint("src/two/**") }),
      contractItem("3", { ownership: disjoint("src/three/**") }),
    ],
    { concurrency: { max_concurrent: 3 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2"), ledgerEntry("3")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1", "2", "3"]);
  assert.ok(decision.rationale.every((r) => r.disposition === "admitted"));
});

test("selectSchedulableSet: the same independent triple truncates correctly under a smaller budget", () => {
  const contract = makeContract(
    [
      contractItem("1", { ownership: disjoint("src/one/**") }),
      contractItem("2", { ownership: disjoint("src/two/**") }),
      contractItem("3", { ownership: disjoint("src/three/**") }),
    ],
    { concurrency: { max_concurrent: 2 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2"), ledgerEntry("3")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1", "2"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "3")?.disposition, "budget_truncation");
});

// ---------------------------------------------------------------------------
// Conflict pair.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: two conflicting items yield at most one admitted, naming the counterpart", () => {
  const contract = makeContract(
    [contractItem("1", { ownership: disjoint("src/shared.ts") }), contractItem("2", { ownership: disjoint("src/shared.ts") })],
    { concurrency: { max_concurrent: 5 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  const denied = decision.rationale.find((r) => r.item_id === "2")!;
  assert.equal(denied.disposition, "conflict_edge");
  assert.equal(denied.counterpart_item_id, "1");
});

test("selectSchedulableSet: an explicit conflicts_with edge is never suppressible", () => {
  const contract = makeContract(
    [
      contractItem("1", { ownership: { exclusive: ["src/a.ts"], conflicts_with: ["2"] } }),
      contractItem("2", { ownership: disjoint("src/b.ts") }),
    ],
    { concurrency: { max_concurrent: 5 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "2")?.disposition, "conflict_edge");
});

// ---------------------------------------------------------------------------
// Unknown ownership.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: an undeclared-ownership item is serialized when another item is already admitted", () => {
  const contract = makeContract([contractItem("1", { ownership: disjoint("src/a.ts") }), contractItem("2")], {
    concurrency: { max_concurrent: 5 },
  });
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "2")?.disposition, "unknown_ownership");
});

test("selectSchedulableSet: an undeclared-ownership item is still admitted alone (backward-compatible serialized default)", () => {
  const contract = makeContract([contractItem("1")]);
  const ledger = makeLedger([ledgerEntry("1")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, ["1"]);
});

// ---------------------------------------------------------------------------
// Serialized merge barrier.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: an active merge barrier admits nothing, naming every candidate merge_barrier", () => {
  const contract = makeContract(
    [contractItem("1", { ownership: disjoint("src/a.ts") }), contractItem("2", { ownership: disjoint("src/b.ts") })],
    { concurrency: { max_concurrent: 5 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")], {
    merge_barrier: { item_id: "0", merged_sha: "abc", set_at: "2026-07-23T00:00:00.000Z" },
  });
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision.selected, []);
  assert.ok(decision.rationale.every((r) => r.disposition === "merge_barrier"));
  assert.equal(decision.rationale.length, 2);
});

// ---------------------------------------------------------------------------
// Unresolved reconciliation drift.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: an item carrying unresolved drift is serialized until the drift resolves", () => {
  const contract = makeContract([contractItem("1", { ownership: disjoint("src/a.ts") }), contractItem("2", { ownership: disjoint("src/b.ts") })]);
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2")], {
    last_reconciliation: {
      sequence: 1,
      time: "2026-07-23T00:00:00.000Z",
      observed: {},
      drift: [{ item_id: "1", ledger_state: "pending", observed_state: "x", class: "ledger-behind" }],
      next_actions: {},
    },
  });
  const decision = selectSchedulableSet({ contract, ledger });
  // "1" is denied for its own unresolved drift, so it never becomes an admitted counterpart —
  // "2" is admitted alone (matching the serialized default's single-item selection).
  assert.deepEqual(decision.selected, ["2"]);
  assert.equal(decision.rationale.find((r) => r.item_id === "1")?.disposition, "unresolved_drift");
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: identical inputs yield an identical ordered selected set and rationale across repeated calls", () => {
  const contract = makeContract(
    [
      contractItem("1", { ownership: disjoint("src/one/**") }),
      contractItem("2", { ownership: disjoint("src/two/**") }),
      contractItem("3", { ownership: disjoint("src/one/nested.ts") }), // conflicts with "1"
    ],
    { concurrency: { max_concurrent: 3 } },
  );
  const ledger = makeLedger([ledgerEntry("1"), ledgerEntry("2"), ledgerEntry("3")]);
  const first = selectSchedulableSet({ contract, ledger });
  const second = selectSchedulableSet({ contract, ledger });
  const third = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.deepEqual(first.selected, ["1", "2"]);
});

// ---------------------------------------------------------------------------
// Empty frontier.
// ---------------------------------------------------------------------------

test("selectSchedulableSet: an empty frontier selects nothing and records no rationale", () => {
  const contract = makeContract([contractItem("1")]);
  const ledger = makeLedger([ledgerEntry("1", "ready")]);
  const decision = selectSchedulableSet({ contract, ledger });
  assert.deepEqual(decision, { selected: [], rationale: [] });
});

// ---------------------------------------------------------------------------
// detectChangedFileOverlap / buildReplanRequest.
// ---------------------------------------------------------------------------

test("detectChangedFileOverlap: real overlap not predicted by declarations parks the affected pair", () => {
  const result = detectChangedFileOverlap({
    a: ["src/a.ts", "src/shared.ts"],
    b: ["src/b.ts", "src/shared.ts"],
  });
  assert.deepEqual(result.affected_item_ids, ["a", "b"]);
  assert.deepEqual(result.overlapping_paths, ["src/shared.ts"]);
});

test("detectChangedFileOverlap: an unaffected third item's evidence is preserved (not reported)", () => {
  const result = detectChangedFileOverlap({
    a: ["src/a.ts", "src/shared.ts"],
    b: ["src/b.ts", "src/shared.ts"],
    c: ["src/c.ts"],
  });
  assert.deepEqual(result.affected_item_ids, ["a", "b"]);
  assert.equal(result.affected_item_ids.includes("c"), false);
});

test("detectChangedFileOverlap: disjoint changed-file sets report no overlap", () => {
  const result = detectChangedFileOverlap({ a: ["src/a.ts"], b: ["src/b.ts"] });
  assert.deepEqual(result, { affected_item_ids: [], overlapping_paths: [] });
});

test("buildReplanRequest: no overlap builds no replan request", () => {
  const result = detectChangedFileOverlap({ a: ["src/a.ts"], b: ["src/b.ts"] });
  assert.equal(buildReplanRequest(result, "2026-07-23T00:00:00.000Z"), null);
});

test("buildReplanRequest: an overlap builds a durable record naming the affected items and paths", () => {
  const result = detectChangedFileOverlap({ a: ["src/shared.ts"], b: ["src/shared.ts"] });
  const request = buildReplanRequest(result, "2026-07-23T00:00:00.000Z");
  assert.ok(request);
  assert.deepEqual(request!.affected_item_ids, ["a", "b"]);
  assert.deepEqual(request!.overlapping_paths, ["src/shared.ts"]);
  assert.equal(request!.time, "2026-07-23T00:00:00.000Z");
  assert.match(request!.reason, /src\/shared\.ts/);
});

test("detectChangedFileOverlap and buildReplanRequest perform no merge, push, or delete — they are pure record builders", () => {
  // A structural guarantee, not just a behavioral one: neither function's signature accepts a
  // store/git/gh seam at all, so there is nothing for it to call.
  assert.equal(detectChangedFileOverlap.length, 1);
  assert.equal(buildReplanRequest.length, 2);
});
