// Tests for the `pipeline improve` sub-command (#303).
//
// All tests are network- and filesystem-free: I/O is injected via ImproveDeps.
// Each test proves the code bites by asserting specific outcomes and error messages.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSignal,
  discoverRuns,
  readEventsLines,
  clusterReviewFindings,
  clusterBlockers,
  clusterFlakyGates,
  clusterTokenWaste,
  clusterPapercuts,
  clusterCorrections,
  clusterDurableRunBlockers,
  qualifiesDurableRunBlocker,
  suggestMilestoneForBlockerClass,
  collectFindingSeverities,
  proposeControlLevel,
  renderControlProposal,
  clustersToEntries,
  formatReport,
  formatJson,
  applyIssues,
  proposedTitle,
  listOpenImproveIssuesArgs,
  parseOpenImproveIssuesPages,
  type ClusterAccum,
  type ClusterEntry,
  type ImproveDeps,
  type OpenImproveIssue,
  type RunInfo,
} from "../scripts/improve.ts";
import type { DurableBlockerOccurrence } from "../scripts/loop/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadLines(lines: string[]): (p: string) => AsyncIterable<string> {
  return (_p: string) => {
    async function* gen() {
      for (const l of lines) yield l;
    }
    return gen();
  };
}

function makeReadLinesNotFound(): (p: string) => AsyncIterable<string> {
  return (_p: string) => {
    async function* gen() {
      // yields nothing — simulates missing file
    }
    return gen();
  };
}

type FakeDirEntry = { name: string; _isDir: boolean; isDirectory(): boolean };

function makeDir(entries: FakeDirEntry[]): (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>> {
  return async (_p: string) => entries;
}

function dirEntry(name: string, isDir = true): FakeDirEntry {
  return { name, _isDir: isDir, isDirectory: () => isDir };
}

function makeFiles(files: Record<string, string>): (p: string) => Promise<string> {
  return async (p: string) => {
    if (p in files) return files[p];
    const err = Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    throw err;
  };
}

// ---------------------------------------------------------------------------
// 4.6 normalizeSignal
// ---------------------------------------------------------------------------

test("normalizeSignal: strips line-number tokens", () => {
  assert.equal(normalizeSignal("error at :42"), "error at");
  assert.equal(normalizeSignal("null check missing at line:107"), "null check missing at line");
});

test("normalizeSignal: strips SHA tokens", () => {
  assert.equal(normalizeSignal("commit abc1234def fails"), "commit fails");
  assert.equal(normalizeSignal("sha abc1234def5678901234567890abcdef1234567 bad"), "sha bad");
});

test("normalizeSignal: strips PR/issue number tokens", () => {
  assert.equal(normalizeSignal("fixes #123 in review"), "fixes in review");
  assert.equal(normalizeSignal("see #42 and #99"), "see and");
});

test("normalizeSignal: collapses whitespace", () => {
  assert.equal(normalizeSignal("  a  b  c  "), "a b c");
  assert.equal(normalizeSignal("null\tcheck\nmissing"), "null check missing");
});

test("normalizeSignal: converts to lowercase", () => {
  assert.equal(normalizeSignal("Null Check Missing"), "null check missing");
});

test("normalizeSignal: merges findings differing only by line number", () => {
  const a = normalizeSignal("Null check missing at line:42");
  const b = normalizeSignal("Null check missing at line:107");
  assert.equal(a, b);
});

test("normalizeSignal: merges findings differing only by space-separated line number", () => {
  const a = normalizeSignal("Null check missing at line 42");
  const b = normalizeSignal("Null check missing at line 107");
  assert.equal(a, b);
  assert.ok(!a.includes("42") && !a.includes("107"), `normalized form still contains line number: ${a}`);
});

// ---------------------------------------------------------------------------
// 2.2 discoverRuns
// ---------------------------------------------------------------------------

test("discoverRuns: empty directory returns []", async () => {
  const deps = {
    readFile: makeFiles({}),
    readdir: makeDir([]),
  };
  const runs = await discoverRuns("/fake/runs", undefined, deps);
  assert.deepEqual(runs, []);
});

test("discoverRuns: missing directory (ENOENT) returns []", async () => {
  const deps = {
    readFile: makeFiles({}),
    readdir: async (_p: string): Promise<Array<{ name: string; isDirectory(): boolean }>> => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    },
  };
  const runs = await discoverRuns("/fake/runs", undefined, deps);
  assert.deepEqual(runs, []);
});

test("discoverRuns: missing run.json is included with null startedAt", async () => {
  const deps = {
    readFile: makeFiles({}),
    readdir: makeDir([dirEntry("42-2026-01-01T00-00-00-000Z")]),
  };
  const runs = await discoverRuns("/fake/runs", undefined, deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "42-2026-01-01T00-00-00-000Z");
  assert.equal(runs[0].startedAt, null);
});

test("discoverRuns: --since excludes runs before cutoff", async () => {
  const deps = {
    readFile: makeFiles({
      "/fake/runs/10-2026-05-01T00-00-00-000Z/run.json": JSON.stringify({ started_at: "2026-05-01T00:00:00Z" }),
      "/fake/runs/20-2026-06-15T00-00-00-000Z/run.json": JSON.stringify({ started_at: "2026-06-15T00:00:00Z" }),
    }),
    readdir: makeDir([
      dirEntry("10-2026-05-01T00-00-00-000Z"),
      dirEntry("20-2026-06-15T00-00-00-000Z"),
    ]),
  };
  const runs = await discoverRuns("/fake/runs", "2026-06-01", deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "20-2026-06-15T00-00-00-000Z");
});

test("discoverRuns: --since includes runs on or after cutoff", async () => {
  const deps = {
    readFile: makeFiles({
      "/fake/runs/10-2026-06-01T00-00-00-000Z/run.json": JSON.stringify({ started_at: "2026-06-01T00:00:00Z" }),
    }),
    readdir: makeDir([dirEntry("10-2026-06-01T00-00-00-000Z")]),
  };
  const runs = await discoverRuns("/fake/runs", "2026-06-01", deps);
  assert.equal(runs.length, 1);
});

test("discoverRuns: run without run.json is not excluded by --since", async () => {
  const deps = {
    readFile: makeFiles({}),
    readdir: makeDir([dirEntry("99-2026-01-01T00-00-00-000Z")]),
  };
  const runs = await discoverRuns("/fake/runs", "2026-06-01", deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startedAt, null);
});

test("discoverRuns: non-directory entries are skipped", async () => {
  const deps = {
    readFile: makeFiles({}),
    readdir: makeDir([dirEntry("somefile.txt", false), dirEntry("10-2026-01-01T00-00-00-000Z")]),
  };
  const runs = await discoverRuns("/fake/runs", undefined, deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "10-2026-01-01T00-00-00-000Z");
});

// ---------------------------------------------------------------------------
// 3.2 readEventsLines
// ---------------------------------------------------------------------------

test("readEventsLines: missing file returns empty", async () => {
  const deps = { readLines: makeReadLinesNotFound() };
  const events: Record<string, unknown>[] = [];
  for await (const e of readEventsLines("/fake/events.jsonl", deps)) {
    events.push(e);
  }
  assert.equal(events.length, 0);
});

test("readEventsLines: corrupt tail line is skipped", async () => {
  const deps = {
    readLines: makeReadLines([
      JSON.stringify({ type: "run_start", at: "2026-01-01T00:00:00Z" }),
      "{ corrupt partial line",
      JSON.stringify({ type: "stage_start", stage: "planning" }),
    ]),
  };
  const events: Record<string, unknown>[] = [];
  for await (const e of readEventsLines("/fake/events.jsonl", deps)) {
    events.push(e);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0]["type"], "run_start");
  assert.equal(events[1]["type"], "stage_start");
});

test("readEventsLines: unknown fields are preserved", async () => {
  const deps = {
    readLines: makeReadLines([
      JSON.stringify({ type: "custom_event", unknown_field: 42, nested: { x: true } }),
    ]),
  };
  const events: Record<string, unknown>[] = [];
  for await (const e of readEventsLines("/fake/events.jsonl", deps)) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]["unknown_field"], 42);
  assert.deepEqual(events[0]["nested"], { x: true });
});

test("readEventsLines: empty lines are skipped", async () => {
  const deps = { readLines: makeReadLines(["", "   ", JSON.stringify({ type: "x" })]) };
  const events: Record<string, unknown>[] = [];
  for await (const e of readEventsLines("/fake/events.jsonl", deps)) {
    events.push(e);
  }
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// 4.7 clusterReviewFindings
// ---------------------------------------------------------------------------

test("clusterReviewFindings: recurring signal is merged into one cluster", () => {
  const clusters = new Map();
  const event = {
    type: "review_verdict",
    findings: [{ title: "Null check missing at :42", body: "some excerpt" }],
  };
  clusterReviewFindings(event, "run-1", clusters);
  clusterReviewFindings(event, "run-2", clusters);
  assert.equal(clusters.size, 1);
  const entry = [...clusters.values()][0];
  assert.equal(entry.count, 2);
  assert.deepEqual([...entry.runIds].sort(), ["run-1", "run-2"]);
});

test("clusterReviewFindings: distinct signals are separate clusters", () => {
  const clusters = new Map();
  clusterReviewFindings(
    { type: "review_verdict", findings: [{ title: "Missing null check", body: "" }] },
    "run-1",
    clusters,
  );
  clusterReviewFindings(
    { type: "review_verdict", findings: [{ title: "Unhandled error path", body: "" }] },
    "run-1",
    clusters,
  );
  assert.equal(clusters.size, 2);
});

test("clusterReviewFindings: evidence excerpt is ≤ 200 chars", () => {
  const longBody = "x".repeat(300);
  const clusters = new Map();
  clusterReviewFindings(
    { type: "review_verdict", findings: [{ title: "Some finding", body: longBody }] },
    "run-1",
    clusters,
  );
  const entry = [...clusters.values()][0];
  assert.ok(entry.excerpt.length <= 200, `excerpt length ${entry.excerpt.length} exceeds 200`);
});

test("clusterReviewFindings: non-review_verdict events are ignored", () => {
  const clusters = new Map();
  clusterReviewFindings({ type: "stage_start", stage: "planning" }, "run-1", clusters);
  assert.equal(clusters.size, 0);
});

// ---------------------------------------------------------------------------
// 4.7 clusterBlockers
// ---------------------------------------------------------------------------

test("clusterBlockers: recurring blocker is merged", () => {
  const clusters = new Map();
  const event = { type: "blocker_set", reason: "CI failed on check #42" };
  clusterBlockers(event, "run-1", clusters);
  clusterBlockers(event, "run-2", clusters);
  assert.equal(clusters.size, 1);
  const entry = [...clusters.values()][0];
  assert.equal(entry.count, 2);
  assert.equal(entry.category, "blocker");
});

test("clusterBlockers: distinct reasons are separate clusters", () => {
  const clusters = new Map();
  clusterBlockers({ type: "blocker_set", reason: "CI failed" }, "run-1", clusters);
  clusterBlockers({ type: "blocker_set", reason: "Auth expired" }, "run-1", clusters);
  assert.equal(clusters.size, 2);
});

test("clusterBlockers: evidence excerpt is ≤ 200 chars", () => {
  const clusters = new Map();
  clusterBlockers(
    { type: "blocker_set", reason: "r".repeat(300) },
    "run-1",
    clusters,
  );
  const entry = [...clusters.values()][0];
  assert.ok(entry.excerpt.length <= 200);
});

test("clusterBlockers: non-blocker_set events are ignored", () => {
  const clusters = new Map();
  clusterBlockers({ type: "review_verdict", findings: [] }, "run-1", clusters);
  assert.equal(clusters.size, 0);
});

// ---------------------------------------------------------------------------
// 4.7 clusterFlakyGates
// ---------------------------------------------------------------------------

test("clusterFlakyGates: repeated stage error is merged", () => {
  const clusters = new Map();
  const event = { type: "stage_complete", stage: "pre_merge", outcome: "error" };
  clusterFlakyGates(event, "run-1", clusters);
  clusterFlakyGates(event, "run-2", clusters);
  assert.equal(clusters.size, 1);
  const entry = [...clusters.values()][0];
  assert.equal(entry.count, 2);
  assert.equal(entry.category, "flaky-gate");
  assert.equal(entry.signal, "pre_merge");
});

test("clusterFlakyGates: non-error outcomes are ignored", () => {
  const clusters = new Map();
  clusterFlakyGates({ type: "stage_complete", stage: "planning", outcome: "advanced" }, "run-1", clusters);
  assert.equal(clusters.size, 0);
});

test("clusterFlakyGates: distinct stages are separate clusters", () => {
  const clusters = new Map();
  clusterFlakyGates({ type: "stage_complete", stage: "planning", outcome: "error" }, "run-1", clusters);
  clusterFlakyGates({ type: "stage_complete", stage: "review", outcome: "error" }, "run-1", clusters);
  assert.equal(clusters.size, 2);
});

test("clusterFlakyGates: evidence excerpt is ≤ 200 chars", () => {
  const clusters = new Map();
  clusterFlakyGates({ type: "stage_complete", stage: "s".repeat(300), outcome: "error" }, "run-1", clusters);
  const entry = [...clusters.values()][0];
  assert.ok(entry.excerpt.length <= 200);
});

// ---------------------------------------------------------------------------
// clusterTokenWaste
// ---------------------------------------------------------------------------

test("clusterTokenWaste: returns false when no token/duration fields", () => {
  const clusters = new Map();
  const result = clusterTokenWaste({ unrelated: "field" }, "run-1", clusters);
  assert.equal(result, false);
  assert.equal(clusters.size, 0);
});

test("clusterTokenWaste: returns false for null/non-object summary", () => {
  const clusters = new Map();
  assert.equal(clusterTokenWaste(null, "run-1", clusters), false);
  assert.equal(clusterTokenWaste("string", "run-1", clusters), false);
  assert.equal(clusters.size, 0);
});

test("clusterTokenWaste: returns true when stage duration data present (below threshold)", () => {
  const clusters = new Map();
  const summary = { stages: [{ stage: "planning", commands: [{ durationMs: 1000 }] }] };
  const result = clusterTokenWaste(summary, "run-1", clusters);
  assert.equal(result, true);
  assert.equal(clusters.size, 0); // below threshold — no cluster created
});

test("clusterTokenWaste: adds cluster for high-duration stage", () => {
  const clusters = new Map();
  const HIGH_MS = 31 * 60 * 1000;
  const summary = { stages: [{ stage: "review", commands: [{ durationMs: HIGH_MS }] }] };
  clusterTokenWaste(summary, "run-1", clusters);
  assert.equal(clusters.size, 1);
  const entry = [...clusters.values()][0];
  assert.equal(entry.category, "token-waste");
  assert.ok(entry.signal.includes("review"));
});

test("clusterTokenWaste: adds cluster for very long duration stage", () => {
  const clusters = new Map();
  const HIGH_MS = 2 * 60 * 60 * 1000; // 2 hours
  const summary = { stages: [{ stage: "fix", commands: [{ durationMs: HIGH_MS }] }] };
  clusterTokenWaste(summary, "run-1", clusters);
  assert.equal(clusters.size, 1);
  const entry = [...clusters.values()][0];
  assert.equal(entry.category, "token-waste");
  assert.ok(entry.signal.includes("fix"));
});

test("clusterTokenWaste: same high-duration stage across runs produces one cluster", () => {
  const clusters = new Map();
  const HIGH_MS = 35 * 60 * 1000;
  const summary = { stages: [{ stage: "review", commands: [{ durationMs: HIGH_MS }] }] };
  clusterTokenWaste(summary, "run-1", clusters);
  clusterTokenWaste(summary, "run-2", clusters);
  clusterTokenWaste(summary, "run-3", clusters);
  assert.equal(clusters.size, 1, `expected 1 cluster, got ${clusters.size}`);
  const entry = [...clusters.values()][0];
  assert.equal(entry.count, 3);
  assert.deepEqual([...entry.runIds].sort(), ["run-1", "run-2", "run-3"]);
  assert.equal(entry.category, "token-waste");
});

// ---------------------------------------------------------------------------
// 2.2/2.4 clusterPapercuts (#421)
// ---------------------------------------------------------------------------

test("clusterPapercuts: repeated messages cluster together", () => {
  const clusters = new Map();
  const event = { type: "papercut", message: "test gate flaked twice" };
  clusterPapercuts(event, "run-1", clusters);
  clusterPapercuts(event, "run-2", clusters);
  assert.equal(clusters.size, 1, `expected 1 cluster, got ${clusters.size}`);
  const entry = [...clusters.values()][0];
  assert.equal(entry.count, 2);
  assert.equal(entry.category, "papercut");
  assert.deepEqual([...entry.runIds].sort(), ["run-1", "run-2"]);
});

test("clusterPapercuts: distinct messages stay separate", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "flaky test gate" }, "run-1", clusters);
  clusterPapercuts({ type: "papercut", message: "slow review round" }, "run-1", clusters);
  assert.equal(clusters.size, 2);
});

test("clusterPapercuts: non-papercut events are ignored", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "blocker_set", reason: "ci failed" }, "run-1", clusters);
  assert.equal(clusters.size, 0);
});

test("clusterPapercuts: evidence excerpt is ≤ 200 chars", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "m".repeat(300) }, "run-1", clusters);
  const entry = [...clusters.values()][0];
  assert.ok(entry.excerpt.length <= 200);
});

// ---------------------------------------------------------------------------
// 3.1/3.2 category isolation (#421)
// ---------------------------------------------------------------------------

test("category isolation: an identically-normalized papercut and blocker signal produce two independent clusters", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "ci failed" }, "run-1", clusters);
  clusterPapercuts({ type: "papercut", message: "ci failed" }, "run-2", clusters);
  clusterBlockers({ type: "blocker_set", reason: "ci failed" }, "run-3", clusters);
  assert.equal(clusters.size, 2, `expected 2 clusters, got ${clusters.size}`);
  const papercutEntry = clusters.get("papercut:ci failed");
  const blockerEntry = clusters.get("blocker:ci failed");
  assert.equal(papercutEntry.count, 2);
  assert.equal(blockerEntry.count, 1);
});

test("category isolation: papercut and flaky-gate clusters about the same stage stay separate", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "test gate" }, "run-1", clusters);
  clusterFlakyGates({ type: "stage_complete", stage: "test gate", outcome: "error" }, "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  assert.equal(entries.length, 2);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["flaky-gate", "papercut"]);
});

test("category isolation: papercut and token-waste clusters about the same stage stay separate", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "review" }, "run-1", clusters);
  const HIGH_MS = 35 * 60 * 1000;
  clusterTokenWaste({ stages: [{ stage: "review", commands: [{ durationMs: HIGH_MS }] }] }, "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  assert.equal(entries.length, 2);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["papercut", "token-waste"]);
});

// ---------------------------------------------------------------------------
// clusterCorrections / proposeControlLevel / renderControlProposal (#500)
// ---------------------------------------------------------------------------

function correctionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "correction_event",
    schema_version: 1,
    at: "2026-07-01T00:00:00Z",
    correction_id: "id-1",
    correction_key: "key-1",
    source_kind: "override",
    failure_class: "review-finding",
    actor_kind: "human",
    issue: 500,
    repo: "org/repo",
    run_id: "run-1",
    stage: "review",
    reviewed_sha: null,
    head_sha: null,
    evidence_ref: { kind: "finding", id: "f1" },
    correction: "Use X instead of Y",
    reusable: "yes",
    ...overrides,
  };
}

test("clusterCorrections: identical correction_key clusters together (identity is the bounded key, not free text)", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", correction: "Use X instead of Y" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", correction: "totally different prose" }), "run-2", clusters);
  assert.equal(clusters.size, 1, `expected 1 cluster, got ${clusters.size}`);
  const entry = clusters.get("correction:key-1");
  assert.equal(entry.count, 2);
  assert.deepEqual([...entry.runIds].sort(), ["run-1", "run-2"]);
});

test("clusterCorrections: different correction_key does not merge even with identical free-text correction prose", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_key: "key-a", correction_id: "id-1", correction: "same wording" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_key: "key-b", correction_id: "id-2", correction: "same wording" }), "run-1", clusters);
  assert.equal(clusters.size, 2, `expected 2 clusters, got ${clusters.size}`);
});

test("clusterCorrections: duplicate delivery of one correction_id counts once", () => {
  const clusters = new Map();
  const event = correctionEvent({ correction_id: "id-1" });
  clusterCorrections(event, "run-1", clusters);
  clusterCorrections(event, "run-1", clusters); // replay of the same event
  const entry = clusters.get("correction:key-1");
  assert.equal(entry.count, 1);
});

test("clusterCorrections: two distinct correction_ids within one correction_key count as two", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2" }), "run-1", clusters);
  const entry = clusters.get("correction:key-1");
  assert.equal(entry.count, 2);
});

test("clusterCorrections: non-correction_event events are ignored", () => {
  const clusters = new Map();
  clusterCorrections({ type: "blocker_set", reason: "ci failed" }, "run-1", clusters);
  assert.equal(clusters.size, 0);
});

test("clusterCorrections: missing correction_key or correction_id is ignored", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_key: undefined }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: undefined }), "run-1", clusters);
  assert.equal(clusters.size, 0);
});

test("clusterCorrections: evidence bundle records distinct items, first/last seen, stages, and actors", () => {
  const clusters = new Map();
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", issue: 10, stage: "review", actor_kind: "human", at: "2026-07-01T00:00:00Z" }),
    "run-1",
    clusters,
  );
  clusterCorrections(
    correctionEvent({ correction_id: "id-2", issue: 11, stage: "fix-1", actor_kind: "pipeline", at: "2026-07-03T00:00:00Z" }),
    "run-2",
    clusters,
  );
  const entries = clustersToEntries(clusters, 10);
  const entry = entries.find((e) => e.category === "correction")!;
  assert.ok(entry.correction);
  assert.equal(entry.correction!.distinctRunCount, 2);
  assert.deepEqual([...entry.correction!.distinctItemIds].sort(), ["10", "11"]);
  assert.equal(entry.correction!.firstSeen, "2026-07-01T00:00:00Z");
  assert.equal(entry.correction!.lastSeen, "2026-07-03T00:00:00Z");
  assert.deepEqual([...entry.correction!.stages].sort(), ["fix-1", "review"]);
  assert.deepEqual([...entry.correction!.actors].sort(), ["human", "pipeline"]);
});

// ---------------------------------------------------------------------------
// Severity/impact evidence cross-reference (#500 review 2 finding 02b2a1921d7c779a)
// ---------------------------------------------------------------------------

test("collectFindingSeverities: indexes key -> severity from a review_verdict event's findings", () => {
  const out = new Map<string, string>();
  collectFindingSeverities(
    { type: "review_verdict", findings: [{ key: "f1", severity: "high" }, { key: "f2", severity: "low" }] },
    out,
  );
  assert.equal(out.get("f1"), "high");
  assert.equal(out.get("f2"), "low");
});

test("collectFindingSeverities: non-review_verdict events and malformed findings are ignored", () => {
  const out = new Map<string, string>();
  collectFindingSeverities({ type: "correction_event" }, out);
  collectFindingSeverities({ type: "review_verdict", findings: "not-an-array" }, out);
  collectFindingSeverities({ type: "review_verdict", findings: [{ key: "f1" }, null, "garbage"] }, out);
  assert.equal(out.size, 0);
});

test("clusterCorrections: resolves severity evidence via evidence_ref when the finding's severity is available", () => {
  const clusters = new Map();
  const findingSeverities = new Map([["f1", "high"]]);
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", evidence_ref: { kind: "finding", id: "f1" } }),
    "run-1",
    clusters,
    findingSeverities,
  );
  const entries = clustersToEntries(clusters, 10);
  const entry = entries.find((e) => e.category === "correction")!;
  assert.deepEqual(entry.correction!.severities, ["high"]);
});

test("clusterCorrections: severities is empty when no severity map is passed", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  const entry = entries.find((e) => e.category === "correction")!;
  assert.deepEqual(entry.correction!.severities, []);
});

test("clusterCorrections: severities is empty when evidence_ref does not reference a finding", () => {
  const clusters = new Map();
  const findingSeverities = new Map([["f1", "high"]]);
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", evidence_ref: { kind: "blocker", id: "b1" } }),
    "run-1",
    clusters,
    findingSeverities,
  );
  const entries = clustersToEntries(clusters, 10);
  const entry = entries.find((e) => e.category === "correction")!;
  assert.deepEqual(entry.correction!.severities, []);
});

test("clusterCorrections: distinct severities across occurrences accumulate deduplicated", () => {
  const clusters = new Map();
  const findingSeverities = new Map([["f1", "high"], ["f2", "medium"]]);
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", evidence_ref: { kind: "finding", id: "f1" } }),
    "run-1",
    clusters,
    findingSeverities,
  );
  clusterCorrections(
    correctionEvent({ correction_id: "id-2", evidence_ref: { kind: "finding", id: "f2" } }),
    "run-1",
    clusters,
    findingSeverities,
  );
  const entries = clustersToEntries(clusters, 10);
  const entry = entries.find((e) => e.category === "correction")!;
  assert.deepEqual(entry.correction!.severities, ["high", "medium"]);
});

test("formatReport: renders severity evidence for a correction cluster when present", () => {
  const clusters = new Map();
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", evidence_ref: { kind: "finding", id: "f1" } }),
    "run-1",
    clusters,
    new Map([["f1", "critical"]]),
  );
  const entries = clustersToEntries(clusters, 10);
  const report = formatReport(entries, false);
  assert.match(report, /\*\*Severity evidence\*\*: critical/);
});

test("formatReport: omits the severity evidence line for a correction cluster with none", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  const report = formatReport(entries, false);
  assert.doesNotMatch(report, /Severity evidence/);
});

test("clusterCorrections: a secret in the correction text is redacted from both signal and excerpt", () => {
  const clusters = new Map();
  clusterCorrections(
    correctionEvent({ correction: "rotate the key sk-ABCDEFGHIJKLMNOPQRSTUVWX01234567 immediately" }),
    "run-1",
    clusters,
  );
  const entry = clusters.get("correction:key-1");
  assert.doesNotMatch(entry.signal, /sk-ABCDEFGHIJKLMNOPQRSTUVWX01234567/);
  assert.doesNotMatch(entry.excerpt, /sk-ABCDEFGHIJKLMNOPQRSTUVWX01234567/);
  assert.match(entry.excerpt, /\[redacted\]|\[REDACTED\]/i);
});

test("category isolation: a correction cluster never merges with a papercut cluster whose signal coincides", () => {
  const clusters = new Map();
  clusterPapercuts({ type: "papercut", message: "flaky test gate" }, "run-1", clusters);
  clusterCorrections(correctionEvent({ correction: "flaky test gate", correction_key: "key-flaky" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  assert.equal(entries.length, 2);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["correction", "papercut"]);
  assert.equal(entries.find((e) => e.category === "papercut")!.count, 1);
  assert.equal(entries.find((e) => e.category === "correction")!.count, 1);
});

test("category isolation: a correction cluster never merges with a flaky-gate cluster for the same stage", () => {
  const clusters = new Map();
  clusterFlakyGates({ type: "stage_complete", stage: "review", outcome: "error" }, "run-1", clusters);
  clusterCorrections(correctionEvent({ stage: "review" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["correction", "flaky-gate"]);
});

test("category isolation: a correction cluster never merges with a token-waste cluster for the same stage", () => {
  const clusters = new Map();
  const HIGH_MS = 35 * 60 * 1000;
  clusterTokenWaste({ stages: [{ stage: "review", commands: [{ durationMs: HIGH_MS }] }] }, "run-1", clusters);
  clusterCorrections(correctionEvent({ stage: "review" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["correction", "token-waste"]);
});

test("category isolation: a correction cluster never merges with a blocker cluster whose reason coincides", () => {
  const clusters = new Map();
  clusterBlockers({ type: "blocker_set", reason: "spec ambiguous" }, "run-1", clusters);
  clusterCorrections(correctionEvent({ correction: "spec ambiguous", correction_key: "key-spec" }), "run-1", clusters);
  const entries = clustersToEntries(clusters, 10);
  const categories = entries.map((e) => e.category).sort();
  assert.deepEqual(categories, ["blocker", "correction"]);
});

test("clusterCorrections: identity/dedup/qualification are unaffected across repeated runs (no LLM/enrichment hook exists in the clustering path)", () => {
  // #500 authority boundary: clusterCorrections and proposeControlLevel are pure
  // functions of the bounded event contract — there is no enrichment dependency
  // parameter anywhere in the clustering path for an LLM to influence identity,
  // dedup, or qualification through. Running the same fixture twice, independently,
  // must produce byte-identical cluster keys/counts/levels every time.
  const events = [
    correctionEvent({ correction_id: "id-1", proposed_control: "instruction" }),
    correctionEvent({ correction_id: "id-2", proposed_control: "instruction" }),
  ];
  function run() {
    const clusters = new Map();
    for (const e of events) clusterCorrections(e, "run-1", clusters);
    return clustersToEntries(clusters, 10);
  }
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test("proposeControlLevel: a single consistent proposed_control seeds the level deterministically", () => {
  assert.equal(proposeControlLevel({ proposedControls: ["eval"] }), "eval");
  assert.equal(proposeControlLevel({ proposedControls: ["instruction"] }), "instruction");
});

test("proposeControlLevel: absent proposed_control yields undetermined", () => {
  assert.equal(proposeControlLevel({ proposedControls: [] }), "undetermined");
  assert.equal(proposeControlLevel({}), "undetermined");
});

test("proposeControlLevel: mixed proposed_control never escalates — yields undetermined", () => {
  assert.equal(proposeControlLevel({ proposedControls: ["instruction", "eval"] }), "undetermined");
  assert.equal(proposeControlLevel({ proposedControls: ["human-judgment", "deterministic-gate"] }), "undetermined");
});

test("graduation ladder: a human-judgment correction is never hardened into an eval or deterministic-gate", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "human-judgment", failure_class: "other" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: "human-judgment", failure_class: "other" }), "run-2", clusters);
  const entry = clustersToEntries(clusters, 10).find((e) => e.category === "correction")!;
  assert.equal(entry.correction!.controlLevel, "human-judgment");
  assert.notEqual(entry.correction!.controlLevel, "eval");
  assert.notEqual(entry.correction!.controlLevel, "deterministic-gate");
});

test("graduation ladder: mixed eval/human-judgment proposed_control resolves to undetermined, never silently to eval", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "eval" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: "human-judgment" }), "run-2", clusters);
  const entry = clustersToEntries(clusters, 10).find((e) => e.category === "correction")!;
  assert.equal(entry.correction!.controlLevel, "undetermined");
});

test("graduation ladder: one occurrence with proposed_control and one distinct occurrence with none resolves to undetermined, never silently to the single named level (#500 review 1 finding cc5edfd1)", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "eval" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: undefined }), "run-2", clusters);
  const entry = clustersToEntries(clusters, 10).find((e) => e.category === "correction")!;
  assert.equal(entry.correction!.controlLevel, "undetermined");
});

test("renderControlProposal: names the level, includes a rationale, and includes acceptance criteria", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "skill-rubric" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: "skill-rubric" }), "run-2", clusters);
  const entry = clustersToEntries(clusters, 10).find((e) => e.category === "correction")!;
  const lines = renderControlProposal(entry);
  const text = lines.join("\n");
  assert.match(text, /Next control level.*skill-rubric/);
  assert.match(text, /Rationale/);
  assert.match(text, /Acceptance criteria/);
  assert.ok(lines.some((l) => l.startsWith("- ")), "expected at least one acceptance-criteria bullet");
});

test("renderControlProposal: undetermined cluster still renders acceptance criteria pointing at a human review", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1" }), "run-1", clusters); // no proposed_control
  const entry = clustersToEntries(clusters, 10).find((e) => e.category === "correction")!;
  const text = renderControlProposal(entry).join("\n");
  assert.match(text, /Next control level.*undetermined/);
  assert.match(text, /human reviews the evidence/i);
});

test("renderControlProposal: non-correction cluster renders nothing", () => {
  assert.deepEqual(renderControlProposal({ category: "papercut", signal: "x", count: 1, runIds: ["r1"], excerpt: "x" }), []);
});

test("formatReport: correction cluster includes evidence bundle fields and control-level proposal", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "instruction" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: "instruction" }), "run-2", clusters);
  const entries = clustersToEntries(clusters, 10);
  const report = formatReport(entries, false);
  assert.match(report, /Distinct runs/);
  assert.match(report, /Distinct items/);
  assert.match(report, /First seen/);
  assert.match(report, /Next control level.*instruction/);
});

test("formatJson: correction cluster emits a correction evidence bundle", () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", proposed_control: "eval" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", proposed_control: "eval" }), "run-2", clusters);
  const entries = clustersToEntries(clusters, 10);
  const json = JSON.parse(formatJson(entries));
  assert.equal(json[0].category, "correction");
  assert.ok(json[0].correction);
  assert.equal(json[0].correction.controlLevel, "eval");
});

test("applyIssues: correction category defaults to a 2-occurrence threshold (not the 3 used by other categories)", async () => {
  const singleton: ClusterEntry = { category: "correction", signal: "s", count: 1, runIds: ["r1"], excerpt: "x" };
  const pair: ClusterEntry = { category: "correction", signal: "t", count: 2, runIds: ["r1", "r2"], excerpt: "y" };
  const createCalls: string[] = [];
  const deps = {
    createIssue: async (title: string) => { createCalls.push(title); return `https://github.com/org/repo/issues/1`; },
    ghAuthCheck: async () => true,
    listOpenImproveIssues: async () => [],
    log: () => {},
  };
  await applyIssues([singleton, pair], {}, deps);
  assert.equal(createCalls.length, 1, "only the 2-occurrence cluster should qualify at the default threshold");
  assert.equal(singleton.issueUrl, undefined, "singleton must remain unfiled");
  assert.ok(pair.issueUrl);
});

test("applyIssues: a non-correction category still requires 3 occurrences by default even when correction's default is 2", async () => {
  const pair: ClusterEntry = { category: "papercut", signal: "s", count: 2, runIds: ["r1", "r2"], excerpt: "x" };
  const deps = {
    createIssue: async () => "https://github.com/org/repo/issues/1",
    ghAuthCheck: async () => true,
    listOpenImproveIssues: async () => [],
    log: () => {},
  };
  await applyIssues([pair], {}, deps);
  assert.equal(pair.issueUrl, undefined);
});

test("applyIssues: an explicit --min-occurrences overrides the per-category default uniformly", async () => {
  const pair: ClusterEntry = { category: "correction", signal: "s", count: 2, runIds: ["r1", "r2"], excerpt: "x" };
  const deps = {
    createIssue: async () => "https://github.com/org/repo/issues/1",
    ghAuthCheck: async () => true,
    listOpenImproveIssues: async () => [],
    log: () => {},
  };
  await applyIssues([pair], { minOccurrences: 3 }, deps);
  assert.equal(pair.issueUrl, undefined, "explicit --min-occurrences 3 should override correction's default of 2");
});

// ---------------------------------------------------------------------------
// 5.4 formatReport
// ---------------------------------------------------------------------------

test("formatReport: empty cluster list includes no-patterns message", () => {
  const report = formatReport([], false);
  assert.ok(report.includes("No recurring patterns found"), `unexpected: ${report}`);
});

test("formatReport: single cluster includes all fields", () => {
  const cluster: ClusterEntry = {
    category: "blocker",
    signal: "ci failed",
    count: 3,
    runIds: ["run-1", "run-2", "run-3"],
    excerpt: "CI failed on push",
  };
  const report = formatReport([cluster], false);
  assert.ok(report.includes("blocker"), `missing category: ${report}`);
  assert.ok(report.includes("ci failed"), `missing signal: ${report}`);
  assert.ok(report.includes("3"), `missing count: ${report}`);
  assert.ok(report.includes("run-1"), `missing runId: ${report}`);
  assert.ok(report.includes("CI failed on push"), `missing excerpt: ${report}`);
  assert.ok(report.includes("Proposed issue title"), `missing proposed title: ${report}`);
});

test("formatReport: token-waste-skipped note when tokenWasteSkipped=true", () => {
  const report = formatReport([], true);
  assert.ok(
    report.includes("token-waste analysis was skipped"),
    `missing skipped note: ${report}`,
  );
});

test("formatReport: no token-waste note when tokenWasteSkipped=false", () => {
  const report = formatReport([], false);
  assert.ok(
    !report.includes("token-waste analysis was skipped"),
    `unexpected skipped note: ${report}`,
  );
});

test("formatReport: includes created issue URL when issueUrl is set", () => {
  const cluster: ClusterEntry = {
    category: "review-finding",
    signal: "null check",
    count: 2,
    runIds: ["run-1"],
    excerpt: "some excerpt",
    issueUrl: "https://github.com/org/repo/issues/42",
  };
  const report = formatReport([cluster], false);
  assert.ok(report.includes("https://github.com/org/repo/issues/42"), `missing issueUrl: ${report}`);
});

test("formatReport: papercut clusters appear alongside other categories", () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 4, runIds: ["run-1"], excerpt: "e" },
    { category: "papercut", signal: "flaky test gate", count: 3, runIds: ["run-2"], excerpt: "e" },
  ];
  const report = formatReport(clusters, false);
  assert.ok(report.includes("[papercut] flaky test gate"), `missing papercut cluster: ${report}`);
  assert.ok(report.includes("[blocker] ci failed"), `missing blocker cluster: ${report}`);
});

test("formatReport: already-tracked cluster is annotated distinctly from a newly created one", () => {
  const cluster: ClusterEntry = {
    category: "papercut",
    signal: "flaky test gate",
    count: 3,
    runIds: ["run-1"],
    excerpt: "e",
    issueUrl: "https://github.com/org/repo/issues/12",
    alreadyTracked: true,
  };
  const report = formatReport([cluster], false);
  assert.ok(report.includes("Already tracked"), `missing already-tracked annotation: ${report}`);
  assert.ok(!report.includes("Created issue"), `should not say Created issue: ${report}`);
});

// ---------------------------------------------------------------------------
// 5.4 formatJson
// ---------------------------------------------------------------------------

test("formatJson: empty cluster list returns valid JSON array", () => {
  const json = formatJson([]);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 0);
});

test("formatJson: single cluster has required fields", () => {
  const cluster: ClusterEntry = {
    category: "flaky-gate",
    signal: "pre_merge",
    count: 4,
    runIds: ["run-1", "run-2"],
    excerpt: "Stage pre_merge failed",
  };
  const json = formatJson([cluster]);
  const parsed = JSON.parse(json) as unknown[];
  assert.equal(parsed.length, 1);
  const obj = parsed[0] as Record<string, unknown>;
  assert.equal(obj["category"], "flaky-gate");
  assert.equal(obj["signal"], "pre_merge");
  assert.equal(obj["count"], 4);
  assert.deepEqual(obj["runIds"], ["run-1", "run-2"]);
  assert.equal(obj["excerpt"], "Stage pre_merge failed");
});

test("formatJson: issueUrl is included when set", () => {
  const cluster: ClusterEntry = {
    category: "blocker",
    signal: "test",
    count: 2,
    runIds: ["run-1"],
    excerpt: "e",
    issueUrl: "https://github.com/org/repo/issues/99",
  };
  const json = formatJson([cluster]);
  const parsed = JSON.parse(json) as Record<string, unknown>[];
  assert.equal(parsed[0]["issueUrl"], "https://github.com/org/repo/issues/99");
});

test("formatJson: issueUrl absent when not set", () => {
  const cluster: ClusterEntry = {
    category: "blocker",
    signal: "test",
    count: 2,
    runIds: ["run-1"],
    excerpt: "e",
  };
  const json = formatJson([cluster]);
  const parsed = JSON.parse(json) as Record<string, unknown>[];
  assert.ok(!("issueUrl" in parsed[0]), "issueUrl should not be present");
});

test("formatJson: papercut cluster emits category: papercut", () => {
  const cluster: ClusterEntry = {
    category: "papercut",
    signal: "flaky test gate",
    count: 3,
    runIds: ["run-1"],
    excerpt: "e",
  };
  const json = formatJson([cluster]);
  const parsed = JSON.parse(json) as Record<string, unknown>[];
  assert.equal(parsed[0]["category"], "papercut");
});

// ---------------------------------------------------------------------------
// 6.4 listOpenImproveIssuesArgs (#421 review 2: truncation regression)
// ---------------------------------------------------------------------------

test("listOpenImproveIssuesArgs: paginates the plain issues endpoint instead of a capped search", () => {
  // Regression for #421 review 2 (round 2) finding: GitHub's search API hard-caps *any*
  // search at 1,000 total results, so a `--search ... in:title` fetch — no matter how high
  // `--limit` is set — silently drops matches in repos with 1,000+ `[pipeline-improve]`
  // issues. The plain `repos/{owner}/{repo}/issues` REST endpoint has no such cap; `--paginate`
  // must be present to follow every page to completion.
  const args = listOpenImproveIssuesArgs();
  assert.equal(args.indexOf("--search"), -1, "must not use the capped search API");
  assert.ok(args.includes("--paginate"), "expected --paginate to fetch every page to completion");
  assert.ok(args.includes("--slurp"), "expected --slurp so paginated pages can be flattened");
  assert.ok(
    args.some((a) => a.startsWith("repos/") && a.includes("/issues")),
    "expected the plain repo issues endpoint, not a search query",
  );
});

test("parseOpenImproveIssuesPages: no truncation across 1,200 matching issues spanning many pages", () => {
  // Regression for #421 review 2 round 2: search-API-based retrieval silently drops matches
  // past 1,000 total results. Simulate 1,200 `[pipeline-improve]` issues spread across 12
  // `--paginate --slurp` pages (100 each, matching the real per_page) and assert every one
  // survives flattening — including the oldest, which a truncated fetch would drop first.
  const pages = Array.from({ length: 12 }, (_, pageIdx) =>
    Array.from({ length: 100 }, (_, i) => {
      const n = pageIdx * 100 + i;
      return {
        title: `[pipeline-improve] Recurring papercut: issue ${n}`,
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        html_url: `https://github.com/o/r/issues/${n}`,
        labels: [],
      };
    }),
  );
  const result = parseOpenImproveIssuesPages(pages);
  assert.equal(result.length, 1200, "expected all 1,200 matching issues, not capped at 1,000");
  assert.ok(
    result.some((i) => i.title === "[pipeline-improve] Recurring papercut: issue 1199"),
    "the oldest/last-paged issue must survive — a 1,000-result cap would drop it",
  );
});

test("parseOpenImproveIssuesPages: drops pull requests and non-matching titles", () => {
  const pages = [
    [
      {
        title: "[pipeline-improve] Recurring papercut: foo",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        html_url: "https://github.com/o/r/issues/1",
        labels: [],
      },
      {
        title: "[pipeline-improve] Recurring papercut: pr",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        html_url: "https://github.com/o/r/pull/2",
        labels: [],
        pull_request: {},
      },
      {
        title: "unrelated issue",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        html_url: "https://github.com/o/r/issues/3",
        labels: [],
      },
    ],
  ];
  const result = parseOpenImproveIssuesPages(pages);
  assert.deepEqual(
    result.map((i) => i.title),
    ["[pipeline-improve] Recurring papercut: foo"],
  );
});

// ---------------------------------------------------------------------------
// 6.5 applyIssues
// ---------------------------------------------------------------------------

function makeApplyDeps(overrides: Partial<{
  authed: boolean;
  createCalls: Array<{ title: string; body: string }>;
  shouldFailCreate: boolean;
  openIssues: OpenImproveIssue[];
}> = {}): Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "listOpenImproveIssues" | "log"> & {
  _createCalls: Array<{ title: string; body: string }>;
  _logLines: string[];
  _listCalls: number;
} {
  const authed = overrides.authed ?? true;
  const createCalls: Array<{ title: string; body: string }> = [];
  const logLines: string[] = [];
  const openIssues = overrides.openIssues ?? [];
  const listCallCounter = { n: 0 };
  const deps = {
    ghAuthCheck: async () => authed,
    listOpenImproveIssues: async () => {
      listCallCounter.n++;
      return openIssues;
    },
    createIssue: async (title: string, body: string) => {
      if (overrides.shouldFailCreate) throw new Error("gh create failed");
      createCalls.push({ title, body });
      return `https://github.com/org/repo/issues/${createCalls.length}`;
    },
    log: (msg: string) => logLines.push(msg),
    _createCalls: createCalls,
    _logLines: logLines,
    get _listCalls() {
      return listCallCounter.n;
    },
  };
  return deps;
}

test("applyIssues: qualifying clusters get gh issue create called", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e1" },
    { category: "review-finding", signal: "null check", count: 3, runIds: ["run-2"], excerpt: "e2" },
  ];
  const deps = makeApplyDeps();
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 2);
  assert.ok(deps._createCalls[0].title.includes("blocker"));
  assert.ok(deps._createCalls[0].body.includes("run-1"));
  assert.ok(deps._createCalls[0].body.includes("e1"));
  assert.equal(clusters[0].issueUrl, "https://github.com/org/repo/issues/1");
});

test("applyIssues: below-threshold clusters are skipped", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e" },
    { category: "review-finding", signal: "null check", count: 2, runIds: ["run-2"], excerpt: "e" },
  ];
  const deps = makeApplyDeps();
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 1);
  assert.equal(clusters[1].issueUrl, undefined);
});

test("applyIssues: gh-not-authenticated path throws error", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e" },
  ];
  const deps = makeApplyDeps({ authed: false });
  await assert.rejects(
    () => applyIssues(clusters, { minOccurrences: 3 }, deps),
    (err: Error) => {
      assert.ok(err.message.includes("not authenticated"), `unexpected message: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps._createCalls.length, 0);
});

test("applyIssues: no clusters qualify when all below threshold", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 1, runIds: ["run-1"], excerpt: "e" },
  ];
  const deps = makeApplyDeps();
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 0);
  assert.equal(deps._logLines.length, 0);
});

// ---------------------------------------------------------------------------
// 4.2/4.4 applyIssues — open-issue dedup (#421)
// ---------------------------------------------------------------------------

test("applyIssues: second apply files nothing when an open issue already matches the title", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e" },
  ];
  const openIssues: OpenImproveIssue[] = [
    {
      title: proposedTitle(clusters[0]),
      url: "https://github.com/org/repo/issues/99",
      state: "OPEN",
      createdAt: "2026-07-01T00:00:00Z",
      labels: [],
    },
  ];
  const deps = makeApplyDeps({ openIssues });
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 0);
  assert.equal(clusters[0].issueUrl, "https://github.com/org/repo/issues/99");
  assert.equal(clusters[0].alreadyTracked, true);
});

test("applyIssues: a closed issue with a matching title does not suppress creation", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e" },
  ];
  const openIssues: OpenImproveIssue[] = [
    {
      title: proposedTitle(clusters[0]),
      url: "https://github.com/org/repo/issues/99",
      state: "CLOSED",
      createdAt: "2026-07-01T00:00:00Z",
      labels: [],
    },
  ];
  const deps = makeApplyDeps({ openIssues });
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 1);
  assert.equal(clusters[0].alreadyTracked, undefined);
});

test("applyIssues: two clusters that truncate to the same title in one invocation create only one issue (finding 4)", async () => {
  const longPrefix = "x".repeat(80);
  const clusters: ClusterEntry[] = [
    { category: "papercut", signal: `${longPrefix} variant one`, count: 5, runIds: ["run-1"], excerpt: "e" },
    { category: "papercut", signal: `${longPrefix} variant two`, count: 4, runIds: ["run-2"], excerpt: "e" },
  ];
  const deps = makeApplyDeps();
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(
    deps._createCalls.length,
    1,
    "both signals truncate to the same 60-char proposedTitle() — only one issue should be created",
  );
  assert.equal(clusters[0].issueUrl, "https://github.com/org/repo/issues/1");
  assert.equal(clusters[1].alreadyTracked, true, "the second cluster should be recognized as a duplicate of the just-created title");
});

test("applyIssues: correction dedup keys on correction_key, not free-text prose (#500 review 1 finding fcb8ee87)", async () => {
  // Same correction_key, prose changed between runs (e.g. wording tweaked) — must
  // still dedup against the prior issue rather than filing a second one.
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_id: "id-1", correction: "original wording" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_id: "id-2", correction: "revised wording, totally different prose" }), "run-2", clusters);
  const entries = clustersToEntries(clusters, 10);
  const openIssues: OpenImproveIssue[] = [
    {
      title: proposedTitle(entries[0]),
      url: "https://github.com/org/repo/issues/42",
      state: "OPEN",
      createdAt: "2026-07-01T00:00:00Z",
      labels: [],
    },
  ];
  const deps = makeApplyDeps({ openIssues });
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 0, "changed prose under the same correction_key must still dedup");
  assert.equal(entries[0].alreadyTracked, true);
});

test("applyIssues: two different correction_key clusters with identical prose file two issues, never merge (#500 review 1 finding fcb8ee87)", async () => {
  const clusters = new Map();
  clusterCorrections(correctionEvent({ correction_key: "key-a", correction_id: "id-1", correction: "same wording" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_key: "key-a", correction_id: "id-2", correction: "same wording" }), "run-1", clusters);
  clusterCorrections(correctionEvent({ correction_key: "key-b", correction_id: "id-3", correction: "same wording" }), "run-2", clusters);
  clusterCorrections(correctionEvent({ correction_key: "key-b", correction_id: "id-4", correction: "same wording" }), "run-2", clusters);
  const entries = clustersToEntries(clusters, 10);
  assert.equal(entries.length, 2);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 2, "identical prose under different correction_keys must not dedup against each other");
  assert.notEqual(deps._createCalls[0].title, deps._createCalls[1].title);
});

test("applyIssues: correction issue body carries severity evidence when present (#500 review 2 finding 02b2a1921d7c779a)", async () => {
  const clusters = new Map();
  clusterCorrections(
    correctionEvent({ correction_id: "id-1", evidence_ref: { kind: "finding", id: "f1" } }),
    "run-1",
    clusters,
    new Map([["f1", "high"]]),
  );
  clusterCorrections(
    correctionEvent({ correction_id: "id-2", evidence_ref: { kind: "finding", id: "f1" } }),
    "run-2",
    clusters,
    new Map([["f1", "high"]]),
  );
  const entries = clustersToEntries(clusters, 10);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 1);
  assert.match(deps._createCalls[0].body, /Severity evidence: high/);
});

test("applyIssues: listOpenImproveIssues is called exactly once regardless of cluster count", async () => {
  const clusters: ClusterEntry[] = [
    { category: "blocker", signal: "ci failed", count: 5, runIds: ["run-1"], excerpt: "e" },
    { category: "review-finding", signal: "null check", count: 4, runIds: ["run-2"], excerpt: "e" },
    { category: "papercut", signal: "flaky test", count: 3, runIds: ["run-3"], excerpt: "e" },
  ];
  const deps = makeApplyDeps();
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._listCalls, 1);
  assert.equal(deps._createCalls.length, 3);
});

test("applyIssues: dedup applies to papercut clusters the same as non-papercut categories", async () => {
  const clusters: ClusterEntry[] = [
    { category: "papercut", signal: "flaky test gate", count: 4, runIds: ["run-1"], excerpt: "e" },
  ];
  const openIssues: OpenImproveIssue[] = [
    {
      title: proposedTitle(clusters[0]),
      url: "https://github.com/org/repo/issues/7",
      state: "OPEN",
      createdAt: "2026-07-01T00:00:00Z",
      labels: [],
    },
  ];
  const deps = makeApplyDeps({ openIssues });
  await applyIssues(clusters, { minOccurrences: 3 }, deps);
  assert.equal(deps._createCalls.length, 0);
  assert.equal(clusters[0].issueUrl, "https://github.com/org/repo/issues/7");
});

// ---------------------------------------------------------------------------
// 7.2 Memory safety — large corpus
// ---------------------------------------------------------------------------

test("memory safety: 500 events produce at most distinct-key count cluster entries", () => {
  const clusters = new Map<string, unknown>();
  // Simulate 500 blocker_set events, 5 distinct reasons × 100 occurrences each
  const reasons = ["ci failed", "auth expired", "no pr found", "lock timeout", "gh rate limited"];
  for (let i = 0; i < 500; i++) {
    const reason = reasons[i % reasons.length];
    const event = { type: "blocker_set", reason } as Record<string, unknown>;
    clusterBlockers(event, `run-${i}`, clusters as Map<string, never>);
  }
  assert.equal(clusters.size, 5, `expected 5 clusters, got ${clusters.size}`);
  for (const [, entry] of clusters) {
    const e = entry as { count: number };
    assert.equal(e.count, 100);
  }
});

// ---------------------------------------------------------------------------
// clustersToEntries
// ---------------------------------------------------------------------------

test("clustersToEntries: sorts by count descending and slices to top-N", () => {
  const clusters = new Map<string, {
    category: "blocker";
    signal: string;
    count: number;
    runIds: Set<string>;
    excerpt: string;
  }>();
  clusters.set("a", { category: "blocker", signal: "a", count: 1, runIds: new Set(["r1"]), excerpt: "e" });
  clusters.set("b", { category: "blocker", signal: "b", count: 5, runIds: new Set(["r2"]), excerpt: "e" });
  clusters.set("c", { category: "blocker", signal: "c", count: 3, runIds: new Set(["r3"]), excerpt: "e" });
  const entries = clustersToEntries(clusters as never, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].signal, "b");
  assert.equal(entries[1].signal, "c");
});

// ---------------------------------------------------------------------------
// clusterDurableRunBlockers / qualifiesDurableRunBlocker (#538)
// ---------------------------------------------------------------------------

function durableOccurrence(overrides: Partial<DurableBlockerOccurrence> = {}): DurableBlockerOccurrence {
  return {
    runId: "run-1",
    itemId: "100",
    blockerClass: "workflow-engine-defect",
    fingerprint: "fp-1",
    evidenceExcerpt: "engine crashed mid-cycle",
    time: "2026-07-20T00:00:00.000Z",
    terminal: false,
    ...overrides,
  };
}

test("clusterDurableRunBlockers: keys on (class, fingerprint), never free-text prose", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", evidenceExcerpt: "wording A" }), clusters);
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-2", evidenceExcerpt: "totally different wording B" }), clusters);
  assert.equal(clusters.size, 1);
  const [entry] = [...clusters.values()];
  assert.equal(entry.count, 2);
  assert.deepEqual([...entry.runIds].sort(), ["run-1", "run-2"]);
});

test("clusterDurableRunBlockers: count mirrors distinct affected runs, not raw occurrence count", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", itemId: "100" }), clusters);
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", itemId: "200" }), clusters);
  const [entry] = [...clusters.values()];
  assert.equal(entry.count, 1); // one distinct run, even though two items in it shared the fingerprint
  assert.deepEqual([...entry.itemIds!].sort(), ["100", "200"]);
});

test("clusterDurableRunBlockers: terminal is sticky once any occurrence is terminal", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", terminal: true }), clusters);
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-2", terminal: false }), clusters);
  const [entry] = [...clusters.values()];
  assert.equal(entry.terminal, true);
});

test("clusterDurableRunBlockers: a secret in the evidence excerpt is redacted (belt-and-braces sanitization)", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(
    durableOccurrence({ evidenceExcerpt: "failed with GITHUB_TOKEN=ghp_abcdefghij1234567890" }),
    clusters,
  );
  const [entry] = [...clusters.values()];
  assert.ok(!entry.excerpt.includes("ghp_abcdefghij1234567890"));
});

test("category isolation: a durable-run-blocker cluster never merges with a blocker cluster whose signal coincides", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ blockerClass: "workflow-state", fingerprint: "fp-1" }), clusters);
  clusterBlockers({ type: "blocker_set", reason: "workflow-state" }, "run-9", clusters);
  assert.equal(clusters.size, 2);
});

test("suggestMilestoneForBlockerClass: deterministic, non-empty for every DurableBlockerClass", () => {
  const classes = [
    "transient-rate-limit",
    "workflow-state",
    "implementation-ci",
    "environment-auth",
    "specification-decision",
    "missing-authority",
    "upstream-dependency",
    "workflow-engine-defect",
  ] as const;
  for (const cls of classes) {
    const a = suggestMilestoneForBlockerClass(cls);
    const b = suggestMilestoneForBlockerClass(cls);
    assert.equal(a, b);
    assert.ok(a.length > 0);
  }
});

test("qualifiesDurableRunBlocker: a terminal cluster qualifies from a single run", () => {
  const entry = clustersToEntries((() => {
    const clusters = new Map<string, ClusterAccum>();
    clusterDurableRunBlockers(durableOccurrence({ terminal: true }), clusters);
    return clusters;
  })(), 10)[0];
  assert.equal(qualifiesDurableRunBlocker(entry, 2), true);
});

test("qualifiesDurableRunBlocker: a non-terminal single-run occurrence never qualifies", () => {
  const entry = clustersToEntries((() => {
    const clusters = new Map<string, ClusterAccum>();
    clusterDurableRunBlockers(durableOccurrence({ terminal: false }), clusters);
    return clusters;
  })(), 10)[0];
  assert.equal(qualifiesDurableRunBlocker(entry, 2), false);
});

test("qualifiesDurableRunBlocker: a non-terminal cluster qualifies once it recurs across 2 distinct runs", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", terminal: false }), clusters);
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-2", terminal: false }), clusters);
  const entry = clustersToEntries(clusters, 10)[0];
  assert.equal(qualifiesDurableRunBlocker(entry, 2), true);
});

test("qualifiesDurableRunBlocker: minOccurrences below the floor of 2 is still floored at 2", () => {
  const entry = clustersToEntries((() => {
    const clusters = new Map<string, ClusterAccum>();
    clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", terminal: false }), clusters);
    return clusters;
  })(), 10)[0];
  assert.equal(qualifiesDurableRunBlocker(entry, 1), false);
});

test("proposedTitle: durable-run-blocker title identity is (class, fingerprint), never free-text prose", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ blockerClass: "environment-auth", fingerprint: "fp-abc", evidenceExcerpt: "wording one" }), clusters);
  const entryA = clustersToEntries(clusters, 10)[0];
  const clusters2 = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ blockerClass: "environment-auth", fingerprint: "fp-abc", evidenceExcerpt: "totally different wording" }), clusters2);
  const entryB = clustersToEntries(clusters2, 10)[0];
  assert.equal(proposedTitle(entryA), proposedTitle(entryB));
  assert.equal(proposedTitle(entryA), "[pipeline-improve] Durable-run blocker: environment-auth:fp-abc");
});

test("formatReport: durable-run-blocker cluster includes fingerprint, terminal flag, item ids, and suggested milestone", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ terminal: true }), clusters);
  const entries = clustersToEntries(clusters, 10);
  const report = formatReport(entries, false);
  assert.match(report, /\*\*Blocker class\*\*: workflow-engine-defect/);
  assert.match(report, /\*\*Evidence fingerprint\*\*: fp-1/);
  assert.match(report, /\*\*Terminal stop\*\*: yes/);
  assert.match(report, /\*\*Affected item ids\*\*: 100/);
  assert.match(report, /\*\*Suggested milestone\*\*: .+/);
});

test("formatJson: durable-run-blocker cluster emits a durableRunBlocker bundle", () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence(), clusters);
  const entries = clustersToEntries(clusters, 10);
  const parsed = JSON.parse(formatJson(entries));
  assert.equal(parsed[0].category, "durable-run-blocker");
  assert.equal(parsed[0].durableRunBlocker.blockerClass, "workflow-engine-defect");
  assert.equal(parsed[0].durableRunBlocker.fingerprint, "fp-1");
});

test("applyIssues: a terminal durable-run-blocker cluster is filed from a single run", async () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ terminal: true }), clusters);
  const entries = clustersToEntries(clusters, 10);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 1);
  assert.equal(entries[0].issueUrl, "https://github.com/org/repo/issues/1");
});

test("applyIssues: a single non-terminal durable-run-blocker occurrence is not filed", async () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ terminal: false }), clusters);
  const entries = clustersToEntries(clusters, 10);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 0);
});

test("applyIssues: a non-terminal durable-run-blocker cluster recurring across 2 runs is filed", async () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-1", terminal: false }), clusters);
  clusterDurableRunBlockers(durableOccurrence({ runId: "run-2", terminal: false }), clusters);
  const entries = clustersToEntries(clusters, 10);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  assert.equal(deps._createCalls.length, 1);
});

test("applyIssues: durable-run-blocker issue body carries evidence and a no-milestone-assigned note", async () => {
  const clusters = new Map<string, ClusterAccum>();
  clusterDurableRunBlockers(durableOccurrence({ terminal: true }), clusters);
  const entries = clustersToEntries(clusters, 10);
  const deps = makeApplyDeps();
  await applyIssues(entries, {}, deps);
  const body = deps._createCalls[0].body;
  assert.match(body, /Blocker class: workflow-engine-defect/);
  assert.match(body, /Evidence fingerprint: fp-1/);
  assert.match(body, /never auto-assigned/);
});
