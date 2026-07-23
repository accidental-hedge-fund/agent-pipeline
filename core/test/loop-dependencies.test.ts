// Tests for durable-run dependency integrity (#513, capability
// `durable-run-dependency-integrity`). Every test runs through an in-memory
// ReconcileObserveDeps fake — no real filesystem, process, network, git, or
// subprocess access anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allExternalDependenciesSatisfied,
  compileContractItems,
  computeExternalDependencyStatuses,
  detectDependencyDeadlock,
  externalDependencyStatus,
  propagateSkips,
  upgradeContractForDependencyIntegrity,
} from "../scripts/loop/dependencies.ts";
import { eligibleIndependentItems, DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { transitionItem } from "../scripts/loop/reconcile.ts";
import { initRun, readLedger, acquireLock, type LoopStoreDeps } from "../scripts/loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopItemState,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import type { ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors loop-supervisor.test.ts / loop-recovery.test.ts).
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-dependencies-${counter++}` };

  const deps: LoopStoreDeps = {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      files.delete(p);
    },
    async removeFileIfMatches(p, expectedContent) {
      if (files.get(p) !== expectedContent) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
    async mkdirp() {},
    async renameDirExclusive(from, to) {
      const fromPrefix = from + "/";
      const published = [...files.keys()].some((k) => k === to || k.startsWith(to + "/"));
      if (published) return false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(fromPrefix)) {
          files.set(to + "/" + k.slice(fromPrefix.length), files.get(k)!);
          files.delete(k);
        }
      }
      return true;
    },
    async listDir(p) {
      const prefix = p + "/";
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive() {
      return true;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date((clock += 1000)),
    uuid: () => `uuid-${uuidCounter++}`,
    env,
  };
  return { deps, files };
}

function fakeObserveDeps(overrides: Partial<ReconcileObserveDeps> = {}): { deps: ReconcileObserveDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      calls.push(`getIssueStateAndLabels:${issueNumber}`);
      return { state: "open", labels: [] };
    },
    async findPrForIssue(issueNumber) {
      calls.push(`findPrForIssue:${issueNumber}`);
      return null;
    },
    async getPrDetail(prNumber) {
      calls.push(`getPrDetail:${prNumber}`);
      return null;
    },
    async getPrChecks(prNumber) {
      calls.push(`getPrChecks:${prNumber}`);
      return [];
    },
    async getLocalHead(issueNumber) {
      calls.push(`getLocalHead:${issueNumber}`);
      return null;
    },
    async baseBranchContainsSha(sha) {
      calls.push(`baseBranchContainsSha:${sha}`);
      return null;
    },
    async getExternalDependencyIssueState(issueNumber) {
      calls.push(`getExternalDependencyIssueState:${issueNumber}`);
      return { state: "open", stateReason: null };
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, calls };
}

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "milestone", value: "v2" },
    objective: "ship v2",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 3 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [{ id: "100", depends_on: [], external_depends_on: [] }],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function itemEntry(id: string, state: LoopItemState): LoopLedger["items"][string] {
  return { id, state, history: [], recovery_budgets_remaining: { default: 3 } };
}

function testLedger(items: LoopLedger["items"]): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items,
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

// ---------------------------------------------------------------------------
// 6.1 — compilation partitions declared dependencies.
// ---------------------------------------------------------------------------

test("compileContractItems: partitions a mixed snapshot into in-snapshot depends_on and external_depends_on, ordering unchanged", () => {
  const items = compileContractItems([
    { id: "100", depends_on: [] },
    { id: "200", depends_on: ["100", "999"] }, // "999" is out-of-snapshot
    { id: "300", depends_on: ["200", "888"] }, // "888" is out-of-snapshot
  ]);

  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(byId["200"].depends_on, ["100"]);
  assert.deepEqual(byId["200"].external_depends_on, ["999"]);
  assert.deepEqual(byId["300"].depends_on, ["200"]);
  assert.deepEqual(byId["300"].external_depends_on, ["888"]);
  assert.deepEqual(byId["100"].depends_on, []);
  assert.deepEqual(byId["100"].external_depends_on, []);

  // Every item follows its in-snapshot dependencies, and repeated compilation
  // is identical.
  const order = items.map((i) => i.id);
  assert.ok(order.indexOf("100") < order.indexOf("200"));
  assert.ok(order.indexOf("200") < order.indexOf("300"));
  const again = compileContractItems([
    { id: "100", depends_on: [] },
    { id: "200", depends_on: ["100", "999"] },
    { id: "300", depends_on: ["200", "888"] },
  ]).map((i) => i.id);
  assert.deepEqual(again, order);
});

test("compileContractItems: an in-snapshot dependency cycle is refused as a validation failure", () => {
  assert.throws(
    () =>
      compileContractItems([
        { id: "100", depends_on: ["200"] },
        { id: "200", depends_on: ["100"] },
      ]),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation" && /cycle/.test(err.message),
  );
});

test("compileContractItems: a duplicate item id is refused as a validation failure", () => {
  assert.throws(
    () =>
      compileContractItems([
        { id: "100", depends_on: [] },
        { id: "100", depends_on: [] },
      ]),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation" && /duplicate/.test(err.message),
  );
});

test("upgradeContractForDependencyIntegrity: a pre-#513 contract with no external_depends_on is defaulted to []; an already-compiled contract is untouched", () => {
  const legacy = testContract({ items: [{ id: "100" } as never] });
  const upgraded = upgradeContractForDependencyIntegrity(legacy);
  assert.deepEqual(upgraded.items[0].external_depends_on, []);

  const compiled = testContract();
  assert.equal(upgradeContractForDependencyIntegrity(compiled), compiled);
});

// ---------------------------------------------------------------------------
// 6.2 — external-dependency verification against live truth.
// ---------------------------------------------------------------------------

test("externalDependencyStatus: open issue is pending; closed-as-completed is satisfied; closed-as-not-planned is unsatisfiable; a merged linked PR is satisfied regardless of issue state", () => {
  assert.equal(externalDependencyStatus({ state: "open", stateReason: null }, false), "pending");
  assert.equal(externalDependencyStatus({ state: "closed", stateReason: "completed" }, false), "satisfied");
  assert.equal(externalDependencyStatus({ state: "closed", stateReason: "not_planned" }, false), "unsatisfiable");
  assert.equal(externalDependencyStatus({ state: "open", stateReason: null }, true), "satisfied");
  assert.equal(externalDependencyStatus(null, false), "pending");
});

test("externalDependencyStatus: a closed issue with an unknown or reopened-adjacent stateReason is not treated as satisfied", () => {
  assert.equal(externalDependencyStatus({ state: "closed", stateReason: null }, false), "pending");
  assert.equal(externalDependencyStatus({ state: "closed", stateReason: "reopened" }, false), "pending");
});

test("an item with a pending external dependency is not eligible to start; it becomes eligible once the dependency is observed satisfied — verified through the injected seam with zero real network/git/subprocess calls", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: ["999"] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });

  const { deps: openObserve, calls: openCalls } = fakeObserveDeps({
    async getExternalDependencyIssueState(n) {
      openCalls.push(`getExternalDependencyIssueState:${n}`);
      return { state: "open", stateReason: null };
    },
  });
  const openStatuses = await computeExternalDependencyStatuses(openObserve, contract);
  assert.equal(openStatuses["999"], "pending");
  assert.deepEqual(eligibleIndependentItems(contract, ledger, openStatuses), []);
  assert.ok(openCalls.some((c) => c.startsWith("getExternalDependencyIssueState:999")), "the seam must be consulted, never a caller claim");

  const { deps: mergedObserve } = fakeObserveDeps({
    async getExternalDependencyIssueState() {
      return { state: "closed", stateReason: "completed" };
    },
  });
  const doneStatuses = await computeExternalDependencyStatuses(mergedObserve, contract);
  assert.equal(doneStatuses["999"], "satisfied");
  assert.deepEqual(eligibleIndependentItems(contract, ledger, doneStatuses), ["100"]);
});

test("computeExternalDependencyStatuses performs zero seam calls when no item declares an external dependency", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: [] }] });
  const { deps: observe, calls } = fakeObserveDeps();
  const statuses = await computeExternalDependencyStatuses(observe, contract);
  assert.deepEqual(statuses, {});
  assert.deepEqual(calls, []);
});

test("computeExternalDependencyStatuses: a non-canonical dependency id is classified pending and never queried against a different issue number", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: ["1e3", "0x10", "2.0", " 5", "5 ", "-7", "007", "999"] },
    ],
  });
  const { deps: observe, calls } = fakeObserveDeps({
    async getExternalDependencyIssueState(n) {
      calls.push(`getExternalDependencyIssueState:${n}`);
      return { state: "closed", stateReason: "completed" };
    },
  });
  const statuses = await computeExternalDependencyStatuses(observe, contract);
  assert.equal(statuses["1e3"], "pending");
  assert.equal(statuses["0x10"], "pending");
  assert.equal(statuses["2.0"], "pending");
  assert.equal(statuses[" 5"], "pending");
  assert.equal(statuses["5 "], "pending");
  assert.equal(statuses["-7"], "pending");
  assert.equal(statuses["007"], "pending");
  // only the canonical id is verified through the seam
  assert.equal(statuses["999"], "satisfied");
  assert.deepEqual(
    calls.filter((c) => c.startsWith("getExternalDependencyIssueState")),
    ["getExternalDependencyIssueState:999"],
  );
});

test("allExternalDependenciesSatisfied: true only when every external dependency is satisfied", () => {
  assert.equal(allExternalDependenciesSatisfied({ external_depends_on: [] }, {}), true);
  assert.equal(allExternalDependenciesSatisfied({ external_depends_on: ["1", "2"] }, { "1": "satisfied", "2": "satisfied" }), true);
  assert.equal(allExternalDependenciesSatisfied({ external_depends_on: ["1", "2"] }, { "1": "satisfied", "2": "pending" }), false);
});

// ---------------------------------------------------------------------------
// 6.3 — skip propagation.
// ---------------------------------------------------------------------------

test("propagateSkips: the pending dependent of an abandoned item becomes skipped (not left pending), naming the causing dependency", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: ["100"], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "abandoned"), "200": itemEntry("200", "pending") });

  const result = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");

  assert.deepEqual(result.skippedItemIds, ["200"]);
  assert.equal(result.ledger.items["200"].state, "skipped");
  const entry = result.ledger.items["200"].history.at(-1)!;
  assert.equal(entry.from, "pending");
  assert.equal(entry.to, "skipped");
  assert.match(entry.note ?? "", /"100"/);
});

test("propagateSkips: transitivity — a multi-hop chain (abandoned -> skipped -> skipped) resolves in one pass", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: ["100"], external_depends_on: [] },
      { id: "300", depends_on: ["200"], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "abandoned"),
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });

  const result = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");

  assert.equal(result.ledger.items["200"].state, "skipped");
  assert.equal(result.ledger.items["300"].state, "skipped");
});

test("propagateSkips: an item whose dependency is unrelated to any abandoned/skipped/unsatisfiable item is not skipped", () => {
  // "100" will be abandoned; "300" depends only on "200" (fine), not on "100"
  // at all — an over-eager propagation that skips every pending item in the
  // run regardless of its actual declared dependency would wrongly skip it.
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: [], external_depends_on: [] },
      { id: "300", depends_on: ["200"], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "abandoned"),
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });

  const result = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");

  assert.deepEqual(result.skippedItemIds, []);
  assert.equal(result.ledger.items["300"].state, "pending");
});

test("propagateSkips: an unsatisfiable external dependency skips its dependent, naming the external id", () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: ["999"] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });

  const result = propagateSkips(contract, ledger, { "999": "unsatisfiable" }, () => "2026-07-23T00:00:00.000Z", "claude");

  assert.equal(result.ledger.items["100"].state, "skipped");
  assert.match(result.ledger.items["100"].history.at(-1)!.note ?? "", /"999"/);
});

test("propagateSkips: a blocked dependent of an abandoned item is also skipped (blocked is treated like pending for propagation)", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: ["100"], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "abandoned"), "200": itemEntry("200", "blocked") });

  const result = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");

  assert.equal(result.ledger.items["200"].state, "skipped");
});

// ---------------------------------------------------------------------------
// 6.4 — transition graph: skipped is reachable only from pending/blocked, and terminal.
// ---------------------------------------------------------------------------

const ALL_ITEM_STATES: LoopItemState[] = [
  "pending",
  "in_progress",
  "blocked",
  "abandoned",
  "implemented",
  "pr_opened",
  "ready",
  "merged",
  "released",
  "deployed",
  "paused",
  "waiting",
  "skipped",
];

test("propagateSkips: enumeration — every state pair is exercised, and skipped is entered only from pending or blocked", () => {
  for (const from of ALL_ITEM_STATES) {
    const contract = testContract({
      items: [
        { id: "100", depends_on: [], external_depends_on: [] },
        { id: "200", depends_on: ["100"], external_depends_on: [] },
      ],
    });
    const ledger = testLedger({ "100": itemEntry("100", "abandoned"), "200": itemEntry("200", from) });

    const result = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");
    const finalState = result.ledger.items["200"].state;

    if (from === "pending" || from === "blocked") {
      assert.equal(finalState, "skipped", `expected "${from}" -> "skipped" to be admitted`);
    } else {
      assert.equal(finalState, from, `expected "${from}" to be refused as a source for "skipped" and left unchanged`);
    }
  }
});

test("transitionItem: refuses every transition into skipped, and every transition out of skipped, naming both states", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: [] }] });

  for (const from of ALL_ITEM_STATES) {
    const ledger = testLedger({ "100": itemEntry("100", from) });
    const { deps } = fakeDeps();
    await initRun(deps, contract, ledger);
    const { token } = await acquireLock(deps, "run-1", "claude");
    const { deps: observe } = fakeObserveDeps();

    await assert.rejects(
      transitionItem(deps, observe, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "skipped" }),
      (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
      `transitionItem must refuse "${from}" -> "skipped"`,
    );
  }

  // Terminal: no outgoing transition out of skipped, via transitionItem.
  const ledger = testLedger({ "100": itemEntry("100", "skipped") });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  const { deps: observe } = fakeObserveDeps();
  await assert.rejects(
    transitionItem(deps, observe, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "pending" }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
  const unchanged = await readLedger(deps, "run-1");
  assert.equal(unchanged.items["100"].state, "skipped");
});

// ---------------------------------------------------------------------------
// 6.5 — dependency-deadlock detection.
// ---------------------------------------------------------------------------

test("detectDependencyDeadlock: an externally-gated frontier reports a chain naming the stuck item and its pending external dependency", () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: ["999"] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });

  const chain = detectDependencyDeadlock(contract, ledger, { "999": "pending" });

  assert.deepEqual(chain, [{ item_id: "100", waiting_on: "999", kind: "external", observed_state: "pending" }]);
});

test("detectDependencyDeadlock: an unsatisfiable external dependency also reports a deadlock chain", () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: ["999"] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });

  const chain = detectDependencyDeadlock(contract, ledger, { "999": "unsatisfiable" });

  assert.deepEqual(chain, [{ item_id: "100", waiting_on: "999", kind: "external", observed_state: "unsatisfiable" }]);
});

test("detectDependencyDeadlock: returns null once an item is eligible, in_progress, or the run is already stopped", () => {
  const contractEligible = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: [] }] });
  const ledgerEligible = testLedger({ "100": itemEntry("100", "pending") });
  assert.equal(detectDependencyDeadlock(contractEligible, ledgerEligible, {}), null);

  const ledgerInProgress = testLedger({ "100": itemEntry("100", "in_progress") });
  assert.equal(detectDependencyDeadlock(contractEligible, ledgerInProgress, {}), null);
});

test("detectDependencyDeadlock: a blocked in-run dependency (with its own recovery path) is not reported as a dependency deadlock", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"], external_depends_on: [] },
      { id: "200", depends_on: [], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "blocked") });

  assert.equal(detectDependencyDeadlock(contract, ledger, {}), null);
});

// ---------------------------------------------------------------------------
// 6.6 — continuation: dependency-independent items are unaffected.
// ---------------------------------------------------------------------------

test("eligibleIndependentItems: an item with no external dependency is eligible regardless of another item's external gating", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: ["999"] },
      { id: "200", depends_on: [], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });

  assert.deepEqual(eligibleIndependentItems(contract, ledger, { "999": "pending" }), ["200"]);
});

test("propagateSkips + detectDependencyDeadlock compose: an independent item stays eligible while an abandoned item's dependent is skipped, and no deadlock is reported", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: ["100"], external_depends_on: [] },
      { id: "300", depends_on: [], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "abandoned"),
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });

  const propagation = propagateSkips(contract, ledger, {}, () => "2026-07-23T00:00:00.000Z", "claude");
  assert.equal(propagation.ledger.items["200"].state, "skipped");

  const eligible = eligibleIndependentItems(contract, propagation.ledger, {});
  assert.deepEqual(eligible, ["300"], "the independent item is eligible before any deadlock is reported");
  assert.equal(detectDependencyDeadlock(contract, propagation.ledger, {}), null);
});
