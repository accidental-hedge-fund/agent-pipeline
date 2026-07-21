import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildScoreboardReport,
  formatScoreboardHuman,
  parseEstimateCosts,
  parseScoreboardWindow,
  type ScoreboardDeps,
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
