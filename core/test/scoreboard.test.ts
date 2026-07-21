import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildScoreboardReport,
  escapeHtml,
  formatScoreboardHuman,
  parseEstimateCosts,
  parseScoreboardBucket,
  parseScoreboardGroupBy,
  parseScoreboardWindow,
  renderScoreboardHtml,
  resolveGroupIdentity,
  runScoreboard,
  type ScoreboardDeps,
  type ScoreboardReport,
} from "../scripts/scoreboard.ts";
import { runsDir } from "../scripts/run-store.ts";

const REPO_DIR = "/repo";
const PIPELINE_SCRIPT = path.resolve(import.meta.dirname, "../scripts/pipeline.ts");

type MemDeps = Pick<ScoreboardDeps, "readFile" | "readdir"> & {
  files: Map<string, string>;
  reads: string[];
};

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function memDeps(files: Record<string, string> = {}): MemDeps {
  const fileMap = new Map(Object.entries(files));
  const reads: string[] = [];
  return {
    files: fileMap,
    reads,
    readFile: async (p) => {
      reads.push(p);
      if (!fileMap.has(p)) throw enoent(p);
      return fileMap.get(p)!;
    },
    readdir: async (p) => {
      if (p !== runsDir(REPO_DIR)) throw enoent(p);
      const prefix = `${p}${path.sep}`;
      const dirs = new Set<string>();
      for (const key of fileMap.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split(path.sep)[0];
        if (first) dirs.add(first);
      }
      return [...dirs].sort().map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

function runPath(runId: string, file: string): string {
  return path.join(runsDir(REPO_DIR), runId, file);
}

function addRun(
  files: Record<string, string>,
  runId: string,
  opts: {
    runJson?: Record<string, unknown> | null;
    events?: Record<string, unknown>[];
    eventsRaw?: string;
    summary?: Record<string, unknown> | null;
    summaryRaw?: string;
  },
): void {
  if (opts.runJson !== null) {
    files[runPath(runId, "run.json")] = JSON.stringify(
      opts.runJson ?? {
        schema_version: 1,
        run_id: runId,
        issue: 301,
        repo: "owner/repo",
        profile: "codex",
        started_at: "2026-06-10T00:00:00Z",
      },
    );
  }
  if (opts.eventsRaw !== undefined) {
    files[runPath(runId, "events.jsonl")] = opts.eventsRaw;
  } else if (opts.events !== undefined) {
    files[runPath(runId, "events.jsonl")] = opts.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
  if (opts.summaryRaw !== undefined) {
    files[runPath(runId, "summary.json")] = opts.summaryRaw;
  } else if (opts.summary !== null) {
    files[runPath(runId, "summary.json")] = JSON.stringify(
      opts.summary ?? {
        schema_version: 1,
        schemaVersion: 1,
        runId,
        run_id: runId,
        issue: 301,
        pr: 101,
        branch: "pipeline/301",
        harnesses: ["codex"],
        stages: [],
        reviews: [],
        overrides: [],
        recoveries: [],
        finalState: "ready-to-deploy",
        finalizedAt: "2026-06-10T00:02:00Z",
        notifiedAt: null,
      },
    );
  }
}

test("parseScoreboardWindow: defaults to last 30 days ending at command start (#301)", () => {
  const window = parseScoreboardWindow({ now: new Date("2026-06-28T15:31:56Z") });
  assert.equal(window.until, "2026-06-28T15:31:56.000Z");
  assert.equal(window.since, "2026-05-29T15:31:56.000Z");
  assert.equal(window.days, 30);
});

test("parseScoreboardWindow: days-only window spans the requested day count (#301)", () => {
  const window = parseScoreboardWindow({ days: 7, now: new Date("2026-06-28T15:31:56Z") });
  const spanDays = (Date.parse(window.until) - Date.parse(window.since)) / (24 * 60 * 60 * 1000);

  assert.equal(window.until, "2026-06-28T15:31:56.000Z");
  assert.equal(window.since, "2026-06-21T15:31:56.000Z");
  assert.equal(spanDays, 7);
  assert.equal(window.days, 7);
});

test("scanRunStore: filters explicit window and honors start timestamp fallback order (#301)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "301-2026-06-10T00-00-00-000Z", {
    runJson: { started_at: "2026-06-10T00:00:00Z", issue: 1 },
    events: [{ schema_version: 1, type: "run_complete", at: "2026-06-10T00:01:00Z", final_state: "ready-to-deploy", elapsed_ms: 60000, pr: 101 }],
  });
  addRun(files, "302-2026-06-20T00-00-00-000Z", {
    runJson: { started_at: "2026-06-20T00:00:00Z", issue: 2 },
    events: [{ schema_version: 1, type: "run_complete", at: "2026-06-20T00:01:00Z", final_state: "ready-to-deploy", elapsed_ms: 60000, pr: 102 }],
  });
  addRun(files, "event-start-run", {
    runJson: null,
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-11T00:00:00Z", issue: 3, repo: "owner/repo" },
      { schema_version: 1, type: "run_complete", at: "2026-06-11T00:01:00Z", final_state: "needs-human", elapsed_ms: 60000 },
    ],
    summary: null,
  });
  addRun(files, "303-2026-06-12T00-00-00-000Z", {
    runJson: null,
    eventsRaw: "",
    summary: null,
  });
  addRun(files, "priority-2026-06-10T00-00-00-000Z", {
    runJson: { started_at: "2026-06-20T00:00:00Z", issue: 4 },
    events: [{ schema_version: 1, type: "run_start", at: "2026-06-10T00:00:00Z", issue: 4, repo: "owner/repo" }],
    summary: null,
  });
  addRun(files, "no-start", {
    runJson: null,
    events: [{ schema_version: 1, type: "blocker_set", at: "not-a-date", reason: "x" }],
    summary: null,
  });

  const deps = memDeps(files);
  const report = await buildScoreboardReport(
    {
      repoDir: REPO_DIR,
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-15T00:00:00Z",
    },
    deps,
  );

  assert.equal(report.totals.scanned_runs, 6);
  assert.equal(report.totals.included_runs, 3);
  assert.equal(report.totals.ready_runs, 1);
  assert.ok(report.diagnostics.some((d) => d.code === "missing_start_time" && d.path.endsWith("no-start")));
  assert.ok(!deps.reads.some((p) => p.endsWith("terminal.log")), "scoreboard must not read terminal.log");
});

test("buildScoreboardReport: computes required throughput, autonomy, reliability, duration, retry, fallback, and cost metrics (#301)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "301-2026-06-10T00-00-00-000Z", {
    runJson: { started_at: "2026-06-10T00:00:00Z", issue: 1 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-10T00:00:00Z", issue: 1, repo: "owner/repo" },
      { schema_version: 1, type: "stage_start", at: "2026-06-10T00:00:00Z", stage: "review-1" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-10T00:01:00Z", stage: "review-1", outcome: "advanced" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-10T00:01:20Z", stage: "eval-gate", outcome: "advanced" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-10T00:01:30Z", stage: "shipcheck-gate", outcome: "skipped" },
      { schema_version: 1, type: "run_complete", at: "2026-06-10T00:02:00Z", final_state: "ready-to-deploy", elapsed_ms: 120000 },
    ],
    summary: {
      issue: 1,
      pr: 101,
      finalState: "ready-to-deploy",
      stages: [
        {
          stage: "review-1",
          enteredAt: "2026-06-10T00:00:00Z",
          exitedAt: "2026-06-10T00:01:00Z",
          outcome: "advanced",
          prompts: [
            { kind: "implementing", harness: "codex", hash: "a", cost_usd: 2.5 },
            { kind: "review", harness: "claude", hash: "b" },
            { kind: "fix", harness: "codex", hash: "c", usage: { cost_usd: 0.5 } },
          ],
        },
        {
          stage: "planning",
          commands: [{ cmd: "npm test", exitCode: 0, durationMs: 1000, outputExcerpt: "ok" }],
        },
        {
          stage: "eval-gate",
          outcome: "advanced",
          commands: [{ cmd: "pnpm evals", exitCode: 0, durationMs: 1200, outputExcerpt: "PASS" }],
        },
      ],
      reviews: [
        { round: 1, sha: "a", verdict: "approve", findingCounts: {}, selfReview: false },
        { round: 2, sha: "b", verdict: "approve", findingCounts: {}, selfReview: true },
        { round: 3, sha: "c", verdict: "approve", findingCounts: {}, selfReview: false },
        { round: 4, sha: "d", verdict: "approve", findingCounts: {}, selfReview: false },
      ],
      overrides: [],
      recoveries: [],
    },
  });
  addRun(files, "302-2026-06-11T00-00-00-000Z", {
    runJson: { started_at: "2026-06-11T00:00:00Z", issue: 2 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-11T00:00:00Z", issue: 2, repo: "owner/repo" },
      { schema_version: 1, type: "human_intervention", at: "2026-06-11T00:00:30Z", kind: "test-build-failure", stage: "fix-1", issue: 2, detail: "tests failed" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-11T00:01:00Z", stage: "eval-gate", outcome: "blocked" },
      { schema_version: 1, type: "gate_result", at: "2026-06-11T00:01:20Z", gate: "shipcheck-gate", result: "pass", mode: "gate" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-11T00:01:30Z", stage: "shipcheck-gate", outcome: "advanced" },
      { schema_version: 1, type: "run_complete", at: "2026-06-11T00:03:00Z", final_state: "ready-to-deploy", elapsed_ms: 180000 },
    ],
    summary: {
      issue: 2,
      pr: 102,
      finalState: "ready-to-deploy",
      stages: [
        { stage: "fix-1", enteredAt: "2026-06-11T00:00:30Z", exitedAt: "2026-06-11T00:01:00Z", outcome: "advanced", prompts: [{ kind: "fix", harness: "codex", hash: "d" }] },
      ],
      reviews: [],
      overrides: [],
      recoveries: [],
    },
  });
  addRun(files, "303-2026-06-12T00-00-00-000Z", {
    runJson: { started_at: "2026-06-12T00:00:00Z", issue: 3 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-12T00:00:00Z", issue: 3, repo: "owner/repo" },
      { schema_version: 1, type: "human_intervention", at: "2026-06-12T00:00:30Z", kind: "review-non-convergence", stage: "review-2", issue: 3, detail: "review loop" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-12T00:01:00Z", stage: "eval-gate", outcome: "skipped" },
      { schema_version: 1, type: "run_complete", at: "2026-06-12T00:04:00Z", final_state: "needs-human", elapsed_ms: 240000 },
    ],
    summary: { issue: 3, pr: 103, finalState: "needs-human", stages: [], reviews: [], overrides: [], recoveries: [] },
  });

  const report = await buildScoreboardReport(
    {
      repoDir: REPO_DIR,
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-30T00:00:00Z",
      estimateCost: ["codex=0.75", "claude=1.00"],
    },
    memDeps(files),
  );

  assert.equal(report.totals.included_runs, 3);
  assert.equal(report.totals.ready_runs, 2);
  assert.equal(report.totals.successful_prs, 2);
  assert.deepEqual(report.metrics.ready_to_deploy_without_human_intervention, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.equal(report.metrics.full_run_duration_ms.count, 3);
  assert.equal(report.metrics.full_run_duration_ms.avg_ms, 180000);
  assert.equal(report.metrics.stage_duration_ms["review-1"].count, 1, "summary/events duplicate stage timings should be counted once");
  assert.deepEqual(report.metrics.harness_calls_per_successful_pr, { numerator: 4, denominator: 2, ratio: 2 });
  assert.deepEqual(report.metrics.retry_fix_rounds_per_pr, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.equal(report.metrics.blocker_rate_by_kind.counts["test-build-failure"], 1);
  assert.equal(report.metrics.blocker_rate_by_kind.counts["review-non-convergence"], 1);
  assert.deepEqual(report.metrics.needs_human_rate, { numerator: 1, denominator: 3, ratio: 1 / 3 });
  assert.deepEqual(report.metrics.same_harness_fallback_rate, { numerator: 1, denominator: 4, ratio: 0.25 });
  assert.deepEqual(report.metrics.gate_pass_rates.test.pass_rate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(report.metrics.gate_pass_rates.eval.pass_rate, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.equal(report.metrics.gate_pass_rates.eval.skipped, 1);
  assert.deepEqual(report.metrics.gate_pass_rates.shipcheck.pass_rate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.equal(report.metrics.gate_pass_rates.shipcheck.skipped, 1);
  assert.equal(report.metrics.cost_per_ready_pr_usd.actual_usd, 3);
  assert.equal(report.metrics.cost_per_ready_pr_usd.estimated_usd, 1.75);
  assert.equal(report.metrics.cost_per_ready_pr_usd.value, 2.375);
});

test("buildScoreboardReport: gate pass rates use verdict evidence, not stage advancement (#301 review 1)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "301-2026-06-13T00-00-00-000Z", {
    runJson: { started_at: "2026-06-13T00:00:00Z", issue: 1 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-13T00:00:00Z", issue: 1, repo: "owner/repo" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-13T00:01:00Z", stage: "eval-gate", outcome: "advanced" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-13T00:02:00Z", stage: "shipcheck-gate", outcome: "advanced" },
      { schema_version: 1, type: "run_complete", at: "2026-06-13T00:03:00Z", final_state: "ready-to-deploy", elapsed_ms: 180000 },
    ],
    summary: {
      issue: 1,
      pr: 201,
      finalState: "ready-to-deploy",
      stages: [
        { stage: "eval-gate", outcome: "advanced", commands: [] },
        { stage: "shipcheck-gate", outcome: "advanced", commands: [] },
      ],
      reviews: [],
      overrides: [],
      recoveries: [],
    },
  });
  addRun(files, "302-2026-06-14T00-00-00-000Z", {
    runJson: { started_at: "2026-06-14T00:00:00Z", issue: 2 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-14T00:00:00Z", issue: 2, repo: "owner/repo" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-14T00:01:00Z", stage: "eval-gate", outcome: "advanced" },
      { schema_version: 1, type: "gate_result", at: "2026-06-14T00:02:00Z", gate: "shipcheck-gate", result: "fail", mode: "advisory" },
      { schema_version: 1, type: "stage_complete", at: "2026-06-14T00:02:10Z", stage: "shipcheck-gate", outcome: "advanced" },
      { schema_version: 1, type: "run_complete", at: "2026-06-14T00:03:00Z", final_state: "ready-to-deploy", elapsed_ms: 180000 },
    ],
    summary: {
      issue: 2,
      pr: 202,
      finalState: "ready-to-deploy",
      stages: [
        {
          stage: "eval-gate",
          outcome: "advanced",
          commands: [{ cmd: "pnpm evals", exitCode: 1, durationMs: 1000, outputExcerpt: "FAIL" }],
        },
        { stage: "shipcheck-gate", outcome: "advanced", commands: [] },
      ],
      reviews: [],
      overrides: [],
      recoveries: [],
    },
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.deepEqual(report.metrics.gate_pass_rates.eval.pass_rate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(report.metrics.gate_pass_rates.eval.failed, 1);
  assert.equal(report.metrics.gate_pass_rates.eval.skipped, 1);
  assert.deepEqual(report.metrics.gate_pass_rates.shipcheck.pass_rate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(report.metrics.gate_pass_rates.shipcheck.failed, 1);
  assert.equal(report.metrics.gate_pass_rates.shipcheck.skipped, 1);
});

test("buildScoreboardReport: artifact problems are diagnostics, not crashes (#301)", async () => {
  const missingStoreDeps: MemDeps = {
    ...memDeps(),
    readdir: async () => { throw enoent(runsDir(REPO_DIR)); },
  };
  const empty = await buildScoreboardReport({ repoDir: REPO_DIR, now: new Date("2026-06-28T00:00:00Z") }, missingStoreDeps);
  assert.equal(empty.totals.included_runs, 0);
  assert.ok(empty.diagnostics.some((d) => d.code === "missing_run_store"));

  const files: Record<string, string> = {};
  addRun(files, "301-2026-06-10T00-00-00-000Z", {
    runJson: { started_at: "2026-06-10T00:00:00Z", issue: 1 },
    eventsRaw:
      JSON.stringify({ schema_version: 1, type: "run_start", at: "2026-06-10T00:00:00Z", issue: 1, repo: "owner/repo" }) + "\n" +
      JSON.stringify({ schema_version: 1, type: "pr_updated", at: "2026-06-10T00:00:30Z", pr: 101 }) + "\n" +
      JSON.stringify({ schema_version: 1, type: "run_complete", at: "2026-06-10T00:01:00Z", final_state: "ready-to-deploy", elapsed_ms: 60000, unknown_future: true }) + "\n" +
      '{"type":',
    summaryRaw: "{not-json",
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.totals.ready_runs, 1);
  assert.equal(report.totals.successful_prs, 1);
  assert.ok(report.diagnostics.some((d) => d.code === "corrupt_summary" && d.path.endsWith("summary.json")));
  assert.ok(report.diagnostics.some((d) => d.code === "partial_events_tail" && d.path.endsWith("events.jsonl")));
});

test("buildScoreboardReport: missing cost estimate makes cost per ready PR unavailable (#301)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "301-2026-06-10T00-00-00-000Z", {
    runJson: { started_at: "2026-06-10T00:00:00Z", issue: 1 },
    events: [{ schema_version: 1, type: "run_complete", at: "2026-06-10T00:01:00Z", final_state: "ready-to-deploy", elapsed_ms: 60000 }],
    summary: {
      issue: 1,
      pr: 101,
      finalState: "ready-to-deploy",
      stages: [{ stage: "review-1", prompts: [{ kind: "review", harness: "claude", hash: "a" }] }],
      reviews: [],
      overrides: [],
      recoveries: [],
    },
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.metrics.cost_per_ready_pr_usd.value, null);
  assert.equal(report.metrics.cost_per_ready_pr_usd.missing_call_count, 1);
  assert.ok(report.diagnostics.some((d) => d.code === "missing_cost_estimate" && d.message.includes("claude")));
});

test("buildScoreboardReport: groups summary accounting by issue stage harness model slot model and outcome (#304)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "304-2026-06-15T00-00-00-000Z", {
    runJson: { started_at: "2026-06-15T00:00:00Z", issue: 304 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-15T00:00:00Z", issue: 304, repo: "owner/repo" },
      { schema_version: 1, type: "run_complete", at: "2026-06-15T00:10:00Z", final_state: "ready-to-deploy", elapsed_ms: 600000 },
    ],
    summary: {
      issue: 304,
      pr: 304,
      finalState: "ready-to-deploy",
      stages: [],
      reviews: [],
      overrides: [],
      recoveries: [],
      accounting: {
        records: [
          {
            schema_version: 1,
            run_id: "304-2026-06-15T00-00-00-000Z",
            issue: 304,
            stage: "review-1",
            harness: "claude",
            model_slot: "review",
            model: "opus",
            started_at: "2026-06-15T00:01:00Z",
            ended_at: "2026-06-15T00:02:00Z",
            duration_ms: 60000,
            command_count: 1,
            subprocess_count: 1,
            outcome: "success",
            blocker_kind: null,
            cost_source: "actual",
            cost_usd: 1.25,
            prompt_chars: 1200,
            prompt_estimated_tokens: 300,
          },
          {
            schema_version: 1,
            run_id: "304-2026-06-15T00-00-00-000Z",
            issue: 304,
            stage: "review-1",
            harness: "claude",
            model_slot: "review",
            model: "opus",
            started_at: "2026-06-15T00:02:00Z",
            ended_at: "2026-06-15T00:03:00Z",
            duration_ms: 30000,
            command_count: 2,
            subprocess_count: 2,
            outcome: "success",
            blocker_kind: null,
            cost_source: "estimated",
            cost_usd: 0.75,
            prompt_chars: 800,
            prompt_estimated_tokens: 200,
          },
          {
            schema_version: 1,
            run_id: "304-2026-06-15T00-00-00-000Z",
            issue: 304,
            stage: "fix-1",
            harness: "codex",
            model_slot: "fix",
            model: "sonnet",
            started_at: "2026-06-15T00:03:00Z",
            ended_at: "2026-06-15T00:04:00Z",
            duration_ms: 45000,
            command_count: 1,
            subprocess_count: 1,
            outcome: "failure",
            blocker_kind: "harness-failure",
            cost_source: "unknown",
            cost_usd: null,
            prompt_chars: 400,
            prompt_estimated_tokens: 100,
          },
        ],
      },
    },
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.metrics.cost_accounting.totals.invocation_count, 3);
  assert.equal(report.metrics.cost_accounting.totals.total_duration_ms, 135000);
  assert.equal(report.metrics.cost_accounting.totals.command_count, 4);
  assert.equal(report.metrics.cost_accounting.totals.subprocess_count, 4);
  assert.equal(report.metrics.cost_accounting.totals.actual_cost_usd, 1.25);
  assert.equal(report.metrics.cost_accounting.totals.estimated_cost_usd, 0.75);
  assert.equal(report.metrics.cost_accounting.totals.unknown_cost_count, 1);
  assert.equal(report.metrics.cost_accounting.totals.prompt_chars_total, 2400);
  assert.equal(report.metrics.cost_accounting.totals.prompt_chars_max, 1200);
  assert.equal(report.metrics.cost_accounting.totals.prompt_estimated_tokens_total, 600);

  // #429 — cost-source coverage: 1 actual, 1 estimated, 1 unknown of 3 total calls.
  assert.equal(report.metrics.cost_accounting.coverage.actual_calls, 1);
  assert.equal(report.metrics.cost_accounting.coverage.estimated_calls, 1);
  assert.equal(report.metrics.cost_accounting.coverage.unknown_calls, 1);
  assert.equal(report.metrics.cost_accounting.coverage.actual_coverage, Math.round((1 / 3) * 10000) / 10000);

  const reviewGroup = report.metrics.cost_accounting.groups.find((g) => g.stage === "review-1");
  assert.ok(reviewGroup, "expected review accounting group");
  assert.equal(reviewGroup.invocation_count, 2);
  assert.equal(reviewGroup.actual_cost_usd, 1.25);
  assert.equal(reviewGroup.estimated_cost_usd, 0.75);
  assert.equal(reviewGroup.unknown_cost_count, 0);
  assert.equal(reviewGroup.prompt_chars_total, 2000);
  assert.equal(reviewGroup.prompt_chars_max, 1200);
  assert.equal(reviewGroup.prompt_estimated_tokens_total, 500);

  const fixGroup = report.metrics.cost_accounting.groups.find((g) => g.stage === "fix-1");
  assert.ok(fixGroup, "expected fix accounting group");
  assert.equal(fixGroup.unknown_cost_count, 1);
  assert.equal(fixGroup.actual_cost_usd, 0);
  assert.equal(fixGroup.estimated_cost_usd, 0);
  assert.equal(fixGroup.prompt_chars_total, 400);
  assert.equal(fixGroup.prompt_chars_max, 400);
  assert.equal(fixGroup.prompt_estimated_tokens_total, 100);
  const human = formatScoreboardHuman(report);
  assert.match(human, /prompt chars 2400 \(max 1200\)/);
  assert.match(human, /est prompt tokens 600/);
  // #429 — the human report names actual/estimated/unknown call counts and the ratio.
  assert.match(human, /Cost-source coverage: actual 1; estimated 1; unknown 1; actual coverage 33\.3%/);
  assert.ok(report.diagnostics.some((d) => d.code === "unknown_accounting_cost" && d.message.includes("not counted as free")));
});

test("buildScoreboardReport: cost-source coverage is null (not 0) for an empty window (#429)", async () => {
  const files: Record<string, string> = {};
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.metrics.cost_accounting.coverage.actual_calls, 0);
  assert.equal(report.metrics.cost_accounting.coverage.estimated_calls, 0);
  assert.equal(report.metrics.cost_accounting.coverage.unknown_calls, 0);
  assert.equal(report.metrics.cost_accounting.coverage.actual_coverage, null);

  const human = formatScoreboardHuman(report);
  assert.match(human, /Cost-source coverage: actual 0; estimated 0; unknown 0; actual coverage n\/a/);
});

test("buildScoreboardReport: a mixed set of schema_version 1 and 2 stage_accounting records aggregates fully with no dropped records or version diagnostics (#429)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "429-2026-07-01T00-00-00-000Z", {
    runJson: { started_at: "2026-07-01T00:00:00Z", issue: 429 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-07-01T00:00:00Z", issue: 429, repo: "owner/repo" },
      {
        schema_version: 1,
        type: "stage_accounting",
        at: "2026-07-01T00:01:00Z",
        run_id: "429-2026-07-01T00-00-00-000Z",
        issue: 429,
        stage: "review-1",
        harness: "codex",
        model_slot: "review",
        model: "sonnet",
        started_at: "2026-07-01T00:00:10Z",
        ended_at: "2026-07-01T00:00:40Z",
        duration_ms: 30000,
        command_count: 1,
        subprocess_count: 1,
        outcome: "success",
        blocker_kind: null,
        cost_source: "estimated",
        cost_usd: 0.5,
      },
      {
        schema_version: 2,
        type: "stage_accounting",
        at: "2026-07-01T00:02:00Z",
        run_id: "429-2026-07-01T00-00-00-000Z",
        issue: 429,
        stage: "review-2",
        harness: "claude",
        model_slot: "review",
        model: "opus",
        started_at: "2026-07-01T00:01:10Z",
        ended_at: "2026-07-01T00:01:40Z",
        duration_ms: 30000,
        command_count: 1,
        subprocess_count: 1,
        outcome: "success",
        blocker_kind: null,
        cost_source: "actual",
        cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { schema_version: 1, type: "run_complete", at: "2026-07-01T00:10:00Z", final_state: "ready-to-deploy", elapsed_ms: 600000, pr: 429 },
    ],
    summaryRaw: "{not-json",
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-07-31T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.metrics.cost_accounting.totals.invocation_count, 2, "both v1 and v2 records must be counted");
  assert.equal(report.metrics.cost_accounting.coverage.actual_calls, 1);
  assert.equal(report.metrics.cost_accounting.coverage.estimated_calls, 1);
  assert.equal(report.metrics.cost_accounting.coverage.unknown_calls, 0);
  assert.ok(
    !report.diagnostics.some((d) => d.code === "invalid_accounting_record"),
    "no record should be dropped or flagged solely for its schema_version",
  );
});

test("buildScoreboardReport: missing or corrupt summary falls back to stage_accounting events (#304)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "304-2026-06-16T00-00-00-000Z", {
    runJson: { started_at: "2026-06-16T00:00:00Z", issue: 304 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-06-16T00:00:00Z", issue: 304, repo: "owner/repo" },
      {
        schema_version: 1,
        type: "stage_accounting",
        at: "2026-06-16T00:01:00Z",
        run_id: "304-2026-06-16T00-00-00-000Z",
        issue: 304,
        stage: "planning",
        harness: "codex",
        model_slot: "planning",
        model: "sonnet",
        started_at: "2026-06-16T00:00:10Z",
        ended_at: "2026-06-16T00:00:40Z",
        duration_ms: 30000,
        command_count: 1,
        subprocess_count: 1,
        outcome: "success",
        blocker_kind: null,
        cost_source: "unknown",
        cost_usd: null,
      },
      { schema_version: 1, type: "run_complete", at: "2026-06-16T00:10:00Z", final_state: "ready-to-deploy", elapsed_ms: 600000, pr: 304 },
    ],
    summaryRaw: "{not-json",
  });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" },
    memDeps(files),
  );

  assert.equal(report.metrics.cost_accounting.groups.length, 1);
  assert.equal(report.metrics.cost_accounting.groups[0].stage, "planning");
  assert.equal(report.metrics.cost_accounting.groups[0].unknown_cost_count, 1);
  assert.ok(report.diagnostics.some((d) => d.code === "corrupt_summary"));
  assert.ok(report.diagnostics.some((d) => d.code === "unknown_accounting_cost"));
});

test("parseEstimateCosts: rejects malformed estimates (#301)", () => {
  assert.deepEqual(parseEstimateCosts(["codex=0.75", "claude=1"]), { codex: 0.75, claude: 1 });
  assert.throws(() => parseEstimateCosts(["codex"]), /--estimate-cost/);
  assert.throws(() => parseEstimateCosts(["codex=-1"]), /--estimate-cost/);
});

test("formatScoreboardHuman: contains every required metric heading (#301)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, now: new Date("2026-06-28T00:00:00Z") },
    { ...memDeps(), readdir: async () => { throw enoent(runsDir(REPO_DIR)); } },
  );
  const output = formatScoreboardHuman(report);
  for (const heading of [
    "Report window:",
    "Included runs:",
    "Successful PRs:",
    "Ready-to-deploy without human intervention:",
    "Cost per ready PR:",
    "Cost-source coverage:",
    "Cost/accounting by group:",
    "Full-run wall-clock duration:",
    "Stage wall-clock duration:",
    "Harness calls per successful PR:",
    "Retry/fix-round count per PR:",
    "Blocker rate by kind:",
    "pipeline:needs-human rate:",
    "Same-harness fallback rate:",
    "Test pass rate:",
    "Eval pass rate:",
    "Shipcheck pass rate:",
    "Diagnostics:",
  ]) {
    assert.ok(output.includes(heading), `missing heading ${heading}`);
  }
});

test("CLI: pipeline scoreboard --json emits exactly one parseable object without gh/config (#301)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-json-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.equal(result.stdout.trimStart().startsWith("{"), true);
    assert.equal(result.stdout.trimEnd().endsWith("}"), true);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema_version, 1);
    assert.ok(parsed.window);
    assert.ok(parsed.totals);
    assert.ok(parsed.metrics);
    assert.ok(Array.isArray(parsed.metrics.cost_accounting.groups));
    assert.ok(Array.isArray(parsed.diagnostics));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard human output includes required headings without gh/config (#301)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-human-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /Report window:/);
    assert.match(result.stdout, /Ready-to-deploy without human intervention:/);
    assert.match(result.stdout, /Cost per ready PR:/);
    assert.match(result.stdout, /Cost\/accounting by group:/);
    assert.match(result.stdout, /Shipcheck pass rate:/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --bucket day|week time-series (#425)
// ---------------------------------------------------------------------------

function addReadyRun(
  files: Record<string, string>,
  runId: string,
  startAt: string,
  opts: { issue?: number; pr?: number } = {},
): void {
  const issue = opts.issue ?? 1;
  const pr = opts.pr ?? issue;
  addRun(files, runId, {
    runJson: { started_at: startAt, issue },
    events: [{ schema_version: 1, type: "run_complete", at: startAt, final_state: "ready-to-deploy", elapsed_ms: 60000, pr }],
    summary: { issue, pr, finalState: "ready-to-deploy", stages: [], reviews: [], overrides: [], recoveries: [] },
  });
}

test("parseScoreboardBucket: accepts day/week, rejects anything else, and is a no-op when absent (#425)", () => {
  assert.equal(parseScoreboardBucket(undefined), null);
  assert.equal(parseScoreboardBucket("day"), "day");
  assert.equal(parseScoreboardBucket("week"), "week");
  assert.throws(() => parseScoreboardBucket("month"), /--bucket must be one of: day, week/);
});

test("buildScoreboardReport: day buckets align to UTC calendar days and are contiguous (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-01T00-00-00-000Z", "2026-06-01T12:00:00Z", { issue: 1 });
  addReadyRun(files, "302-2026-06-02T00-00-00-000Z", "2026-06-02T12:00:00Z", { issue: 2 });
  addReadyRun(files, "303-2026-06-03T00-00-00-000Z", "2026-06-03T12:00:00Z", { issue: 3 });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-04T00:00:00Z", bucket: "day" },
    memDeps(files),
  );

  assert.equal(report.bucket, "day");
  assert.equal(report.series?.length, 3);
  const series = report.series!;
  assert.equal(series[0].start, "2026-06-01T00:00:00.000Z");
  assert.equal(series[1].start, "2026-06-02T00:00:00.000Z");
  assert.equal(series[2].start, "2026-06-03T00:00:00.000Z");
  assert.equal(series[2].end, "2026-06-04T00:00:00.000Z");
  for (let i = 0; i < series.length - 1; i++) {
    assert.equal(series[i].end, series[i + 1].start, `entry ${i}'s end must equal entry ${i + 1}'s start`);
  }
});

test("buildScoreboardReport: week buckets align to Monday 00:00 UTC and clip to window bounds (#425)", async () => {
  const files: Record<string, string> = {};
  const report = await buildScoreboardReport(
    // 2026-06-03 is a Wednesday.
    { repoDir: REPO_DIR, since: "2026-06-03T00:00:00Z", until: "2026-06-17T00:00:00Z", bucket: "week" },
    memDeps(files),
  );

  assert.equal(report.bucket, "week");
  const series = report.series!;
  assert.equal(series[0].start, "2026-06-03T00:00:00.000Z", "first entry start clips to window.since");
  assert.equal(series[0].end, "2026-06-08T00:00:00.000Z", "first entry end aligns to the following Monday");
  assert.equal(series[series.length - 1].end, "2026-06-17T00:00:00.000Z", "last entry end clips to window.until");
  for (const entry of series.slice(1, -1)) {
    assert.equal(new Date(entry.start).getUTCDay(), 1, "interior entries start on a Monday");
    assert.equal(new Date(entry.end).getUTCDay(), 1, "interior entries end on a Monday");
  }
});

test("buildScoreboardReport: a run on a period boundary is counted once, in the later period (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-02T00-00-00-000Z", "2026-06-02T00:00:00Z", { issue: 1 });
  addReadyRun(files, "302-2026-06-03T00-00-00-000Z", "2026-06-03T00:00:00Z", { issue: 2 });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-03T00:00:00Z", bucket: "day" },
    memDeps(files),
  );

  const series = report.series!;
  assert.equal(series.length, 2);
  assert.equal(series[0].totals.included_runs, 0, "boundary-hitting run belongs to the later period, not this one");
  assert.equal(series[1].totals.included_runs, 2, "the run at `until` also lands in the final period");
  const sum = series.reduce((total, period) => total + period.totals.included_runs, 0);
  assert.equal(sum, report.totals.included_runs);
});

test("buildScoreboardReport: sum of series included_runs equals the window total (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-01T00-00-00-000Z", "2026-06-01T05:00:00Z", { issue: 1 });
  addReadyRun(files, "302-2026-06-01T00-00-00-000Z", "2026-06-01T18:00:00Z", { issue: 2 });
  addReadyRun(files, "303-2026-06-03T00-00-00-000Z", "2026-06-03T05:00:00Z", { issue: 3 });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-04T00:00:00Z", bucket: "day" },
    memDeps(files),
  );

  const sum = report.series!.reduce((total, period) => total + period.totals.included_runs, 0);
  assert.equal(sum, report.totals.included_runs);
  assert.equal(report.totals.included_runs, 3);
});

test("buildScoreboardReport: an empty period reports zeroed totals and null ratios without throwing (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-01T00-00-00-000Z", "2026-06-01T05:00:00Z", { issue: 1 });
  addReadyRun(files, "303-2026-06-03T00-00-00-000Z", "2026-06-03T05:00:00Z", { issue: 3 });
  // No run on 2026-06-02.

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-04T00:00:00Z", bucket: "day" },
    memDeps(files),
  );

  const middle = report.series!.find((p) => p.start === "2026-06-02T00:00:00.000Z");
  assert.ok(middle, "the empty middle day must still appear in the series");
  assert.equal(middle!.totals.included_runs, 0);
  assert.equal(middle!.metrics.ready_to_deploy_without_human_intervention.ratio, null);
  assert.equal(middle!.metrics.full_run_duration_ms.avg_ms, null);
});

test("buildScoreboardReport: window totals/metrics/diagnostics are identical whether or not --bucket is supplied (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-01T00-00-00-000Z", "2026-06-01T05:00:00Z", { issue: 1 });
  addReadyRun(files, "302-2026-06-02T00-00-00-000Z", "2026-06-02T05:00:00Z", { issue: 2 });

  const opts = { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-04T00:00:00Z" };
  const withoutBucket = await buildScoreboardReport(opts, memDeps(files));
  const withBucket = await buildScoreboardReport({ ...opts, bucket: "week" }, memDeps(files));

  assert.deepEqual(withoutBucket.window, withBucket.window);
  assert.deepEqual(withoutBucket.totals, withBucket.totals);
  assert.deepEqual(withoutBucket.metrics, withBucket.metrics);
  assert.deepEqual(withoutBucket.diagnostics, withBucket.diagnostics);
  assert.equal(withoutBucket.bucket, undefined);
  assert.equal(withoutBucket.series, undefined);
});

test("buildScoreboardReport: omitting --bucket produces no bucket/series keys (#425)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, now: new Date("2026-06-28T00:00:00Z") },
    { ...memDeps(), readdir: async () => { throw enoent(runsDir(REPO_DIR)); } },
  );
  assert.ok(!("bucket" in report));
  assert.ok(!("series" in report));
});

test("buildScoreboardReport: an unsupported --bucket value throws before scanning artifacts (#425)", async () => {
  const deps = memDeps();
  await assert.rejects(
    () => buildScoreboardReport({ repoDir: REPO_DIR, bucket: "month" }, deps),
    /--bucket must be one of: day, week/,
  );
  assert.deepEqual(deps.reads, [], "an invalid --bucket must fail before any artifact read");
});

test("formatScoreboardHuman: renders one labelled per-period group in chronological order, including empty periods (#425)", async () => {
  const files: Record<string, string> = {};
  addReadyRun(files, "301-2026-06-01T00-00-00-000Z", "2026-06-01T05:00:00Z", { issue: 1 });
  addReadyRun(files, "303-2026-06-03T00-00-00-000Z", "2026-06-03T05:00:00Z", { issue: 3 });

  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-04T00:00:00Z", bucket: "day" },
    memDeps(files),
  );
  const output = formatScoreboardHuman(report);

  const idx1 = output.indexOf("2026-06-01T00:00:00.000Z");
  const idx2 = output.indexOf("2026-06-02T00:00:00.000Z");
  const idx3 = output.indexOf("2026-06-03T00:00:00.000Z");
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2, "periods must render in chronological order, including the empty one");
  assert.match(output, /Per-period breakdown \(day\):/);
});

test("formatScoreboardHuman: no per-period section renders when --bucket is omitted (#425)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, now: new Date("2026-06-28T00:00:00Z") },
    { ...memDeps(), readdir: async () => { throw enoent(runsDir(REPO_DIR)); } },
  );
  const output = formatScoreboardHuman(report);
  assert.ok(!output.includes("Per-period breakdown"));
});

test("CLI: pipeline scoreboard --bucket day --json emits a parseable series (#425)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-bucket-json-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--bucket", "day", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.bucket, "day");
    assert.ok(Array.isArray(parsed.series));
    for (const entry of parsed.series) {
      assert.ok("start" in entry && "end" in entry && "totals" in entry && "metrics" in entry);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --bucket month fails clearly with no partial output (#425)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-bucket-bad-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--bucket", "month", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /day/);
    assert.match(result.stderr, /week/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --by harness|model|effort|executor grouping (#437)
// ---------------------------------------------------------------------------

function groupingFixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  addRun(files, "437-2026-07-15T00-00-00-000Z", {
    runJson: { started_at: "2026-07-15T00:00:00Z", issue: 437 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-07-15T00:00:00Z", issue: 437, repo: "owner/repo" },
      {
        schema_version: 3, type: "stage_accounting", at: "2026-07-15T00:01:00Z",
        run_id: "437-2026-07-15T00-00-00-000Z", issue: 437, stage: "review-1",
        harness: "claude", model_slot: "review", model: "opus", effort: "high",
        started_at: "2026-07-15T00:00:10Z", ended_at: "2026-07-15T00:00:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "actual", cost_usd: 0.1,
      },
      {
        schema_version: 3, type: "stage_accounting", at: "2026-07-15T00:02:00Z",
        run_id: "437-2026-07-15T00-00-00-000Z", issue: 437, stage: "review-2",
        harness: "codex", model_slot: "review", model: "sonnet", effort: "low",
        started_at: "2026-07-15T00:01:10Z", ended_at: "2026-07-15T00:01:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "estimated", cost_usd: 0.05,
      },
      {
        // delegated stage with a recorded provider (#314)
        schema_version: 3, type: "stage_accounting", at: "2026-07-15T00:03:00Z",
        run_id: "437-2026-07-15T00-00-00-000Z", issue: 437, stage: "fix-1",
        harness: "my-executor", model_slot: "fix", model: null,
        executor_provider: "acme", executor_model: "acme-1",
        started_at: "2026-07-15T00:02:10Z", ended_at: "2026-07-15T00:02:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "actual", cost_usd: 0.2,
      },
      {
        // delegated stage with executor evidence but no recorded provider
        schema_version: 3, type: "stage_accounting", at: "2026-07-15T00:04:00Z",
        run_id: "437-2026-07-15T00-00-00-000Z", issue: 437, stage: "fix-2",
        harness: "my-executor-2", model_slot: "fix", model: null,
        executor_model: "modelX",
        started_at: "2026-07-15T00:03:10Z", ended_at: "2026-07-15T00:03:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "unknown", cost_usd: null,
      },
      {
        // local-harness stage with no model/effort/executor evidence at all
        schema_version: 3, type: "stage_accounting", at: "2026-07-15T00:05:00Z",
        run_id: "437-2026-07-15T00-00-00-000Z", issue: 437, stage: "planning",
        harness: "claude", model_slot: "planning", model: null,
        started_at: "2026-07-15T00:04:10Z", ended_at: "2026-07-15T00:04:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "unknown", cost_usd: null,
      },
      { schema_version: 1, type: "run_complete", at: "2026-07-15T00:10:00Z", final_state: "ready-to-deploy", elapsed_ms: 600000, pr: 437 },
    ],
    summaryRaw: "{not-json",
  });
  return files;
}

test("parseScoreboardGroupBy: null when absent, throws naming all four dimensions when unsupported, throws on repeat (#437)", () => {
  assert.equal(parseScoreboardGroupBy(undefined), null);
  assert.equal(parseScoreboardGroupBy([]), null);
  assert.equal(parseScoreboardGroupBy(["harness"]), "harness");
  assert.equal(parseScoreboardGroupBy(["model"]), "model");
  assert.equal(parseScoreboardGroupBy(["effort"]), "effort");
  assert.equal(parseScoreboardGroupBy(["executor"]), "executor");
  assert.throws(() => parseScoreboardGroupBy(["team"]), /harness.*model.*effort.*executor/s);
  assert.throws(() => parseScoreboardGroupBy(["harness", "model"]), /exactly one/);
});

test("resolveGroupIdentity: harness/model verbatim, effort/model unknown when absent, executor not-applicable vs unknown (#437)", () => {
  const base = { harness: "claude", model: "unknown", effort: "unknown", executor_provider: null, executor_model: null } as any;
  assert.equal(resolveGroupIdentity(base, "harness"), "claude");
  assert.equal(resolveGroupIdentity(base, "model"), "unknown");
  assert.equal(resolveGroupIdentity(base, "effort"), "unknown");
  assert.equal(resolveGroupIdentity(base, "executor"), "not applicable");
  assert.equal(resolveGroupIdentity({ ...base, executor_model: "modelX" }, "executor"), "unknown");
  assert.equal(resolveGroupIdentity({ ...base, executor_provider: "acme", executor_model: "acme-1" }, "executor"), "acme");
});

test("buildScoreboardReport: --by harness produces one group per distinct recorded harness (#437)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["harness"] },
    memDeps(groupingFixtureFiles()),
  );
  assert.equal(report.by, "harness");
  assert.ok(report.grouping);
  const keys = report.grouping!.groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ["claude", "codex", "my-executor", "my-executor-2"]);
  const claude = report.grouping!.groups.find((g) => g.key === "claude")!;
  assert.equal(claude.invocation_count, 2);
});

test("buildScoreboardReport: --by model, --by effort, --by executor share the same group entry shape (#437)", async () => {
  const files = groupingFixtureFiles();
  const dims = ["model", "effort", "executor"] as const;
  for (const by of dims) {
    const report = await buildScoreboardReport(
      { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: [by] },
      memDeps(files),
    );
    assert.equal(report.by, by);
    assert.ok(report.grouping);
    for (const group of report.grouping!.groups) {
      for (const field of [
        "key", "invocation_count", "total_duration_ms", "command_count", "subprocess_count",
        "actual_cost_usd", "estimated_cost_usd", "unknown_cost_count",
        "prompt_chars_total", "prompt_chars_max", "prompt_estimated_tokens_total",
        "actual_calls", "estimated_calls", "unknown_calls", "actual_coverage",
      ]) {
        assert.ok(field in group, `${by} group missing ${field}`);
      }
    }
  }
});

test("buildScoreboardReport: --by group sums conserve the window's cost_accounting totals (#437)", async () => {
  for (const by of ["harness", "model", "effort", "executor"] as const) {
    const report = await buildScoreboardReport(
      { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: [by] },
      memDeps(groupingFixtureFiles()),
    );
    const groups = report.grouping!.groups;
    const totalInvocations = groups.reduce((sum, g) => sum + g.invocation_count, 0);
    const totalActual = groups.reduce((sum, g) => sum + g.actual_cost_usd, 0);
    const totalEstimated = groups.reduce((sum, g) => sum + g.estimated_cost_usd, 0);
    assert.equal(totalInvocations, report.metrics.cost_accounting.totals.invocation_count, by);
    assert.equal(Math.round(totalActual * 10000), Math.round(report.metrics.cost_accounting.totals.actual_cost_usd * 10000), by);
    assert.equal(Math.round(totalEstimated * 10000), Math.round(report.metrics.cost_accounting.totals.estimated_cost_usd * 10000), by);
  }
});

test("buildScoreboardReport: a missing model groups as unknown rather than being coerced or dropped (#437)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["model"] },
    memDeps(groupingFixtureFiles()),
  );
  const unknown = report.grouping!.groups.find((g) => g.key === "unknown");
  assert.ok(unknown, "unknown group must be present");
  assert.equal(unknown!.invocation_count, 3);
  assert.ok(!report.grouping!.groups.some((g) => g.key === "opus" && g.invocation_count > 1));
});

test("buildScoreboardReport: --by executor separates not-applicable and unknown, both present (#437)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["executor"] },
    memDeps(groupingFixtureFiles()),
  );
  const notApplicable = report.grouping!.groups.find((g) => g.key === "not applicable");
  const unknown = report.grouping!.groups.find((g) => g.key === "unknown");
  assert.ok(notApplicable, "not applicable group must be present");
  assert.ok(unknown, "unknown group must be present");
  assert.equal(notApplicable!.invocation_count, 3);
  assert.equal(unknown!.invocation_count, 1);
  assert.notDeepEqual(notApplicable, unknown);
  const acme = report.grouping!.groups.find((g) => g.key === "acme");
  assert.ok(acme);
  assert.deepEqual(acme!.executor_models, ["acme-1"]);
});

test("buildScoreboardReport: harness and executor identities are not conflated for a delegated record (#437)", async () => {
  const files = groupingFixtureFiles();
  const byHarness = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["harness"] },
    memDeps(files),
  );
  const byExecutor = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["executor"] },
    memDeps(files),
  );
  assert.ok(byHarness.grouping!.groups.some((g) => g.key === "my-executor"));
  assert.ok(!byHarness.grouping!.groups.some((g) => g.key === "acme"));
  assert.ok(byExecutor.grouping!.groups.some((g) => g.key === "acme"));
  assert.ok(!byExecutor.grouping!.groups.some((g) => g.key === "my-executor"));
});

test("buildScoreboardReport: cost provenance is preserved per group, actual_coverage null at zero calls (#437)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["harness"] },
    memDeps(groupingFixtureFiles()),
  );
  const claude = report.grouping!.groups.find((g) => g.key === "claude")!;
  assert.equal(claude.actual_calls, 1);
  assert.equal(claude.unknown_calls, 1);
  assert.equal(claude.actual_coverage, 0.5);

  const codex = report.grouping!.groups.find((g) => g.key === "codex")!;
  assert.equal(codex.estimated_calls, 1);
  assert.equal(codex.actual_coverage, 0);
});

test("buildScoreboardReport: --by harness --bucket day conserves each period's totals (#437)", async () => {
  const report = await buildScoreboardReport(
    {
      repoDir: REPO_DIR, since: "2026-07-14T00:00:00Z", until: "2026-07-16T00:00:00Z",
      by: ["harness"], bucket: "day",
    },
    memDeps(groupingFixtureFiles()),
  );
  assert.ok(report.series && report.series.length > 0);
  for (const period of report.series!) {
    if (!period.grouping) continue;
    const sum = period.grouping.groups.reduce((s, g) => s + g.invocation_count, 0);
    assert.equal(sum, period.metrics.cost_accounting.totals.invocation_count);
  }
  const withRecords = report.series!.find((p) => p.totals.included_runs > 0);
  assert.ok(withRecords?.by === "harness");
  assert.ok(withRecords?.grouping);
});

test("buildScoreboardReport: omitting --by leaves JSON key set and values unchanged, no human grouping section (#437)", async () => {
  const files = groupingFixtureFiles();
  const withoutBy = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z" },
    memDeps(files),
  );
  assert.ok(!("by" in withoutBy));
  assert.ok(!("grouping" in withoutBy));
  const human = formatScoreboardHuman(withoutBy);
  assert.ok(!human.includes("Grouped by"));

  const withBy = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["harness"] },
    memDeps(files),
  );
  const { by: _by, grouping: _grouping, ...withoutByStripped } = withBy;
  assert.deepEqual(withoutByStripped, withoutBy);
});

test("formatScoreboardHuman: renders a grouping section with unknown and not applicable groups (#437)", async () => {
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["executor"] },
    memDeps(groupingFixtureFiles()),
  );
  const human = formatScoreboardHuman(report);
  assert.match(human, /Grouped by executor:/);
  assert.match(human, /not applicable:/);
  assert.match(human, /unknown:/);
  assert.match(human, /acme:/);
});

test("buildScoreboardReport: pre-#437 records without an effort field group as unknown under --by effort (#437)", async () => {
  const files: Record<string, string> = {};
  addRun(files, "437-2026-07-16T00-00-00-000Z", {
    runJson: { started_at: "2026-07-16T00:00:00Z", issue: 437 },
    events: [
      { schema_version: 1, type: "run_start", at: "2026-07-16T00:00:00Z", issue: 437, repo: "owner/repo" },
      {
        schema_version: 2, type: "stage_accounting", at: "2026-07-16T00:01:00Z",
        run_id: "437-2026-07-16T00-00-00-000Z", issue: 437, stage: "review-1",
        harness: "claude", model_slot: "review", model: "opus",
        started_at: "2026-07-16T00:00:10Z", ended_at: "2026-07-16T00:00:40Z",
        duration_ms: 30000, command_count: 1, subprocess_count: 1,
        outcome: "success", blocker_kind: null, cost_source: "actual", cost_usd: 0.1,
      },
      { schema_version: 1, type: "run_complete", at: "2026-07-16T00:10:00Z", final_state: "ready-to-deploy", elapsed_ms: 600000, pr: 437 },
    ],
    summaryRaw: "{not-json",
  });
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-07-01T00:00:00Z", until: "2026-07-31T00:00:00Z", by: ["effort"] },
    memDeps(files),
  );
  assert.deepEqual(report.grouping!.groups.map((g) => g.key), ["unknown"]);
});

test("CLI: pipeline scoreboard --by harness --json emits a grouping object (#437)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-by-json-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--by", "harness", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.by, "harness");
    assert.ok(Array.isArray(parsed.grouping.groups));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --by team fails clearly naming all four dimensions, no partial output (#437)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-by-bad-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--by", "team", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /harness/);
    assert.match(result.stderr, /model/);
    assert.match(result.stderr, /effort/);
    assert.match(result.stderr, /executor/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --help documents --by <dimension> (#437)", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /--by <dimension>/);
  assert.match(result.stdout, /harness\|model\|effort\|executor/);
});

test("CLI: pipeline scoreboard --by harness --by model fails with a repeated-flag error, no partial output (#437)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-by-repeat-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--by", "harness", "--by", "model", "--json", "--repo-path", repo],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --html self-contained offline export (#427)
// ---------------------------------------------------------------------------

function htmlFixtureReport(): ScoreboardReport {
  const metrics = {
    ready_to_deploy_without_human_intervention: { numerator: 3, denominator: 4, ratio: 0.75 },
    cost_per_ready_pr_usd: {
      value: 1.2345,
      denominator: 4,
      total_usd: 4.938,
      actual_usd: 3.0,
      estimated_usd: 1.938,
      actual_call_count: 10,
      estimated_call_count: 2,
      missing_call_count: 0,
    },
    cost_accounting: {
      totals: {
        invocation_count: 12,
        total_duration_ms: 65000,
        command_count: 20,
        subprocess_count: 5,
        actual_cost_usd: 3.0,
        estimated_cost_usd: 1.938,
        unknown_cost_count: 0,
        prompt_chars_total: 5000,
        prompt_chars_max: 900,
        prompt_estimated_tokens_total: 1250,
      },
      groups: [
        {
          issue: 42,
          stage: "review<script>",
          harness: "claude&code",
          model_slot: 'primary"slot',
          model: "sonnet'5",
          outcome: "success",
          invocation_count: 6,
          total_duration_ms: 30000,
          command_count: 10,
          subprocess_count: 2,
          actual_cost_usd: 1.5,
          estimated_cost_usd: 0,
          unknown_cost_count: 0,
          prompt_chars_total: 2500,
          prompt_chars_max: 500,
          prompt_estimated_tokens_total: 600,
        },
      ],
      coverage: { actual_calls: 10, estimated_calls: 2, unknown_calls: 0, actual_coverage: 0.8333 },
    },
    full_run_duration_ms: { count: 4, total_ms: 240000, min_ms: 30000, max_ms: 90000, avg_ms: 60000 },
    stage_duration_ms: {
      "planning<x>": { count: 4, total_ms: 40000, min_ms: 5000, max_ms: 15000, avg_ms: 10000 },
      review: { count: 0, total_ms: 0, min_ms: null, max_ms: null, avg_ms: null },
    },
    harness_calls_per_successful_pr: { numerator: 16, denominator: 4, ratio: 4 },
    retry_fix_rounds_per_pr: { numerator: 0, denominator: 0, ratio: null },
    blocker_rate_by_kind: {
      denominator: 8,
      counts: { "needs-review&approve": 2, 'manual"gate': 1 },
      rates: {
        "needs-review&approve": { numerator: 2, denominator: 8, ratio: 0.25 },
        'manual"gate': { numerator: 1, denominator: 8, ratio: 0.125 },
      },
    },
    needs_human_rate: { numerator: 1, denominator: 8, ratio: 0.125 },
    same_harness_fallback_rate: { numerator: 0, denominator: 0, ratio: null },
    gate_pass_rates: {
      test: { pass_rate: { numerator: 4, denominator: 4, ratio: 1 }, passed: 4, failed: 0, skipped: 0 },
      eval: { pass_rate: { numerator: 0, denominator: 0, ratio: null }, passed: 0, failed: 0, skipped: 4 },
      shipcheck: { pass_rate: { numerator: 3, denominator: 4, ratio: 0.75 }, passed: 3, failed: 1, skipped: 0 },
    },
  };

  return {
    schema_version: 1,
    window: { since: "2026-06-01T00:00:00.000Z", until: "2026-07-01T00:00:00.000Z", days: 30 },
    totals: { scanned_runs: 10, included_runs: 8, ready_runs: 5, successful_prs: 4, diagnostics: 1 },
    metrics,
    diagnostics: [
      {
        severity: "warning",
        code: "missing_pr_for_ready_run",
        path: "/runs/<abc>",
        message: `Run 'x' has "quotes" & <tags>`,
      },
    ],
    by: "harness",
    grouping: {
      groups: [
        {
          key: "claude&code",
          invocation_count: 12,
          total_duration_ms: 65000,
          command_count: 20,
          subprocess_count: 5,
          actual_cost_usd: 3.0,
          estimated_cost_usd: 1.938,
          unknown_cost_count: 0,
          prompt_chars_total: 5000,
          prompt_chars_max: 900,
          prompt_estimated_tokens_total: 1250,
          actual_calls: 10,
          estimated_calls: 2,
          unknown_calls: 0,
          actual_coverage: 0.8333,
        },
      ],
    },
    bucket: "week",
    series: [
      {
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-06-08T00:00:00.000Z",
        totals: { scanned_runs: 3, included_runs: 3, ready_runs: 2, successful_prs: 2, diagnostics: 0 },
        metrics,
      },
    ],
  };
}

test("escapeHtml: escapes all five HTML metacharacters (#427)", () => {
  assert.equal(escapeHtml(`<script>&"'</script>`), "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
});

test("renderScoreboardHtml: produces one complete document with no external resource references (#427)", () => {
  const html = renderScoreboardHtml(htmlFixtureReport());
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
  for (const forbidden of ["<script", "src=", "href=", "@import", "url(", "fetch(", "XMLHttpRequest", "http://", "https://", "//"]) {
    assert.equal(html.includes(forbidden), false, `found forbidden token: ${forbidden}`);
  }
  assert.match(html, /<style>/);
});

test("renderScoreboardHtml: metric values match formatScoreboardHuman output (#427)", () => {
  const report = htmlFixtureReport();
  const human = formatScoreboardHuman(report);
  const html = renderScoreboardHtml(report);
  const tokens = [
    "75.0% (3/4)",
    "$1.2345",
    "actual $3.0000",
    "estimated $1.9380",
    "avg 1m 0s",
    "4.00 (16/4)",
    "12.5% (1/8)",
    "100.0% (4/4)",
  ];
  for (const token of tokens) {
    assert.ok(human.includes(token), `test fixture bug: token missing from human output: ${token}`);
    assert.ok(html.includes(token), `value not found in html export: ${token}`);
  }
});

test("renderScoreboardHtml: null ratios and averages render as n/a, never 0 (#427)", () => {
  const html = renderScoreboardHtml(htmlFixtureReport());
  assert.ok(html.includes("n/a (0/0)"), "retry/fix-round and fallback rates must render n/a, not 0");
  assert.ok(html.includes("review: n/a"), "a stage with no provable duration must render n/a");
});

test("renderScoreboardHtml: run-derived strings are escaped and cannot inject markup (#427)", () => {
  const html = renderScoreboardHtml(htmlFixtureReport());
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("review<script>"), false);
  assert.ok(html.includes("review&lt;script&gt;"));
  assert.ok(html.includes("claude&amp;code"));
  assert.ok(html.includes("primary&quot;slot"));
  assert.ok(html.includes("sonnet&#39;5"));
  assert.ok(html.includes("needs-review&amp;approve"));
  assert.ok(html.includes("manual&quot;gate"));
  assert.ok(html.includes("planning&lt;x&gt;"));
  assert.ok(html.includes("/runs/&lt;abc&gt;"));
  assert.ok(html.includes("&#39;x&#39;"));
  assert.ok(html.includes("&quot;quotes&quot;"));
  assert.ok(html.includes("&lt;tags&gt;"));
});

test("renderScoreboardHtml: rendering the same report twice is byte-identical (#427)", () => {
  assert.equal(renderScoreboardHtml(htmlFixtureReport()), renderScoreboardHtml(htmlFixtureReport()));
});

test("runScoreboard: without --html the write seam is never invoked and stdout is unchanged (#427)", async () => {
  const logs: string[] = [];
  const deps: ScoreboardDeps = {
    readFile: async (p: string) => { throw enoent(p); },
    readdir: async () => { throw enoent(runsDir(REPO_DIR)); },
    log: (msg: string) => logs.push(msg),
    writeFile: async () => { throw new Error("writeFile must not be called without --html"); },
    rename: async () => { throw new Error("rename must not be called without --html"); },
    unlink: async () => { throw new Error("unlink must not be called without --html"); },
  };
  await runScoreboard({ repoDir: REPO_DIR }, deps);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /# pipeline scoreboard/);
});

test("runScoreboard: a failure after the write starts removes the temp file, writes nothing at the destination, and names the path (#427)", async () => {
  const written = new Map<string, string>();
  let unlinkedPath: string | null = null;
  const deps: ScoreboardDeps = {
    readFile: async (p: string) => { throw enoent(p); },
    readdir: async () => { throw enoent(runsDir(REPO_DIR)); },
    log: () => {},
    writeFile: async (p: string, content: string) => { written.set(p, content); },
    rename: async () => { throw new Error("EBOOM: simulated rename failure"); },
    unlink: async (p: string) => { unlinkedPath = p; written.delete(p); },
  };
  await assert.rejects(
    () => runScoreboard({ repoDir: REPO_DIR, html: "/out/report.html" }, deps),
    /cannot write HTML export to \/out\/report\.html/,
  );
  assert.ok(unlinkedPath, "the temp file must be removed on failure");
  assert.equal(written.has("/out/report.html"), false, "no bytes must land at the destination");
  assert.equal(written.size, 0, "the temp file must not remain either");
});

test("runScoreboard: a failure during the initial write removes the temp file and leaves an existing destination unchanged (#427)", async () => {
  const written = new Map<string, string>();
  written.set("/out/report.html", "pre-existing content");
  let unlinkedPath: string | null = null;
  const deps: ScoreboardDeps = {
    readFile: async (p: string) => { throw enoent(p); },
    readdir: async () => { throw enoent(runsDir(REPO_DIR)); },
    log: () => {},
    writeFile: async (p: string) => {
      written.set(p, "");
      throw new Error("EBOOM: simulated disk-full failure");
    },
    rename: async () => { throw new Error("rename must not be called when writeFile fails"); },
    unlink: async (p: string) => { unlinkedPath = p; written.delete(p); },
  };
  await assert.rejects(
    () => runScoreboard({ repoDir: REPO_DIR, html: "/out/report.html" }, deps),
    /cannot write HTML export to \/out\/report\.html/,
  );
  assert.ok(unlinkedPath, "the temp file must be removed when the initial write fails");
  assert.equal(written.get("/out/report.html"), "pre-existing content", "the existing destination must be left unchanged");
});

test("CLI: pipeline scoreboard --html writes one complete document and exits 0, touching nothing under .agent-pipeline/runs (#427)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-basic-"));
  try {
    const dest = path.join(repo, "report.html");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo, "--html", dest],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.ok(fs.existsSync(dest));
    const html = fs.readFileSync(dest, "utf8");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.equal(fs.existsSync(runsDir(repo)), false, "the export must never create the run store");
    assert.deepEqual(fs.readdirSync(repo).sort(), ["report.html"], "no other file may be created");
    // Stdout must still carry the normal human report.
    assert.match(result.stdout, /Report window:/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --html --json writes both the JSON to stdout and the HTML file (#427)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-json-"));
  try {
    const dest = path.join(repo, "report.html");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo, "--html", dest, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema_version, 1);
    assert.ok(fs.existsSync(dest));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --html composes with --bucket and --by (#427)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-compose-"));
  try {
    const dest = path.join(repo, "report.html");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard",
        "--repo-path", repo, "--html", dest, "--bucket", "day", "--by", "harness", "--days", "3",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const html = fs.readFileSync(dest, "utf8");
    assert.match(html, /Per-period breakdown \(day\)/);
    assert.match(html, /Grouped by harness/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --html fails clearly when the parent directory is missing, leaving no file behind (#427)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-badparent-"));
  try {
    const dest = path.join(repo, "missing-dir", "report.html");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo, "--html", dest],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot write HTML export/);
    assert.ok(result.stderr.includes(dest), "the error must name the destination path");
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(path.join(repo, "missing-dir")), false, "the missing parent must not be created");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: pipeline scoreboard --html fails clearly when the destination is an existing directory, leaving no temp file behind (#427)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-isdir-"));
  try {
    const dest = path.join(repo, "report.html");
    fs.mkdirSync(dest);
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo, "--html", dest],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot write HTML export/);
    assert.ok(result.stderr.includes(dest));
    assert.deepEqual(fs.readdirSync(repo).sort(), ["report.html"], "only the pre-existing directory may remain");
    assert.deepEqual(fs.readdirSync(dest), [], "no temp file may be left beside/under the destination");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

if (process.getuid && process.getuid() !== 0) {
  test("CLI: pipeline scoreboard --html fails clearly when the destination directory is unwritable, leaving no file behind (#427)", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scoreboard-html-unwritable-"));
    const targetDir = path.join(repo, "locked");
    fs.mkdirSync(targetDir);
    fs.chmodSync(targetDir, 0o500);
    try {
      const dest = path.join(targetDir, "report.html");
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--repo-path", repo, "--html", dest],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot write HTML export/);
      assert.ok(result.stderr.includes(dest));
      assert.equal(fs.existsSync(dest), false);
    } finally {
      fs.chmodSync(targetDir, 0o700);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("CLI: pipeline scoreboard --help documents --html <path> (#427)", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "scoreboard", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /--html <path>/);
});
