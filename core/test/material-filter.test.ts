// Unit tests for the shared events.jsonl material filter (#742).
// Pure fixtures — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADVANCE_MATERIAL_KINDS,
  LOOP_MATERIAL_KINDS,
  createMaterialFilterState,
  filterMaterialLine,
  filterMaterialLines,
  filterMaterialText,
} from "../scripts/material-filter.ts";

function adv(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    type,
    at: "2026-07-31T00:00:00.000Z",
    ...extra,
  });
}

function loop(kind: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    seq: 1,
    time: "2026-07-31T00:00:00.000Z",
    kind,
    data,
  });
}

test("ADVANCE_MATERIAL_KINDS covers the issue allow-list", () => {
  for (const k of [
    "run_start",
    "stage_start",
    "stage_complete",
    "pr_created",
    "pr_updated",
    "review_verdict",
    "gate_result",
    "blocker_set",
    "blocker_cleared",
    "run_complete",
  ]) {
    assert.ok(
      (ADVANCE_MATERIAL_KINDS as readonly string[]).includes(k),
      `missing advance kind ${k}`,
    );
  }
});

test("LOOP_MATERIAL_KINDS covers the issue allow-list", () => {
  for (const k of [
    "loop_item_started",
    "loop_item_transitioned",
    "loop_item_blocked",
    "loop_item_advance_linked",
    "loop_item_advance_finished",
    "loop_item_stage_progress",
    "loop_item_progress",
    "loop_run_stopped",
  ]) {
    assert.ok(
      (LOOP_MATERIAL_KINDS as readonly string[]).includes(k),
      `missing loop kind ${k}`,
    );
  }
});

test("advance material kinds pass the filter among noise", () => {
  const lines = [
    adv("stage_accounting", { stage: "planning", tokens: 1 }),
    adv("run_start", { run_id: "r1", issue: 742, repo: "o/r" }),
    adv("worktree_created", { _localPath: "/tmp/x" }),
    adv("stage_start", { stage: "planning" }),
    adv("stage_complete", { stage: "planning", outcome: "advanced" }),
    adv("pr_created", { pr: 99 }),
    adv("review_verdict", { round: 1, sha: "abc", verdict: "changes_requested" }),
    adv("gate_result", { gate: "ci", result: "pass" }),
    adv("blocker_set", { reason: "needs human" }),
    adv("run_complete", { final_state: "blocked", elapsed_ms: 1 }),
  ];
  const out = filterMaterialLines(lines);
  const joined = out.join("\n");
  assert.match(joined, /\[run_start\]/);
  assert.match(joined, /\[stage_start\] planning/);
  assert.match(joined, /\[stage_complete\]/);
  assert.match(joined, /\[pr_created\] #99/);
  assert.match(joined, /\[review_verdict\]/);
  assert.match(joined, /\[gate_result\] ci=pass/);
  assert.match(joined, /\[blocker_set\]/);
  assert.match(joined, /\[run_complete\]/);
  assert.ok(!joined.includes("stage_accounting"));
  assert.ok(!joined.includes("worktree_created"));
});

test("loop material kinds pass the filter among noise", () => {
  const lines = [
    loop("loop_heartbeat", {}),
    loop("loop_item_started", { item_id: "#742" }),
    loop("loop_item_transitioned", { item_id: "#742", from: "ready", to: "in_progress" }),
    loop("loop_item_blocked", { item_id: "#742", reason: "ci" }),
    loop("loop_item_advance_linked", {
      item_id: "#742",
      pipeline_run_id: "742-x",
      events: "/repo/.agent-pipeline/runs/742-x/events.jsonl",
    }),
    loop("loop_item_stage_progress", { item_id: "#742", stage: "implementing" }),
    loop("loop_item_progress", {
      item_id: "#742",
      domain: "pre_merge",
      step: "ci",
      status: "pass",
    }),
    loop("loop_item_advance_finished", { item_id: "#742", outcome: "advanced" }),
    loop("loop_run_stopped", { reason: "all_done" }),
  ];
  const out = filterMaterialLines(lines);
  const joined = out.join("\n");
  for (const k of LOOP_MATERIAL_KINDS) {
    assert.ok(joined.includes(`[${k}]`), `expected ${k} in output`);
  }
  assert.ok(!joined.includes("loop_heartbeat"));
});

test("CI partial spam is suppressed after the first; definitive pass remains", () => {
  const state = createMaterialFilterState();
  const partial = adv("gate_result", { gate: "ci", result: "partial", reason: "pending" });
  const first = filterMaterialLine(partial, state);
  const second = filterMaterialLine(partial, state);
  const third = filterMaterialLine(partial, state);
  assert.ok(first != null, "first CI partial should emit");
  assert.equal(second, null, "second identical CI partial suppressed");
  assert.equal(third, null, "third identical CI partial suppressed");

  const pass = filterMaterialLine(
    adv("gate_result", { gate: "ci", result: "pass" }),
    state,
  );
  assert.ok(pass != null && pass.includes("pass"), "definitive CI pass must emit");
});

test("OpenSpec skipped gate_result is suppressed", () => {
  const state = createMaterialFilterState();
  const skipped = filterMaterialLine(
    adv("gate_result", { gate: "openspec-archive", result: "skipped" }),
    state,
  );
  assert.equal(skipped, null);
  const pass = filterMaterialLine(
    adv("gate_result", { gate: "openspec-archive", result: "pass" }),
    state,
  );
  assert.ok(pass != null);
});

test("loop_item_progress: first CI waiting only per stretch; definitive always", () => {
  const state = createMaterialFilterState();
  const waiting = loop("loop_item_progress", {
    item_id: "#1",
    domain: "pre_merge",
    step: "ci",
    status: "waiting",
  });
  assert.ok(filterMaterialLine(waiting, state) != null, "first waiting");
  assert.equal(filterMaterialLine(waiting, state), null, "second waiting suppressed");
  assert.equal(filterMaterialLine(waiting, state), null, "third waiting suppressed");

  const pass = loop("loop_item_progress", {
    item_id: "#1",
    domain: "pre_merge",
    step: "ci",
    status: "pass",
  });
  assert.ok(filterMaterialLine(pass, state) != null, "pass after waiting");

  // New stretch: waiting again after definitive.
  assert.ok(
    filterMaterialLine(waiting, state) != null,
    "first waiting of a new stretch after definitive",
  );
  assert.equal(filterMaterialLine(waiting, state), null, "repeat waiting in new stretch");
});

test("loop_item_progress openspec skipped is suppressed", () => {
  const out = filterMaterialLine(
    loop("loop_item_progress", {
      domain: "pre_merge",
      step: "openspec_archive",
      status: "skipped",
    }),
  );
  assert.equal(out, null);
});

test("non-listed heartbeat/accounting kinds never emit", () => {
  const noise = [
    adv("stage_accounting", { stage: "x" }),
    adv("gh_metrics_summary", { call_count: 1 }),
    loop("loop_heartbeat", {}),
    "not-json",
    "",
  ];
  assert.deepEqual(filterMaterialLines(noise), []);
});

test("jsonl mode returns original material lines", () => {
  const line = adv("stage_start", { stage: "review-1" });
  const state = createMaterialFilterState();
  const out = filterMaterialLine(line, state, { jsonl: true });
  assert.equal(out, line);
});

test("filterMaterialText preserves multi-line dump semantics", () => {
  const text =
    adv("run_start", { run_id: "r", issue: 1, repo: "o/r" }) +
    "\n" +
    adv("stage_accounting", { stage: "x" }) +
    "\n" +
    adv("run_complete", { final_state: "ready-to-deploy", elapsed_ms: 2 }) +
    "\n";
  const filtered = filterMaterialText(text);
  assert.match(filtered, /\[run_start\]/);
  assert.match(filtered, /\[run_complete\]/);
  assert.ok(!filtered.includes("stage_accounting"));
  assert.ok(filtered.endsWith("\n"));
});

test("optional schedule evaluations burst-suppress identical payloads", () => {
  const state = createMaterialFilterState();
  const line = loop("loop_schedule_evaluated", { decision: "hold", fingerprint: "a" });
  assert.ok(filterMaterialLine(line, state) != null);
  assert.equal(filterMaterialLine(line, state), null);
  const changed = loop("loop_schedule_evaluated", { decision: "dispatch", fingerprint: "b" });
  assert.ok(filterMaterialLine(changed, state) != null);
});

test("regression: filter without allow-list logic would pass noise — prove bite", () => {
  // Without the filter, a raw feed includes accounting. The material filter
  // must drop it so host monitors are not flooded.
  const mixed = [
    adv("stage_accounting", { stage: "pre-merge" }),
    adv("gate_result", { gate: "ci", result: "partial" }),
    adv("gate_result", { gate: "ci", result: "partial" }),
  ];
  const out = filterMaterialLines(mixed);
  assert.equal(out.length, 1, "only first partial, no accounting");
  assert.match(out[0]!, /gate_result/);
});
