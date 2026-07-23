// Regression fixtures for #501 — repeat-correction / control-attribution
// recurrence metrics in `pipeline scoreboard`. Covers: falling recurrence
// after a deterministic-gate control, continued recurrence after a
// documentation-only (instruction) control, zero-exposure ->
// insufficient_post_control_evidence, duplicate correction_id delivery
// counted once, and control supersession/rollback re-measured from the new
// boundary. All I/O goes through an in-memory ScoreboardDeps fake — no real
// filesystem, network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildScoreboardReport,
  parseScoreboardCorrectionsBy,
  type ScoreboardDeps,
} from "../scripts/scoreboard.ts";
import { runsDir } from "../scripts/run-store.ts";
import { deriveCorrectionKey, controlAttributionsPath } from "../scripts/correction.ts";

const REPO_DIR = "/repo";

type MemDeps = Pick<ScoreboardDeps, "readFile" | "readdir"> & { files: Map<string, string>; reads: string[] };

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

function correctionEvent(overrides: Record<string, unknown> & { correction_id: string; correction_key: string }): Record<string, unknown> {
  return {
    schema_version: 1,
    type: "correction_event",
    at: "2026-06-01T00:00:00Z",
    source_kind: "override",
    failure_class: "review-finding",
    actor_kind: "human",
    issue: 1,
    repo: "owner/repo",
    run_id: "run",
    stage: "review-2",
    reviewed_sha: null,
    head_sha: null,
    evidence_ref: { kind: "finding", id: "f1" },
    correction: "fixed",
    reusable: "unknown",
    ...overrides,
  };
}

function addRun(
  files: Record<string, string>,
  runId: string,
  startedAt: string,
  events: Record<string, unknown>[],
): void {
  files[runPath(runId, "run.json")] = JSON.stringify({
    schema_version: 1,
    run_id: runId,
    issue: 1,
    repo: "owner/repo",
    profile: "codex",
    started_at: startedAt,
  });
  files[runPath(runId, "events.jsonl")] = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function stageEvents(stage: string, at: string): Record<string, unknown>[] {
  return [
    { schema_version: 1, type: "stage_start", at, stage },
    { schema_version: 1, type: "stage_complete", at, stage, outcome: "advanced" },
  ];
}

function attribution(overrides: Record<string, unknown> & { attribution_id: string; correction_key: string }): Record<string, unknown> {
  return {
    schema_version: 1,
    type: "control_attribution",
    at: "2026-06-02T00:00:00Z",
    control_type: "deterministic-gate",
    disposition: "implemented",
    issue: null,
    pr: null,
    effective_commit: null,
    effective_release: null,
    effective_at: "2026-06-02T00:00:00Z",
    supersedes: null,
    evidence_ref: { kind: "comment", id: "" },
    note: "",
    ...overrides,
  };
}

function ledgerContent(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const WINDOW_OPTS = { repoDir: REPO_DIR, days: 60, now: new Date("2026-07-15T00:00:00Z") };

// ---------------------------------------------------------------------------
// Totals: dedup, distinct classes, repeated-class rate, per-ready-item
// ---------------------------------------------------------------------------

test("corrections: total corrections dedup by correction_id, count distinct classes and repeated classes", async () => {
  const files: Record<string, string> = {};
  const keyA = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  const keyB = deriveCorrectionKey({ source_kind: "unblock", failure_class: "blocker", stage: "implementing" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: keyA }),
    // Replayed delivery of the same correction_id — must count once.
    correctionEvent({ correction_id: "a1", correction_key: keyA }),
    correctionEvent({ correction_id: "a2", correction_key: keyA, stage: "review-2" }),
    correctionEvent({ correction_id: "b1", correction_key: keyB, source_kind: "unblock", failure_class: "blocker", stage: "implementing" }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.equal(report.corrections?.total_corrections, 3, "a1 (deduped) + a2 + b1");
  assert.equal(report.corrections?.distinct_classes, 2);
  assert.equal(report.corrections?.repeated_class_count, 1, "only keyA has >=2 distinct corrections");
  assert.deepEqual(report.corrections?.repeated_class_rate, { numerator: 1, denominator: 2, ratio: 0.5 });
});

test("corrections: bucketed period totals dedup a replayed correction_id once window-wide, and sum to the window total (#501 review-1 bcf2f196)", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  // A replayed delivery of the same correction_id shows up in runs assigned
  // to two different day buckets — the window-level metric counts it once;
  // per-period totals must not each count it again.
  addRun(files, "run-day1", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "dup1", correction_key: key, run_id: "run-day1", at: "2026-06-01T00:00:00Z" }),
  ]);
  addRun(files, "run-day2", "2026-06-02T00:00:00Z", [
    correctionEvent({ correction_id: "dup1", correction_key: key, run_id: "run-day2", at: "2026-06-02T00:00:00Z" }),
    correctionEvent({ correction_id: "a2", correction_key: key, run_id: "run-day2", at: "2026-06-02T00:00:00Z" }),
  ]);
  const report = await buildScoreboardReport(
    { repoDir: REPO_DIR, since: "2026-06-01T00:00:00Z", until: "2026-06-03T00:00:00Z", bucket: "day" },
    memDeps(files),
  );
  assert.equal(report.corrections?.total_corrections, 2, "dup1 (deduped window-wide) + a2");
  const seriesSum = report.series!.reduce((sum, p) => sum + p.corrections!.total_corrections, 0);
  assert.equal(seriesSum, report.corrections?.total_corrections, "per-period totals sum to the window total");
});

test("corrections: corrections-per-ready-item uses the successful-PR denominator, null at zero PRs", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: key }),
  ]);
  const zeroPrReport = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.equal(zeroPrReport.totals.successful_prs, 0);
  assert.equal(zeroPrReport.corrections?.corrections_per_ready_item.ratio, null);
});

// ---------------------------------------------------------------------------
// Attribution + recurrence classification
// ---------------------------------------------------------------------------

test("corrections: recurrence falls to no_recurrence_observed after a deterministic-gate control", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    ...stageEvents("review-2", "2026-06-01T00:00:00Z"),
    correctionEvent({ correction_id: "a1", correction_key: key, at: "2026-06-01T00:00:00Z" }),
  ]);
  addRun(files, "1-2026-06-03T00-00-00-000Z", "2026-06-03T00:00:00Z", [
    ...stageEvents("review-2", "2026-06-03T00:00:00Z"),
    correctionEvent({ correction_id: "a2", correction_key: key, at: "2026-06-03T00:00:00Z" }),
  ]);
  // Post-control eligible run: exercises review-2 again, but emits no correction.
  addRun(files, "1-2026-06-05T00-00-00-000Z", "2026-06-05T00:00:00Z", stageEvents("review-2", "2026-06-05T00:00:00Z"));

  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-a",
      correction_key: key,
      control_type: "deterministic-gate",
      disposition: "implemented",
      at: "2026-06-04T00:00:00Z",
      effective_at: "2026-06-04T00:00:00Z",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.ok(cls, "class must be present");
  assert.equal(cls!.recurrence?.status, "no_recurrence_observed");
  assert.equal(cls!.recurrence?.eligible_post_control_runs, 1);
  assert.equal(cls!.recurrence?.attribution?.control_type, "deterministic-gate");
  assert.equal(cls!.recurrence?.time_to_control_ms, Date.parse("2026-06-04T00:00:00Z") - Date.parse("2026-06-01T00:00:00Z"));
});

test("corrections: a documentation-only (instruction) control that keeps recurring is classified recurred, not reported as fixed", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "unblock", failure_class: "blocker", stage: "implementing" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    ...stageEvents("implementing", "2026-06-01T00:00:00Z"),
    correctionEvent({
      correction_id: "b1", correction_key: key, source_kind: "unblock", failure_class: "blocker",
      stage: "implementing", at: "2026-06-01T00:00:00Z",
    }),
  ]);
  // Post-control eligible run still emits the same correction class.
  addRun(files, "1-2026-06-03T00-00-00-000Z", "2026-06-03T00:00:00Z", [
    ...stageEvents("implementing", "2026-06-03T00:00:00Z"),
    correctionEvent({
      correction_id: "b2", correction_key: key, source_kind: "unblock", failure_class: "blocker",
      stage: "implementing", at: "2026-06-03T00:00:00Z",
    }),
  ]);

  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-b",
      correction_key: key,
      control_type: "instruction",
      disposition: "implemented",
      at: "2026-06-02T00:00:00Z",
      effective_at: "2026-06-02T00:00:00Z",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence?.status, "recurred");
  assert.equal(cls!.recurrence?.recurrence_evidence.length, 1);
  assert.equal(cls!.recurrence?.recurrence_evidence[0].correction_id, "b2");
});

test("corrections: zero post-control exposure classifies insufficient_post_control_evidence, never no_recurrence_observed", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "repair", failure_class: "harness-crash", stage: "planning" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    ...stageEvents("planning", "2026-06-01T00:00:00Z"),
    correctionEvent({
      correction_id: "c1", correction_key: key, source_kind: "repair", failure_class: "harness-crash",
      stage: "planning", at: "2026-06-01T00:00:00Z",
    }),
  ]);

  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-c",
      correction_key: key,
      control_type: "eval",
      disposition: "implemented",
      at: "2026-06-10T00:00:00Z",
      effective_at: "2026-06-10T00:00:00Z",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence?.eligible_post_control_runs, 0);
  assert.equal(cls!.recurrence?.status, "insufficient_post_control_evidence");
});

test("corrections: control supersession is re-measured from the new boundary, and the superseded control is still surfaced", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "rejection", failure_class: "spec-defect", stage: "review-1" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    ...stageEvents("review-1", "2026-06-01T00:00:00Z"),
    correctionEvent({
      correction_id: "e1", correction_key: key, source_kind: "rejection", failure_class: "spec-defect",
      stage: "review-1", at: "2026-06-01T00:00:00Z",
    }),
  ]);
  // Eligible only relative to B's boundary (after 06-05); no correction here.
  addRun(files, "1-2026-06-06T00-00-00-000Z", "2026-06-06T00:00:00Z", stageEvents("review-1", "2026-06-06T00:00:00Z"));

  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-e-a",
      correction_key: key,
      control_type: "deterministic-gate",
      disposition: "implemented",
      at: "2026-06-02T00:00:00Z",
      effective_at: "2026-06-02T00:00:00Z",
    }),
    attribution({
      attribution_id: "attr-e-b",
      correction_key: key,
      control_type: "eval",
      disposition: "implemented",
      at: "2026-06-05T00:00:00Z",
      effective_at: "2026-06-05T00:00:00Z",
      supersedes: "attr-e-a",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence?.attribution?.attribution_id, "attr-e-b");
  assert.equal(cls!.recurrence?.superseded.length, 1);
  assert.equal(cls!.recurrence?.superseded[0].attribution_id, "attr-e-a");
  assert.equal(
    cls!.recurrence?.time_to_control_ms,
    Date.parse("2026-06-05T00:00:00Z") - Date.parse("2026-06-01T00:00:00Z"),
    "time-to-control measures from first-seen to the ACTIVE (B's) effective_at, not A's",
  );
  assert.equal(cls!.recurrence?.status, "no_recurrence_observed", "only run after B's boundary is eligible, and it recurs nothing");
});

test("corrections: a rollback (rejected disposition superseding an implemented one) clears the active boundary but keeps the history visible", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "manual", failure_class: "other", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({
      correction_id: "r1", correction_key: key, source_kind: "manual", failure_class: "other",
      stage: "review-2", at: "2026-06-01T00:00:00Z",
    }),
  ]);
  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-r-a",
      correction_key: key,
      control_type: "deterministic-gate",
      disposition: "implemented",
      at: "2026-06-02T00:00:00Z",
      effective_at: "2026-06-02T00:00:00Z",
    }),
    attribution({
      attribution_id: "attr-r-b",
      correction_key: key,
      control_type: "deterministic-gate",
      disposition: "rejected",
      at: "2026-06-03T00:00:00Z",
      effective_at: null,
      supersedes: "attr-r-a",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence?.attribution, null, "rolled back — no active control");
  assert.equal(cls!.recurrence?.status, null);
  assert.equal(cls!.recurrence?.superseded.length, 1);
  assert.equal(cls!.recurrence?.superseded[0].attribution_id, "attr-r-a");
});

test("corrections: a replayed attribution append (same attribution_id) collapses to one canonical copy, not a false supersession (#501 review-1 1ea368e9)", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: key, at: "2026-06-01T00:00:00Z" }),
  ]);
  // Two appends of the SAME logical attribution (identical attribution_id,
  // as a crash-and-retry would produce) — a later append time must not read
  // as a new attribution superseding the earlier one, and the recurrence
  // boundary must stay pinned to the earliest valid append.
  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({
      attribution_id: "attr-replay",
      correction_key: key,
      disposition: "implemented",
      at: "2026-06-02T00:00:00Z",
      effective_at: "2026-06-02T00:00:00Z",
    }),
    attribution({
      attribution_id: "attr-replay",
      correction_key: key,
      disposition: "implemented",
      at: "2026-06-05T00:00:00Z",
      effective_at: "2026-06-05T00:00:00Z",
    }),
  ]);

  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence?.superseded.length, 0, "the replay must not surface as a superseded prior copy");
  assert.equal(cls!.recurrence?.attribution?.attribution_id, "attr-replay");
  assert.equal(cls!.recurrence?.attribution?.effective_at, "2026-06-02T00:00:00Z", "boundary pinned to the earliest valid append, not the retry's later one");
});

// ---------------------------------------------------------------------------
// --corrections-by grouping
// ---------------------------------------------------------------------------

test("parseScoreboardCorrectionsBy: null when absent, throws naming all dimensions when unsupported, throws on repeat", () => {
  assert.equal(parseScoreboardCorrectionsBy(undefined), null);
  assert.equal(parseScoreboardCorrectionsBy([]), null);
  assert.throws(() => parseScoreboardCorrectionsBy(["team"]), /repo, stage, harness, model, source_kind, failure_class, proposed_control, implemented_control/);
  assert.throws(() => parseScoreboardCorrectionsBy(["stage", "repo"]), /exactly one grouping dimension/);
  assert.equal(parseScoreboardCorrectionsBy(["failure_class"]), "failure_class");
});

test("corrections: --corrections-by failure_class produces one entry per distinct failure_class", async () => {
  const files: Record<string, string> = {};
  const keyA = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  const keyB = deriveCorrectionKey({ source_kind: "unblock", failure_class: "blocker", stage: "implementing" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: keyA, failure_class: "review-finding" }),
    correctionEvent({ correction_id: "b1", correction_key: keyB, source_kind: "unblock", failure_class: "blocker", stage: "implementing" }),
  ]);

  const report = await buildScoreboardReport({ ...WINDOW_OPTS, correctionsBy: ["failure_class"] }, memDeps(files));
  assert.equal(report.correctionsBy, "failure_class");
  assert.equal(report.correctionsGrouping?.groups.length, 2);
  const keys = report.correctionsGrouping?.groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ["blocker", "review-finding"]);
});

test("corrections: omitting --corrections-by leaves the JSON key set unchanged", async () => {
  const files: Record<string, string> = {};
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.equal(report.correctionsBy, undefined);
  assert.equal(report.correctionsGrouping, undefined);
  assert.ok(report.corrections, "corrections totals are always present");
});

test("CLI: pipeline scoreboard --corrections-by team fails naming supported dimensions, no partial output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scoreboard-corrections-by-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.resolve(import.meta.dirname, "../scripts/pipeline.ts"), "scoreboard", "--corrections-by", "team", "--json", "--repo-path", tmp],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repo, stage, harness, model, source_kind, failure_class, proposed_control, implemented_control/);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Diagnostics: malformed/orphan records are surfaced, not fatal
// ---------------------------------------------------------------------------

test("corrections: a malformed correction_event is surfaced as a diagnostic, not fatal", async () => {
  const files: Record<string, string> = {};
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    { schema_version: 1, type: "correction_event", at: "2026-06-01T00:00:00Z" }, // missing required fields
  ]);
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.ok(report.diagnostics.some((d) => d.code === "corrupt_correction_event"));
  assert.equal(report.corrections?.total_corrections, 0);
});

test("corrections: an unrecognized correction_event schema_version is surfaced with a distinct diagnostic code", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "z1", correction_key: key, schema_version: 2 }),
  ]);
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.ok(report.diagnostics.some((d) => d.code === "unknown_schema_version"));
});

test("corrections: a malformed control_attribution line is surfaced as a diagnostic, not fatal", async () => {
  const files: Record<string, string> = {};
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", []);
  files[controlAttributionsPath(REPO_DIR)] = "not json\n";
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.ok(report.diagnostics.some((d) => d.code === "corrupt_attribution"));
});

test("corrections: an attribution referencing an unknown correction_key is diagnosed as orphan_attribution", async () => {
  const files: Record<string, string> = {};
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", []);
  files[controlAttributionsPath(REPO_DIR)] = ledgerContent([
    attribution({ attribution_id: "orphan-1", correction_key: "no-such-class-key" }),
  ]);
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.ok(report.diagnostics.some((d) => d.code === "orphan_attribution"));
});

test("corrections: a missing attribution store reads as a valid empty state (no error)", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: key }),
  ]);
  const report = await buildScoreboardReport(WINDOW_OPTS, memDeps(files));
  assert.equal(report.diagnostics.some((d) => d.code === "corrupt_attribution"), false);
  const cls = report.corrections?.classes.find((c) => c.correction_key === key);
  assert.equal(cls!.recurrence, null, "unattributed class");
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

test("corrections: buildScoreboardReport never writes the attribution ledger or any run artifact", async () => {
  const files: Record<string, string> = {};
  const key = deriveCorrectionKey({ source_kind: "override", failure_class: "review-finding", stage: "review-2" });
  addRun(files, "1-2026-06-01T00-00-00-000Z", "2026-06-01T00:00:00Z", [
    correctionEvent({ correction_id: "a1", correction_key: key }),
  ]);
  const deps = memDeps(files);
  const before = new Map(deps.files);
  await buildScoreboardReport(WINDOW_OPTS, deps);
  assert.deepEqual(deps.files, before, "no file was created or modified");
});

test("no state-machine path writes a control_attribution — merge/deploy_ready/pre_merge never reference emitControlAttribution", () => {
  const scriptsDir = path.resolve(import.meta.dirname, "../scripts");
  for (const file of ["stages/merge.ts", "stages/deploy_ready.ts", "stages/pre_merge.ts"]) {
    const contents = fs.readFileSync(path.join(scriptsDir, file), "utf8");
    assert.ok(!contents.includes("emitControlAttribution"), `${file} must never call emitControlAttribution`);
  }
});
