// Unit tests for the human-intervention taxonomy and factory-debt helpers (#302).
//
// All tests are network- and filesystem-free. I/O is injected via EmitInterventionDeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HUMAN_INTERVENTION_KINDS,
  type HumanInterventionKind,
  type HumanInterventionEvent,
  emitHumanIntervention,
  summarizeInterventions,
  blockerKindToInterventionKind,
  type EmitInterventionDeps,
} from "../scripts/intervention.ts";
import { BLOCKER_KINDS } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// 4.1 Taxonomy — all 11 members present and unique
// ---------------------------------------------------------------------------

test("HUMAN_INTERVENTION_KINDS: has exactly 11 members", () => {
  assert.equal(HUMAN_INTERVENTION_KINDS.length, 11);
});

test("HUMAN_INTERVENTION_KINDS: all members are unique", () => {
  const seen = new Set<string>();
  for (const k of HUMAN_INTERVENTION_KINDS) {
    assert.ok(!seen.has(k), `duplicate kind: ${k}`);
    seen.add(k);
  }
});

test("HUMAN_INTERVENTION_KINDS: contains every expected member", () => {
  const expected: HumanInterventionKind[] = [
    "ambiguous-issue",
    "product-judgment-required",
    "plan-review-feedback",
    "review-non-convergence",
    "test-build-failure",
    "eval-shipcheck-failure",
    "merge-conflict-or-branch-drift",
    "auth-tooling-preflight-failure",
    "human-risk-override",
    "reviewer-unavailable",
    "unknown",
  ];
  for (const k of expected) {
    assert.ok(
      (HUMAN_INTERVENTION_KINDS as readonly string[]).includes(k),
      `missing kind: ${k}`,
    );
  }
});

test("HUMAN_INTERVENTION_KINDS: all members are lowercase kebab-case strings", () => {
  for (const k of HUMAN_INTERVENTION_KINDS) {
    assert.match(k, /^[a-z][a-z0-9-]*$/, `unexpected format: ${k}`);
  }
});

test("HUMAN_INTERVENTION_KINDS: includes 'unknown' escape hatch", () => {
  assert.ok((HUMAN_INTERVENTION_KINDS as readonly string[]).includes("unknown"));
});

// ---------------------------------------------------------------------------
// 4.2 emitHumanIntervention — valid payload, I/O failure, injection denylist
// ---------------------------------------------------------------------------

function fakeDeps(captured: string[]): EmitInterventionDeps {
  return {
    appendFile: async (_p, data) => { captured.push(data); },
  };
}

test("emitHumanIntervention: writes a valid JSON line to events.jsonl", async () => {
  const lines: string[] = [];
  await emitHumanIntervention(
    "/fake/run",
    { kind: "test-build-failure", stage: "fix-1", issue: 42, detail: "npm test failed" },
    fakeDeps(lines),
  );
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]) as HumanInterventionEvent;
  assert.equal(event.type, "human_intervention");
  assert.equal(event.schema_version, 1);
  assert.equal(event.kind, "test-build-failure");
  assert.equal(event.stage, "fix-1");
  assert.equal(event.issue, 42);
  assert.equal(event.detail, "npm test failed");
  assert.ok(typeof event.at === "string" && event.at.endsWith("Z"));
});

test("emitHumanIntervention: appends to events.jsonl path inside runDir", async () => {
  const paths: string[] = [];
  const deps: EmitInterventionDeps = {
    appendFile: async (p, _data) => { paths.push(p); },
  };
  await emitHumanIntervention(
    "/some/run-dir",
    { kind: "ambiguous-issue", stage: null, issue: 1, detail: "unclear spec" },
    deps,
  );
  assert.ok(paths[0].endsWith("events.jsonl"), `unexpected path: ${paths[0]}`);
  assert.ok(paths[0].startsWith("/some/run-dir"), `path not under runDir: ${paths[0]}`);
});

test("emitHumanIntervention: no-op when runDir is undefined", async () => {
  const lines: string[] = [];
  await emitHumanIntervention(
    undefined,
    { kind: "reviewer-unavailable", stage: "review-1", issue: 5, detail: "harness down" },
    fakeDeps(lines),
  );
  assert.equal(lines.length, 0);
});

test("emitHumanIntervention: I/O failure caught and does not throw", async () => {
  const failDeps: EmitInterventionDeps = {
    appendFile: async () => { throw new Error("disk full"); },
  };
  await assert.doesNotReject(() =>
    emitHumanIntervention(
      "/fake/run",
      { kind: "human-risk-override", stage: null, issue: 99, detail: "override applied" },
      failDeps,
    ),
  );
});

test("emitHumanIntervention: includes ref field when provided", async () => {
  const lines: string[] = [];
  await emitHumanIntervention(
    "/fake/run",
    { kind: "merge-conflict-or-branch-drift", stage: "pre-merge", issue: 7, detail: "conflict", ref: "abc123" },
    fakeDeps(lines),
  );
  const event = JSON.parse(lines[0]) as HumanInterventionEvent;
  assert.equal(event.ref, "abc123");
});

test("emitHumanIntervention: omits ref field when not provided", async () => {
  const lines: string[] = [];
  await emitHumanIntervention(
    "/fake/run",
    { kind: "plan-review-feedback", stage: "plan-review", issue: 3, detail: "needs work" },
    fakeDeps(lines),
  );
  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.ok(!("ref" in event), "ref should be absent");
});

test("emitHumanIntervention: injection denylist applied to detail", async () => {
  const lines: string[] = [];
  // A secret-looking token should be redacted from the detail field.
  await emitHumanIntervention(
    "/fake/run",
    { kind: "auth-tooling-preflight-failure", stage: "ready", issue: 11, detail: "token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    fakeDeps(lines),
  );
  const event = JSON.parse(lines[0]) as HumanInterventionEvent;
  assert.ok(!event.detail.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "secret not redacted");
});

test("emitHumanIntervention: calls stdoutWrite when provided", async () => {
  const lines: string[] = [];
  const written: string[] = [];
  const deps: EmitInterventionDeps = {
    appendFile: async (_p, data) => { lines.push(data); },
    stdoutWrite: (line) => { written.push(line); },
  };
  await emitHumanIntervention(
    "/fake/run",
    { kind: "eval-shipcheck-failure", stage: "eval-gate", issue: 20, detail: "eval failed" },
    deps,
  );
  assert.equal(written.length, 1);
  assert.equal(written[0], lines[0]);
});

// ---------------------------------------------------------------------------
// 4.3 summarizeInterventions — counts, window filter, empty input, unknown kind
// ---------------------------------------------------------------------------

function makeEvent(kind: string, at: string, issue = 1): Record<string, unknown> {
  return { type: "human_intervention", schema_version: 1, kind, stage: null, issue, at, detail: "x" };
}

test("summarizeInterventions: empty input returns zero summary", () => {
  const s = summarizeInterventions([]);
  assert.equal(s.total, 0);
  assert.equal(s.items.length, 0);
  for (const k of HUMAN_INTERVENTION_KINDS) {
    assert.equal(s.byKind[k], 0);
  }
});

test("summarizeInterventions: counts each event by kind", () => {
  const events = [
    makeEvent("test-build-failure", "2026-06-01T00:00:00Z"),
    makeEvent("test-build-failure", "2026-06-02T00:00:00Z"),
    makeEvent("reviewer-unavailable", "2026-06-03T00:00:00Z"),
  ];
  const s = summarizeInterventions(events);
  assert.equal(s.total, 3);
  assert.equal(s.byKind["test-build-failure"], 2);
  assert.equal(s.byKind["reviewer-unavailable"], 1);
  assert.equal(s.byKind["ambiguous-issue"], 0);
});

test("summarizeInterventions: non-human_intervention events are ignored", () => {
  const events = [
    makeEvent("test-build-failure", "2026-06-01T00:00:00Z"),
    { type: "run_start", schema_version: 1, issue: 1, at: "2026-06-01T00:00:00Z" },
    { type: "run_complete", schema_version: 1, issue: 1, at: "2026-06-01T00:01:00Z" },
  ];
  const s = summarizeInterventions(events);
  assert.equal(s.total, 1);
});

test("summarizeInterventions: unrecognized kind is counted under 'unknown'", () => {
  const events = [makeEvent("invented-kind-xyz", "2026-06-01T00:00:00Z")];
  const s = summarizeInterventions(events);
  assert.equal(s.total, 1);
  assert.equal(s.byKind["unknown"], 1);
});

test("summarizeInterventions: windowMs filters to last N ms of most recent event", () => {
  const events = [
    makeEvent("test-build-failure", "2026-06-01T00:00:00Z"),
    makeEvent("test-build-failure", "2026-06-01T01:00:00Z"), // 1h later
    makeEvent("reviewer-unavailable", "2026-06-01T02:00:00Z"), // 2h after first
  ];
  // Window of 90 minutes = 5400000ms: should include events at t+1h and t+2h but NOT t+0.
  const oneHourMs = 3600000;
  const s = summarizeInterventions(events, oneHourMs * 1.5);
  assert.equal(s.total, 2);
  assert.equal(s.byKind["test-build-failure"], 1);
  assert.equal(s.byKind["reviewer-unavailable"], 1);
});

test("summarizeInterventions: windowMs=0 only keeps events at the exact latest timestamp", () => {
  const events = [
    makeEvent("test-build-failure", "2026-06-01T00:00:00Z"),
    makeEvent("reviewer-unavailable", "2026-06-01T01:00:00Z"),
  ];
  const s = summarizeInterventions(events, 0);
  assert.equal(s.total, 1);
  assert.equal(s.byKind["reviewer-unavailable"], 1);
});

test("summarizeInterventions: items array contains all matching events", () => {
  const events = [
    makeEvent("plan-review-feedback", "2026-06-01T00:00:00Z", 5),
    makeEvent("plan-review-feedback", "2026-06-02T00:00:00Z", 7),
  ];
  const s = summarizeInterventions(events);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].issue, 5);
  assert.equal(s.items[1].issue, 7);
});

test("summarizeInterventions: byKind has all taxonomy members", () => {
  const s = summarizeInterventions([]);
  for (const k of HUMAN_INTERVENTION_KINDS) {
    assert.ok(k in s.byKind, `missing byKind entry: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 4.5 improve --interventions: runImprove with interventions flag
// ---------------------------------------------------------------------------

import * as path from "node:path";
import { runImprove, type ImproveDeps } from "../scripts/improve.ts";

function makeImproveDeps(lines: string[][]): ImproveDeps {
  // lines[i] corresponds to events for run index i
  let callCount = 0;
  return {
    readFile: async (_p: string) => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    readLines: (_p: string) => {
      const idx = callCount++;
      const runLines = lines[idx] ?? [];
      async function* gen() { for (const l of runLines) yield l; }
      return gen();
    },
    readdir: async (_p: string) => {
      return lines.map((_, i) => ({
        name: `run-${i}`,
        isDirectory: () => true,
      }));
    },
    log: (_msg: string) => {},
    createIssue: async () => "https://github.com/example/issues/1",
    ghAuthCheck: async () => true,
  };
}

test("runImprove --interventions: prints valid JSON summary for empty runs", async () => {
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") written.push(chunk);
    return true;
  };
  try {
    await runImprove(
      { repoDir: "/fake", interventions: true },
      makeImproveDeps([]),
    );
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(written.length, 1);
  const summary = JSON.parse(written[0]);
  assert.equal(summary.total, 0);
  assert.ok("byKind" in summary);
  assert.ok("items" in summary);
});

test("runImprove --interventions: counts events by kind across runs", async () => {
  const event1 = JSON.stringify({ type: "human_intervention", schema_version: 1, kind: "test-build-failure", stage: "fix-1", issue: 1, at: "2026-06-01T00:00:00Z", detail: "x" });
  const event2 = JSON.stringify({ type: "human_intervention", schema_version: 1, kind: "reviewer-unavailable", stage: "review-1", issue: 2, at: "2026-06-01T01:00:00Z", detail: "y" });
  const nonIntervention = JSON.stringify({ type: "run_start", schema_version: 1, issue: 1, at: "2026-06-01T00:00:00Z" });

  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") written.push(chunk);
    return true;
  };
  try {
    await runImprove(
      { repoDir: "/fake", interventions: true },
      makeImproveDeps([[event1, nonIntervention], [event2]]),
    );
  } finally {
    process.stdout.write = orig;
  }
  const summary = JSON.parse(written[0]);
  assert.equal(summary.total, 2);
  assert.equal(summary.byKind["test-build-failure"], 1);
  assert.equal(summary.byKind["reviewer-unavailable"], 1);
});

test("runImprove --interventions: exits early without cluster analysis", async () => {
  // Provide a summary.json that would trigger clusterTokenWaste if cluster path ran.
  // Only the interventions path should run; no cluster output expected.
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") written.push(chunk);
    return true;
  };
  try {
    await runImprove(
      { repoDir: "/fake", interventions: true },
      makeImproveDeps([[]]),
    );
  } finally {
    process.stdout.write = orig;
  }
  // Should have exactly one write (the JSON summary), not a cluster report.
  assert.equal(written.length, 1);
  const summary = JSON.parse(written[0]);
  assert.ok("total" in summary, "expected InterventionSummary shape");
});

// ---------------------------------------------------------------------------
// blockerKindToInterventionKind — every BlockerKind maps to a valid HumanInterventionKind
// ---------------------------------------------------------------------------

test("blockerKindToInterventionKind: every BlockerKind maps to a known HumanInterventionKind", () => {
  for (const kind of BLOCKER_KINDS) {
    const mapped = blockerKindToInterventionKind(kind);
    assert.ok(
      HUMAN_INTERVENTION_KINDS.includes(mapped),
      `BlockerKind "${kind}" maps to unknown kind "${mapped}"`,
    );
  }
});

test("blockerKindToInterventionKind: specific mappings are stable", () => {
  assert.equal(blockerKindToInterventionKind("test-gate-exhausted"), "test-build-failure");
  assert.equal(blockerKindToInterventionKind("eval-gate-failed"), "eval-shipcheck-failure");
  assert.equal(blockerKindToInterventionKind("eval-gate-misconfigured"), "eval-shipcheck-failure");
  assert.equal(blockerKindToInterventionKind("merge-conflict"), "merge-conflict-or-branch-drift");
  assert.equal(blockerKindToInterventionKind("worktree-missing"), "auth-tooling-preflight-failure");
  assert.equal(blockerKindToInterventionKind("worktree-creation-failed"), "auth-tooling-preflight-failure");
  assert.equal(blockerKindToInterventionKind("worktree-setup-failed"), "auth-tooling-preflight-failure");
  assert.equal(blockerKindToInterventionKind("harness-failure"), "reviewer-unavailable");
  assert.equal(blockerKindToInterventionKind("needs-human"), "product-judgment-required");
  assert.equal(blockerKindToInterventionKind("push-failed"), "test-build-failure");
  assert.equal(blockerKindToInterventionKind("no-commits"), "test-build-failure");
});
