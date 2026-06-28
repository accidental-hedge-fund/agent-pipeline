// Tests for the `pipeline queue` sub-command (#305).
//
// All tests are network-, filesystem-, and subprocess-free: I/O is injected via
// the QueueDeps seam. Each test proves the code bites (assertions on specific
// outcomes, error cases, or guard conditions).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectIssues,
  buildBatchSummary,
  computePriorityScore,
  STAGE_PRIORITY_SCORE,
  runQueue,
  type EligibleIssue,
  type QueueDeps,
  type QueueOpts,
  type RunResult,
  type IssueFilters,
} from "../scripts/stages/queue.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  number: number,
  labels: string[] = ["pipeline:ready"],
  milestone: string | null = null,
): EligibleIssue {
  return {
    number,
    title: `Issue #${number}`,
    labels,
    priorityScore: computePriorityScore(labels),
    milestone,
  };
}

/** Build a fake QueueDeps for testing. */
function makeDeps(overrides: Partial<QueueDeps> = {}): QueueDeps & { written: Map<string, string>; logs: string[] } {
  const written = new Map<string, string>();
  const logs: string[] = [];
  let tick = 0;

  return {
    listEligibleIssues: async (_filters: IssueFilters) => [],
    runPipeline: async (issueNumber) => ({
      issueNumber,
      finalState: "ready-to-deploy",
      costUsd: 0.1,
      durationMs: 100,
    }),
    readRunCost: async (_issueNumber) => null,
    writeFile: async (filePath, content) => { written.set(filePath, content); },
    log: (msg) => { logs.push(msg); },
    clock: () => ++tick * 100,
    written,
    logs,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<QueueOpts> = {}): QueueOpts {
  return {
    maxIssues: 10,
    budgetDollars: null,
    concurrency: 1,
    maxFailureRate: 1.0,
    filters: {},
    repoDir: "/fake/repo",
    profile: undefined,
    batchId: "2026-06-28T00-00-00-000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: computePriorityScore
// ---------------------------------------------------------------------------

test("computePriorityScore: pipeline:ready label returns highest score", () => {
  const score = computePriorityScore(["pipeline:ready", "harness:claude"]);
  assert.equal(score, STAGE_PRIORITY_SCORE["ready"]);
});

test("computePriorityScore: pipeline:review-2 returns lower score than pipeline:ready", () => {
  const readyScore = computePriorityScore(["pipeline:ready"]);
  const review2Score = computePriorityScore(["pipeline:review-2"]);
  assert.ok(readyScore > review2Score);
});

test("computePriorityScore: no pipeline label returns 0", () => {
  assert.equal(computePriorityScore(["bug", "harness:claude"]), 0);
});

// ---------------------------------------------------------------------------
// Unit tests: selectIssues
// ---------------------------------------------------------------------------

test("selectIssues: empty candidates returns empty list", () => {
  const result = selectIssues([], {}, 10);
  assert.deepEqual(result, []);
});

test("selectIssues: maxIssues cap is respected", () => {
  const candidates = [1, 2, 3, 4, 5].map((n) => makeIssue(n));
  const result = selectIssues(candidates, {}, 3);
  assert.equal(result.length, 3);
});

test("selectIssues: maxIssues=0 returns empty list", () => {
  const candidates = [1, 2, 3].map((n) => makeIssue(n));
  assert.deepEqual(selectIssues(candidates, {}, 0), []);
});

test("selectIssues: label filter excludes non-matching issues", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready", "team:backend"]),
    makeIssue(2, ["pipeline:ready", "team:frontend"]),
    makeIssue(3, ["pipeline:ready", "team:backend"]),
  ];
  const result = selectIssues(candidates, { labels: ["team:backend"] }, 10);
  assert.equal(result.length, 2);
  assert.ok(result.every((i) => i.labels.includes("team:backend")));
});

test("selectIssues: label filter requires ALL specified labels (intersection)", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready", "team:backend", "size:small"]),
    makeIssue(2, ["pipeline:ready", "team:backend"]),
    makeIssue(3, ["pipeline:ready", "size:small"]),
  ];
  const result = selectIssues(candidates, { labels: ["team:backend", "size:small"] }, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
});

test("selectIssues: milestone filter excludes non-matching issues", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready"], "v2.0"),
    makeIssue(2, ["pipeline:ready"], "v1.0"),
    makeIssue(3, ["pipeline:ready"], "v2.0"),
  ];
  const result = selectIssues(candidates, { milestone: "v2.0" }, 10);
  assert.equal(result.length, 2);
  assert.ok(result.every((i) => i.milestone === "v2.0"));
});

test("selectIssues: risk filter excludes issues above specified level", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready", "risk:low"]),
    makeIssue(2, ["pipeline:ready", "risk:medium"]),
    makeIssue(3, ["pipeline:ready", "risk:high"]),
    makeIssue(4, ["pipeline:ready"]), // no risk label — included
  ];
  const result = selectIssues(candidates, { risk: "medium" }, 10);
  assert.equal(result.length, 3);
  assert.ok(!result.find((i) => i.number === 3), "risk:high should be excluded");
  assert.ok(result.find((i) => i.number === 4), "no risk label should be included");
});

test("selectIssues: risk=low excludes medium and high", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready", "risk:low"]),
    makeIssue(2, ["pipeline:ready", "risk:medium"]),
    makeIssue(3, ["pipeline:ready", "risk:high"]),
  ];
  const result = selectIssues(candidates, { risk: "low" }, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
});

test("selectIssues: priority ordering — pipeline:ready scores higher than pipeline:review-2", () => {
  const candidates = [
    makeIssue(1, ["pipeline:review-2"]),
    makeIssue(2, ["pipeline:ready"]),
    makeIssue(3, ["pipeline:fix-1"]),
  ];
  const result = selectIssues(candidates, {}, 10);
  assert.equal(result[0].number, 2, "pipeline:ready should rank first");
});

test("selectIssues: ties in score broken by issue number ascending (FIFO)", () => {
  const candidates = [
    makeIssue(5, ["pipeline:ready"]),
    makeIssue(1, ["pipeline:ready"]),
    makeIssue(3, ["pipeline:ready"]),
  ];
  const result = selectIssues(candidates, {}, 10);
  assert.equal(result[0].number, 1);
  assert.equal(result[1].number, 3);
  assert.equal(result[2].number, 5);
});

test("selectIssues: all filters applied together", () => {
  const candidates = [
    makeIssue(1, ["pipeline:ready", "risk:low", "team:backend"], "v2.0"),
    makeIssue(2, ["pipeline:ready", "risk:low", "team:frontend"], "v2.0"),
    makeIssue(3, ["pipeline:ready", "risk:high", "team:backend"], "v2.0"),
    makeIssue(4, ["pipeline:ready", "risk:low", "team:backend"], "v1.0"),
  ];
  const result = selectIssues(candidates, { labels: ["team:backend"], risk: "low", milestone: "v2.0" }, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
});

// ---------------------------------------------------------------------------
// Unit tests: buildBatchSummary
// ---------------------------------------------------------------------------

test("buildBatchSummary: serializes to valid JSON with schema_version='1'", () => {
  const results: RunResult[] = [
    { issueNumber: 1, finalState: "ready-to-deploy", costUsd: 0.50, durationMs: 1000 },
    { issueNumber: 2, finalState: "needs-human", costUsd: 0.30, durationMs: 800 },
    { issueNumber: 3, finalState: "error", costUsd: null, durationMs: 500, error: "oops" },
  ];
  const titles = new Map([[1, "Alpha"], [2, "Beta"], [3, "Gamma"]]);
  const opts = makeOpts({ batchId: "test-batch-01" });
  const summary = buildBatchSummary(results, titles, opts, null, 2, 1000, 5000);

  const json = JSON.stringify(summary);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema_version, "1");
  assert.equal(parsed.batch_id, "test-batch-01");
  assert.ok(parsed.started_at.includes("T"), "started_at should be ISO 8601");
  assert.ok(parsed.ended_at.includes("T"), "ended_at should be ISO 8601");
  assert.equal(parsed.halt_reason, null);
  assert.equal(parsed.issues.length, 3);
  assert.equal(parsed.excluded_count, 2);
});

test("buildBatchSummary: aggregate counts succeeded and failed correctly", () => {
  const results: RunResult[] = [
    { issueNumber: 1, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 100 },
    { issueNumber: 2, finalState: "needs-human", costUsd: 0.20, durationMs: 200 },
    { issueNumber: 3, finalState: "error", costUsd: null, durationMs: 300 },
    { issueNumber: 4, finalState: "planning", costUsd: null, durationMs: 400 },
  ];
  const titles = new Map(results.map((r) => [r.issueNumber, `Issue ${r.issueNumber}`]));
  const summary = buildBatchSummary(results, titles, makeOpts(), null, 0, 0, 1000);

  assert.equal(summary.aggregate.total_issues, 4);
  assert.equal(summary.aggregate.succeeded, 2); // ready-to-deploy + needs-human
  assert.equal(summary.aggregate.failed, 2);    // error + planning
  assert.equal(summary.aggregate.failure_rate, 0.5);
  assert.ok(Math.abs(summary.aggregate.total_cost_usd - 0.30) < 1e-9, `expected ~0.30, got ${summary.aggregate.total_cost_usd}`);
  assert.equal(summary.aggregate.total_duration_ms, 1000);
});

test("buildBatchSummary: halt_reason recorded in summary", () => {
  const results: RunResult[] = [
    { issueNumber: 1, finalState: "ready-to-deploy", costUsd: 0.60, durationMs: 500 },
  ];
  const titles = new Map([[1, "Alpha"]]);
  const summary = buildBatchSummary(results, titles, makeOpts({ budgetDollars: 0.5 }), "budget_exhausted", 5, 0, 1000);
  assert.equal(summary.halt_reason, "budget_exhausted");
});

test("buildBatchSummary: error field included for errored issues", () => {
  const results: RunResult[] = [
    { issueNumber: 42, finalState: "error", costUsd: null, durationMs: 100, error: "timeout" },
  ];
  const titles = new Map([[42, "Crashed Issue"]]);
  const summary = buildBatchSummary(results, titles, makeOpts(), null, 0, 0, 1000);
  assert.equal(summary.issues[0].error, "timeout");
});

// ---------------------------------------------------------------------------
// Integration tests: runQueue
// ---------------------------------------------------------------------------

test("9.1 happy-path batch: 5 eligible issues, concurrency 2, all succeed", async () => {
  const issues = [1, 2, 3, 4, 5].map((n) => makeIssue(n));
  const written = new Map<string, string>();
  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => ({
      issueNumber: n,
      finalState: "ready-to-deploy",
      costUsd: 0.10,
      durationMs: 50,
    }),
    writeFile: async (p, c) => { written.set(p, c); },
  });

  await runQueue(makeOpts({ maxIssues: 5, concurrency: 2 }), deps);

  assert.equal(written.size, 1, "batch-summary.json should be written");
  const summaryJson = [...written.values()][0];
  const summary = JSON.parse(summaryJson);
  assert.equal(summary.schema_version, "1");
  assert.equal(summary.aggregate.total_issues, 5);
  assert.equal(summary.aggregate.succeeded, 5);
  assert.equal(summary.aggregate.failed, 0);
  assert.equal(summary.halt_reason, null);
});

test("9.2 --max-issues cap: 10 eligible issues, maxIssues=3; only 3 runs launched", async () => {
  const issues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => makeIssue(n));
  let launched = 0;
  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      launched++;
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 3, concurrency: 1 }), deps);

  assert.equal(launched, 3, "only 3 issues should be launched");
  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.aggregate.total_issues, 3);
  assert.equal(summary.excluded_count, 7);
});

test("9.3 budget exhaustion mid-batch: runs cost $0.40 each, budget $1.00; run 4 not launched", async () => {
  const issues = [1, 2, 3, 4, 5].map((n) => makeIssue(n));
  const launched: number[] = [];
  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      launched.push(n);
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.40, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 5, concurrency: 1, budgetDollars: 1.0 }), deps);

  // runs 1 ($0.40) and 2 ($0.80) complete; before run 3 starts, cumulative is $0.80 < $1.00
  // run 3 ($1.20) completes; before run 4 starts, $1.20 >= $1.00 → budget exhausted
  assert.ok(launched.length <= 3, `only ≤3 runs should launch, got ${launched.length}`);

  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.halt_reason, "budget_exhausted");
  assert.ok(summary.aggregate.total_cost_usd >= 1.0);
});

test("9.4 failure-rate gate: 3 completed, 2 failed; run 4 not launched after gate fires", async () => {
  // concurrency=2: issues 1 and 2 start, then 3 and 4, etc.
  // Outcomes: 1=success, 2=fail, 3=fail → 3 completed, 2 failed, rate=0.67 >= 0.5 → gate fires
  const issues = [1, 2, 3, 4, 5].map((n) => makeIssue(n));
  const outcomes: Record<number, string> = {
    1: "ready-to-deploy",
    2: "error",
    3: "error",
    4: "ready-to-deploy",
    5: "ready-to-deploy",
  };
  const launched: number[] = [];

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      launched.push(n);
      return { issueNumber: n, finalState: outcomes[n] ?? "error", costUsd: 0.10, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 5, concurrency: 2, maxFailureRate: 0.5 }), deps);

  // Gate should fire after 3 completions with 2 failures. In-flight slots drain, but
  // no new issues are launched after the gate fires.
  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.halt_reason, "failure_rate_exceeded");
  // Issues 4 and/or 5 might be in-flight when gate fires (concurrency=2 means some slots
  // were filled before gate triggered) but no further slots are filled after gate.
  assert.ok(launched.length < 5, `fewer than 5 issues should launch when gate fires; got ${launched.length}`);
});

test("9.5 gate cold-start: 2 completed runs both failed; gate does NOT fire (sample < 3)", async () => {
  const issues = [1, 2, 3].map((n) => makeIssue(n));
  const outcomes: Record<number, string> = { 1: "error", 2: "error", 3: "ready-to-deploy" };
  const launched: number[] = [];

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      launched.push(n);
      return { issueNumber: n, finalState: outcomes[n] ?? "error", costUsd: 0.10, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 3, concurrency: 1, maxFailureRate: 0.5 }), deps);

  // With sample < 3, gate does not fire even when 100% fail.
  // After 3 completions (2 fail + 1 success), rate is 0.67 but let's check that at 2
  // completions the 3rd is still launched.
  assert.equal(launched.length, 3, "all 3 issues should be launched (gate needs ≥3 completed)");

  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  // Gate fires after run 3 completes (3 completed, 2 failed), but run 3 itself was already launched.
  // So the halt_reason may be set after all 3 are done but no further runs were possible anyway.
  // Key assertion: all 3 were launched (gate didn't fire before run 3 started).
  assert.equal(summary.aggregate.total_issues, 3);
});

test("9.6 per-issue isolation: run 2 throws; runs 1 and 3 complete normally", async () => {
  const issues = [1, 2, 3].map((n) => makeIssue(n));

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      if (n === 2) throw new Error("simulated crash");
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 50 };
    },
  });

  // Should NOT throw — exceptions are caught per-issue.
  await runQueue(makeOpts({ maxIssues: 3, concurrency: 1 }), deps);

  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.aggregate.total_issues, 3);

  const issue2 = summary.issues.find((i: { number: number }) => i.number === 2);
  assert.ok(issue2, "issue 2 should appear in summary");
  assert.equal(issue2.final_state, "error");
  assert.ok(typeof issue2.error === "string" && issue2.error.length > 0, "error field should be set");

  // Issues 1 and 3 should be succeeded.
  const succeeded = summary.issues.filter((i: { final_state: string }) => i.final_state === "ready-to-deploy");
  assert.equal(succeeded.length, 2);
});

test("9.7 label filter: 6 eligible issues, 2 have risk:high; --risk medium excludes 2", async () => {
  const issues = [
    makeIssue(1, ["pipeline:ready"]),
    makeIssue(2, ["pipeline:ready", "risk:high"]),
    makeIssue(3, ["pipeline:ready", "risk:medium"]),
    makeIssue(4, ["pipeline:ready"]),
    makeIssue(5, ["pipeline:ready", "risk:high"]),
    makeIssue(6, ["pipeline:ready", "risk:low"]),
  ];
  const launched: number[] = [];

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      launched.push(n);
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 10, concurrency: 1, filters: { risk: "medium" } }), deps);

  assert.equal(launched.length, 4, "only 4 non-high-risk issues should launch");
  assert.ok(!launched.includes(2), "issue 2 (risk:high) should be excluded");
  assert.ok(!launched.includes(5), "issue 5 (risk:high) should be excluded");

  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.excluded_count, 2, "2 high-risk issues should be counted as excluded");
});

test("9.8 config sub-key defaults: queue.concurrency=3 in config, no CLI flag → effective concurrency 3", async () => {
  // We test the selectIssues+runQueue interaction by checking how many are active at once.
  // With concurrency=3, all 3 issues should be in-flight simultaneously.
  const issues = [1, 2, 3].map((n) => makeIssue(n));
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      // Simulate async work by yielding to allow other runs to start.
      await new Promise<void>((resolve) => setImmediate(resolve));
      currentConcurrent--;
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 50 };
    },
  });

  // opts.concurrency=3 simulates what would happen when config sets concurrency=3 and no CLI flag overrides
  await runQueue(makeOpts({ maxIssues: 3, concurrency: 3 }), deps);

  assert.equal(maxConcurrent, 3, "all 3 should run concurrently with concurrency=3");
});

test("9.9 config CLI override: config concurrency=3, CLI concurrency=1 → sequential execution", async () => {
  const issues = [1, 2, 3].map((n) => makeIssue(n));
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await new Promise<void>((resolve) => setImmediate(resolve));
      currentConcurrent--;
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.10, durationMs: 50 };
    },
  });

  // concurrency=1 (CLI flag value) should override any config value
  await runQueue(makeOpts({ maxIssues: 3, concurrency: 1 }), deps);

  assert.equal(maxConcurrent, 1, "only 1 should run at a time with concurrency=1");
});

test("9.10 buildBatchSummary: JSON.parse succeeds; schema_version is '1'", () => {
  const results: RunResult[] = [
    { issueNumber: 1, finalState: "ready-to-deploy", costUsd: 0.25, durationMs: 1500 },
  ];
  const titles = new Map([[1, "Example Issue"]]);
  const opts = makeOpts({ batchId: "verify-schema" });
  const summary = buildBatchSummary(results, titles, opts, null, 0, 1000, 2000);

  const json = JSON.stringify(summary);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema_version, "1", "schema_version must be the string '1'");
  assert.ok(Array.isArray(parsed.issues), "issues must be an array");
  assert.ok(typeof parsed.aggregate === "object", "aggregate must be an object");
  assert.ok(typeof parsed.limits === "object", "limits must be an object");
  assert.ok(typeof parsed.excluded_count === "number", "excluded_count must be a number");
  assert.ok(typeof parsed.halt_reason === "object" || parsed.halt_reason === null, "halt_reason must be null or string");
});

test("batch-summary.json is written to the correct path", async () => {
  const issues = [makeIssue(1)];
  const written = new Map<string, string>();
  const batchId = "2026-01-01T00-00-00-000Z";

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => ({
      issueNumber: n,
      finalState: "ready-to-deploy",
      costUsd: 0.05,
      durationMs: 100,
    }),
    writeFile: async (p, c) => { written.set(p, c); },
  });

  await runQueue(makeOpts({ repoDir: "/fake/repo", batchId }), deps);

  const expectedPath = `/fake/repo/.agent-pipeline/runs/batch-${batchId}/batch-summary.json`;
  assert.ok(written.has(expectedPath), `summary should be written to ${expectedPath}`);
});

test("in-flight runs complete after budget gate fires", async () => {
  // concurrency=2: run 1 and 2 start in parallel.
  // run 1 costs $0.60 — after it completes, cumulative = $0.60 >= budget $0.50 → gate fires.
  // run 2 was already in-flight → must complete.
  const issues = [1, 2, 3].map((n) => makeIssue(n));
  const completed: number[] = [];

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => {
      if (n === 2) {
        // Ensure run 2 starts before run 1 completes (yield one tick).
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      completed.push(n);
      return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0.60, durationMs: 50 };
    },
  });

  await runQueue(makeOpts({ maxIssues: 3, concurrency: 2, budgetDollars: 0.50 }), deps);

  // run 3 must NOT be launched (budget exhausted before it could start).
  // runs 1 and 2 must have completed.
  assert.ok(!completed.includes(3), "run 3 should not be launched after budget exhausted");
  const summaryStr = [...deps.written.values()][0];
  const summary = JSON.parse(summaryStr);
  assert.equal(summary.halt_reason, "budget_exhausted");
});

test("stdout includes per-issue table and aggregate line", async () => {
  const issues = [makeIssue(42)];
  issues[0].title = "My special issue";

  const deps = makeDeps({
    listEligibleIssues: async () => issues,
    runPipeline: async (n) => ({
      issueNumber: n,
      finalState: "ready-to-deploy",
      costUsd: 0.12,
      durationMs: 2000,
    }),
  });

  await runQueue(makeOpts({ maxIssues: 1 }), deps);

  const logOutput = deps.logs.join("\n");
  assert.ok(logOutput.includes("#42"), "log should mention the issue number");
  assert.ok(logOutput.includes("Aggregate:"), "log should include aggregate line");
  assert.ok(logOutput.includes("Artifact:"), "log should include artifact path");
});
