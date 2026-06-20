// Unit tests for run-store (#155). All I/O goes through an in-memory RunStoreDeps
// fake — no real filesystem, network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  emitGhMetrics,
  finalizeRun,
  initRunDir,
  isValidSummaryBundle,
  latestSummaryForIssue,
  listRunIds,
  readEvents,
  runDirPath,
  runIdFor,
  runsDir,
  type RunEvent,
  type RunStoreDeps,
} from "../scripts/run-store.ts";
import type { EvidenceBundle } from "../scripts/types.ts";
import { GhMetricsCollector } from "../scripts/gh.ts";
import type { GhMetricsSummary } from "../scripts/gh.ts";

const REPO_DIR = "/tmp/test-repo";
const STATE_DIR = "/tmp/test-state";
const ISSUE = 155;
const STARTED_AT = "2026-06-16T21-11-35-000Z"; // filesystem-safe (hyphens + ms)
const STARTED_AT_ISO = "2026-06-16T21:11:35.000Z"; // ISO for Date parsing

// ---------------------------------------------------------------------------
// runIdFor / runsDir / runDirPath
// ---------------------------------------------------------------------------

test("runIdFor: produces <issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ> with milliseconds", () => {
  const d = new Date("2026-06-16T21:11:35.000Z");
  const id = runIdFor(ISSUE, d);
  assert.equal(id, "155-2026-06-16T21-11-35-000Z");
});

// Regression: two dispatches starting in the same second must produce different run directories.
// Prior to the ms-precision fix, runIdFor dropped milliseconds and both runs would share
// the same directory, causing mixed events and summary overwrites.
test("runIdFor: two dates in the same second with different ms produce distinct run-ids", () => {
  const d1 = new Date("2026-06-16T21:11:35.000Z");
  const d2 = new Date("2026-06-16T21:11:35.123Z");
  const id1 = runIdFor(ISSUE, d1);
  const id2 = runIdFor(ISSUE, d2);
  assert.notEqual(id1, id2, "same-second dispatches must get separate run directories");
  assert.equal(id1, "155-2026-06-16T21-11-35-000Z");
  assert.equal(id2, "155-2026-06-16T21-11-35-123Z");
});

test("runsDir: resolves to <repoDir>/.agent-pipeline/runs", () => {
  assert.equal(runsDir(REPO_DIR), path.join(REPO_DIR, ".agent-pipeline", "runs"));
});

test("runDirPath: resolves to <repoDir>/.agent-pipeline/runs/<runId>", () => {
  const id = runIdFor(ISSUE, new Date("2026-06-16T21:11:35Z"));
  assert.equal(
    runDirPath(REPO_DIR, id),
    path.join(REPO_DIR, ".agent-pipeline", "runs", id),
  );
});

// ---------------------------------------------------------------------------
// In-memory deps helper
// ---------------------------------------------------------------------------

function memRunStore() {
  const files = new Map<string, string>();
  const appends = new Map<string, string[]>();
  const mkdirs: string[] = [];
  const stdoutLines: string[] = [];

  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      // Combine initial write + subsequent appends
      const base = files.get(p) ?? "";
      const parts = appends.get(p) ?? [];
      if (!files.has(p) && parts.length === 0) throw enoent(p);
      return base + parts.join("");
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    appendFile: async (p, data) => {
      if (!appends.has(p)) appends.set(p, []);
      appends.get(p)!.push(data);
    },
    rename: async (from, to) => {
      // Support both files and appends
      const baseData = files.get(from) ?? "";
      const appendData = (appends.get(from) ?? []).join("");
      const combined = baseData + appendData;
      if (!files.has(from) && appends.get(from)?.length === 0) throw enoent(from);
      files.set(to, combined);
      files.delete(from);
      appends.delete(from);
    },
    mkdir: async (p) => {
      mkdirs.push(p);
    },
    readdir: async (p) => {
      const prefix = p + path.sep;
      const subdirs = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split(path.sep)[0];
          if (first) subdirs.add(first);
        }
      }
      return [...subdirs].map((name) => ({ name, isDirectory: () => true }));
    },
    stat: async (p) => {
      // Deterministic mtime for listRunIds ordering tests (directory names)
      if (p.includes("run-a")) return { mtime: new Date(2000) };
      if (p.includes("run-b")) return { mtime: new Date(1000) };
      // File existence check (used by initRunDir idempotency guard)
      if (!files.has(p)) throw enoent(p);
      return { mtime: new Date(0) };
    },
    stdoutWrite: (line) => {
      stdoutLines.push(line);
    },
  };

  function readFile(p: string): string {
    const base = files.get(p) ?? "";
    const parts = appends.get(p) ?? [];
    return base + parts.join("");
  }

  return { files, appends, mkdirs, stdoutLines, deps, readFile };
}

const RUN_DIR = path.join(REPO_DIR, ".agent-pipeline", "runs", `${ISSUE}-${STARTED_AT}`);
const EVENTS_JSONL = path.join(RUN_DIR, "events.jsonl");
const RUN_JSON = path.join(RUN_DIR, "run.json");

// ---------------------------------------------------------------------------
// 4.1 — initRunDir
// ---------------------------------------------------------------------------

test("initRunDir: creates run dir, writes run.json with all required fields, events.jsonl exists, run_start event present", async () => {
  const { deps, readFile } = memRunStore();

  const runId = `${ISSUE}-${STARTED_AT}`;
  await initRunDir(
    { runDir: RUN_DIR, runId, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO },
    deps,
  );

  // run.json
  const meta = JSON.parse(readFile(RUN_JSON));
  assert.equal(meta.schema_version, 1);
  assert.equal(meta.run_id, runId);
  assert.equal(meta.issue, ISSUE);
  assert.equal(meta.repo, "owner/repo");
  assert.equal(meta.profile, "codex");
  assert.equal(meta.started_at, STARTED_AT_ISO);

  // events.jsonl — has the run_start event
  const events = JSON.parse(readFile(EVENTS_JSONL).trim());
  assert.equal(events.schema_version, 1);
  assert.equal(events.type, "run_start");
  assert.equal(events.run_id, runId);
  assert.equal(events.issue, ISSUE);
  assert.equal(events.repo, "owner/repo");
});

test("initRunDir: creates an empty terminal.log up front so `logs --follow` has a file to tail (#155)", async () => {
  const { deps, appends } = memRunStore();
  const TERMINAL_LOG = path.join(RUN_DIR, "terminal.log");
  await initRunDir(
    { runDir: RUN_DIR, runId: `${ISSUE}-${STARTED_AT}`, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO },
    deps,
  );
  assert.ok(appends.has(TERMINAL_LOG), "initRunDir must create terminal.log up front (closes the --follow ENOENT window)");
});

test("initRunDir: non-fatal on I/O error (no throw)", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => { throw new Error("nope"); },
    writeFile: async () => { throw new Error("write failed"); },
    appendFile: async () => { throw new Error("nope"); },
    rename: async () => { throw new Error("nope"); },
    mkdir: async () => { throw new Error("mkdir failed"); },
    readdir: async () => [],
    stat: async () => { throw new Error("nope"); },
  };
  // Should not throw
  await initRunDir({ runDir: RUN_DIR, runId: "155-x", issue: ISSUE, repo: "r", profile: null, startedAt: STARTED_AT_ISO }, deps);
});

// Regression: calling initRunDir twice for the same run-id must not overwrite
// run.json or truncate events.jsonl — both are written-once / append-only.
test("initRunDir: second call with same run-id is idempotent (run.json and events.jsonl unchanged)", async () => {
  const { deps, readFile } = memRunStore();
  const runId = `${ISSUE}-${STARTED_AT}`;
  const opts = { runDir: RUN_DIR, runId, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO };

  // First call: initialize the run directory
  await initRunDir(opts, deps);
  const runJsonAfterFirst = readFile(RUN_JSON);
  const eventsAfterFirst = readFile(EVENTS_JSONL);

  // Second call: must leave both files completely unchanged
  await initRunDir(opts, deps);
  assert.equal(readFile(RUN_JSON), runJsonAfterFirst, "run.json must not be modified on second init");
  assert.equal(readFile(EVENTS_JSONL), eventsAfterFirst, "events.jsonl must not gain a second run_start on re-init");
});

// ---------------------------------------------------------------------------
// 4.2 — appendEvent
// ---------------------------------------------------------------------------

test("appendEvent: appends JSON line to events.jsonl", async () => {
  const { deps, readFile } = memRunStore();
  const event: RunEvent = { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps);
  const line = readFile(EVENTS_JSONL).trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, "stage_start");
  assert.equal(parsed.stage, "planning");
  assert.equal(parsed.schema_version, 1);
});

test("appendEvent: writes to stdoutWrite when set (--json-events mode)", async () => {
  const { deps, stdoutLines } = memRunStore();
  const event: RunEvent = { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: STARTED_AT_ISO, stage: "review-1", outcome: "advanced" };
  await appendEvent(RUN_DIR, event, deps);
  assert.equal(stdoutLines.length, 1);
  const parsed = JSON.parse(stdoutLines[0]);
  assert.equal(parsed.type, "stage_complete");
  assert.equal(parsed.outcome, "advanced");
});

test("appendEvent: I/O error is non-fatal (no throw, no stdout write)", async () => {
  const stdoutLines: string[] = [];
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
    stdoutWrite: (line) => stdoutLines.push(line),
  };
  const event: RunEvent = { schema_version: 1, type: "run_complete", at: STARTED_AT_ISO, final_state: "ready-to-deploy", elapsed_ms: 100 };
  await appendEvent(RUN_DIR, event, deps); // must not throw
  assert.equal(stdoutLines.length, 0, "stdout write must not happen when appendFile failed");
});

test("appendEvent: does NOT write to stdout when stdoutWrite is unset", async () => {
  const captured: string[] = [];
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
    // No stdoutWrite
  };
  const event: RunEvent = { schema_version: 1, type: "run_start", at: STARTED_AT_ISO, run_id: "x", issue: 1, repo: "r" };
  await appendEvent(RUN_DIR, event, deps);
  assert.equal(captured.length, 0);
});

// Regression: worktree_removed must appear in both events.jsonl and stdout in --json-events mode.
// Prior to fixing deploy_ready.finalize, it used defaultRunStoreDeps (no stdoutWrite), so the
// event was written to disk but never streamed to stdout, violating the --json-events contract.
test("appendEvent: worktree_removed event appears in both events.jsonl and stdout when stdoutWrite is set", async () => {
  const { deps, stdoutLines, readFile } = memRunStore();
  const event: RunEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "worktree_removed",
    at: STARTED_AT_ISO,
    _localPath: "/tmp/wt/155",
  };
  await appendEvent(RUN_DIR, event, deps);

  // Must be written to events.jsonl
  const fileContent = readFile(EVENTS_JSONL).trim();
  const parsed = JSON.parse(fileContent);
  assert.equal(parsed.type, "worktree_removed");
  assert.equal(parsed._localPath, "/tmp/wt/155");

  // Must also appear on stdout (--json-events mode)
  assert.equal(stdoutLines.length, 1, "worktree_removed must be streamed to stdout");
  assert.deepEqual(JSON.parse(stdoutLines[0]), parsed, "stdout line must be identical to file line");
});

// ---------------------------------------------------------------------------
// 4.3 — readEvents
// ---------------------------------------------------------------------------

test("readEvents: returns parsed events from well-formed file", async () => {
  const { deps, files } = memRunStore();
  const e1 = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  const e2 = { schema_version: 1, type: "stage_complete", at: STARTED_AT_ISO, stage: "planning", outcome: "advanced" };
  files.set(EVENTS_JSONL, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);

  const events = await readEvents(RUN_DIR, deps);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "stage_start");
  assert.equal(events[1].type, "stage_complete");
});

test("readEvents: skips partial/corrupt tail line", async () => {
  const { deps, files } = memRunStore();
  const e1 = { schema_version: 1, type: "run_start", at: STARTED_AT_ISO, run_id: "x", issue: 1, repo: "r" };
  files.set(EVENTS_JSONL, `${JSON.stringify(e1)}\n{broken`);

  const events = await readEvents(RUN_DIR, deps);
  assert.equal(events.length, 1, "corrupt tail line must be skipped");
  assert.equal(events[0].type, "run_start");
});

test("readEvents: returns [] when file is absent", async () => {
  const { deps } = memRunStore();
  // No file written — readFile will throw ENOENT
  const events = await readEvents(RUN_DIR, deps);
  assert.deepEqual(events, []);
});

test("readEvents: preserves unknown fields from future schema versions", async () => {
  const { deps, files } = memRunStore();
  const event = { schema_version: 2, type: "stage_start", at: STARTED_AT_ISO, stage: "planning", future_field: "keep-me" };
  files.set(EVENTS_JSONL, `${JSON.stringify(event)}\n`);

  const events = await readEvents(RUN_DIR, deps);
  assert.equal(events.length, 1);
  assert.equal((events[0] as Record<string, unknown>)["future_field"], "keep-me");
});

// ---------------------------------------------------------------------------
// 4.4 — finalizeRun
// ---------------------------------------------------------------------------

function makeBundle(finalState: string | null = "ready-to-deploy"): EvidenceBundle {
  return {
    schema_version: 1,
    schemaVersion: 1,
    runId: `${ISSUE}-${STARTED_AT}`,
    issue: ISSUE,
    pr: 42,
    branch: "pipeline/155-x",
    harnesses: ["codex"],
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState,
    finalizedAt: "2026-06-16T22:00:00Z",
    notifiedAt: null,
  };
}

test("finalizeRun: appends run_complete event with final_state and elapsed_ms", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const lines = readFile(EVENTS_JSONL).split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "at least one event must be appended");
  const complete = JSON.parse(lines[lines.length - 1]);
  assert.equal(complete.type, "run_complete");
  assert.equal(complete.final_state, "ready-to-deploy");
  assert.ok(typeof complete.elapsed_ms === "number", "elapsed_ms must be a number");
  assert.equal(complete.schema_version, 1);
});

test("finalizeRun: writes summary.json to run directory", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const summaryPath = path.join(RUN_DIR, "summary.json");
  const summary = JSON.parse(readFile(summaryPath));
  assert.equal(summary.issue, ISSUE);
  assert.equal(summary.finalState, "ready-to-deploy");
  assert.ok("schema_version" in summary);
});

// 4.7 — backward-compat regression test
test("finalizeRun: writes legacy evidence.json with same content as summary.json", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const summaryPath = path.join(RUN_DIR, "summary.json");
  const legacyPath = path.join(STATE_DIR, String(ISSUE), "evidence.json");

  const summary = JSON.parse(readFile(summaryPath));
  const legacy = JSON.parse(readFile(legacyPath));

  assert.deepEqual(summary, legacy, "legacy evidence.json must match summary.json");
});

test("finalizeRun: legacy evidence.json write failure is non-fatal", async () => {
  let legacyWriteCount = 0;
  const { deps: baseDeps, readFile } = memRunStore();
  const deps: RunStoreDeps = {
    ...baseDeps,
    mkdir: async (p) => {
      // Fail for the legacy path
      if (p.includes(STATE_DIR)) throw new Error("no permission");
    },
  };
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps); // must not throw

  // summary.json should still have been written
  const summaryPath = path.join(RUN_DIR, "summary.json");
  const summary = JSON.parse(readFile(summaryPath));
  assert.equal(summary.issue, ISSUE);
});

// ---------------------------------------------------------------------------
// 4.8 — schema_version in every event type
// ---------------------------------------------------------------------------

test("schema_version: all event types carry schema_version: 1", async () => {
  const { deps, readFile } = memRunStore();

  const events: RunEvent[] = [
    { schema_version: RUN_SCHEMA_VERSION, type: "run_start", at: STARTED_AT_ISO, run_id: "x", issue: 1, repo: "r" },
    { schema_version: RUN_SCHEMA_VERSION, type: "run_complete", at: STARTED_AT_ISO, final_state: "ready-to-deploy", elapsed_ms: 0 },
    { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" },
    { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: STARTED_AT_ISO, stage: "planning", outcome: "advanced" },
    { schema_version: RUN_SCHEMA_VERSION, type: "pr_created", at: STARTED_AT_ISO, pr: 42 },
    { schema_version: RUN_SCHEMA_VERSION, type: "pr_updated", at: STARTED_AT_ISO, pr: 42 },
    { schema_version: RUN_SCHEMA_VERSION, type: "worktree_created", at: STARTED_AT_ISO, _localPath: "/tmp/wt" },
    { schema_version: RUN_SCHEMA_VERSION, type: "worktree_removed", at: STARTED_AT_ISO, _localPath: "/tmp/wt" },
    { schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at: STARTED_AT_ISO, round: 1, sha: "abc", verdict: "approve", finding_counts: {} },
    { schema_version: RUN_SCHEMA_VERSION, type: "blocker_set", at: STARTED_AT_ISO, reason: "test" },
    { schema_version: RUN_SCHEMA_VERSION, type: "blocker_cleared", at: STARTED_AT_ISO },
  ];

  for (const event of events) {
    await appendEvent(RUN_DIR, event, deps);
  }

  const lines = readFile(EVENTS_JSONL).split("\n").filter(Boolean);
  assert.equal(lines.length, events.length);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.schema_version, 1, `Event ${parsed.type} must carry schema_version: 1`);
  }
});

// ---------------------------------------------------------------------------
// listRunIds
// ---------------------------------------------------------------------------

test("listRunIds: returns empty array when runs dir is absent", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
    stat: async () => ({ mtime: new Date() }),
  };
  const ids = await listRunIds(REPO_DIR, deps);
  assert.deepEqual(ids, []);
});

test("listRunIds: returns run-ids sorted by mtime descending", async () => {
  const dirs = [
    { name: "run-b", mtime: new Date(1000) },
    { name: "run-a", mtime: new Date(2000) },
  ];
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => dirs.map((d) => ({ name: d.name, isDirectory: () => true })),
    stat: async (p) => {
      const match = dirs.find((d) => p.endsWith(d.name));
      return { mtime: match?.mtime ?? new Date(0) };
    },
  };
  const ids = await listRunIds(REPO_DIR, deps);
  assert.deepEqual(ids, ["run-a", "run-b"], "run-a (newer mtime) should come first");
});

// ---------------------------------------------------------------------------
// emitGhMetrics (#257)
// ---------------------------------------------------------------------------

function makeGhMetrics(overrides: Partial<GhMetricsSummary> = {}): GhMetricsSummary {
  return {
    call_count: 3,
    total_ms: 150,
    p50_ms: 50,
    p95_ms: 100,
    slowest_calls: [
      { category: "pr create", elapsed_ms: 100 },
      { category: "issue view", elapsed_ms: 30 },
      { category: "label add", elapsed_ms: 20 },
    ],
    ...overrides,
  };
}

test("emitGhMetrics: appends a correctly structured gh_metrics_summary event line", async () => {
  const { deps, readFile } = memRunStore();
  const summary = makeGhMetrics();

  await emitGhMetrics(RUN_DIR, summary, deps);

  const line = readFile(EVENTS_JSONL).trim();
  const event = JSON.parse(line);
  assert.equal(event.type, "gh_metrics_summary");
  assert.equal(event.schema_version, 1);
  assert.equal(event.call_count, 3);
  assert.equal(event.total_ms, 150);
  assert.equal(event.p50_ms, 50);
  assert.equal(event.p95_ms, 100);
  assert.equal(event.slowest_calls.length, 3);
  assert.ok(typeof event.at === "string" && event.at.length > 0, "must have an at timestamp");
});

test("emitGhMetrics: I/O error from appendFile is caught and does not propagate", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
  };
  // Must not throw
  await emitGhMetrics(RUN_DIR, makeGhMetrics(), deps);
});

test("emitGhMetrics: event contains schema_version: 1 and no raw arg values", async () => {
  const { deps, readFile } = memRunStore();
  // slowest_calls have only category + elapsed_ms — no body/token fields
  const summary = makeGhMetrics({
    slowest_calls: [
      { category: "issue comment", elapsed_ms: 200 },
    ],
  });

  await emitGhMetrics(RUN_DIR, summary, deps);

  const event = JSON.parse(readFile(EVENTS_JSONL).trim());
  assert.equal(event.schema_version, 1);
  const entry = event.slowest_calls[0];
  assert.deepEqual(Object.keys(entry).sort(), ["category", "elapsed_ms"]);
  assert.equal(entry.category, "issue comment");
});

test("emitGhMetrics: zero-call summary emits event with call_count: 0 and empty slowest_calls", async () => {
  const { deps, readFile } = memRunStore();

  await emitGhMetrics(RUN_DIR, makeGhMetrics({ call_count: 0, total_ms: 0, p50_ms: 0, p95_ms: 0, slowest_calls: [] }), deps);

  const event = JSON.parse(readFile(EVENTS_JSONL).trim());
  assert.equal(event.call_count, 0);
  assert.equal(event.total_ms, 0);
  assert.deepEqual(event.slowest_calls, []);
});

// ---------------------------------------------------------------------------
// finalizeRun with ghMetrics (#257)
// ---------------------------------------------------------------------------

test("finalizeRun: gh_metrics_summary event appears before run_complete when ghMetrics provided", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps, makeGhMetrics());

  const lines = readFile(EVENTS_JSONL).split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "must have at least gh_metrics_summary + run_complete");
  const types = lines.map((l) => JSON.parse(l).type);
  const metricsIdx = types.indexOf("gh_metrics_summary");
  const completeIdx = types.indexOf("run_complete");
  assert.ok(metricsIdx >= 0, "gh_metrics_summary must appear in events.jsonl");
  assert.ok(completeIdx >= 0, "run_complete must appear in events.jsonl");
  assert.ok(metricsIdx < completeIdx, "gh_metrics_summary must precede run_complete");
});

test("finalizeRun: no gh_metrics_summary event when ghMetrics is omitted", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const lines = readFile(EVENTS_JSONL).split("\n").filter(Boolean);
  const types = lines.map((l) => JSON.parse(l).type);
  assert.ok(!types.includes("gh_metrics_summary"), "gh_metrics_summary must not appear when ghMetrics is omitted");
});

// Regression test for finding #1 in review-1 (#257): notification gh calls must be
// included in gh_metrics_summary. The fix emits metrics after notifyBundlePath so that
// getPrForIssue / postPrComment calls are captured in the collector before summary().
test("emitGhMetrics after finalizeRun: notification calls included in emitted summary", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();

  // Simulate the fixed dispatch ordering: finalizeRun (no metrics) → notification → emitGhMetrics
  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  // Simulate notification gh calls recorded by the active collector after finalizeRun
  const collector = new GhMetricsCollector();
  collector.record("pr view", 50); // simulates getPrForIssue
  collector.record("pr comment", 80); // simulates postPrComment

  await emitGhMetrics(RUN_DIR, collector.summary(), deps);

  const lines = readFile(EVENTS_JSONL).split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const completeIdx = events.findIndex((e: { type: string }) => e.type === "run_complete");
  const metricsIdx = events.findIndex((e: { type: string }) => e.type === "gh_metrics_summary");

  assert.ok(completeIdx >= 0, "run_complete must appear in events.jsonl");
  assert.ok(metricsIdx >= 0, "gh_metrics_summary must appear in events.jsonl");
  assert.ok(metricsIdx > completeIdx, "gh_metrics_summary must appear after run_complete (notification calls captured)");

  const metricsEvent = events[metricsIdx];
  assert.equal(metricsEvent.call_count, 2, "summary must reflect both notification gh calls");
});

// ---------------------------------------------------------------------------
// latestSummaryForIssue (#261)
// ---------------------------------------------------------------------------

function makeSummaryBundle(issue: number, runId: string): EvidenceBundle {
  return {
    schema_version: 1,
    schemaVersion: 1,
    runId,
    issue,
    pr: null,
    branch: null,
    harnesses: [],
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState: "ready-to-deploy",
    finalizedAt: null,
    notifiedAt: null,
  };
}

test("latestSummaryForIssue: returns null when runs dir is absent (#261)", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; },
    stat: async () => ({ mtime: new Date() }),
  };
  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.equal(result, null, "expected null when runs dir is absent");
});

test("latestSummaryForIssue: returns null when no run matches the issue prefix (#261)", async () => {
  const dirs = [{ name: "999-2026-06-20T10-00-00-000Z", isDirectory: () => true }];
  const deps: RunStoreDeps = {
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => dirs,
    stat: async () => ({ mtime: new Date(1000) }),
  };
  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.equal(result, null, "expected null when no run-id matches the issue prefix");
});

test("latestSummaryForIssue: returns bundle from the most-recent matching run (#261)", async () => {
  const id1 = `${ISSUE}-2026-06-20T09-00-00-000Z`;
  const id2 = `${ISSUE}-2026-06-20T10-00-00-000Z`; // newer
  const bundle1 = makeSummaryBundle(ISSUE, id1);
  const bundle2 = makeSummaryBundle(ISSUE, id2);
  const dir = path.join(REPO_DIR, ".agent-pipeline", "runs");

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      if (p === path.join(dir, id2, "summary.json")) return JSON.stringify(bundle2);
      if (p === path.join(dir, id1, "summary.json")) return JSON.stringify(bundle1);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [
      { name: id1, isDirectory: () => true },
      { name: id2, isDirectory: () => true },
    ],
    stat: async (p) => {
      // id2 is newer
      if (p.endsWith(id2)) return { mtime: new Date(2000) };
      if (p.endsWith(id1)) return { mtime: new Date(1000) };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null, "expected a bundle");
  assert.equal(result.runId, id2, "expected the most-recent run's bundle");
});

test("latestSummaryForIssue: skips corrupt summary.json and falls back to older run (#261)", async () => {
  const id1 = `${ISSUE}-2026-06-20T09-00-00-000Z`; // older, but valid
  const id2 = `${ISSUE}-2026-06-20T10-00-00-000Z`; // newer, but corrupt
  const bundle1 = makeSummaryBundle(ISSUE, id1);
  const dir = path.join(REPO_DIR, ".agent-pipeline", "runs");

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      if (p === path.join(dir, id2, "summary.json")) return "not-valid-json{{{";
      if (p === path.join(dir, id1, "summary.json")) return JSON.stringify(bundle1);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [
      { name: id1, isDirectory: () => true },
      { name: id2, isDirectory: () => true },
    ],
    stat: async (p) => {
      if (p.endsWith(id2)) return { mtime: new Date(2000) };
      if (p.endsWith(id1)) return { mtime: new Date(1000) };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null, "expected a bundle from the older valid run");
  assert.equal(result.runId, id1, "should fall back to the older valid run");
});

test("latestSummaryForIssue: returns null when all matching summaries are absent or corrupt (#261)", async () => {
  const id1 = `${ISSUE}-2026-06-20T10-00-00-000Z`;

  const deps: RunStoreDeps = {
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [{ name: id1, isDirectory: () => true }],
    stat: async () => ({ mtime: new Date(1000) }),
  };

  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.equal(result, null, "expected null when all matching summaries are absent");
});

test("latestSummaryForIssue: treats summary.json with missing required fields as absent (#261)", async () => {
  // {} is valid JSON but missing harnesses/stages/reviews/overrides/recoveries arrays.
  // It must be treated as absent so the legacy fallback can be reached.
  const id1 = `${ISSUE}-2026-06-20T09-00-00-000Z`; // older, valid
  const id2 = `${ISSUE}-2026-06-20T10-00-00-000Z`; // newer, but missing fields
  const bundle1 = makeSummaryBundle(ISSUE, id1);
  const dir = path.join(REPO_DIR, ".agent-pipeline", "runs");

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      if (p === path.join(dir, id2, "summary.json")) return "{}";
      if (p === path.join(dir, id1, "summary.json")) return JSON.stringify(bundle1);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [
      { name: id1, isDirectory: () => true },
      { name: id2, isDirectory: () => true },
    ],
    stat: async (p) => {
      if (p.endsWith(id2)) return { mtime: new Date(2000) };
      if (p.endsWith(id1)) return { mtime: new Date(1000) };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  const result = await latestSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null, "expected a bundle from the older valid run");
  assert.equal(result.runId, id1, "should skip the missing-fields entry and return the valid older run");
});

// ---------------------------------------------------------------------------
// isValidSummaryBundle (#261)
// ---------------------------------------------------------------------------

test("isValidSummaryBundle: returns true for a complete bundle (#261)", () => {
  const b = makeSummaryBundle(ISSUE, "run-1");
  assert.equal(isValidSummaryBundle(b), true);
});

test("isValidSummaryBundle: returns false for null (#261)", () => {
  assert.equal(isValidSummaryBundle(null), false);
});

test("isValidSummaryBundle: returns false for empty object (#261)", () => {
  assert.equal(isValidSummaryBundle({}), false);
});

test("isValidSummaryBundle: returns false when harnesses is missing (#261)", () => {
  const { harnesses, ...rest } = makeSummaryBundle(ISSUE, "run-1");
  void harnesses;
  assert.equal(isValidSummaryBundle(rest), false);
});

test("isValidSummaryBundle: returns false when stages is missing (#261)", () => {
  const { stages, ...rest } = makeSummaryBundle(ISSUE, "run-1");
  void stages;
  assert.equal(isValidSummaryBundle(rest), false);
});

test("isValidSummaryBundle: returns false when reviews is missing (#261)", () => {
  const { reviews, ...rest } = makeSummaryBundle(ISSUE, "run-1");
  void reviews;
  assert.equal(isValidSummaryBundle(rest), false);
});

// Regression tests for nested record validation (review-2 finding: stages:[{}] crashes formatSummary)
test("isValidSummaryBundle: returns false for stage entry missing required fields (#261)", () => {
  // {} passes the top-level array check but formatSummary crashes on s.commands iteration
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), stages: [{}] };
  assert.equal(isValidSummaryBundle(b), false, "stage missing stage+commands should be rejected");
});

test("isValidSummaryBundle: returns false for stage entry with stage but missing commands (#261)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), stages: [{ stage: "planning" }] };
  assert.equal(isValidSummaryBundle(b), false, "stage missing commands array should be rejected");
});

test("isValidSummaryBundle: returns true for stage entry with required fields present (#261)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), stages: [{ stage: "planning", outcome: null, commands: [], enteredAt: null, exitedAt: null, commits: [], prompts: [] }] };
  assert.equal(isValidSummaryBundle(b), true, "stage with required fields should be accepted");
});

test("isValidSummaryBundle: returns false for review entry missing required fields (#261)", () => {
  // {} passes the top-level array check but formatSummary crashes on r.findingCounts / r.sha
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), reviews: [{}] };
  assert.equal(isValidSummaryBundle(b), false, "review missing sha/verdict/round/findingCounts should be rejected");
});

test("isValidSummaryBundle: returns false for review entry missing sha (#261)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), reviews: [{ round: 1, verdict: "approved", findingCounts: {} }] };
  assert.equal(isValidSummaryBundle(b), false, "review missing sha should be rejected");
});

test("isValidSummaryBundle: returns true for review entry with required fields present (#261)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), reviews: [{ round: 1, sha: "abc1234", verdict: "approved", findingCounts: {} }] };
  assert.equal(isValidSummaryBundle(b), true, "review with required fields should be accepted");
});
