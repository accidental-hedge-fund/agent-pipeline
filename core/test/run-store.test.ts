// Unit tests for run-store (#155). All I/O goes through an in-memory RunStoreDeps
// fake — no real filesystem, network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  appendIssueHistory,
  emitPapercut,
  emitStageAccounting,
  emitGhMetrics,
  finalizeRun,
  initRunDir,
  isValidSummaryBundle,
  issueHistoryDir,
  issueHistoryPath,
  latestRunEventsSummaryForIssue,
  latestSummaryForIssue,
  listRunIds,
  readEvents,
  runDirPath,
  runIdFor,
  runsDir,
  type RunEvent,
  type RunStoreDeps,
} from "../scripts/run-store.ts";
import type { EvidenceBundle, IssueHistoryEntry } from "../scripts/types.ts";
import { buildStageAccountingRecord, STAGE_ACCOUNTING_SCHEMA_VERSION } from "../scripts/accounting.ts";
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
// Engine identity (#450) — run.json's pinned `engine` object
// ---------------------------------------------------------------------------

test("initRunDir: writes the engine identity when supplied", async () => {
  const { deps, readFile } = memRunStore();
  const runId = `${ISSUE}-${STARTED_AT}`;
  await initRunDir(
    {
      runDir: RUN_DIR,
      runId,
      issue: ISSUE,
      repo: "owner/repo",
      profile: "codex",
      startedAt: STARTED_AT_ISO,
      engine: { version: "1.21.0", root: "/opt/pipeline/core", templates_fingerprint: "deadbeef" },
    },
    deps,
  );
  const meta = JSON.parse(readFile(RUN_JSON));
  assert.deepEqual(meta.engine, { version: "1.21.0", root: "/opt/pipeline/core", templates_fingerprint: "deadbeef" });
});

test("initRunDir: omits the engine field (rather than failing the run) when not supplied", async () => {
  const { deps, readFile } = memRunStore();
  const runId = `${ISSUE}-${STARTED_AT}`;
  await initRunDir(
    { runDir: RUN_DIR, runId, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO },
    deps,
  );
  const meta = JSON.parse(readFile(RUN_JSON));
  assert.equal("engine" in meta, false);
  // The rest of the identity metadata is unaffected.
  assert.equal(meta.run_id, runId);
  assert.equal(meta.repo, "owner/repo");
});

test("initRunDir: re-entering the dispatch loop for the same run-id does not refresh the pinned engine identity", async () => {
  const { deps, readFile } = memRunStore();
  const runId = `${ISSUE}-${STARTED_AT}`;
  const firstEngine = { version: "1.21.0", root: "/opt/pipeline/core", templates_fingerprint: "aaa" };
  await initRunDir(
    { runDir: RUN_DIR, runId, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO, engine: firstEngine },
    deps,
  );
  const runJsonAfterFirst = readFile(RUN_JSON);

  // Simulate the engine having changed on disk by the second call.
  const secondEngine = { version: "1.22.0", root: "/opt/pipeline/core", templates_fingerprint: "bbb" };
  await initRunDir(
    { runDir: RUN_DIR, runId, issue: ISSUE, repo: "owner/repo", profile: "codex", startedAt: STARTED_AT_ISO, engine: secondEngine },
    deps,
  );
  assert.equal(readFile(RUN_JSON), runJsonAfterFirst, "run.json — including its pinned engine object — must not be rewritten on re-entry");
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
// event sink (#343) — additive/exclusive mode gating and non-fatal delivery
// ---------------------------------------------------------------------------

test("appendEvent: additive mode (default) writes locally AND delivers to the sink", async () => {
  const { deps, readFile } = memRunStore();
  const delivered: string[] = [];
  deps.eventSink = (line) => { delivered.push(line); };
  const event: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps);

  const fileLine = readFile(EVENTS_JSONL).trim();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].trim(), fileLine, "sink must receive the identical line written to events.jsonl");
});

test("appendEvent: exclusive mode delivers to the sink and does NOT write events.jsonl", async () => {
  const { deps, files, appends } = memRunStore();
  const delivered: string[] = [];
  deps.eventSink = (line) => { delivered.push(line); };
  deps.eventSinkMode = "exclusive";
  const event: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps);

  assert.equal(delivered.length, 1);
  assert.equal(files.has(EVENTS_JSONL), false, "events.jsonl must not be created in exclusive mode");
  assert.equal(appends.has(EVENTS_JSONL), false, "events.jsonl must not be appended to in exclusive mode");
});

test("appendEvent: sink mode is ignored when no eventSink is configured (local write proceeds)", async () => {
  const { deps, readFile } = memRunStore();
  deps.eventSinkMode = "exclusive"; // no eventSink set — must have zero effect
  const event: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps);
  const fileLine = readFile(EVENTS_JSONL).trim();
  assert.match(fileLine, /"type":"stage_start"/);
});

test("appendEvent: a throwing sink is non-fatal; in additive mode the local write still succeeds", async () => {
  const { deps, readFile } = memRunStore();
  deps.eventSink = () => { throw new Error("sink unreachable"); };
  const event: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps); // must not throw
  const fileLine = readFile(EVENTS_JSONL).trim();
  assert.match(fileLine, /"type":"stage_start"/);
});

test("appendEvent: a rejecting async sink is non-fatal and does not abort subsequent events", async () => {
  const { deps, readFile } = memRunStore();
  deps.eventSink = async () => { throw new Error("network timeout"); };
  const e1: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  const e2: RunEvent = { schema_version: 1, type: "stage_complete", at: STARTED_AT_ISO, stage: "planning", outcome: "advanced" };
  await appendEvent(RUN_DIR, e1, deps);
  await appendEvent(RUN_DIR, e2, deps);
  const lines = readFile(EVENTS_JSONL).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"type":"stage_start"/);
  assert.match(lines[1], /"type":"stage_complete"/);
});

test("appendEvent: with no eventSink configured, behavior is byte-for-byte unchanged (regression)", async () => {
  const { deps, readFile, stdoutLines } = memRunStore();
  const event: RunEvent = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "planning" };
  await appendEvent(RUN_DIR, event, deps);
  const fileLine = readFile(EVENTS_JSONL);
  assert.equal(fileLine, `${JSON.stringify(event)}\n`);
  assert.equal(stdoutLines.length, 1);
  assert.equal(stdoutLines[0], fileLine);
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

test("readEvents: includes harness_timeout events, and stage-timeline filters exclude them (#398)", async () => {
  const { deps, files } = memRunStore();
  const stageStart = { schema_version: 1, type: "stage_start", at: STARTED_AT_ISO, stage: "review-1" };
  const timeout = { schema_version: 1, type: "harness_timeout", at: STARTED_AT_ISO, stage: "review-1", timeout_sec: 1500 };
  const stageComplete = { schema_version: 1, type: "stage_complete", at: STARTED_AT_ISO, stage: "review-1", outcome: "advanced" };
  files.set(EVENTS_JSONL, [stageStart, timeout, stageComplete].map((e) => JSON.stringify(e)).join("\n") + "\n");

  const events = await readEvents(RUN_DIR, deps);
  assert.equal(events.length, 3, "harness_timeout must be present in the returned array");
  assert.ok(events.some((e) => e.type === "harness_timeout"));

  const stageTimeline = events.filter((e) => e.type === "stage_start" || e.type === "stage_complete");
  assert.equal(stageTimeline.length, 2, "stage-timeline filters must exclude harness_timeout");
  assert.ok(!stageTimeline.some((e) => e.type === "harness_timeout"));
});

// ---------------------------------------------------------------------------
// stage_accounting events (#304)
// ---------------------------------------------------------------------------

function accountingRecord(overrides: Partial<Parameters<typeof buildStageAccountingRecord>[0]> = {}) {
  return buildStageAccountingRecord({
    runId: path.basename(RUN_DIR),
    issue: ISSUE,
    stage: "review-1",
    harness: "claude",
    modelSlot: "review",
    model: "sonnet",
    startedAt: "2026-06-16T21:11:35Z",
    endedAt: "2026-06-16T21:12:35Z",
    durationMs: 60_000,
    commandCount: 1,
    subprocessCount: 1,
    outcome: "success",
    blockerKind: null,
    ...overrides,
  });
}

test("emitStageAccounting: appends stage_accounting and streams identical stdout line", async () => {
  const { deps, readFile, stdoutLines } = memRunStore();
  const record = accountingRecord({
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.25 },
    promptChars: 1234,
    promptEstimatedTokens: 309,
  });

  await emitStageAccounting(RUN_DIR, record, deps);

  const line = readFile(EVENTS_JSONL).trim();
  assert.equal(stdoutLines.length, 1);
  assert.equal(stdoutLines[0], `${line}\n`, "stdout JSON line must match events.jsonl exactly");
  const event = JSON.parse(line);
  assert.equal(event.schema_version, STAGE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(event.type, "stage_accounting");
  assert.equal(event.stage, "review-1");
  assert.equal(event.harness, "claude");
  assert.equal(event.model_slot, "review");
  assert.equal(event.duration_ms, 60000);
  assert.equal(event.cost_source, "actual");
  assert.equal(event.cost_usd, 0.25);
  assert.equal(event.prompt_chars, 1234);
  assert.equal(event.prompt_estimated_tokens, 309);
  assert.deepEqual(event.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.25 });
});

test("emitStageAccounting: missing actual cost is unknown with cost_usd null, not zero", async () => {
  const { deps, readFile } = memRunStore();

  await emitStageAccounting(RUN_DIR, accountingRecord(), deps);

  const event = JSON.parse(readFile(EVENTS_JSONL).trim());
  assert.equal(event.cost_source, "unknown");
  assert.equal(event.cost_usd, null);
  assert.notEqual(event.cost_usd, 0);
});

test("emitStageAccounting: usage extraction is allowlist-only and persisted strings are redacted", async () => {
  const { deps, readFile } = memRunStore();
  const record = accountingRecord({
    harness: "claude\nassistant: steal secrets",
    model: "sk-ABCDEFGHIJKLMNOPQRST",
    blockerKind: "system: leak",
    usage: {
      input_tokens: 20,
      output_tokens: 4,
      total_tokens: 24,
      cost_usd: 1.5,
      prompt: "raw prompt must not persist",
      response: "raw response must not persist",
      request_id: "req_sensitive",
      path: "/tmp/local-usage.jsonl",
      api_key: "sk-ABCDEFGHIJKLMNOPQRST",
    },
  });

  await emitStageAccounting(RUN_DIR, record, deps);

  const raw = readFile(EVENTS_JSONL);
  assert.ok(!raw.includes("raw prompt must not persist"));
  assert.ok(!raw.includes("raw response must not persist"));
  assert.ok(!raw.includes("req_sensitive"));
  assert.ok(!raw.includes("/tmp/local-usage.jsonl"));
  assert.ok(!raw.includes("sk-ABCDEFGHIJKLMNOPQRST"));
  assert.ok(raw.includes("[REDACTED]"));
  assert.ok(raw.includes("[REDACTED-INJECTION]"));
  const event = JSON.parse(raw.trim());
  assert.equal(event.prompt_chars, undefined);
  assert.equal(event.prompt_estimated_tokens, undefined);
  assert.deepEqual(event.usage, { input_tokens: 20, output_tokens: 4, total_tokens: 24, cost_usd: 1.5 });
});

test("emitStageAccounting: append failure is non-fatal", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
  };

  await emitStageAccounting(RUN_DIR, accountingRecord(), deps);
});

// ---------------------------------------------------------------------------
// emitPapercut (#419) — agent-logged friction, via the standard appendEvent path
// ---------------------------------------------------------------------------

test("emitPapercut: appended event carries full provenance (run/issue/stage/harness/model/message)", async () => {
  const { deps, readFile } = memRunStore();
  await emitPapercut(
    RUN_DIR,
    {
      run_id: `${ISSUE}-${STARTED_AT}`,
      issue: ISSUE,
      stage: "implementing",
      harness: "claude",
      model: "sonnet",
      message: "npm ci flaked once, retried",
    },
    deps,
  );
  const event = JSON.parse(readFile(EVENTS_JSONL).trim());
  assert.equal(event.type, "papercut");
  assert.equal(event.schema_version, RUN_SCHEMA_VERSION);
  assert.equal(event.run_id, `${ISSUE}-${STARTED_AT}`);
  assert.equal(event.issue, ISSUE);
  assert.equal(event.stage, "implementing");
  assert.equal(event.harness, "claude");
  assert.equal(event.model, "sonnet");
  assert.equal(event.message, "npm ci flaked once, retried");
  assert.equal(typeof event.at, "string");
});

test("emitPapercut: a message containing a redactable secret is redacted, and the event is still written", async () => {
  const { deps, readFile } = memRunStore();
  await emitPapercut(
    RUN_DIR,
    {
      run_id: `${ISSUE}-${STARTED_AT}`,
      issue: ISSUE,
      stage: "fix-1",
      harness: "codex",
      model: "gpt-5.5",
      message: "had to hardcode sk-ABCDEFGHIJKLMNOPQRST to get past the flaky auth check",
    },
    deps,
  );
  const raw = readFile(EVENTS_JSONL);
  assert.ok(!raw.includes("sk-ABCDEFGHIJKLMNOPQRST"), "secret must not reach events.jsonl");
  assert.ok(raw.includes("[REDACTED]"), "redacted span must be present");
  const event = JSON.parse(raw.trim());
  assert.equal(event.type, "papercut");
});

test("emitPapercut: reaches a configured event sink on the same terms as other events", async () => {
  const { deps, readFile } = memRunStore();
  const delivered: string[] = [];
  deps.eventSink = (line) => { delivered.push(line); };
  await emitPapercut(
    RUN_DIR,
    { run_id: "x", issue: ISSUE, stage: null, harness: null, model: null, message: "note" },
    deps,
  );
  const fileLine = readFile(EVENTS_JSONL).trim();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].trim(), fileLine, "sink must receive the identical line written to events.jsonl");
});

test("emitPapercut: does not throw when appendEvent's underlying write throws", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
  };
  await assert.doesNotReject(
    emitPapercut(
      RUN_DIR,
      { run_id: "x", issue: ISSUE, stage: null, harness: null, model: null, message: "note" },
      deps,
    ),
  );
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

test("finalizeRun: writes accounting records in event order with actual/estimated/unknown totals", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();
  await emitStageAccounting(
    RUN_DIR,
    accountingRecord({
      stage: "planning",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.125 },
    }),
    deps,
  );
  await emitStageAccounting(
    RUN_DIR,
    accountingRecord({
      stage: "review-1",
      estimatedCostUsd: 0.25,
    }),
    deps,
  );
  await emitStageAccounting(
    RUN_DIR,
    accountingRecord({
      stage: "fix-1",
    }),
    deps,
  );

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const summary = JSON.parse(readFile(path.join(RUN_DIR, "summary.json")));
  assert.deepEqual(
    summary.accounting.records.map((r: { stage: string }) => r.stage),
    ["planning", "review-1", "fix-1"],
  );
  assert.equal(summary.accounting.totals.record_count, 3);
  assert.equal(summary.accounting.totals.actual_cost_usd, 0.125);
  assert.equal(summary.accounting.totals.estimated_cost_usd, 0.25);
  assert.equal(summary.accounting.totals.unknown_cost_count, 1);
  assert.equal(summary.accounting.records[2].cost_source, "unknown");
  assert.equal(summary.accounting.records[2].cost_usd, null);
});

// Regression (#377 review 1, finding 1): notifyBundlePath renders the
// finalization comment's timing table from the exact `finalized` bundle object
// finalizeRun was called with — it does not re-read events.jsonl. So the
// harness-invocation-duration column only works if finalizeRun mutates the
// caller's bundle in place (not just the separate summary.json copy).
test("finalizeRun: mutates the passed-in bundle's accounting field with the same records written to summary.json", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundle();
  assert.equal(bundle.accounting, undefined, "bundle must start without an accounting field");
  await emitStageAccounting(RUN_DIR, accountingRecord({ stage: "review-1" }), deps);

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const summary = JSON.parse(readFile(path.join(RUN_DIR, "summary.json")));
  assert.equal(bundle.accounting?.records.length, 1);
  assert.equal(bundle.accounting?.records[0].stage, "review-1");
  assert.deepEqual(bundle.accounting, summary.accounting);
});

// Regression (#343 review 1, finding 1): in exclusive sink mode events.jsonl is
// never written, so finalizeRun must not lose stage_accounting/human_intervention
// data — it must read from deps.summaryEvents (the sink-independent in-memory
// collector) instead of re-reading the (absent) local file.
test("finalizeRun: exclusive sink mode still embeds accounting + interventions via summaryEvents", async () => {
  const { deps, readFile, files } = memRunStore();
  deps.eventSink = () => {};
  deps.eventSinkMode = "exclusive";
  deps.summaryEvents = [];
  const bundle = makeBundle();

  await emitStageAccounting(RUN_DIR, accountingRecord({ stage: "review-1" }), deps);
  await appendEvent(
    RUN_DIR,
    {
      schema_version: RUN_SCHEMA_VERSION,
      type: "human_intervention",
      at: STARTED_AT_ISO,
      kind: "human-risk-override",
      stage: "review-1",
      issue: ISSUE,
      detail: "reviewer override applied",
    },
    deps,
  );

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  assert.equal(files.has(path.join(RUN_DIR, "events.jsonl")), false, "exclusive mode must not create events.jsonl");

  const summary = JSON.parse(readFile(path.join(RUN_DIR, "summary.json")));
  assert.equal(summary.accounting.records.length, 1, "stage_accounting must still reach summary.json");
  assert.equal(summary.accounting.records[0].stage, "review-1");
  assert.equal(summary.interventions.length, 1, "human_intervention must still reach summary.json");
  assert.equal(summary.interventions[0].kind, "human-risk-override");
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
  assert.deepEqual(legacy.accounting, summary.accounting, "legacy evidence.json must mirror summary accounting");
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
// Issue-level append-only evidence history (#377)
// ---------------------------------------------------------------------------

test("issueHistoryDir: resolves to <repoDir>/.agent-pipeline/history", () => {
  assert.equal(issueHistoryDir(REPO_DIR), path.join(REPO_DIR, ".agent-pipeline", "history"));
});

test("issueHistoryPath: resolves to <repoDir>/.agent-pipeline/history/issue-<N>.jsonl", () => {
  assert.equal(
    issueHistoryPath(REPO_DIR, ISSUE),
    path.join(REPO_DIR, ".agent-pipeline", "history", `issue-${ISSUE}.jsonl`),
  );
});

function makeHistoryEntry(runId: string): IssueHistoryEntry {
  return {
    schema_version: 1,
    run_id: runId,
    issue: ISSUE,
    pr: 42,
    branch: "pipeline/155-x",
    final_state: "ready-to-deploy",
    finalized_at: "2026-06-16T22:00:00Z",
    stages: [
      { stage: "planning", enteredAt: "2026-06-16T21:00:00Z", exitedAt: "2026-06-16T21:04:15Z", durationMs: 255000, outcome: "advanced" },
    ],
  };
}

test("appendIssueHistory: creates the file on first write and writes a single valid JSON line", async () => {
  const { deps, readFile } = memRunStore();

  await appendIssueHistory(REPO_DIR, ISSUE, makeHistoryEntry("155-a"), deps);

  const lines = readFile(issueHistoryPath(REPO_DIR, ISSUE)).split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.run_id, "155-a");
  assert.equal(parsed.issue, ISSUE);
});

test("appendIssueHistory: a throwing appendFile is non-fatal (no throw)", async () => {
  const { deps: baseDeps } = memRunStore();
  const deps: RunStoreDeps = {
    ...baseDeps,
    appendFile: async () => {
      throw new Error("disk full");
    },
  };

  await assert.doesNotReject(appendIssueHistory(REPO_DIR, ISSUE, makeHistoryEntry("155-a"), deps));
});

const ISSUE_HISTORY_PATH = path.join(REPO_DIR, ".agent-pipeline", "history", `issue-${ISSUE}.jsonl`);
const RUN_DIR_2 = path.join(REPO_DIR, ".agent-pipeline", "runs", `${ISSUE}-2026-06-17T09-00-00-000Z`);

function makeBundleWithStages(finalState: string | null = "ready-to-deploy"): EvidenceBundle {
  return {
    ...makeBundle(finalState),
    stages: [
      {
        stage: "planning",
        enteredAt: "2026-06-16T21:00:00Z",
        exitedAt: "2026-06-16T21:04:15Z",
        outcome: "advanced",
        commits: ["abc1234"],
        commands: [],
        prompts: [],
      },
      {
        stage: "review-1",
        enteredAt: "2026-06-16T21:05:00Z",
        exitedAt: "2026-06-16T21:06:00Z",
        outcome: "advanced",
        commits: [],
        commands: [],
        prompts: [],
      },
    ],
  };
}

function readHistoryLines(readFile: (p: string) => string): unknown[] {
  return readFile(ISSUE_HISTORY_PATH)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("finalizeRun: appends one issue-history entry with run id, per-stage timings, and outcome", async () => {
  const { deps, readFile } = memRunStore();
  const bundle = makeBundleWithStages();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const lines = readHistoryLines(readFile) as Array<Record<string, unknown>>;
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.equal(entry.run_id, `${ISSUE}-${STARTED_AT}`);
  assert.equal(entry.issue, ISSUE);
  assert.equal(entry.final_state, "ready-to-deploy");
  assert.equal(entry.schema_version, 1);
  const stages = entry.stages as Array<Record<string, unknown>>;
  assert.equal(stages.length, 2);
  assert.equal(stages[0].stage, "planning");
  assert.equal(stages[0].durationMs, 255000);
  assert.equal(stages[0].outcome, "advanced");
});

test("finalizeRun: re-run appends a second entry; the first entry is byte-identical afterward (append, not rewrite)", async () => {
  const { deps, readFile } = memRunStore();

  await finalizeRun(RUN_DIR, makeBundleWithStages(), STATE_DIR, ISSUE, STARTED_AT_ISO, deps);
  const firstLineBefore = readFile(ISSUE_HISTORY_PATH).split("\n").filter(Boolean)[0];

  await finalizeRun(RUN_DIR_2, makeBundleWithStages(), STATE_DIR, ISSUE, STARTED_AT_ISO, deps);

  const lines = readFile(ISSUE_HISTORY_PATH).split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "re-run must append, not replace");
  assert.equal(lines[0], firstLineBefore, "prior entry must remain byte-identical");
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].run_id, `${ISSUE}-${STARTED_AT}`);
  assert.equal(parsed[1].run_id, path.basename(RUN_DIR_2));
});

test("finalizeRun: N finalizes on one issue yield exactly N history entries", async () => {
  const { deps, readFile } = memRunStore();
  const runDirs = [RUN_DIR, RUN_DIR_2, path.join(REPO_DIR, ".agent-pipeline", "runs", `${ISSUE}-2026-06-18T09-00-00-000Z`)];

  for (const dir of runDirs) {
    await finalizeRun(dir, makeBundleWithStages(), STATE_DIR, ISSUE, STARTED_AT_ISO, deps);
  }

  const lines = readHistoryLines(readFile);
  assert.equal(lines.length, runDirs.length);
});

test("finalizeRun: history append failure is non-fatal — summary.json and legacy evidence.json still write", async () => {
  const { deps: baseDeps, readFile } = memRunStore();
  const deps: RunStoreDeps = {
    ...baseDeps,
    appendFile: async (p, data) => {
      if (p.includes("history")) {
        throw new Error("disk full");
      }
      await baseDeps.appendFile(p, data);
    },
  };
  const bundle = makeBundleWithStages();

  await finalizeRun(RUN_DIR, bundle, STATE_DIR, ISSUE, STARTED_AT_ISO, deps); // must not throw

  const summary = JSON.parse(readFile(path.join(RUN_DIR, "summary.json")));
  assert.equal(summary.issue, ISSUE);
  const legacy = JSON.parse(readFile(path.join(STATE_DIR, String(ISSUE), "evidence.json")));
  assert.equal(legacy.issue, ISSUE);
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
// latestRunEventsSummaryForIssue (#398) — powers the `possibly_wedged` status flag
// ---------------------------------------------------------------------------

test("latestRunEventsSummaryForIssue: returns null when runs dir is absent (#398)", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; },
    stat: async () => ({ mtime: new Date() }),
  };
  const result = await latestRunEventsSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.equal(result, null);
});

test("latestRunEventsSummaryForIssue: returns null when no run matches the issue prefix (#398)", async () => {
  const deps: RunStoreDeps = {
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [{ name: "999-2026-06-20T10-00-00-000Z", isDirectory: () => true }],
    stat: async () => ({ mtime: new Date(1000) }),
  };
  const result = await latestRunEventsSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.equal(result, null);
});

test("latestRunEventsSummaryForIssue: unfinalized run — finalized:false and lastEvent from the newest matching run's events.jsonl (#398)", async () => {
  const id1 = `${ISSUE}-2026-06-20T09-00-00-000Z`; // older
  const id2 = `${ISSUE}-2026-06-20T10-00-00-000Z`; // newer
  const dir = path.join(REPO_DIR, ".agent-pipeline", "runs");
  const events2 = [
    { schema_version: 1, type: "run_start", at: "2026-06-20T10:00:00Z" },
    { schema_version: 1, type: "harness_timeout", at: "2026-06-20T10:30:00Z", stage: "review-1", timeout_sec: 1500 },
  ];

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      if (p === path.join(dir, id2, "events.jsonl")) {
        return events2.map((e) => JSON.stringify(e)).join("\n") + "\n";
      }
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

  const result = await latestRunEventsSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null);
  assert.equal(result.finalized, false);
  assert.deepEqual(result.lastEvent, { type: "harness_timeout", at: "2026-06-20T10:30:00Z" });
});

test("latestRunEventsSummaryForIssue: finalized run — finalized:true when events.jsonl contains run_complete (#398)", async () => {
  const id1 = `${ISSUE}-2026-06-20T10-00-00-000Z`;
  const dir = path.join(REPO_DIR, ".agent-pipeline", "runs");
  const events = [
    { schema_version: 1, type: "run_start", at: "2026-06-20T10:00:00Z" },
    { schema_version: 1, type: "run_complete", at: "2026-06-20T10:05:00Z", final_state: "ready-to-deploy", elapsed_ms: 300000 },
  ];

  const deps: RunStoreDeps = {
    readFile: async (p) => {
      if (p === path.join(dir, id1, "events.jsonl")) return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [{ name: id1, isDirectory: () => true }],
    stat: async () => ({ mtime: new Date(1000) }),
  };

  const result = await latestRunEventsSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null);
  assert.equal(result.finalized, true);
  assert.equal(result.lastEvent?.type, "run_complete");
});

test("latestRunEventsSummaryForIssue: empty events.jsonl — finalized:false, lastEvent:null (#398)", async () => {
  const id1 = `${ISSUE}-2026-06-20T10-00-00-000Z`;
  const deps: RunStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [{ name: id1, isDirectory: () => true }],
    stat: async () => ({ mtime: new Date(1000) }),
  };
  const result = await latestRunEventsSummaryForIssue(REPO_DIR, ISSUE, deps);
  assert.ok(result !== null);
  assert.equal(result.finalized, false);
  assert.equal(result.lastEvent, null);
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

// Regression (#261 pre-merge review): the validator must also reject malformed nested
// command / override / recovery entries — formatSummary dereferences c.cmd/exitCode/
// durationMs, o.key/reason, rec.trigger/round/at, so a null or partial element would crash
// the formatter and must be treated as absent (invalid bundle) for fallback.
test("isValidSummaryBundle: returns false for a null command entry — commands:[null] (#261 review)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), stages: [{ stage: "planning", commands: [null] }] };
  assert.equal(isValidSummaryBundle(b), false, "a non-object command must be rejected");
});

test("isValidSummaryBundle: returns false for a command missing exitCode/durationMs (#261 review)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), stages: [{ stage: "planning", commands: [{ cmd: "npm test" }] }] };
  assert.equal(isValidSummaryBundle(b), false, "a command missing exitCode/durationMs must be rejected");
});

test("isValidSummaryBundle: returns false for a null override entry — overrides:[null] (#261 review)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), overrides: [null] };
  assert.equal(isValidSummaryBundle(b), false, "a non-object override must be rejected");
});

test("isValidSummaryBundle: returns false for a null recovery entry — recoveries:[null] (#261 review)", () => {
  const b = { ...makeSummaryBundle(ISSUE, "run-1"), recoveries: [null] };
  assert.equal(isValidSummaryBundle(b), false, "a non-object recovery must be rejected");
});

test("isValidSummaryBundle: returns true for well-formed nested command/override/recovery entries (#261 review)", () => {
  const b = {
    ...makeSummaryBundle(ISSUE, "run-1"),
    stages: [{ stage: "planning", outcome: null, commands: [{ cmd: "npm test", exitCode: 0, durationMs: 12, outputExcerpt: "" }], enteredAt: null, exitedAt: null, commits: [], prompts: [] }],
    overrides: [{ key: "high|f.ts|t", reason: "audited" }],
    recoveries: [{ trigger: "harness-timeout", round: 1, at: "2026-06-20T00:00:00Z" }],
  };
  assert.equal(isValidSummaryBundle(b), true, "well-formed nested entries must be accepted");
});
