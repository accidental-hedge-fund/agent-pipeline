// Tests for the loop precondition stage gate (#568, capability
// `loop-precondition-stage-gate`). Every function under test here is pure —
// no gh, git, fs, clock, or store access — so these are plain unit tests over
// in-memory fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRECONDITION_REQUIRED_STAGE,
  buildPreconditionExclusion,
  classifyPreconditionExclusions,
  excludeContractItems,
  hasNewLabelEvent,
  isPrePipelineStage,
  pipelineStageFromLabels,
} from "../scripts/loop/precondition.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA, type LoopContract, type LoopExternalIdentity, type LoopLedger } from "../scripts/loop/types.ts";

function identity(overrides: Partial<LoopExternalIdentity> = {}): LoopExternalIdentity {
  return {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    pr_number: null,
    pr_state: null,
    head_branch: "",
    head_sha: "",
    merge_commit_sha: null,
    checks_conclusion: "none",
    pipeline_stage: null,
    observed_at: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
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
    recovery_policy: {} as LoopContract["recovery_policy"],
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

function itemEntry(id: string, state: LoopLedger["items"][string]["state"]): LoopLedger["items"][string] {
  return { id, state, history: [], recovery_budgets_remaining: { default: 3 } };
}

function testLedger(items: LoopLedger["items"], observed: Record<string, LoopExternalIdentity> = {}): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items,
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation:
      Object.keys(observed).length > 0
        ? { sequence: 1, time: "2026-07-24T00:00:00.000Z", observed, drift: [], next_actions: {} }
        : null,
    reconciliation_sequence: Object.keys(observed).length > 0 ? 1 : 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

// ---------------------------------------------------------------------------
// isPrePipelineStage
// ---------------------------------------------------------------------------

test("isPrePipelineStage: null (no pipeline:* label) is pre-pipeline", () => {
  assert.equal(isPrePipelineStage(null), true);
});

test("isPrePipelineStage: backlog is pre-pipeline", () => {
  assert.equal(isPrePipelineStage("backlog"), true);
});

test("isPrePipelineStage: ready is admissible", () => {
  assert.equal(isPrePipelineStage("ready"), false);
});

test("isPrePipelineStage: an in-flight advance-loop stage is admissible", () => {
  assert.equal(isPrePipelineStage("review-1"), false);
  assert.equal(isPrePipelineStage("planning"), false);
});

test("isPrePipelineStage: ready-to-deploy is admissible", () => {
  assert.equal(isPrePipelineStage("ready-to-deploy"), false);
});

// ---------------------------------------------------------------------------
// pipelineStageFromLabels
// ---------------------------------------------------------------------------

test("pipelineStageFromLabels: no pipeline:* label -> null", () => {
  assert.equal(pipelineStageFromLabels([]), null);
  assert.equal(pipelineStageFromLabels(["bug", "priority:high"]), null);
});

test("pipelineStageFromLabels: extracts the suffix after the pipeline: prefix", () => {
  assert.equal(pipelineStageFromLabels(["pipeline:backlog"]), "backlog");
  assert.equal(pipelineStageFromLabels(["some-other-label", "pipeline:ready"]), "ready");
});

// ---------------------------------------------------------------------------
// buildPreconditionExclusion
// ---------------------------------------------------------------------------

test("buildPreconditionExclusion: names the required stage and 'none' for an absent label", () => {
  const exclusion = buildPreconditionExclusion("100", null);
  assert.deepEqual(exclusion, { item_id: "100", required_stage: PRECONDITION_REQUIRED_STAGE, observed_stage: "none" });
});

test("buildPreconditionExclusion: renders the observed stage as a full pipeline:<stage> label", () => {
  const exclusion = buildPreconditionExclusion("100", "backlog");
  assert.deepEqual(exclusion, { item_id: "100", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" });
});

// ---------------------------------------------------------------------------
// classifyPreconditionExclusions
// ---------------------------------------------------------------------------

test("classifyPreconditionExclusions: excludes a pending item observed at pipeline:backlog", () => {
  const contract = testContract();
  const ledger = testLedger({ "100": itemEntry("100", "pending") }, { "100": identity({ pipeline_stage: "backlog" }) });
  const exclusions = classifyPreconditionExclusions(contract, ledger);
  assert.deepEqual(exclusions, [{ item_id: "100", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" }]);
});

test("classifyPreconditionExclusions: excludes a pending item observed with no pipeline:* label", () => {
  const contract = testContract();
  const ledger = testLedger({ "100": itemEntry("100", "pending") }, { "100": identity({ pipeline_stage: null }) });
  const exclusions = classifyPreconditionExclusions(contract, ledger);
  assert.deepEqual(exclusions, [{ item_id: "100", required_stage: "pipeline:ready", observed_stage: "none" }]);
});

test("classifyPreconditionExclusions: does not exclude a pending item observed at pipeline:ready", () => {
  const contract = testContract();
  const ledger = testLedger({ "100": itemEntry("100", "pending") }, { "100": identity({ pipeline_stage: "ready" }) });
  assert.deepEqual(classifyPreconditionExclusions(contract, ledger), []);
});

test("classifyPreconditionExclusions: never excludes a non-pending item, even if observed pre-pipeline", () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "in_progress") }, { "100": identity({ pipeline_stage: "backlog" }) });
  assert.deepEqual(classifyPreconditionExclusions(contract, ledger), []);
});

test("classifyPreconditionExclusions: an item with no observed identity this cycle is never excluded (reconciliation has not run yet)", () => {
  const contract = testContract();
  const ledger = testLedger({ "100": itemEntry("100", "pending") }); // no observed entry at all
  assert.deepEqual(classifyPreconditionExclusions(contract, ledger), []);
});

test("classifyPreconditionExclusions: a mixed frontier excludes only the pre-pipeline items, in contract order", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: [], external_depends_on: [] },
      { id: "300", depends_on: [], external_depends_on: [] },
    ],
  });
  const ledger = testLedger(
    {
      "100": itemEntry("100", "pending"),
      "200": itemEntry("200", "pending"),
      "300": itemEntry("300", "pending"),
    },
    {
      "100": identity({ issue_number: 100, pipeline_stage: "backlog" }),
      "200": identity({ issue_number: 200, pipeline_stage: "ready" }),
      "300": identity({ issue_number: 300, pipeline_stage: null }),
    },
  );
  const exclusions = classifyPreconditionExclusions(contract, ledger);
  assert.deepEqual(exclusions.map((e) => e.item_id), ["100", "300"]);
});

// ---------------------------------------------------------------------------
// excludeContractItems
// ---------------------------------------------------------------------------

test("excludeContractItems: returns the same contract reference when nothing is excluded", () => {
  const contract = testContract();
  assert.equal(excludeContractItems(contract, new Set()), contract);
});

test("excludeContractItems: removes only the named items, preserving every other field", () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [], external_depends_on: [] },
      { id: "200", depends_on: [], external_depends_on: [] },
    ],
  });
  const pruned = excludeContractItems(contract, new Set(["100"]));
  assert.deepEqual(pruned.items.map((i) => i.id), ["200"]);
  assert.equal(pruned.run_id, contract.run_id);
  assert.equal(pruned.canonical_hash, contract.canonical_hash);
});

// ---------------------------------------------------------------------------
// hasNewLabelEvent (#568 review 1, finding f09d500c)
// ---------------------------------------------------------------------------

test("hasNewLabelEvent: false when after is identical to before", () => {
  const before = [{ label: "pipeline:backlog", createdAt: "2026-07-23T00:00:00.000Z" }];
  const after = [{ label: "pipeline:backlog", createdAt: "2026-07-23T00:00:00.000Z" }];
  assert.equal(hasNewLabelEvent(before, after), false);
});

test("hasNewLabelEvent: false when both are empty", () => {
  assert.equal(hasNewLabelEvent([], []), false);
});

test("hasNewLabelEvent: true when after contains an event not present in before, regardless of what any local clock says", () => {
  const before: { label: string; createdAt: string }[] = [];
  const after = [
    { label: "pipeline:ready", createdAt: "2026-07-23T00:00:01.000Z" },
    { label: "pipeline:backlog", createdAt: "2026-07-23T00:00:02.000Z" },
  ];
  assert.equal(hasNewLabelEvent(before, after), true);
});

test("hasNewLabelEvent: a duplicate event already present in before is not counted as new", () => {
  const before = [{ label: "pipeline:backlog", createdAt: "2026-07-23T00:00:00.000Z" }];
  const after = [
    { label: "pipeline:backlog", createdAt: "2026-07-23T00:00:00.000Z" },
    { label: "pipeline:backlog", createdAt: "2026-07-23T00:00:00.000Z" },
  ];
  assert.equal(hasNewLabelEvent(before, after), true, "a second occurrence of the same (label, createdAt) pair is a genuinely new event");
});
