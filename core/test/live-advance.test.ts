// #770 loop live-advance coexistence — pure probe/classifier unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isCoexistenceFailureEvidence,
  isNonFatalMidStageExit,
  isLockFileLive,
  eventsTextIsTerminal,
  resolveLinkageTerminalState,
  findActiveRunStoreForIssue,
  probeLiveAdvance,
} from "../scripts/loop/live-advance.ts";
import { classifyDispatchOutcome } from "../scripts/pipeline.ts";
import { normalizeLoopOutcome } from "../scripts/loop-execution-contract.ts";

test("isCoexistenceFailureEvidence: lock / already-running / install-in-progress", () => {
  assert.equal(isCoexistenceFailureEvidence("pipeline: issue #675 is already running"), true);
  assert.equal(isCoexistenceFailureEvidence("Pipeline lock held by another process for #597"), true);
  assert.equal(isCoexistenceFailureEvidence("an install/update is in progress — starting now risks"), true);
  assert.equal(isCoexistenceFailureEvidence("TypeError: cannot read"), false);
  assert.equal(isCoexistenceFailureEvidence(null), false);
});

test("isNonFatalMidStageExit: only coexistence evidence, not bare skipped/waiting (#770 929fc0ac)", () => {
  const skippedOnly = [
    JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" }),
  ].join("\n");
  assert.equal(
    isNonFatalMidStageExit(skippedOnly, ["pipeline:pre-merge"]),
    false,
    "generic skipped mid-stage must not be coexistence",
  );
  const withLock = skippedOnly + "\n" + "pipeline: issue #675 is already running";
  assert.equal(
    isNonFatalMidStageExit(withLock, ["pipeline:pre-merge"]),
    true,
  );
});

test("classifyDispatchOutcome: lock evidence → coexistence_wait; bare skipped → failed (#770 929fc0ac)", () => {
  const skippedOnly = [
    JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" }),
  ].join("\n");
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:pre-merge"], state: "open" }, null, skippedOnly),
    "failed",
    "skipped/waiting alone must not mask a genuine crash as coexistence",
  );
  assert.equal(
    classifyDispatchOutcome(
      { labels: ["pipeline:pre-merge"], state: "open" },
      null,
      "pipeline: issue #675 is already running (.lock-failed)",
    ),
    "coexistence_wait",
  );
  assert.equal(normalizeLoopOutcome("coexistence_wait"), "coexistence_wait");
});

test("classifyDispatchOutcome: still maps plain open mid-stage without events to failed", () => {
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:review-1"], state: "open" }),
    "failed",
  );
});

test("eventsTextIsTerminal / resolveLinkageTerminalState", () => {
  assert.equal(eventsTextIsTerminal(null), false);
  assert.equal(
    eventsTextIsTerminal(JSON.stringify({ type: "stage_start", stage: "review" })),
    false,
  );
  assert.equal(
    eventsTextIsTerminal(
      [
        JSON.stringify({ type: "stage_start", stage: "review" }),
        JSON.stringify({ type: "run_complete", final_state: "review" }),
      ].join("\n"),
    ),
    true,
  );

  // Unresolvable without path/repo → null
  assert.equal(
    resolveLinkageTerminalState({ pipeline_run_id: "1-x" }),
    null,
  );

  // Injectable reader: non-terminal
  assert.equal(
    resolveLinkageTerminalState(
      { pipeline_run_id: "1-x", events: "/fake/events.jsonl" },
      { readText: () => JSON.stringify({ type: "stage_start", stage: "fix" }) },
    ),
    false,
  );
  // Injectable reader: terminal
  assert.equal(
    resolveLinkageTerminalState(
      { pipeline_run_id: "1-x", events: "/fake/events.jsonl" },
      { readText: () => JSON.stringify({ type: "run_complete" }) },
    ),
    true,
  );
});

test("probeLiveAdvance: lock file with live PID → live lock_held", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  fs.writeFileSync(lockPath, String(process.pid));
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    lockPathForTest: lockPath,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "lock_held");
    assert.equal(r.holder_pid, process.pid);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: dead PID lock → not live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  // PID 1 may be live on some systems; use a high unused pid unlikely to exist
  fs.writeFileSync(lockPath, "999999999");
  const held = isLockFileLive(lockPath);
  // If somehow live, skip assertion body
  if (!held.live) {
    const r = probeLiveAdvance({
      domain: "test",
      issueNumber: 770,
      lockPathForTest: lockPath,
    });
    assert.equal(r.live, false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: knownLinkage non-terminal → live loop_linkage (#770 dcfb0878)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-2026-01-01T00-00-00-000Z" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770"),
    resolveLinkageTerminal: () => false,
  });
  assert.equal(r.live, true);
  if (r.live) assert.equal(r.evidence, "loop_linkage");
});

test("probeLiveAdvance: knownLinkage terminal → not live from linkage (#770 ce4794fb)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-2026-01-01T00-00-00-000Z" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-term"),
    resolveLinkageTerminal: () => true,
  });
  assert.equal(r.live, false, "terminal linked advance must not block re-admission");
});

test("probeLiveAdvance: unresolvable linkage alone is not live", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-missing" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-unres"),
    resolveLinkageTerminal: () => null,
  });
  assert.equal(r.live, false);
});

test("probeLiveAdvance: active_run_store evidence (#770 dcfb0878)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 675,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-store"),
    findActiveRunStore: (n) =>
      n === 675
        ? { pipeline_run_id: "675-active", events_path: "/tmp/e.jsonl" }
        : null,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "active_run_store");
    assert.equal(r.pipeline_run_id, "675-active");
  }
});

test("probeLiveAdvance: wrapper_pid evidence", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-wrap"),
    findWrapperPid: () => process.pid,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "wrapper_pid");
    assert.equal(r.holder_pid, process.pid);
  }
});

test("findActiveRunStoreForIssue: non-terminal run dir is active; terminal is not", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-repo-"));
  const runs = path.join(repo, ".agent-pipeline", "runs");
  const activeId = "42-2026-01-01T00-00-00-000Z";
  const doneId = "42-2026-01-02T00-00-00-000Z";
  fs.mkdirSync(path.join(runs, activeId), { recursive: true });
  fs.mkdirSync(path.join(runs, doneId), { recursive: true });
  fs.writeFileSync(
    path.join(runs, activeId, "events.jsonl"),
    JSON.stringify({ type: "stage_start", stage: "review", at: "t" }) + "\n",
  );
  fs.writeFileSync(
    path.join(runs, doneId, "events.jsonl"),
    [
      JSON.stringify({ type: "stage_start", stage: "review", at: "t" }),
      JSON.stringify({ type: "run_complete", final_state: "review", at: "t2" }),
    ].join("\n") + "\n",
  );
  // Newer doneId must not shadow; findActive skips terminal and finds active
  // (mtime: touch done after active so newest is terminal)
  const newer = Date.now();
  fs.utimesSync(path.join(runs, doneId), newer / 1000, newer / 1000);
  fs.utimesSync(path.join(runs, activeId), (newer - 10_000) / 1000, (newer - 10_000) / 1000);

  const found = findActiveRunStoreForIssue(repo, 42);
  assert.ok(found, "expected a non-terminal run");
  assert.equal(found!.pipeline_run_id, activeId);

  // Issue with only terminal runs → null
  assert.equal(findActiveRunStoreForIssue(repo, 99), null);

  fs.rmSync(repo, { recursive: true, force: true });
});
