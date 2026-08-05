// #763: human-touch, discovery-channel, stratified, candidate-integrity collectors.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  buildScoreboardReport,
  formatScoreboardHuman,
  type ScoreboardDeps,
} from "../scripts/scoreboard.ts";
import { runsDir } from "../scripts/run-store.ts";
import {
  classifyHumanTouch,
  computeCandidateIntegrityMetrics,
  computeDiscoveryChannelBreakdown,
  computeEngineClassReleaseSeries,
  computeHumanTouchMetrics,
  computeStratifiedStabilizationMetrics,
  countTerminalEngineBlockers,
  type StabilizationRun,
} from "../scripts/scoreboard-stabilization.ts";
import { controlAttributionsPath } from "../scripts/correction.ts";
const FRG_TREND_LEDGER_REL = path.join(".agent-pipeline", "frg", "trend-ledger.jsonl");

const REPO = "/repo";

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function memDeps(files: Record<string, string>): Pick<ScoreboardDeps, "readFile" | "readdir"> {
  const map = new Map(Object.entries(files));
  return {
    readFile: async (p) => {
      if (!map.has(p)) throw enoent(p);
      return map.get(p)!;
    },
    readdir: async (p) => {
      if (p !== runsDir(REPO)) throw enoent(p);
      const prefix = `${p}${path.sep}`;
      const dirs = new Set<string>();
      for (const key of map.keys()) {
        if (!key.startsWith(prefix)) continue;
        const first = key.slice(prefix.length).split(path.sep)[0];
        if (first) dirs.add(first);
      }
      return [...dirs].sort().map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

function runPath(runId: string, file: string): string {
  return path.join(runsDir(REPO), runId, file);
}

function addRun(
  files: Record<string, string>,
  runId: string,
  opts: {
    issue: number;
    startedAt: string;
    finalState: string;
    events?: Record<string, unknown>[];
    engine?: Record<string, unknown>;
    pr?: number;
  },
): void {
  files[runPath(runId, "run.json")] = JSON.stringify({
    schema_version: 1,
    run_id: runId,
    issue: opts.issue,
    repo: "owner/repo",
    profile: "codex",
    started_at: opts.startedAt,
    ...(opts.engine ? { engine: opts.engine } : {}),
  });
  files[runPath(runId, "events.jsonl")] =
    (opts.events ?? []).map((e) => JSON.stringify(e)).join("\n") +
    (opts.events?.length ? "\n" : "");
  files[runPath(runId, "summary.json")] = JSON.stringify({
    schema_version: 1,
    runId,
    issue: opts.issue,
    pr: opts.pr ?? 100 + opts.issue,
    finalState: opts.finalState,
    finalizedAt: opts.startedAt,
  });
}

test("classifyHumanTouch maps override/unblock; ignores engine worktree remove", () => {
  assert.equal(
    classifyHumanTouch({ type: "human_intervention", kind: "human-risk-override" }),
    "override",
  );
  assert.equal(classifyHumanTouch({ type: "blocker_cleared" }), "unblock");
  assert.equal(
    classifyHumanTouch({ type: "worktree_removed", source: "manual" }),
    "manual_worktree_remove",
  );
  assert.equal(classifyHumanTouch({ type: "worktree_removed" }), null);
  assert.equal(
    classifyHumanTouch({ type: "human_intervention", kind: "needs-human" }),
    null,
  );
});

test("human-touch rates: per-attempted and per-R2D denominators; zero denom null", () => {
  const runs: StabilizationRun[] = [
    {
      runId: "a",
      dir: "/a",
      runJson: { engine: { version: "1.0.0" } },
      events: [
        { type: "human_intervention", kind: "human-risk-override", at: "2026-06-10T00:00:00Z" },
        { type: "blocker_cleared", at: "2026-06-10T00:10:00Z" },
        { type: "human_intervention", kind: "human-risk-override", at: "2026-06-10T00:16:00Z" },
      ],
      summary: { finalState: "ready-to-deploy" },
      startAt: "2026-06-10T00:00:00Z",
      issue: 1,
      pr: 101,
      finalState: "ready-to-deploy",
    },
    {
      runId: "b",
      dir: "/b",
      runJson: { engine: { version: "1.0.0" } },
      events: [],
      summary: { finalState: "needs-human" },
      startAt: "2026-06-10T01:00:00Z",
      issue: 2,
      pr: null,
      finalState: "needs-human",
    },
  ];
  const m = computeHumanTouchMetrics(runs);
  assert.equal(m.total_touches, 3);
  assert.equal(m.human_touches_per_attempted_issue.numerator, 3);
  assert.equal(m.human_touches_per_attempted_issue.denominator, 2);
  assert.equal(m.human_touches_per_r2d_issue.numerator, 3);
  assert.equal(m.human_touches_per_r2d_issue.denominator, 1);
  // No labor-minutes field
  assert.equal("labor_minutes" in m, false);

  const empty = computeHumanTouchMetrics([]);
  assert.equal(empty.human_touches_per_attempted_issue.ratio, null);
  assert.equal(empty.human_touches_per_r2d_issue.ratio, null);
});

test("discovery-channel: papercut-autofile not folded into live-run; missing not live-run", () => {
  const runs: StabilizationRun[] = [
    {
      runId: "live",
      dir: "/l",
      runJson: { engine: { version: "1.0.0" } },
      events: [],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 1,
      pr: null,
      finalState: "ready-to-deploy",
    },
    {
      runId: "live2",
      dir: "/l2",
      runJson: { engine: { version: "1.0.0" } },
      events: [],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 2,
      pr: null,
      finalState: "ready-to-deploy",
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      runId: `pc-${i}`,
      dir: `/p${i}`,
      runJson: { discovery_channel: "papercut-autofile" },
      events: [{ type: "papercut", discovery_channel: "papercut-autofile" }],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 100 + i,
      pr: null,
      finalState: null,
    })),
    {
      runId: "hist",
      dir: "/h",
      runJson: null,
      events: [{ type: "blocker_set", reason: "x" }],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 999,
      pr: null,
      finalState: "needs-human",
    },
  ];
  const b = computeDiscoveryChannelBreakdown(runs);
  assert.equal(b.by_channel["live-run"], 2);
  assert.equal(b.by_channel["papercut-autofile"], 20); // 10 run-level + 10 events
  assert.ok(b.missing_attribution >= 1);
});

test("recovered same-run blocker is not terminal engine off-ramp (post-#787)", () => {
  const run: StabilizationRun = {
    runId: "r",
    dir: "/r",
    runJson: { engine: { version: "1.0.0" } },
    events: [
      { type: "stage_start", stage: "pre-merge", at: "t0" },
      {
        type: "blocker_set",
        stage: "pre-merge",
        blocker_kind: "harness-failure",
        at: "t1",
      },
      { type: "stage_start", stage: "pre-merge", at: "t2" },
      { type: "stage_complete", stage: "pre-merge", outcome: "ok", at: "t3" },
      { type: "run_complete", final_state: "ready-to-deploy", at: "t4" },
    ],
    summary: { finalState: "ready-to-deploy" },
    startAt: "2026-06-10T00:00:00Z",
    issue: 1,
    pr: 1,
    finalState: "ready-to-deploy",
  };
  assert.equal(countTerminalEngineBlockers(run), 0);

  const terminal: StabilizationRun = {
    ...run,
    finalState: "needs-human",
    events: [
      { type: "stage_start", stage: "pre-merge", at: "t0" },
      {
        type: "blocker_set",
        stage: "pre-merge",
        blocker_kind: "harness-failure",
        at: "t1",
      },
      { type: "run_complete", final_state: "needs-human", at: "t2" },
    ],
  };
  assert.equal(countTerminalEngineBlockers(terminal), 1);
});

test("engine blockers per 100 stage attempts", () => {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    events.push({ type: "stage_start", stage: i % 2 === 0 ? "fix" : "review" });
  }
  // two terminal engine blockers
  events.push({
    type: "blocker_set",
    stage: "fix",
    blocker_kind: "harness-failure",
  });
  events.push({
    type: "blocker_set",
    stage: "review",
    blocker_kind: "worktree-missing",
  });
  events.push({ type: "run_complete", final_state: "needs-human" });
  const run: StabilizationRun = {
    runId: "r",
    dir: "/r",
    runJson: {},
    events,
    summary: null,
    startAt: "2026-06-10T00:00:00Z",
    issue: 1,
    pr: null,
    finalState: "needs-human",
  };
  const { metrics } = computeStratifiedStabilizationMetrics([run]);
  assert.equal(metrics.stage_attempts, 50);
  assert.equal(metrics.engine_blocker_events, 2);
  assert.equal(metrics.engine_blockers_per_100_stage_attempts.numerator, 200);
  assert.equal(metrics.engine_blockers_per_100_stage_attempts.denominator, 50);
  assert.equal(metrics.engine_blockers_per_100_stage_attempts.ratio, 4);
});

test("candidate-integrity: scope expansion counted; absent yields zeros", () => {
  const empty = computeCandidateIntegrityMetrics([
    {
      runId: "r",
      dir: "/r",
      runJson: {},
      events: [],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 1,
      pr: null,
      finalState: "ready-to-deploy",
    },
  ]);
  assert.equal(empty.metrics.total_events, 0);
  assert.equal(empty.metrics.scope_expansion_invalidations, 0);
  assert.equal(empty.metrics.invalidation_rate.ratio, null);
  assert.ok(empty.diagnostics.some((d) => d.code === "missing_candidate_integrity_events"));

  const withEvents = computeCandidateIntegrityMetrics([
    {
      runId: "r2",
      dir: "/r2",
      runJson: { engine: { version: "1.31.0" } },
      events: [
        {
          type: "candidate_integrity",
          classification: "scope_expansion",
          mutation_method: "repair",
        },
        {
          type: "candidate_integrity",
          classification: "scope-expansion",
          mutation_method: "restack",
        },
      ],
      summary: null,
      startAt: "2026-06-10T00:00:00Z",
      issue: 2,
      pr: null,
      finalState: "ready-to-deploy",
    },
  ]);
  assert.equal(withEvents.metrics.scope_expansion_invalidations, 2);
  assert.equal(withEvents.metrics.candidate_moving_repairs, 1);
  assert.equal(withEvents.metrics.candidate_moving_restacks, 1);
});

test("FRG trend ledger populates release series; missing falls back with diagnostic", () => {
  const present = computeEngineClassReleaseSeries({
    frgTrendEntries: [
      {
        version: "v1.30.0",
        run_id: "r1",
        loop_run_id: null,
        pass: true,
        pack_id: "p",
        created_at: "2026-06-01T00:00:00Z",
        item_count: 4,
        ready_clean_count: 4,
        engine_class_count: 0,
        engine_class_rate: 0,
        thresholds: {
          max_engine_class_rate: 0.25,
          min_clean_ready_to_deploy: 2,
          capacity_stress_n: 2,
        },
      },
      {
        version: "v1.31.0",
        run_id: "r2",
        loop_run_id: null,
        pass: true,
        pack_id: "p",
        created_at: "2026-07-01T00:00:00Z",
        item_count: 4,
        ready_clean_count: 3,
        engine_class_count: 1,
        engine_class_rate: 0.25,
        thresholds: {
          max_engine_class_rate: 0.25,
          min_clean_ready_to_deploy: 2,
          capacity_stress_n: 2,
        },
      },
    ],
  });
  assert.equal(present.source, "frg_trend_ledger");
  assert.equal(present.entries.length, 2);
  assert.equal(present.entries.find((e) => e.version === "v1.31.0")?.engine_class_rate, 0.25);

  const missing = computeEngineClassReleaseSeries({ frgTrendEntries: null });
  assert.equal(missing.source, "empty");
  assert.ok(missing.diagnostics.some((d) => d.code === "frg_trend_ledger_missing"));
});

test("scoreboard --json exposes human-touch, escape-recurrence, discovery; human output labels", async () => {
  const files: Record<string, string> = {};
  addRun(files, "2026-06-10T00-00-00Z-aaa", {
    issue: 1,
    startedAt: "2026-06-10T00:00:00Z",
    finalState: "ready-to-deploy",
    pr: 101,
    engine: { version: "1.31.0", commit_sha: "abc123", root: "/x", templates_fingerprint: "f" },
    events: [
      {
        type: "human_intervention",
        kind: "human-risk-override",
        at: "2026-06-10T00:01:00Z",
        stage: "pre-merge",
        issue: 1,
        detail: "override",
        engine_version: "1.31.0",
        engine_commit_sha: "abc123",
        discovery_channel: "live-run",
      },
      {
        type: "blocker_set",
        stage: "pre-merge",
        blocker_kind: "worktree-missing",
        at: "2026-06-10T00:02:00Z",
      },
      { type: "blocker_cleared", at: "2026-06-10T00:03:00Z" },
      { type: "run_complete", final_state: "ready-to-deploy", at: "2026-06-10T00:04:00Z" },
    ],
  });
  addRun(files, "2026-06-10T01-00-00Z-bbb", {
    issue: 2,
    startedAt: "2026-06-10T01:00:00Z",
    finalState: "needs-human",
    engine: { version: "1.31.0", root: "/x", templates_fingerprint: "f" },
    events: [
      { type: "papercut", discovery_channel: "papercut-autofile", message: "friction" },
      { type: "run_complete", final_state: "needs-human", at: "2026-06-10T01:01:00Z" },
    ],
  });

  // control attribution establishing worktree fix boundary
  files[controlAttributionsPath(REPO)] =
    JSON.stringify({
      schema_version: 1,
      type: "control_attribution",
      at: "2026-05-01T00:00:00Z",
      attribution_id: "attr-worktree",
      correction_key: "worktree",
      control_type: "deterministic-gate",
      disposition: "implemented",
      note: "fix worktree",
      issue: 50,
      pr: 50,
      effective_commit: "deadbeef",
      effective_release: "v1.30.0",
      effective_at: "2026-05-01T00:00:00Z",
      supersedes: null,
      evidence_ref: { kind: "comment", id: "" },
    }) + "\n";

  // FRG trend ledger
  files[path.join(REPO, FRG_TREND_LEDGER_REL)] =
    JSON.stringify({
      version: "v1.31.0",
      run_id: "frg-1",
      loop_run_id: null,
      pass: true,
      pack_id: "p",
      created_at: "2026-06-01T00:00:00Z",
      item_count: 4,
      ready_clean_count: 4,
      engine_class_count: 0,
      engine_class_rate: 0,
      thresholds: {
        max_engine_class_rate: 0.25,
        min_clean_ready_to_deploy: 2,
        capacity_stress_n: 2,
      },
    }) + "\n";

  const report = await buildScoreboardReport(
    {
      repoDir: REPO,
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-30T00:00:00Z",
      json: true,
    },
    memDeps(files),
  );

  assert.equal(report.metrics.human_touches.total_touches, 2); // override + unblock
  assert.equal(report.metrics.human_touches.human_touches_per_attempted_issue.denominator, 2);
  assert.ok(report.metrics.escape_recurrence.classes_with_fix_boundary >= 1);
  assert.ok(
    report.metrics.escape_recurrence.by_key.some(
      (r) => r.class_key === "worktree" && r.has_fix_boundary,
    ),
  );
  assert.ok(report.metrics.discovery_channel.by_channel["papercut-autofile"] >= 1);
  assert.ok(report.metrics.discovery_channel.by_channel["live-run"] >= 1);
  assert.equal(report.metrics.candidate_integrity.total_events, 0);
  assert.ok(report.engine_class_release_series);
  assert.equal(report.engine_class_release_series!.source, "frg_trend_ledger");

  const human = formatScoreboardHuman(report);
  assert.match(human, /Human-touch rates/);
  assert.match(human, /Escape-recurrence/);
  assert.match(human, /Discovery-channel/);
  assert.match(human, /Candidate-integrity/);
  assert.doesNotMatch(human, /labor.?minutes/i);
});

test("bucketed periods recompute without changing full-window human-touch summary", async () => {
  const files: Record<string, string> = {};
  addRun(files, "2026-06-10T00-00-00Z-aaa", {
    issue: 1,
    startedAt: "2026-06-10T00:00:00Z",
    finalState: "ready-to-deploy",
    events: [
      {
        type: "human_intervention",
        kind: "human-risk-override",
        at: "2026-06-10T00:01:00Z",
        issue: 1,
        detail: "x",
        stage: null,
      },
    ],
    engine: { version: "1.0.0", root: "/x", templates_fingerprint: "f" },
  });
  addRun(files, "2026-06-18T00-00-00Z-bbb", {
    issue: 2,
    startedAt: "2026-06-18T00:00:00Z",
    finalState: "ready-to-deploy",
    events: [],
    engine: { version: "1.0.0", root: "/x", templates_fingerprint: "f" },
  });

  const baseOpts = {
    repoDir: REPO,
    since: "2026-06-01T00:00:00Z",
    until: "2026-06-30T00:00:00Z",
  };
  const full = await buildScoreboardReport(baseOpts, memDeps(files));
  const bucketed = await buildScoreboardReport(
    { ...baseOpts, bucket: "week" },
    memDeps(files),
  );
  assert.deepEqual(
    full.metrics.human_touches.human_touches_per_attempted_issue,
    bucketed.metrics.human_touches.human_touches_per_attempted_issue,
  );
  assert.deepEqual(
    full.metrics.escape_recurrence.ratio,
    bucketed.metrics.escape_recurrence.ratio,
  );
  assert.ok(bucketed.series && bucketed.series.length >= 1);
  // Period-local metrics exist
  assert.ok(bucketed.series![0].metrics.human_touches);
});
