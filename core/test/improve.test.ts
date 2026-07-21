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
  clustersToEntries,
  formatReport,
  formatJson,
  applyIssues,
  proposedTitle,
  type ClusterEntry,
  type ImproveDeps,
  type OpenImproveIssue,
  type RunInfo,
} from "../scripts/improve.ts";

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
